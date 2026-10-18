/**
 * Taking numbers from an AI assistant, and not believing them.
 *
 * ChatGPT (or Claude, or a local model, or a person) cannot push anything into a
 * browser extension: an MV3 worker has no listening socket and can only make
 * outbound requests. So there are exactly two ways in, and this module is the shared
 * landing strip for both:
 *
 *   1. **paste** - the assistant writes JSON, the user pastes it into the dashboard.
 *   2. **bridge** - a small hosted queue an assistant can post to (see
 *      `bridge/src/worker.js`), which the extension polls on an alarm.
 *
 * Neither of them writes anything by itself. Every entry becomes an **inbox item**
 * with a `status` of `pending`, and only an explicit apply in the dashboard turns it
 * into a catalogue price, a trade-in quote the payout path may use, or a new product.
 * That is the whole safety model, and it is deliberately boring: a model cannot make
 * a number reach a verdict without a human click.
 *
 * The second rule is the one this project keeps re-learning: an **asking price** and a
 * **payout** are different numbers, and a tool that lets them blur is worse than no
 * tool. So a reference must say which one it is - `resale_ask` or `trade_in_quote` -
 * and there is no third "price" kind to fall back on.
 *
 * Everything here is pure: text in, records out, no storage, no network, no DOM.
 */

import { CATEGORIES, normalizeCatalogItem } from "./catalog.js";
import { ConfigError } from "./models.js";
import { BUY_SOURCES, RESALE_REFERENCE_SOURCES } from "./sources.js";

export class AssistantError extends ConfigError {
  constructor(message) {
    super(message);
    this.name = "AssistantError";
  }
}

/** What the two kinds mean, in the words the prompt and the inbox both use. */
export const REFERENCE_KINDS = {
  resale_ask: "an asking price: what a buyer is charged for it",
  trade_in_quote: "a payout: what a refurbisher offers you for yours",
};

/** Spelled out because "ask" and "quote" are exactly the words people mix up. */
const KIND_ALIASES = {
  resale_ask: "resale_ask",
  ask: "resale_ask",
  asking: "resale_ask",
  asking_price: "resale_ask",
  resale: "resale_ask",
  resale_price: "resale_ask",
  // Deliberately NOT accepted: "price", "sell" and "buy". They are the words that mean
  // either number depending on who is talking, and guessing is how an ask becomes a
  // payout. A model that says "price" is asked again, with the two options named.
  trade_in: "trade_in_quote",
  tradein: "trade_in_quote",
  "trade-in": "trade_in_quote",
  trade_in_quote: "trade_in_quote",
  payout: "trade_in_quote",
  buyback: "trade_in_quote",
  buy_back: "trade_in_quote",
  quote: "trade_in_quote",
  cash: "trade_in_quote",
};

export const INBOX_KINDS = [...Object.keys(REFERENCE_KINDS), "product"];
export const MAX_REFERENCES = 50;
export const MAX_PASTE_CHARS = 60000;
export const MAX_AMOUNT = 100000;

const fold = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** `"385,00 €"` -> 385. Forgiving about the currency, strict about being a number. */
export function asPrice(value) {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === "number") return value;
  const cleaned = String(value)
    .replace(/\s/g, "")
    .replace(/[€$£]/g, "")
    .replace(/eur|usd|gbp/gi, "")
    .replace(",", ".");
  // "1.234,56" and "1,234.56" are both written by people; neither is worth guessing at,
  // so only the last separator is treated as the decimal one.
  const normalised = cleaned.includes(".") && cleaned.includes(",") ? cleaned.replace(/\./g, "") : cleaned;
  const number = Number(normalised);
  return Number.isFinite(number) ? number : Number.NaN;
}

/** The two kinds, or a readable refusal naming them. */
export function kindOf(value) {
  // A model writing `resalePrice` in JSON is the common case, so camelCase is split
  // before the lookup rather than being rejected as an unknown kind.
  const key = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/[\s-]+/g, "_");
  const kind = KIND_ALIASES[key];
  if (!kind) {
    throw new AssistantError(
      `kind '${value}' is not one of the two: use "resale_ask" for an asking price a buyer pays, ` +
        `or "trade_in_quote" for a payout a refurbisher offers you`,
    );
  }
  return kind;
}

function isoDate(value, fallback) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return fallback;
  return new Date(time).toISOString().slice(0, 10);
}

