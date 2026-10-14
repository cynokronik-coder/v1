"""marketwatch command line interface."""

from __future__ import annotations

import os
import secrets
import sys
import threading
import webbrowser
from dataclasses import dataclass
from pathlib import Path

import typer
from rich.console import Console

from .adapters.base import MarketplaceBlocked, MarketplaceError
from .config import ConfigError, load_watches, select_watches
from .dashboard import DashboardState, EventHub, is_loopback, report_event, start_dashboard
from .models import SearchQuery, Watch
from .notify import build_bus
from .pipeline import Scanner, summarize, watch_loop
from .render import (
    TERMS_WARNINGS,
    comps_table,
    print_deals,
    render_report,
    report_to_dict,
    write_deals_csv,
    write_json,
)
from .store import Store

app = typer.Typer(add_completion=False, no_args_is_help=True,
                  help="Find marketplace listings priced below the market price.")
console = Console()
err_console = Console(stderr=True)


@dataclass
class Settings:
    config: Path | None
    db: str
    vinted_delay: float
    vinted_jitter: float
    lbc_transport: str
    quiet: bool


def load_dotenv(path: Path = Path(".env")) -> None:
    """Minimal .env loader (no extra dependency). Existing env wins."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@app.callback()
def main(
    ctx: typer.Context,
    config: Path = typer.Option(None, "--config", "-c", help="Path to watches YAML."),
    db: str = typer.Option(None, "--db", help="SQLite file (default marketwatch.sqlite3)."),
    vinted_delay: float = typer.Option(6.0, "--vinted-delay",
                                       help="Minimum seconds between requests to "
                                            "unofficial marketplaces (vinted, leboncoin)."),
    vinted_jitter: float = typer.Option(3.0, "--vinted-jitter",
                                        help="Random extra delay, in seconds."),
    lbc_transport: str = typer.Option("auto", "--lbc-transport",
                                      help="Leboncoin transport: auto | api | page."),
    quiet: bool = typer.Option(False, "--quiet", "-q", help="Only print deals."),
) -> None:
    load_dotenv()
    ctx.obj = Settings(
        config=config,
        db=db or os.environ.get("MARKETWATCH_DB", "marketwatch.sqlite3"),
        vinted_delay=vinted_delay,
        vinted_jitter=vinted_jitter,
        lbc_transport=lbc_transport,
        quiet=quiet,
    )


def _watches(settings: Settings, names: list[str] | None) -> list[Watch]:
    try:
        return select_watches(load_watches(settings.config), names)
    except ConfigError as exc:
        err_console.print(f"[red]config error:[/red] {exc}")
        raise typer.Exit(code=2)


def _warn_if_unofficial(watches: list[Watch]) -> None:
    """Warn about each unofficial marketplace the user has not acknowledged yet."""
    unacknowledged: dict[str, list[str]] = {}
    for watch in watches:
        if watch.marketplace in TERMS_WARNINGS and not watch.acknowledge_terms:
            unacknowledged.setdefault(watch.marketplace, []).append(watch.name)
    for marketplace, names in unacknowledged.items():
        console.print(f"[yellow]note:[/yellow] {TERMS_WARNINGS[marketplace]}\n")
        console.print(
            f"[dim]set `acknowledge_terms: true` on {', '.join(names)} "
            "to hide this notice[/dim]\n"
        )


def _scanner(settings: Settings, store: Store) -> Scanner:
    return Scanner(
        store,
        vinted_min_interval=settings.vinted_delay,
        vinted_jitter=settings.vinted_jitter,
        lbc_transport=settings.lbc_transport,
    )


@app.command()
def watches(
    ctx: typer.Context,
    watch: list[str] = typer.Option(None, "--watch", "-w", help="Filter by watch name."),
) -> None:
    """List the configured watches."""
    from rich.table import Table

    settings: Settings = ctx.obj
    items = _watches(settings, watch or None)
    table = Table(title="configured watches", header_style="bold")
    for col in ("name", "marketplace", "search", "market price band", "deal rule"):
        table.add_column(col, overflow="fold")
    for w in items:
        table.add_row(
            w.name, w.marketplace, w.search_text,
            f"{w.plausible_min_price:.0f}-{w.plausible_max_price:.0f}",
            f">= {w.min_discount * 100:.0f}% under"
            + (f" & z <= {w.max_robust_z}" if w.max_robust_z is not None else " (z-gate off)"),
        )
    console.print(table)


@app.command()
def comps(
    ctx: typer.Context,
    watch: list[str] = typer.Option(None, "--watch", "-w", help="Watch name (required)."),
    refresh: bool = typer.Option(False, "--refresh", help="Ignore the cached baseline."),
) -> None:
    """Show the comparable pool behind one watch's market price."""
    settings: Settings = ctx.obj
    items = _watches(settings, watch or None)
    if len(items) != 1:
        err_console.print("[red]pass exactly one --watch[/red]")
        raise typer.Exit(code=2)
    target = items[0]
    with Store(settings.db) as store:
        scanner = _scanner(settings, store)
        try:
            stats, comparables, notes = scanner.build_baseline(target, force=refresh)
        except MarketplaceError as exc:
            err_console.print(f"[red]marketplace error:[/red] {exc}")
            raise typer.Exit(code=1)
        finally:
            scanner.close()
    for note in notes:
        console.print(f"  [yellow]note:[/yellow] {note}")
    console.print(comps_table(stats, comparables, title=f"comparables for '{target.search_text}'"))


