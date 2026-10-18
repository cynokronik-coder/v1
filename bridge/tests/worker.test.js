/**
 * The bridge, tested against real SQL.
 *
 * A hand-written fake D1 would only prove that the fake agrees with itself, and every
 * interesting question here is a SQL question: does the claim UPDATE really take the
 * rows, does `ON CONFLICT (token, idem)` really deduplicate, does an expired claim
 * really come back. Node 24 ships `node:sqlite`, so these tests open a real in-memory
 * database and hand the worker a shim that implements the three D1 methods it uses.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker, { __testing } from "../src/worker.js";

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

/** The D1 surface `src/worker.js` actually uses, over node:sqlite. */
function d1(db) {
  const params = (list) => list.map((value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value));
  const run = (sql, list) => db.prepare(sql).run(...params(list));
  return {
    prepare(sql) {
      const make = (list) => ({
        async all() {
          return { results: db.prepare(sql).all(...params(list)) };
        },
        async run() {
          return { success: true, meta: { changes: Number(run(sql, list).changes) } };
        },
      });
      return { ...make([]), bind: (...list) => make(list) };
    },
  };
}

function harness({ token = TOKEN } = {}) {
  const db = new DatabaseSync(":memory:");
  const env = { DB: d1(db) };
  const call = (path, init = {}) => worker.fetch(new Request(`https://bridge.test${path}`, init), env);
  const rpc = async (method, params = {}, id = 1) => {
    const response = await call(`/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const tool = async (name, args = {}) => {
    const { body } = await rpc("tools/call", { name, arguments: args });
    return { result: body?.result, text: body?.result?.content?.[0]?.text, isError: Boolean(body?.result?.isError) };
  };
  const pull = async (limit = 20, tokenOverride = token) => {
    const response = await call(`/pull/${tokenOverride}?limit=${limit}`, { method: "GET" });
    return { status: response.status, body: await response.json() };
  };
  const ack = async (results, tokenOverride = token) => {
    const response = await call(`/ack/${tokenOverride}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { db, env, call, rpc, tool, pull, ack };
}

test("health answers without a token", async () => {
  const { call } = harness();
  const response = await call("/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "marketwatch-bridge");
});

test("a missing token is a 404, not an open door", async () => {
  const { call } = harness();
  assert.equal((await call("/mcp")).status, 404);
  assert.equal((await call("/pull")).status, 404);
  assert.equal((await call("/mcp/short")).status, 404);
});

test("initialize echoes the client's protocol version and advertises tools", async () => {
  const { rpc } = harness();
  const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.name, "marketwatch-bridge");
  assert.equal(body.result.capabilities.tools.listChanged, false);
});

test("tools/list exposes both kinds and the closed marketplace list", async () => {
  const { rpc } = harness();
  const { body } = await rpc("tools/list");
  const names = body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["list_marketplaces", "queue_reference", "queue_product", "queue_status"]);
  const reference = body.result.tools.find((tool) => tool.name === "queue_reference");
  assert.deepEqual(reference.inputSchema.properties.kind.enum, ["resale_ask", "trade_in_quote"]);
  // "price" is not a kind: a model must choose which number it is talking about.
  assert.equal(reference.inputSchema.properties.price, undefined);
});

test("a queued reference is pulled once, then acknowledged", async () => {
  const { tool, pull, ack, call } = harness();
  const queued = await tool("queue_reference", {
    product: "iphone 13 128",
    kind: "trade_in_quote",
    amount: 385,
    source: "Back Market buyback page",
    note: "good condition",
  });
  assert.equal(queued.isError, false);
  const receipt = JSON.parse(queued.text);
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.kind, "trade_in_quote");

  const first = await pull();
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].payload.amount, 385);
  assert.equal(first.body.items[0].payload.kind, "trade_in_quote");
  assert.equal(first.body.items[0].payload.product, "iphone 13 128");

  // Claimed, so a second pull gets nothing: two devices never ingest one number twice.
  assert.equal((await pull()).body.items.length, 0);

  const settled = await ack([{ id: first.body.items[0].id, status: "applied" }]);
  assert.equal(settled.body.settled, 1);

  const status = await call(`/status/${TOKEN}`);
  const counts = await status.json();
  assert.equal(counts.applied, 1);
  assert.equal(counts.pending, 0);
});

test("the same number queued twice is stored once", async () => {
  const { tool, pull } = harness();
  const args = { product: "pixel 8", kind: "resale_ask", amount: 240, source: "eBay" };
  const first = await tool("queue_reference", args);
  const second = await tool("queue_reference", args);
  assert.equal(JSON.parse(first.text).queued, JSON.parse(second.text).queued);
  assert.equal((await pull()).body.items.length, 1);
});

test("an abandoned claim returns to the queue after the TTL", async () => {
  const { tool, pull, db } = harness();
  await tool("queue_reference", { product: "switch oled", kind: "resale_ask", amount: 180, source: "eBay" });
  assert.equal((await pull()).body.items.length, 1);
  // Pretend the tab died ten minutes ago.
  db.prepare(`UPDATE items SET claimed_at = ?`).run(new Date(Date.now() - 11 * 60 * 1000).toISOString());
  const again = await pull();
  assert.equal(again.body.items.length, 1, "a closed laptop must not eat the item");
});

