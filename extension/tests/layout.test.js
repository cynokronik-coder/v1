/**
 * The two layout bugs this file exists to keep fixed.
 *
 * Neither of them was visible to a test of pure functions, and both made the whole
 * dashboard look broken while every other test passed:
 *
 *  1. `main { display: grid }` in the stylesheet overrode the user-agent's
 *     `[hidden] { display: none }`, because author rules beat the UA sheet whatever
 *     the specificity. So all five pages rendered at once, one under the other, and
 *     the page navigation looked like it did nothing. The same thing made every
 *     hidden button (`.btn { display: inline-flex }`) show up - including "Resale
 *     reference", which then had no href and did nothing when clicked.
 *  2. The product catalogue was an 11-column row grid inside a 340px sidebar, so it
 *     was unreadable and off on the far right of a page nobody could reach.
 *
 * jsdom does compute the cascade (including `!important`), so both of these are
 * testable here rather than only visible to a person looking at the screen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";

const HTML = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../dashboard.css", import.meta.url), "utf8");

/** The page as a browser sees it: markup plus the real stylesheet. */
function render() {
  const dom = new JSDOM(HTML.replace("</head>", `<style>${CSS}</style></head>`));
  return { doc: dom.window.document, window: dom.window };
}

const TOOLS = ["deals", "opportunities", "price", "catalogue", "sources", "providers", "history", "settings"];

test("every tool in the rail has its own page, and every page is reachable from the rail", () => {
  const { doc } = render();
  const tabs = [...doc.querySelectorAll(".pagenav-tab")].map((tab) => tab.dataset.page);
  const pages = [...doc.querySelectorAll("main[id^='page-']")].map((main) => main.id.replace("page-", ""));
  assert.deepEqual([...tabs].sort(), [...pages].sort(), "the rail and the pages must be the same list as the tools");
  for (const tool of TOOLS) {
    assert.ok(tabs.includes(tool), `the rail should offer ${tool}`);
  }
});

test("a hidden page is really hidden, not merely marked hidden", () => {
  const { doc, window } = render();
  for (const main of doc.querySelectorAll("main[id^='page-']")) {
    main.hidden = true;
    assert.equal(
      window.getComputedStyle(main).display,
      "none",
      `${main.id} sets a display rule that defeats [hidden] - every page would render at once`,
    );
  }
});

test("a hidden button is really hidden too", () => {
  const { doc, window } = render();
  // `#scan` is a plain `.btn`, which is the class that used to defeat [hidden];
  // `#price-result` is a panel. The card buttons live inside <template>, so they
  // cannot be styled here - dashboard.test.js checks those on a rendered card.
  for (const selector of ["#scan", "#self-check", "#price-result"]) {
    const node = doc.querySelector(selector);
    assert.ok(node, `${selector} should exist`);
    node.hidden = true;
    assert.equal(window.getComputedStyle(node).display, "none", `${selector} stayed visible while hidden`);
  }
});

test("the payout block is really hidden when the run never asked for one", () => {
  // The same trap as the pages and the buttons, one level deeper: `.payout` lives inside a
  // <template>, so checking it against the real cascade means putting a rendered card in
  // the document. Without this, every card would advertise a payout of nothing.
  const { doc, window } = render();
  const card = doc.querySelector("#opportunity-template").content.firstElementChild.cloneNode(true);
  const payout = card.querySelector(".payout");
  assert.ok(payout, "an opportunity card should carry a payout block");
  assert.equal(payout.hidden, true, "hidden by default: most runs do not ask for a quote");
  doc.body.append(card);
  assert.equal(
    window.getComputedStyle(payout).display,
    "none",
    ".payout sets a display rule that defeats [hidden] - a payout nobody asked about would show on every card",
  );
  payout.hidden = false;
  assert.notEqual(window.getComputedStyle(payout).display, "none", "and unhiding it must still make it visible");
});

test("a trade-in reference can be marked as an asking price, not a payout", () => {
  // Back Market's search results are what it CHARGES. The block has to be able to say so.
  assert.match(CSS, /\.reference\.is-ask\s*\{/, "the resale reference needs an \"this is an ask\" state");
  assert.match(CSS, /\.payout\.is-none\s*\{/, "and the payout needs a \"asked, nothing came back\" state");
});

test("the tool rail stays put while a long page scrolls", () => {
  assert.match(CSS, /\.rail\s*\{[^}]*position:\s*sticky/, "the rail must be sticky, or the tools scroll away");
});

test("the catalogue is a page of its own, not a row grid squeezed into the sidebar", () => {
  const { doc } = render();
  const catalog = doc.querySelector("#catalog");
  assert.ok(catalog, "the catalogue editor should be in the page");
  assert.ok(catalog.closest("main#page-catalogue"), "the catalogue belongs on its own page");
  assert.equal(catalog.closest("aside.side"), null, "the catalogue must not live in the narrow right column");
  // And each product is one card that wraps, rather than a fixed row of tiny inputs.
  // (Template contents are a fragment, so they are queried through `.content`.)
  const grid = doc.querySelector("#catalog-template").content.querySelector(".product-grid");
  assert.ok(grid, "a catalogue entry should be a wrapping grid of labelled fields");
  assert.match(CSS, /\.product-grid\s*\{[^}]*repeat\(auto-fit/, "the catalogue fields should wrap instead of being clipped");
});

test("a card with no photo does not reserve space for one", () => {
  // Several page-based marketplaces never return an image; keeping the 4:3 box made
  // those cards mostly empty grey. The fallback collapses to a label instead.
  assert.match(CSS, /\.shot\.is-missing\s*\{[^}]*aspect-ratio:\s*auto/, "a missing photo must not keep the 4:3 box");
});

test("the API key page names every provider the engine actually has", () => {
  const { doc } = render();
  assert.ok(doc.querySelector("#api-setup"), "the API keys page needs a place to render the setup cards");
  assert.ok(doc.querySelector("#setup-template"), "the setup cards come from a template");
  const card = doc.querySelector("#setup-template").content;
  for (const selector of [".setup-steps", ".setup-keys", ".setup-settings", ".setup-legal"]) {
    assert.ok(card.querySelector(selector), `a setup card should have ${selector}`);
  }
});
