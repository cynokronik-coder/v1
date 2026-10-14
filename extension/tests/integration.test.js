/**
 * The dashboard and the service worker, wired to each other for real.
 *
 * Every other suite uses a fake on one side of the message channel. This one uses
 * the real `createController` behind the real `chrome.runtime.sendMessage` shape, so
 * it catches the class of bug unit tests cannot: the two sides disagreeing about
 * what a message is called, or what a reply contains. It runs the actual pipeline -
 * offline marketplace, real analyzer, real opportunity engine, real storage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { createController } from "../src/background.js";
import { fail, ok } from "../src/core/messages.js";

const HTML = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");

function fakeChrome() {
  let storage = {};
  return {
    storageData: () => storage,
    api: {
      storage: {
        local: {
          async get() {
            return { ...storage };
          },
          async set(next) {
            storage = { ...next };
          },
        },
      },
      notifications: {
        create(_id, _options, cb) {
          cb?.("id");
        },
        clear(_id, cb) {
          cb?.(true);
        },
      },
      tabs: {
        async create({ url }) {
          return { url };
        },
        async query() {
          return [];
        },
      },
      action: {
        async setBadgeText() {},
        async setBadgeBackgroundColor() {},
      },
      alarms: {
        async create(name, info) {
          this._map = this._map || new Map();
          this._map.set(name, { name, ...info, scheduledTime: Date.now() + (info.periodInMinutes || 15) * 60000 });
        },
        async get(name) {
          return this._map?.get(name) ?? null;
        },
      },
      cookies: {
        get(_options, cb) {
          cb(null);
        },
      },
      runtime: {
        getURL: (path) => `chrome-extension://abcdefghijklmnop/${path}`,
        lastError: null,
        id: "abcdefghijklmnop",
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
const text = (doc, selector) => doc.querySelector(selector)?.textContent.trim();

/** Boot the real dashboard against the real controller. */
async function openAgainstWorker({ seedDemoWatch = false } = {}) {
  const fake = fakeChrome();
  const controller = createController({
    chrome: fake.api,
    // No route answers: anything that reaches the network is a bug in this test.
    fetchImpl: async (url) => {
      throw new Error(`unexpected network request to ${url}`);
    },
    trendFetch: async () => ({ status: 404, body: "" }),
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    logger: () => {},
  });
  await controller.init();
  // The browser calls this from the onInstalled listener; here it happens before
  // the dashboard boots, exactly as it would on a fresh install.
  if (seedDemoWatch) await controller.seedDemoWatch();

  const dom = new JSDOM(HTML, { url: "https://dashboard.invalid/dashboard.html" });
  const win = dom.window;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.localStorage = win.localStorage;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.chrome = {
    runtime: {
      getURL: fake.api.runtime.getURL,
      // The extension's own transport: a message in, an envelope out.
      sendMessage: async (message) => {
        try {
          return ok(await controller.handleMessage(message));
        } catch (err) {
          return fail(err);
        }
      },
    },
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  await import(`../src/dashboard.js?integration=${Math.random()}`);
  await settle();
  globalThis.setInterval = realSetInterval;
  return { doc: win.document, controller, win };
}

test("the dashboard drives the real worker: scan, deal, star, history", async () => {
  const { doc, controller } = await openAgainstWorker({ seedDemoWatch: true });

  // On install the worker seeded the offline demo watch, and the dashboard is
  // showing it, rendered from real state.
  const state = await controller.handleMessage({ type: "getState" });
  assert.equal(state.watches.length, 1);
  assert.ok(state.catalog.length >= 20);
  assert.equal(doc.querySelectorAll("details.watch").length, 1, "the watch editor is rendered from real state");

  // Scan now: the real pipeline runs the offline marketplace end to end.
  doc.querySelector("#scan").click();
  await settle();
  await settle();
  const cards = [...doc.querySelectorAll("#deals .card")];
  assert.ok(cards.length >= 3, `expected the planted bargains to reach the UI, got ${cards.length}`);
  assert.match(cards[0].querySelector(".headline").textContent, /under .* market/);

  // Star the first one: the star must come back from the worker, not just locally.
  cards[0].querySelector(".act-star").click();
  await settle();
  assert.match(doc.querySelector("#deals .card .act-star").textContent, /★ Starred/);
  const starred = (await controller.handleMessage({ type: "getState" })).alerts.filter((alert) => alert.favourite);
  assert.equal(starred.length, 1, "the worker stored the favourite");

  doc.querySelector('.tab[data-favourites]').click();
  assert.equal(doc.querySelectorAll("#deals .card").length, 1);
  doc.querySelector('.tab[data-status="new"]').click();

  // Mark it bought from the card, and check the badge follows.
  doc.querySelector("#deals .card .act-bought").click();
  await settle();
  assert.equal((await controller.handleMessage({ type: "getState" })).alerts.find((a) => a.favourite).status, "bought");
});

test("an opportunities run from the dashboard computes real numbers, and lands in the history", async () => {
  const { doc, controller } = await openAgainstWorker();

  // One offline product, priced against a resale price typed by the user: no
  // network, no keys, and the full engine.
  await controller.handleMessage({
    type: "setCatalog",
    catalog: [
      {
        id: "demo-opp",
        name: "Offline demo product",
        keyword: "pixel 8",
        category: "phones",
        buyMarket: ["mock"],
        resaleSource: "manual",
        manualResalePrice: 320,
        plausibleMinPrice: 20,
        plausibleMaxPrice: 2000,
      },
    ],
  });
  await controller.handleMessage({ type: "setSettings", settings: { acknowledgeAll: true } });
  await controller.handleMessage({ type: "getState" }); // the dashboard's own poll

  doc.querySelector('.pagenav-tab[data-page="opportunities"]').click();
  doc.querySelector("#scan-opportunities").click();
  await settle();
  await settle();

  const card = doc.querySelector("#opportunities .opp");
  assert.ok(card, "the opportunities page rendered a card");
  assert.equal(card.querySelector(".chip-verdict").textContent, "buy");
  assert.match(card.querySelector(".opp-headline").textContent, /buy \d+\.\d\d EUR → sell 320\.00 EUR/);
  assert.match(card.querySelector(".opp-meta").textContent, /score \d+\/100 · demand \d+\/100/);
  assert.match(text(doc, "#banner"), /opportunities: 1 product\(s\) measured/);

  // And the run is in the history, which is the point of the History page.
  doc.querySelector('.pagenav-tab[data-page="history"]').click();
  const rows = [...doc.querySelectorAll("#history-body tr")];
  assert.ok(rows.some((row) => /opportunities/.test(row.textContent)), "the run shows up in the history table");
  assert.match(text(doc, "#history-hint"), /Every scan pass/);
});

test("the catalogue edited in the dashboard is the catalogue the worker stores", async () => {
  const { doc, controller, win } = await openAgainstWorker();
  doc.querySelector('.pagenav-tab[data-page="opportunities"]').click();
  assert.ok(doc.querySelectorAll("#catalog .catalog-row").length >= 20, "the seeded catalogue is editable in place");

  // Change the first row's keyword, add a product, save: the worker must end up with both.
  const first = doc.querySelector('#catalog [data-field="keyword"]');
  first.value = "iphone 13 256";
  first.dispatchEvent(new win.Event("input", { bubbles: true }));
  doc.querySelector("#add-catalog").click();
  const rows = [...doc.querySelectorAll("#catalog .catalog-row")];
  const added = rows.at(-1);
  added.querySelector('[data-field="name"]').value = "My product";
  added.querySelector('[data-field="keyword"]').value = "my product 42";
  added.querySelector('[data-field="manualResalePrice"]').value = "150,50";

  doc.querySelector("#save-catalog").click();
  await settle();

  const stored = (await controller.handleMessage({ type: "getState" })).catalog;
  assert.equal(stored.length, rows.length);
  assert.equal(stored[0].keyword, "iphone 13 256");
  assert.equal(stored.at(-1).name, "My product");
  assert.equal(stored.at(-1).manualResalePrice, 150.5, "a comma decimal from the user is understood");
});

test("the sources page shows the engine's real registry, and switching a source off sticks", async () => {
  const { doc, controller, win } = await openAgainstWorker();
  doc.querySelector('.pagenav-tab[data-page="sources"]').click();
  await settle();

  const rows = [...doc.querySelectorAll("#sources-list .source-row")];
  const state = await controller.handleMessage({ type: "getState" });
  assert.equal(rows.length, state.sources.length, "every registry source is rendered");
  assert.ok(rows.length >= 12, `expected the full marketplace list, got ${rows.length}`);
  assert.deepEqual(
    rows.map((row) => row.dataset.source),
    state.sources.map((source) => source.id),
  );

  // The one documented API is shown as such, and Facebook is off until asked for.
  const ebay = doc.querySelector('.source-row[data-source="ebay"]');
  assert.match(ebay.querySelector(".chip-access").textContent, /documented API/);
  assert.match(ebay.querySelector(".source-status").textContent, /needs credentials/);
  assert.equal(doc.querySelector('.source-row[data-source="facebook"] [data-field="enabled"]').checked, false);

  // Switching Vinted off in the UI must reach storage, and change the engine's view.
  const toggle = doc.querySelector('.source-row[data-source="vinted"] [data-field="enabled"]');
  toggle.checked = false;
  toggle.dispatchEvent(new win.Event("change"));
  await settle();
  await settle();

  const after = await controller.handleMessage({ type: "getState" });
  assert.equal(after.settings.sources.vinted.enabled, false);
  assert.equal(after.sources.find((source) => source.id === "vinted").enabled, false);
  assert.equal(doc.querySelector('.source-row[data-source="vinted"] [data-field="enabled"]').checked, false);
});
