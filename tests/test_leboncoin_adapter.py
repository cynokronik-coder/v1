"""Leboncoin adapter behaviour with a mocked transport: no live requests in tests."""

import json

import httpx
import pytest

from marketwatch.adapters.base import (
    MarketplaceBlocked,
    MarketplaceError,
    MarketplaceRateLimited,
)
from marketwatch.adapters.leboncoin import DEFAULT_API_KEY, LeboncoinAdapter
from marketwatch.models import SearchQuery

DATADOME_403 = {
    "url": "https://geo.captcha-delivery.com/captcha/?initialCid=x&cid=y&hash=z",
    "message": "blocked",
}
HOME = "https://www.leboncoin.fr"
API = "https://api.leboncoin.fr/finder/search"

SEARCH_HTML = (
    '<html><body><script id="__NEXT_DATA__" type="application/json">'
    '{"props":{"pageProps":{"searchData":{"ads":[{"list_id":42,"subject":"velo course",'
    '"price_cents":15000,"attributes":[{"key":"condition","value":"etatbon",'
    '"value_label":"Bon état"}]}],"total":1}}}}'
    "</script></body></html>"
)


def client_for(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True, timeout=5)


def adapter(handler, **kw) -> LeboncoinAdapter:
    return LeboncoinAdapter(client=client_for(handler), min_interval=0, jitter=0, max_retries=1, **kw)


def test_bootstraps_a_session_then_posts_the_search_body():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "www.leboncoin.fr" and request.url.path == "/":
            return httpx.Response(200, headers={"set-cookie": "datadome=abc; Path=/"}, text="<html></html>")
        return httpx.Response(200, json={"ads": [{"list_id": 1, "subject": "x", "price_cents": 100}], "total": 70})

    a = adapter(handler)
    result = a.search(SearchQuery(search_text="iphone 13", per_page=10, page=2))

    assert result.total_entries == 70
    assert len(result.items) == 1
    assert str(seen[0].url) == HOME + "/"          # homepage first: it sets the cookies
    call = seen[1]
    assert str(call.url) == API
    assert call.headers["api_key"] == DEFAULT_API_KEY
    body = json.loads(call.content)
    assert body["limit"] == 10 and body["offset"] == 10          # offset paging, not ?page=
    assert body["filters"]["keywords"] == {"text": "iphone 13"}
    assert body["filters"]["enums"] == {"ad_type": ["offer"]}    # never mix in wanted ads


def test_prices_in_the_api_filter_are_cents_and_the_page_url_uses_euros():
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/":
            return httpx.Response(200, text="")
        if request.url.host == "api.leboncoin.fr":
            return httpx.Response(200, json={"ads": [], "total": 0})
        return httpx.Response(200, text=SEARCH_HTML)

    query = SearchQuery(search_text="iphone 13", min_price=100, max_price=400, per_page=96)
    adapter(handler).search(query)
    body = json.loads(captured[-1].content)
    assert body["filters"]["ranges"]["price"] == {"min": 10000, "max": 40000}
    assert body["limit"] == 35                       # clamped: leboncoin rejects more

    listed: list[httpx.Request] = []

    def page_handler(request: httpx.Request) -> httpx.Response:
        listed.append(request)
        if request.url.path == "/":
            return httpx.Response(200, text="")
        return httpx.Response(200, text=SEARCH_HTML, headers={"content-type": "text/html"})

    adapter(page_handler, transport="page").search(query)
    page_call = listed[-1]
    assert page_call.url.host == "www.leboncoin.fr"
    assert page_call.url.params["text"] == "iphone 13"
    assert page_call.url.params["price"] == "100-400"    # euros here, not cents
    assert page_call.url.params["limit"] == "35"


def test_translates_order_category_and_location():
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/":
            return httpx.Response(200, text="")
        return httpx.Response(200, json={"ads": [], "total": 0})

    adapter(handler).search(SearchQuery(
        search_text="velo", order="newest",
        filters={"category": ["55"], "regions": ["12"], "owner_type": ["private"]},
    ))
    body = json.loads(captured[-1].content)
    assert body["sort_by"] == "time" and body["sort_order"] == "desc"
    assert body["filters"]["category"] == {"id": "55"}
    assert body["filters"]["location"] == {"regions": ["12"]}
    assert body["filters"]["enums"]["owner_type"] == ["private"]


