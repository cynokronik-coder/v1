/**
 * marketwatch bridge - a queue an AI assistant can post to, that the extension pulls.
 *
 * Why this exists at all: a browser extension cannot be *sent* anything. An MV3
 * service worker has no listening socket, so the only way an assistant's answer can
 * reach one is a paste or a mailbox it can check. This is the mailbox.
 *
 * Deliberately three things and no more:
 *
 *   1. **An MCP server** at `/mcp/<token>`, so ChatGPT (or any MCP client) gets real
 *      tools with real schemas instead of being asked to "output JSON please". The
 *      tools are the safety boundary: a model can *name* an asking price or a payout
 *      and nothing else, and the marketplace ids it may use are handed to it rather
 *      than guessed by it.
 *   2. **A queue** in D1, one row per queued number, keyed by a hash of the install
 *      token. Nothing is applied here - the extension decides, after a human click.
 *   3. **A pull/ack pair** so a device that was asleep does not lose anything.
 *
 * What it deliberately is not: a store of prices, a reader of the user's data, or a
 * place where a number becomes a verdict. There is no read path from the extension's
 * state to this worker at all, which is the privacy answer to "can the model see my
 * scans?" - it cannot, because the bridge was never told.
 *
 * One file, no imports, no dependencies: that is what lets `sites_deploy` upload it
 * as a single module without a bundler, and what lets the tests import it in node.
 */

const SERVICE = "marketwatch-bridge";
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ITEMS = 50;
const RATE_PER_MINUTE = 30;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[a-z0-9]{24,80}$/i;
/** `received` = the extension has it in its review inbox; the rest are the user's verdict. */
const SETTLE_STATUSES = new Set(["received", "applied", "rejected"]);

/**
 * A mirror of `extension/src/core/sources.js`, kept small on purpose.
 *
 * The worker cannot import the extension's registry (a different deployment, no
 * bundler), but the model must not be able to invent `wallapop`. So this list is
 * duplicated and `bridge/tests/parity.test.js` fails if it drifts from the real
 * registry. A stale copy becomes a failing test rather than a wrong suggestion.
 */
const MARKETPLACES = {
  buy: [
    ["vinted", "Vinted"],
    ["leboncoin", "leboncoin"],
    ["ebay", "eBay (Browse API)"],
    ["backmarket", "Back Market"],
    ["fnac", "Fnac"],
    ["cdiscount", "Cdiscount"],
    ["easycash", "Easy Cash"],
    ["cashexpress", "Cash Express"],
    ["cashconverters", "Cash Converters"],
    ["momox", "momox"],
    ["facebook", "Facebook Marketplace"],
  ],
  resale: [
    ["ebay", "eBay (Browse API)"],
    ["backmarket", "Back Market"],
    ["vinted", "Vinted"],
    ["leboncoin", "leboncoin"],
    ["fnac", "Fnac"],
    ["cdiscount", "Cdiscount"],
    ["momox", "momox"],
    ["easycash", "Easy Cash"],
    ["cashexpress", "Cash Express"],
    ["cashconverters", "Cash Converters"],
  ],
};

const CATEGORIES = [
  "phones",
  "tablets",
  "laptops",
  "consoles",
  "pc-parts",
  "cameras",
  "audio",
  "wearables",
  "sneakers",
  "lego",
  "watches",
  "instruments",
  "tools",
  "appliances",
  "games",
  "bikes",
  "keyboards",
  "other",
];

const RESALE_IDS = [...new Set(MARKETPLACES.resale.map(([id]) => id))];
const BUY_IDS = [...new Set(MARKETPLACES.buy.map(([id]) => id))];

