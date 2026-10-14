"""Deal alerting.

A `Deal` becomes an alert once (the store dedupes), and this module fans it out to
one or more destinations:

* `console` - the terminal you are already watching
* `webhook` - one plain HTTP POST, so it works with ntfy, Discord, Slack,
              Zapier/Make or your own endpoint, with no SDK and no account
* the local dashboard in `marketwatch.dashboard`, which needs no configuration
  at all and is the default when you run `marketwatch serve`

Design rule: alerting never breaks scanning. A notifier failure is returned as a
string for the caller to display, never raised into the scan loop.
"""

from __future__ import annotations

from typing import Any, Iterable, Protocol, Sequence, runtime_checkable

import httpx

from .models import Deal

DEFAULT_TITLE = "marketwatch"


class NotifierError(RuntimeError):
    """A notifier could not deliver (its own problem, not the scan's)."""


def deal_summary(deal: Deal) -> str:
    """One line a human can act on from a lock screen."""
    listing = deal.listing
    title = (listing.title or "(untitled)").strip()
    if len(title) > 60:
        title = title[:57] + "..."
    return (
        f"{title} - {listing.price:.2f} {listing.currency} "
        f"({deal.discount_pct:.0%} under market "
        f"{deal.market_price:.2f} {listing.currency}) [{deal.watch}/{listing.marketplace}]\n"
        f"{listing.url}"
    )


def deal_payload(deal: Deal) -> dict[str, Any]:
    """The machine-readable form, used by the webhook, the dashboard and JSON/CSV."""
    listing = deal.listing
    return {
        "watch": deal.watch,
        "marketplace": listing.marketplace,
        "item_id": listing.item_id,
        "title": listing.title,
        "url": listing.url,
        "price": listing.price,
        "currency": listing.currency,
        "landed_price": listing.landed_price,
        "market_price": deal.market_price,
        "discount_pct": round(deal.discount_pct, 4),
        "robust_z": round(deal.robust_z, 3),
        "condition": listing.condition,
        "size": listing.size,
        "brand": listing.brand,
        "first_seen": deal.first_seen.isoformat(),
    }


@runtime_checkable
class Notifier(Protocol):
    name: str

    def send(self, deals: Sequence[Deal]) -> None: ...


class ConsoleNotifier:
    """Print alerts to stdout, so `watch` keeps behaving the way it always did."""

    name = "console"

    def __init__(self, printer: Any | None = None) -> None:
        self._printer = printer

    def send(self, deals: Sequence[Deal]) -> None:
        for deal in deals:
            if self._printer is not None:
                self._printer(deal_summary(deal))
            else:  # pragma: no cover - the CLI always passes a printer
                print(deal_summary(deal))


class WebhookNotifier:
    """POST new deals to a URL.

    ``style="json"`` (default) sends ``{"text": ..., "content": ..., "deals": [...]}``.
    Slack reads ``text``, Discord reads ``content``, and anything else can read
    ``deals``. ``style="text"`` sends the plain summary as the request body with a
    ``Title`` header, which is exactly what ntfy.sh expects
    (``MARKETWATCH_WEBHOOK_URL=https://ntfy.sh/<your-topic>`` with
    ``MARKETWATCH_WEBHOOK_STYLE=text``).
    """

    name = "webhook"

    def __init__(
        self,
        url: str,
        *,
        style: str = "json",
        timeout: float = 10.0,
        headers: dict[str, str] | None = None,
        title: str = DEFAULT_TITLE,
        client: httpx.Client | None = None,
    ) -> None:
        if not url or not url.startswith(("http://", "https://")):
            raise NotifierError(f"webhook URL must be http(s), got {url!r}")
        self.url = url
        self.style = (style or "json").lower()
        self.title = title
        self._headers = dict(headers or {})
        self._client = client or httpx.Client(timeout=timeout, follow_redirects=False)
        self._owns_client = client is None

    @staticmethod
    def _set_default(headers: dict[str, str], name: str, value: str) -> None:
        """Header names are case-insensitive, so never emit a duplicate."""
        if not any(k.lower() == name.lower() for k in headers):
            headers[name] = value

    def build_request(self, deals: Sequence[Deal]) -> tuple[dict[str, str], dict[str, Any]]:
        """The headers plus the httpx kwargs for one delivery."""
        text = "\n\n".join(deal_summary(d) for d in deals)
        headers = {"User-Agent": "marketwatch/0.1", **self._headers}
        if self.style == "text":
            # ntfy.sh style: the body is the message, headers carry presentation.
            self._set_default(headers, "Title", self.title)
            self._set_default(headers, "Tags", "moneybag")
            if len(deals) == 1:
                self._set_default(headers, "Click", deals[0].listing.url)
            return headers, {"content": text.encode("utf-8")}
        payload = {
            "title": self.title,
            "text": text,       # Slack
            "content": text,    # Discord
            "count": len(deals),
            "deals": [deal_payload(d) for d in deals],
        }
        self._set_default(headers, "Content-Type", "application/json")
        return headers, {"json": payload}

    def send(self, deals: Sequence[Deal]) -> None:
        if not deals:
            return
        headers, kwargs = self.build_request(deals)
        try:
            resp = self._client.post(self.url, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise NotifierError(f"webhook POST failed: {exc}") from exc
        if resp.status_code >= 300:
            raise NotifierError(
                f"webhook returned HTTP {resp.status_code}: {(resp.text or '')[:200]}"
            )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()


class NotifierBus:
    """Fan one alert out to every configured notifier, surviving their failures."""

    name = "bus"

    def __init__(self, notifiers: Iterable[Notifier] | None = None) -> None:
        self._notifiers: list[Notifier] = list(notifiers or [])
        self.errors: list[str] = []

    def add(self, notifier: Notifier) -> None:
        self._notifiers.append(notifier)

    def __bool__(self) -> bool:
        return bool(self._notifiers)

    def __len__(self) -> int:
        return len(self._notifiers)

    @property
    def names(self) -> list[str]:
        return [getattr(n, "name", type(n).__name__) for n in self._notifiers]

    def notify(self, deals: Sequence[Deal]) -> list[str]:
        """Deliver `deals`; returns human-readable failures, never raises."""
        deals = list(deals)
        if not deals:
            return []
        failures: list[str] = []
        for notifier in self._notifiers:
            try:
                notifier.send(deals)
            except Exception as exc:  # a broken channel must not hide the others
                failures.append(f"{getattr(notifier, 'name', 'notifier')}: {exc}")
        self.errors.extend(failures)
        return failures

    def close(self) -> None:
        for notifier in self._notifiers:
            close = getattr(notifier, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # pragma: no cover - best effort
                    pass


def build_bus(webhook_url: str | None = None, *, style: str = "json") -> NotifierBus:
    """The alert channels implied by the CLI options and environment."""
    bus = NotifierBus()
    if webhook_url:
        bus.add(WebhookNotifier(webhook_url, style=style))
    return bus