def test_datadome_challenge_is_reported_with_advice_and_no_retry_storm():
    state = {"home": 0, "api": 0, "page": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            state["home"] += 1
            return httpx.Response(200, text="")
        if request.url.host == "api.leboncoin.fr":
            state["api"] += 1
        else:
            state["page"] += 1
        return httpx.Response(403, json=DATADOME_403)

    with pytest.raises(MarketplaceBlocked) as exc:
        adapter(handler, transport="api").search(SearchQuery(search_text="velo"))

    assert state["api"] == 1                       # a challenge is not retried
    message = str(exc.value)
    assert "DataDome" in message and "README.md" in message
    assert "MARKETWATCH_LBC_COOKIE" in message
    assert "CAPTCHAs" in message                   # we say what we will not do


def test_auto_transport_falls_back_from_api_to_the_page():
    hits: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            return httpx.Response(200, text="")
        if request.url.host == "api.leboncoin.fr":
            hits.append("api")
            return httpx.Response(403, json=DATADOME_403)
        hits.append("page")
        return httpx.Response(200, text=SEARCH_HTML, headers={"content-type": "text/html"})

    result = adapter(handler).search(SearchQuery(search_text="velo"))

    assert hits == ["api", "page"]
    assert len(result.items) == 1
    assert result.items[0].price == 150.0
    assert result.items[0].condition == "Bon état"


def test_a_challenged_homepage_still_lets_the_api_transport_try():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            return httpx.Response(403, json=DATADOME_403)
        return httpx.Response(200, json={"ads": [{"list_id": 1, "subject": "x", "price_cents": 100}]})

    result = adapter(handler).search(SearchQuery(search_text="velo"))
    assert len(result.items) == 1


def test_rate_limit_after_retries_raises_rate_limited():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            return httpx.Response(200, text="")
        return httpx.Response(429, headers={"Retry-After": "0"})

    with pytest.raises(MarketplaceRateLimited):
        adapter(handler).search(SearchQuery(search_text="velo"))


def test_200_page_without_embedded_ads_is_an_explicit_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            return httpx.Response(200, text="")
        return httpx.Response(200, text="<html>no data</html>", headers={"content-type": "text/html"})

    with pytest.raises(MarketplaceError, match="no embedded listing JSON"):
        adapter(handler, transport="page").search(SearchQuery(search_text="velo"))


def test_drops_wanted_ads_sold_listings_and_other_seller_types():
    payload = {"ads": [
        {"list_id": 1, "subject": "offre", "price_cents": 100, "ad_type": "offer", "status": "active"},
        {"list_id": 2, "subject": "demande", "price_cents": 100, "ad_type": "demand", "status": "active"},
        {"list_id": 3, "subject": "vendu", "price_cents": 100, "ad_type": "offer", "status": "sold"},
        {"list_id": 4, "subject": "pro", "price_cents": 100, "ad_type": "offer",
         "status": "active", "owner": {"type": "pro"}},
    ]}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            return httpx.Response(200, text="")
        return httpx.Response(200, json=payload)

    kept = adapter(handler).search(SearchQuery(search_text="x", filters={"owner_type": ["private"]}))
    assert [i.item_id for i in kept.items] == ["1"]
    everything = adapter(handler).search(SearchQuery(search_text="x"))
    assert [i.item_id for i in everything.items] == ["1", "4"]


def test_a_watch_from_the_shipped_example_builds_a_complete_request():
    """config/watch -> SearchQuery.filters -> request body, with no glue missing."""
    from pathlib import Path

    from marketwatch.config import load_watches

    watch = next(w for w in load_watches(Path("config/watches.example.yaml"))
                 if w.marketplace == "leboncoin")
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.path == "/":
            return httpx.Response(200, text="")
        return httpx.Response(200, json={"ads": [], "total": 0})

    adapter(handler).search(SearchQuery(
        search_text=watch.search_text, filters=watch.filters,
        min_price=watch.plausible_min_price, max_price=watch.plausible_max_price,
    ))
    body = json.loads(sent[-1].content)
    assert body["filters"]["keywords"] == {"text": "iphone 13 128"}
    assert body["filters"]["category"] == {"id": "2978"}
    assert body["filters"]["enums"]["owner_type"] == ["private"]
    assert body["filters"]["ranges"]["price"] == {"min": 12000, "max": 60000}


def test_retry_after_and_url_building_helpers():
    assert LeboncoinAdapter._retry_after("7") == 7.0
    assert LeboncoinAdapter._retry_after(None) is None

    a = adapter(lambda r: httpx.Response(200, json={}))
    url = a._search_url(SearchQuery(search_text="vélo électrique", min_price=200, order="newest"))
    assert "text=v%C3%A9lo+%C3%A9lectrique" in url or "text=v%C3%A9lo%20%C3%A9lectrique" in url
    assert "sort=time" in url and "page=1" in url
