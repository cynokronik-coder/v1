"""Parser test for the official eBay Browse API path.

Built from the documented item_summary/search shape. Not a live test: it needs
an eBay developer keyset (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET) which CI does not
have, so the HTTP/auth layer stays unverified here - see README "Verification".
"""

from marketwatch.adapters.base import MarketplaceError
from marketwatch.adapters.ebay import EbayBrowseAdapter, parse_ebay_items
from marketwatch.models import SearchQuery

PAYLOAD = {
    "total": 2,
    "limit": 50,
    "offset": 0,
    "itemSummaries": [
        {
            "itemId": "v1|123456789|0",
            "legacyItemId": "123456789",
            "title": "Lenovo ThinkPad T480 i5 16GB",
            "itemWebUrl": "https://www.ebay.fr/itm/123456789",
            "price": {"value": "249.99", "currency": "EUR"},
            "condition": "Used",
            "buyingOptions": ["FIXED_PRICE"],
            "itemCreationDate": "2026-01-02T03:04:05.000Z",
            "shippingOptions": [
                {"shippingCostType": "CALCULATED", "shippingCost": {"value": "12.50", "currency": "EUR"}}
            ],
        },
        {"itemId": "v1|999|0", "title": "no price, no url"},  # must be skipped
    ],
}


def test_parses_summaries_with_shipping_and_no_shipping():
    items = parse_ebay_items(PAYLOAD)
    assert len(items) == 1
    first = items[0]
    assert first.item_id == "123456789"                 # prefer the legacy id
    assert first.price == 249.99 and first.currency == "EUR"
    assert first.landed_price == 262.49                 # price + shipping
    assert first.url == "https://www.ebay.fr/itm/123456789"
    assert first.condition == "Used"
    assert first.created_at is not None and first.created_at.year == 2026
    assert first.marketplace == "ebay"


def test_missing_credentials_raise_a_helpful_error(monkeypatch):
    monkeypatch.delenv("EBAY_CLIENT_ID", raising=False)
    monkeypatch.delenv("EBAY_CLIENT_SECRET", raising=False)
    adapter = EbayBrowseAdapter()
    try:
        adapter.search(SearchQuery(search_text="thinkpad"))
    except MarketplaceError as exc:
        assert "EBAY_CLIENT_ID" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected MarketplaceError without credentials")


def test_search_uses_bearer_token_and_marketplace_header(monkeypatch):
    import httpx

    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 7200})
        captured["headers"] = dict(request.headers)
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json=PAYLOAD)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    adapter = EbayBrowseAdapter(client_id="id", client_secret="secret",
                                marketplace_id="EBAY_FR", client=client)
    result = adapter.search(SearchQuery(search_text="thinkpad t480", per_page=50,
                                        page=2, order="price_asc", min_price=100,
                                        max_price=500, currency="EUR"))
    assert result.total_entries == 2 and len(result.items) == 1
    assert captured["headers"]["authorization"] == "Bearer tok"
    assert captured["headers"]["x-ebay-c-marketplace-id"] == "EBAY_FR"
    assert captured["params"]["offset"] == "50"
    assert captured["params"]["sort"] == "price"
    assert captured["params"]["filter"] == "price:[100..500],priceCurrency:EUR"
