/** The arbitrage arithmetic: fees, samples, confidence, and what a verdict means. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIDENCE_RANK,
  acquisitionPrice,
  cheapestUrl,
  computeOpportunity,
  liquidityScore,
  opportunityVerdicts,
  plausiblePrices,
  rankOpportunities,
  resolveFees,
  sampleConfidence,
} from "../src/core/opportunity.js";
import { normalizeCatalogItem } from "../src/core/catalog.js";
import { makeListing } from "../src/core/models.js";

const NOW = Date.parse("2026-02-01T12:00:00Z");

const listing = (price, over = {}) =>
  makeListing({
    marketplace: over.marketplace || "vinted",
    itemId: `${price}-${over.itemId || Math.random()}`,
    title: over.title || "iphone 13 256 go",
    url: over.url || `https://example.invalid/${price}`,
    price,
    currency: "EUR",
    favourites: over.favourites ?? null,
    createdAt: over.createdAt ?? null,
  });

const product = (over = {}) =>
  normalizeCatalogItem({ name: "iPhone 13", keyword: "iphone 13 256", ...over });

test("fees come from the destination marketplace unless the product overrides them", () => {
  assert.equal(resolveFees({ product: product({ resaleSource: "ebay" }) }).commissionPct, 0.11);
  assert.equal(resolveFees({ product: product({ resaleSource: "vinted" }) }).commissionPct, 0, "a private seller pays no commission");
  assert.equal(resolveFees({ product: product({ resaleSource: "manual" }) }).commissionPct, 0.1);
  assert.equal(resolveFees({ product: product({ fees: { commissionPct: 0.03 } }) }).commissionPct, 0.03);
  assert.equal(resolveFees({ product: product(), fees: { shippingOut: 0 } }).shippingOut, 0);
});

test("the acquisition price is a low percentile, not the once-in-a-year cheapest", () => {
  const prices = [100, 110, 120, 150, 200, 260, 320, 400];
  const p = acquisitionPrice(prices);
  assert.ok(p >= 100 && p <= 120, `expected a low quantile, got ${p}`);
  assert.equal(acquisitionPrice([180]), 180, "a single listing is still a price");
  assert.equal(acquisitionPrice([]), null);
  assert.equal(acquisitionPrice([0, -5, Number.NaN]), null, "nonsense prices are not a price");
});

test("the price band is what keeps a phone case out of a phone's market", () => {
  const prices = plausiblePrices([listing(5), listing(150), listing(400), listing(9000)], { min: 100, max: 700 });
  assert.deepEqual(prices, [150, 400]);
});

test("confidence is about sample size, and says so", () => {
  assert.equal(sampleConfidence({ buySize: 20, resaleSize: 10 }).level, "high");
  assert.equal(sampleConfidence({ buySize: 8, resaleSize: 4 }).level, "medium");
  assert.equal(sampleConfidence({ buySize: 3, resaleSize: 1 }).level, "low");
  assert.match(sampleConfidence({ buySize: 3, resaleSize: 1 }).reason, /thin samples/);
  assert.equal(sampleConfidence({ buySize: 15, manual: true }).level, "high");
  assert.equal(CONFIDENCE_RANK.low < CONFIDENCE_RANK.medium, true);
});

test("liquidity reads the marketplace's own evidence", () => {
  const quiet = liquidityScore({ totalEntries: 8, listings: [listing(150)], now: NOW });
  const busy = liquidityScore({
    totalEntries: 400,
    listings: [
      listing(150, { favourites: 20, createdAt: new Date(NOW - 3600_000).toISOString() }),
      listing(160, { favourites: 12, createdAt: new Date(NOW - 7200_000).toISOString() }),
      listing(170, { favourites: 30, createdAt: new Date(NOW - 10800_000).toISOString() }),
    ],
    now: NOW,
  });
  assert.ok(busy.score > quiet.score, `${busy.score} should beat ${quiet.score}`);
  assert.ok(busy.score <= 1 && busy.score >= 0);
  assert.match(busy.reasons.join(" "), /favourites per listing/);
  assert.match(busy.reasons.join(" "), /400 listing/);
});

test("a real opportunity: cheap on Vinted, expensive on eBay, and fees are subtracted", () => {
  const buy = [90, 100, 105, 110, 120, 130, 140, 150, 160, 170, 180, 190].map((price) => listing(price));
  const resale = [300, 310, 320, 330, 340, 350].map((price) => listing(price, { marketplace: "ebay" }));
  const opportunity = computeOpportunity({
    product: product({ resaleSource: "ebay", plausibleMinPrice: 50, plausibleMaxPrice: 600 }),
    buyListings: buy,
    resaleListings: resale,
    trends: { score: 0.5, reasons: ["public interest rising"] },
    settings: { opportunityMinMargin: 0.15, opportunityMinConfidence: "medium" },
    now: NOW,
  });

  assert.equal(opportunity.verdict, "buy");
  assert.equal(opportunity.confidence, "high");
  assert.equal(opportunity.buySample, 12);
  assert.equal(opportunity.resaleSample, 6);
  // median resale 325, 11% commission, 2% payment, 5 shipping -> 325*0.89*0.98-5
  const expectedNet = 325 * 0.89 * 0.98 - 5;
  const expectedCost = opportunity.buyPrice;
  assert.ok(Math.abs(opportunity.profitAbs - (expectedNet - expectedCost)) < 0.02);
  assert.ok(opportunity.marginPct > 1, "a 3x price gap is a big net margin");
  assert.ok(opportunity.score > 0.5);
  assert.match(opportunity.reasons.join(" "), /15th percentile/);
  assert.match(opportunity.reasons.join(" "), /after .*commission/);
  assert.equal(opportunity.buyUrl, "https://example.invalid/90");
});

test("a margin that fees eat is not a margin", () => {
  const buy = [100, 105, 110, 115, 120, 125, 130, 135].map((price) => listing(price));
  const resale = [118, 120, 122, 124, 126, 128].map((price) => listing(price, { marketplace: "ebay" }));
  const opportunity = computeOpportunity({
    product: product({ resaleSource: "ebay", plausibleMinPrice: 50, plausibleMaxPrice: 600 }),
    buyListings: buy,
    resaleListings: resale,
    settings: { opportunityMinMargin: 0.15, opportunityMinConfidence: "medium" },
    now: NOW,
  });
  assert.equal(opportunity.verdict, "skip");
  assert.ok(opportunity.marginPct < 0.15);
  assert.match(opportunity.reasons.join(" "), /below 15% after fees/);
});

test("thin data never becomes a verdict, however good the numbers look", () => {
  const opportunity = computeOpportunity({
    product: product({ plausibleMinPrice: 50, plausibleMaxPrice: 600 }),
    buyListings: [listing(80), listing(85), listing(90)],
    resaleListings: [listing(400, { marketplace: "ebay" })],
    settings: { opportunityMinMargin: 0.15, opportunityMinConfidence: "medium" },
    now: NOW,
  });
  assert.equal(opportunity.verdict, "insufficient data");
  assert.equal(opportunity.confidence, "low");
  assert.match(opportunity.reasons.join(" "), /confidence low is below the required medium/);
  // The arithmetic is still reported: the user can see the numbers and decide for themselves.
  assert.ok(opportunity.marginPct > 1);
});

test("a manual resale price is enough to score, with no resale sample at all", () => {
  const opportunity = computeOpportunity({
    product: product({ manualResalePrice: 320, plausibleMinPrice: 50, plausibleMaxPrice: 600 }),
    buyListings: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210].map((p) => listing(p)),
    manualResalePrice: 320,
    settings: { opportunityMinMargin: 0.15, opportunityMinConfidence: "medium" },
    now: NOW,
  });
  assert.equal(opportunity.resaleSource, "manual");
  assert.equal(opportunity.resalePrice, 320);
  assert.equal(opportunity.verdict, "buy");
  assert.match(opportunity.reasons.join(" "), /entered by hand/);
});

test("no resale price is a stated gap, not a zero", () => {
  const opportunity = computeOpportunity({
    product: product(),
    buyListings: [listing(100), listing(110), listing(120), listing(130), listing(140), listing(150)],
    resaleListings: [],
    resaleErrors: ["ebay: unavailable"],
    now: NOW,
  });
  assert.equal(opportunity.resalePrice, null);
  assert.equal(opportunity.verdict, "insufficient data");
  assert.match(opportunity.reasons.join(" "), /no resale price/);
  assert.deepEqual(opportunity.errors, ["ebay: unavailable"]);
});

test("ranking puts what you can act on first, and every verdict is counted", () => {
  const opportunity = (name, verdict, score, marginPct) => ({ name, verdict, score, marginPct, margin: marginPct });
  const rows = [
    opportunity("skip", "skip", 0.2, 0.02),
    opportunity("watch", "watch", 0.4, 0.1),
    opportunity("buy-b", "buy", 0.5, 0.2),
    opportunity("buy-a", "buy", 0.8, 0.3),
    opportunity("unknown", "insufficient data", null, null),
  ];
  assert.deepEqual(rankOpportunities(rows).map((r) => r.name), ["buy-a", "buy-b", "watch", "skip", "unknown"]);
  assert.deepEqual(rankOpportunities(rows, { onlyActionable: true }).map((r) => r.name), ["buy-a", "buy-b"]);
  assert.deepEqual(opportunityVerdicts(rows), { buy: 2, watch: 1, skip: 1, "insufficient data": 1 });
});

test("the cheapest plausible listing is what the card links to", () => {
  const listings = [listing(5, { url: "https://example.invalid/too-cheap" }), listing(150, { url: "https://example.invalid/a" }), listing(120, { url: "https://example.invalid/b" })];
  assert.equal(cheapestUrl(listings, { min: 100, max: 500 }), "https://example.invalid/b");
  assert.equal(cheapestUrl([], {}), null);
});
