"""Parser tests for the leboncoin ad shape, run against real captured records."""

import json
from pathlib import Path

from marketwatch.adapters.leboncoin import (
    find_ads_in_page,
    parse_ads,
    parse_datetime,
    parse_price,
)

FIXTURE = Path(__file__).parent / "fixtures" / "leboncoin_search.json"


def load() -> dict:
    return json.loads(FIXTURE.read_text())


def test_parses_a_real_captured_payload():
    payload = load()
    items = parse_ads(payload)

    assert len(items) == 8 == len(payload["ads"])
    first = items[0]
    assert first.marketplace == "leboncoin"
    assert first.item_id == "3055076563"
    assert first.title == "Boîte coffe"
    assert first.price == 4.00                 # price_cents 400
    assert first.currency == "EUR"             # leboncoin is euro-only
    assert first.url == "https://www.leboncoin.fr/ad/arts_de_la_table/3055076563"
    assert all(i.url.startswith("https://www.leboncoin.fr/ad/") for i in items)


def test_every_price_matches_price_cents():
    payload = load()
    items = parse_ads(payload)
    by_id = {i.item_id: i for i in items}
    for ad in payload["ads"]:
        assert by_id[str(ad["list_id"])].price == round(ad["price_cents"] / 100, 2)


def test_condition_comes_from_the_attribute_label():
    payload = load()
    for ad in payload["ads"]:
        attrs = {a["key"]: a for a in ad.get("attributes") or []}
        if "condition" not in attrs:
            continue
        item = next(i for i in parse_ads(payload) if i.item_id == str(ad["list_id"]))
        assert item.condition == attrs["condition"]["value_label"] == "État neuf"
        return
    raise AssertionError("fixture no longer exercises the condition attribute")


def test_site_brand_is_not_treated_as_an_item_brand():
    """Capture tools put `brand: "leboncoin"` in every record; it is not a brand."""
    payload = load()
    assert all(ad.get("brand") == "leboncoin" for ad in payload["ads"])
    assert all(item.brand is None for item in parse_ads(payload))


def test_converts_paris_local_dates_to_utc():
    # 15:55 Paris (CEST, UTC+2) in September -> 13:55 UTC
    dt = parse_datetime({"index_date": "2025-09-10 15:55:18"})
    assert dt is not None and dt.tzinfo is not None
    assert (dt.hour, dt.minute, dt.utcoffset().total_seconds()) == (13, 55, 0)
    assert parse_datetime({}) is None


def test_price_shapes_seen_in_the_wild():
    assert parse_price({"price_cents": 400}) == 4.00
    assert parse_price({"price": [4]}) == 4.0          # single-element list
    assert parse_price({"price": 12.5}) == 12.5        # plain scalar
    assert parse_price({"price": {"value": 30}}) == 30  # object form
    assert parse_price({"price": {"amount": "30,50"}}) == 30.5  # French decimal
    assert parse_price({"price": []}) is None
    assert parse_price({"price": [None], "price_cents": None}) is None
    assert parse_price({}) is None
    assert parse_price({"price_cents": 0.0, "price": [7]}) == 0.0  # free items stay 0


def test_skips_ads_without_an_id_or_a_price():
    payload = {"ads": [
        {"list_id": 1, "subject": "ok", "price_cents": 500},
        {"list_id": 2, "subject": "no price"},
        {"subject": "no id", "price_cents": 500},
        {"list_id": 4, "subject": "garbage", "price": [None]},
    ]}
    assert [i.item_id for i in parse_ads(payload)] == ["1"]


def test_accepts_a_bare_list_of_ads_too():
    assert len(parse_ads([{"list_id": 9, "subject": "t", "price_cents": 100}])) == 1


def test_reads_size_and_brand_attributes_when_present():
    payload = {"ads": [{
        "list_id": 7, "subject": "doudoune", "price_cents": 4500,
        "attributes": [
            {"key": "brand", "value": "270", "value_label": "The North Face"},
            {"key": "size", "value": "l", "value_label": "L"},
            {"key": "condition", "value": "etattresbon", "value_label": "Très bon état"},
        ],
    }]}
    item = parse_ads(payload)[0]
    assert (item.brand, item.size, item.condition) == ("The North Face", "L", "Très bon état")


def test_keeps_seller_and_location_metadata_for_diagnostics():
    item = parse_ads(load())[0]
    assert item.raw["seller_type"] == "private"
    assert item.raw["seller_name"]
    assert item.raw["zipcode"] == "31000"
    assert item.raw["ad_type"] == "offer"


def test_finds_ads_embedded_in_a_nextjs_page():
    html = (
        '<html><body><script id="__NEXT_DATA__" type="application/json">'
        '{"props":{"pageProps":{"searchData":{"ads":[{"list_id":42,"subject":"velo",'
        '"price_cents":15000}],"total":1}}}}'
        "</script></body></html>"
    )
    ads = find_ads_in_page(html)
    assert [a["list_id"] for a in ads] == [42]
    assert parse_ads({"ads": ads})[0].price == 150.0
    assert find_ads_in_page("<html>no payload here</html>") == []
    assert find_ads_in_page('<script id="__NEXT_DATA__" type="application/json">{oops</script>') == []


def test_finds_ads_nested_under_an_unexpected_key():
    """The exact JSON path moves between releases, so lookups must not hard-code it."""
    html = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props":{"pageProps":{"someRenamedNode":{"list":[{"list_id":5,"price_cents":100}]}}}}'
        "</script>"
    )
    assert [a["list_id"] for a in find_ads_in_page(html)] == [5]
