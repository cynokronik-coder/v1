/**
 * One scan pass over one watch: fetch -> estimate the market price -> score.
 *
 * Mirrors the Python pipeline, including the two things that turned out to matter
 * in practice:
 *
 *  * The baseline is cached (`compsTtlSeconds`) so a 15-minute loop makes 1 request
 *    per watch per pass instead of 4.
 *  * One hostile marketplace must not take the others down: a blocked or failing
 *    watch becomes a report with an `error`, and the scan moves on.
 */

import { CREDENTIALED_MARKETPLACES, UNOFFICIAL_MARKETPLACES, slimListing } from "./models.js";
import { sourceEnabled } from "./sources.js";
import {
  buildStats,
  explainNoDeals,
  filterComparables,
  findDeals,
  phraseRejections,
} from "./analyzer.js";
import { MarketplaceBlocked, MarketplaceError, ORDER } from "./adapters/base.js";

export const DEFAULT_PER_PAGE = 96;

export function makeQuery(watch, { page = 1, perPage = DEFAULT_PER_PAGE, order = ORDER.RELEVANCE } = {}) {
  return {
    searchText: watch.searchText,
    filters: watch.filters || {},
    minPrice: null,
    maxPrice: null,
    page,
    perPage,
    order,
    currency: null,
  };
}

/** Why a watch is not being scanned at all (as opposed to failing). */
export function skipReason(watch, settings) {
  if (!watch.enabled) return "disabled";
  if (!sourceEnabled(watch.marketplace, settings)) {
    return "switched off in the Sources page";
  }
  if (UNOFFICIAL_MARKETPLACES[watch.marketplace] && !watch.acknowledgeTerms && !settings?.acknowledgeAll) {
    return "not acknowledged: read the terms note and set acknowledgeTerms on this watch";
  }
  if (CREDENTIALED_MARKETPLACES[watch.marketplace] && !settings?.credentials?.[watch.marketplace]) {
    return `${watch.marketplace} needs credentials before it can be scanned: ${CREDENTIALED_MARKETPLACES[watch.marketplace]}`;
  }
  return null;
}

function dedupe(listings) {
  const seen = new Map();
  for (const listing of listings) {
    const key = `${listing.marketplace}:${listing.itemId}`;
    if (!seen.has(key)) seen.set(key, listing);
  }
  return [...seen.values()];
}

