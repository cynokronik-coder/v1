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
  backmarket: { commissionPct: 0.1, paymentPct: 0.02, note: "marketplace commission plus payment fees" },
  manual: { commissionPct: 0.1, paymentPct: 0.02, note: "a guess: adjust the numbers for where you actually sell" },
};

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

export function resolveFees({ product = {}, fees = {} } = {}) {
  const preset = FEE_PRESETS[product.resaleSource] || FEE_PRESETS[product.sellOn] || {};
  // Caller-provided fees win, then the product's own nested or flat value, then the
  // preset for wherever the item gets sold, then the defaults.
  const explicit = { ...(product.fees || {}), ...fees };
  return {
    commissionPct: explicit.commissionPct ?? product.commissionPct ?? preset.commissionPct ?? DEFAULT_FEES.commissionPct,
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

  const fees = resolveFees({ product });
  const confidence = sampleConfidence({ buySize: buyPrices.length, resaleSize: resalePrices.length, manual });
  const resaleSpread = consensus ? consensus.spread : 0;

  const base = {
    id: product.id,
    name: product.name,
    category: product.category || "other",
    keyword: product.keyword || (product.keywords || [])[0] || product.name,
    buyMarket: product.buyMarket || ["vinted"],
    resaleSource: manual ? "manual" : consensus ? consensus.source : product.resaleSource || "ebay",
    resaleReferences: consensus
      ? consensus.references.map((entry) => ({ source: entry.id, median: entry.median, sample: entry.count }))
      : [],
    resaleSpread: Math.round(resaleSpread * 100) / 100,
    manualResalePrice: manual ? manualResalePrice : null,
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

  if (buyPrice === null) {
    reasons.push(
      buyPrices.length === 0
        ? `no acquisition price: the buy-side search returned ${buyListings.length} listing(s) but none inside the price band`
        : "no acquisition price",
    );
    base.reasons = reasons;
    return base;
  }
  if (resalePrice === null) {
    reasons.push("no resale price: nothing to compare against (sample the resale side, or enter a price by hand)");
    base.reasons = reasons;
    return base;
  }

  // --- the arithmetic -------------------------------------------------------
  const netProceeds = resalePrice * (1 - fees.commissionPct) * (1 - fees.paymentPct) - fees.shippingOut;
  const cost = buyPrice + fees.shippingIn;
  const profitAbs = netProceeds - cost;
  const marginPct = cost > 0 ? profitAbs / cost : 0;
  const spreadPct = buyPrice > 0 ? resalePrice / buyPrice - 1 : 0;

  base.profitAbs = Math.round(profitAbs * 100) / 100;
  base.marginPct = Math.round(marginPct * 10000) / 10000;
  base.spreadPct = Math.round(spreadPct * 10000) / 10000;

  const minMargin = settings.opportunityMinMargin ?? 0.15;
  const minConfidence = CONFIDENCE_RANK[settings.opportunityMinConfidence ?? "medium"] ?? 1;

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
