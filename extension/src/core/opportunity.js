/**
 * Arbitrage scoring: "can I buy this here, right now, and sell it there for more?"
 *
 * This is a different question from the Deals page. There, one marketplace prices
 * itself and we look for outliers. Here we compare **two different markets**: what
 * a used item actually costs to acquire on the buy side (Vinted / leboncoin, where
 * private sellers dump things) against what the same thing fetches on the resale
 * side (eBay used/refurbished, Back Market refurbished, or a price the user read
 * somewhere and typed in).
 *
 * Everything in this file is pure arithmetic on numbers that were already fetched:
 * no network, no DOM, no storage. The numbers that decide the answer are the fee
 * model, the acquisition price, and the sample sizes - so those are explicit.
 *
 * Deliberately NOT here: any pretence that a thin sample is an answer. If either
 * side is too thin, the verdict is "insufficient data" and says which side.
 */

import { median, quantile } from "./analyzer.js";

/** Marketplace take-rates, as fractions. Overridable per product. */
export const FEE_PRESETS = {
  vinted: { commissionPct: 0, paymentPct: 0, note: "private sellers pay no commission" },
  leboncoin: { commissionPct: 0, paymentPct: 0, note: "private sellers pay no commission" },
  ebay: { commissionPct: 0.11, paymentPct: 0.02, note: "~11-13% final value fee plus payment processing" },
  // Back Market's real rate depends on the category - see BACKMARKET_COMMISSION below.
  // The preset is only the fallback for a product with no usable category.
  backmarket: { commissionPct: 0.11, paymentPct: 0.02, note: "category-dependent commission plus payment fees" },
  manual: { commissionPct: 0.1, paymentPct: 0.02, note: "a guess: adjust the numbers for where you actually sell" },
};

/**
 * Back Market does not charge one rate, so the flat 10% this used to carry was wrong
 * for most of the catalogue: it understated a phone sale by 2 points and an accessory
 * sale by 5 to 25.
 *
 * From the Seller Terms & Conditions schedule effective 2024-08-10, EU/FR: MacBooks and
 * iMacs 10%; laptops and consoles 10% *only* when sold in the UK; smartphones sold in
 * France or Spain 12%; Apple accessories excluding cases 15%; non-Apple accessories and
 * repair kits 20%; cases 25% (non-smartphone and Apple-branded) or 35% (non-Apple
 * smartphone cases); everything else 11%. The commission is charged on the total the
 * buyer pays, tax and shipping included, so a per-item margin keyed only on the item
 * price is still marginally optimistic.
 *
 * Two things this deliberately does not model: the 50 EUR monthly subscription (no
 * per-item margin can express it - it is disclosed in the Marketplaces page instead) and
 * any seller-specific rate, since Back Market's own terms say the commission is "in
 * accordance with the terms agreed upon" with each seller. The product's own `fees`
 * override always wins over this schedule.
 */
export const BACKMARKET_COMMISSION = {
  smartphones: { pct: 0.12, band: "smartphones sold in France or Spain" },
  mac: { pct: 0.1, band: "MacBooks and iMacs" },
  ukLaptopsAndConsoles: { pct: 0.1, band: "laptops and consoles sold in the UK" },
  appleAccessory: { pct: 0.15, band: "Apple accessories excluding cases" },
  accessory: { pct: 0.2, band: "non-Apple accessories and repair kits" },
  other: { pct: 0.11, band: "all other products" },
};

const APPLE_NAME = /\b(apple|macbook|imac|airpods|ipad|iphone|magic keyboard|mac mini|mac studio)\b/;
/** Categories that are plausibly "accessories" in the fee schedule's sense. */
const ACCESSORY_CATEGORIES = new Set(["audio", "wearables", "keyboards"]);

/**
 * Which band a catalogue entry falls in, and the rate that implies. Sector names are
 * matched rather than product names, because the schedule is written per category.
 *
 * @returns {{pct: number, band: string}}
 */
export function backmarketCommissionPct({ category = "other", name = "" } = {}) {
  const cat = String(category || "other").toLowerCase();
  const apple = APPLE_NAME.test(String(name || "").toLowerCase());
  if (cat === "phones" || cat === "smartphones") return BACKMARKET_COMMISSION.smartphones;
  if (cat === "laptops" && apple) return BACKMARKET_COMMISSION.mac;
  if (ACCESSORY_CATEGORIES.has(cat)) {
    return apple ? BACKMARKET_COMMISSION.appleAccessory : BACKMARKET_COMMISSION.accessory;
  }
  return BACKMARKET_COMMISSION.other;
}

