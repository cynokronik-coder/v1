"""Leboncoin adapter.

Leboncoin has **no public API** for searching other people's listings, and its
``robots.txt`` is explicit::

    ## It's forbidden to use search robots or other automatic methods to access
    ## Leboncoin.fr. Access is only permitted with special permission from Leboncoin.fr.

This adapter therefore exists for personal, low-volume price research only, and
is opt-in per watch (``acknowledge_terms: true``). Read README.md "Legal & terms".

Two transports are implemented, both of which are the ones Leboncoin's own
browser client uses:

``api``   POST https://api.leboncoin.fr/finder/search   (clean JSON, cookie-less)
``page``  GET  https://www.leboncoin.fr/recherche?text=...  and read the JSON the
          Next.js page embeds in ``<script id="__NEXT_DATA__">``

Both sit behind **DataDome**, which is what the error messages are about: it
returns HTTP 403 with a ``geo.captcha-delivery.com`` body from datacenter IPs and
when you ask too fast. When that happens we stop and tell you. There is no proxy
rotation, no fingerprint spoofing and no CAPTCHA solving in this code, on purpose.

Everything the parser reads was taken from real captured search records
(see tests/fixtures/leboncoin_search.json), because this response is undocumented
and its fields move around.
"""

from __future__ import annotations

import json
import os
import random
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable

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

DEFAULT_DOMAIN = "www.leboncoin.fr"
FINDER_URL = "https://api.leboncoin.fr/finder/search"
SEARCH_PAGE = "https://{domain}/recherche"
HOME_PAGE = "https://{domain}/"

# The key the mobile/web client has shipped publicly for years. Undocumented and
# subject to change: override with MARKETWATCH_LBC_API_KEY if it starts failing.
DEFAULT_API_KEY = "ba0c2dad52b3ec"

# Community clients use 35; larger limits are rejected/ignored.
MAX_PER_PAGE = 35
CURRENCY = "EUR"  # leboncoin is a French-only, euro-only marketplace

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# attribute keys -> the field they carry. Order matters: first hit wins.
ATTR_BRAND = ("brand", "marque")
ATTR_SIZE = ("size", "taille", "shoe_size", "clothing_size")
ATTR_CONDITION = ("condition", "etat", "état", "item_condition")
# `general_sales_condition` is the shipping/sales condition, not the item state,
# so it is only a last resort.
ATTR_CONDITION_FALLBACK = ("general_sales_condition",)

# The site name leaked into the `brand` field by some capture tools; never an item brand.
SITE_BRANDS = {"leboncoin", "leboncoin.fr", "www.leboncoin.fr"}

try:  # pragma: no cover - tzdata is present on Linux, absent on some Windows boxes
    from zoneinfo import ZoneInfo

    PARIS: Any = ZoneInfo("Europe/Paris")
except Exception:  # pragma: no cover
    PARIS = timezone.utc


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


