/**
 * Presentation helpers for the dashboard.
 *
 * Kept out of dashboard.js and free of the DOM on purpose: sorting, filtering and
 * formatting are the parts of a UI that can be wrong in a way you would not notice,
 * so they are plain functions with tests.
 */

export const MARKETPLACE_LABELS = {
  vinted: "Vinted",
  leboncoin: "leboncoin",
  ebay: "eBay",
  mock: "offline demo",
};

export function money(amount, currency = "EUR", { compact = false } = {}) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const value = compact && Math.abs(amount) >= 1000 ? Math.round(amount) : amount;
  const digits = compact && Number.isInteger(value) ? 0 : 2;
  return `${value.toFixed(digits)} ${currency}`;
}

export function percent(fraction, digits = 0) {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function marketplaceLabel(marketplace) {
  return MARKETPLACE_LABELS[marketplace] || marketplace;
}

/** "3 min ago" / "2 h ago" / "yesterday" - for the last-scan line. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "never";
  const then = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 5400) return "1 h ago";
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 172800) return "yesterday";
  return `${Math.round(seconds / 86400)} d ago`;
}

/** "in 12 min" - for the next scheduled scan. */
export function untilTime(iso, now = Date.now()) {
  if (!iso) return "—";
  const then = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = (then - now) / 1000;
  if (seconds <= 0) return "due now";
  if (seconds < 60) return "in <1 min";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  return `in ${Math.round(seconds / 3600)} h`;
}

export const DEAL_SORTS = {
  newest: (a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen),
  discount: (a, b) => b.discountPct - a.discountPct || Date.parse(b.firstSeen) - Date.parse(a.firstSeen),
  price: (a, b) => a.price - b.price,
  cheapest: (a, b) => a.price - b.price,
};

/**
 * Filter + sort stored alerts for display. `query` mirrors the dashboard controls:
 * status ("new" | "bought" | "hidden" | "all"), watch, marketplace, free text,
 * minDiscount, and a sort key.
 */
export function visibleDeals(alerts, query = {}) {
  const {
    status = "new",
    watch = null,
    marketplace = null,
    text = "",
    minDiscount = null,
    sort = "newest",
  } = query;
  const needle = String(text || "").trim().toLowerCase();
  const filtered = alerts.filter((alert) => {
    if (status !== "all" && alert.status !== status) return false;
    if (watch && alert.watch !== watch) return false;
    if (marketplace && alert.marketplace !== marketplace) return false;
    if (minDiscount !== null && alert.discountPct < minDiscount) return false;
    if (needle) {
      const haystack = `${alert.title} ${alert.brand || ""} ${alert.size || ""} ${alert.watch}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const comparator = DEAL_SORTS[sort] || DEAL_SORTS.newest;
  return filtered.sort(comparator);
}

export function countByStatus(alerts) {
  const counts = { new: 0, bought: 0, hidden: 0 };
  for (const alert of alerts) counts[alert.status] = (counts[alert.status] || 0) + 1;
  return counts;
}

/** The one-line "why this is a deal" string for a card. */
export function dealHeadline(alert) {
  return (
    `${money(alert.price, alert.currency)} · ${percent(alert.discountPct)} under ` +
    `${money(alert.marketPrice, alert.currency)} market`
  );
}

export function watchSummary(run, baseline) {
  if (!run) return { marketPrice: null, comparables: 0, line: "never scanned", error: null };
  const stats = baseline?.stats || null;
  const marketPrice = run.marketPrice ?? stats?.median ?? null;
  const comparables = run.comparables ?? stats?.usedSize ?? 0;
  return {
    marketPrice,
    comparables,
    line:
      marketPrice === null
        ? "no verdict"
        : `${money(marketPrice, stats?.currency || "EUR")} from ${comparables} comparable listings`,
    error: run.error ? run.message || run.error : null,
  };
}
