/**
 * Selectors for the Opportunities and History pages.
 *
 * Same rule as format.js: the parts that can be quietly wrong - which rows a filter
 * keeps, what a sparkline draws, how a margin is phrased - are plain functions with
 * tests, and the dashboard only wires them to the DOM.
 */

import { marketplaceLabel, money, percent, relativeTime } from "./format.js";
import { TRADE_IN_SOURCES } from "../core/opportunity.js";

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

/**
 * What the resale figure on a card actually is, and where it came from.
 *
 * This exists because the card used to show nothing at all in the common case: the
 * engine's `resaleReferences` list is only filled when a product is priced against
 * *several* resale sources (the consensus path), so a product with the usual single
 * reference had no reference line and no working reference button - it looked like
 * the feature did not exist. Every branch here returns something to show, including
 * the honest "none measured yet".
 *
 * One more thing it has to do, now that the Back Market reference is read properly: say
 * when a number is an **asking price** rather than a payout. A retailer that both sells
 * and buys - Back Market, momox, the cash-for-goods chains - publishes two prices on the
 * same model, and the higher one is the one that shows up in a search. Reading it as
 * "what I will get for mine" is the mistake, so the commission that comes out of it is
 * named on the card.
 *
 * @returns {{measured: boolean, isAsk?: boolean, value: string, detail: string}}
 */
export function resaleReference(opportunity = {}) {
  const currency = opportunity.currency || "EUR";
  const references = opportunity.resaleReferences || [];
  if (references.length) {
    const value = references.map((entry) => `${sourceName(entry.source)} ${money(entry.median, currency)}`).join(" · ");
    const sizes = references
      .filter((entry) => Number.isFinite(entry.sample))
      .map((entry) => `${sourceName(entry.source)}: ${entry.sample} listing(s)`);
    const asks = references.filter((entry) => TRADE_IN_SOURCES.has(entry.source)).map((entry) => sourceName(entry.source));
    return {
      measured: true,
      isAsk: asks.length > 0,
      value,
      detail: (sizes.length
        ? `${references.length} references compared · median of ${sizes.join(", ")} · the lowest one wins, less ${percent(opportunity.resaleSpread ?? 0)} for disagreement`
        : `${references.length} references compared`) +
        (asks.length ? ` · ${asks.join(" and ")} quote asking prices, so those are ceilings, not payouts` : ""),
    };
  }
  if (Number.isFinite(opportunity.manualResalePrice)) {
    // A hand-supplied price now says *whose* hand. A number imported from an assistant
    // and one typed into the catalogue are the same arithmetic and a different claim, so
    // the card names the difference instead of flattening both into "you typed it in".
    const imported = opportunity.manualResaleSource === "assistant";
    return {
      measured: true,
      value: `${money(opportunity.manualResalePrice, currency)} — ${imported ? "the price you imported from an assistant" : "the price you typed in"}`,
      detail: imported
        ? `read by an assistant${opportunity.manualResaleDetail ? ` from ${opportunity.manualResaleDetail}` : ""} · ` +
          "it overrides anything the marketplaces say, so check it against the reference below"
        : "manual reference from the catalogue: it overrides anything the marketplaces say",
    };
  }
  if (Number.isFinite(opportunity.resalePrice)) {
    // A trade-in source is the case that misleads: its search results are what it
    // CHARGES. The card says "asking price" and names the commission, so nobody reads a
    // retail price as an offer for their own item.
    const tradeIn = TRADE_IN_SOURCES.has(opportunity.resaleSource);
    return {
      measured: true,
      isAsk: tradeIn,
      value: tradeIn
        ? `${money(opportunity.resalePrice, currency)} — median asking price on ${sourceName(opportunity.resaleSource)}`
        : `${money(opportunity.resalePrice, currency)} — median on ${sourceName(opportunity.resaleSource)}`,
      detail:
        `${opportunity.resaleSample ?? 0} resale listing(s) used · ${opportunity.confidence || "low"} confidence` +
        (tradeIn
          ? ` · what a buyer is charged, before ${sourceName(opportunity.resaleSource)} keeps its commission - a payout is lower`
          : ""),
    };
  }
  return {
    measured: false,
    value: "no resale price measured",
    detail:
      `nothing came back from ${sourceName(opportunity.resaleSource)} and there is no manual price` +
      " — add an eBay keyset in API keys, type a resale price in the Catalogue, or open the search link below",
  };
}

/** `+12.30 EUR` / `-4.00 EUR` - a signed amount, because the sign is the point. */
function signed(amount, currency) {
  if (!Number.isFinite(amount)) return "—";
  return `${amount >= 0 ? "+" : ""}${money(amount, currency)}`;
}

/**
 * What a refurbisher would pay for this item today, which is a different question from
 * what a buyer would pay for it eventually.
 *
 * Returns `null` when the run never asked (the switch is off, or Back Market is not one
 * of the product's references), so a card without a payout line is silent rather than
 * claiming the payout is zero. `measured: false` means the question was asked and no
 * number came back - which is stated, along with the link that gets the answer by hand.
 *
 * @returns {{measured: boolean, label: string, value: string, detail: string, url: string|null, urlLabel: string}|null}
 */
export function payoutReference(opportunity = {}) {
  const payout = opportunity.payout;
  if (!payout) return null;
  const currency = payout.currency || opportunity.currency || "EUR";
  const label = payout.label || "Instant payout";
  if (!payout.measured || !Number.isFinite(payout.net)) {
    return {
      measured: false,
      label,
      value: "no trade-in quote read",
      detail: `${payout.reason || "open the buyback flow"} · unmeasured, not zero`,
      url: payout.url || null,
      urlLabel: "Open the buyback flow",
    };
  }

  const parts = [
    `less ${percent(payout.commissionPct, 0)} commission (${money(payout.commission, currency)}) and ` +
      `${money(payout.logistics, currency)} logistics`,
  ];
  // The published schedule covers smartphones/audio and MacBooks/consoles/tablets only,
  // so anything else says its logistics figure is missing rather than pretending.
  if (!payout.logisticsKnown) parts.push("logistics is not published for this category, so the net may be optimistic");
  if (Number.isFinite(payout.breakEvenBuyPrice)) {
    parts.push(`breaks even at a buy price of ${money(payout.breakEvenBuyPrice, currency)}`);
  }
  if (Number.isFinite(payout.profitAbs)) {
    parts.push(
      `${VERDICT_LABELS[payout.verdict] || payout.verdict} at the current buy price ` +
        `(${signed(payout.profitAbs, currency)}, ${percent(payout.marginPct ?? 0, 1)})`,
    );
  }
  // A quote that came from an assistant rather than from this run's read of the page is
  // labelled as such: it is still a real number, but it was obtained by someone else.
  const imported = payout.origin === "assistant";
  if (imported) parts.push(`${payout.readFrom || "quote supplied by your assistant"} - the buyback page gave nothing to read`);
  return {
    measured: true,
    label: imported ? `${label} (imported)` : label,
    value: `${money(payout.gross, currency)} quote → ${money(payout.net, currency)} net`,
    detail: parts.join(" · "),
    url: payout.url || null,
    urlLabel: "Read the quote yourself",
  };
}

/**
 * A marketplace id as a person would write it. This reuses format.js's labels and
 * the live registry, so a source added to core/sources.js is named correctly here
 * without a second list to keep in step; "manual" is the one id that is not a
 * marketplace at all.
 */
function sourceName(id) {
  if (!id) return "the resale side";
  if (id === "manual") return "a price you typed";
  return marketplaceLabel(id);
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