function httpUrl(value) {
  if (!value) return null;
  const text = String(value).trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

/**
 * Pull JSON out of whatever the assistant actually wrote.
 *
 * In practice that is a fenced block inside three paragraphs of apology or
 * explanation, sometimes with an example block *before* the real one - so the last
 * fence wins, and a bare JSON body is accepted as-is.
 */
export function extractJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new AssistantError("nothing pasted: copy the whole answer, including the braces");
  if (raw.length > MAX_PASTE_CHARS) {
    throw new AssistantError(`that is ${raw.length} characters; the import accepts up to ${MAX_PASTE_CHARS}`);
  }
  const fences = [...raw.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map((match) => match[1].trim()).filter(Boolean);
  const candidates = [...fences.reverse(), raw];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate; the final throw below explains what was wanted
    }
  }
  throw new AssistantError(
    "that is not JSON. Paste the block between the ``` marks, starting with { (or [) and ending with } (or ]).",
  );
}

/**
 * The envelope: `{products, references}` either or both, or a bare array where each
 * entry is sorted by whether it smells like a price or a product.
 */
export function splitPayload(parsed) {
  if (Array.isArray(parsed)) {
    const references = parsed.filter((entry) => entry && typeof entry === "object" && (entry.amount ?? entry.price) !== undefined);
    const products = parsed.filter((entry) => entry && typeof entry === "object" && (entry.amount ?? entry.price) === undefined);
    return { references, products };
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AssistantError("that JSON is not an object: expected {\"references\": [...]} and/or {\"products\": [...]}");
  }
  const references = [].concat(parsed.references || parsed.prices || []);
  const products = [].concat(parsed.products || []);
  if (!references.length && !products.length) {
    throw new AssistantError('nothing to import: expected "references" (prices) and/or "products" (catalogue entries)');
  }
  return { references, products };
}

/** One price, validated. Throws with a message a person can act on. */
export function normalizeReference(raw, index = 0) {
  const where = `reference #${index + 1}`;
  if (!raw || typeof raw !== "object") throw new AssistantError(`${where} must be an object`);
  const product = String(raw.product ?? raw.keyword ?? raw.name ?? "").trim();
  if (!product) throw new AssistantError(`${where} has no product: it needs "product": "the search text it is about"`);
  const kind = kindOf(raw.kind ?? raw.type);
  const amount = asPrice(raw.amount ?? raw.price ?? raw.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AssistantError(`${where} ("${product}") has no usable amount: ${JSON.stringify(raw.amount ?? raw.price ?? null)}`);
  }
  if (amount > MAX_AMOUNT) {
    throw new AssistantError(`${where} ("${product}") is ${amount}, which is not a second-hand price this tool will store`);
  }
  const source = String(raw.source ?? raw.where ?? raw.site ?? "the assistant").trim().slice(0, 60) || "the assistant";
  const currency = String(raw.currency ?? "EUR").trim().toUpperCase().slice(0, 3);
  return {
    product,
    kind,
    amount: Math.round(amount * 100) / 100,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "EUR",
    source,
    url: httpUrl(raw.url),
    note: String(raw.note ?? "").slice(0, 400),
    observedAt: isoDate(raw.observedAt ?? raw.date ?? raw.observed, new Date().toISOString().slice(0, 10)),
  };
}

/**
 * Which catalogue product a reference is about.
 *
 * Exact id, exact keyword, then containment on the folded text. Deliberately no
 * fuzzy scoring: attaching "iphone 13" to "iPhone 13 Pro Max" because they share a
 * word is how a payout ends up on the wrong product. No match is a normal outcome,
 * and the inbox asks the user to pick.
 */
export function matchProduct(catalog = [], text) {
  const needle = fold(text);
  if (!needle) return null;
  const items = catalog || [];
  const exact = items.find((item) => fold(item.id) === needle || fold(item.keyword) === needle);
  if (exact) return exact;
  const byName = items.find((item) => fold(item.name) === needle);
  if (byName) return byName;
  const contains = items.filter((item) => {
    const haystack = `${fold(item.name)} ${fold(item.keyword)}`;
    return haystack.includes(needle) || needle.includes(fold(item.keyword));
  });
  // Only when it is unambiguous: two candidates means the user picks.
  return contains.length === 1 ? contains[0] : null;
}

