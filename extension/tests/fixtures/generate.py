"""Regenerate parity.json: the Python implementation's answers, for the JS port to match.

    uv run python extension/tests/fixtures/generate.py

The extension is a JavaScript re-implementation, so "it looks right" is not good
enough for the statistics or the parser: this script runs the reference
implementation in src/marketwatch and writes its exact outputs here. The extension's
node tests then assert the JS produces the same numbers.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "src"))

from marketwatch.analyzer import (  # noqa: E402
    build_stats,
    explain_no_deals,
    find_deals,
)
from marketwatch.adapters.leboncoin import parse_ads  # noqa: E402
from marketwatch.adapters.vinted import parse_items  # noqa: E402
from marketwatch.models import Listing, Watch  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"


def stats_case(name: str, prices: list[float], currency: str = "EUR") -> dict:
    stats = build_stats(prices, currency)
    return {
        "name": name,
        "prices": prices,
        "currency": currency,
        "expected": {
            "sampleSize": stats.sample_size,
            "usedSize": stats.used_size,
            "median": stats.median,
            "mean": stats.mean,
            "q1": stats.q1,
            "q3": stats.q3,
            "mad": stats.mad,
            "lowerFence": stats.lower_fence,
        },
    }


def listing_payload(item_id: str, price: float, **kw) -> dict:
    """Exactly the fields the JS Listing carries, so both sides compare like for like."""
    return {
        "itemId": item_id,
        "title": kw.get("title", f"item {item_id}"),
        "price": price,
        "currency": kw.get("currency", "EUR"),
        "condition": kw.get("condition"),
        "size": kw.get("size"),
        "brand": kw.get("brand"),
        "landedPrice": kw.get("landed_price"),
        "favourites": kw.get("favourites"),
        "createdAt": kw.get("created_at"),
    }


def py_listing(payload: dict, marketplace: str = "mock") -> Listing:
    return Listing(
        marketplace=marketplace,
        item_id=payload["itemId"],
        title=payload["title"],
        url=f"https://example.invalid/{payload['itemId']}",
        price=payload["price"],
        currency=payload["currency"],
        condition=payload["condition"],
        size=payload["size"],
        brand=payload["brand"],
        landed_price=payload["landedPrice"],
        favourites=payload["favourites"],
        created_at=payload["createdAt"],
    )


def deal_case(name: str, watch_kwargs: dict, pool: list[dict], candidates: list[dict]) -> dict:
    watch = Watch(name=name[:40], search_text="thing", marketplace="mock", **watch_kwargs)
    comparables = [py_listing(p) for p in pool]
    currency = comparables[0].currency
    stats = build_stats([c.price for c in comparables], currency)
    deals = find_deals([py_listing(c) for c in candidates], stats, watch)
    notes = explain_no_deals([py_listing(c) for c in candidates], stats, watch)
    return {
        "name": name,
        "watch": {
            "name": watch.name,
            "searchText": watch.search_text,
            "marketplace": "mock",
            "mustMatch": watch.must_match,
            "mustNotMatch": watch.must_not_match,
            "sizes": watch.sizes,
            "conditions": watch.conditions,
            "plausibleMinPrice": watch.plausible_min_price,
            "plausibleMaxPrice": watch.plausible_max_price,
            "minSampleSize": watch.min_sample_size,
            "minDiscount": watch.min_discount,
            "maxRobustZ": watch.max_robust_z,
        },
        "pool": pool,
        "candidates": candidates,
        "expectedStats": {
            "sampleSize": stats.sample_size,
            "usedSize": stats.used_size,
            "median": stats.median,
            "q1": stats.q1,
            "q3": stats.q3,
            "mad": stats.mad,
        },
        "expectedDeals": [
            {
                "itemId": d.listing.item_id,
                "price": d.listing.price,
                "marketPrice": d.market_price,
                "discountPct": d.discount_pct,
                "robustZ": d.robust_z,
            }
            for d in deals
        ],
        "expectedNotes": notes,
    }


def build_stats_cases() -> list[dict]:
    rng = random.Random(11)
    cases = [
        stats_case("single value", [42.0]),
        stats_case("odd count", [3.0, 1.0, 2.0]),
        stats_case("even count", [4.0, 1.0, 3.0, 2.0]),
        stats_case("flat pool (mad 0 -> sigma fallback)", [100.0] * 12),
        stats_case("junk outlier is trimmed", [200, 210, 220, 190, 205, 215, 195, 225, 185, 230, 1.0]),
        stats_case("tiny pool is never trimmed", [10.0, 20.0, 30.0]),
        stats_case("wide but honest pool", [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]),
        stats_case("200 seeded prices", [round(rng.uniform(20, 400), 2) for _ in range(200)]),
        stats_case("two prices", [100.0, 300.0]),
        stats_case("usd pool", [10.0, 11.0, 12.0, 13.0, 14.0], "USD"),
    ]
    return cases


def build_deal_cases() -> list[dict]:
    rng = random.Random(7)
    normal = [
        listing_payload(f"std{i}", round(200 * (1 + rng.uniform(-0.3, 0.3)), 2), title="nike air max 90 sneaker",
                        condition="very good", size="42")
        for i in range(24)
    ]
    garden = [
        listing_payload(f"g{i}", round(500 * (1 + rng.uniform(-0.4, 0.4)), 2), title="garden table oak",
                        condition="used", size="140 cm")
        for i in range(20)
    ]
    cases = [
        deal_case(
            "planted bargains are found, junk and variants are not",
            {"min_sample_size": 8, "min_discount": 0.30, "max_robust_z": -1.0,
             "plausible_min_price": 20, "plausible_max_price": 500,
             "must_not_match": ["kids"], "sizes": ["42"]},
            normal,
            normal
            + [
                listing_payload("bargain1", 120.0, title="nike air max 90 sneaker", condition="very good", size="42"),
                listing_payload("bargain2", 100.0, title="nike air max 90 sneaker", condition="very good", size="42"),
                listing_payload("kids", 95.0, title="nike air max 90 kids", condition="very good", size="42"),
                listing_payload("wrongsize", 90.0, title="nike air max 90 sneaker", condition="very good", size="39"),
                listing_payload("junk", 1.0, title="nike air max 90 sneaker", condition="very good", size="42"),
            ],
        ),
        deal_case(
            "z-gate off: discount alone decides",
            {"min_sample_size": 8, "min_discount": 0.25, "max_robust_z": None,
             "plausible_min_price": 50, "plausible_max_price": 2000},
            garden,
            garden
            + [
                listing_payload("deal-a", 250.0, title="garden table oak", condition="used", size="140 cm"),
                listing_payload("deal-b", 180.0, title="garden table oak", condition="used", size="140 cm"),
            ],
        ),
        deal_case(
            "strict z-gate rejects a merely cheap listing",
            {"min_sample_size": 8, "min_discount": 0.20, "max_robust_z": -3.0,
             "plausible_min_price": 20, "plausible_max_price": 900},
            normal,
            normal + [listing_payload("cheapish", 140.0, title="nike air max 90 sneaker", size="42")],
        ),
        deal_case(
            "thin market: below min_sample_size means no verdict",
            {"min_sample_size": 30, "min_discount": 0.30, "max_robust_z": -1.0,
             "plausible_min_price": 20, "plausible_max_price": 900},
            normal[:6],
            normal[:6] + [listing_payload("cheap", 60.0, title="nike air max 90 sneaker", size="42")],
        ),
        deal_case(
            "condition allowlist keeps non-comparable listings out",
            {"min_sample_size": 5, "min_discount": 0.30, "max_robust_z": None,
             "plausible_min_price": 20, "plausible_max_price": 900,
             "conditions": ["very good"]},
            normal[:12],
            normal[:12]
            + [
                listing_payload("ok-cond", 110.0, title="nike air max 90 sneaker", condition="very good", size="42"),
                listing_payload("bad-cond", 90.0, title="nike air max 90 sneaker", condition="for parts", size="42"),
            ],
        ),
    ]
    return cases


def vinted_parse_case() -> dict:
    payload = json.loads((FIXTURES / "vinted_search_nike.json").read_text())
    items = parse_items(payload, domain="vinted.fr")
    return {
        "source": "tests/fixtures/vinted_search_nike.json",
        "payload": payload,
        "expected": [
            {
                "itemId": i.item_id,
                "title": i.title,
                "url": i.url,
                "price": i.price,
                "currency": i.currency,
                "landedPrice": i.landed_price,
                "condition": i.condition,
                "brand": i.brand,
                "size": i.size,
                "favourites": i.favourites,
            }
            for i in items
        ],
    }


def leboncoin_parse_case() -> dict:
    payload = json.loads((FIXTURES / "leboncoin_search.json").read_text())
    items = parse_ads(payload)
    return {
        "source": "tests/fixtures/leboncoin_search.json",
        "payload": payload,
        "expected": [
            {
                "itemId": i.item_id,
                "title": i.title,
                "url": i.url,
                "price": i.price,
                "currency": i.currency,
                "condition": i.condition,
                "brand": i.brand,
                "size": i.size,
                "createdAt": i.created_at.astimezone(__import__("datetime").timezone.utc).isoformat()
                if i.created_at
                else None,
                "sellerType": (i.raw or {}).get("seller_type"),
            }
            for i in items
        ],
    }


def main() -> None:
    out = {
        "_generated_by": "extension/tests/fixtures/generate.py (runs the Python implementation)",
        "_why": "the JS port must reproduce these numbers exactly",
        "stats": build_stats_cases(),
        "deals": build_deal_cases(),
        "vinted": vinted_parse_case(),
        "leboncoin": leboncoin_parse_case(),
    }
    target = Path(__file__).with_name("parity.json")
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    print(f"  stats cases: {len(out['stats'])}, deal cases: {len(out['deals'])}")
    print(f"  vinted items: {len(out['vinted']['expected'])}, leboncoin items: {len(out['leboncoin']['expected'])}")


if __name__ == "__main__":
    main()
