/**
 * The shared extractor: the one piece of code every page-based marketplace depends
 * on. If it reads a price wrong, ten marketplaces report the wrong market.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  absoluteUrl,
  collectProducts,
  decodeEntities,
  extractEmbeddedJson,
  extractJsonLd,
  listingsFromEmbeddedJson,
  listingsFromJsonLd,
  listingsFromMarkup,
  looksLikeLoginWall,
  parseSearchHtml,
  toFloat,
} from "../src/core/adapters/html-extract.js";

const ld = (payload) => `<html><head><script type="application/ld+json">${JSON.stringify(payload)}</script></head><body></body></html>`;

test("prices are read the way the sites actually write them", () => {
  assert.equal(toFloat(199.9), 199.9);
  assert.equal(toFloat("199.90"), 199.9);
  assert.equal(toFloat("199,90 €"), 199.9);
  assert.equal(toFloat("1 234,56 €"), 1234.56);
  assert.equal(toFloat("1,234.56"), 1234.56);
  assert.equal(toFloat("1.234,56"), 1234.56);
  assert.equal(toFloat({ amount: "250.00", currencyCode: "EUR" }), 250);
  assert.equal(toFloat({ value: 12 }), 12);
  assert.equal(toFloat("gratuit"), null);
  assert.equal(toFloat(""), null);
  assert.equal(toFloat(null), null);
  assert.equal(toFloat(true), null);
});

test("JSON-LD ItemList is read as the site intended it", () => {
  const html = ld({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: {
          "@type": "Product",
          name: "iPhone 13 128 Go",
          url: "https://www.vinted.fr/items/42",
          sku: "42",
          brand: { name: "Apple" },
          offers: { "@type": "Offer", price: "249.00", priceCurrency: "EUR", itemCondition: "https://schema.org/UsedCondition" },
        },
      },
    ],
  });
  const { items, source } = parseSearchHtml(html, { marketplace: "vinted", domain: "www.vinted.fr" });
  assert.equal(source, "json-ld");
  assert.equal(items.length, 1);
  assert.equal(items[0].marketplace, "vinted");
  assert.equal(items[0].price, 249);
  assert.equal(items[0].itemId, "42");
  assert.equal(items[0].brand, "Apple");
  assert.equal(items[0].condition, "occasion");
  assert.equal(items[0].currency, "EUR");
});

test("an embedded app payload is read, and relative links are made absolute", () => {
  const payload = {
    props: {
      pageProps: {
        results: [
          { itemId: "a1", title: "PlayStation 5 slim", price: "399,99", href: "/product/ps5", condition: "reconditionné" },
          { itemId: "a2", title: "no price here" },
        ],
      },
    },
  };
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
  const { items, source } = parseSearchHtml(html, { marketplace: "cdiscount", domain: "www.cdiscount.com" });
  assert.equal(source, "embedded-json");
  assert.equal(items.length, 1, "a row without a price is not a listing");
  assert.equal(items[0].price, 399.99);
  assert.equal(items[0].url, "https://www.cdiscount.com/product/ps5");
  assert.equal(items[0].condition, "reconditionné");
});

test("the same product in two containers is one listing, not two", () => {
  const payload = { items: [{ id: 1, title: "RTX 3060", price: 210 }], also: [{ id: 1, title: "RTX 3060", price: 210 }] };
  const listings = listingsFromEmbeddedJson([payload], { marketplace: "fnac", domain: "www.fnac.com" });
  assert.equal(listings.length, 1);
});

test("markup is the last resort, and it is narrow on purpose", () => {
  const html = `
    <ul>
      <li><a href="/annonce/1">Bureau en chêne massif</a><span class="price">120 €</span></li>
      <li><a href="/annonce/2">Chaise de bureau</a><span class="price">sur demande</span></li>
      <li><a href="/aide">Comment ça marche</a></li>
    </ul>`;
  const items = listingsFromMarkup(html, { marketplace: "leboncoin", domain: "www.leboncoin.fr" });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Bureau en chêne massif");
  assert.equal(items[0].price, 120);
  assert.equal(items[0].url, "https://www.leboncoin.fr/annonce/1");
});

test("a page with nothing recognisable yields nothing, and says so", () => {
  const { items, source } = parseSearchHtml("<html><body><h1>Résultats</h1></body></html>", { marketplace: "fnac" });
  assert.deepEqual(items, []);
  assert.equal(source, null, "no strategy worked, so the caller must report that rather than an empty market");
});

test("a sign-in wall is recognised for what it is", () => {
  assert.equal(looksLikeLoginWall("<div>Connectez-vous pour continuer</div>"), true);
  assert.equal(looksLikeLoginWall("<div>Vous devez vous connecter</div>"), false);
  assert.equal(looksLikeLoginWall("<div>3 résultats</div>"), false);
});

test("helpers: entity decoding, absolute URLs, and no crash on junk", () => {
  assert.equal(decodeEntities("Caf&eacute; &amp; croissants &#39;sp&eacute;cial&#39;"), "Café & croissants 'spécial'");
  assert.equal(absoluteUrl("/x/y", "www.vinted.fr"), "https://www.vinted.fr/x/y");
  assert.equal(absoluteUrl("https://x.test/a", "www.vinted.fr"), "https://x.test/a");
  assert.equal(absoluteUrl(null, "www.vinted.fr"), "https://www.vinted.fr/");
  assert.equal(absoluteUrl(null, ""), "");
  assert.deepEqual(extractJsonLd("<p>no scripts</p>"), []);
  assert.deepEqual(extractEmbeddedJson("<p>nothing</p>"), []);
  assert.deepEqual(collectProducts(null), []);
  assert.deepEqual(collectProducts({ a: 1 }), []);
  assert.deepEqual(listingsFromJsonLd([], { marketplace: "x" }), []);
});
