"""Scan pipeline: fetch -> build baseline -> score -> persist -> report.

One scan pass per watch does two kinds of request:

  1. baseline  - `sample_pages` pages of the general search to sample the
                 market (expensive, so cached for `comps_ttl_seconds`)
  2. freshness - page 1 sorted by newest, to catch just-posted listings

Both are normalised, filtered for comparability, then every listing we saw is
scored against the baseline. Requests are serialised with jitter by the
adapters; nothing here runs in parallel on purpose.
"""

from __future__ import annotations

import random
import time
from collections import Counter
from typing import Callable, Iterable, Sequence

from .adapters.base import MarketplaceAdapter, MarketplaceBlocked, MarketplaceError, get_adapter
from .analyzer import build_stats, explain_no_deals, filter_comparables, find_deals
from .models import Deal, Listing, PriceStats, SearchQuery, Watch, WatchReport
from .store import Store

DEFAULT_PER_PAGE = 96


class Scanner:
    def __init__(
        self,
        store: Store,
        *,
        vinted_min_interval: float = 6.0,
        vinted_jitter: float = 3.0,
        lbc_transport: str = "auto",
        adapter_factory: Callable[..., MarketplaceAdapter] = get_adapter,
    ) -> None:
        self.store = store
        self.vinted_min_interval = vinted_min_interval
        self.vinted_jitter = vinted_jitter
        self.lbc_transport = lbc_transport
        self._adapter_factory = adapter_factory
        self._adapters: dict[tuple[str, str | None], MarketplaceAdapter] = {}
        self._request_count = 0

    # --- adapters ---------------------------------------------------------
    def adapter_for(self, watch: Watch) -> MarketplaceAdapter:
        tag = watch.domain or watch.marketplace_id
        key = (watch.marketplace, tag)
        if key not in self._adapters:
            kwargs: dict[str, object] = {}
            if watch.marketplace == "vinted":
                kwargs.update(
                    domain=watch.domain,
                    min_interval=self.vinted_min_interval,
                    jitter=self.vinted_jitter,
                )
            elif watch.marketplace in {"leboncoin", "lbc"}:
                # DataDome on leboncoin is stricter than Vinted, so never poll it
                # faster than one request every 8s no matter how the CLI is set.
                kwargs.update(
                    domain=watch.domain,
                    min_interval=max(self.vinted_min_interval, 8.0),
                    jitter=max(self.vinted_jitter, 3.0),
                    transport=self.lbc_transport,
                )
            elif watch.marketplace == "ebay":
                kwargs.update(marketplace_id=watch.marketplace_id)
            self._adapters[key] = self._adapter_factory(watch.marketplace, **kwargs)
        return self._adapters[key]

    def search_preview(self, watch: Watch, *, per_page: int = 5) -> list[Listing]:
        """A single cheap search, used by `marketwatch doctor`."""
        return self._search(watch, SearchQuery(search_text=watch.search_text, per_page=per_page))

    def _search(self, watch: Watch, query: SearchQuery) -> list[Listing]:
        adapter = self.adapter_for(watch)
        result = adapter.search(query)
        self._request_count += 1
        return result.items

    def close(self) -> None:
        for adapter in self._adapters.values():
            close = getattr(adapter, "close", None)
            if callable(close):
                close()

    # --- baseline ---------------------------------------------------------
    def build_baseline(
        self, watch: Watch, *, force: bool = False
    ) -> tuple[PriceStats | None, list[Listing], list[str]]:
        """Estimate the market price of `watch.search_text`."""
        notes: list[str] = []
        if not force:
            cached = self.store.load_stats(watch.name, watch.comps_ttl_seconds)
            if cached is not None:
                return cached, [], [f"baseline reused from cache ({cached.used_size} comparables)"]

        pool: list[Listing] = []
        for page in range(1, max(1, watch.sample_pages) + 1):
            pool.extend(
                self._search(
                    watch,
                    SearchQuery(
                        search_text=watch.search_text,
                        filters=watch.filters,
                        page=page,
                        per_page=DEFAULT_PER_PAGE,
                        order="relevance",
                    ),
                )
            )

        comparables = filter_comparables(pool, watch)
        if not comparables:
            notes.append(
                f"no comparable listings for '{watch.search_text}' "
                f"({len(pool)} listings fetched, all filtered out)"
            )
            return None, [], notes

        # Never mix currencies in one baseline: keep the dominant one.
        currency_counts = Counter(c.currency for c in comparables)
        currency, count = currency_counts.most_common(1)[0]
        if len(currency_counts) > 1:
            others = {c: n for c, n in currency_counts.items() if c != currency}
            notes.append(f"ignored listings in other currencies: {others}")
            comparables = [c for c in comparables if c.currency == currency]

        if len(comparables) < watch.min_sample_size:
            notes.append(
                f"only {len(comparables)} comparables in {currency} "
                f"(min_sample_size={watch.min_sample_size}) - no verdict this pass"
            )

        stats = build_stats([c.price for c in comparables], currency)
        self.store.save_stats(watch.name, stats)
        return stats, comparables, notes

    # --- one pass ---------------------------------------------------------
    def scan(self, watch: Watch, *, force_baseline: bool = False) -> WatchReport:
        report = WatchReport(watch=watch)
        requests_before = self._request_count
        stats, comparables, notes = self.build_baseline(watch, force=force_baseline)
        report.stats, report.comparables, report.notes = stats, comparables, notes

        fresh = self._search(
            watch,
            SearchQuery(
                search_text=watch.search_text,
                filters=watch.filters,
                page=1,
                per_page=DEFAULT_PER_PAGE,
                order="newest",
            ),
        )

        seen: dict[tuple[str, str], Listing] = {}
        for listing in [*comparables, *fresh]:
            seen.setdefault(listing.key(), listing)
        report.candidates = list(seen.values())

        # A price is only comparable inside one currency: the baseline keeps a
        # single currency, but the freshness page is unfiltered, so without this a
        # GBP listing could be scored against a EUR median.
        if stats is not None:
            foreign = [c for c in report.candidates if c.currency != stats.currency]
            if foreign:
                others = sorted({c.currency for c in foreign})
                report.notes.append(
                    f"ignored {len(foreign)} listing(s) priced in another currency "
                    f"({', '.join(others)})"
                )
                report.candidates = [c for c in report.candidates if c.currency == stats.currency]

        deals = find_deals(report.candidates, stats, watch)
        for deal in deals:
            self.store.note_listing(deal.listing, watch.name)
        report.deals = deals
        if not deals:
            report.notes.extend(explain_no_deals(report.candidates, stats, watch))
        report.new_deals = [d for d in deals if self.store.mark_alert(d)]
        report.requests_made = self._request_count - requests_before
        return report

    def scan_all(
        self, watches: Sequence[Watch], *, force_baseline: bool = False,
        on_report: Callable[[WatchReport], None] | None = None,
    ) -> list[WatchReport]:
        reports: list[WatchReport] = []
        for watch in watches:
            try:
                report = self.scan(watch, force_baseline=force_baseline)
            except MarketplaceBlocked:
                raise
            except MarketplaceError as exc:
                report = WatchReport(watch=watch, notes=[f"scan failed: {exc}"])
            reports.append(report)
            if on_report:
                on_report(report)
        return reports