@app.command()
def scan(
    ctx: typer.Context,
    watch: list[str] = typer.Option(None, "--watch", "-w", help="Watch name(s) to scan."),
    refresh: bool = typer.Option(False, "--refresh", help="Rebuild the baseline, ignore cache."),
    show_comps: bool = typer.Option(False, "--show-comps", help="Print the comparable pool."),
    json_out: Path = typer.Option(None, "--json", help="Write machine-readable results here."),
    csv_out: Path = typer.Option(None, "--csv", help="Write deals as CSV here."),
    webhook: str = typer.Option(None, "--webhook",
                                help="POST new deals to this URL (ntfy/Discord/Slack/your site)."),
    webhook_style: str = typer.Option("json", "--webhook-style",
                                      help="json (Slack, Discord, generic) or text (ntfy.sh)."),
) -> None:
    """One scan pass; exits non-zero when deals are found (cron/CI friendly)."""
    settings: Settings = ctx.obj
    items = _watches(settings, watch or None)
    _warn_if_unofficial(items)
    with Store(settings.db) as store:
        scanner = _scanner(settings, store)
        try:
            reports = scanner.scan_all(items, force_baseline=refresh)
        except MarketplaceBlocked as exc:
            err_console.print(f"[red]blocked:[/red] {exc}")
            raise typer.Exit(code=3)
        finally:
            scanner.close()

    if not settings.quiet:
        for report in reports:
            render_report(console, report, show_comps=show_comps)

    deals = [d for r in reports for d in r.deals]
    new_deals = [d for r in reports for d in r.new_deals]
    _deliver_alerts(webhook, webhook_style, new_deals)
    if json_out:
        path = write_json(json_out, {
            "summary": summarize(reports),
            "reports": [report_to_dict(r) for r in reports],
        })
        console.print(f"[green]wrote[/green] {path}")
    if csv_out:
        path = write_deals_csv(csv_out, deals)
        console.print(f"[green]wrote[/green] {path} ({len(deals)} deals)")

    if settings.quiet:
        print_deals(console, new_deals or deals, title="Deals")
    raise typer.Exit(code=0 if not deals else 1)


@app.command()
def watch(
    ctx: typer.Context,
    watch: list[str] = typer.Option(None, "--watch", "-w", help="Watch name(s) to poll."),
    interval: float = typer.Option(300.0, "--interval", "-i", help="Seconds between passes."),
    cycles: int = typer.Option(None, "--cycles", help="Stop after N passes (default: forever)."),
    refresh: bool = typer.Option(False, "--refresh", help="Rebuild baselines on the first pass."),
    json_out: Path = typer.Option(None, "--json", help="Append every pass's results here."),
    webhook: str = typer.Option(None, "--webhook",
                                help="POST new deals to this URL (ntfy/Discord/Slack/your site)."),
    webhook_style: str = typer.Option("json", "--webhook-style",
                                      help="json (Slack, Discord, generic) or text (ntfy.sh)."),
) -> None:
    """Poll continuously and print only newly found bargains."""
    settings: Settings = ctx.obj
    items = _watches(settings, watch or None)
    _warn_if_unofficial(items)
    console.print(
        f"[bold]watching[/bold] {', '.join(w.name for w in items)} every {interval:.0f}s "
        f"(Ctrl-C to stop)"
    )
    collected: list[dict] = []
    with Store(settings.db) as store:
        scanner = _scanner(settings, store)

        def on_report(report) -> None:
            if report.new_deals:
                print_deals(console, report.new_deals, title=f"new deals - {report.watch.name}")
                for deal in report.new_deals:
                    console.print(f"   [blue]{deal.listing.url}[/blue]")
                _deliver_alerts(webhook, webhook_style, report.new_deals)
            elif not settings.quiet:
                stats = report.stats
                console.print(
                    f"[dim]{report.watch.name}: nothing new"
                    + (f" (market {stats.median:.2f} {stats.currency})" if stats else "")
                    + "[/dim]"
                )
            if json_out:
                collected.append(report_to_dict(report))
                write_json(json_out, collected)

        def on_error(target, exc: Exception) -> None:
            err_console.print(f"[red]{target.name}: {exc}[/red]")

        try:
            watch_loop(
                scanner,
                items,
                interval=interval,
                cycles=cycles,
                on_report=on_report,
                on_error=on_error,
            )
        except KeyboardInterrupt:
            console.print("\n[dim]stopped[/dim]")
        finally:
            scanner.close()


