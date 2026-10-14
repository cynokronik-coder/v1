"""eBay adapter - the terms-compliant path (official Browse API).

Requires a free eBay developer keyset:
    https://developer.ebay.com/signin
Then export EBAY_CLIENT_ID / EBAY_CLIENT_SECRET (see .env.example).

Auth is OAuth2 client_credentials ("application token"), which is enough for
public item search. Rate limits are per keyset (5,000 calls/day by default).
"""

from __future__ import annotations

import base64
import os
import time
from typing import Any

import httpx

from ..models import Listing, SearchQuery, SearchResult
from .base import (
    ORDER_NEWEST,
    ORDER_PRICE_ASC,
    ORDER_PRICE_DESC,
    MarketplaceError,
)

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"
SCOPE = "https://api.ebay.com/oauth/api_scope"

ORDER_MAP = {
    ORDER_NEWEST: "newlyListed",
    ORDER_PRICE_ASC: "price",
    ORDER_PRICE_DESC: "-price",
}


def _to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(str(value).strip())
    except ValueError:
        return None


def parse_ebay_items(payload: dict[str, Any], *, marketplace: str = "ebay") -> list[Listing]:
    """Normalize an eBay item_summary/search payload."""
    listings: list[Listing] = []
    for item in payload.get("itemSummaries") or []:
        if not isinstance(item, dict):
            continue
        price_obj = item.get("price") or {}
        price = _to_float(price_obj.get("value"))
        item_id = item.get("legacyItemId") or item.get("itemId")
        url = item.get("itemWebUrl")
        if price is None or not item_id or not url:
            continue
        currency = price_obj.get("currency") or "EUR"

        landed = None
        for option in item.get("shippingOptions") or []:
            cost = _to_float((option.get("shippingCost") or {}).get("value"))
            if cost is not None:
                landed = round(price + cost, 2)
                break

        listings.append(
            Listing(
                marketplace=marketplace,
                item_id=str(item_id),
                title=(item.get("title") or "").strip(),
                url=url,
                price=price,
                currency=currency,
                landed_price=landed,
                condition=item.get("condition"),
                brand=item.get("brand"),
                size=None,
                favourites=None,
                created_at=_parse_dt(item.get("itemCreationDate")),
                raw=item,
            )
        )
    return listings


def _parse_dt(raw: Any):
    if not isinstance(raw, str):
        return None
    from datetime import datetime, timezone

    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


class EbayBrowseAdapter:
    name = "ebay"

    def __init__(
        self,
        *,
        marketplace_id: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        timeout: float = 25.0,
        client: httpx.Client | None = None,
        **_: object,
    ) -> None:
        self.marketplace_id = marketplace_id or os.environ.get("EBAY_MARKETPLACE_ID") or "EBAY_FR"
        self.client_id = client_id or os.environ.get("EBAY_CLIENT_ID")
        self.client_secret = client_secret or os.environ.get("EBAY_CLIENT_SECRET")
        self.requests_made = 0
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._client = client or httpx.Client(timeout=timeout, follow_redirects=True)

    def _require_credentials(self) -> tuple[str, str]:
        if not self.client_id or not self.client_secret:
            raise MarketplaceError(
                "eBay credentials missing. Create a free keyset at "
                "https://developer.ebay.com/signin and set EBAY_CLIENT_ID / "
                "EBAY_CLIENT_SECRET (see .env.example)."
            )
        return self.client_id, self.client_secret

    def _application_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at - 60:
            return self._token
        client_id, client_secret = self._require_credentials()
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        resp = self._client.post(
            TOKEN_URL,
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials", "scope": SCOPE},
        )
        self.requests_made += 1
        if resp.status_code != 200:
            raise MarketplaceError(
                f"eBay token request failed (HTTP {resp.status_code}): {resp.text[:300]}"
            )
        payload = resp.json()
        self._token = payload["access_token"]
        self._token_expires_at = time.monotonic() + float(payload.get("expires_in", 7200))
        return self._token

    def search(self, query: SearchQuery) -> SearchResult:
        limit = min(query.per_page, 200)
        offset = max(0, (query.page - 1) * limit)
        params: dict[str, str] = {
            "q": query.search_text,
            "limit": str(limit),
            "offset": str(offset),
        }
        sort = ORDER_MAP.get(query.order)
        if sort:
            params["sort"] = sort
        if query.min_price is not None or query.max_price is not None:
            low = query.min_price if query.min_price is not None else 0
            high = query.max_price
            rng = f"[{low:g}..{high:g}]" if high is not None else f"[{low:g}..]"
            params["filter"] = f"price:{rng},priceCurrency:{(query.currency or 'EUR')}"

        resp = self._client.get(
            SEARCH_URL,
            params=params,
            headers={
                "Authorization": f"Bearer {self._application_token()}",
                "X-EBAY-C-MARKETPLACE-ID": self.marketplace_id,
                "Accept": "application/json",
            },
        )
        self.requests_made += 1
        if resp.status_code == 429:
            raise MarketplaceError("eBay rate limit reached for this keyset")
        if resp.status_code >= 400:
            raise MarketplaceError(f"eBay search failed (HTTP {resp.status_code}): {resp.text[:300]}")
        payload = resp.json()
        total = payload.get("total")
        return SearchResult(
            marketplace=self.name,
            items=parse_ebay_items(payload),
            page=query.page,
            per_page=limit,
            total_entries=int(total) if total is not None else None,
            total_pages=(int(total) // limit + 1) if total else None,
        )
