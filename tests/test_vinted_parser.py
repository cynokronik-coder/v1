import json
from pathlib import Path

from marketwatch.adapters.vinted import parse_items

FIXTURE = Path(__file__).parent / "fixtures" / "vinted_search_nike.json"


def test_parses_a_real_captured_payload():
    payload = json.loads(FIXTURE.read_text())
    items = parse_items(payload, domain="vinted.fr")

    assert len(items) == 5 == len(payload["items"])
    first = items[0]
    assert first.item_id == "10355798758"
    assert first.title == "Nike sweats"
    assert first.price == 9.00
    assert first.currency == "USD"          # geo-dependent: never assume EUR
    assert first.landed_price == 10.15      # item + buyer protection fee
    assert first.brand == "Nike"
    assert first.size == "5 ans / 110 cm"
    assert first.condition == "Neuf sans étiquette"
    assert first.url == "https://www.vinted.fr/items/10355798758-nike-sweats"
    assert first.marketplace == "vinted"
    assert all(i.url.startswith("https://") for i in items)


def test_skips_items_without_a_usable_price():
    payload = {
        "items": [
            {"id": 1, "title": "ok", "url": "/items/1", "price": {"amount": "5.00", "currency_code": "EUR"}},
            {"id": 2, "title": "no price", "url": "/items/2"},
            {"id": 3, "title": "garbage price", "url": "/items/3", "price": {"amount": "n/a", "currency_code": "EUR"}},
            {"id": None, "title": "no id", "price": {"amount": "5.00"}},
        ]
    }
    items = parse_items(payload)
    assert [i.item_id for i in items] == ["1"]


def test_landed_price_ignored_when_currency_differs():
    payload = {"items": [{
        "id": 9, "title": "t", "url": "/items/9",
        "price": {"amount": "10.00", "currency_code": "EUR"},
        "total_item_price": {"amount": "11.00", "currency_code": "GBP"},
    }]}
    assert parse_items(payload)[0].landed_price is None


def test_parses_english_labels_when_marketplace_is_localised_differently():
    payload = {"items": [{
        "id": 5, "title": "jacket", "url": "/items/5",
        "price": {"amount": "20.00", "currency_code": "GBP"},
        "item_box": {"first_line": "North Face",
                     "second_line": "M · Very good",
                     "accessibility_label": "jacket, Brand: North Face, Condition: Very good, Size: M"},
    }]}
    item = parse_items(payload, domain="vinted.co.uk")[0]
    assert (item.brand, item.size, item.condition) == ("North Face", "M", "Very good")
    assert item.url == "https://www.vinted.co.uk/items/5"