@app.command()
def deals(
    ctx: typer.Context,
    limit: int = typer.Option(50, "--limit", "-n", help="How many stored deals to show."),
    watch: list[str] = typer.Option(None, "--watch", "-w", help="Filter by watch name."),
    json_out: Path = typer.Option(None, "--json", help="Write stored deals here."),
    csv_out: Path = typer.Option(None, "--csv", help="Write stored deals as CSV here."),
) -> None:
    """Show bargains found earlier (from the local database)."""
    settings: Settings = ctx.obj
    names = [w for w in (watch or [])]
    with Store(settings.db) as store:
        stored = []
        for name in names or [None]:
            stored.extend(store.recent_alerts(limit=limit, watch=name))
        stored.sort(key=lambda d: d.first_seen, reverse=True)
        stored = stored[:limit]
    print_deals(console, stored, title="Stored deals")
    if json_out:
        console.print(f"[green]wrote[/green] {write_json(json_out, [d.model_dump(mode='json') for d in stored])}")
    if csv_out:
        console.print(f"[green]wrote[/green] {write_deals_csv(csv_out, stored)}")


@app.command()
def doctor(ctx: typer.Context) -> None:
    """Check config, credentials and marketplace reachability."""
    settings: Settings = ctx.obj
    ok = True
    try:
        items = load_watches(settings.config)
        console.print(f"[green]ok[/green] config: {len(items)} watch(es)")
    except ConfigError as exc:
        console.print(f"[red]fail[/red] config: {exc}")
        raise typer.Exit(code=2)

    markets = {w.marketplace for w in items}
    if "ebay" in markets:
        if os.environ.get("EBAY_CLIENT_ID") and os.environ.get("EBAY_CLIENT_SECRET"):
            console.print("[green]ok[/green] eBay credentials present")
        else:
            ok = False
            console.print(
                "[red]fail[/red] eBay watch configured but EBAY_CLIENT_ID / "
                "EBAY_CLIENT_SECRET are not set (.env or environment)"
            )

    if "leboncoin" in markets:
        console.print(
            "[dim]note: leboncoin is DataDome-protected and routinely answers 403 "
            "from cloud/datacenter IPs. Run it from a home connection; if it is still "
            "blocked, raise --vinted-delay and read README 'Legal & terms'.[/dim]"
        )

    with Store(settings.db) as store:
        scanner = _scanner(settings, store)
        try:
            for w in items:
                try:
                    results = scanner.search_preview(w, per_page=5)
                    console.print(f"[green]ok[/green] {w.name}: {len(results)} listings from {w.marketplace}")
                except MarketplaceError as exc:
                    ok = False
                    console.print(f"[red]fail[/red] {w.name}: {exc}")
        finally:
            scanner.close()
    raise typer.Exit(code=0 if ok else 1)



def _deliver_alerts(webhook: str | None, style: str, deals: list) -> None:
    """POST `deals` to the configured webhook. A dead channel never stops a scan."""
    bus = build_bus(
        webhook or os.environ.get("MARKETWATCH_WEBHOOK_URL"),
        style=style or os.environ.get("MARKETWATCH_WEBHOOK_STYLE") or "json",
    )
    try:
        if not bus or not deals:
            return
        for failure in bus.notify(deals):
            err_console.print(f"[yellow]alert channel failed:[/yellow] {failure}")
    finally:
        bus.close()