/**
 * Sources that sell to the public *and* buy goods outright. A retailer's asking price
 * and its trade-in offer are two different numbers on the same site, and reading one as
 * the other invents money - Back Market's own buyback page quoted "up to 385 EUR" for an
 * iPhone 13 Pro Max while its refurbished asks for the same model started at 432 EUR.
 * A reference from one of these is a ceiling, not a payout.
 */
export const TRADE_IN_SOURCES = new Set(["backmarket", "momox", "easycash", "cashexpress", "cashconverters"]);

/**
 * The reason lines for the trade-in route.
 *
 * A module-level function because the payout is scored on more than one path: it is real
 * information even in a run where the resale side came back empty, which is exactly the
 * run where "what will someone pay me for this?" is the only question left.
 *
 * @param {object|null} payout
 * @param {object} [ctx] { cost, currency, selfSellVerdict }
 * @returns {string[]}
 */
export function payoutReasons(payout, { cost = null, currency = "EUR", selfSellVerdict = null } = {}) {
  if (!payout) return [];
  if (!payout.measured) return [`no trade-in quote was read (${payout.reason}) - unmeasured, not zero`];
  const payoutCurrency = payout.currency || currency;
  const amount = (value) => Number(value).toFixed(2);
  if (!Number.isFinite(payout.profitAbs)) {
    return [
      `${payout.label}: ${amount(payout.gross)} quoted, ${amount(payout.net)} ${payoutCurrency} net after fees ` +
        "- not scored, because there is no acquisition price to compare it to",
    ];
  }
  return [
    `instant trade-in via ${payout.label}: ${amount(payout.gross)} quoted, ` +
      `${amount(payout.net)} ${payoutCurrency} net after ${(payout.commissionPct * 100).toFixed(0)}% commission ` +
      `and ${amount(payout.logistics)} logistics, against a ${amount(cost)} cost = ` +
      `${payout.profitAbs >= 0 ? "+" : ""}${amount(payout.profitAbs)} (${(payout.marginPct * 100).toFixed(1)}%)` +
      (payout.logisticsKnown ? "" : " - logistics for this category is not published, so the net may be optimistic") +
      (payout.verdict === "skip" && selfSellVerdict && selfSellVerdict !== "skip"
        ? ". Only the sell-it-yourself route clears the margin"
        : ""),
    `the trade-in route breaks even at a buy price of ${amount(payout.breakEvenBuyPrice)} ${payoutCurrency}`,
  ];
}

export const DEFAULT_FEES = {
  commissionPct: 0.11,
  paymentPct: 0.02,
  shippingOut: 5, // what it costs you to ship the item to the buyer
  shippingIn: 0, // what the buy side charges you on top of the price
};

/**
 * One resale price from several references.
 *
 * With a single reference this is just its median, exactly as before. With more
 * than one it is deliberately the **cheapest** reference's median: the first offer
 * that sells is the cheapest credible one, so quoting the most flattering platform
 * would invent margin that does not exist. The per-reference numbers are returned
 * too, so the card can show what each marketplace actually said.
 */
export function conservativeResale({ resaleBySource = {}, minSample = 1 } = {}) {
  const entries = Object.entries(resaleBySource)
    .map(([id, prices]) => {
      const clean = (prices || []).filter((p) => Number.isFinite(p) && p > 0);
      return { id, count: clean.length, median: clean.length >= minSample ? median(clean) : null };
    })
    .filter((entry) => entry.median !== null)
    .sort((a, b) => a.median - b.median);
  if (!entries.length) return null;
  return {
    price: entries[0].median,
    source: entries[0].id,
    count: entries[0].count,
    references: entries,
    spread: entries.length > 1 ? entries[entries.length - 1].median - entries[0].median : 0,
  };
}

export const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
export const CONFIDENCE_LABEL = { low: "low", medium: "medium", high: "high" };

/** How cheaply you can realistically acquire the item: a low quantile, not the min. */
export function acquisitionPrice(prices, { quantile: q = 0.15 } = {}) {
  const clean = (prices || []).filter((p) => Number.isFinite(p) && p > 0);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  return quantile(clean, q);
}

