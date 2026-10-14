/**
 * Selectors for the Opportunities and History pages.
 *
 * Same rule as format.js: the parts that can be quietly wrong - which rows a filter
 * keeps, what a sparkline draws, how a margin is phrased - are plain functions with
 * tests, and the dashboard only wires them to the DOM.
 */

import { money, percent, relativeTime } from "./format.js";

export const VERDICT_LABELS = {
  buy: "buy",
  watch: "worth watching",
  skip: "skip",
  "insufficient data": "not enough data",
};

export function verdictLabel(verdict) {
  return VERDICT_LABELS[verdict] || String(verdict || "unknown");
}

/** "buy 180.00 EUR → sell 320.00 EUR · +33.7% after fees" */
export function opportunityHeadline(opportunity) {
  const currency = opportunity.currency || "EUR";
  if (opportunity.buyPrice === null || opportunity.resalePrice === null) {
    return opportunity.buyPrice === null ? "no acquisition price yet" : "no resale price yet";
  }
  const margin =
    opportunity.marginPct === null || opportunity.marginPct === undefined
      ? "—"
      : `${opportunity.marginPct >= 0 ? "+" : ""}${(opportunity.marginPct * 100).toFixed(1)}%`;
  return (
    `buy ${money(opportunity.buyPrice, currency)} → sell ${money(opportunity.resalePrice, currency)} ` +
    `· ${margin} after fees (${opportunity.profitAbs >= 0 ? "+" : ""}${money(opportunity.profitAbs, currency)})`
  );
}

/** How confident, and on what evidence. */
export function confidenceLine(opportunity) {
  return `${opportunity.confidence || "low"} confidence · ${opportunity.confidenceReason || "no sample"}`;
}

/** The score, out of 100, plus the three inputs that produced it. */
export function scoreLine(opportunity) {
  const liquidity = Math.round((opportunity.liquidity ?? 0) * 100);
  const trend = Math.round((opportunity.trend ?? 0) * 100);
  const score = opportunity.score === null || opportunity.score === undefined ? "—" : Math.round(opportunity.score * 100);
  return `score ${score}/100 · demand ${liquidity}/100 · trend ${trend}/100`;
}

export const OPPORTUNITY_SORTS = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
  margin: (a, b) => (b.marginPct ?? -9) - (a.marginPct ?? -9),
  profit: (a, b) => (b.profitAbs ?? -1e9) - (a.profitAbs ?? -1e9),
  demand: (a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0),
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
};

/**
 * Filter + sort the scored opportunities. `verdict` of "" means every verdict,
 * which is the default on purpose: hiding the "skip" rows makes it impossible to
 * see that the engine ran and simply did not find a margin.
 */
export function visibleOpportunities(opportunities, query = {}) {
  const { verdict = "", category = "", text = "", sort = "score", actionableOnly = false } = query;
  const needle = String(text || "").trim().toLowerCase();
  const filtered = (opportunities || []).filter((item) => {
    if (verdict && item.verdict !== verdict) return false;
    if (actionableOnly && item.verdict !== "buy") return false;
    if (category && item.category !== category) return false;
    if (needle) {
      const haystack = `${item.name} ${item.keyword} ${item.category} ${item.buyMarket?.join(" ") || ""} ${item.reasons?.join(" ") || ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  return filtered.sort(OPPORTUNITY_SORTS[sort] || OPPORTUNITY_SORTS.score);
}

export function opportunityCategories(opportunities) {
  return [...new Set((opportunities || []).map((item) => item.category).filter(Boolean))].sort();
}

/**
 * History rows, newest first. Kinds: "watch" (one scan pass) and "opportunities"
 * (one catalogue run).
 */
export function historyRows(history, query = {}) {
  const { kind = "", watch = "", text = "", limit = 0 } = query;
  const needle = String(text || "").trim().toLowerCase();
  const rows = (history || []).filter((row) => {
    if (kind && row.kind !== kind) return false;
    if (watch && row.watch !== watch) return false;
    if (needle) {
      const haystack = `${row.watch || ""} ${row.marketplace || row.kind} ${row.message || ""} ${row.error || ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** One line per history row, whatever kind it is. */
export function historySummary(row) {
  if (row.kind === "opportunities") {
    return `${row.products ?? 0} product(s) measured · ${row.deals ?? 0} to buy · ${row.requests ?? 0} request(s)`;
  }
  const market = row.marketPrice === null || row.marketPrice === undefined ? "no verdict" : money(row.marketPrice, row.currency || "EUR");
  return `${market} from ${row.comparables ?? 0} comparable(s) · ${row.deals ?? 0} deal(s) (${row.newDeals ?? 0} new)`;
}

export function historyWhen(row, now = Date.now()) {
  return relativeTime(row.at, now);
}

/**
 * A price history for one watch, oldest to newest: exactly what the stored history
 * rows give us, so the sparkline never invents a point.
 */
export function priceSeries(history, watch) {
  return (history || [])
    .filter((row) => row.kind === "watch" && row.watch === watch && Number.isFinite(row.marketPrice))
    .slice(0, 60)
    .reverse();
}

/**
 * An SVG polyline for the price series. Returns "" when there is nothing to draw,
 * so the dashboard can show "not enough scans yet" instead of a misleading line.
 */
export function sparklinePath(series, { width = 220, height = 44, pad = 3 } = {}) {
  const values = (series || []).map((point) => point.marketPrice).filter((v) => Number.isFinite(v));
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = pad + index * step;
      const y = pad + (1 - (value - min) / span) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Deals the user starred, newest first. */
export function favouriteDeals(alerts) {
  return (alerts || [])
    .filter((alert) => alert.favourite)
    .sort((a, b) => Date.parse(b.favouriteChangedAt || b.firstSeen) - Date.parse(a.favouriteChangedAt || a.firstSeen));
}

/** Counts for the page navigation badges. */
export function pageCounts({ alerts = [], opportunities = [] } = {}) {
  return {
    deals: alerts.filter((alert) => alert.status === "new").length,
    favourites: alerts.filter((alert) => alert.favourite).length,
    opportunities: opportunities.filter((item) => item.verdict === "buy").length,
  };
}

/** "12 min ago" for the opportunities panel header. */
export function lastRunLine(opportunityRuns, now = Date.now()) {
  const last = (opportunityRuns || [])[0];
  if (!last) return "never run";
  return `last run ${relativeTime(last.at, now)} · ${last.products ?? 0} product(s), ${last.requests ?? 0} request(s)`;
}

export { percent };
