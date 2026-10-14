/**
 * Market price estimation and deal scoring.
 *
 * A direct port of the Python implementation in ../../src/marketwatch/analyzer.py,
 * because the statistics are the part that decides whether the output means
 * anything. Ported deliberately: the numbers are cross-checked against Python in
 * tests/analyzer-parity.test.js.
 *
 *   market price = median of the comparable pool
 *   sigma        = 1.4826 * MAD          (consistent estimator for normal data)
 *   robust z     = (price - median) / sigma
 *
 * A listing is a deal only when it is BOTH cheap in relative terms
 * (price <= median * (1 - minDiscount)) AND an outlier (z <= maxRobustZ), and only
 * when that verdict rests on enough comparables.
 */

export const MAD_TO_SIGMA = 1.4826;

export function median(values) {
  if (!values || values.length === 0) throw new Error("median() of empty sequence");
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid];
  return (ordered[mid - 1] + ordered[mid]) / 2;
}

/** Linear-interpolation quantile (the numpy/statistics "inclusive" method). */
export function quantile(values, p) {
  if (!values || values.length === 0) throw new Error("quantile() of empty sequence");
  if (p < 0 || p > 1) throw new Error("p must be in [0, 1]");
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 1) return ordered[0];
  const pos = p * (ordered.length - 1);
  const low = Math.trunc(pos);
  const high = Math.min(low + 1, ordered.length - 1);
  const frac = pos - low;
  return ordered[low] * (1 - frac) + ordered[high] * frac;
}

