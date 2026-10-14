"""The local alert dashboard.

`marketwatch serve` runs the watch loop and this dashboard side by side. It is a
single stdlib HTTP server - no build step, no npm, no framework - serving one HTML
page plus three JSON/stream endpoints:

    GET /            the page (deals table + live updates + desktop notifications)
    GET /events      Server-Sent Events: one message per new deal, as it is found
    GET /api/deals   the stored deals, so opening the page shows history
    GET /api/status  watch list, last pass per watch, request counts
    GET /healthz     "ok"

Why a web page rather than a browser extension: it needs no install, no store
review, and no build; the same page gives you desktop notifications through the
standard Notification API, and it works on a phone on the same Wi-Fi. See README
"Deal alerts" for the push-to-phone alternative (a webhook, e.g. ntfy).

Security: binds to 127.0.0.1 by default. Binding anywhere else requires a token,
because anything on the network could otherwise read your deals.
"""

from __future__ import annotations

import hmac
import json
import queue
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .models import WatchReport
from .notify import deal_payload
from .store import Store

KEEPALIVE_SECONDS = 15.0
MAX_QUEUE = 64
LOOPBACK = {"127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"}


def is_loopback(host: str) -> bool:
    return (host or "").strip().lower() in LOOPBACK


class EventHub:
    """Fan a scan result out to every connected browser, without blocking it."""

    def __init__(self) -> None:
        self._subscribers: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    @property
    def subscribers(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(event)
            except queue.Full:
                # A browser that cannot keep up loses old events, never the loop.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (queue.Empty, queue.Full):  # pragma: no cover - race
                    pass


class DashboardState:
    """What the page shows about the watcher itself."""

    def __init__(self, watches: list[str], *, interval: float = 0.0) -> None:
        self.watches = list(watches)
        self.interval = interval
        self.started_at = datetime.now(timezone.utc)
        self._lock = threading.Lock()
        self._passes: dict[str, dict[str, Any]] = {}
        self.passes = 0
        self.new_deals = 0
        self.errors: list[str] = []

    def note_report(self, report: WatchReport) -> None:
        with self._lock:
            stats = report.stats
            self._passes[report.watch.name] = {
                "at": datetime.now(timezone.utc).isoformat(),
                "market_price": stats.median if stats else None,
                "currency": stats.currency if stats else None,
                "comparables": stats.used_size if stats else 0,
                "deals": len(report.deals),
                "new_deals": len(report.new_deals),
                "requests": report.requests_made,
                "notes": report.notes[:3],
            }
            self.passes += 1
            self.new_deals += len(report.new_deals)

    def note_error(self, watch: str, exc: Exception) -> None:
        with self._lock:
            self.errors.append(f"{watch}: {exc}")
            self.errors = self.errors[-10:]
            self._passes[watch] = {
                "at": datetime.now(timezone.utc).isoformat(),
                "error": str(exc),
                "deals": 0,
                "new_deals": 0,
                "requests": 0,
                "notes": [],
            }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "watches": self.watches,
                "interval_seconds": self.interval,
                "started_at": self.started_at.isoformat(),
                "passes": self.passes,
                "new_deals": self.new_deals,
                "errors": list(self.errors),
                "passes_by_watch": dict(self._passes),
            }


def report_event(report: WatchReport) -> dict[str, Any]:
    """The SSE payload for one scan pass."""
    stats = report.stats
    return {
        "type": "report",
        "watch": report.watch.name,
        "market_price": stats.median if stats else None,
        "currency": stats.currency if stats else None,
        "comparables": stats.used_size if stats else 0,
        "deals": len(report.deals),
        "new_deals": [deal_payload(d) for d in report.new_deals],
        "notes": report.notes[:3],
        "at": datetime.now(timezone.utc).isoformat(),
    }