/** Estimate the market price of a watch's product (cached for compsTtlSeconds). */
export async function buildBaseline({ watch, adapter, store, settings, force = false, logger = () => {} }) {
  const notes = [];
  let requestsMade = 0;

  if (!force) {
    const cached = store.getBaseline(watch.name, watch.compsTtlSeconds);
    if (cached) {
      return {
        stats: cached.stats,
        comparables: cached.comparables,
        notes: [`baseline reused from cache (${cached.stats.usedSize} comparables)`],
        requestsMade: 0,
      };
    }
  }

  const pool = [];
  for (let page = 1; page <= Math.max(1, watch.samplePages); page += 1) {
    const result = await adapter.search(makeQuery(watch, { page, perPage: settings?.perPage || DEFAULT_PER_PAGE }));
    pool.push(...result.items);
    requestsMade += 1;
  }

  let comparables = filterComparables(pool, watch);
  const droppedByPhrase = phraseRejections(pool, watch);
  if (droppedByPhrase) {
    notes.push(
      `exact phrase "${watch.searchText}" removed ${droppedByPhrase} of ${pool.length} listing(s) whose title/description did not contain it`,
    );
  }
  if (comparables.length === 0) {
    notes.push(
      `no comparable listings for '${watch.searchText}' (${pool.length} listings fetched, all filtered out)`,
    );
    return { stats: null, comparables: [], notes, requestsMade };
  }

  // Never mix currencies in one baseline (the marketplace geo decides the currency).
  const counts = new Map();
  for (const c of comparables) counts.set(c.currency, (counts.get(c.currency) || 0) + 1);
  const [currency, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (counts.size > 1) {
    const others = Object.fromEntries([...counts.entries()].filter(([c]) => c !== currency));
    notes.push(`ignored listings in other currencies: ${JSON.stringify(others)}`);
    comparables = comparables.filter((c) => c.currency === currency);
  }

  if (comparables.length < watch.minSampleSize) {
    notes.push(
      `only ${comparables.length} comparables in ${currency} ` +
        `(minSampleSize=${watch.minSampleSize}) - no verdict this pass`,
    );
  }

  const stats = buildStats(comparables.map((c) => c.price), currency);
  await store.saveBaseline(watch.name, stats, comparables.map(slimListing));
  logger(`${watch.name}: baseline ${stats.median.toFixed(2)} ${currency} from ${stats.usedSize} comparables`);
  return { stats, comparables, notes, requestsMade };
}

export async function scanWatch({
  watch,
  adapter,
  store,
  settings = {},
  forceBaseline = false,
  logger = () => {},
  now = () => new Date().toISOString(),
}) {
  const startedAt = now();
  const report = {
    watch: watch.name,
    marketplace: watch.marketplace,
    stats: null,
    comparables: [],
    candidates: [],
    deals: [],
    newDeals: [],
    requestsMade: 0,
    notes: [],
    errors: [],
    error: null,
    startedAt,
    finishedAt: null,
  };

  const reason = skipReason(watch, settings);
  if (reason) {
    report.notes.push(`skipped: ${reason}`);
    report.finishedAt = now();
    return report;
  }

  try {
    const baseline = await buildBaseline({ watch, adapter, store, settings, force: forceBaseline, logger });
    report.stats = baseline.stats;
    report.comparables = baseline.comparables;
    report.notes.push(...baseline.notes);
    report.requestsMade += baseline.requestsMade;

    const fresh = await adapter.search(makeQuery(watch, { page: 1, perPage: settings?.perPage || DEFAULT_PER_PAGE, order: ORDER.NEWEST }));
    report.requestsMade += 1;
    report.candidates = dedupe([...baseline.comparables, ...fresh.items]);

    // A price is only comparable inside one currency. The baseline already keeps a
    // single currency, but the freshness page is unfiltered, so a listing priced in
    // another currency used to be scored against this median - which is how a GBP
    // item can look "40% under" a EUR market. Drop them, and say so.
    if (report.stats?.currency) {
      const foreign = report.candidates.filter((c) => c.currency !== report.stats.currency);
      if (foreign.length) {
        report.notes.push(
          `ignored ${foreign.length} listing(s) priced in another currency ` +
            `(${[...new Set(foreign.map((f) => f.currency))].join(", ")})`,
        );
        report.candidates = report.candidates.filter((c) => c.currency === report.stats.currency);
      }
    }

    const deals = findDeals(report.candidates, report.stats, watch);
    report.deals = deals;
    if (deals.length === 0) {
      report.notes.push(...explainNoDeals(report.candidates, report.stats, watch));
    }

    for (const deal of deals) {
      await store.noteListing(deal.listing, watch.name);
      const isNew = await store.markAlert(deal);
      if (isNew) report.newDeals.push(deal);
    }
  } catch (err) {
    const message = err?.message || String(err);
    report.error = err instanceof MarketplaceBlocked ? "blocked" : "failed";
    report.errors.push(message);
    report.notes.push(`${report.error}: ${message}`);
    logger(`${watch.name}: ${message}`);
  }

  report.finishedAt = now();
  return report;
}

/**
 * Every enabled watch, sequentially. `adapterFactory(watch)` returns an adapter;
 * tests inject their own, the service worker passes `getAdapter`.
 */
export async function scanAll({
  watches,
  store,
  adapterFactory,
  settings = {},
  forceBaseline = false,
  logger = () => {},
  onReport = null,
}) {
  const reports = [];
  for (const watch of watches) {
    const adapter = skipReason(watch, settings) ? null : adapterFactory(watch);
    const report = await scanWatch({
      watch,
      adapter,
      store,
      settings,
      forceBaseline,
      logger,
    });
    reports.push(report);
    await store.recordRun(watch.name, {
      at: report.finishedAt,
      at_ms: Date.parse(report.finishedAt),
      marketPrice: report.stats?.median ?? null,
      currency: report.stats?.currency ?? null,
      comparables: report.stats?.usedSize ?? 0,
      deals: report.deals.length,
      newDeals: report.newDeals.length,
      requests: report.requestsMade,
      error: report.error,
      message: report.errors[0] || null,
      notes: report.notes.slice(0, 4),
    });
    if (report.errors.length) await store.appendLog({ level: "error", watch: watch.name, message: report.errors[0] });
    if (onReport) await onReport(report);
  }
  return reports;
}

export function summarize(reports) {
  return {
    watches: reports.length,
    requests: reports.reduce((sum, r) => sum + r.requestsMade, 0),
    deals: reports.reduce((sum, r) => sum + r.deals.length, 0),
    newDeals: reports.reduce((sum, r) => sum + r.newDeals.length, 0),
    errors: reports.filter((r) => r.error).map((r) => `${r.watch}: ${r.errors[0] || r.error}`),
  };
}

export { MarketplaceError };