def watch_loop(
    scanner: Scanner,
    watches: Sequence[Watch],
    *,
    interval: float,
    cycles: int | None = None,
    jitter: float = 0.2,
    on_report: Callable[[WatchReport], None] | None = None,
    on_error: Callable[[Watch, Exception], None] | None = None,
    stop: Callable[[], bool] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> list[WatchReport]:
    """Poll the market every `interval` seconds and report new bargains.

    Kept deliberately simple and sequential. A blocked marketplace is reported
    through `on_error` and skipped for the rest of the pass, then tried again on
    the next one: one hostile marketplace (leboncoin's DataDome, typically) must
    not take the other watches - or the alert dashboard - down with it. We never
    retry harder than one attempt per pass; see README "Legal & terms".
    """
    cycle = 0
    collected: list[WatchReport] = []
    while cycles is None or cycle < cycles:
        if stop and stop():
            break
        for watch in watches:
            if stop and stop():
                break
            try:
                report = scanner.scan(watch)
            except MarketplaceBlocked as exc:
                if on_error:
                    on_error(watch, exc)
                continue
            except MarketplaceError as exc:
                if on_error:
                    on_error(watch, exc)
                continue
            collected.append(report)
            if on_report:
                on_report(report)
        cycle += 1
        if cycles is not None and cycle >= cycles:
            break
        sleep(max(0.0, interval + random.uniform(0, jitter * interval)))
    return collected


def summarize(reports: Iterable[WatchReport]) -> dict[str, object]:
    reports = list(reports)
    return {
        "watches": len(reports),
        "requests": sum(r.requests_made for r in reports),
        "deals": sum(len(r.deals) for r in reports),
        "new_deals": sum(len(r.new_deals) for r in reports),
        "errors": [n for r in reports for n in r.notes if "failed" in n],
    }