export function mad(values, med = null) {
  const m = med === null ? median(values) : med;
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * MAD-based sigma, with a fallback for degenerate pools: when more than half the
 * pool shares one price, MAD is 0 and every z-score would be infinite. Falling
 * back to 10% of the median keeps the outlier test meaningful.
 */
export function robustSigma(values, med = null) {
  const m = med === null ? median(values) : med;
  let sigma = MAD_TO_SIGMA * mad(values, m);
  if (sigma <= 0) sigma = Math.max(0.1 * m, 1e-9);
  return sigma;
}

/**
 * Tukey fences with k=3: only extreme values go. A pool that is genuinely
 * expensive-wide still describes itself honestly, and bargains are NOT removed
 * from the baseline (that was a real bug once: IQR trimming at k=1.5 deleted the
 * very listings we were hunting).
 */
export function trimOutliers(prices, k = 3.0) {
  if (prices.length < 4) return { kept: [...prices], lowerFence: null };
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - k * iqr;
  const upper = iqr > 0 ? q3 + k * iqr : null;
  const kept = prices.filter((p) => p >= lower && (upper === null || p <= upper));
  return { kept: kept.length ? kept : [...prices], lowerFence: lower };
}

export function buildStats(prices, currency, { trimK = 3.0 } = {}) {
  const { kept, lowerFence } = trimOutliers(prices, trimK);
  const med = median(kept);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return {
    sampleSize: prices.length,
    usedSize: kept.length,
    currency,
    median: med,
    mean,
    q1: quantile(kept, 0.25),
    q3: quantile(kept, 0.75),
    mad: mad(kept, med),
    lowerFence,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Render a number the way Python's f-string does: a float always keeps a decimal
 * part, so a z threshold of -1.0 prints as "-1.0" and not "-1". The parity test
 * compares these strings against the Python implementation, and it reads better.
 */
function pyFloat(value) {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

export function robustSigmaFromStats(stats) {
  let sigma = MAD_TO_SIGMA * stats.mad;
  if (sigma <= 0) sigma = Math.max(0.1 * stats.median, 1e-9);
  return sigma;
}

// --- comparability ---------------------------------------------------------

const REGEX_CACHE = new Map();
function re(pattern) {
  let compiled = REGEX_CACHE.get(pattern);
  if (!compiled) {
    compiled = new RegExp(pattern, "i");
    REGEX_CACHE.set(pattern, compiled);
  }
  return compiled;
}

export function titleMatches(title, watch) {
  const low = String(title || "").toLowerCase();
  if (watch.mustMatch?.length && !watch.mustMatch.every((p) => re(p).test(low))) return false;
  if (watch.mustNotMatch?.length && watch.mustNotMatch.some((p) => re(p).test(low))) return false;
  return true;
}

// --- exact phrase ----------------------------------------------------------

/**
 * Fold text into comparable words: lowercase, accents removed, and a letter/digit
 * boundary treated as a word boundary so "256Go" is read as "256 go" and
 * "iPhone13" as "iphone 13". Without that step a search for "iphone 13 256"
 * would miss the very listings a human would call an exact match.
 */
export function foldText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function words(text) {
  const folded = foldText(text);
  return folded ? folded.split(" ") : [];
}

/**
 * Does `haystack` contain `phrase` as consecutive whole words?
 *
 * Whole words, not substrings, so "13" does not match "130", and consecutive, so
 * a search for "iphone 13 256" does not match "iphone 13 pro max 256 go". This is
 * the difference between "the listing mentions my product" and "the listing
 * mentions some of the same words".
 */
export function containsPhrase(haystack, phrase) {
  const needle = words(phrase);
  if (needle.length === 0) return true;
  const hay = words(haystack);
  for (let start = 0; start + needle.length <= hay.length; start += 1) {
    let ok = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (hay[start + offset] !== needle[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Title, plus the description when the marketplace gave us one. */
export function searchableText(listing) {
  return [listing?.title, listing?.description].filter(Boolean).join("\n");
}

/** The phrase a watch insists on (nothing to check when the gate is off). */
export function requiredPhrase(watch) {
  return watch?.exactPhrase ? String(watch.searchText || "").trim() : "";
}

/** The watch's own words must appear in the listing's title or description. */
export function phraseMatches(listing, watch) {
  const phrase = requiredPhrase(watch);
  if (!phrase) return true;
  return containsPhrase(searchableText(listing), phrase);
}

/**
 * Match a size/condition against an allowlist.
 *
 * A plain substring test is wrong for sizes ("9" would match "39.5", "42" would
 * match "142"), so a purely numeric entry must equal a whole number token of the
 * field. Anything else stays a substring test, which is what conditions want
 * ("bon état" matches "très bon état").
 */
export function valueMatches(value, allowed) {
  if (!allowed || allowed.length === 0) return true;
  if (value === null || value === undefined || value === "") return false;
  const low = String(value).toLowerCase();
  const numbers = new Set((low.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")));
  for (const candidate of allowed) {
    const needle = String(candidate).trim().toLowerCase();
    if (!needle) continue;
    if (/^\d+(?:[.,]\d+)?$/.test(needle)) {
      if (numbers.has(needle.replace(",", "."))) return true;
    } else if (low.includes(needle)) {
      return true;
    }
  }
  return false;
}

export function isPlausible(listing, watch) {
  return listing.price >= watch.plausibleMinPrice && listing.price <= watch.plausibleMaxPrice;
}

/** Is this the same product? Matters for candidates as much as for the baseline. */
export function matchesProduct(listing, watch) {
  if (!titleMatches(listing.title, watch)) return false;
  if (!phraseMatches(listing, watch)) return false;
  if (!valueMatches(listing.size, watch.sizes)) return false;
  if (!valueMatches(listing.condition, watch.conditions)) return false;
  return true;
}

export function isComparable(listing, watch) {
  return matchesProduct(listing, watch) && isPlausible(listing, watch);
}

export function filterComparables(listings, watch) {
  return listings.filter((l) => isComparable(l, watch));
}

/** How many listings the exact-phrase gate alone removed from a pool. */
export function phraseRejections(listings, watch) {
  if (!requiredPhrase(watch)) return 0;
  return listings.filter((l) => !phraseMatches(l, watch)).length;
}

// --- scoring ---------------------------------------------------------------

export function scoreListing(listing, stats, watch, sigma = null) {
  if (stats.median <= 0) return null;
  if (!matchesProduct(listing, watch)) return null;
  if (!isPlausible(listing, watch)) return null;
  const discount = 1 - listing.price / stats.median;
  if (discount < watch.minDiscount) return null;
  const s = sigma === null ? robustSigmaFromStats(stats) : sigma;
  const z = (listing.price - stats.median) / s;
  if (watch.maxRobustZ !== null && watch.maxRobustZ !== undefined && z > watch.maxRobustZ) return null;
  return {
    watch: watch.name,
    listing,
    marketPrice: stats.median,
    discountPct: discount,
    robustZ: z,
    landedPrice: listing.landedPrice ?? null,
    reasons: [
      `${(discount * 100).toFixed(1)}% below the ${stats.currency} market median ` +
        `(${stats.median.toFixed(2)} over ${stats.usedSize} comparable listings)`,
      `robust z-score ${z.toFixed(2)} ` +
        (watch.maxRobustZ !== null && watch.maxRobustZ !== undefined
          ? `(<= ${pyFloat(watch.maxRobustZ)})`
          : "(reported, no z gate configured)"),
      `condition=${listing.condition || "n/a"} size=${listing.size || "n/a"}`,
    ],
    firstSeen: new Date().toISOString(),
    stats: null,
  };
}

/** Score every candidate, best discount first. */
export function findDeals(candidates, stats, watch) {
  if (!stats || stats.usedSize < watch.minSampleSize) return [];
  const sigma = robustSigmaFromStats(stats);
  const deals = candidates
    .map((c) => scoreListing(c, stats, watch, sigma))
    .filter((d) => d !== null);
  deals.sort((a, b) => b.discountPct - a.discountPct || a.listing.price - b.listing.price);
  return deals;
}

/**
 * Why nothing was flagged: the cheapest few matches and their numbers, so tuning
 * a watch means knowing whether the market is thin, the filters are too strict, or
 * the thresholds are simply unreachable for this product.
 */
export function explainNoDeals(candidates, stats, watch, { limit = 3 } = {}) {
  if (!stats) return [];
  const matched = candidates.filter((c) => matchesProduct(c, watch) && isPlausible(c, watch));
  if (matched.length === 0) {
    const filters = [
      requiredPhrase(watch) ? `exact phrase "${watch.searchText}"` : null,
      "title",
      "size",
      "condition",
      "price band",
    ].filter(Boolean);
    return [`no listing matched the product filters (${filters.join(" / ")})`];
  }
  const sigma = robustSigmaFromStats(stats);
  const notes = [
    watch.maxRobustZ === null || watch.maxRobustZ === undefined
      ? "z-gate is off (discount alone decides)"
      : `thresholds: >= ${(watch.minDiscount * 100).toFixed(0)}% under median ` +
        `(${(stats.median * (1 - watch.minDiscount)).toFixed(2)} ${stats.currency}) ` +
        `and z <= ${pyFloat(watch.maxRobustZ)}`,
  ];
  for (const listing of [...matched].sort((a, b) => a.price - b.price).slice(0, limit)) {
    const discount = 1 - listing.price / stats.median;
    const z = (listing.price - stats.median) / sigma;
    notes.push(
      `closest match ${listing.price.toFixed(2)} ${listing.currency} ` +
        `(${(discount * 100).toFixed(0)}% under, z ${z.toFixed(2)}) - ` +
        String(listing.title || "").slice(0, 60),
    );
  }
  return notes;
}
