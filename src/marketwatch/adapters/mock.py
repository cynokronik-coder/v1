"""Deterministic offline marketplace.

Used by the test suite and by `--marketplace mock` demos: it produces a
synthetic market around a configurable base price, plants a few genuine
bargains, and plants junk listings below the plausibility floor so the
analyzer's filters are exercised end to end.
"""

from __future__ import annotations

import random

from ..models import Listing, SearchQuery, SearchResult
from .base import ORDER_NEWEST, ORDER_PRICE_ASC, ORDER_PRICE_DESC, MarketplaceError

JUNK_PRICE = 1.0


class MockAdapter:
    name = "mock"

    def __init__(
        self,
        market: dict[str, list[Listing]] | None = None,
        *,
        base_price: float = 200.0,
        spread: float = 0.35,
        pool_size: int = 60,
        bargain_discounts: tuple[float, ...] = (0.45, 0.40, 0.35),
        junk_listings: int = 2,
        currency: str = "EUR",
        seed: int = 7,
        **_: object,
    ) -> None:
        self.market = market or {}
        self.base_price = base_price
        self.spread = spread
        self.pool_size = pool_size
        self.bargain_discounts = bargain_discounts
        self.junk_listings = junk_listings
        self.currency = currency
        self.seed = seed

    def generate(self, search_text: str) -> list[Listing]:
        """Build a stable synthetic pool for a query."""
        rng = random.Random(f"{self.seed}:{search_text}")
        listings: list[Listing] = []
        for i in range(self.pool_size):
            price = round(self.base_price * (1 + rng.uniform(-self.spread, self.spread)), 2)
            listings.append(self._listing(search_text, f"std-{i}", price, i))
        for n, discount in enumerate(self.bargain_discounts):
            price = round(self.base_price * (1 - discount), 2)
            listings.append(self._listing(search_text, f"deal-{n}", price, 1000 + n))
        for n in range(self.junk_listings):
            listings.append(self._listing(search_text, f"junk-{n}", JUNK_PRICE, 2000 + n))
        return listings

    def _listing(self, search_text: str, slug: str, price: float, index: int) -> Listing:
        item_id = f"{abs(hash(search_text)) % 10**6}-{slug}"
        return Listing(
            marketplace=self.name,
            item_id=item_id,
            title=f"{search_text} - listing {index}",
            url=f"https://example.invalid/items/{item_id}",
            price=price,
            currency=self.currency,
            landed_price=round(price * 1.05 + 1.0, 2),
            condition="très bon état",
            brand=search_text.split()[0],
            size="M",
            favourites=index % 7,
            created_at=None,
        )

    def search(self, query: SearchQuery) -> SearchResult:
        if query.page < 1:
            raise MarketplaceError("page must be >= 1")
        pool = self.market.get(query.search_text) or self.generate(query.search_text)
        order = query.order
        if order == ORDER_PRICE_ASC:
            pool = sorted(pool, key=lambda l: l.price)
        elif order == ORDER_PRICE_DESC:
            pool = sorted(pool, key=lambda l: l.price, reverse=True)
        elif order == ORDER_NEWEST:
            pool = list(reversed(pool))

        start = (query.page - 1) * query.per_page
        page_items = pool[start : start + query.per_page]
        return SearchResult(
            marketplace=self.name,
            items=page_items,
            page=query.page,
            per_page=query.per_page,
            total_entries=len(pool),
            total_pages=max(1, -(-len(pool) // query.per_page)),
        )