/**
 * @param {object} args
 * @param {object} args.product
 * @param {object} [args.fees]   explicit override
 * @param {string} [args.source] **the marketplace the item is actually sold on**, which
 *        is not always the one the catalogue declared: the sell side can be priced by
 *        several references and the cheapest credible one is quoted, so a product
 *        declared as "ebay" can end up quoted against Back Market - and it used to keep
 *        eBay's take-rate while doing so, understating what selling there costs.
 */
export function resolveFees({ product = {}, fees = {}, source = null } = {}) {
  const resolved = source || product.resaleSource || product.sellOn || null;
  const preset = FEE_PRESETS[resolved] || FEE_PRESETS[product.sellOn] || {};
  // Caller-provided fees win, then the product's own nested or flat value, then the
  // preset for wherever the item gets sold, then the defaults.
  const explicit = { ...(product.fees || {}), ...fees };
  const backmarket = resolved === "backmarket" ? backmarketCommissionPct(product) : null;
  return {
    source: resolved,
    commissionPct:
      explicit.commissionPct ??
      product.commissionPct ??
      (backmarket ? backmarket.pct : preset.commissionPct) ??
      DEFAULT_FEES.commissionPct,
    commissionBand: backmarket ? backmarket.band : null,
    note: resolved === "backmarket" && !explicit.commissionPct ? "the published Back Market schedule; your own contract may differ" : preset.note || null,
    paymentPct: explicit.paymentPct ?? product.paymentPct ?? preset.paymentPct ?? DEFAULT_FEES.paymentPct,
    shippingOut: explicit.shippingOut ?? product.shippingOut ?? DEFAULT_FEES.shippingOut,
    shippingIn: explicit.shippingIn ?? product.shippingIn ?? DEFAULT_FEES.shippingIn,
  };
}

/** Keep only the listings that are plausibly the product itself. */
export function plausiblePrices(listings, { min = 0, max = Infinity } = {}) {
  return (listings || [])
    .filter((l) => Number.isFinite(l?.price) && l.price >= min && l.price <= max)
    .map((l) => l.price);
}

export function sampleConfidence({ buySize = 0, resaleSize = 0, manual = false }) {
  if (manual && buySize >= 12) return { level: "high", reason: `acquisition price from ${buySize} listings, resale price entered by hand` };
  if (manual && buySize >= 6) return { level: "medium", reason: `acquisition price from ${buySize} listings, resale price entered by hand` };
  if (buySize >= 12 && resaleSize >= 6) return { level: "high", reason: `${buySize} buy-side and ${resaleSize} resale listings` };
  if (buySize >= 6 && resaleSize >= 3) return { level: "medium", reason: `${buySize} buy-side and ${resaleSize} resale listings` };
  return {
    level: "low",
    reason:
      `thin samples (${buySize} buy-side, ${resaleSize} resale listing(s)): not enough to call this a margin` +
      (manual ? "" : " - widen the keyword, or enter a resale price by hand"),
  };
}

/**
 * Liquidity: can you actually move the item once you own it? A high margin on a
 * product nobody wants is a loss with extra steps. Everything here is evidence the
 * marketplaces already gave us:
 *
 *   - volume      : how many listings the search returns (a deep market = demand)
 *   - favourites  : how many people watch the average listing (attention per item)
 *   - freshness   : how many listings are recent (a market with new supply daily)
 */
export function liquidityScore({ totalEntries = null, listings = [], now = Date.now() } = {}) {
  const reasons = [];
  let score = 0;
  let weight = 0;

  const volume = Number(totalEntries ?? listings.length ?? 0);
  // 200+ listings is a deep market; 10 is a niche.
  const volumeScore = volume <= 0 ? 0 : Math.min(1, Math.log10(volume + 1) / Math.log10(201));
  score += volumeScore * 0.4;
  weight += 0.4;
  reasons.push(`${volume} listing(s) on the buy side`);

  const favs = listings.map((l) => l?.favourites).filter((v) => Number.isFinite(v));
  if (favs.length) {
    const avg = favs.reduce((a, b) => a + b, 0) / favs.length;
    // ~15 watchers per listing is a hot product.
    const favScore = Math.min(1, Math.log10(avg + 1) / Math.log10(16));
    score += favScore * 0.35;
    weight += 0.35;
    reasons.push(`${avg.toFixed(1)} favourites per listing on average`);
  }

  const ages = listings
    .map((l) => (l?.createdAt ? (now - Date.parse(l.createdAt)) / 3600000 : null))
    .filter((v) => v !== null && Number.isFinite(v));
  if (ages.length >= 3) {
    const freshShare = ages.filter((h) => h <= 72).length / ages.length;
    score += Math.min(1, freshShare * 1.5) * 0.25;
    weight += 0.25;
    reasons.push(`${Math.round(freshShare * 100)}% of listings are under 3 days old`);
  }

  return { score: weight ? Math.min(1, score / weight) : 0, reasons };
}

