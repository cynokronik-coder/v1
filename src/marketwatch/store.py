"""SQLite persistence: what we have seen, what we alerted, cached baselines.

Two different dedupe keys matter:
  * listings  -> "have I ever seen this item for this watch?"  (first_seen)
  * alerts    -> "have I already told the user about this bargain?"
                 A deal is re-reported only if its price dropped further.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import Deal, Listing, PriceStats

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    marketplace TEXT NOT NULL, item_id TEXT NOT NULL, watch TEXT NOT NULL,
    title TEXT, url TEXT, price REAL, currency TEXT, landed_price REAL,
    condition TEXT, brand TEXT, size TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (marketplace, item_id, watch)
);
CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace TEXT NOT NULL, item_id TEXT NOT NULL, watch TEXT NOT NULL,
    price REAL NOT NULL, currency TEXT, seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    marketplace TEXT NOT NULL, item_id TEXT NOT NULL, watch TEXT NOT NULL,
    title TEXT, url TEXT, price REAL NOT NULL, currency TEXT,
    market_price REAL, discount_pct REAL, robust_z REAL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (marketplace, item_id, watch)
);
CREATE TABLE IF NOT EXISTS comp_stats (
    watch TEXT PRIMARY KEY, payload TEXT NOT NULL, computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item ON price_snapshots (marketplace, item_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at DESC);
"""

PRICE_DROP_REALERT = 0.05  # re-alert a known bargain if it got 5% cheaper


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str | Path = "marketwatch.sqlite3") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- listings ---------------------------------------------------------
    def note_listing(self, listing: Listing, watch: str) -> bool:
        """Record a listing; True when this (marketplace, item, watch) is new."""
        cur = self.conn.execute(
            "SELECT 1 FROM listings WHERE marketplace=? AND item_id=? AND watch=?",
            (*listing.key(), watch),
        )
        is_new = cur.fetchone() is None
        now = _now()
        self.conn.execute(
            """
            INSERT INTO listings (marketplace, item_id, watch, title, url, price, currency,
                                  landed_price, condition, brand, size, first_seen, last_seen)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (marketplace, item_id, watch) DO UPDATE SET
                last_seen=excluded.last_seen, price=excluded.price,
                landed_price=excluded.landed_price
            """,
            (listing.marketplace, listing.item_id, watch, listing.title, listing.url,
             listing.price, listing.currency, listing.landed_price, listing.condition,
             listing.brand, listing.size, now, now),
        )
        self.conn.execute(
            "INSERT INTO price_snapshots (marketplace, item_id, watch, price, currency, seen_at)"
            " VALUES (?,?,?,?,?,?)",
            (listing.marketplace, listing.item_id, watch, listing.price, listing.currency, now),
        )
        self.conn.commit()
        return is_new

    def seen_item_ids(self, watch: str, marketplace: str | None = None) -> set[str]:
        sql = "SELECT item_id FROM listings WHERE watch=?"
        args: list[str] = [watch]
        if marketplace:
            sql += " AND marketplace=?"
            args.append(marketplace)
        return {row["item_id"] for row in self.conn.execute(sql, args)}

    def price_history(self, listing: Listing, watch: str | None = None) -> list[float]:
        sql = "SELECT price FROM price_snapshots WHERE marketplace=? AND item_id=?"
        args: list = [*listing.key()]
        if watch:
            sql += " AND watch=?"
            args.append(watch)
        sql += " ORDER BY seen_at"
        return [row["price"] for row in self.conn.execute(sql, args)]

    # --- alerts -----------------------------------------------------------
    def mark_alert(self, deal: Deal) -> bool:
        """True when the user should be told about this deal now.

        New bargain -> True. Already reported and the price did not fall
        further -> False (no spam). Price fell >= 5% -> True again.
        """
        listing = deal.listing
        row = self.conn.execute(
            "SELECT price FROM alerts WHERE marketplace=? AND item_id=? AND watch=?",
            (*listing.key(), deal.watch),
        ).fetchone()
        should_report = row is None or listing.price <= row["price"] * (1 - PRICE_DROP_REALERT)
        if not should_report:
            return False
        self.conn.execute(
            """
            INSERT INTO alerts (marketplace, item_id, watch, title, url, price, currency,
                                market_price, discount_pct, robust_z, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (marketplace, item_id, watch) DO UPDATE SET
                price=excluded.price, market_price=excluded.market_price,
                discount_pct=excluded.discount_pct, robust_z=excluded.robust_z,
                created_at=excluded.created_at
            """,
            (listing.marketplace, listing.item_id, deal.watch, listing.title, listing.url,
             listing.price, listing.currency, deal.market_price, deal.discount_pct,
             deal.robust_z, _now()),
        )
        self.conn.commit()
        return True

    def recent_alerts(self, limit: int = 50, watch: str | None = None) -> list[Deal]:
        sql = "SELECT * FROM alerts"
        args: list = []
        if watch:
            sql += " WHERE watch=?"
            args.append(watch)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        deals: list[Deal] = []
        for row in self.conn.execute(sql, args):
            listing = Listing(
                marketplace=row["marketplace"], item_id=row["item_id"], title=row["title"] or "",
                url=row["url"] or "", price=row["price"], currency=row["currency"] or "EUR",
            )
            deals.append(
                Deal(
                    watch=row["watch"], listing=listing, market_price=row["market_price"] or 0.0,
                    discount_pct=row["discount_pct"] or 0.0, robust_z=row["robust_z"] or 0.0,
                    reasons=["stored alert"],
                    first_seen=datetime.fromisoformat(row["created_at"]),
                )
            )
        return deals

    # --- baseline cache ---------------------------------------------------
    def save_stats(self, watch: str, stats: PriceStats) -> None:
        self.conn.execute(
            "INSERT INTO comp_stats (watch, payload, computed_at) VALUES (?,?,?)"
            " ON CONFLICT (watch) DO UPDATE SET payload=excluded.payload,"
            " computed_at=excluded.computed_at",
            (watch, stats.model_dump_json(), _now()),
        )
        self.conn.commit()

    def load_stats(self, watch: str, ttl_seconds: int) -> PriceStats | None:
        row = self.conn.execute(
            "SELECT payload, computed_at FROM comp_stats WHERE watch=?", (watch,)
        ).fetchone()
        if row is None:
            return None
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["computed_at"])).total_seconds()
        if ttl_seconds >= 0 and age > ttl_seconds:
            return None
        return PriceStats(**json.loads(row["payload"]))
