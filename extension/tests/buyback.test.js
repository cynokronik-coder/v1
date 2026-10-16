/**
 * The instant-payout path: what a refurbisher pays you, versus what a buyer is charged.
 *
 * This exists because those two numbers were being confused. A search of backmarket.fr
 * returns asking prices - what a buyer pays - and the extension was quoting that as the
 * resale figure, with no commission removed and no hint that the same site also runs a
 * trade-in flow quoting a much lower number for the same model. Measured 2026: an
 * iPhone 13 Pro Max, "up to 385 EUR" on Back Market's own buyback page against
 * refurbished asks starting at 432 EUR.
 *
 * So the tests below are as much about what must NOT happen - a payout must never be an
 * ask, an unmeasured payout must never be a zero, and a category whose logistics charge
 * is not published must never get an invented one - as about the arithmetic.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKMARKET_TRADE_IN,
  buybackUrl,
  modelSlug,
  netPayout,
  payoutFromQuote,
  payoutSummary,
  tradeInLogistics,
  unmeasuredPayout,
} from "../src/core/buyback.js";
import { computeOpportunity } from "../src/core/opportunity.js";
import { normalizeCatalogItem } from "../src/core/catalog.js";
import { makeListing } from "../src/core/models.js";

const listing = (price, marketplace = "vinted") =>
  makeListing({
    marketplace,
    itemId: `${marketplace}-${price}`,
    title: "iphone 13 128",
    url: `https://example.invalid/${marketplace}/${price}`,
    price,
    currency: "EUR",
  });

const NOW = Date.parse("2026-02-01T12:00:00Z");

// --- the arithmetic --------------------------------------------------------

test("a trade-in quote is cut by the commission and the return logistics", () => {
  // The published schedule: 10% on what the refurbisher pays, then the flat charge.
  // 385 -> 346.50 -> 335.60 for a phone.
  const phone = netPayout({ gross: 385, category: "phones" });
  assert.equal(phone.commissionPct, 0.1);
  assert.equal(phone.commission, 38.5);
  assert.equal(phone.logistics, 10.9);
  assert.equal(phone.net, 335.6);
  assert.equal(phone.logisticsKnown, true);

  // MacBooks, consoles and tablets cost more to send back.
  assert.equal(netPayout({ gross: 500, category: "consoles" }).net, 436.1);
  assert.equal(tradeInLogistics("laptops").amount, 13.9);
  assert.equal(tradeInLogistics("audio").amount, 10.9);
});

test("a category with no published logistics charge says so instead of guessing", () => {
  const boots = netPayout({ gross: 100, category: "sneakers" });
  assert.equal(boots.logisticsKnown, false);
  assert.equal(boots.logistics, 0, "nothing is deducted, because nothing is documented");
  assert.equal(boots.net, 90, "the commission is still applied");
  assert.equal(tradeInLogistics(undefined).known, false);
});

test("a nonsense quote is not a payout", () => {
  assert.equal(netPayout({ gross: 0 }), null);
  assert.equal(netPayout({ gross: null }), null);
  assert.equal(netPayout({ gross: Number.NaN }), null);
  assert.equal(netPayout({ gross: -20 }), null);
});

test("the commission can be overridden, because the schedule is not your contract", () => {
  const overridden = netPayout({ gross: 385, category: "phones", commissionPct: 0.2, logistics: 0 });
  assert.equal(overridden.net, 308);
  assert.equal(BACKMARKET_TRADE_IN.commissionPct, 0.1, "the published default is unchanged");
});

// --- the URL ---------------------------------------------------------------

test("a model name becomes the slug Back Market's own URLs use", () => {
  assert.equal(modelSlug("iPhone 13 Pro Max"), "iphone-13-pro-max");
  // Catalogue names carry their variants, which are not part of the model URL.
  assert.equal(modelSlug("iPhone 13 (128 / 256 Go)"), "iphone-13");
  assert.equal(modelSlug("Sony A7 III — boîtier nu"), "sony-a7-iii-boitier-nu");
  assert.equal(modelSlug("  RTX 3060  "), "rtx-3060");
  assert.equal(modelSlug(""), "");
});

test("only the verified family gets a model URL; everything else goes to the flow", () => {
  const phones = buybackUrl({ category: "phones", slug: "iPhone 13" });
  assert.equal(phones.url, "https://www.backmarket.fr/fr-fr/buyback/m/smartphone/iphone-13");
  assert.equal(phones.exact, true);

  // Guessing the remaining path segments would ship links that 404, so an unverified
  // family gets the page where Back Market's own flow picks the device.
  const consoles = buybackUrl({ category: "consoles", slug: "PlayStation 5" });
  assert.equal(consoles.url, "https://www.backmarket.fr/fr-fr/buyback/home");
  assert.equal(consoles.exact, false);

  // A verified family with no usable slug is the same case.
  assert.equal(buybackUrl({ category: "phones", slug: "" }).exact, false);
  assert.equal(buybackUrl({ category: "phones", slug: "iPhone 13", domain: "www.backmarket.com" }).url.startsWith("https://www.backmarket.com/"), true);
});

// --- the shapes the card consumes ------------------------------------------

test("a quote becomes a payout with its fees stated", () => {
  const payout = payoutFromQuote({ amount: 385, currency: "EUR" }, { category: "phones", productName: "iPhone 13" });
  assert.equal(payout.measured, true);
  assert.equal(payout.gross, 385);
  assert.equal(payout.net, 335.6);
  assert.equal(payout.source, "backmarket-buyback");
  assert.match(payoutSummary(payout), /385\.00 EUR trade-in quote/);
  assert.match(payoutSummary(payout), /less 10% commission \(38\.50 EUR\) and 10\.90 EUR logistics => 335\.60 EUR net/);

  assert.equal(payoutFromQuote(null), null);
  assert.equal(payoutFromQuote({ amount: 0 }), null);
  assert.equal(payoutSummary(null), null, "an unmeasured payout has no summary to print");
});

test("an unmeasured payout is a link to the flow, never a zero", () => {
  const missing = unmeasuredPayout({ category: "phones", keyword: "iphone 13", url: "https://example.invalid/buyback" });
  assert.equal(missing.measured, false);
  assert.equal(missing.net, null);
  assert.notEqual(missing.net, 0, "zero would read as \"they will pay nothing\", which is a different claim");
  assert.equal(missing.url, "https://example.invalid/buyback");
  assert.match(missing.reason, /enter the offer you are given/);
});

// --- how it lands on an opportunity ----------------------------------------

const product = (over = {}) =>
  normalizeCatalogItem({
    id: "iphone-13",
    name: "iPhone 13 (128 / 256 Go)",
    keyword: "iphone 13 128",
    buyMarket: ["vinted"],
    resaleSource: "backmarket",
    plausibleMinPrice: 50,
    plausibleMaxPrice: 900,
    ...over,
  });

const settings = { opportunityMinMargin: 0.15, opportunityMinConfidence: "medium" };

test("the payout is scored on its own and never blended into the resale ask", () => {
  const buy = [180, 185, 190, 195, 200, 205, 210, 215, 220, 225, 230, 235].map((p) => listing(p));
  const ask = [300, 310, 320, 330, 340, 350].map((p) => listing(p, "backmarket"));

  const withoutQuote = computeOpportunity({
    product: product({ category: "phones" }),
    buyListings: buy,
    resaleListings: ask,
    settings,
    now: NOW,
  });
  const withQuote = computeOpportunity({
    product: product({ category: "phones" }),
    buyListings: buy,
    resaleListings: ask,
    payout: payoutFromQuote({ amount: 385, currency: "EUR" }, { category: "phones" }),
    settings,
    now: NOW,
  });

  // The ask is untouched by the payout: a 325 median (six asks, one source), and the
  // commission is 12%, because the quoted source is Back Market and this is a phone.
  assert.equal(withoutQuote.resalePrice, 325);
  assert.equal(withoutQuote.fees.commissionPct, 0.12);
  assert.equal(withQuote.resalePrice, withoutQuote.resalePrice);
  assert.equal(withQuote.marginPct, withoutQuote.marginPct);

  // The payout is its own figure, with its own margin and verdict.
  assert.equal(withQuote.payout.gross, 385);
  assert.equal(withQuote.payout.net, 335.6);
  assert.equal(withQuote.payout.cost, withQuote.buyPrice);
  assert.equal(withQuote.payout.profitAbs, Math.round((335.6 - withQuote.buyPrice) * 100) / 100);
  assert.equal(withQuote.payout.breakEvenBuyPrice, 335.6);
  assert.equal(withQuote.payout.verdict, "buy");
  assert.match(withQuote.reasons.join(" "), /instant trade-in via Back Market trade-in/);
  assert.match(withQuote.reasons.join(" "), /breaks even at a buy price of 335\.60 EUR/);
});

test("the trade-in route can be the only one that fails, and the card says which is which", () => {
  const buy = [200, 205, 210, 215, 220, 225, 230, 235, 240, 245, 250, 255].map((p) => listing(p));
  const ask = [400, 410, 420, 430, 440, 450].map((p) => listing(p, "backmarket"));

  const opportunity = computeOpportunity({
    product: product({ category: "phones" }),
    buyListings: buy,
    resaleListings: ask,
    payout: payoutFromQuote({ amount: 150, currency: "EUR" }, { category: "phones" }),
    settings: { ...settings, opportunityMinMargin: 0.2 },
    now: NOW,
  });

  // Selling it yourself clears the bar comfortably: a 425 ask, 12% commission.
  assert.equal(opportunity.verdict, "buy");
  // The same model's trade-in quote does not: 124.10 net against a ~207 acquisition price.
  assert.equal(opportunity.payout.net, 124.1);
  assert.equal(opportunity.payout.verdict, "skip");
  assert.ok(opportunity.payout.profitAbs < 0);
  assert.match(opportunity.reasons.join(" "), /Only the sell-it-yourself route clears the margin/);
});

test("a ceiling reference is named as a ceiling, with the commission that explains it", () => {
  const buy = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190].map((p) => listing(p));
  const opportunity = computeOpportunity({
    product: product({ category: "phones" }),
    buyListings: buy,
    resaleListings: [300, 310, 320].map((p) => listing(p, "backmarket")),
    settings,
    now: NOW,
  });
  assert.equal(opportunity.resaleIsCeiling, true);
  const reasons = opportunity.reasons.join(" ");
  assert.match(reasons, /asking price, not a payout/);
  assert.match(reasons, /12% commission it keeps/);
  assert.match(reasons, /smartphones sold in France or Spain/, "the band behind the rate is stated");
  assert.match(reasons, /its own buy-back offer is the number to look for/);

  // A private-seller reference is not a ceiling: it is what the seller receives.
  const vinted = computeOpportunity({
    product: product({ resaleSource: "vinted" }),
    buyListings: buy,
    resaleListings: [300, 310, 320].map((p) => listing(p, "vinted")),
    settings,
    now: NOW,
  });
  assert.equal(vinted.resaleIsCeiling, false);
  assert.doesNotMatch(vinted.reasons.join(" "), /asking price, not a payout/);
});

test("an unmeasured payout is stated, and is not a zero on the card either", () => {
  const opportunity = computeOpportunity({
    product: product({ category: "phones" }),
    buyListings: [180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290].map((p) => listing(p)),
    resaleListings: [400, 410, 420].map((p) => listing(p, "backmarket")),
    payout: unmeasuredPayout({ category: "phones", url: "https://example.invalid/buyback", reason: "the buyback page answered HTTP 403" }),
    settings,
    now: NOW,
  });
  assert.equal(opportunity.payout.measured, false);
  assert.equal(opportunity.payout.net, null);
  assert.equal(opportunity.payout.verdict, undefined, "there is nothing to score");
  assert.match(opportunity.reasons.join(" "), /no trade-in quote was read \(the buyback page answered HTTP 403\) - unmeasured, not zero/);
});

test("a payout survives a run where the ask never arrived", () => {
  // The two sides fail independently: no resale price means "insufficient data" for the
  // arbitrage, but the payout is still a real answer about the item.
  const opportunity = computeOpportunity({
    product: product({ category: "phones" }),
    buyListings: [180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290].map((p) => listing(p)),
    resaleListings: [],
    payout: payoutFromQuote({ amount: 385, currency: "EUR" }, { category: "phones" }),
    settings,
    now: NOW,
  });
  assert.equal(opportunity.resalePrice, null);
  assert.equal(opportunity.verdict, "insufficient data");
  assert.equal(opportunity.payout.measured, true);
  assert.equal(opportunity.payout.net, 335.6);
  assert.ok(opportunity.payout.marginPct > 0, "and it is still scored against the buy price");
});