/** A stable id, so a re-pasted or re-polled entry is recognised instead of duplicated. */
export function referenceKey(record = {}) {
  const parts = [
    // `keyword` first: an inbox item's `product` is a catalogue id by then, and the id
    // has to be stable across the shape it was created from and the shape it is stored as.
    fold(record.keyword || record.product || ""),
    record.kind || "",
    Number(record.amount || 0).toFixed(2),
    fold(record.source || ""),
    String(record.observedAt || "").slice(0, 10),
  ];
  let hash = 2166136261;
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `in-${(hash >>> 0).toString(36)}`;
}

/** A reference (or a product suggestion) as an inbox item waiting for a click. */
export function makeInboxItem(raw, { catalog = [], origin = "paste", now = Date.now() } = {}) {
  const base = { origin, status: "pending", receivedAt: new Date(now).toISOString() };
  if (raw && typeof raw === "object" && (raw.kind === "product" || raw.type === "product")) {
    const draft = normalizeProductDraft(raw, catalog);
    return { ...base, id: `in-${draft.id}`, kind: "product", product: null, keyword: draft.keyword, productDraft: draft };
  }
  const reference = normalizeReference(raw);
  const match = matchProduct(catalog, reference.product);
  return {
    ...base,
    id: referenceKey(reference),
    kind: reference.kind,
    ...reference,
    // `product` is the catalogue id once matched; the text the assistant used is kept
    // as `keyword`, because that is what the inbox has to show and what a user
    // recognises when re-attaching it to a different product.
    keyword: reference.product,
    product: match?.id ?? null,
    productName: match?.name ?? null,
  };
}

/**
 * A product the assistant proposes adding to the catalogue.
 *
 * Only `name` is required in the payload; everything else falls back to what
 * `normalizeCatalogItem` does when you type an entry by hand, so a thin suggestion is
 * still a valid entry rather than a half-built one.
 */
export function normalizeProductDraft(raw, catalog = []) {
  const name = String(raw.name ?? raw.product ?? raw.keyword ?? "").trim();
  const draft = {
    name,
    keyword: String(raw.keyword ?? raw.search ?? name).trim(),
    category: raw.category,
    buyMarket: raw.buyMarket,
    resaleSource: raw.resaleSource,
    resaleSources: raw.resaleSources,
    plausibleMinPrice: raw.plausibleMinPrice ?? raw.minPrice,
    plausibleMaxPrice: raw.plausibleMaxPrice ?? raw.maxPrice,
    wikipedia: raw.wikipedia,
    note: raw.note,
  };
  let normalised;
  try {
    normalised = normalizeCatalogItem(draft);
  } catch (error) {
    throw new AssistantError(String(error.message || error).replace(/^Error: /, ""));
  }
  if ((catalog || []).some((item) => item.id === normalised.id)) {
    throw new AssistantError(`'${normalised.name}' is already in the catalogue`);
  }
  return normalised;
}

/**
 * Everything one paste (or one poll) contains, validated row by row.
 *
 * One bad row never throws the whole import away: the user gets the rows that
 * worked plus a list of the ones that did not, with the assistant's own text quoted
 * back. That matters because the failure is usually the model's, and the fix is to
 * ask it again rather than to retype its output.
 */
export function importAssistant({ text, parsed = null, catalog = [], origin = "paste", now = Date.now() } = {}) {
  const payload = parsed ?? extractJson(text);
  const { references, products } = splitPayload(payload);
  const items = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();

  references.forEach((raw, index) => {
    try {
      const item = makeInboxItem({ ...raw, kind: raw.kind ?? raw.type }, { catalog, origin, now });
      if (seen.has(item.id)) {
        warnings.push(`ignored a duplicate of "${item.keyword}"`);
        return;
      }
      seen.add(item.id);
      items.push(item);
      if (!item.product) {
        warnings.push(`no catalogue product matches "${item.keyword}" - pick one when you apply it`);
      }
    } catch (error) {
      errors.push({ where: `reference #${index + 1}`, message: stripError(error) });
    }
  });

  products.forEach((raw, index) => {
    try {
      const item = makeInboxItem({ ...raw, kind: "product" }, { catalog, origin, now });
      if (seen.has(item.id)) {
        warnings.push(`ignored a duplicate product suggestion "${item.keyword}"`);
        return;
      }
      seen.add(item.id);
      items.push(item);
    } catch (error) {
      errors.push({ where: `product #${index + 1}`, message: stripError(error) });
    }
  });

  if (!items.length && !errors.length) {
    throw new AssistantError("that JSON had nothing in it: expected a list of prices or products");
  }
  return { items, errors, warnings, references: references.length, products: products.length };
}