const TOOLS = [
  {
    name: "list_marketplaces",
    description:
      "The marketplaces this extension actually knows, split into where it can look for items to buy and where it can read a resale price. Call this before naming a marketplace anywhere else: any other name is rejected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "queue_reference",
    description:
      "Queue ONE price for review in the user's marketwatch extension. Use kind=resale_ask for an asking price that a buyer is charged, and kind=trade_in_quote for a payout a refurbisher offers the user for their own item. Only queue a number you can actually see; the extension shows it to the user, who decides whether to apply it.",
    inputSchema: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description: "The search text this price is about, ideally one of the user's catalogue keywords.",
        },
        kind: {
          type: "string",
          enum: ["resale_ask", "trade_in_quote"],
          description:
            "resale_ask = what a buyer is charged (a ceiling). trade_in_quote = what a refurbisher pays the user (a payout, lower).",
        },
        amount: { type: "number", description: "The number, in the item's currency. No symbols." },
        currency: { type: "string", description: "ISO code, e.g. EUR. Defaults to EUR." },
        source: { type: "string", description: "Where the number was read, e.g. 'Back Market buyback page'." },
        url: { type: "string", description: "Optional https link to the page the number came from." },
        note: { type: "string", description: "One line on what exactly this number is (storage, condition, date)." },
        observedAt: { type: "string", description: "YYYY-MM-DD, when the number was seen." },
      },
      required: ["product", "kind", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "queue_product",
    description:
      "Queue a product the user might want to add to their catalogue, for review. The extension samples it on both sides of the market on its next run.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Readable name, e.g. 'iPhone 13'." },
        keyword: { type: "string", description: "The search text to use on both sides." },
        category: { type: "string", enum: CATEGORIES },
        minPrice: { type: "number", description: "Below this, a listing is not this product." },
        maxPrice: { type: "number", description: "Above this, a listing is not this product." },
        buyMarket: { type: "array", items: { type: "string", enum: BUY_IDS } },
        resaleSources: { type: "array", items: { type: "string", enum: RESALE_IDS } },
      },
      required: ["name", "keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "queue_status",
    description: "How many items are waiting in the user's marketwatch review inbox, and which have been applied.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// --- small helpers ----------------------------------------------------------

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

const empty = (status, headers = {}) => new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The token is a capability, so it is only ever stored as a hash. */
function tokenFromPath(path, prefix) {
  if (!path.startsWith(prefix)) return null;
  const token = path.slice(prefix.length);
  return TOKEN_RE.test(token) ? token : null;
}

function seconds(ms) {
  return new Date(ms).toISOString();
}

// --- storage ----------------------------------------------------------------

/**
 * A tiny SQL helper over D1.
 *
 * The queue is four statements plus one index; wrapping them here keeps the SQL in
 * one place and makes the memory shim in the tests a fair imitation rather than a
 * second implementation.
 */
function sql(env) {
  return async (text, ...params) => {
    const statement = env.DB.prepare(text);
    const bound = params.length ? statement.bind(...params) : statement;
    if (/^\s*(select|with)/i.test(text)) {
      const result = await bound.all();
      return result?.results || [];
    }
    const result = await bound.run();
    return result?.meta || { changes: 0 };
  };
}

// Per env object, not per module: a test that builds several databases in one process
// must still get a table in each of them.
const schemaReady = new WeakSet();

/**
 * Create the table on first use.
 *
 * There is no SQL console in this deployment path, so the worker owns its own schema.
 * `IF NOT EXISTS` makes it safe to run once per isolate, and doing it here rather
 * than in a migration click is what makes "deploy and it works" true.
 */
async function ensureSchema(env) {
  if (schemaReady.has(env)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS items (
       id TEXT PRIMARY KEY,
       token TEXT NOT NULL,
       kind TEXT NOT NULL,
       payload TEXT NOT NULL,
       source TEXT,
       note TEXT,
       idem TEXT NOT NULL,
       status TEXT NOT NULL,
       created_at TEXT NOT NULL,
       claimed_at TEXT,
       settled_at TEXT,
       reason TEXT,
       UNIQUE (token, idem)
     )`,
  ).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS items_by_token ON items (token, status, created_at)`).run();
  schemaReady.add(env);
}

async function enqueue({ env, token, kind, payload, source = null, note = null, now = Date.now() }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  const idem = await sha256Hex(`${kind}|${JSON.stringify(payload)}`);

  // A model that retries after a timeout must not queue the same number twice.
  await query(
    `INSERT INTO items (id, token, kind, payload, source, note, idem, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(token, idem) DO NOTHING`,
    crypto.randomUUID(),
    tokenHash,
    kind,
    JSON.stringify(payload),
    source,
    note,
    idem,
    seconds(now),
  );

  const rows = await query(`SELECT id, status, created_at FROM items WHERE token = ? AND idem = ? LIMIT 1`, tokenHash, idem);
  const row = rows[0];
  return { id: row.id, status: row.status, duplicate: row.created_at !== seconds(now) };
}

/**
 * Hand out what is waiting, atomically enough.
 *
 * The claim is an UPDATE with the selection inside it, then a read back by the claim
 * stamp: two devices sharing a token therefore cannot both take the same row, and a
 * device that dies mid-pull gets its items back after the TTL instead of stranding
 * them as permanently "claimed".
 */
async function claim({ env, token, limit = MAX_ITEMS, now = Date.now() }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  const stamp = seconds(now);
  await query(
    `UPDATE items SET status = 'claimed', claimed_at = ?
     WHERE token = ? AND status = 'pending' AND id IN (
       SELECT id FROM items WHERE token = ? AND status = 'pending' ORDER BY created_at LIMIT ?
     )`,
    stamp,
    tokenHash,
    tokenHash,
    Math.min(MAX_ITEMS, Math.max(1, Number(limit) || MAX_ITEMS)),
  );
  const rows = await query(`SELECT * FROM items WHERE token = ? AND status = 'claimed' AND claimed_at = ? ORDER BY created_at`, tokenHash, stamp);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: safeJson(row.payload),
    source: row.source,
    createdAt: row.created_at,
  }));
}

