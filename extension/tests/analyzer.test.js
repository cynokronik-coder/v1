/**
 * The exact-phrase gate: "if I search for iPhone 13 256, only listings that say
 * iPhone 13 256 count".
 *
 * This is the one filter that can silently gut a whole comparison pool, so it is
 * tested from both directions: what it must accept, and what it must reject.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  containsPhrase,
  explainNoDeals,
  filterComparables,
  foldText,
  matchesProduct,
  phraseMatches,
  phraseRejections,
  requiredPhrase,
  searchableText,
  words,
} from "../src/core/analyzer.js";
import { makeListing, normalizeWatch } from "../src/core/models.js";

const listing = (title, over = {}) =>
  makeListing({
    marketplace: "mock",
    itemId: over.itemId || title,
    title,
    url: "https://example.invalid/x",
    price: over.price ?? 200,
    currency: "EUR",
    description: over.description ?? null,
    size: over.size ?? null,
    condition: over.condition ?? null,
  });

test("text is folded the way a person reads a listing title", () => {
  assert.equal(foldText("iPhone 13 256Go"), "iphone 13 256 go");
  assert.equal(foldText("IPHONE13"), "iphone 13");
  assert.equal(foldText("Très bon état"), "tres bon etat");
  assert.equal(foldText("Nike — Air  Max 90!"), "nike air max 90");
  assert.deepEqual(words("256Go,  reconditionné"), ["256", "go", "reconditionne"]);
});

test("a phrase matches consecutive whole words, not loose substrings", () => {
  assert.equal(containsPhrase("iPhone 13 256 Go bon état", "iphone 13 256"), true);
  assert.equal(containsPhrase("iPhone13 256Go", "iphone 13 256"), true);
  assert.equal(containsPhrase("apple iphone 13 pro max 256 go", "iphone 13 256"), false, "pro max is not the same product");
  assert.equal(containsPhrase("iPhone 130 256 Go", "iphone 13 256"), false, "13 must be a whole word");
  assert.equal(containsPhrase("iphone 14 256 go", "iphone 13 256"), false);
  assert.equal(containsPhrase("256 go iphone 13", "iphone 13 256"), false, "order matters: it is a phrase");
  assert.equal(containsPhrase("anything at all", ""), true, "an empty phrase constrains nothing");
});

test("the title is checked first and the description counts too", () => {
  const described = listing("Vends mobile", { description: "iPhone 13 256 Go, très bon état" });
  const watch = normalizeWatch({ name: "w", searchText: "iphone 13 256", exactPhrase: true });
  assert.equal(searchableText(described).includes("iPhone 13 256"), true);
  assert.equal(phraseMatches(described, watch), true);

  const wrong = listing("Vends mobile", { description: "iPhone 12 128 Go" });
  assert.equal(phraseMatches(wrong, watch), false);
});

test("the gate is off unless the watch asks for it (so a Python config behaves the same)", () => {
  assert.equal(normalizeWatch({ name: "w", searchText: "iphone 13 256" }).exactPhrase, false);
  assert.equal(normalizeWatch({ name: "w", searchText: "x", exact_phrase: true }).exactPhrase, true);
  const off = normalizeWatch({ name: "w", searchText: "iphone 13 256" });
  assert.equal(phraseMatches(listing("totally unrelated"), off), true);
  assert.equal(requiredPhrase(off), "");
  assert.equal(phraseRejections([listing("unrelated")], off), 0);
});

test("comparability and the no-deal explanation both report the phrase gate", () => {
  const watch = normalizeWatch({
    name: "iphone",
    searchText: "iphone 13 256",
    exactPhrase: true,
    plausibleMinPrice: 100,
    plausibleMaxPrice: 900,
  });
  const pool = [
    listing("iPhone 13 256 Go", { price: 300 }),
    listing("iPhone 13 256 Go - écran cassé", { price: 150 }),
    listing("iPhone 13 Pro Max 256 Go", { price: 320 }),
    listing("coque iPhone 13", { price: 20 }),
  ];
  assert.deepEqual(
    filterComparables(pool, watch).map((l) => l.title),
    ["iPhone 13 256 Go", "iPhone 13 256 Go - écran cassé"],
  );
  assert.equal(phraseRejections(pool, watch), 2);

  // When the phrase gate is what emptied the pool, the explanation has to say so.
  const stats = { median: 300, usedSize: 10, currency: "EUR", mad: 30, sampleSize: 12 };
  const notes = explainNoDeals([listing("iPhone 14 128 Go")], stats, watch);
  assert.match(notes.join(" "), /exact phrase "iphone 13 256"/);
});

test("a listing that mentions the phrase but the wrong model is still the user's call", () => {
  // mustMatch / mustNotMatch stay the tool for model-level precision; the phrase
  // gate only answers "does it mention what I searched for".
  const watch = normalizeWatch({
    name: "iphone",
    searchText: "iphone 13",
    exactPhrase: true,
    mustNotMatch: ["pro max", "coque"],
    plausibleMinPrice: 50,
    plausibleMaxPrice: 900,
  });
  assert.equal(matchesProduct(listing("iPhone 13 Pro Max 256"), watch), false);
  assert.equal(matchesProduct(listing("Coque iPhone 13"), watch), false);
  assert.equal(matchesProduct(listing("iPhone 13 256 Go"), watch), true);
});