export function stripError(error) {
  return String(error?.message || error || "unknown error").replace(/^Error: /, "");
}

/**
 * The instructions to hand the assistant.
 *
 * Built from the live registry rather than written once in a README, so the ids a
 * model is allowed to name are the ids this build actually has. That is the whole
 * reason a pasted answer usually fails: it invents `wallapop`, and the validator
 * refuses it. This prompt closes that loop without loosening the validator.
 */
export function assistantPrompt({ catalog = [], resaleIds = RESALE_REFERENCE_SOURCES, buyIds = BUY_SOURCES } = {}) {
  const products = (catalog || [])
    .filter((item) => item.enabled !== false)
    .slice(0, 12)
    .map((item) => `  - "${item.keyword}" (${item.name}, ${item.category})`);
  const known = products.length ? `\nProducts already in the catalogue, so prefer these exact search texts:\n${products.join("\n")}\n` : "";
  return [
    "You are filling in an import for the marketwatch browser extension. Reply with ONE fenced ```json block and nothing else.",
    "",
    "Every entry is either a PRICE or a PRODUCT.",
    "",
    "A price:",
    '  {"kind": "resale_ask" | "trade_in_quote", "product": "the search text it is about",',
    '   "amount": 385.00, "currency": "EUR", "source": "where you read it",',
    '   "url": "optional page", "note": "one line on what this number is", "observedAt": "YYYY-MM-DD"}',
    "",
    'kind "resale_ask"    = an asking price: what a buyer is CHARGED for the item.',
    'kind "trade_in_quote" = a payout: what a refurbisher OFFERS YOU for yours. This is lower.',
    "Use trade_in_quote for any buy-back / trade-in / cash-offer page, including Back Market's.",
    "",
    "A product to add to the catalogue:",
    '  {"kind": "product", "name": "iPhone 13", "keyword": "iphone 13 128", "category": "phones",',
    '   "plausibleMinPrice": 200, "plausibleMaxPrice": 600, "buyMarket": ["vinted", "leboncoin"],',
    '   "resaleSources": ["ebay", "backmarket"]}',
    "",
    `category is one of: ${CATEGORIES.join(", ")}`,
    `buyMarket is one or more of: ${buyIds.join(", ")}`,
    `resaleSources is one or more of: ${resaleIds.join(", ")}`,
    "",
    "Rules:",
    "- Only report numbers you can actually see on a page. Never estimate, average or remember a price.",
    "- If you cannot see a number, leave the entry out entirely instead of guessing.",
    "- Put the real currency in `currency`. Amounts are plain numbers, no symbols.",
    "- Say in `note` where the number came from, in plain words.",
    "- Do not invent marketplace names; the lists above are the only allowed values.",
    known,
    "Answer with exactly:",
    '```json',
    '{"references": [{"kind": "trade_in_quote", "product": "iphone 13 128", "amount": 385, "currency": "EUR",',
    '  "source": "Back Market buyback page", "note": "trade-in quote for a 128 GB iPhone 13 in good condition"}]}',
    "```",
  ].join("\n");
}

/** "Back Market, 2026-10-18" - the provenance line stored on a manual price. */
export function provenanceLine(item = {}) {
  const when = item.observedAt || String(item.receivedAt || "").slice(0, 10);
  const origin = item.origin === "bridge" ? "assistant (live bridge)" : "assistant (pasted)";
  return [item.source || origin, when].filter(Boolean).join(", ");
}

/** One inbox item as a sentence a person can check at a glance. */
export function inboxLine(item = {}) {
  if (item.kind === "product") {
    return `new product "${item.productDraft?.name}" (${item.productDraft?.keyword})`;
  }
  const label = item.kind === "trade_in_quote" ? "payout quote" : "asking price";
  const currency = item.currency || "EUR";
  return `${label}: ${Number(item.amount).toFixed(2)} ${currency} for "${item.keyword}", from ${item.source || "the assistant"}`;
}