def make_handler(
    *,
    state: DashboardState,
    hub: EventHub,
    db_path: str,
    token: str | None = None,
    keepalive: float = KEEPALIVE_SECONDS,
) -> type[BaseHTTPRequestHandler]:
    """Build the request handler with its dependencies bound in."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "marketwatch"
        protocol_version = "HTTP/1.1"

        # --- plumbing -----------------------------------------------------
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            pass  # a price watcher's stdout is for deals, not access logs

        def _json(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if not token:
                return True
            supplied = (
                self.headers.get("X-Marketwatch-Token")
                or (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
                or self._cookie_token()
            )
            return bool(supplied) and hmac.compare_digest(supplied, token)

        def _cookie_token(self) -> str:
            for chunk in (self.headers.get("Cookie") or "").split(";"):
                name, _, value = chunk.strip().partition("=")
                if name == "mw_token":
                    return value
            return ""

        def _guard(self) -> bool:
            if self._authorized():
                return True
            self._json({"error": "unauthorized: pass ?token=..."}, status=401)
            return False

        # --- routes -------------------------------------------------------
        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/healthz":
                self._json({"status": "ok"})
                return
            if not self._guard():
                return
            if path == "/":
                self._page()
            elif path == "/events":
                self._stream()
            elif path == "/api/deals":
                self._deals()
            elif path == "/api/status":
                self._json(state.snapshot())
            else:
                self._json({"error": "not found"}, status=404)

        def _deals(self) -> None:
            query = parse_qs(urlparse(self.path).query)
            limit = min(int((query.get("limit") or ["50"])[0] or 50), 500)
            watch = (query.get("watch") or [None])[0]
            with Store(db_path) as store:  # a connection per request: SQLite threads
                deals = store.recent_alerts(limit=limit, watch=watch)
            self._json({"count": len(deals), "deals": [deal_payload(d) for d in deals]})

        def _page(self) -> None:
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if token:
                # Remember the token so /events and fetch() keep working after reload.
                self.send_header("Set-Cookie", f"mw_token={token}; Path=/; SameSite=Strict")
            self.end_headers()
            self.wfile.write(body)

        def _stream(self) -> None:
            q = hub.subscribe()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        event = q.get(timeout=keepalive)
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue
                    payload = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"event: {event.get('type', 'message')}\n".encode())
                    self.wfile.write(f"data: {payload}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # the tab was closed; not an error
            finally:
                hub.unsubscribe(q)

    return Handler


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_dashboard(
    *,
    db_path: str,
    state: DashboardState,
    hub: EventHub,
    host: str = "127.0.0.1",
    port: int = 8787,
    token: str | None = None,
    keepalive: float = KEEPALIVE_SECONDS,
) -> tuple[DashboardServer, str]:
    """Bind, serve in a background thread, and return (server, url).

    `keepalive` is the SSE idle heartbeat; a closed tab is only noticed when the
    next write fails, so it also bounds how long a disconnected client keeps its
    queue alive.
    """
    handler = make_handler(
        state=state, hub=hub, db_path=db_path, token=token, keepalive=keepalive
    )
    server = DashboardServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, name="marketwatch-dashboard", daemon=True)
    thread.start()
    shown = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{shown}:{server.server_port}/"
    if token:
        url += f"?token={token}"
    return server, url


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>marketwatch - deals</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: #10141a; color: #e6edf3; }
  header { position: sticky; top: 0; background: #151b24; border-bottom: 1px solid #232c38;
           padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; letter-spacing: .02em; }
  h1 span { color: #7d8b9c; font-weight: 400; }
  button { background: #1f6feb; color: #fff; border: 0; border-radius: 6px; padding: 7px 12px;
           font-size: 13px; cursor: pointer; }
  button.ghost { background: #232c38; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #7d8b9c; font-size: 12px; margin-left: auto; }
  #dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950;
         margin-right: 6px; vertical-align: middle; }
  #dot.off { background: #f85149; }
  main { padding: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #1d2530; vertical-align: top; }
  th { color: #7d8b9c; font-weight: 600; font-size: 12px; text-transform: uppercase;
       letter-spacing: .04em; }
  tr.fresh { animation: flash 2.2s ease-out; }
  @keyframes flash { from { background: #1d3a24; } to { background: transparent; } }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .price { font-weight: 600; }
  .off { color: #3fb950; font-weight: 600; }
  .meta { color: #7d8b9c; font-size: 12px; }
  .empty { color: #7d8b9c; padding: 24px 4px; }
  .pill { background: #1d2530; border-radius: 999px; padding: 2px 8px; font-size: 11px; color: #9da9b8; }
</style>
</head>
<body>
<header>
  <h1>marketwatch <span>deals</span></h1>
  <button id="notify">Enable desktop notifications</button>
  <button id="refresh" class="ghost">Refresh</button>
  <div id="status"><span id="dot"></span><span id="statustext">connecting...</span></div>
</header>
<main>
  <table>
    <thead><tr>
      <th>found</th><th>product</th><th>price</th><th>under market</th><th>market</th>
      <th>where</th><th></th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" hidden>No deals yet. They appear here the moment a scan finds one.</div>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const qs = token ? '?token=' + encodeURIComponent(token) : '';
const rows = document.getElementById('rows');
const empty = document.getElementById('empty');
const statusText = document.getElementById('statustext');
const dot = document.getElementById('dot');
const seen = new Set();

function money(v, c) { return v == null ? '-' : v.toFixed(2) + ' ' + (c || ''); }
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function addDeal(d, fresh) {
  if (d.item_id && seen.has(d.watch + '/' + d.item_id)) return;
  if (d.item_id) seen.add(d.watch + '/' + d.item_id);
  empty.hidden = true;
  const tr = document.createElement('tr');
  if (fresh) tr.className = 'fresh';
  tr.innerHTML = `
    <td class="meta">${ago(d.first_seen)}</td>
    <td>${escapeHtml(d.title)}<div class="meta">${escapeHtml(d.watch)}
        ${d.brand ? '&middot; ' + escapeHtml(d.brand) : ''}
        ${d.size ? '&middot; ' + escapeHtml(d.size) : ''}
        ${d.condition ? '&middot; ' + escapeHtml(d.condition) : ''}</div></td>
    <td class="price">${money(d.price, d.currency)}</td>
    <td class="off">${(d.discount_pct * 100).toFixed(0)}%</td>
    <td class="meta">${money(d.market_price, d.currency)}</td>
    <td><span class="pill">${escapeHtml(d.marketplace)}</span></td>
    <td><a href="${encodeURI(d.url)}" target="_blank" rel="noopener">open</a></td>`;
  rows.prepend(tr);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function load() {
  const res = await fetch('/api/deals?limit=100' + (token ? '&token=' + encodeURIComponent(token) : ''));
  if (res.status === 401) { statusText.textContent = 'unauthorized - reopen with ?token='; return; }
  const data = await res.json();
  data.deals.reverse().forEach(d => addDeal(d, false));
  const st = await (await fetch('/api/status' + qs)).json();
  renderStatus(st);
}
function renderStatus(st) {
  const names = (st.watches || []).join(', ');
  const last = Object.entries(st.passes_by_watch || {})
    .map(([w, p]) => w + ': ' + (p.error ? 'error' : money(p.market_price, p.currency))).join(' | ');
  statusText.textContent = st.passes + ' pass(es) - ' + st.new_deals + ' alerts'
    + (names ? ' - watching ' + names : '') + (last ? ' - ' + last : '');
}
document.getElementById('refresh').onclick = () => location.reload();
document.getElementById('notify').onclick = async () => {
  if (!('Notification' in window)) { alert('This browser has no Notification API.'); return; }
  const p = await Notification.requestPermission();
  document.getElementById('notify').disabled = true;
  document.getElementById('notify').textContent =
    p === 'granted' ? 'Desktop notifications on' : 'Notifications blocked in this browser';
};
if ('Notification' in window && Notification.permission === 'granted') {
  const b = document.getElementById('notify');
  b.disabled = true; b.textContent = 'Desktop notifications on';
}
load().catch(e => { statusText.textContent = 'load failed: ' + e; });
const es = new EventSource('/events' + qs);
es.onopen = () => { dot.classList.remove('off'); };
es.onerror = () => { dot.classList.add('off'); statusText.textContent = 'reconnecting...'; };
es.addEventListener('report', ev => {
  dot.classList.remove('off');
  const r = JSON.parse(ev.data);
  r.new_deals.forEach(d => {
    addDeal(d, true);
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(d.title, {
        body: (d.price.toFixed(2) + ' ' + d.currency + ', ' + (d.discount_pct * 100).toFixed(0)
              + '% under ' + d.market_price.toFixed(2) + ' ' + d.currency + ' - ' + d.watch),
        tag: d.watch + '/' + d.item_id,
      });
      n.onclick = () => { window.open(d.url, '_blank'); n.close(); };
    }
  });
  fetch('/api/status' + qs).then(r => r.json()).then(renderStatus).catch(() => {});
  document.title = r.new_deals.length
    ? '(' + r.new_deals.length + ') marketwatch - deals' : 'marketwatch - deals';
});
</script>
</body>
</html>
"""
