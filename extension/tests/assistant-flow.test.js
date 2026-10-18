/**
 * The assistant path end to end, through the message API the dashboard uses.
 *
 * What this pins down is the promise the UI makes: an import cannot change a price by
 * itself, an unmatched number cannot be applied to a guess, a payout never becomes a
 * resale price, and a bridge that is unreachable does not break anything else.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_ALARM_NAME, createController } from "../src/background.js";
import { withAssistantQuote } from "../src/core/opportunity-scan.js";

const TOKEN = "0123456789abcdef0123456789abcdef01234567";

/** The extension APIs the controller touches, faked. */
function fakeChrome() {
  let storage = {};
  const alarms = new Map();
  return {
    alarms,
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
        create(id, options, cb) {
          cb?.(id);
        },
        clear(id, cb) {
          cb?.(true);
        },
      },
      tabs: { async create({ url }) { return { url }; } },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      alarms: {
        async create(name, info) {
          alarms.set(name, { name, ...info });
        },
        async get(name) {
          return alarms.get(name) ?? null;
        },
        async clear(name) {
          alarms.delete(name);
        },
      },
      cookies: { get(_options, cb) { cb(null); } },
      runtime: { getURL: (path) => `chrome-extension://fake/${path}`, lastError: null, id: "fake" },
    },
  };
}

async function setup(fetchImpl = async (url) => { throw new Error(`unexpected request: ${url}`); }) {
  const fake = fakeChrome();
  const controller = createController({ chrome: fake.api, fetchImpl, sleep: () => Promise.resolve(), random: () => 0.5 });
  await controller.init();
  return { ...fake, controller };
}

const importText = (payload) => JSON.stringify(payload);

async function importOne(harness, reference) {
  const result = await harness.controller.handleMessage({
    type: "importAssistant",
    text: importText({ references: [reference] }),
  });
  const state = await harness.controller.handleMessage({ type: "getState" });
  return { result, state, item: state.inbox[0] };
}

test("an import lands in the inbox as pending, and changes no price", async () => {
  const harness = await setup();
  const { result, state, item } = await importOne(harness, {
    product: "pixel 8",
    kind: "resale_ask",
    amount: 240,
    source: "eBay sold listing",
    note: "128 GB, good",
  });
  assert.equal(result.added, 1);
  assert.equal(state.inbox.length, 1);
  assert.equal(item.status, "pending");
  assert.equal(item.kind, "resale_ask");
  assert.equal(item.product, "pixel-8");

  const product = state.catalog.find((entry) => entry.id === "pixel-8");
  assert.equal(product.manualResalePrice, null, "an import must not touch a price by itself");
});

test("applying an asking price writes it, labelled as imported", async () => {
  const harness = await setup();
  const { item } = await importOne(harness, {
    product: "pixel 8",
    kind: "resale_ask",
    amount: 240,
    source: "eBay sold listing",
  });
  const applied = await harness.controller.handleMessage({ type: "decideInbox", id: item.id, action: "apply" });
  assert.equal(applied.item.status, "applied");

  const state = await harness.controller.handleMessage({ type: "getState" });
  const product = state.catalog.find((entry) => entry.id === "pixel-8");
  assert.equal(product.manualResalePrice, 240);
  assert.equal(product.manualResaleSource, "assistant");
  assert.equal(product.resaleSource, "manual");
  assert.match(product.manualResaleDetail, /eBay sold listing/);
  // And it is still in the inbox, marked, so the page can explain what happened.
  assert.equal(state.inbox[0].status, "applied");
});

test("applying a trade-in quote never pretends to be a resale price", async () => {
  const harness = await setup();
  const { item } = await importOne(harness, {
    product: "iphone 13 128",
    kind: "trade_in_quote",
    amount: 385,
    currency: "EUR",
    source: "Back Market buyback page",
  });
  await harness.controller.handleMessage({ type: "decideInbox", id: item.id, action: "apply" });

  const state = await harness.controller.handleMessage({ type: "getState" });
  const product = state.catalog.find((entry) => entry.id === "iphone-13");
  assert.equal(product.manualResalePrice, null, "a payout is not an asking price");
  assert.equal(harness.controller.store.appliedTradeInQuotes().length, 1);
});

test("a number for a product nobody recognises has to be attached before it can be applied", async () => {
  const harness = await setup();
  const { item } = await importOne(harness, {
    product: "leica q2",
    kind: "resale_ask",
    amount: 2400,
    source: "eBay",
  });
  assert.equal(item.product, null);
  await assert.rejects(
    () => harness.controller.handleMessage({ type: "decideInbox", id: item.id, action: "apply" }),
    /not attached to a catalogue product/,
  );

  const attached = await harness.controller.handleMessage({ type: "attachInbox", id: item.id, product: "pixel-8" });
  assert.equal(attached.item.product, "pixel-8");
  const applied = await harness.controller.handleMessage({ type: "decideInbox", id: item.id, action: "apply" });
  assert.equal(applied.item.status, "applied");
});

