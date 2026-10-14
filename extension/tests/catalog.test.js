/** The product catalogue: the seed, its validation, and the request estimate. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  DEFAULT_CATALOG,
  estimatedRequests,
  findCatalogItem,
  normalizeCatalog,
  normalizeCatalogItem,
} from "../src/core/catalog.js";
import { RESALE_SOURCES } from "../src/core/models.js";

test("the seed catalogue is valid, and would tell you if it stopped being", () => {
  const items = normalizeCatalog(DEFAULT_CATALOG);
  assert.ok(items.length >= 20, "a wide analysis needs a wide starting list");
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) {
    assert.ok(item.keyword.length > 1, `${item.name} needs a usable keyword`);
    assert.ok(item.plausibleMinPrice < item.plausibleMaxPrice, `${item.name} has an empty price band`);
    assert.ok(item.buyMarket.length > 0, `${item.name} has nowhere to buy from`);
    assert.ok(RESALE_SOURCES.includes(item.resaleSource), `${item.name} sells nowhere`);
    assert.ok(CATEGORIES.includes(item.category), `${item.name} has an unknown category`);
  }
  // A useful seed covers several categories and gives the trend engine something to read.
  assert.ok(new Set(items.map((item) => item.category)).size >= 8);
  assert.ok(items.filter((item) => item.wikipedia).length >= 15, "most seed products should have a public-interest article");
  assert.ok(items.every((item) => item.enabled), "the seed starts fully enabled");
});

test("an entry is normalised, not trusted", () => {
  const item = normalizeCatalogItem({ name: "iPhone 14 Pro", keyword: " iphone 14 pro " });
  assert.equal(item.id, "iphone-14-pro");
  assert.equal(item.keyword, "iphone 14 pro");
  assert.deepEqual(item.buyMarket, ["vinted", "leboncoin"]);
  assert.equal(item.resaleSource, "ebay");
  assert.equal(item.category, "other");
  assert.equal(item.enabled, true);

  const manual = normalizeCatalogItem({ id: "x", name: "N", keyword: "k", resaleSource: "manual", manualResalePrice: "199,90" });
  assert.equal(manual.manualResalePrice, 199.9);
  assert.equal(normalizeCatalogItem({ name: "N", keyword: "k", manualResalePrice: "" }).manualResalePrice, null);
});

test("a bad entry is rejected with a message worth showing", () => {
  assert.throws(() => normalizeCatalogItem({ keyword: "k" }), /has no name/);
  assert.throws(() => normalizeCatalogItem({ name: "N" }), /has no keyword/);
  assert.throws(() => normalizeCatalogItem({ name: "N", keyword: "k", plausibleMinPrice: 500, plausibleMaxPrice: 100 }), /must be below/);
  assert.throws(() => normalizeCatalogItem({ name: "N", keyword: "k", resaleSource: "wallapop" }), /unknown resaleSource/);
  assert.throws(() => normalizeCatalogItem({ name: "N", keyword: "k", manualResalePrice: -5 }), /positive number/);
  assert.throws(() => normalizeCatalog([{ id: "dupe", name: "A", keyword: "a" }, { id: "dupe", name: "B", keyword: "b" }]), /duplicate catalogue id/);
});

test("an empty catalogue falls back to the seed, an explicit empty one does not", () => {
  assert.equal(normalizeCatalog([]).length, DEFAULT_CATALOG.length);
  assert.deepEqual(normalizeCatalog([], { fallbackToSeed: false }), []);
  assert.equal(findCatalogItem(DEFAULT_CATALOG, "iphone-13").name.includes("iPhone 13"), true);
  assert.equal(findCatalogItem(DEFAULT_CATALOG, "nope"), null);
});

test("the request estimate counts bought and sold sides, and ignores disabled products", () => {
  const catalog = [
    normalizeCatalogItem({ name: "A", keyword: "a", buyMarket: ["vinted", "leboncoin"], resaleSource: "ebay" }),
    normalizeCatalogItem({ name: "B", keyword: "b", buyMarket: ["vinted"], resaleSource: "manual" }),
    normalizeCatalogItem({ name: "C", keyword: "c", buyMarket: ["vinted"], resaleSource: "ebay", enabled: false }),
  ];
  assert.equal(estimatedRequests(catalog), 4); // 2 + 1 buy requests, 1 resale request
});