/** Old claims go back to the queue: a closed laptop is not a decision. */
async function expireClaims({ env, token, now = Date.now() }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  await query(
    `UPDATE items SET status = 'pending', claimed_at = NULL WHERE token = ? AND status = 'claimed' AND claimed_at < ?`,
    tokenHash,
    seconds(now - CLAIM_TTL_MS),
  );
}

async function settle({ env, token, results = [], now = Date.now() }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  let settled = 0;
  for (const entry of results.slice(0, MAX_ITEMS)) {
    const id = String(entry?.id || "").trim();
    const requested = String(entry?.status || "");
    const status = SETTLE_STATUSES.has(requested) ? requested : "rejected";
    if (!id) continue;
    const meta = await query(
      `UPDATE items SET status = ?, settled_at = ?, reason = ? WHERE id = ? AND token = ?`,
      status,
      seconds(now),
      String(entry?.reason || "").slice(0, 300) || null,
      id,
      tokenHash,
    );
    if (meta?.changes) settled += 1;
  }
  return settled;
}

async function counts({ env, token }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  const rows = await query(`SELECT status, COUNT(*) AS n FROM items WHERE token = ? GROUP BY status`, tokenHash);
  const out = { pending: 0, claimed: 0, received: 0, applied: 0, rejected: 0, items: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    if (row.status in out) out[row.status] = n;
    out.items += n;
  }
  return out;
}

async function recent({ env, token, windowMs = 60_000, now = Date.now() }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  const rows = await query(`SELECT COUNT(*) AS n FROM items WHERE token = ? AND created_at > ?`, tokenHash, seconds(now - windowMs));
  return Number(rows[0]?.n) || 0;
}

