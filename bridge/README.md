# marketwatch bridge

A tiny queue an AI assistant can post to, which the [extension](../extension) collects
from. One Worker, one D1 table, no dependencies, no build step.

## Why it exists

A browser extension cannot be *sent* anything. An MV3 service worker has no listening
socket, cannot open one, and is not a server; the dashboard is a page. A ChatGPT connector
or MCP client, meanwhile, can only call a public HTTPS endpoint. Something has to sit
between them, and that something is a mailbox the extension checks.

```
ChatGPT ──tool call──▶ POST /mcp/<token>        Worker + D1
                            │ validate shape, rate limit, dedupe
                            ▼
                       items(status=pending)
                            ▲
Extension ──GET /pull/<token>──┘   claim → hand out
     │ validate with the same code the paste box uses
     ▼
  review inbox ──user clicks Apply──▶ catalogue / payout
     │
     └──POST /ack/<token> {applied | rejected | received}
```

The extension polls on its own alarm (`bridgePollMinutes`, 15 by default), so a laptop
that was asleep simply means the numbers waited. Nothing is ever pushed at it.

## What it deliberately is not

- **Not a store of prices.** Items are deleted seven days after they are settled.
- **Not a read path into the extension.** The bridge is never told what the user is
  watching, what was scanned, or what a run found. The assistant therefore cannot see any
  of it. That is a design decision, not an omission.
- **Not authoritative.** It validates *shape*; whether a number is credible is decided by
  `extension/src/core/assistant.js`, and whether it is used is decided by a human click.
- **Not an account system.** The token in the URL *is* the account. Each install makes its
  own; the queue is namespaced by `sha256(token)`. One deployment can therefore serve every
  install without any of them seeing each other's items.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `{ok, service, version, time}`. No token. |
| `POST` | `/mcp/<token>` | MCP over JSON-RPC: `initialize`, `tools/list`, `tools/call`, `ping`. Stateless (no session header), JSON responses only - a `GET` is answered `405` rather than left hanging. |
| `GET` | `/pull/<token>?limit=20` | Claim up to 50 pending items. Claimed items are not offered again for 10 minutes, then they return to the queue. |
| `POST` | `/ack/<token>` | `{results: [{id, status, reason?}]}` with status `received`, `applied` or `rejected`. |
| `GET` | `/status/<token>` | Counts by status. |

Tools exposed to the model:

| Tool | Why it exists |
|---|---|
| `list_marketplaces` | Hands the model the marketplace ids and categories this build actually has, so it cannot invent one. `bridge/tests/worker.test.js` fails if this list drifts from `extension/src/core/sources.js`. |
| `queue_reference` | One price, with `kind` forced to `resale_ask` (what a buyer is charged) or `trade_in_quote` (what a refurbisher pays). There is no generic "price". |
| `queue_product` | A catalogue suggestion. |
| `queue_status` | How many are waiting or applied, so the model can answer "did that work?". |

## Schema

Created by the worker on first use (`CREATE TABLE IF NOT EXISTS`), because there is no SQL
console in this deployment path:

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,        -- uuid
  token TEXT NOT NULL,        -- sha256 of the install token, never the token
  kind TEXT NOT NULL,         -- 'reference' | 'product'
  payload TEXT NOT NULL,      -- JSON, validated again by the extension
  source TEXT, note TEXT,
  idem TEXT NOT NULL,         -- sha256(kind + payload): a retried tool call is not a second row
  status TEXT NOT NULL,       -- pending | claimed | received | applied | rejected
  created_at TEXT NOT NULL,
  claimed_at TEXT, settled_at TEXT, reason TEXT,
  UNIQUE (token, idem)
);
CREATE INDEX items_by_token ON items (token, status, created_at);
```

## Run it locally

```bash
cd bridge
npx wrangler dev --local --port 8787
node tests/smoke.mjs http://127.0.0.1:8787 0123456789abcdef0123456789abcdef01234567
```

`tests/smoke.mjs` walks the whole cycle over HTTP - initialize, tools/list, queue, pull,
double-pull, ack, status - and works against the deployed worker too.

```bash
node --test tests/*.test.js   # 19 tests, the worker's real SQL against node:sqlite
```

The unit tests open an in-memory SQLite database and hand the worker a shim that
implements the three D1 methods it uses, so the claim `UPDATE`, the `ON CONFLICT`
dedupe and the expired-claim reset are exercised as SQL rather than against a hand-written
fake.

## Deploy

The worker is deployed through the Sites tooling with `sites.manifest.json` (one ESM
module, no assets, no build), and its D1 binding is named `DB`. Compatibility date
`2026-10-18`. If you deploy your own copy, put its address in the extension under
**Assistant → bridge address** (or `bridgeUrl` in settings) and generate a token there.

## Security model

- **The token is a capability.** It rides in the URL path, which is what makes a
  paste-into-a-connector setup possible at all: ChatGPT's MCP connectors cannot send a
  customer-provided API key. Treat the address like an incoming-webhook URL. Regenerating
  the token in the dashboard revokes the old one immediately, because the queue is keyed by
  its hash.
- **Only hashes are stored**, so a dump of the table does not hand out working tokens.
- **Rate limited** to 30 items per minute per token, 50 per pull, 64 KiB per request.
- **No CORS headers.** A model calls this server-side, and the extension reaches the
  queue through its own host permission (`*.freebuff.page` in `manifest.json`), which is
  not subject to CORS. A random browser tab therefore cannot read or write the queue even
  if it learns a token: the browser refuses the response. If you deploy your own copy,
  add its host to the extension's `host_permissions` - and keep CORS off.
- **A post can only add a row.** There is no delete, no update of anything outside its own
  token's queue, and no read of the extension's state.