@app.command()
def serve(
    ctx: typer.Context,
    watch: list[str] = typer.Option(None, "--watch", "-w", help="Watch name(s) to poll."),
    interval: float = typer.Option(300.0, "--interval", "-i", help="Seconds between passes."),
    host: str = typer.Option("127.0.0.1", "--host",
                             help="Bind address. Anything but loopback requires --token."),
    port: int = typer.Option(8787, "--port", help="Dashboard port."),
    token: str = typer.Option(None, "--token", help="Shared secret for the dashboard URL."),
    show: bool = typer.Option(False, "--open", help="Open the dashboard in your browser."),
    cycles: int = typer.Option(None, "--cycles", help="Stop after N passes (default: forever)."),
    webhook: str = typer.Option(None, "--webhook",
                                help="Also POST alerts to this URL (ntfy/Discord/Slack)."),
    webhook_style: str = typer.Option("json", "--webhook-style",
                                      help="json (Slack, Discord, generic) or text (ntfy.sh)."),
) -> None:
    """Run the watcher and serve a live dashboard of new bargains.

    This is the alerting path: open the printed URL and click "Enable desktop
    notifications" once. The page keeps a live connection to this process, so a
    bargain appears (and notifies) the second a scan finds it - with no polling
    in the browser and no account anywhere.
    """
    settings: Settings = ctx.obj
    items = _watches(settings, watch or None)
    _warn_if_unofficial(items)

    if not is_loopback(host) and not token:
        token = secrets.token_urlsafe(16)
        err_console.print(
            "[yellow]note:[/yellow] binding beyond loopback; a dashboard token was "
            "generated (it is in the URL below)."
        )

    state = DashboardState([w.name for w in items], interval=interval)
    hub = EventHub()
    server, url = start_dashboard(
        db_path=settings.db, state=state, hub=hub, host=host, port=port, token=token
    )
    console.print(f"[bold]dashboard[/bold] {url}")

    bus = build_bus(
        webhook or os.environ.get("MARKETWATCH_WEBHOOK_URL"),
        style=webhook_style or os.environ.get("MARKETWATCH_WEBHOOK_STYLE") or "json",
    )
    if bus:
        console.print(f"[dim]alerts also POSTed to: {', '.join(bus.names)}[/dim]")
    if show and is_loopback(host):
        webbrowser.open(url)

    stop = threading.Event()

    def worker() -> None:
        # The Store and the adapters are opened *in this thread* on purpose: SQLite
        # connections and httpx clients are not meant to cross threads.
        with Store(settings.db) as store:
            scanner = _scanner(settings, store)

            def on_report(report) -> None:
                state.note_report(report)
                hub.publish(report_event(report))
                if report.new_deals:
                    print_deals(console, report.new_deals,
                                title=f"new deals - {report.watch.name}")
                    for deal in report.new_deals:
                        console.print(f"   [blue]{deal.listing.url}[/blue]")
                    for failure in bus.notify(report.new_deals):
                        err_console.print(f"[yellow]alert channel failed:[/yellow] {failure}")
                elif not settings.quiet:
                    stats = report.stats
                    console.print(
                        f"[dim]{report.watch.name}: nothing new"
                        + (f" (market {stats.median:.2f} {stats.currency})" if stats else "")
                        + "[/dim]"
                    )

            def on_error(target, exc: Exception) -> None:
                state.note_error(target.name, exc)
                err_console.print(f"[red]{target.name}: {exc}[/red]")

            try:
                watch_loop(
                    scanner, items, interval=interval, cycles=cycles,
                    on_report=on_report, on_error=on_error, stop=stop.is_set,
                )
            except MarketplaceBlocked as exc:
                state.note_error("scanner", exc)
                err_console.print(f"[red]blocked:[/red] {exc}")
            except Exception as exc:  # keep the dashboard up so it can explain
                state.note_error("scanner", exc)
                err_console.print(f"[red]scan loop stopped:[/red] {exc}")
            finally:
                scanner.close()
                bus.close()

    thread = threading.Thread(target=worker, name="marketwatch-watch", daemon=True)
    thread.start()
    console.print(
        f"[dim]watching {', '.join(w.name for w in items)} every {interval:.0f}s "
        "- Ctrl-C to stop[/dim]"
    )
    try:
        while thread.is_alive():
            thread.join(timeout=0.5)
    except KeyboardInterrupt:
        stop.set()
        thread.join(timeout=5.0)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":  # pragma: no cover
    app()