def _first(value: Any) -> Any:
    """Leboncoin wraps some scalars in single-element lists (``"price": [4]``)."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def parse_price(ad: dict[str, Any]) -> float | None:
    """Euros for one ad.

    ``price_cents`` is the exact value; ``price`` is either a scalar, a
    single-element list, or ``{"value": n}`` depending on the endpoint/category.
    """
    cents = _to_float(_first(ad.get("price_cents")))
    if cents is not None:
        return round(cents / 100.0, 2)
    raw = _first(ad.get("price"))
    if isinstance(raw, dict):
        raw = raw.get("value") or raw.get("amount")
    return _to_float(raw)


def _attributes(ad: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    raw = ad.get("attributes")
    if not isinstance(raw, list):
        return out
    for attr in raw:
        if isinstance(attr, dict) and attr.get("key"):
            out.setdefault(str(attr["key"]).lower(), attr)
    return out


def _attr_label(attr: dict[str, Any] | None) -> str | None:
    if not attr:
        return None
    label = _first(attr.get("value_label")) or _first(attr.get("value"))
    if label is None:
        values = attr.get("values")
        label = values[0] if isinstance(values, list) and values else None
    if label is None:
        return None
    return str(label).strip() or None


def _attr_of(attrs: dict[str, dict[str, Any]], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        label = _attr_label(attrs.get(key))
        if label:
            return label
    return None


def parse_datetime(ad: dict[str, Any]) -> datetime | None:
    """``index_date``/``first_publication_date`` are Paris-local, without a zone."""
    for field in ("index_date", "first_publication_date"):
        raw = _first(ad.get(field))
        if not isinstance(raw, str) or not raw.strip():
            continue
        text = raw.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                naive = datetime.strptime(text, fmt)
            except ValueError:
                continue
            return naive.replace(tzinfo=PARIS).astimezone(timezone.utc)
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            continue
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=PARIS).astimezone(timezone.utc)
    return None


def parse_ads(
    payload: Any, *, domain: str = DEFAULT_DOMAIN, marketplace: str = "leboncoin"
) -> list[Listing]:
    """Normalise a raw search response into Listing objects.

    Defensive on purpose: the payload is undocumented, so unexpected shapes are
    skipped rather than raising.
    """
    if isinstance(payload, list):
        ads: list[Any] = payload
    elif isinstance(payload, dict):
        ads = payload.get("ads") or payload.get("items") or payload.get("data") or []
    else:
        ads = []

    listings: list[Listing] = []
    for ad in ads:
        if not isinstance(ad, dict):
            continue
        price = parse_price(ad)
        item_id = _first(ad.get("list_id")) or _first(ad.get("id"))
        if price is None or item_id is None:
            continue
        attrs = _attributes(ad)
        url = ad.get("url")
        if not isinstance(url, str) or not url.strip():
            url = f"https://{domain}/ad/{_first(ad.get('category_id')) or 0}/{item_id}"
        elif url.startswith("/"):
            url = "https://" + domain + url

        brand = _attr_of(attrs, ATTR_BRAND)
        if not brand:
            top = ad.get("brand")
            # Some capture tools stuff the site name in here; that is not a brand.
            brand = str(top).strip() if isinstance(top, str) and top.strip().lower() not in SITE_BRANDS else None

        counters = ad.get("counters") if isinstance(ad.get("counters"), dict) else {}
        owner = ad.get("owner") if isinstance(ad.get("owner"), dict) else {}
        location = ad.get("location") if isinstance(ad.get("location"), dict) else {}

        listings.append(
            Listing(
                marketplace=marketplace,
                item_id=str(item_id),
                title=str(ad.get("subject") or "").strip(),
                url=url,
                price=price,
                currency=CURRENCY,
                condition=_attr_of(attrs, ATTR_CONDITION) or _attr_of(attrs, ATTR_CONDITION_FALLBACK),
                brand=brand,
                size=_attr_of(attrs, ATTR_SIZE),
                favourites=(
                    counters.get("favorites")
                    if isinstance(counters.get("favorites"), int)
                    else None
                ),
                created_at=parse_datetime(ad),
                raw={
                    "ad": ad,
                    "seller_type": owner.get("type"),
                    "seller_name": owner.get("name"),
                    "zipcode": location.get("zipcode"),
                    "city": location.get("city"),
                    "ad_type": ad.get("ad_type"),
                    "status": ad.get("status"),
                },
            )
        )
    return listings


def find_ads_in_page(html: str) -> list[dict[str, Any]]:
    """Pull the ads list out of the JSON the Next.js search page embeds.

    The exact path (``props.pageProps.searchData.ads``) moves between releases, so
    instead of hard-coding it we walk the tree and keep the first list whose
    entries look like ads.
    """
    match = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S
    )
    if not match:
        return []
    try:
        data = json.loads(match.group(1))
    except ValueError:
        return []
    return _search_ads_list(data, depth=0)


def _search_ads_list(node: Any, *, depth: int) -> list[dict[str, Any]]:
    if depth > 12:
        return []
    if isinstance(node, list):
        if node and all(isinstance(x, dict) for x in node) and any("list_id" in x for x in node):
            return [x for x in node if isinstance(x, dict)]
        for item in node:
            found = _search_ads_list(item, depth=depth + 1)
            if found:
                return found
        return []
    if isinstance(node, dict):
        for key in ("ads", "items", "results"):
            found = _search_ads_list(node.get(key), depth=depth + 1)
            if found:
                return found
        for value in node.values():
            found = _search_ads_list(value, depth=depth + 1)
            if found:
                return found
    return []


def blocked_advice(cookie_set: bool) -> str:
    """What to do about a DataDome refusal - stated once, not once per request."""
    if cookie_set:
        tail = (
            "MARKETWATCH_LBC_COOKIE is set but no longer accepted - refresh it from a "
            "browser, or unset it."
        )
    else:
        tail = (
            "Set MARKETWATCH_LBC_COOKIE to a Cookie header copied from your own "
            "logged-in browser session if you want to use that session."
        )
    return (
        "This is normal from cloud/datacenter IPs and when polling too fast: run "
        "marketwatch from your home connection, slow it down (`--vinted-delay 20`), "
        f"and see README.md 'Legal & terms'. {tail} marketwatch does not solve "
        "CAPTCHAs or rotate proxies."
    )


class LeboncoinAdapter(PacingMixin):
    name = "leboncoin"

    def __init__(
        self,
        domain: str | None = None,
        *,
        transport: str | None = None,
        timeout: float = 25.0,
        min_interval: float = 8.0,
        jitter: float = 4.0,
        max_retries: int = 2,
        user_agent: str | None = None,
        api_key: str | None = None,
        cookie: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        raw_domain = (domain or os.environ.get("MARKETWATCH_LBC_DOMAIN") or DEFAULT_DOMAIN).lstrip("/")
        self.domain = raw_domain or DEFAULT_DOMAIN
        self.transport = (transport or os.environ.get("MARKETWATCH_LBC_TRANSPORT") or "auto").lower()
        self.min_interval = min_interval
        self.jitter = jitter
        self.max_retries = max_retries
        self.api_key = api_key or os.environ.get("MARKETWATCH_LBC_API_KEY") or DEFAULT_API_KEY
        self.requests_made = 0
        self._reset_pacing()
        self._bootstrapped = False
        # Optional: your *own* browser session, pasted from devtools. Off by default.
        self._extra_cookie = cookie if cookie is not None else os.environ.get("MARKETWATCH_LBC_COOKIE")
        self._client = client or httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers=self._default_headers(user_agent),
        )
        if self._extra_cookie:
            self._client.headers["Cookie"] = self._extra_cookie

    # --- session handling -------------------------------------------------
    def _default_headers(self, user_agent: str | None) -> dict[str, str]:
        return {
            # DataDome fingerprints the client: a bot-looking UA is challenged
            # immediately, so we present a normal browser UA. This is not
            # spoofing a human - it is the client the public site expects.
            "User-Agent": user_agent or os.environ.get("MARKETWATCH_USER_AGENT", DEFAULT_USER_AGENT),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "Origin": f"https://{self.domain}",
            "Referer": f"https://{self.domain}/",
            "Upgrade-Insecure-Requests": "1",
        }

    def _bootstrap(self, *, force: bool = False) -> None:
        """Pick up the site cookies (``datadome``, ``cnfdVisitorId``) once."""
        if self._bootstrapped and not force:
            return
        url = HOME_PAGE.format(domain=self.domain)
        try:
            self._pace()
            resp = self._client.get(url, headers={"Accept": "text/html"})
            self._mark_request()
            self.requests_made += 1
        except httpx.HTTPError as exc:
            raise MarketplaceError(f"could not reach {url}: {exc}") from exc
        if resp.status_code >= 400:
            raise self._blocked(resp, url) if self._is_challenge(resp) else MarketplaceError(
                f"{url} returned HTTP {resp.status_code}"
            )
        self._bootstrapped = True

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "LeboncoinAdapter":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- blocked / challenge detection ------------------------------------
    @staticmethod
    def _is_challenge(resp: httpx.Response) -> bool:
        if resp.status_code not in (403, 429, 503):
            return False
        body = (resp.text or "")[:2000].lower()
        return (
            "captcha-delivery" in body
            or "datadome" in body
            or "captcha" in body
            or "blocked" in body
            or resp.headers.get("x-datadome", "") != ""
        )

    @staticmethod
    def _challenge_reason(resp: httpx.Response) -> str:
        if "captcha-delivery" in (resp.text or ""):
            return "DataDome challenge"
        return f"HTTP {resp.status_code}"

    def _blocked(self, resp: httpx.Response, url: str) -> MarketplaceBlocked:
        """Short on purpose: `search()` adds the advice exactly once."""
        return MarketplaceBlocked(f"{url} refused ({self._challenge_reason(resp)})")

    # --- request plumbing -------------------------------------------------
    def _request(
        self, send: Callable[[], httpx.Response], *, label: str
    ) -> httpx.Response:
        last_status: int | None = None
        for attempt in range(self.max_retries + 1):
            try:
                self._pace()
                resp = send()
                self._mark_request()
                self.requests_made += 1
            except httpx.HTTPError as exc:
                if attempt >= self.max_retries:
                    raise MarketplaceError(f"request to {label} failed: {exc}") from exc
                time.sleep(self._backoff(attempt))
                continue

            last_status = resp.status_code
            if resp.status_code == 200:
                return resp
            if self._is_challenge(resp):
                raise self._blocked(resp, label)
            if resp.status_code in (401, 403):
                if attempt == 0:
                    self._bootstrap(force=True)
                    continue
                raise self._blocked(resp, label)
            if resp.status_code == 429:
                wait = self._retry_after(resp.headers.get("Retry-After"))
                wait = self._backoff(attempt) if wait is None else wait
                if attempt >= self.max_retries:
                    raise MarketplaceRateLimited(
                        f"rate limited by {self.domain}", retry_after=wait
                    )
                time.sleep(wait)
                continue
            if resp.status_code >= 500 and attempt < self.max_retries:
                time.sleep(self._backoff(attempt))
                continue
            raise MarketplaceError(f"{label} returned HTTP {resp.status_code}")
        raise MarketplaceError(f"giving up on {label} (last HTTP {last_status})")

    @staticmethod
    def _retry_after(raw: str | None) -> float | None:
        try:
            return float(raw) if raw else None
        except ValueError:
            return None

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(90.0, 8.0 * (2**attempt)) + random.uniform(0, 3.0)

    # --- query translation ------------------------------------------------
    @staticmethod
    def _filter_values(query: SearchQuery, *names: str) -> list[str]:
        out: list[str] = []
        for key, values in (query.filters or {}).items():
            if key.strip().lower() in names:
                out.extend(str(v) for v in values if str(v).strip())
        return out

    def _limit(self, query: SearchQuery) -> int:
        return max(1, min(int(query.per_page or MAX_PER_PAGE), MAX_PER_PAGE))

    def _body(self, query: SearchQuery) -> dict[str, Any]:
        """The POST body for /finder/search. Prices in the *filter* are in cents."""
        limit = self._limit(query)
        filters: dict[str, Any] = {"keywords": {"text": query.search_text}}

        ad_types = self._filter_values(query, "ad_type") or ["offer"]
        enums: dict[str, list[str]] = {"ad_type": ad_types}
        owner_types = self._filter_values(query, "owner_type", "seller_type")
        if owner_types:
            enums["owner_type"] = owner_types
        filters["enums"] = enums

        categories = self._filter_values(query, "category", "category_id")
        if categories:
            filters["category"] = {"id": categories[0]}

        location = self._location_filters(query)
        if location:
            filters["location"] = location

        price: dict[str, int] = {}
        if query.min_price is not None:
            price["min"] = int(round(query.min_price * 100))
        if query.max_price is not None:
            price["max"] = int(round(query.max_price * 100))
        if price:
            filters["ranges"] = {"price": price}

        body: dict[str, Any] = {"limit": limit, "offset": (max(1, query.page) - 1) * limit, "filters": filters}
        sorting = {
            ORDER_RELEVANCE: None,
            ORDER_NEWEST: ("time", "desc"),
            ORDER_PRICE_ASC: ("price", "asc"),
            ORDER_PRICE_DESC: ("price", "desc"),
        }.get(query.order)
        if sorting:
            body["sort_by"], body["sort_order"] = sorting
        return body

    def _location_filters(self, query: SearchQuery) -> dict[str, Any]:
        location: dict[str, Any] = {}
        for key, field in (
            ("regions", "regions"),
            ("region", "regions"),
            ("departments", "departments"),
            ("department", "departments"),
            ("city_zipcodes", "city_zipcodes"),
            ("zipcodes", "zip_codes"),
            ("zipcode", "zip_codes"),
        ):
            values = self._filter_values(query, key)
            if values:
                location.setdefault(field, []).extend(values)
        return location

    def _search_url(self, query: SearchQuery) -> str:
        """The page transport URL. Here the price filter is in *euros*."""
        limit = self._limit(query)
        params: list[tuple[str, str]] = [
            ("text", query.search_text),
            ("page", str(max(1, query.page))),
        ]
        if query.min_price is not None or query.max_price is not None:
            low = f"{query.min_price:g}" if query.min_price is not None else ""
            high = f"{query.max_price:g}" if query.max_price is not None else ""
            params.append(("price", f"{low}-{high}"))
        if query.order == ORDER_NEWEST:
            params += [("sort", "time"), ("order", "desc")]
        elif query.order == ORDER_PRICE_ASC:
            params += [("sort", "price"), ("order", "asc")]
        elif query.order == ORDER_PRICE_DESC:
            params += [("sort", "price"), ("order", "desc")]
        for key, values in (query.filters or {}).items():
            low = key.strip().lower()
            if low in {"category", "category_id"} and values:
                params.append(("category", str(values[0])))
            elif low in {"regions", "region"} and values:
                params.append(("locations", ",".join(str(v) for v in values)))
            elif low in {"departments", "department"} and values:
                params.append(("locations", ",".join(str(v) for v in values)))
        params.append(("limit", str(limit)))
        return str(httpx.URL(SEARCH_PAGE.format(domain=self.domain), params=params))

    # --- transports -------------------------------------------------------
    def _search_api(self, query: SearchQuery) -> SearchResult:
        body = self._body(query)
        url = FINDER_URL

        def send() -> httpx.Response:
            headers = {
                "Content-Type": "application/json; charset=utf-8",
                "api_key": self.api_key,
                "Accept": "application/json",
            }
            return self._client.post(url, json=body, headers=headers)

        resp = self._request(send, label=url)
        try:
            payload = resp.json()
        except ValueError as exc:
            raise MarketplaceError(
                f"{url} returned non-JSON content (likely a bot challenge)"
            ) from exc
        return self._build_result(payload, query, transport="api")

    def _search_page(self, query: SearchQuery) -> SearchResult:
        url = self._search_url(query)

        def send() -> httpx.Response:
            return self._client.get(url, headers={"Accept": "text/html"})

        resp = self._request(send, label=url)
        ads = find_ads_in_page(resp.text)
        if not ads:
            raise MarketplaceError(
                f"{url} returned HTTP 200 but no embedded listing JSON was found "
                "(the page markup probably changed, or DataDome served an interstitial)"
            )
        return self._build_result({"ads": ads}, query, transport="page", source_url=url)

    def _transports(self) -> list[str]:
        if self.transport in {"api", "page"}:
            return [self.transport]
        return ["api", "page"]  # auto

    def search(self, query: SearchQuery) -> SearchResult:
        transports = self._transports()
        failures: list[str] = []
        try:
            self._bootstrap()
        except MarketplaceBlocked as exc:
            # The homepage is challenged but /finder/search sometimes still answers
            # (it authenticates with api_key, not the session cookie). Try anyway.
            failures.append(f"session: {exc}")
        for index, transport in enumerate(transports):
            try:
                result = self._search_api(query) if transport == "api" else self._search_page(query)
            except MarketplaceRateLimited:
                raise
            except MarketplaceBlocked as exc:
                failures.append(f"{transport}: {exc}")
                if index < len(transports) - 1:
                    continue  # the other transport may still work
                break
            result.items = self._post_filter(result.items, query)
            return result
        raise MarketplaceBlocked(
            f"{self.domain} refused every transport: "
            + "; ".join(failures)
            + ". "
            + blocked_advice(bool(self._extra_cookie))
        )

    def _post_filter(self, items: list[Listing], query: SearchQuery) -> list[Listing]:
        """Client-side guards for fields the request body cannot always express.

        `seller_type` is dropped only when it is present and contradicts the filter:
        a field that vanished from the response must not empty the whole pool.
        """
        ad_types = {t.lower() for t in self._filter_values(query, "ad_type")} or {"offer"}
        owner_types = {t.lower() for t in self._filter_values(query, "owner_type", "seller_type")}
        kept: list[Listing] = []
        for item in items:
            meta = item.raw or {}
            if meta.get("ad_type") and str(meta["ad_type"]).lower() not in ad_types:
                continue  # a "demande" (wanted ad) is not a comparable listing
            if meta.get("status") and str(meta["status"]).lower() not in {"active", ""}:
                continue  # sold/expired ads still show up in some responses
            seller_type = str(meta.get("seller_type") or "").lower()
            if owner_types and seller_type and seller_type not in owner_types:
                continue  # only drop when the seller type is actually stated
            kept.append(item)
        return kept

    def _build_result(
        self,
        payload: Any,
        query: SearchQuery,
        *,
        transport: str,
        source_url: str | None = None,
    ) -> SearchResult:
        pagination = payload.get("pagination") if isinstance(payload, dict) else None
        pagination = pagination if isinstance(pagination, dict) else {}
        total = None
        if isinstance(payload, dict):
            total = payload.get("total") or pagination.get("total")
        limit = self._limit(query)
        return SearchResult(
            marketplace=self.name,
            items=parse_ads(payload, domain=self.domain),
            page=max(1, query.page),
            per_page=limit,
            total_entries=total if isinstance(total, int) else None,
            total_pages=(
                payload.get("max_pages")
                if isinstance(payload, dict) and isinstance(payload.get("max_pages"), int)
                else pagination.get("max_pages")
            ),
        )