async function prune({ env, token, now = Date.now() }) {
  const query = sql(env);
  const tokenHash = await sha256Hex(token);
  await query(
    `DELETE FROM items WHERE token = ? AND status IN ('applied', 'rejected', 'received') AND COALESCE(settled_at, created_at) < ?`,
    tokenHash,
    seconds(now - RETENTION_MS),
  );
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- the MCP surface --------------------------------------------------------

function rpc(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textResult(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const asText = (value) => JSON.stringify(value, null, 2);

/** Validation that stops at shape. Whether a number is *credible* is the extension's call. */
function validateReference(args) {
  const product = String(args?.product ?? "").trim();
  if (!product) return "product is required: the search text the price is about";
  if (product.length > 120) return "product is longer than 120 characters";
  const kind = String(args?.kind ?? "");
  if (kind !== "resale_ask" && kind !== "trade_in_quote") {
    return 'kind must be "resale_ask" (what a buyer is charged) or "trade_in_quote" (what a refurbisher pays)';
  }
  const amount = Number(args?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "amount must be a positive number";
  if (amount > 100000) return "amount is too large for a second-hand item";
  const currency = String(args?.currency ?? "EUR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return "currency must be a three-letter code such as EUR";
  if (args?.url && !/^https?:\/\//i.test(String(args.url))) return "url must start with http:// or https://";
  return null;
}

function referencePayload(args) {
  return {
    product: String(args.product).trim(),
    kind: args.kind,
    amount: Math.round(Number(args.amount) * 100) / 100,
    currency: String(args.currency ?? "EUR").toUpperCase(),
    source: String(args.source ?? "the assistant").slice(0, 60),
    url: args.url ? String(args.url) : null,
    note: String(args.note ?? "").slice(0, 400),
    observedAt: args.observedAt ? String(args.observedAt).slice(0, 10) : null,
  };
}

function validateProduct(args) {
  const name = String(args?.name ?? "").trim();
  const keyword = String(args?.keyword ?? "").trim();
  if (!name) return "name is required";
  if (!keyword) return "keyword is required: the search text to use on both sides";
  if (args?.category && !CATEGORIES.includes(args.category)) return `unknown category '${args.category}'`;
  for (const id of [].concat(args?.buyMarket || [])) {
    if (!BUY_IDS.includes(id)) return `unknown buyMarket '${id}' (expected ${BUY_IDS.join(" | ")})`;
  }
  for (const id of [].concat(args?.resaleSources || [])) {
    if (!RESALE_IDS.includes(id)) return `unknown resale source '${id}' (expected ${RESALE_IDS.join(" | ")})`;
  }
  const min = args?.minPrice === undefined ? null : Number(args.minPrice);
  const max = args?.maxPrice === undefined ? null : Number(args.maxPrice);
  if (min !== null && max !== null && min >= max) return "minPrice must be below maxPrice";
  return null;
}

function productPayload(args) {
  return {
    kind: "product",
    name: String(args.name).trim(),
    keyword: String(args.keyword).trim(),
    category: args.category || null,
    plausibleMinPrice: args.minPrice ?? null,
    plausibleMaxPrice: args.maxPrice ?? null,
    buyMarket: args.buyMarket || null,
    resaleSources: args.resaleSources || null,
  };
}

async function callTool(name, args, { env, token, now }) {
  switch (name) {
    case "list_marketplaces":
      return textResult(
        asText({
          buy: MARKETPLACES.buy.map(([id, label]) => ({ id, label })),
          resale: MARKETPLACES.resale.map(([id, label]) => ({ id, label })),
          categories: CATEGORIES,
          rule:
            "An asking price (resale_ask) is what a buyer is charged. A payout (trade_in_quote) is what a refurbisher pays the user, and it is lower.",
        }),
      );

    case "queue_reference": {
      const problem = validateReference(args);
      if (problem) return toolError(problem);
      if ((await recent({ env, token, now })) >= RATE_PER_MINUTE) {
        return toolError(`rate limit: ${RATE_PER_MINUTE} items per minute for this token. Ask the user before queueing more.`);
      }
      const payload = referencePayload(args);
      const queued = await enqueue({
        env,
        token,
        kind: "reference",
        payload,
        source: payload.source,
        note: payload.note,
        now,
      });
      return textResult(
        asText({
          queued: queued.id,
          status: queued.status,
          waitingFor: "the user to review it in the extension's Assistant page",
          kind: payload.kind,
          amount: payload.amount,
          currency: payload.currency,
        }),
        { structuredContent: { queued: queued.id, status: queued.status } },
      );
    }

    case "queue_product": {
      const problem = validateProduct(args);
      if (problem) return toolError(problem);
      if ((await recent({ env, token, now })) >= RATE_PER_MINUTE) {
        return toolError(`rate limit: ${RATE_PER_MINUTE} items per minute for this token.`);
      }
      const payload = productPayload(args);
      const queued = await enqueue({ env, token, kind: "product", payload, source: "the assistant", now });
      return textResult(
        asText({ queued: queued.id, status: queued.status, name: payload.name, keyword: payload.keyword }),
        { structuredContent: { queued: queued.id, status: queued.status } },
      );
    }

    case "queue_status": {
      const state = await counts({ env, token });
      return textResult(asText(state), { structuredContent: state });
    }

    default:
      return null;
  }
}

async function handleMcp(request, { env, token, now }) {
  let body;
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "request too large" }, 413);
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return json(rpcError(null, -32700, "parse error: the body is not JSON"), 400);
  }
  if (!body || typeof body !== "object") return json(rpcError(null, -32600, "invalid request"), 400);

  // A JSON-RPC notification has no id and expects no result body.
  const isNotification = body.id === undefined || body.id === null;
  const reply = async (message) => (isNotification ? empty(202) : json(message));

  switch (body.method) {
    case "initialize": {
      const requested = body.params?.protocolVersion;
      return reply(
        rpc(body.id, {
          // Echo the client's version when it offered one: this server has no state and
          // no streaming, so every version it is likely to be asked for behaves the same.
          protocolVersion: typeof requested === "string" && requested ? requested : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVICE, version: VERSION },
          instructions:
            "Queue prices for the user's marketwatch extension. Use resale_ask for what a buyer is charged and trade_in_quote for what a refurbisher pays. Nothing you queue changes the user's data until they apply it.",
        }),
      );
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return empty(202);
    case "ping":
      return reply(rpc(body.id, {}));
    case "tools/list":
      return reply(rpc(body.id, { tools: TOOLS }));
    case "tools/call": {
      const name = String(body.params?.name || "");
      if (!TOOLS.some((tool) => tool.name === name)) {
        return reply(rpcError(body.id, -32602, `unknown tool '${name}'`));
      }
      const result = await callTool(name, body.params?.arguments || {}, { env, token, now });
      return reply(rpc(body.id, result || toolError("that tool is not available")));
    }
    default:
      return reply(rpcError(body.id, -32601, `method '${body.method}' is not supported by this server`));
  }
}

// --- routing ----------------------------------------------------------------

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const now = Date.now();

  if (path === "/health") {
    return json({ ok: true, service: SERVICE, version: VERSION, time: seconds(now) });
  }

  const mcpToken = tokenFromPath(path, "/mcp/");
  const pullToken = tokenFromPath(path, "/pull/");
  const ackToken = tokenFromPath(path, "/ack/");
  const statusToken = tokenFromPath(path, "/status/");
  const token = mcpToken || pullToken || ackToken || statusToken;

  if (!token && ["/mcp", "/pull", "/ack", "/status"].some((prefix) => path.startsWith(prefix))) {
    // No token, no answer: this is the one place a 404 must not be ambiguous.
    return json({ error: "missing token" }, 404);
  }
  if (!token) return json({ error: "not found", service: SERVICE }, 404);
  if (!env?.DB) return json({ error: "the queue is not configured (no DB binding)" }, 503);

  await ensureSchema(env);

  if (mcpToken) {
    if (request.method !== "POST") return empty(405, { allow: "POST" });
    return handleMcp(request, { env, token, now });
  }

  if (pullToken) {
    if (request.method !== "GET") return empty(405, { allow: "GET" });
    await expireClaims({ env, token, now });
    const limit = Number(url.searchParams.get("limit") || 20);
    const items = await claim({ env, token, limit, now });
    if (items.length) await prune({ env, token, now });
    return json({ items });
  }

  if (ackToken) {
    if (request.method !== "POST") return empty(405, { allow: "POST" });
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "request too large" }, 413);
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json({ error: "the body is not JSON" }, 400);
    }
    const settled = await settle({ env, token, results: body?.results || [], now });
    return json({ ok: true, settled });
  }

  if (statusToken) {
    if (request.method !== "GET") return empty(405, { allow: "GET" });
    return json(await counts({ env, token }));
  }

  return json({ error: "not found", service: SERVICE }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      // Never leak a stack trace to a caller that only needed to know it failed.
      const message = String(error?.message || error).slice(0, 200);
      return json({ error: "the bridge failed", detail: message }, 500);
    }
  },
};

export const __testing = {
  MARKETPLACES,
  CATEGORIES,
  TOOLS,
  validateReference,
  validateProduct,
  handleMcp,
  claim,
  enqueue,
  settle,
  counts,
  expireClaims,
  TOKEN_RE,
  MAX_ITEMS,
  RATE_PER_MINUTE,
};
