/**
 * One opportunities run: for every catalogue entry, sample the buy side, sample the
 * resale side, read the trend signals, and score the difference.
 *
 * Same discipline as core/scan.js:
 *
 *  * sequential, paced requests - never a burst, never parallel workers;
 *  * a marketplace that refuses or an API without credentials is a *note on that
 *    product*, not a failed run: the rest of the catalogue still gets measured;
 *  * everything that was measured is reported, including what was missing, so a
 *    "no opportunities" answer is a real answer rather than a silent failure.
 *
 * The adapters and the trend fetch are injected, which is why the whole thing is
 * testable in node with no network (tests/opportunity-scan.test.js).
 */

import { MarketplaceBlocked, MarketplaceError, ORDER } from "./adapters/base.js";
import { UNOFFICIAL_MARKETPLACES } from "./models.js";
import { buybackUrl, payoutFromQuote, unmeasuredPayout } from "./buyback.js";
import { sourceConfig, sourceEnabled } from "./sources.js";
import {
  computeOpportunity,
  opportunityVerdicts,
  rankOpportunities,
} from "./opportunity.js";
import { gdeltUrl, parseGdelt, parsePageviews, scoreTrends, socialMatch, wikipediaUrl } from "./trends.js";

export const DEFAULT_PER_PAGE = 40;
export const DEFAULT_MAX_REQUESTS = 150;

function short(err) {
  return `${err?.name || "Error"}: ${err?.message || String(err)}`.slice(0, 300);
}

/** One search, normalised: always returns listings plus the notes about what failed. */
async function searchSide({
  side,
  marketplace,
  keyword,
  perPage,
  product,
  adapterFactory,
  settings,
  logger,
  notes,
}) {
  const label = `${product.name} [${side}/${marketplace}]`;
  if (!sourceAllowed({ label, marketplace, product, settings, notes })) {
    return { items: [], totalEntries: null, requests: 0, ok: false };
  }
  try {
    const adapter = adapterFactory({ marketplace, product, settings });
    if (adapter?.configured === false) {
      notes.push(`${label}: ${adapter.name || marketplace} needs credentials before it can be used`);
      return { items: [], totalEntries: null, requests: 0, ok: false, needsCredentials: true };
    }
    const result = await adapter.search({
      searchText: keyword,
      filters: product.filters || {},
      minPrice: product.plausibleMinPrice ?? null,
      maxPrice: product.plausibleMaxPrice ?? null,
      page: 1,
      perPage,
      order: ORDER.RELEVANCE,
      currency: null,
    });
    return { items: result.items || [], totalEntries: result.totalEntries ?? null, requests: adapter.requestsMade ?? 1, ok: true };
  } catch (err) {
    const blocked = err instanceof MarketplaceBlocked;
    const message = `${label}: ${short(err)}`;
    logger(message);
    notes.push(blocked ? `${message} - open ${marketplace} in a tab and try again` : message);
    return { items: [], totalEntries: null, requests: 0, ok: false, blocked };
  }
}

async function trendForProduct({ product, settings, trendFetch, notes }) {
  const sources = settings.trendSources || {};
  const errors = [];
  let wikipedia = null;
  let news = null;

  if (trendFetch && sources.wikipedia && product.wikipedia) {
    const url = wikipediaUrl({ article: product.wikipedia, days: 60 });
    try {
      const response = await trendFetch(url);
      if (response?.status === 200) wikipedia = parsePageviews(JSON.parse(response.body));
      else errors.push(`public interest unavailable (HTTP ${response?.status ?? "?"} for ${product.wikipedia})`);
    } catch (err) {
      errors.push(`public interest unavailable (${short(err)})`);
    }
  }

  if (trendFetch && sources.gdelt) {
    const url = gdeltUrl({ query: product.keyword });
    try {
      const response = await trendFetch(url);
      if (response?.status === 200) news = parseGdelt(JSON.parse(response.body));
      else errors.push(`news attention unavailable (HTTP ${response?.status ?? "?"})`);
    } catch (err) {
      errors.push(`news attention unavailable (${short(err)})`);
    }
  }

  const social = socialMatch({ product, hotKeywords: settings.socialKeywords || [] });
  const scored = scoreTrends({ wikipedia, news, social, errors });
  if (!scored.measured) for (const error of errors) notes.push(`${product.name}: ${error}`);
  return scored;
}

