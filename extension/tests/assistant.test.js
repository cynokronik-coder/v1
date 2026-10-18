/**
 * The assistant import, tested where it can be wrong: what counts as JSON, which of
 * the two kinds a number is, and whether a bad row takes the good ones down with it.
 *
 * The rule these tests exist to protect: an imported number is a *suggestion* with a
 * label, never a price that appears by itself, and an asking price can never be
 * quietly stored as a payout.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_AMOUNT,
  asPrice,
  assistantPrompt,
  extractJson,
  importAssistant,
  inboxLine,
  kindOf,
  makeInboxItem,
  matchProduct,
  normalizeReference,
  provenanceLine,
  referenceKey,
  splitPayload,
} from "../src/core/assistant.js";

const CATALOG = [
  { id: "iphone-13", name: "iPhone 13 (128 / 256 Go)", keyword: "iphone 13 128", category: "phones" },
  { id: "pixel-8", name: "Pixel 8", keyword: "pixel 8", category: "phones" },
  { id: "iphone-14-pro", name: "iPhone 14 Pro", keyword: "iphone 14 pro", category: "phones" },
];

test("a fenced block inside an explanation is found", () => {
  const text = 'Here you go:\n\n```json\n{"references": [{"product": "pixel 8", "kind": "resale_ask", "amount": 240}]}\n```\n\nHope that helps.';
  assert.equal(extractJson(text).references.length, 1);
});

test("the last fenced block wins, because models show an example first", () => {
  const text = 'Example:\n```json\n{"references": []}\n```\nReal answer:\n```json\n{"references": [{"amount": 1}]}\n```';
  assert.equal(extractJson(text).references.length, 1);
});

test("bare JSON is accepted", () => {
  assert.equal(extractJson('{"products": []}').products.length, 0);
});

test("prose with no JSON says what to paste", () => {
  assert.throws(() => extractJson("I could not find a price, sorry."), /not JSON|between the ```/);
  assert.throws(() => extractJson("   "), /nothing pasted/);
});

test("a bare array is sorted into prices and products by shape", () => {
  const parsed = extractJson('[{"product": "x", "amount": 10}, {"name": "y", "keyword": "y"}]');
  const { references, products } = splitPayload(parsed);
  assert.equal(references.length, 1);
  assert.equal(products.length, 1);
});

test("an envelope with neither key is refused, with the expected shape named", () => {
  assert.throws(() => splitPayload({ hello: "world" }), /references/);
});

test("prices arrive as people and models write them", () => {
  assert.equal(asPrice(385), 385);
  assert.equal(asPrice("385 EUR"), 385);
  assert.equal(asPrice("385,00 €"), 385);
  assert.equal(asPrice("1 234,56"), 1234.56);
  assert.ok(Number.isNaN(asPrice("free")));
  assert.ok(Number.isNaN(asPrice(null)));
});

test("only two kinds exist, and the wrong one is refused by name", () => {
  assert.equal(kindOf("trade_in"), "trade_in_quote");
  assert.equal(kindOf("buyback"), "trade_in_quote");
  assert.equal(kindOf("ask"), "resale_ask");
  assert.equal(kindOf("resalePrice"), "resale_ask");
  assert.throws(() => kindOf("price"), /resale_ask.*trade_in_quote|trade_in_quote.*resale_ask/s);
});

test("a reference keeps its provenance and loses a non-http url", () => {
  const reference = normalizeReference({
    product: " iphone 13 128 ",
    kind: "trade_in_quote",
    amount: "385,00 €",
    source: "Back Market buyback page",
    url: "javascript:alert(1)",
    note: "128 GB, good condition",
    observedAt: "2026-10-12T09:00:00Z",
  });
  assert.equal(reference.product, "iphone 13 128");
  assert.equal(reference.amount, 385);
  assert.equal(reference.currency, "EUR");
  assert.equal(reference.url, null, "a javascript: url is not a source link");
  assert.equal(reference.observedAt, "2026-10-12");
});

test("a reference with no product or no amount is refused, quoting the row", () => {
  assert.throws(() => normalizeReference({ kind: "resale_ask", amount: 10 }), /no product/);
  assert.throws(() => normalizeReference({ product: "x", kind: "resale_ask" }), /no usable amount/);
  assert.throws(
    () => normalizeReference({ product: "x", kind: "resale_ask", amount: MAX_AMOUNT + 1 }),
    /not a second-hand price/,
  );
});

test("a product is matched exactly, or by one unambiguous mention, or not at all", () => {
  assert.equal(matchProduct(CATALOG, "iphone-13").id, "iphone-13");
  assert.equal(matchProduct(CATALOG, "pixel 8").id, "pixel 8".replace(" ", "-"));
  assert.equal(matchProduct(CATALOG, "iPhone 13"), CATALOG[0]);
  // Two products mention "iphone": guessing is exactly how a payout lands on the wrong one.
  assert.equal(matchProduct(CATALOG, "iphone"), null);
  assert.equal(matchProduct(CATALOG, "leica q2"), null);
});

test("an inbox item is pending, labelled with where it came from", () => {
  const item = makeInboxItem(
    { product: "pixel 8", kind: "resale_ask", amount: 240, source: "eBay" },
    { catalog: CATALOG, origin: "bridge", now: Date.parse("2026-10-18T10:00:00Z") },
  );
  assert.equal(item.status, "pending");
  assert.equal(item.origin, "bridge");
  assert.equal(item.product, "pixel-8");
  assert.equal(item.productName, "Pixel 8");
  assert.equal(item.receivedAt, "2026-10-18T10:00:00.000Z");
});

test("the same number twice is the same id, a changed number is not", () => {
  const one = makeInboxItem({ product: "pixel 8", kind: "resale_ask", amount: 240, source: "eBay" }, { catalog: CATALOG });
  const again = makeInboxItem({ product: "pixel 8", kind: "resale_ask", amount: 240, source: "eBay" }, { catalog: CATALOG });
  const higher = makeInboxItem({ product: "pixel 8", kind: "resale_ask", amount: 260, source: "eBay" }, { catalog: CATALOG });
  assert.equal(one.id, again.id);
  assert.notEqual(one.id, higher.id);
  assert.equal(referenceKey(one), one.id);
});

test("an import with one broken row keeps the good ones and quotes the bad one", () => {
  const result = importAssistant({
    text: JSON.stringify({
      references: [
        { product: "pixel 8", kind: "resale_ask", amount: 240 },
        { product: "iphone 13", kind: "price", amount: 385 },
        { product: "iphone 14 pro", kind: "trade_in_quote", amount: 500 },
      ],
    }),
    catalog: CATALOG,
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].where, /reference #2/);
  assert.match(result.errors[0].message, /resale_ask/);
});

test("a product suggestion becomes a catalogue draft, and a duplicate is refused", () => {
  const result = importAssistant({
    text: JSON.stringify({
      products: [
        { kind: "product", name: "Leica Q2", keyword: "leica q2", category: "cameras", plausibleMinPrice: 1500, plausibleMaxPrice: 3200 },
        { kind: "product", name: "Pixel 8", keyword: "pixel 8" },
      ],
    }),
    catalog: CATALOG,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "product");
  assert.equal(result.items[0].productDraft.keyword, "leica q2");
  assert.equal(result.items[0].productDraft.category, "cameras");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /already in the catalogue/);
});

test("a duplicate inside one import is imported once and mentioned", () => {
  const result = importAssistant({
    text: JSON.stringify({
      references: [
        { product: "pixel 8", kind: "resale_ask", amount: 240 },
        { product: "pixel 8", kind: "resale_ask", amount: 240 },
      ],
    }),
    catalog: CATALOG,
  });
  assert.equal(result.items.length, 1);
  assert.match(result.warnings.join(" "), /duplicate/);
});

test("a price for something the catalogue does not have warns instead of guessing", () => {
  const result = importAssistant({
    text: JSON.stringify({ references: [{ product: "leica q2", kind: "resale_ask", amount: 2400 }] }),
    catalog: CATALOG,
  });
  assert.equal(result.items[0].product, null);
  assert.match(result.warnings.join(" "), /no catalogue product matches/);
});

test("the prompt teaches the two kinds, and names the ids this build has", () => {
  const prompt = assistantPrompt({ catalog: CATALOG });
  assert.match(prompt, /trade_in_quote/);
  assert.match(prompt, /resale_ask/);
  assert.match(prompt, /OFFERS YOU/);
  assert.match(prompt, /vinted/);
  assert.match(prompt, /backmarket/);
  assert.match(prompt, /Never estimate/);
  assert.match(prompt, /"pixel 8"/, "the user's own products are listed");
  // It must not invite a number the catalogue cannot store.
  assert.doesNotMatch(prompt, /wallapop/);
});

test("an imported price says whose hand supplied it, and when", () => {
  const line = provenanceLine({ source: "Back Market buyback page", observedAt: "2026-10-12", origin: "paste" });
  assert.equal(line, "Back Market buyback page, 2026-10-12");
});

test("an inbox row reads as one sentence", () => {
  const reference = makeInboxItem({ product: "pixel 8", kind: "trade_in_quote", amount: 120, source: "Back Market" }, { catalog: CATALOG });
  assert.match(inboxLine(reference), /payout quote: 120\.00 EUR for "pixel 8", from Back Market/);
  const product = makeInboxItem({ kind: "product", name: "Leica Q2", keyword: "leica q2" }, { catalog: [] });
  assert.match(inboxLine(product), /new product "Leica Q2"/);
});
