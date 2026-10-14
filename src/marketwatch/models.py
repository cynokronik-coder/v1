"""Core data models shared by every adapter, the analyzer and the store."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Generic sort orders the CLI/config speaks; adapters translate them.
Order = str  # one of: relevance | newest | price_asc | price_desc


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Money(BaseModel):
    amount: float
    currency: str

    def __str__(self) -> str:  # pragma: no cover - display helper
        return f"{self.amount:.2f} {self.currency}"


class Listing(BaseModel):
    """One normalized marketplace listing."""

    model_config = ConfigDict(populate_by_name=True)

    marketplace: str
    item_id: str
    title: str
    url: str
    price: float
    currency: str
    # Price actually paid by the buyer (item + buyer protection + shipping) when known.
    landed_price: float | None = None
    condition: str | None = None
    brand: str | None = None
    size: str | None = None
    favourites: int | None = None
    created_at: datetime | None = None
    raw: dict[str, Any] = Field(default_factory=dict, repr=False)

    @field_validator("price", "landed_price")
    @classmethod
    def _positive(cls, v: float | None) -> float | None:
        if v is not None and v < 0:
            raise ValueError("price cannot be negative")
        return v

    def key(self) -> tuple[str, str]:
        return (self.marketplace, self.item_id)


class SearchQuery(BaseModel):
    """A marketplace-agnostic search request."""

    search_text: str
    filters: dict[str, list[str]] = Field(default_factory=dict)
    min_price: float | None = None
    max_price: float | None = None
    page: int = 1
    per_page: int = 96
    order: Order = "relevance"
    currency: str | None = None


class SearchResult(BaseModel):
    marketplace: str
    items: list[Listing]
    page: int = 1
    per_page: int = 0
    total_entries: int | None = None
    total_pages: int | None = None


class Watch(BaseModel):
    """A product we want to price-track, plus the rules that keep its
    comparable pool honest."""

    name: str
    search_text: str
    marketplace: str = "vinted"

    # --- adapter routing ---
    domain: str | None = None  # e.g. "vinted.fr" / "www.ebay.fr"
    marketplace_id: str | None = None  # eBay X-EBAY-C-MARKETPLACE-ID
    filters: dict[str, list[str]] = Field(default_factory=dict)

    # --- comparability rules (keep the baseline from comparing apples to oranges) ---
    must_match: list[str] = Field(default_factory=list)  # regex, all must match the title
    must_not_match: list[str] = Field(default_factory=list)  # regex, none may match
    conditions: list[str] = Field(default_factory=list)  # exact-ish condition allowlist
    sizes: list[str] = Field(default_factory=list)  # exact-ish size allowlist

    # --- plausibility bounds: prices outside this band are junk, not bargains ---
    plausible_min_price: float = 5.0
    plausible_max_price: float = 5000.0

    # --- baseline + deal thresholds ---
    sample_pages: int = 3  # pages fetched to build the comparable pool
    min_sample_size: int = 8  # below this we refuse to judge
    min_discount: float = 0.30  # 30% under the market price
    max_robust_z: float | None = -1.0  # robust-sigma outlier test; null = off
    comps_ttl_seconds: int = 900  # reuse the baseline for this long

    # --- runtime guards (unofficial marketplaces) ---
    acknowledge_terms: bool = False

    def title_matches(self, title: str) -> bool:
        low = title.lower()
        if self.must_match and not all(
            re.search(p, low, re.I) for p in self.must_match
        ):
            return False
        if self.must_not_match and any(
            re.search(p, low, re.I) for p in self.must_not_match
        ):
            return False
        return True

    def value_matches(self, value: str | None, allowed: list[str]) -> bool:
        """Match a size/condition against an allowlist.

        A plain substring test is wrong for sizes ("9" would match "39.5", "42"
        would match "142"), so a purely numeric entry must equal a whole number
        token of the field ("US 9" -> 9, "42 EU" -> 42, "42,5" -> 42.5). Anything
        else stays a substring test, which is what conditions want
        ("bon état" matches "Très bon état").
        """
        if not allowed:
            return True
        if not value:
            return False
        low = str(value).lower()
        numbers = {n.replace(",", ".") for n in re.findall(r"\d+(?:[.,]\d+)?", low)}
        for candidate in allowed:
            needle = str(candidate).strip().lower()
            if not needle:
                continue
            if re.fullmatch(r"\d+(?:[.,]\d+)?", needle):
                if needle.replace(",", ".") in numbers:
                    return True
            elif needle in low:
                return True
        return False


class PriceStats(BaseModel):
    """Robust summary of the comparable pool = our 'market price' estimate."""

    sample_size: int  # comparable listings found
    used_size: int  # listings kept after outlier trimming
    currency: str
    median: float
    mean: float
    q1: float
    q3: float
    mad: float  # median absolute deviation
    lower_fence: float | None = None  # q1 - k*IQR, informational
    source: str = "active_listings"
    computed_at: datetime = Field(default_factory=utcnow)


class Deal(BaseModel):
    watch: str
    listing: Listing
    market_price: float
    discount_pct: float
    robust_z: float
    landed_price: float | None = None
    reasons: list[str] = Field(default_factory=list)
    first_seen: datetime = Field(default_factory=utcnow)
    stats: PriceStats | None = None


class WatchReport(BaseModel):
    """Result of one scan pass over one watch."""

    watch: Watch
    stats: PriceStats | None = None
    comparables: list[Listing] = Field(default_factory=list)
    candidates: list[Listing] = Field(default_factory=list)
    deals: list[Deal] = Field(default_factory=list)
    new_deals: list[Deal] = Field(default_factory=list)
    requests_made: int = 0
    notes: list[str] = Field(default_factory=list)
