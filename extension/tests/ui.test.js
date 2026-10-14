/** The dashboard's sorting/filtering/formatting logic, tested without a browser. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  countByStatus,
  dealHeadline,
  marketplaceLabel,
  money,
  percent,
  relativeTime,
  untilTime,
  visibleDeals,
  watchSummary,
} from "../src/ui/format.js";

const alert = (over = {}) => ({
  key: over.key || `k${Math.random()}`,
  watch: "pixel",
  marketplace: "mock",
  title: "pixel 8 - listing 1000",
  price: 110,
  currency: "EUR",
  marketPrice: 200,
  discountPct: 0.45,
  status: "new",
  firstSeen: "2026-01-02T00:00:00.000Z",
  ...over,
});

test("money and percent never render nonsense", () => {
  assert.equal(money(110, "EUR"), "110.00 EUR");
  assert.equal(money(1500, "EUR", { compact: true }), "1500 EUR");
  assert.equal(money(null, "EUR"), "—");
  assert.equal(money(undefined), "—");
  assert.equal(money(Number.NaN, "EUR"), "—");
  assert.equal(percent(0.4532), "45%");
  assert.equal(percent(0.4532, 1), "45.3%");
  assert.equal(percent(null), "—");
});

test("times read the way a person says them", () => {
  const now = Date.parse("2026-01-02T12:00:00Z");
  assert.equal(relativeTime("2026-01-02T11:59:40Z", now), "just now");
  assert.equal(relativeTime("2026-01-02T11:57:00Z", now), "3 min ago");
  assert.equal(relativeTime("2026-01-02T09:00:00Z", now), "3 h ago");
  assert.equal(relativeTime("2026-01-01T09:00:00Z", now), "yesterday");
  assert.equal(relativeTime("2025-12-25T09:00:00Z", now), "8 d ago");
  assert.equal(relativeTime(null, now), "never");
  assert.equal(relativeTime("not a date", now), "never");
  assert.equal(untilTime("2026-01-02T12:12:00Z", now), "in 12 min");
  assert.equal(untilTime("2026-01-02T11:00:00Z", now), "due now");
});

test("the deals view filters by status, watch, marketplace and text", () => {
  const alerts = [
    alert({ key: "a", status: "new", title: "pixel 8", firstSeen: "2026-01-03T00:00:00.000Z" }),
    alert({ key: "b", status: "bought", title: "iphone 13", watch: "phone", marketplace: "leboncoin" }),
    alert({ key: "c", status: "new", title: "dyson v8", watch: "vacuum", discountPct: 0.2 }),
  ];
  assert.deepEqual(visibleDeals(alerts).map((a) => a.key), ["a", "c"]);       // "new" is the default view
  assert.deepEqual(visibleDeals(alerts, { status: "all" }).map((a) => a.key).sort(), ["a", "b", "c"]);
  assert.deepEqual(visibleDeals(alerts, { status: "bought" }).map((a) => a.key), ["b"]);
  assert.deepEqual(visibleDeals(alerts, { status: "all", watch: "phone" }).map((a) => a.key), ["b"]);
  assert.deepEqual(visibleDeals(alerts, { status: "all", marketplace: "leboncoin" }).map((a) => a.key), ["b"]);
  assert.deepEqual(visibleDeals(alerts, { status: "all", text: "iphone" }).map((a) => a.key), ["b"]);
  assert.deepEqual(visibleDeals(alerts, { status: "all", text: "PIXEL" }).map((a) => a.key), ["a"]);
  assert.deepEqual(visibleDeals(alerts, { status: "all", minDiscount: 0.3 }).map((a) => a.key).sort(), ["a", "b"]);
});

test("sorting is newest, best discount, or cheapest", () => {
  const alerts = [
    alert({ key: "old-cheap", price: 50, discountPct: 0.75, firstSeen: "2026-01-01T00:00:00.000Z" }),
    alert({ key: "new-mild", price: 180, discountPct: 0.1, firstSeen: "2026-01-09T00:00:00.000Z" }),
    alert({ key: "mid", price: 90, discountPct: 0.5, firstSeen: "2026-01-05T00:00:00.000Z" }),
  ];
  assert.deepEqual(visibleDeals(alerts, { sort: "newest" }).map((a) => a.key), ["new-mild", "mid", "old-cheap"]);
  assert.deepEqual(visibleDeals(alerts, { sort: "discount" }).map((a) => a.key), ["old-cheap", "mid", "new-mild"]);
  assert.deepEqual(visibleDeals(alerts, { sort: "cheapest" }).map((a) => a.key), ["old-cheap", "mid", "new-mild"]);
});

test("status counts drive the tabs", () => {
  const counts = countByStatus([alert({ status: "new" }), alert({ status: "new" }), alert({ status: "bought" })]);
  assert.deepEqual(counts, { new: 2, bought: 1, hidden: 0 });
});

test("a card headline states the price and the comparison", () => {
  assert.equal(dealHeadline(alert()), "110.00 EUR · 45% under 200.00 EUR market");
});

test("a watch summary explains whether there is a verdict yet", () => {
  const run = { marketPrice: 192.97, comparables: 63, error: null };
  assert.deepEqual(watchSummary(run, { stats: { currency: "EUR" } }), {
    marketPrice: 192.97,
    comparables: 63,
    line: "192.97 EUR from 63 comparable listings",
    error: null,
  });
  assert.equal(watchSummary({ error: "blocked", message: "403 DataDome" }, null).error, "403 DataDome");
  assert.equal(watchSummary(null, null).line, "never scanned");
  assert.equal(watchSummary({ marketPrice: null, comparables: 0 }, null).line, "no verdict");
});

test("marketplaces have human names", () => {
  assert.equal(marketplaceLabel("leboncoin"), "leboncoin");
  assert.equal(marketplaceLabel("vinted"), "Vinted");
  assert.equal(marketplaceLabel("mock"), "offline demo");
  assert.equal(marketplaceLabel("weird"), "weird");
});
