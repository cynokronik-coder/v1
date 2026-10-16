/**
 * The instant-payout path: what a refurbisher pays **you**, as opposed to what a
 * buyer is asked to pay for the same item.
 *
 * This file exists because those two numbers are not the same number, and the
 * difference is not small. A search of backmarket.fr returns the prices Back Market
 * *charges*, which is the seller's asking price; what a seller walks away with is
 * that minus Back Market's commission (10-35% depending on category), and what a
 * consumer walks away with is usually much less again, because Back Market's trade-in
 * ("reprise") flow is a professional refurbisher buying your device outright at a
 * wholesale price - they carry the refurbishing cost and the selling risk.
 *
 * Measured on the same model, 2026: an iPhone 13 Pro Max showed "up to 385 EUR" on
 * Back Market's own buyback page, while the refurbished asking prices on its price
 * guide for the same model started at 432 EUR (128 GB, "correct" condition). That is
 * the gap this file makes visible instead of hiding.
 *
 * So: `resalePrice` remains what you can get by selling the item yourself, and a
 * `payout` is a floor - instant, no listing, no buyer, no waiting, and correspondingly
 * less money. The two are never averaged together; mixing a retail ask into a payout
 * would invent money that does not exist.
 *
 * Everything here is pure arithmetic and string work: no network, no DOM, no storage,
 * so it is all testable in node (tests/buyback.test.js).
 *
 * Sources for the fee numbers, read 2026-10: Back Market's own seller documentation
 * at https://api.backmarket.dev/ and its seller pages, plus the Seller Terms &
 * Conditions schedule effective 2024-08-10 (trade-in commission 10% excluding tax on
 * what the refurbisher pays, plus logistics charges in France: 10.90 EUR for
 * smartphones and audio, 13.90 EUR for MacBooks, consoles and tablets).
 * Back Market's own terms say a seller's commission is "in accordance with the terms
 * agreed upon" with that seller, so treat this as the published schedule, not as your
 * contract: it is overridable, and it says so wherever it is shown.
 */

/** The trade-in schedule, with its own provenance attached. */
export const BACKMARKET_TRADE_IN = {
  source: "backmarket-buyback",
  label: "Back Market trade-in",
  /** On the amount the refurbisher pays, including tax and shipping. Ex-tax rate. */
  commissionPct: 0.1,
  /** Flat logistics charge you pay to send the item in, by category, in EUR. */
  logistics: {
    phones: 10.9,
    audio: 10.9,
    laptops: 13.9,
    tablets: 13.9,
    consoles: 13.9,
  },
  asOf: "2024-08-10",
  note:
    "trade-in commission (10%) and return logistics, from the Seller Terms schedule effective " +
    "2024-08-10 - your own contract may differ, so the override on the product wins",
};

/**
 * The logistics charge for a category. Back Market's published schedule names only
 * two bands, so anything outside them is reported as *not published* rather than
 * filled in with a number that would flatter the net figure.
 */
export function tradeInLogistics(category) {
  const amount = BACKMARKET_TRADE_IN.logistics[String(category || "").toLowerCase()];
  return Number.isFinite(amount) ? { amount, known: true } : { amount: 0, known: false };
}

/**
 * Gross quote -> what actually lands in your account.
 *
 * `net = gross * (1 - commissionPct) - logistics`. The commission is charged on what
 * the refurbisher pays rather than on what you receive, which is why it is applied
 * before the flat charge instead of after it.
 *
 * @param {object} args
 * @param {number} args.gross                 the quote, as shown by the buyback page
 * @param {string} [args.category]            for the logistics band
 * @param {number} [args.commissionPct]       override, e.g. from the product's fees
 * @param {number} [args.logistics]           override the flat charge
 * @param {string} [args.currency]
 */
export function netPayout({ gross, category = null, commissionPct, logistics, currency = "EUR" } = {}) {
  if (!Number.isFinite(gross) || gross <= 0) return null;
  const band = tradeInLogistics(category);
  const commission = Number.isFinite(commissionPct) ? commissionPct : BACKMARKET_TRADE_IN.commissionPct;
  const charge = Number.isFinite(logistics) ? logistics : band.amount;
  const logisticsKnown = Number.isFinite(logistics) ? true : band.known;
  const fee = gross * commission;
  const net = gross - fee - charge;
  return {
    // Kept unrounded for arithmetic; the UI rounds.
    gross,
    commissionPct: commission,
    commission: Math.round(fee * 100) / 100,
    logistics: Math.round(charge * 100) / 100,
    logisticsKnown,
    net: Math.round(net * 100) / 100,
    currency,
  };
}

