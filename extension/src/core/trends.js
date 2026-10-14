/**
 * Trend signals: "is anyone still interested in this, and is interest rising?"
 *
 * What this module deliberately is NOT: a scraper of TikTok, Instagram or Google
 * Trends. Google Trends has no open API (its official one is still limited-access),
 * and social platforms do not publish searchable interest data; anything claiming
 * to read them from an extension would either be lying or scraping against their
 * terms. So the signals here are the ones that are genuinely available and honest
 * about what they measure:
 *
 *   1. Wikimedia pageviews - a real, key-less, public-interest proxy. If searches
 *      for a product are surging, its Wikipedia article usually reflects it, and
 *      the numbers are downloadable by anyone.
 *   2. GDELT news attention - how much of the world's news coverage mentions the
 *      keyword. Media buzz, not search demand. Off by default.
 *   3. Your own keywords - paste in what you are seeing in your feeds. This is the
 *      only "social media" input that exists here, and it is honest because you are
 *      the one supplying it. See the opportunities panel.
 *
 * Plus the marketplace's own demand evidence (favourites, listing volume, freshness)
 * which lives in core/opportunity.js - that is usually the strongest signal of all,
 * because it is behaviour with money attached.
 *
 * All of the fetching lives in core/opportunity-scan.js; everything here is pure.
 */

export const WIKIPEDIA_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article";
export const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";
export const DEFAULT_PROJECT = "en.wikipedia";

function yyyymmdd(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Daily pageviews for one article. Wikimedia's data lags by about a day, so the
 * window ends one day ago rather than at "now".
 */
export function wikipediaUrl({ article, project = DEFAULT_PROJECT, days = 60, now = Date.now() } = {}) {
  if (!article) return null;
  const end = now - 24 * 3600 * 1000;
  const start = end - (days - 1) * 24 * 3600 * 1000;
  const title = encodeURIComponent(String(article).trim().replace(/\s+/g, "_"));
  return `${WIKIPEDIA_BASE}/${project}/all-access/all-agents/${title}/daily/${yyyymmdd(start)}/${yyyymmdd(end)}`;
}

/** News-attention timeline: share of monitored news mentioning the query. */
export function gdeltUrl({ query, days = 90, now = Date.now() } = {}) {
  if (!query) return null;
  const params = new URLSearchParams({
    query: `"${String(query).trim()}"`,
    mode: "timelinevol",
    format: "json",
    timespan: `${days}d`,
  });
  void now;
  return `${GDELT_BASE}?${params.toString()}`;
}

/** Split a series into a recent window and the window before it, and compare. */
export function growthFromSeries(series, { recentDays = 14 } = {}) {
  const points = (series || []).filter((p) => Number.isFinite(p?.views));
  if (points.length < recentDays * 2) {
    return { growth: null, recentMean: null, priorMean: null, recentDays: points.length };
  }
  const recent = points.slice(-recentDays);
  const prior = points.slice(-recentDays * 2, -recentDays);
  const mean = (list) => list.reduce((sum, p) => sum + p.views, 0) / (list.length || 1);
  const recentMean = mean(recent);
  const priorMean = mean(prior);
  const growth = priorMean > 0 ? (recentMean - priorMean) / priorMean : recentMean > 0 ? 1 : 0;
  return {
    growth: Math.round(growth * 10000) / 10000,
    recentMean: Math.round(recentMean * 10) / 10,
    priorMean: Math.round(priorMean * 10) / 10,
    recentDays: recent.length,
  };
}

export function parsePageviews(payload) {
  const series = (payload?.items || [])
    .map((item) => {
      const raw = String(item?.timestamp || "");
      const date = raw.length >= 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
      return date ? { date, views: Number(item.views) || 0 } : null;
    })
    .filter(Boolean);
  return { series, ...growthFromSeries(series) };
}

export function parseGdelt(payload) {
  const first = payload?.timeline?.[0];
  const series = (first?.series?.[0]?.data || [])
    .map((point) => {
      const raw = String(point?.date || "");
      const date = raw.length >= 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
      const value = Number(point?.value);
      return date && Number.isFinite(value) ? { date, views: value } : null;
    })
    .filter(Boolean);
  return { series, ...growthFromSeries(series) };
}

/** A growth rate as 0..1: -50% or worse is 0, flat is 0.5, +50% or better is 1. */
export function growthScore(growth) {
  if (growth === null || growth === undefined || !Number.isFinite(growth)) return null;
  return Math.max(0, Math.min(1, (growth + 0.5) / 1.0));
}

/**
 * The user's own hot list. Matching is word-based on purpose: "iphone 13" should
 * count for "iphone 13 128" but not for "iphone 14".
 */
export function socialMatch({ product, hotKeywords = [] } = {}) {
  const needles = [...(product?.socialKeywords || []), product?.keyword, product?.name]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase().trim());
  const matched = [];
  for (const hot of hotKeywords || []) {
    const needle = String(hot || "").toLowerCase().trim();
    if (!needle) continue;
    for (const candidate of needles) {
      if (candidate.includes(needle) || needle.includes(candidate)) {
        matched.push(needle);
        break;
      }
    }
  }
  return { matched: [...new Set(matched)], score: matched.length ? 1 : 0 };
}

/**
 * Blend the signals into one 0..1 number plus the reasons to show the user.
 * A missing signal is not a zero: it is simply not part of the blend, and the
 * reasons say which parts were actually measured.
 */
export function scoreTrends({ wikipedia = null, news = null, social = null, errors = [] } = {}) {
  const parts = [];
  const reasons = [];

  const wikiScore = growthScore(wikipedia?.growth ?? null);
  if (wikiScore !== null) {
    parts.push({ weight: 0.5, score: wikiScore });
    const pct = (wikipedia.growth * 100).toFixed(0);
    reasons.push(
      `public interest (Wikipedia pageviews): ${pct >= 0 ? "+" : ""}${pct}% recent vs previous window ` +
        `(${wikipedia.recentMean}/day vs ${wikipedia.priorMean}/day)`,
    );
  } else if (wikipedia?.series?.length) {
    reasons.push("public interest: too few daily points to call a trend");
  }

  const newsScore = growthScore(news?.growth ?? null);
  if (newsScore !== null) {
    parts.push({ weight: 0.3, score: newsScore });
    const pct = (news.growth * 100).toFixed(0);
    reasons.push(`news attention (GDELT): ${pct >= 0 ? "+" : ""}${pct}% recent vs previous window`);
  }

  if (social && (social.matched?.length || social.score === 0)) {
    parts.push({ weight: 0.2, score: social.score });
    reasons.push(
      social.matched?.length
        ? `on your own hot list: ${social.matched.join(", ")}`
        : "not on your hot list",
    );
  }

  for (const error of errors) reasons.push(error);
  if (!parts.length) {
    reasons.push("no trend data available: enable interest signals or paste your own hot keywords");
    return { score: 0, reasons, measured: 0 };
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const score = parts.reduce((sum, part) => sum + part.weight * part.score, 0) / totalWeight;
  return { score: Math.round(score * 1000) / 1000, reasons, measured: parts.length };
}
