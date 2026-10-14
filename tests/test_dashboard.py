"""The alert dashboard, exercised over real HTTP sockets (no browser needed)."""

import json
import threading
import time

import httpx
import pytest

from marketwatch.dashboard import (
    DashboardState,
    EventHub,
    is_loopback,
    report_event,
    start_dashboard,
)
from marketwatch.models import PriceStats, Watch, WatchReport
from marketwatch.store import Store
from tests.test_notify import make_deal


def report_for(watch: str = "iphone-13-128", *, new: int = 1) -> WatchReport:
    stats = PriceStats(currency="EUR", median=300.0, mean=310.0, q1=200.0, q3=400.0,
                       mad=90.0, sample_size=20, used_size=18)
    return WatchReport(
        watch=Watch(name=watch, search_text="iphone 13", marketplace="vinted"),
        stats=stats,
        deals=[make_deal()] * new,
        new_deals=[make_deal()] * new,
        requests_made=4,
    )


@pytest.fixture
def dashboard(tmp_path):
    db = str(tmp_path / "t.sqlite3")
    state = DashboardState(["iphone-13-128"], interval=60.0)
    hub = EventHub()
    server, url = start_dashboard(db_path=db, state=state, hub=hub, port=0, keepalive=0.2)
    try:
        yield {"url": url, "state": state, "hub": hub, "db": db, "server": server}
    finally:
        server.shutdown()
        server.server_close()


def test_health_and_status_endpoints(dashboard):
    base = dashboard["url"].rstrip("/")
    assert httpx.get(f"{base}/healthz", timeout=5).json() == {"status": "ok"}

    status = httpx.get(f"{base}/api/status", timeout=5).json()
    assert status["watches"] == ["iphone-13-128"]
    assert status["passes"] == 0 and status["new_deals"] == 0
    assert status["interval_seconds"] == 60.0


def test_page_is_served_with_the_notification_ui(dashboard):
    res = httpx.get(dashboard["url"], timeout=5)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    assert "Enable desktop notifications" in res.text
    assert "EventSource('/events'" in res.text          # live connection, no polling
    assert "new Notification" in res.text


def test_api_deals_reads_what_the_scanner_stored(dashboard):
    base = dashboard["url"].rstrip("/")
    with Store(dashboard["db"]) as store:              # written from this thread
        store.mark_alert(make_deal())

    body = httpx.get(f"{base}/api/deals", timeout=5).json()
    assert body["count"] == 1
    assert body["deals"][0]["title"] == "iPhone 13 128 Go"
    assert body["deals"][0]["discount_pct"] == pytest.approx(0.6)

    assert httpx.get(f"{base}/api/deals?watch=nope", timeout=5).json()["count"] == 0


def test_status_reflects_a_report_published_by_the_watcher(dashboard):
    dashboard["state"].note_report(report_for())
    status = httpx.get(f"{dashboard['url'].rstrip('/')}/api/status", timeout=5).json()
    assert status["passes"] == 1 and status["new_deals"] == 1
    assert status["passes_by_watch"]["iphone-13-128"]["market_price"] == 300.0
    assert status["passes_by_watch"]["iphone-13-128"]["comparables"] == 18


def test_errors_are_visible_on_the_dashboard(dashboard):
    dashboard["state"].note_error("iphone-13-128", RuntimeError("403 challenge"))
    status = httpx.get(f"{dashboard['url'].rstrip('/')}/api/status", timeout=5).json()
    assert "403 challenge" in status["errors"][-1]
    assert status["passes_by_watch"]["iphone-13-128"]["error"] == "403 challenge"


def test_unknown_path_is_404(dashboard):
    assert httpx.get(f"{dashboard['url'].rstrip('/')}/nope", timeout=5).status_code == 404


def test_event_stream_pushes_a_new_deal_as_it_is_found(dashboard):
    stream_url = dashboard["url"].rstrip("/") + "/events"
    timeout = httpx.Timeout(10.0, read=10.0)
    with httpx.Client(timeout=timeout) as client:
        with client.stream("GET", stream_url) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            assert dashboard["hub"].subscribers == 1        # the tab is registered

            report = report_for()
            dashboard["state"].note_report(report)
            dashboard["hub"].publish(report_event(report))

            event_type = data = None
            for line in response.iter_lines():
                if line.startswith("event: "):
                    event_type = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                    break
            assert event_type == "report"
            assert data["watch"] == "iphone-13-128"
            assert data["market_price"] == 300.0
            assert data["new_deals"][0]["url"] == "https://www.vinted.fr/items/42"
    deadline = time.time() + 5.0                            # noticed on the next heartbeat
    while dashboard["hub"].subscribers and time.time() < deadline:
        time.sleep(0.05)
    assert dashboard["hub"].subscribers == 0


def test_hub_never_blocks_the_watcher_when_a_client_is_slow():
    hub = EventHub()
    q = hub.subscribe()
    for i in range(200):
        hub.publish({"type": "report", "n": i})   # far more than the queue holds
    assert q.qsize() <= 64                        # oldest events are dropped


def test_token_is_required_only_off_loopback(tmp_path):
    db = str(tmp_path / "t.sqlite3")
    state, hub = DashboardState(["w"]), EventHub()
    server, url = start_dashboard(db_path=db, state=state, hub=hub, port=0, token="s3cret")
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        assert httpx.get(f"{base}/api/deals", timeout=5).status_code == 401
        assert httpx.get(f"{base}/api/deals?token=wrong", timeout=5).status_code == 401
        ok = httpx.get(f"{base}/api/deals?token=s3cret", timeout=5)
        assert ok.status_code == 200
        assert httpx.get(f"{base}/api/deals", timeout=5,
                         headers={"X-Marketwatch-Token": "s3cret"}).status_code == 200
        assert httpx.get(f"{base}/api/status", timeout=5,
                         cookies={"mw_token": "s3cret"}).status_code == 200
        assert "token=s3cret" in url
    finally:
        server.shutdown()
        server.server_close()


def test_loopback_detection():
    assert is_loopback("127.0.0.1") and is_loopback("localhost") and is_loopback("::1")
    assert not is_loopback("0.0.0.0") and not is_loopback("192.168.1.10")


def test_watcher_and_dashboard_can_write_and_read_at_the_same_time(tmp_path):
    """The dashboard opens its own SQLite connection per request, on its own thread."""
    db = str(tmp_path / "t.sqlite3")
    state, hub = DashboardState(["w"]), EventHub()
    server, url = start_dashboard(db_path=db, state=state, hub=hub, port=0)
    stop = threading.Event()

    def writer() -> None:
        with Store(db) as store:                  # a different thread, different connection
            while not stop.is_set():
                store.mark_alert(make_deal(price=100.0 + time.time() % 5))
                time.sleep(0.02)

    thread = threading.Thread(target=writer)
    thread.start()
    try:
        base = url.rstrip("/")
        for _ in range(10):
            assert httpx.get(f"{base}/api/deals", timeout=5).status_code == 200
    finally:
        stop.set()
        thread.join(timeout=5)
        server.shutdown()
        server.server_close()