/**
 * "iPhone 13 Pro Max" -> "iphone-13-pro-max", which is the shape Back Market's own
 * buyback URLs use. Accents are folded rather than dropped so "Sony A7 III" style
 * names and French catalogue text both survive the trip.
 */
export function modelSlug(text) {
  return String(text || "")
    // Catalogue names carry their variants: "iPhone 13 (128 / 256 Go)" is the iPhone 13,
    // and the parenthetical would otherwise become "iphone-13-128-256-go" and 404.
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const BACKMARKET_BUYBACK_ORIGIN = "https://www.backmarket.fr";
export const BACKMARKET_BUYBACK_LOCALE = "fr-fr";

/**
 * Buyback URL families. Only `smartphone` was verified against the live site (an
 * iPhone 13 Pro Max page lives at /fr-fr/buyback/m/smartphone/iphone-13-pro-max), so
 * every other family deliberately falls back to the buyback home page, where the user
 * picks their device in Back Market's own flow. Guessing the remaining path segments
 * would produce links that 404, which is worse than an extra click.
 */
export const BUYBACK_PATHS = { phones: "smartphone" };

/**
 * Where to send someone to get a real payout quote.
 *
 * @returns {{url: string, exact: boolean}} `exact: false` means "the home page - this
 *          category's model URL pattern has not been verified".
 */
export function buybackUrl({ category = null, slug = null, domain = "www.backmarket.fr", locale = BACKMARKET_BUYBACK_LOCALE } = {}) {
  const base = `https://${String(domain || "www.backmarket.fr").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  const family = BUYBACK_PATHS[String(category || "").toLowerCase()];
  const cleanSlug = slug ? modelSlug(slug) : null;
  if (family && cleanSlug) return { url: `${base}/${locale}/buyback/m/${family}/${cleanSlug}`, exact: true };
  return { url: `${base}/${locale}/buyback/home`, exact: false };
}

/**
 * A parsed quote plus the fee maths, in one object the card can render.
 *
 * @param {object} quote  { amount, currency, condition, storage, expiresAt, url }
 * @param {object} [options] { category, commissionPct, logistics, productName }
 */
export function payoutFromQuote(quote, { category = null, commissionPct, logistics, productName = null } = {}) {
  if (!quote || !Number.isFinite(quote.amount) || quote.amount <= 0) return null;
  const net = netPayout({
    gross: quote.amount,
    category,
    commissionPct,
    logistics,
    currency: quote.currency || "EUR",
  });
  if (!net) return null;
  return {
    source: BACKMARKET_TRADE_IN.source,
    label: BACKMARKET_TRADE_IN.label,
    measured: true,
    productName,
    condition: quote.condition ?? null,
    storage: quote.storage ?? null,
    expiresAt: quote.expiresAt ?? null,
    url: quote.url || null,
    readFrom: quote.readFrom || null,
    ...net,
  };
}

/**
 * The payout slot when no quote could be read. This is *not* a zero and never renders
 * as one: it carries the URL of the flow so the number can be obtained by hand, which
 * is how this actually gets used - Back Market's quote depends on condition answers
 * only the owner of the device can give.
 */
export function unmeasuredPayout({ category = null, keyword = null, url = null, reason = null } = {}) {
  return {
    source: BACKMARKET_TRADE_IN.source,
    label: BACKMARKET_TRADE_IN.label,
    measured: false,
    gross: null,
    net: null,
    currency: "EUR",
    category,
    keyword,
    url,
    reason: reason || "no quote read - open the buyback flow and enter the offer you are given",
  };
}

/** "385.00 EUR - trade-in, 10% commission and 10.90 logistics => 335.60 net" */
export function payoutSummary(payout) {
  if (!payout || !payout.measured) return null;
  const currency = payout.currency || "EUR";
  const money = (amount) => `${Number(amount).toFixed(2)} ${currency}`;
  return (
    `${money(payout.gross)} trade-in quote, less ${(payout.commissionPct * 100).toFixed(0)}% commission ` +
    `(${money(payout.commission)}) and ${money(payout.logistics)} logistics => ${money(payout.net)} net`
  );
}
