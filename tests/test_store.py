from datetime import datetime, timedelta, timezone

from marketwatch.analyzer import build_stats
from marketwatch.models import Deal, Listing
from marketwatch.store import Store


def listing(price=100.0, item_id="1", title="thing"):
    return Listing(marketplace="mock", item_id=item_id, title=title, url="http://x", price=price, currency="EUR")


def deal(price=50.0, item_id="1"):
    return Deal(watch="w", listing=listing(price, item_id), market_price=200.0, discount_pct=0.75, robust_z=-4.0)


def test_listing_lifecycle_and_price_history():
    with Store(":memory:") as store:
        assert store.note_listing(listing(100.0), "w") is True   # first time seen
        assert store.note_listing(listing(90.0), "w") is False   # same item again
        assert store.note_listing(listing(100.0), "other-watch") is True
        assert store.seen_item_ids("w") == {"1"}
        assert store.price_history(listing(0.0), "w") == [100.0, 90.0]


def test_alert_dedupe_and_price_drop_realert():
    with Store(":memory:") as store:
        assert store.mark_alert(deal(price=50.0)) is True            # new bargain
        assert store.mark_alert(deal(price=50.0)) is False           # unchanged -> no spam
        assert store.mark_alert(deal(price=51.0)) is False           # slightly higher -> no
        assert store.mark_alert(deal(price=44.0)) is True            # 12% cheaper -> tell again
        assert store.mark_alert(deal(price=44.0)) is False
        stored = store.recent_alerts(limit=10)
        assert len(stored) == 1 and stored[0].listing.price == 44.0
        assert stored[0].watch == "w" and stored[0].market_price == 200.0


def test_stats_cache_roundtrip_and_ttl():
    with Store(":memory:") as store:
        stats = build_stats([180, 190, 200, 210, 220], "EUR")
        store.save_stats("w", stats)
        cached = store.load_stats("w", ttl_seconds=3600)
        assert cached is not None and cached.median == stats.median

        stale = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        store.conn.execute("UPDATE comp_stats SET computed_at=? WHERE watch='w'", (stale,))
        store.conn.commit()
        assert store.load_stats("w", ttl_seconds=60) is None        # expired
        assert store.load_stats("w", ttl_seconds=-1) is not None    # ttl<0 = never expire
        assert store.load_stats("missing", ttl_seconds=60) is None