/**
 * One opportunity.
 *
 * @param {object} args
 * @param {object} args.product        a catalogue entry
 * @param {Array}  args.buyListings    listings from the buy side
 * @param {Array}  args.resaleListings listings from the resale side (may be empty)
 * @param {number} [args.manualResalePrice]
 * @param {object} [args.trends]       { score, reasons } from core/trends.js
 * @param {object} [args.payout]       a trade-in quote for this product, as produced by
 *        core/buyback.js - a *payout*, kept separate from the resale ask
 * @param {object} [args.settings]     { opportunityMinMargin }
 */
export function computeOpportunity({
  product,
  buyListings = [],
  resaleListings = [],
  manualResalePrice = null,
  resaleBySource: resaleBySourceArg = null,
  trends = { score: 0, reasons: [] },
  settings = {},
  now = Date.now(),
  payout = null,
  buyErrors = [],
  resaleErrors = [],
} = {}) {
  const reasons = [];
  const band = { min: product.plausibleMinPrice ?? 0, max: product.plausibleMaxPrice ?? Infinity };
  const buyPrices = plausiblePrices(buyListings, band);
  const resalePrices = plausiblePrices(resaleListings, band);

  // Per-reference prices, so several marketplaces can price the sell side at once.
  const resaleBySource = {};
  for (const [id, listings] of Object.entries(resaleBySourceArg || {})) {
    const prices = plausiblePrices(listings, band);
    if (prices.length) resaleBySource[id] = prices;
  }
  const multipleReferences = Object.keys(resaleBySource).length > 1;
  const consensus = multipleReferences ? conservativeResale({ resaleBySource }) : null;

  const buyPrice = acquisitionPrice(buyPrices);
  const manual = Number.isFinite(manualResalePrice) && manualResalePrice > 0;
  const resalePrice = manual
    ? manualResalePrice
    : consensus
      ? consensus.price
      : resalePrices.length
        ? median(resalePrices)
        : null;

  // The source that actually priced this item, not the one the catalogue hoped for.
  const quotedSource = manual ? "manual" : consensus ? consensus.source : product.resaleSource || "ebay";
  const fees = resolveFees({ product, source: quotedSource });
  const confidence = sampleConfidence({ buySize: buyPrices.length, resaleSize: resalePrices.length, manual });
  const resaleSpread = consensus ? consensus.spread : 0;

  const base = {
    id: product.id,
    name: product.name,
    category: product.category || "other",
    keyword: product.keyword || (product.keywords || [])[0] || product.name,
    buyMarket: product.buyMarket || ["vinted"],
    resaleSource: quotedSource,
    // True when the quoted reference is a retailer's asking price rather than money a
    // seller receives. The card and the reasons both say so.
    resaleIsCeiling: TRADE_IN_SOURCES.has(quotedSource),
    payout: payout ? { ...payout } : null,
    resaleReferences: consensus
      ? consensus.references.map((entry) => ({ source: entry.id, median: entry.median, sample: entry.count }))
      : [],
    resaleSpread: Math.round(resaleSpread * 100) / 100,
    manualResalePrice: manual ? manualResalePrice : null,
    // Where a hand-supplied price came from. A number typed in by the user and one
    // imported from an assistant look identical in the arithmetic and are not the same
    // thing in a verdict, so the card can say which it is.
    manualResaleSource: manual ? product.manualResaleSource || "you" : null,
    manualResaleDetail: manual ? product.manualResaleDetail || null : null,
    buyPrice: buyPrice === null ? null : Math.round(buyPrice * 100) / 100,
    resalePrice: resalePrice === null ? null : Math.round(resalePrice * 100) / 100,
    buySample: buyPrices.length,
    resaleSample: manual ? 0 : resalePrices.length,
    currency: buyListings[0]?.currency || product.currency || "EUR",
    fees,
    confidence: confidence.level,
    confidenceReason: confidence.reason,
    buyUrl: cheapestUrl(buyListings, band),
    resaleUrl: product.resaleUrl || null,
    computedAt: new Date(now).toISOString(),
    errors: [...buyErrors, ...resaleErrors],
    liquidity: 0,
    liquidityReasons: [],
    trend: trends.score ?? 0,
    trendReasons: trends.reasons || [],
    reasons,
    score: null,
    profitAbs: null,
    marginPct: null,
    spreadPct: null,
    verdict: "insufficient data",
  };

  const liquidity = liquidityScore({ totalEntries: product.totalEntries ?? null, listings: buyListings, now });
  base.liquidity = Math.round(liquidity.score * 1000) / 1000;
  base.liquidityReasons = liquidity.reasons;

  const minMargin = settings.opportunityMinMargin ?? 0.15;
  const minConfidence = CONFIDENCE_RANK[settings.opportunityMinConfidence ?? "medium"] ?? 1;

  /**
   * Score the payout against a cost, as soon as one exists.
   *
   * Called before the "no resale price" return below on purpose: a resale sample that
   * came back empty says nothing about what a refurbisher pays, so the trade-in route is
   * still a real answer in exactly the run where the arbitrage question could not be.
   */
  const scorePayout = (cost) => {
    if (!base.payout || !base.payout.measured || !Number.isFinite(base.payout.net) || !Number.isFinite(cost)) return;
    const payoutProfit = base.payout.net - cost;
    base.payout.cost = Math.round(cost * 100) / 100;
    base.payout.profitAbs = Math.round(payoutProfit * 100) / 100;
    base.payout.marginPct = cost > 0 ? Math.round((payoutProfit / cost) * 10000) / 10000 : 0;
    // The most the item can cost and still break even on the trade-in route. Useful by
    // itself: it is the number to bid against, and it does not move when asks do.
    base.payout.breakEvenBuyPrice = Math.round((base.payout.net - fees.shippingIn) * 100) / 100;
    base.payout.verdict =
      base.payout.marginPct >= minMargin ? "buy" : base.payout.marginPct >= minMargin / 2 ? "watch" : "skip";
  };

  if (buyPrice === null) {
    reasons.push(
      buyPrices.length === 0
        ? `no acquisition price: the buy-side search returned ${buyListings.length} listing(s) but none inside the price band`
        : "no acquisition price",
    );
    // Nothing to score it against, but the quote is still worth stating.
    reasons.push(...payoutReasons(base.payout, { currency: base.currency }));
    base.reasons = reasons;
    return base;
  }

  const cost = buyPrice + fees.shippingIn;
  scorePayout(cost);

  if (resalePrice === null) {
    reasons.push("no resale price: nothing to compare against (sample the resale side, or enter a price by hand)");
    reasons.push(...payoutReasons(base.payout, { cost, currency: base.currency }));
    base.reasons = reasons;
    return base;
  }

  // --- the arithmetic -------------------------------------------------------
  const netProceeds = resalePrice * (1 - fees.commissionPct) * (1 - fees.paymentPct) - fees.shippingOut;
  const profitAbs = netProceeds - cost;
  const marginPct = cost > 0 ? profitAbs / cost : 0;
  const spreadPct = buyPrice > 0 ? resalePrice / buyPrice - 1 : 0;

  base.profitAbs = Math.round(profitAbs * 100) / 100;
  base.marginPct = Math.round(marginPct * 10000) / 10000;
  base.spreadPct = Math.round(spreadPct * 10000) / 10000;

  // Score: margin first (it is the point), then how easily it moves, then whether
  // anyone actually wants it right now. Confidence scales the whole thing down,
  // because a beautiful margin from four listings is not a beautiful margin.
  const marginScore = Math.max(0, Math.min(1, marginPct / 0.6)); // 60%+ net = full marks
  const raw = marginScore * 0.5 + base.liquidity * 0.2 + (base.trend || 0) * 0.3;
  const scale = { low: 0.45, medium: 0.8, high: 1 }[confidence.level] ?? 0.45;
  base.score = Math.round(raw * scale * 1000) / 1000;

  reasons.push(
    `buy at ~${base.buyPrice.toFixed(2)} ${base.currency} (${buyPrices.length} listing(s), 15th percentile), ` +
      `sell at ~${resalePrice.toFixed(2)} (${manual ? "entered by hand" : `${resalePrices.length} resale listing(s), median`})`,
  );
  if (consensus) {
    reasons.push(
      "resale references: " +
        consensus.references
          .map((entry) => `${entry.id} ${entry.median.toFixed(2)} (${entry.count})`)
          .join(" · ") +
        ` - the cheapest credible one is quoted, so a spread of ${consensus.spread.toFixed(2)} ${base.currency} ` +
        "between platforms does not become profit on paper",
    );
  }
  reasons.push(
    `after ${(fees.commissionPct * 100).toFixed(0)}% commission, ${(fees.paymentPct * 100).toFixed(0)}% payment fees and ` +
      `${fees.shippingOut.toFixed(2)} shipping: net ${netProceeds.toFixed(2)} on ${cost.toFixed(2)} cost ` +
      `= ${profitAbs >= 0 ? "+" : ""}${profitAbs.toFixed(2)} ${base.currency} (${(marginPct * 100).toFixed(1)}%)`,
  );
  reasons.push(`spread ${(spreadPct * 100).toFixed(1)}% · demand ${(base.liquidity * 100).toFixed(0)}/100 · trend ${(base.trend * 100).toFixed(0)}/100`);
  if (base.trendReasons.length) reasons.push(...base.trendReasons.slice(0, 2));

  const verdict =
    confidence.level === "low" || CONFIDENCE_RANK[confidence.level] < minConfidence
      ? "insufficient data"
      : marginPct >= minMargin
        ? "buy"
        : marginPct >= minMargin / 2
          ? "watch"
          : "skip";
  base.verdict = verdict;
  if (verdict === "insufficient data") reasons.push(`confidence ${confidence.level} is below the required ${CONFIDENCE_LABEL[settings.opportunityMinConfidence ?? "medium"]}`);
  if (verdict === "skip") reasons.push(`net margin ${(marginPct * 100).toFixed(1)}% is below ${(minMargin * 100).toFixed(0)}% after fees`);

  // What the quoted reference is *not*. A retailer that both sells and buys is the case
  // that goes wrong: its asking price reads like an offer for your item, and it is not.
  if (base.resaleIsCeiling) {
    reasons.push(
      `${base.resaleSource} is an asking price, not a payout: that is what a buyer is charged, ` +
        `before the ${(fees.commissionPct * 100).toFixed(0)}% commission it keeps` +
        ` (${fees.commissionBand || "published schedule"})` +
        (base.payout?.measured ? "; what it actually pays is the trade-in line below" : "; its own buy-back offer is the number to look for"),
    );
  }
  reasons.push(...payoutReasons(base.payout, { cost, currency: base.currency, selfSellVerdict: verdict }));
  base.reasons = reasons;
  return base;
}

/** The cheapest plausible buy-side listing, so the card can link somewhere useful. */
export function cheapestUrl(listings, { min = 0, max = Infinity } = {}) {
  const candidates = (listings || [])
    .filter((l) => Number.isFinite(l?.price) && l.price >= min && l.price <= max)
    .sort((a, b) => a.price - b.price);
  return candidates[0]?.url || null;
}

/** Rank opportunities: verdict first, then score, then margin. */
export function rankOpportunities(opportunities, { onlyActionable = false } = {}) {
  const order = { buy: 0, watch: 1, skip: 2, "insufficient data": 3 };
  return [...(opportunities || [])]
    .filter((o) => (onlyActionable ? o.verdict === "buy" : true))
    .sort(
      (a, b) =>
        (order[a.verdict] ?? 4) - (order[b.verdict] ?? 4) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        (b.marginPct ?? -1) - (a.marginPct ?? -1),
    );
}

/** Headline counts for the run summary and the History page. */
export function opportunityVerdicts(opportunities) {
  const counts = { buy: 0, watch: 0, skip: 0, "insufficient data": 0 };
  for (const item of opportunities || []) counts[item.verdict] = (counts[item.verdict] || 0) + 1;
  return counts;
}
