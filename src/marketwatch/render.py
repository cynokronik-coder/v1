"""Console / file output. Rich tables for humans, JSON+CSV for pipelines."""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .models import Deal, PriceStats, WatchReport

LEBONCOIN_WARNING = (
    "Leboncoin has no public API for searching listings, and its robots.txt states "
    "'it's forbidden to use search robots or other automatic methods to access "
    "Leboncoin.fr'. The endpoints used here are the ones its own browser client "
    "calls, and they sit behind DataDome, which returns HTTP 403 from "
    "cloud/datacenter IPs and when you poll too fast. Personal, low-volume use "
    "only, on your own responsibility - see the 'Legal & terms' section of README.md. "
    "The eBay watch uses eBay's official Browse API and is the terms-compliant path."
)

VINTED_WARNING = (
    "Vinted has no public API for searching other people's listings; this uses the "
    "endpoint its own web app calls. Vinted's terms forbid scraping/bots, so use it "
    "for personal, low-volume research only, on your own responsibility - see the "
    "'Legal & terms' section of README.md. The eBay watch uses eBay's official "
    "Browse API and is the terms-compliant path."
)

# Every marketplace whose endpoints are unofficial: a watch must set
# acknowledge_terms before these run.
TERMS_WARNINGS = {
    "vinted": VINTED_WARNING,
    "leboncoin": LEBONCOIN_WARNING,
}
UNOFFICIAL_MARKETPLACES = set(TERMS_WARNINGS)


def deal_to_dict(deal: Deal) -> dict:
    l = deal.listing
    return {
        "watch": deal.watch,
        "marketplace": l.marketplace,
        "item_id": l.item_id,
        "title": l.title,
        "url": l.url,
        "price": l.price,
        "currency": l.currency,
        "landed_price": l.landed_price,
        "market_price": round(deal.market_price, 2),
        "discount_pct": round(deal.discount_pct * 100, 1),
        "robust_z": round(deal.robust_z, 2),
        "condition": l.condition,
        "size": l.size,
        "brand": l.brand,
        "first_seen": deal.first_seen.isoformat(),
        "reasons": deal.reasons,
    }


def stats_to_dict(stats: PriceStats | None) -> dict | None:
    if stats is None:
        return None
    return {
        "sample_size": stats.sample_size,
        "used_size": stats.used_size,
        "currency": stats.currency,
        "market_price_median": round(stats.median, 2),
        "mean": round(stats.mean, 2),
        "q1": round(stats.q1, 2),
        "q3": round(stats.q3, 2),
        "mad": round(stats.mad, 2),
        "computed_at": stats.computed_at.isoformat(),
    }


def deals_table(deals: Sequence[Deal], *, title: str = "Deals below market price") -> Table:
    table = Table(title=title, header_style="bold", show_lines=False)
    table.add_column("#", justify="right", style="dim")
    table.add_column("watch", style="cyan", no_wrap=True)
    table.add_column("price", justify="right", style="bold green")
    table.add_column("market", justify="right")
    table.add_column("under", justify="right", style="bold")
    table.add_column("z", justify="right", style="dim")
    table.add_column("item")
    table.add_column("link", style="blue", overflow="fold")
    for i, deal in enumerate(deals, 1):
        l = deal.listing
        table.add_row(
            str(i),
            deal.watch,
            f"{l.price:.2f} {l.currency}",
            f"{deal.market_price:.2f}",
            f"{deal.discount_pct * 100:.0f}%",
            f"{deal.robust_z:.1f}",
            f"{l.title}\n[dim]{l.condition or '?'} | {l.size or '?'} | landed "
            f"{l.landed_price:.2f} {l.currency}[/dim]" if l.landed_price
            else f"{l.title}\n[dim]{l.condition or '?'} | {l.size or '?'}[/dim]",
            l.url,
        )
    return table


def comps_table(stats: PriceStats | None, comparables: Sequence, *, title: str) -> Table:
    table = Table(title=title, header_style="bold")
    table.add_column("price", justify="right")
    table.add_column("title")
    table.add_column("condition / size", style="dim")
    for listing in sorted(comparables, key=lambda l: l.price):
        table.add_row(
            f"{listing.price:.2f} {listing.currency}",
            listing.title,
            f"{listing.condition or '?'} | {listing.size or '?'}",
        )
    if stats:
        table.caption = (
            f"median {stats.median:.2f} {stats.currency} | q1 {stats.q1:.2f} | "
            f"q3 {stats.q3:.2f} | MAD {stats.mad:.2f} | "
            f"{stats.used_size}/{stats.sample_size} comparable listings after trimming"
        )
    return table


def render_report(console: Console, report: WatchReport, *, show_comps: bool = False) -> None:
    head = (
        f"[bold]{report.watch.name}[/bold] ({report.watch.marketplace}) "
        f"[dim]'{report.watch.search_text}'[/dim]"
    )
    if report.stats:
        head += (
            f"\nmarket price [bold]{report.stats.median:.2f} {report.stats.currency}[/bold] "
            f"(median of {report.stats.used_size} comparables, "
            f"q1 {report.stats.q1:.2f}, q3 {report.stats.q3:.2f})"
        )
    else:
        head += "\n[red]no baseline: not enough comparable listings[/red]"
    console.print(Panel(head, title="scan", expand=False))

    for note in report.notes:
        console.print(f"  [yellow]note:[/yellow] {note}")

    if report.new_deals:
        console.print(deals_table(report.new_deals, title="New deals"))
    elif report.deals:
        console.print(
            f"  [dim]{len(report.deals)} deal(s) still active but already reported[/dim]"
        )
    else:
        console.print("  [dim]no listing under the thresholds this pass[/dim]")

    if show_comps and report.comparables:
        console.print(comps_table(report.stats, report.comparables, title="Comparable pool"))


def print_deals(console: Console, deals: Iterable[Deal], *, title: str = "Deals") -> None:
    deals = list(deals)
    if not deals:
        console.print("[dim]no deals stored yet[/dim]")
        return
    console.print(deals_table(deals, title=title))


def write_json(path: str | Path, payload: object) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    def default(o):
        if isinstance(o, datetime):
            return o.isoformat()
        raise TypeError(f"not serializable: {type(o)}")
    p.write_text(json.dumps(payload, indent=2, default=default))
    return p


def write_deals_csv(path: str | Path, deals: Sequence[Deal]) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    rows = [deal_to_dict(d) for d in deals]
    fields = list(rows[0].keys()) if rows else [
        "watch", "marketplace", "item_id", "title", "url", "price", "currency",
        "landed_price", "market_price", "discount_pct", "robust_z", "condition",
        "size", "brand", "first_seen", "reasons",
    ]
    with p.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            row = dict(row)
            row["reasons"] = " | ".join(row.get("reasons") or [])
            writer.writerow(row)
    return p


def report_to_dict(report: WatchReport) -> dict:
    return {
        "watch": report.watch.name,
        "marketplace": report.watch.marketplace,
        "search_text": report.watch.search_text,
        "stats": stats_to_dict(report.stats),
        "deals": [deal_to_dict(d) for d in report.deals],
        "new_deals": [deal_to_dict(d) for d in report.new_deals],
        "comparables_seen": len(report.comparables),
        "candidates_scored": len(report.candidates),
        "requests_made": report.requests_made,
        "notes": report.notes,
    }
