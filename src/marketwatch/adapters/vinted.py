"""Vinted adapter.

Vinted has no public API for searching other people's listings (its official
"Pro Integrations" API only covers a business's own inventory). This adapter
speaks the endpoint the Vinted web app itself calls:

    GET https://api.<domain>/svc-catalogue/items

An anonymous session is required: we GET the marketplace homepage once, keep
the cookies and echo the `anon_id` cookie in the `X-Anon-Id` header. Without it
the API answers 403 {"code":"FORBIDDEN"}.

Read README.md "Legal & terms" before enabling this marketplace. We do not
implement proxy rotation, CAPTCHA solving or any other evasion: if Vinted says
403 we stop and tell you.
"""

from __future__ import annotations

import os
import random
import time
from typing import Any

import httpx

from ..models import Listing, SearchQuery, SearchResult
from .base import (
    ORDER_NEWEST,
    ORDER_PRICE_ASC,
    ORDER_PRICE_DESC,
    ORDER_RELEVANCE,
    MarketplaceBlocked,
    MarketplaceError,
    MarketplaceRateLimited,
    PacingMixin,
)

DEFAULT_DOMAIN = "vinted.fr"
HOME_TEMPLATE = "https://www.{domain}/"
API_TEMPLATE = "https://api.{domain}/svc-catalogue/items"
ITEM_TEMPLATE = "https://www.{domain}{path}"

DEFAULT_USER_AGENT = (
    "marketwatch/0.1 (personal price-research tool; "
    "contact: set MARKETWATCH_CONTACT)"
)

ORDER_MAP = {
    ORDER_RELEVANCE: "relevance",
    ORDER_NEWEST: "newest_first",
    ORDER_PRICE_ASC: "price_low_to_high",
    ORDER_PRICE_DESC: "price_high_to_low",
}

# Label keywords are localised by marketplace, e.g. on vinted.fr: "Marque: Nike,
# État: Neuf sans étiquette, Taille: 5 ans / 110 cm".
LABEL_KEYS = {
    "brand": ("marque", "brand", "marca", "marke", "merk"),
    "condition": ("état", "etat", "condition", "estado", "zustand", "staat"),
    "size": ("taille", "size", "talla", "größe", "groesse", "maat"),
}


def _to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def _parse_labels(item: dict[str, Any]) -> dict[str, str | None]:
    """Extract brand / condition / size from the structured label fields."""
    box = item.get("item_box") or {}
    brand = box.get("first_line") or None
    size = condition = None
    second = box.get("second_line")
    if isinstance(second, str) and second.strip():
        parts = [p.strip() for p in second.split("·") if p.strip()]
        if parts:
            size = parts[0]
        if len(parts) > 1:
            condition = parts[1]

    label = box.get("accessibility_label")
    if isinstance(label, str):
        for chunk in label.split(","):
            if ":" not in chunk:
                continue
            key, _, val = chunk.partition(":")
            key, val = key.strip().lower(), val.strip()
            if not val:
                continue
            for field, keywords in LABEL_KEYS.items():
                if any(k in key for k in keywords):
                    if field == "brand" and not brand:
                        brand = val
                    elif field == "condition" and not condition:
                        condition = val
                    elif field == "size" and not size:
                        size = val
    return {"brand": brand, "condition": condition, "size": size}


def parse_items(payload: dict[str, Any], *, domain: str = DEFAULT_DOMAIN,
                marketplace: str = "vinted") -> list[Listing]:
    """Turn a raw /svc-catalogue/items payload into Listing objects.

    Defensive on purpose: the response is undocumented and fields disappear.
    """
    listings: list[Listing] = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict):
            continue
        price_obj = item.get("price") or {}
        price = _to_float(price_obj.get("amount"))
        item_id = item.get("id")
        if price is None or item_id is None:
            continue
        currency = price_obj.get("currency_code") or "EUR"
        total = item.get("total_item_price") or {}
        landed = _to_float(total.get("amount")) if total.get("currency_code") == currency else None
        labels = _parse_labels(item)
        path = item.get("url") or f"/items/{item_id}"
        listings.append(
            Listing(
                marketplace=marketplace,
                item_id=str(item_id),
                title=(item.get("title") or "").strip(),
                url=path if str(path).startswith("http") else ITEM_TEMPLATE.format(domain=domain, path=path),
                price=price,
                currency=currency,
                landed_price=landed,
                condition=labels["condition"],
                brand=labels["brand"],
                size=labels["size"],
                favourites=item.get("favourite_count"),
                raw=item,
            )
        )
    return listings


