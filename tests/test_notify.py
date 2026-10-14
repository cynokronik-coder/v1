"""Alert delivery: summaries, webhook styles, and failure isolation."""

import json
from datetime import datetime, timezone

import httpx
import pytest

from marketwatch.models import Deal, Listing
from marketwatch.notify import (
    ConsoleNotifier,
    NotifierBus,
    NotifierError,
    WebhookNotifier,
    build_bus,
    deal_payload,
    deal_summary,
)


def make_deal(price: float = 120.0, market: float = 300.0, *, watch: str = "iphone-13-128") -> Deal:
    listing = Listing(
        marketplace="vinted", item_id="42", title="iPhone 13 128 Go",
        url="https://www.vinted.fr/items/42", price=price, currency="EUR",
        condition="Très bon état", size="128 Go", brand="Apple",
    )
    return Deal(
        watch=watch, listing=listing, market_price=market,
        discount_pct=1 - price / market, robust_z=-2.0,
        first_seen=datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
    )


def webhook(handler, **kw) -> WebhookNotifier:
    client = httpx.Client(transport=httpx.MockTransport(handler), timeout=5)
    return WebhookNotifier("https://hooks.example/mw", client=client, **kw)


def test_summary_is_actionable_and_short():
    text = deal_summary(make_deal())
    assert "iPhone 13 128 Go" in text
    assert "120.00 EUR" in text and "60% under" in text and "300.00 EUR" in text
    assert "https://www.vinted.fr/items/42" in text
    long_title = make_deal().listing.model_copy(update={"title": "x" * 200})
    assert len(deal_summary(Deal(watch="w", listing=long_title, market_price=1, discount_pct=0.5, robust_z=0)).splitlines()[0]) < 130


def test_payload_carries_the_machine_readable_fields():
    payload = deal_payload(make_deal())
    assert payload["item_id"] == "42"
    assert payload["discount_pct"] == pytest.approx(0.6)
    assert payload["marketplace"] == "vinted"
    assert payload["first_seen"] == "2026-01-02T03:04:05+00:00"
    assert payload["brand"] == "Apple"


def test_json_webhook_speaks_slack_and_discord():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["ctype"] = request.headers.get("content-type")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    webhook(handler).send([make_deal()])
    assert seen["url"] == "https://hooks.example/mw"
    assert seen["ctype"] == "application/json"
    assert "iPhone 13" in seen["body"]["text"]      # Slack reads `text`
    assert seen["body"]["content"] == seen["body"]["text"]  # Discord reads `content`
    assert seen["body"]["deals"][0]["price"] == 120.0


def test_text_webhook_is_ntfy_shaped():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.content.decode()
        seen["headers"] = {k.lower(): v for k, v in request.headers.items()}
        return httpx.Response(200)

    webhook(handler, style="text").send([make_deal()])
    assert "iPhone 13" in seen["body"]
    assert seen["headers"]["title"] == "marketwatch"
    assert seen["headers"]["tags"] == "moneybag"
    assert seen["headers"]["click"] == "https://www.vinted.fr/items/42"
    assert "application/json" != seen["headers"].get("content-type")


def test_custom_headers_are_never_duplicated_case_insensitively():
    def handler(request: httpx.Request) -> httpx.Response:
        assert [k.lower() for k in request.headers.keys()].count("title") == 1
        return httpx.Response(200)

    webhook(handler, style="text", headers={"title": "my topic"}).send([make_deal()])


def test_http_error_from_the_webhook_is_a_notifier_error():
    notifier = webhook(lambda r: httpx.Response(500, text="boom"))
    with pytest.raises(NotifierError, match="HTTP 500"):
        notifier.send([make_deal()])


def test_network_failure_is_a_notifier_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with pytest.raises(NotifierError, match="webhook POST failed"):
        webhook(handler).send([make_deal()])


def test_rejects_a_non_http_url():
    with pytest.raises(NotifierError):
        WebhookNotifier("ftp://nope")


def test_nothing_is_sent_when_there_is_nothing_to_send():
    calls = []
    notifier = webhook(lambda r: calls.append(r) or httpx.Response(200))
    notifier.send([])
    assert calls == []


def test_bus_isolates_failures_and_reports_them():
    sent: list[str] = []

    class Good:
        name = "good"

        def send(self, deals):
            sent.append("good")

    class Bad:
        name = "bad"

        def send(self, deals):
            raise NotifierError("channel is down")

    bus = NotifierBus([Bad(), Good()])
    failures = bus.notify([make_deal()])

    assert sent == ["good"]                       # the healthy channel still fired
    assert failures == ["bad: channel is down"]
    assert bus.errors == failures
    assert bus.names == ["bad", "good"]
    assert len(bus) == 2 and bool(bus)


def test_console_notifier_uses_the_injected_printer():
    lines: list[str] = []
    ConsoleNotifier(lines.append).send([make_deal()])
    assert len(lines) == 1 and "iPhone 13" in lines[0]


def test_build_bus_is_empty_without_a_url():
    assert not build_bus(None)
    assert len(build_bus("https://hooks.example/x")) == 1