/**
 * The two reasons a source is not sampled: it is switched off, or its terms are not
 * acknowledged. Shared by the search sides and the payout path, so a trade-in request
 * is bound by exactly the same rules as a search rather than by a second copy of them.
 */
function sourceAllowed({ label, marketplace, product, settings, notes }) {
  if (!sourceEnabled(marketplace, settings)) {
    notes.push(`${label}: skipped - switched off in the Marketplaces page`);
    return false;
  }
  const acknowledged =
    settings.acknowledgeAll || product.acknowledgeTerms || sourceConfig(marketplace, settings).acknowledgeTerms === true;
  if (UNOFFICIAL_MARKETPLACES[marketplace] && !acknowledged) {
    notes.push(`${label}: skipped - its terms are not acknowledged for this product`);
    return false;
  }
  return true;
}

/**
 * What Back Market would *pay* for one of these, as opposed to what it charges for one.
 *
 * One extra paced request, only for a product whose declared resale references include
 * Back Market - it is a sell channel for the products the catalogue says trade there,
 * not a question worth asking about a bicycle. A failure here is a note, never a failed
 * run, and a missing quote is reported as unmeasured rather than as zero.
 */
async function payoutSide({ product, adapterFactory, settings, notes }) {
  const label = `${product.name} [payout/backmarket]`;
  const url = buybackUrl({
    category: product.category,
    slug: product.name,
    domain: settings.backmarketDomain || undefined,
  }).url;
  const fallback = unmeasuredPayout({ category: product.category, keyword: product.keyword, url });
  if (!sourceAllowed({ label, marketplace: "backmarket", product, settings, notes })) {
    return { payout: null, requests: 0 };
  }
  try {
    const adapter = adapterFactory({ marketplace: "backmarket", product, settings });
    if (typeof adapter?.quote !== "function") {
      notes.push(`${label}: this adapter cannot read a trade-in quote`);
      return { payout: fallback, requests: 0 };
    }
    const result = await adapter.quote({ product, keyword: product.keyword });
    const requests = adapter.requestsMade ?? 1;
    if (result?.quote?.amount) {
      return {
        payout: payoutFromQuote(result.quote, { category: product.category, productName: product.name }),
        requests,
      };
    }
    notes.push(`${label}: ${result?.reason || "no quote read"}`);
    return { payout: { ...fallback, url: result?.url || url }, requests };
  } catch (err) {
    notes.push(`${label}: ${short(err)}`);
    return { payout: fallback, requests: adapterRequests(err) };
  }
}

/** An adapter that threw still made the request it threw on. */
function adapterRequests(err) {
  return Number.isFinite(err?.requestsMade) ? err.requestsMade : 1;
}

/**
 * Where the sell side gets priced. `resaleSources` is the multi-reference form;
 * `resaleSource` is the single one the product has always had, and `manual` means
 * the user read a price somewhere and typed it in.
 */
export function resaleSourcesFor(product = {}) {
  const list = [...(product.resaleSources || []), product.resaleSource].filter(Boolean).map(String);
  return [...new Set(list)].filter((id) => id !== "manual");
}

/**
 * @param {object} args
 * @param {Array}  args.catalog
 * @param {object} args.settings
 * @param {(args: {marketplace: string, product: object, settings: object}) => object} args.adapterFactory
 * @param {((url: string) => Promise<{status: number, body: string}>)|null} [args.trendFetch]
 * @param {((product: object) => Promise<Array>)|null} [args.providerResale]  extra resale
 *        reference from a data provider (Google Shopping via SerpApi, typically)
 * @param {((product: object) => Promise<{score: number, reasons: string[]}>|null)|null} [args.providerTrend]
 */
