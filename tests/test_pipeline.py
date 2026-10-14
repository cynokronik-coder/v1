from marketwatch.adapters.mock import MockAdapter
from marketwatch.models import Listing, Watch
from marketwatch.pipeline import Scanner, summarize
from marketwatch.store import Store

WATCH = Watch(
    name="air-max",
    search_text="nike air max 90",
    marketplace="mock",
    must_not_match=["kids"],
    plausible_min_price=20,
    plausible_max_price=500,
    min_discount=0.30,
    max_robust_z=-1.0,
    min_sample_size=5,
    sample_pages=1,
    comps_ttl_seconds=900,
)


def market():
    """29 listings symmetric around 200, two bargains, two junk listings."""
    items = [
        Listing(marketplace="mock", item_id=f"std{i}", title="nike air max 90 sneaker",
                url="http://x", price=200 - 14 + i, currency="EUR",
                condition="very good", size="42")
        for i in range(29)
    ]
    items += [
        Listing(marketplace="mock", item_id="bargain1", title="nike air max 90 rare",
                url="http://x/b1", price=120.0, currency="EUR", condition="good", size="42"),
        Listing(marketplace="mock", item_id="bargain2", title="nike air max 90 rare",
                url="http://x/b2", price=100.0, currency="EUR", condition="good", size="42"),
        Listing(marketplace="mock", item_id="junk1", title="nike air max 90 kids",
                url="http://x/j1", price=95.0, currency="EUR", condition="good", size="42"),
        Listing(marketplace="mock", item_id="junk2", title="nike air max 90 sole only",
                url="http://x/j2", price=1.0, currency="EUR", condition="good", size="42"),
    ]
    return items


def scanner(store):
    return Scanner(store, adapter_factory=lambda name, **kw: MockAdapter(market=WATCH.search_text and {"nike air max 90": market()}, **kw))


def test_scan_estimates_market_and_finds_only_real_bargains():
    with Store(":memory:") as store:
        s = scanner(store)
        report = s.scan(WATCH)
        s.close()

    assert report.stats is not None
    assert report.stats.median == 200.0
    # the 2 bargains are comparable, but the IQR fence trims them out of the
    # baseline on purpose: the baseline should describe normal pricing.
    assert (report.stats.sample_size, report.stats.used_size) == (31, 29)
    assert report.requests_made == 2               # 1 baseline page + 1 newest page
    assert [d.listing.item_id for d in report.deals] == ["bargain2", "bargain1"]
    assert [round(d.discount_pct, 2) for d in report.deals] == [0.50, 0.40]
    # never scored as deals: the "kids" variant (must_not_match) and the 1.00 junk
    assert {d.listing.item_id for d in report.deals} == {"bargain1", "bargain2"}
    assert len(report.comparables) == 31 and len(report.candidates) == 33


def test_watch_mode_reports_each_bargain_only_once():
    with Store(":memory:") as store:
        s = scanner(store)
        first = s.scan(WATCH)
        assert len(first.new_deals) == 2

        second = s.scan(WATCH)
        assert second.deals and second.new_deals == []          # known bargains: silent
        assert any("reused from cache" in n for n in second.notes)
        assert second.requests_made == 1                        # baseline came from cache

        third = s.scan(WATCH, force_baseline=True)
        assert third.requests_made == 2 and third.new_deals == []

        summary = summarize([first, second, third])
        s.close()

    assert summary["deals"] == 6 and summary["new_deals"] == 2 and summary["requests"] == 5


def test_generated_market_finds_the_planted_bargains():
    with Store(":memory:") as store:
        s = Scanner(store, adapter_factory=lambda name, **kw: MockAdapter(**kw))
        report = s.scan(WATCH.model_copy(update={"min_sample_size": 10}))
        s.close()
    prices = {d.listing.price for d in report.deals}
    assert {110.0, 120.0, 130.0} <= prices          # MockAdapter's planted bargains
    assert all(p > 5 for p in prices)               # junk listings stay out


def test_a_blocked_marketplace_does_not_stop_the_other_watches():
    """leboncoin 403s must not take the dashboard (or other watches) down with it."""
    from marketwatch.adapters.base import MarketplaceBlocked
    from marketwatch.pipeline import watch_loop

    blocked = WATCH.model_copy(update={"name": "blocked", "search_text": "leboncoin thing"})
    healthy = WATCH.model_copy(update={"name": "healthy", "search_text": "nike air max 90"})

    def factory(name, **kw):
        adapter = MockAdapter(market={"nike air max 90": market()}, **kw)

        original = adapter.search

        def search(query):
            if query.search_text == "leboncoin thing":
                raise MarketplaceBlocked("leboncoin refused (DataDome)")
            return original(query)

        adapter.search = search  # type: ignore[method-assign]
        return adapter

    errors: list[tuple[str, str]] = []
    seen: list[str] = []
    with Store(":memory:") as store:
        reports = watch_loop(
            Scanner(store, adapter_factory=factory),
            [blocked, healthy],
            interval=0,
            cycles=2,
            on_report=lambda r: seen.append(r.watch.name),
            on_error=lambda w, exc: errors.append((w.name, str(exc))),
            sleep=lambda _: None,
        )

    assert [e[0] for e in errors] == ["blocked", "blocked"]     # reported every pass
    assert all("DataDome" in e[1] for e in errors)
    assert seen == ["healthy", "healthy"]                        # never stopped
    assert len(reports) == 2


def test_foreign_currency_candidates_are_never_scored():
    """A price is only comparable inside one currency.

    The baseline keeps a single currency, but the freshness page does not: without
    this guard a GBP listing could be scored against a EUR median and look 40% under.
    """
    pool = market()
    pool.append(
        Listing(marketplace="mock", item_id="gbp-bargain", title="nike air max 90 sneaker",
                url="http://x/gbp", price=60.0, currency="GBP", condition="good", size="42")
    )

    with Store(":memory:") as store:
        s = Scanner(store, adapter_factory=lambda name, **kw: MockAdapter(market={"nike air max 90": pool}, **kw))
        report = s.scan(WATCH)
        s.close()

    assert report.stats.currency == "EUR"
    assert "gbp-bargain" not in {d.listing.item_id for d in report.deals}
    assert not any(d.listing.currency != "EUR" for d in report.deals)
    assert any("another currency" in n and "GBP" in n for n in report.notes)


def test_marketplace_error_is_reported_not_raised():
    from marketwatch.adapters.base import MarketplaceError

    def factory(name, **kw):
        adapter = MockAdapter(**kw)
        def boom(query):
            raise MarketplaceError("marketplace exploded")
        adapter.search = boom  # type: ignore[method-assign]
        return adapter

    with Store(":memory:") as store:
        reports = Scanner(store, adapter_factory=factory).scan_all([WATCH])
    assert len(reports) == 1
    assert reports[0].deals == [] and "exploded" in reports[0].notes[0]