class VintedAdapter(PacingMixin):
    name = "vinted"

    def __init__(
        self,
        domain: str | None = None,
        *,
        timeout: float = 25.0,
        min_interval: float = 6.0,
        jitter: float = 3.0,
        max_retries: int = 3,
        user_agent: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.domain = (domain or os.environ.get("MARKETWATCH_VINTED_DOMAIN") or DEFAULT_DOMAIN).lstrip("/")
        self.min_interval = min_interval
        self.jitter = jitter
        self.max_retries = max_retries
        self.requests_made = 0
        self._reset_pacing()
        self._bootstrapped = False
        self._client = client or httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={
                "User-Agent": user_agent or os.environ.get("MARKETWATCH_USER_AGENT", DEFAULT_USER_AGENT),
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
                "Platform": "web",
                "x-next-app": "marketplace-web",
                "Origin": f"https://www.{self.domain}",
                "Referer": f"https://www.{self.domain}/catalog",
            },
        )

    # --- session handling -------------------------------------------------
    def _bootstrap(self, *, force: bool = False) -> None:
        """Establish the anonymous session and expose its id to the API."""
        if self._bootstrapped and not force:
            return
        url = HOME_TEMPLATE.format(domain=self.domain)
        try:
            self._pace()
            resp = self._client.get(url, headers={"Accept": "text/html"})
            self._mark_request()
            self.requests_made += 1
        except httpx.HTTPError as exc:
            raise MarketplaceError(f"could not reach {url}: {exc}") from exc
        if resp.status_code >= 400:
            raise MarketplaceError(f"{url} returned HTTP {resp.status_code}")
        anon_id = self._client.cookies.get("anon_id")
        if anon_id:
            self._client.headers["X-Anon-Id"] = anon_id
        self._bootstrapped = True

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "VintedAdapter":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- search -----------------------------------------------------------
    def _params(self, query: SearchQuery) -> dict[str, str]:
        params: dict[str, str] = {
            "search_text": query.search_text,
            "page": str(query.page),
            "per_page": str(query.per_page),
            "order": ORDER_MAP.get(query.order, "relevance"),
        }
        if query.min_price is not None:
            params["price_from"] = f"{query.min_price:g}"
        if query.max_price is not None:
            params["price_to"] = f"{query.max_price:g}"
        if query.currency:
            params["currency"] = query.currency
        for key, ids in query.filters.items():
            if ids:
                params[f"attribute_ids[{key}]"] = ",".join(str(i) for i in ids)
        return params

    def search(self, query: SearchQuery) -> SearchResult:
        self._bootstrap()
        url = API_TEMPLATE.format(domain=self.domain)
        params = self._params(query)
        last_status: int | None = None

        for attempt in range(self.max_retries + 1):
            try:
                self._pace()
                resp = self._client.get(url, params=params)
                self._mark_request()
                self.requests_made += 1
            except httpx.HTTPError as exc:
                if attempt >= self.max_retries:
                    raise MarketplaceError(f"request to {url} failed: {exc}") from exc
                time.sleep(self._backoff(attempt))
                continue

            last_status = resp.status_code
            if resp.status_code == 200:
                try:
                    payload = resp.json()
                except ValueError as exc:
                    raise MarketplaceError(
                        "marketplace returned HTML/opaque content instead of JSON "
                        "(likely a bot challenge)"
                    ) from exc
                return self._build_result(payload, query)
            if resp.status_code == 429:
                wait = self._retry_after(resp.headers.get("Retry-After"))
                wait = self._backoff(attempt) if wait is None else wait
                if attempt >= self.max_retries:
                    raise MarketplaceRateLimited(f"rate limited by {self.domain}", retry_after=wait)
                time.sleep(wait)
                continue
            if resp.status_code in (401, 403):
                # A stale anonymous session is the usual cause; refresh it once.
                if attempt == 0:
                    self._bootstrap(force=True)
                    continue
                raise MarketplaceBlocked(
                    f"{self.domain} refused automated access (HTTP {resp.status_code}). "
                    "Stopping - see README.md 'Legal & terms'. Do not add evasion."
                )
            if resp.status_code >= 500 and attempt < self.max_retries:
                time.sleep(self._backoff(attempt))
                continue
            raise MarketplaceError(f"{url} returned HTTP {resp.status_code}")

        raise MarketplaceError(f"giving up on {url} (last HTTP {last_status})")

    @staticmethod
    def _retry_after(raw: str | None) -> float | None:
        try:
            return float(raw) if raw else None
        except ValueError:
            return None

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(60.0, 5.0 * (2**attempt)) + random.uniform(0, 2.0)

    def _build_result(self, payload: dict[str, Any], query: SearchQuery) -> SearchResult:
        pagination = payload.get("pagination") or {}
        return SearchResult(
            marketplace=self.name,
            items=parse_items(payload, domain=self.domain),
            page=int(pagination.get("current_page") or query.page),
            per_page=int(pagination.get("per_page") or query.per_page),
            total_entries=pagination.get("total_entries"),
            total_pages=pagination.get("total_pages"),
        )
