"""Adapter interface + the generic sort-order vocabulary."""

from __future__ import annotations

import time
from typing import Protocol, runtime_checkable

from ..models import SearchQuery, SearchResult

ORDER_RELEVANCE = "relevance"
ORDER_NEWEST = "newest"
ORDER_PRICE_ASC = "price_asc"
ORDER_PRICE_DESC = "price_desc"


class MarketplaceError(RuntimeError):
    """Adapter-level failure (network, schema, configuration)."""


class MarketplaceBlocked(MarketplaceError):
    """The marketplace refused automated access (403 / challenge page).

    We stop instead of trying to evade it: see README.md "Legal & terms".
    """


class MarketplaceRateLimited(MarketplaceError):
    """429 after all retries were exhausted."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@runtime_checkable
class MarketplaceAdapter(Protocol):
    name: str

    def search(self, query: SearchQuery) -> SearchResult: ...


class PacingMixin:
    """Serialised, jittered request pacing + backoff for unofficial endpoints.

    Deliberately single-threaded: parallel workers are what gets an IP or an
    account blocked, and a price baseline does not need that speed.
    """

    min_interval: float = 6.0
    jitter: float = 3.0

    def _reset_pacing(self) -> None:
        self._last_request_at = 0.0

    def _pace(self) -> None:
        last = getattr(self, "_last_request_at", 0.0)
        target = last + self.min_interval + (self.jitter * _rand())
        wait = target - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def _mark_request(self) -> None:
        self._last_request_at = time.monotonic()


def _rand() -> float:  # isolated so tests can monkeypatch determinism
    import random

    return random.random()


def get_adapter(name: str, **kwargs) -> MarketplaceAdapter:
    """Factory: resolves an adapter by marketplace name."""
    key = (name or "").strip().lower()
    if key == "vinted":
        from .vinted import VintedAdapter

        return VintedAdapter(**kwargs)
    if key in {"leboncoin", "lbc"}:
        from .leboncoin import LeboncoinAdapter

        return LeboncoinAdapter(**kwargs)
    if key == "ebay":
        from .ebay import EbayBrowseAdapter

        return EbayBrowseAdapter(**kwargs)
    if key in {"mock", "fixture"}:
        from .mock import MockAdapter

        return MockAdapter(**kwargs)
    raise MarketplaceError(
        f"unknown marketplace '{name}' (expected: vinted | leboncoin | ebay | mock)"
    )