test("tokens are isolated from each other", async () => {
  const { tool, pull } = harness();
  await tool("queue_reference", { product: "iphone 13", kind: "resale_ask", amount: 300, source: "eBay" });
  assert.equal((await pull(20, OTHER)).body.items.length, 0);
  assert.equal((await pull()).body.items.length, 1);
});

test("a kind that is neither of the two is refused, and nothing is queued", async () => {
  const { tool, pull } = harness();
  const result = await tool("queue_reference", { product: "iphone 13", kind: "price", amount: 300 });
  assert.equal(result.isError, true);
  assert.match(result.text, /resale_ask/);
  assert.equal((await pull()).body.items.length, 0);
});

test("a nonsense amount is refused", async () => {
  const { tool } = harness();
  for (const amount of [0, -5, "385 EUR", 1_000_000]) {
    const result = await tool("queue_reference", { product: "x", kind: "resale_ask", amount });
    assert.equal(result.isError, true, `amount ${amount} should be refused`);
  }
});

test("an invented marketplace is refused by queue_product", async () => {
  const { tool } = harness();
  const result = await tool("queue_product", { name: "Pixel 8", keyword: "pixel 8", buyMarket: ["wallapop"] });
  assert.equal(result.isError, true);
  assert.match(result.text, /wallapop/);
});

test("a product suggestion is queued with the product kind", async () => {
  const { tool, pull } = harness();
  const queued = await tool("queue_product", {
    name: "iPhone 13",
    keyword: "iphone 13 128",
    category: "phones",
    minPrice: 200,
    maxPrice: 600,
    buyMarket: ["vinted", "leboncoin"],
    resaleSources: ["ebay", "backmarket"],
  });
  assert.equal(queued.isError, false);
  const item = (await pull()).body.items[0];
  assert.equal(item.kind, "product");
  assert.equal(item.payload.keyword, "iphone 13 128");
  assert.equal(item.payload.plausibleMaxPrice, 600);
});

test("queue_status counts what is waiting", async () => {
  const { tool } = harness();
  await tool("queue_reference", { product: "a", kind: "resale_ask", amount: 10 });
  await tool("queue_reference", { product: "b", kind: "resale_ask", amount: 20 });
  const status = await tool("queue_status");
  assert.equal(JSON.parse(status.text).pending, 2);
});

test("the stream endpoint is refused rather than left hanging", async () => {
  const { call } = harness();
  assert.equal((await call(`/mcp/${TOKEN}`, { method: "GET" })).status, 405);
  assert.equal((await call(`/pull/${TOKEN}`, { method: "POST" })).status, 405);
});

test("an unknown method or tool is a JSON-RPC error, not a crash", async () => {
  const { rpc } = harness();
  const method = await rpc("resources/list");
  assert.equal(method.body.error.code, -32601);
  const missing = await rpc("tools/call", { name: "delete_everything", arguments: {} });
  assert.equal(missing.body.error.code, -32602);
});

test("garbage in the body is a 400, not a 500", async () => {
  const { call } = harness();
  const response = await call(`/mcp/${TOKEN}`, { method: "POST", body: "not json" });
  assert.equal(response.status, 400);
});

test("a rate-limited token is told so", async () => {
  const { tool } = harness();
  for (let index = 0; index < __testing.RATE_PER_MINUTE; index += 1) {
    const queued = await tool("queue_reference", { product: `item ${index}`, kind: "resale_ask", amount: 10 + index });
    assert.equal(queued.isError, false);
  }
  const over = await tool("queue_reference", { product: "one more", kind: "resale_ask", amount: 99 });
  assert.equal(over.isError, true);
  assert.match(over.text, /rate limit/);
});

test("no DB binding says so instead of pretending", async () => {
  const response = await worker.fetch(new Request(`https://bridge.test/pull/${TOKEN}`), {});
  assert.equal(response.status, 503);
});

/**
 * The one duplication that could rot: the marketplace list in the worker.
 *
 * If the extension gains or renames a source, this test fails here rather than the
 * model being handed a name the extension will reject.
 */
test("the worker's marketplace mirror matches the extension registry", async () => {
  const { SOURCES } = await import("../../extension/src/core/sources.js");
  const { CATEGORIES } = await import("../../extension/src/core/catalog.js");
  const buy = SOURCES.filter((source) => source.buying && source.id !== "mock").map((source) => source.id).sort();
  const resale = SOURCES.filter((source) => source.resale && source.id !== "mock").map((source) => source.id).sort();
  assert.deepEqual(__testing.MARKETPLACES.buy.map(([id]) => id).sort(), buy);
  assert.deepEqual(__testing.MARKETPLACES.resale.map(([id]) => id).sort(), resale);
  assert.deepEqual(__testing.CATEGORIES, CATEGORIES);
});