test("a product suggestion becomes a catalogue entry only when applied", async () => {
  const harness = await setup();
  const imported = await harness.controller.handleMessage({
    type: "importAssistant",
    text: importText({
      products: [{ kind: "product", name: "Leica Q2", keyword: "leica q2", category: "cameras", plausibleMinPrice: 1500, plausibleMaxPrice: 3200 }],
    }),
  });
  assert.equal(imported.added, 1);
  let state = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(state.catalog.some((entry) => entry.keyword === "leica q2"), false);

  const applied = await harness.controller.handleMessage({ type: "decideInbox", id: state.inbox[0].id, action: "apply" });
  assert.equal(applied.opened, "catalogue");
  state = await harness.controller.handleMessage({ type: "getState" });
  const added = state.catalog.find((entry) => entry.keyword === "leica q2");
  assert.ok(added, "the catalogue gained the product");
  assert.equal(added.category, "cameras");
});

test("dismissing keeps the row but takes it out of the queue", async () => {
  const harness = await setup();
  const { item } = await importOne(harness, { product: "pixel 8", kind: "resale_ask", amount: 240 });
  const dismissed = await harness.controller.handleMessage({ type: "decideInbox", id: item.id, action: "dismiss" });
  assert.equal(dismissed.item.status, "dismissed");
  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(state.inbox.filter((entry) => entry.status === "pending").length, 0);
});

test("a garbage payload is refused with the assistant's own mistake named", async () => {
  const harness = await setup();
  await assert.rejects(
    () => harness.controller.handleMessage({ type: "importAssistant", text: "I could not find a price." }),
    /not JSON/,
  );
});

test("the bridge is pulled, acknowledged as received, and reported again when decided", async () => {
  const acks = [];
  const fetchImpl = async (url, init = {}) => {
    const address = String(url);
    if (address.includes("/pull/")) {
      return new Response(
        JSON.stringify({
          items: [
            { id: "q1", kind: "reference", payload: { product: "iphone 13 128", kind: "trade_in_quote", amount: 385, source: "Back Market buyback page" } },
          ],
        }),
        { status: 200 },
      );
    }
    if (address.includes("/ack/")) {
      acks.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, settled: 1 }), { status: 200 });
    }
    throw new Error(`unexpected request: ${address}`);
  };
  const harness = await setup(fetchImpl);
  await harness.controller.handleMessage({
    type: "setSettings",
    settings: { bridgeUrl: "https://bridge.test", bridgeToken: TOKEN, bridgeEnabled: true, bridgePollMinutes: 5 },
  });
  assert.ok(harness.alarms.has(BRIDGE_ALARM_NAME), "the poll alarm is scheduled once the bridge is configured");

  const pulled = await harness.controller.handleMessage({ type: "bridgePull", reason: "test" });
  assert.equal(pulled.pulled, 1);
  assert.equal(pulled.added, 1);
  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.equal(state.inbox[0].origin, "bridge");
  assert.equal(state.inbox[0].bridgeId, "q1");
  assert.deepEqual(acks[0], { results: [{ id: "q1", status: "received" }] });

  await harness.controller.handleMessage({ type: "decideInbox", id: state.inbox[0].id, action: "apply" });
  assert.deepEqual(acks.at(-1), { results: [{ id: "q1", status: "applied" }] });
});

test("turning the bridge off clears the alarm instead of leaving it firing", async () => {
  const harness = await setup();
  await harness.controller.handleMessage({
    type: "setSettings",
    settings: { bridgeUrl: "https://bridge.test", bridgeToken: TOKEN, bridgeEnabled: true },
  });
  assert.ok(harness.alarms.has(BRIDGE_ALARM_NAME));
  await harness.controller.handleMessage({ type: "setSettings", settings: { bridgeEnabled: false } });
  assert.equal(harness.alarms.has(BRIDGE_ALARM_NAME), false);
});

test("an unreachable bridge is a message, not a broken worker", async () => {
  const harness = await setup(async () => {
    throw new TypeError("fetch failed");
  });
  await harness.controller.handleMessage({
    type: "setSettings",
    settings: { bridgeUrl: "https://bridge.test", bridgeToken: TOKEN, bridgeEnabled: true },
  });
  await assert.rejects(() => harness.controller.handleMessage({ type: "bridgePull" }), /could not be reached/);
  // The rest of the extension still works.
  const state = await harness.controller.handleMessage({ type: "getState" });
  assert.ok(state.catalog.length > 0);
});

test("an imported quote only fills a payout the page left empty", () => {
  const product = { id: "iphone-13", name: "iPhone 13", category: "phones" };
  const quote = { kind: "trade_in_quote", status: "applied", product: "iphone-13", amount: 385, currency: "EUR", source: "Back Market buyback page" };

  const measured = { measured: true, gross: 420, net: 360, origin: undefined };
  assert.equal(withAssistantQuote({ payout: measured, product, references: [quote] }), measured, "the page wins");

  const notes = [];
  const filled = withAssistantQuote({ payout: { measured: false, url: "https://example/flow" }, product, references: [quote], notes });
  assert.equal(filled.measured, true);
  assert.equal(filled.origin, "assistant");
  assert.equal(filled.gross, 385);
  assert.ok(filled.net < filled.gross, "the commission and logistics still come off");
  assert.match(notes.join(" "), /quote you imported/);

  const pending = { ...quote, status: "pending" };
  const untouched = withAssistantQuote({ payout: null, product, references: [pending] });
  assert.equal(untouched, null, "a pending quote is not used before the user applies it");

  const other = { ...quote, product: "pixel-8" };
  assert.equal(withAssistantQuote({ payout: null, product, references: [other] }), null);
});