export async function runOpportunityScan({
  catalog = [],
  settings = {},
  adapterFactory,
  trendFetch = null,
  providerResale = null,
  providerTrend = null,
  logger = () => {},
  now = () => Date.now(),
  startedAt = null,
} = {}) {
  const started = startedAt ?? now();
  const perPage = settings.opportunityPerPage ?? DEFAULT_PER_PAGE;
  const maxProducts = settings.opportunityMaxProducts ?? 12;
  const maxRequests = settings.opportunityMaxRequests ?? DEFAULT_MAX_REQUESTS;
  const enabled = catalog.filter((item) => item.enabled !== false);
  const selected = enabled.slice(0, maxProducts);

  const notes = [];
  const opportunities = [];
  let requests = 0;
  let stoppedEarly = false;

  for (const product of selected) {
    if (requests >= maxRequests) {
      stoppedEarly = true;
      notes.push(
        `stopped after ${requests} request(s): the per-run budget (opportunityMaxRequests=${maxRequests}) is there to keep this a polite, personal-scale tool`,
      );
      break;
    }

    const buyListings = [];
    const buyErrors = [];
    let totalEntries = null;

    for (const marketplace of product.buyMarket || []) {
      const result = await searchSide({
        side: "buy",
        marketplace,
        keyword: product.keyword,
        perPage,
        product,
        adapterFactory,
        settings,
        logger,
        notes,
      });
      requests += result.requests;
      buyListings.push(...result.items);
      if (result.totalEntries !== null && totalEntries === null) totalEntries = result.totalEntries;
      if (!result.ok) buyErrors.push(`${marketplace}: unavailable`);
    }

    const resaleListings = [];
    const resaleErrors = [];
    const resaleBySource = {};
    if (!product.manualResalePrice && product.resaleSource !== "manual") {
      for (const marketplace of resaleSourcesFor(product)) {
        const result = await searchSide({
          side: "resale",
          marketplace,
          keyword: product.keyword,
          perPage,
          product,
          adapterFactory,
          settings,
          logger,
          notes,
        });
        requests += result.requests;
        resaleListings.push(...result.items);
        if (result.items.length) resaleBySource[marketplace] = result.items;
        if (!result.ok) resaleErrors.push(`${marketplace}: unavailable`);
      }

      // A data provider can price the sell side too, when the user brought a key
      // and asked for it. Its results are labelled with the provider's own name so
      // they are never mistaken for a marketplace quote.
      if (providerResale) {
        try {
          const items = (await providerResale(product)) || [];
          requests += 1;
          if (items.length) resaleBySource["google-shopping"] = items;
          resaleListings.push(...items);
        } catch (err) {
          notes.push(`${product.name} [resale/google-shopping]: ${short(err)}`);
          resaleErrors.push("google-shopping: unavailable");
        }
      }
    }

    // Asked outside the `manualResalePrice` branch on purpose: a price you typed in for
    // the sell-it-yourself route says nothing about what a refurbisher pays.
    let payout = null;
    if (settings.opportunityTradeIn !== false && resaleSourcesFor(product).includes("backmarket")) {
      const result = await payoutSide({ product, adapterFactory, settings, notes });
      requests += result.requests;
      payout = result.payout;
    }

    const trends = await trendForProduct({ product, settings, trendFetch, notes });
    if (providerTrend) {
      try {
        const extra = await providerTrend(product);
        requests += 1;
        if (extra && Number.isFinite(extra.score)) {
          trends.score = Math.round((trends.score * 0.6 + extra.score * 0.4) * 1000) / 1000;
          trends.reasons = [...(trends.reasons || []), ...(extra.reasons || [])];
          trends.measured = true;
        }
      } catch (err) {
        notes.push(`${product.name} [trends/google-trends]: ${short(err)}`);
      }
    }

    opportunities.push(
      computeOpportunity({
        product: { ...product, totalEntries },
        buyListings,
        resaleListings,
        resaleBySource,
        manualResalePrice: product.manualResalePrice,
        payout,
        trends,
        settings,
        now: now(),
        buyErrors,
        resaleErrors,
      }),
    );
  }

  const ranked = rankOpportunities(opportunities);
  const verdicts = opportunityVerdicts(ranked);
  const summary = {
    at: new Date(started).toISOString(),
    products: ranked.length,
    catalogSize: enabled.length,
    skippedByCap: Math.max(0, enabled.length - selected.length),
    verdicts,
    requests,
    stoppedEarly,
    durationMs: now() - started,
    errors: notes,
  };
  return { opportunities: ranked, summary, notes };
}

export function summarizeOpportunities(opportunities) {
  const ranked = rankOpportunities(opportunities);
  return {
    products: ranked.length,
    actionable: ranked.filter((o) => o.verdict === "buy").length,
    best: ranked.find((o) => o.verdict === "buy") || null,
    verdicts: opportunityVerdicts(ranked),
  };
}

export { MarketplaceBlocked, MarketplaceError };
