/** The opportunities and history views: filtering, history rows, sparklines. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  confidenceLine,
  favouriteDeals,
  historyRows,
  historySummary,
  lastRunLine,
  opportunityCategories,
  opportunityHeadline,
  pageCounts,
  priceSeries,
  resaleReference,
  scoreLine,
  sparklinePath,
  verdictLabel,
  visibleOpportunities,
} from "../src/ui/views.js";

const opportunity = (over = {}) => ({
  id: over.id || over.name,
  name: "iPhone 13",
  category: "phones",
  keyword: "iphone 13 256",
  buyMarket: ["vinted", "leboncoin"],
  resaleSource: "ebay",
  buyPrice: 180,
  resalePrice: 320,
  profitAbs: 90.6,
  marginPct: 0.5,
  confidence: "high",
  confidenceReason: "12 buy-side and 6 resale listings",
  liquidity: 0.6,
  trend: 0.8,
  score: 0.7,
  verdict: "buy",
  currency: "EUR",
  reasons: ["after 11% commission"],
  ...over,
});

test("an opportunity headline states the trade, not just a number", () => {
  assert.equal(
    opportunityHeadline(opportunity()),
    "buy 180.00 EUR → sell 320.00 EUR · +50.0% after fees (+90.60 EUR)",
  );
  assert.match(opportunityHeadline(opportunity({ buyPrice: null })), /no acquisition price/);
  assert.match(opportunityHeadline(opportunity({ resalePrice: null })), /no resale price/);
  assert.equal(scoreLine(opportunity()), "score 70/100 · demand 60/100 · trend 80/100");
  assert.match(confidenceLine(opportunity()), /^high confidence · 12 buy-side/);
  assert.equal(verdictLabel("insufficient data"), "not enough data");
  assert.equal(verdictLabel("weird"), "weird");
});

test("the opportunities view filters by verdict, category and text, then sorts", () => {
  const rows = [
    opportunity({ id: "a", name: "iPhone 13", score: 0.9, marginPct: 0.2, liquidity: 0.1 }),
    opportunity({ id: "b", name: "RTX 3060", category: "pc-parts", verdict: "skip", score: 0.2, marginPct: 0.01, liquidity: 0.9 }),
    opportunity({ id: "c", name: "LEGO Star Wars", category: "lego", verdict: "watch", score: 0.5, marginPct: 0.12, liquidity: 0.5 }),
  ];
  assert.deepEqual(visibleOpportunities(rows).map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(visibleOpportunities(rows, { verdict: "skip" }).map((r) => r.id), ["b"]);
  assert.deepEqual(visibleOpportunities(rows, { actionableOnly: true }).map((r) => r.id), ["a"]);
  assert.deepEqual(visibleOpportunities(rows, { category: "lego" }).map((r) => r.id), ["c"]);
  assert.deepEqual(visibleOpportunities(rows, { text: "rtx" }).map((r) => r.id), ["b"]);
  assert.deepEqual(visibleOpportunities(rows, { text: "LEBONCOIN" }).map((r) => r.id), ["a", "c", "b"], "the buy side is searchable too");
  assert.deepEqual(visibleOpportunities(rows, { sort: "margin" }).map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(visibleOpportunities(rows, { sort: "demand" }).map((r) => r.id), ["b", "c", "a"]);
  assert.deepEqual(visibleOpportunities(rows, { sort: "name" }).map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(opportunityCategories(rows), ["lego", "pc-parts", "phones"]);
});

test("history rows cover both kinds of scan and can be filtered", () => {
  const history = [
    { at: "2026-02-01T10:00:00Z", kind: "watch", watch: "iphone", marketplace: "vinted", marketPrice: 200, currency: "EUR", comparables: 40, deals: 2, newDeals: 1, requests: 4, error: null },
    { at: "2026-02-01T09:00:00Z", kind: "opportunities", products: 12, deals: 3, newDeals: 1, requests: 40, error: null },
    { at: "2026-02-01T08:00:00Z", kind: "watch", watch: "dyson", marketplace: "leboncoin", marketPrice: null, currency: null, comparables: 0, deals: 0, newDeals: 0, requests: 2, error: "blocked", message: "DataDome" },
  ];
  assert.equal(historyRows(history).length, 3);
  assert.deepEqual(historyRows(history, { kind: "watch" }).map((r) => r.watch), ["iphone", "dyson"]);
  assert.deepEqual(historyRows(history, { watch: "dyson" }).length, 1);
  assert.deepEqual(historyRows(history, { text: "datadome" }).length, 1);
  assert.equal(historyRows(history, { limit: 1 }).length, 1);

  assert.equal(historySummary(history[0]), "200.00 EUR from 40 comparable(s) · 2 deal(s) (1 new)");
  assert.equal(historySummary(history[1]), "12 product(s) measured · 3 to buy · 40 request(s)");
  assert.equal(historySummary(history[2]), "no verdict from 0 comparable(s) · 0 deal(s) (0 new)");
});

test("a price series is oldest-first, one watch only, and never invented", () => {
  const history = [
    { kind: "watch", watch: "iphone", marketPrice: 230, currency: "EUR" },
    { kind: "watch", watch: "iphone", marketPrice: 210, currency: "EUR" },
    { kind: "watch", watch: "dyson", marketPrice: 90, currency: "EUR" },
    { kind: "opportunities", watch: null, products: 3 },
    { kind: "watch", watch: "iphone", marketPrice: null, currency: "EUR" },
  ];
  const series = priceSeries(history, "iphone");
  assert.deepEqual(series.map((row) => row.marketPrice), [210, 230], "oldest first, and no-null rows");
  assert.deepEqual(priceSeries(history, "nothing"), []);
});

test("the sparkline draws nothing rather than something meaningless", () => {
  assert.equal(sparklinePath([]), "");
  assert.equal(sparklinePath([{ marketPrice: 100 }]), "");
  const path = sparklinePath([
    { marketPrice: 100 },
    { marketPrice: 200 },
    { marketPrice: 150 },
  ]);
  assert.match(path, /^M/);
  assert.equal(path.split("L").length, 3);
  // The cheapest point sits at the bottom of the box, the dearest at the top.
  const points = [...path.matchAll(/([ML])([\d.]+),([\d.]+)/g)].map((m) => ({ x: Number(m[2]), y: Number(m[3]) }));
  assert.ok(points[0].y > points[1].y);
  assert.ok(points[2].y > points[1].y && points[2].y < points[0].y);
});

test("starred deals come back newest-starred first, and the badges count what they say", () => {
  const alerts = [
    { key: "a", status: "new", favourite: true, firstSeen: "2026-01-01T00:00:00Z", favouriteChangedAt: "2026-01-02T00:00:00Z" },
    { key: "b", status: "new", favourite: false },
    { key: "c", status: "bought", favourite: true, favouriteChangedAt: "2026-01-05T00:00:00Z" },
  ];
  assert.deepEqual(favouriteDeals(alerts).map((a) => a.key), ["c", "a"]);
  assert.deepEqual(pageCounts({ alerts, opportunities: [opportunity(), opportunity({ id: "x", verdict: "skip" })] }), {
    deals: 2,
    favourites: 2,
    opportunities: 1,
  });
  assert.equal(lastRunLine([]), "never run");
  assert.equal(lastRunLine([{ at: new Date().toISOString(), products: 12, requests: 40 }]).includes("12 product(s)"), true);
});

// --- the resale reference on an opportunity card ---------------------------

test("a resale reference is always stated - measured, or honestly not", () => {
  // The single-source case: the engine leaves `resaleReferences` empty, and the card
  // used to show no reference at all because of it.
  const single = resaleReference({ currency: "EUR", resaleSource: "backmarket", resalePrice: 310, resaleSample: 9, confidence: "high" });
  assert.equal(single.measured, true);
  assert.equal(single.value, "310.00 EUR — median on Back Market");
  assert.match(single.detail, /9 resale listing\(s\) used/);

  // A manual price is what gets used, so it is what gets shown.
  const manual = resaleReference({ currency: "EUR", resaleSource: "manual", manualResalePrice: 275, resalePrice: 275, resaleSample: 0 });
  assert.equal(manual.measured, true);
  assert.match(manual.value, /275\.00 EUR — the price you typed in/);
  assert.match(manual.detail, /overrides/);

  // Several references: every one is listed, with its own sample size.
  const many = resaleReference({
    currency: "EUR",
    resaleSpread: 0.1,
    resaleReferences: [
      { source: "ebay", median: 320, sample: 14 },
      { source: "backmarket", median: 295, sample: 6 },
    ],
  });
  assert.equal(many.measured, true);
  assert.equal(many.value, "eBay 320.00 EUR · Back Market 295.00 EUR");
  assert.match(many.detail, /median of eBay: 14 listing\(s\), Back Market: 6 listing\(s\)/);
  assert.match(many.detail, /the lowest one wins/, "the consensus rule is stated, not implied");

  // Nothing measured: said out loud, with the three ways to fix it.
  const none = resaleReference({ currency: "EUR", resaleSource: "ebay", resalePrice: null, resaleSample: 0 });
  assert.equal(none.measured, false);
  assert.equal(none.value, "no resale price measured");
  assert.match(none.detail, /nothing came back from eBay/);
  assert.match(none.detail, /add an eBay keyset in API keys/);

  // An empty object must not throw, because a half-written record is a real state.
  assert.equal(resaleReference({}).measured, false);
  assert.match(resaleReference({}).detail, /the resale side/);
});
