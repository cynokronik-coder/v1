"""Adapter behaviour with a mocked HTTP transport: no live requests in tests."""

import httpx
import pytest

from marketwatch.adapters.base import MarketplaceBlocked, MarketplaceError, MarketplaceRateLimited
from marketwatch.adapters.vinted import VintedAdapter
from marketwatch.models import SearchQuery

ANON_COOKIE = {"set-cookie": "anon_id=abc-123; Path=/; Domain=.vinted.fr"}
EMPTY_PAGE = {"items": [], "pagination": {"current_page": 1, "per_page": 24, "total_entries": 0, "total_pages": 0}}


def client_for(handler: callable) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True, timeout=5)


def adapter(handler, **kw) -> VintedAdapter:
    return VintedAdapter(client=client_for(handler), min_interval=0, jitter=0, max_retries=1, **kw)


def test_bootstraps_anonymous_session_and_sends_anon_id():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "www.vinted.fr":
            return httpx.Response(200, headers=ANON_COOKIE, text="<html></html>")
        return httpx.Response(200, json=EMPTY_PAGE)

    a = adapter(handler)
    result = a.search(SearchQuery(search_text="nike air max 90", per_page=24, order="newest"))
    assert result.total_entries == 0

    assert str(seen[0].url) == "https://www.vinted.fr/"          # homepage first
    api_call = seen[1]
    assert api_call.url.host == "api.vinted.fr"
    assert api_call.url.path == "/svc-catalogue/items"
    assert api_call.headers["X-Anon-Id"] == "abc-123"
    assert api_call.url.params["search_text"] == "nike air max 90"
    assert api_call.url.params["order"] == "newest_first"        # translated from "newest"
    assert api_call.url.params["per_page"] == "24"


def test_builds_filters_price_bounds_and_currency():
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.vinted.fr":
            return httpx.Response(200, headers=ANON_COOKIE, text="")
        captured.update(dict(request.url.params))
        return httpx.Response(200, json=EMPTY_PAGE)

    a = adapter(handler)
    a.search(SearchQuery(
        search_text="iphone 13", filters={"brand": ["53", "417"], "catalog": ["2996"]},
        min_price=100, max_price=400, currency="EUR", order="price_asc", page=2,
    ))
    assert captured["price_from"] == "100"
    assert captured["price_to"] == "400"
    assert captured["currency"] == "EUR"
    assert captured["order"] == "price_low_to_high"
    assert captured["page"] == "2"
    assert captured["attribute_ids[brand]"] == "53,417"
    assert captured["attribute_ids[catalog]"] == "2996"


def test_forbidden_refreshes_the_session_once_then_stops():
    state = {"home": 0, "api": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.vinted.fr":
            state["home"] += 1
            return httpx.Response(200, headers=ANON_COOKIE, text="")
        state["api"] += 1
        return httpx.Response(403, json={"code": "FORBIDDEN", "message": "Access denied."})

    with pytest.raises(MarketplaceBlocked) as exc:
        adapter(handler).search(SearchQuery(search_text="nike"))
    assert state == {"home": 2, "api": 2}  # one refresh attempt, then we stop
    assert "never" not in str(exc.value) and "README" in str(exc.value)


def test_rate_limit_after_retries_raises_rate_limited():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.vinted.fr":
            return httpx.Response(200, headers=ANON_COOKIE, text="")
        return httpx.Response(429, headers={"Retry-After": "0"})

    with pytest.raises(MarketplaceRateLimited):
        adapter(handler).search(SearchQuery(search_text="nike"))


def test_html_instead_of_json_is_reported_as_a_challenge():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.vinted.fr":
            return httpx.Response(200, headers=ANON_COOKIE, text="")
        return httpx.Response(200, text="<html>please verify you are human</html>",
                              headers={"content-type": "text/html"})

    with pytest.raises(MarketplaceError, match="challenge"):
        adapter(handler).search(SearchQuery(search_text="nike"))


def test_retry_after_parsing():
    assert VintedAdapter._retry_after("7") == 7.0
    assert VintedAdapter._retry_after(None) is None
    assert VintedAdapter._retry_after("Wed, 21 Oct 2015 07:28:00 GMT") is None
    assert VintedAdapter._backoff(3) > 0
