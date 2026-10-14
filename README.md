# marketwatch

Scan a second-hand marketplace, estimate what a product is *actually* worth, and
list the listings priced well below that.

```
watches.yaml ──▶ adapter (vinted / leboncoin / ebay / mock) ──▶ comparability filters
                                                          │
                            robust baseline (median, MAD) ◀┘
                                     │
              candidates scored ─────┴──▶ discount% + robust z ──▶ deals
                                     │                            │
                             SQLite (seen / alerted / history) ◀──┘
```

The interesting part is not the scraping — it is deciding whether a price is
*actually* low. A mean over mixed listings (kids sizes, "case only", EUR 1
placeholder) will happily tell you everything is a bargain, so the baseline here
is a median with a MAD-based dispersion, guarded by filters that keep the pool
comparable to one product.

## Quickstart

```bash
uv sync --extra dev                 # install (or: pip install -e ".[dev]")
cp config/watches.example.yaml config/watches.yaml
$EDITOR config/watches.yaml         # define the products you care about

uv run marketwatch scan -w demo-offline -c config/watches.example.yaml
                                   # ^ zero-risk first run: the offline mock marketplace
uv run marketwatch doctor           # config + credentials + reachability
uv run marketwatch comps -w iphone-13-128     # inspect the comparable pool
uv run marketwatch scan  -w iphone-13-128     # one pass, table + optional --json/--csv
uv run marketwatch watch -w iphone-13-128 -i 300   # poll every 5 min, print new bargains
uv run marketwatch deals -n 20      # everything found so far, from SQLite
uv run marketwatch serve -w iphone-13-128 -i 300   # live dashboard + desktop notifications
```

`serve` is the alerting path: it prints a local URL, and once you click "Enable
desktop notifications" in that page, new bargains pop up as they are found. See
[Deal alerts](#deal-alerts).

`scan` exits **1** when it found deals and **0** when it found none, so it drops
straight into cron / CI:

```cron
*/15 * * * * cd /path/to/marketwatch && uv run marketwatch --quiet scan --csv out/deals.csv >> out/cron.log 2>&1
```

Global options (`--config`, `--db`, `--vinted-delay`, `--vinted-jitter`,
`--lbc-transport`, `--quiet`) go **before** the subcommand, as with any Click/Typer
app. `--webhook` deliberately does *not*: it belongs to the commands that alert.

## How the market price is estimated

For every watch, each pass:

1. **Sample the market** — `sample_pages` pages of the normal search (cached for
   `comps_ttl_seconds`, because that is the expensive part).
2. **Keep only comparable listings** — title regexes (`must_match` /
   `must_not_match`), `sizes`, `conditions`, and a plausible price band. This is
   the step that decides whether the result means anything.
3. **Trim far outliers** — Tukey fences with `k=3` (`q1 - 3*IQR`, `q3 + 3*IQR`).
   Placeholder and incomplete listings leave the baseline here. Bargains also
   leave the baseline — that is intentional: the baseline should describe normal
   market pricing, and the bargains are scored against it separately.
4. **Summarise robustly**
   `market price = median`, `sigma = 1.4826 * MAD`, `z = (price - median) / sigma`.
   When MAD collapses to 0 (everyone asks the same price), sigma falls back to
   10% of the median instead of producing infinities.
5. **Score every listing we saw** (the pool *and* page 1 sorted by newest, so
   fresh posts are caught too). A deal must clear **both** gates:

   ```
   price <= median * (1 - min_discount)      # relative cheapness
   z     <= max_robust_z                      # statistical outlier-ness
   ```

   Set `max_robust_z: null` to let the discount decide alone.

### Calibrating: a real example

Measured on a live `vinted.fr` scan of `nike air max 90` (2026‑10‑12, 3 pages,
96 per page):

| watch filters | comparables | median | q1–q3 | MAD | result |
|---|---|---|---|---|---|
| brand only | 49 | 28.00 USD | 25–40 | 5.0 | 4 deals |
| + adult sizes (41–45, US 9/10) | 16 | 37.50 USD | 26–66 | 15.0 | 0 deals at 35% & z≤−1 |

Two lessons that generalise:

* **Filters matter more than thresholds.** The unfiltered pool was dominated by
  kids' sizes, which dragged the "market price" down to 28. Filtering to adult
  sizes moved the baseline to 37.50 and the deals disappeared — the 15–18 USD
  "deals" were cheap *because they were a different product*.
* **A noisy product defeats a strict z-gate.** With MAD 15 and median 37.50,
  `z <= -1.0` already means ~59% below median, so nothing qualified. The tool
  tells you instead of staying silent:

  ```
  note: thresholds: >= 35% under median (24.38 USD) and z <= -1.0
  note: closest match 20.00 USD (47% under, z -0.79) - Nike Air Max 90 Leather Whiteout …
  ```

  Lowering `min_discount` to 0.40 and setting `max_robust_z: null` flagged that
  listing immediately. For dispersed markets (sneakers, phones with many storage
  variants) prefer a tight pool + discount-only; reserve the z-gate for
  homogeneous products.

Practical defaults: `min_sample_size >= 10`, `sample_pages` 2–3, a
`plausible_min_price` at the realistic floor of the product (junk filter, not a
hope), and `min_discount` 0.30–0.40.

## Watch configuration

```yaml
defaults:            # inherited by every watch, override per watch
  min_sample_size: 10

watches:
  - name: air-max-90            # required, unique
    marketplace: vinted         # vinted | leboncoin | ebay | mock
    domain: vinted.fr           # vinted marketplace domain
    search_text: "nike air max 90"
    must_match: ["air max 90"]              # regexes, all must match the title
    must_not_match: ["kids", "sole", "coque"]  # regexes, none may match
    sizes: ["42", "43", "US 9"] # numeric entries match whole number tokens only
    conditions: ["bon état"]    # non-numeric entries match as substrings
    plausible_min_price: 15     # outside this band = junk, never a deal
    plausible_max_price: 350
    min_discount: 0.35          # required cheapness
    max_robust_z: -1.0          # required outlier-ness, null = off
    sample_pages: 3             # pages used for the baseline
    min_sample_size: 10         # below this: no verdict
    comps_ttl_seconds: 900      # reuse the cached baseline
    filters: {brand: ["53"]}    # marketplace-native filter ids (attribute_ids[brand])
    marketplace_id: EBAY_FR     # eBay only
```

## Marketplaces

**eBay (official, recommended).** The Browse API with an OAuth2
client-credentials token: free developer keyset, 5,000 calls/day by default.
Set `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` (see `.env.example`).

**Vinted (unofficial).** Vinted has no public API for searching other people's
listings — its official Pro Integrations API only covers a seller's own
inventory. This adapter calls the endpoint the Vinted web app itself uses:
`GET https://api.<domain>/svc-catalogue/items`. It needs an anonymous session,
which is why the first request is the homepage:

* GET the homepage (browser-style User-Agent, no account, no login), keep the
  cookies, echo the `anon_id` cookie in `X-Anon-Id`. Without it the API answers
  `403 {"code":"FORBIDDEN"}`.
* On `401/403` the session is refreshed **once**; if it still refuses we raise
  `MarketplaceBlocked` and stop. No proxies, no CAPTCHA solving, no evasion —
  if the marketplace says no, the tool says no.
* On `429`, `Retry-After` is honoured, then exponential backoff + jitter, then
  `MarketplaceRateLimited`.
* Requests are serialised and paced (`--vinted-delay`, default 6 s, plus up to
  `--vinted-jitter` 3 s). One pass = 4 requests ≈ 30 s. No parallel workers.
* The legacy `/api/v2/catalog/items` route now returns **404** (verified
  2026‑10‑12); `per_page` accepts up to 96 and the payload carries
  `pagination.total_entries/total_pages`.
* **Currency follows the session's geo, not the domain**: this sandbox resolves
  to the US and got USD prices from `vinted.fr`. The tool records the currency
  from the payload, never assumes one, and refuses to mix currencies in one
  baseline.

**leboncoin (unofficial, opt-in).** There is no public API for searching
leboncoin's listings, and its `robots.txt` says so plainly: *"It's forbidden to
use search robots or other automatic methods to access Leboncoin.fr"*. On top of
that the whole site sits behind **DataDome**. Both of the endpoints this adapter
speaks are the ones leboncoin's own browser client uses, and either can be used:

| `--lbc-transport` | request | notes |
|---|---|---|
| `api` | `POST https://api.leboncoin.fr/finder/search` | JSON in, JSON out; `api_key` header (public value, override with `MARKETWATCH_LBC_API_KEY`); prices in the filter are **cents**; offset paging, `limit` capped at 35; drops `ad_type: demand` (wanted ads), sold listings and — if you ask — pro sellers |
| `page` | `GET https://www.leboncoin.fr/recherche?text=…` | reads the JSON the Next.js page embeds in `<script id="__NEXT_DATA__">` by *searching the tree for ad-shaped objects*, so a renamed JSON path does not break it; prices in the URL are **euros** |
| `auto` (default) | `api`, then `page` | tries the second when the first is refused |

Field mapping, all taken from real captured search records: `list_id` → id,
`subject` → title, `price_cents` (or `price`, which can be a bare number, a
one-element list, or `{"value": …}`) → euros, `attributes` (`condition`, `brand`,
`size`, using the localised `value_label`, e.g. `État neuf`) → condition/brand/size,
`index_date`/`first_publication_date` (Paris-local, no timezone) → UTC,
`owner.type` → seller type, `location.zipcode` → kept in `raw` for diagnostics.
Currency is always EUR. Filter keys in the watch config are the marketplace's own:
`ad_type`, `category`, `owner_type`, `regions`, `departments`, `city_zipcodes`.

Pacing is stricter than Vinted's — never faster than one request every 8 s — and a
DataDome challenge is **not** retried: the adapter reports it and stops. Expect
HTTP 403 from cloud/datacenter IPs; run it from a home connection. If you want to
reuse your own logged-in browser session, put the `Cookie` header value from your
own devtools into `MARKETWATCH_LBC_COOKIE` — but that is your session, your
responsibility, and this tool still will not solve a CAPTCHA or rotate a proxy.

**mock.** A deterministic offline marketplace used by the tests and by
`marketplace: mock` demos — it plants genuine bargains plus junk below the
plausibility floor.

## Real-time operation

`marketwatch watch` re-polls each watch every `--interval` seconds (default 300)
and prints **only newly discovered bargains**:

* an item is reported once per watch, tracked in SQLite — a still-cheap item is
  silent next pass;
* re-reported only if it gets **5%+ cheaper**;
* the baseline is reused for `comps_ttl_seconds` (default 900 s), so a 5-minute
  loop makes ~1 request per watch per pass, not 4;
* `--json out/watch.json` accumulates every pass for post-processing.

A marketplace that blocks us (leboncoin's DataDome, typically) is reported and
skipped for the rest of the pass, then tried once more on the next one: one
hostile marketplace does not take your other watches — or the dashboard — down
with it. It is never retried harder than one attempt per pass.

Business rules for "is it a deal" live in one place (`analyzer.py`), so any
future delta-vs-history or model-specific check goes there.

## Deal alerts

`marketwatch serve` runs the watch loop and a small dashboard side by side:

```bash
uv run marketwatch serve -w air-max-90 -w iphone-13-lbc -i 300
# dashboard http://127.0.0.1:8787/
```

Open that URL and click **Enable desktop notifications** once. The page keeps a
live Server-Sent Events connection to the watcher, so a deal appears and notifies
the second a scan finds it — no polling in the browser, no account, no build step,
no extension to install. The page also lists everything in SQLite, so a reload
shows history rather than an empty screen.

Why a page instead of a browser extension: nothing to install or sideload, no
store review, no build tooling, and the same `Notification` API. What it is not:
a phone push service. Desktop notifications work on loopback (a secure context);
from another machine you get the live page, but browsers only allow notifications
on HTTPS or localhost, and iOS needs a home-screen web app for them. For alerts on
your phone, use the webhook below — that is what it is for.

```bash
# one POST per batch of new deals, to anything that accepts one
uv run marketwatch serve --webhook https://ntfy.sh/my-marketwatch-topic --webhook-style text
uv run marketwatch scan  --webhook $SLACK_OR_DISCORD_WEBHOOK_URL
```

* `--webhook-style json` (default) posts
  `{"title": …, "text": …, "content": …, "count": n, "deals": [ … ]}`. Slack reads
  `text`, Discord reads `content`, and everything else can read `deals`.
* `--webhook-style text` posts the human-readable summary as the body with
  `Title`, `Tags` and `Click` headers — exactly the shape `ntfy.sh` wants, so you
  get a real push notification on your phone with one URL and no account.
* Environment equivalents: `MARKETWATCH_WEBHOOK_URL`, `MARKETWATCH_WEBHOOK_STYLE`.
* Alerting never breaks scanning: a failing channel is printed and the loop
  carries on. Delivery is deduplicated by the same store rule as the terminal,
  so you get one message per bargain (and a second one only if it drops another
  5%).

Other endpoints the page uses: `GET /api/deals`, `GET /api/status`, `GET /healthz`.
It binds `127.0.0.1` by default; binding anywhere else (`--host 0.0.0.0`) generates
a token and puts it in the URL, because otherwise anything on the network could
read your deals.

## Legal & terms

This is a personal price-research tool, not a data-mining service — but the
rules are not optional, and they differ per marketplace.

* **Vinted's terms prohibit automated access.** The version applicable from
  2025‑09‑08 forbids *"any kind of external software tools (including but not
  limited to: bots, scraping programs, crawling programs, spiders)"* and to
  *"data mine, screen scrape, crawl, disassemble, decompile or reverse engineer
  any part of the Site"*
  ([vinted.ie terms](https://www.vinted.ie/old-terms-and-conditions)). Their
  stated remedies include warnings, feature limits and account blocking.
  Going slowly does not make it permitted. If you use the Vinted adapter, keep it
  to personal, low-volume research on your own account's and jurisdiction's risk,
  and set `acknowledge_terms: true` once you have read this.
* **Leboncoin's robots.txt is unambiguous.** It opens with *"It's forbidden to use
  search robots or other automatic methods to access Leboncoin.fr. Access is only
  permitted with special permission from Leboncoin.fr"*, and `/recherche` is
  disallowed by name in the same file. That is why the leboncoin adapter is opt-in
  per watch (`acknowledge_terms: true`), paced at 8 s minimum, and stops on the
  first DataDome challenge instead of working around it. Personal, low-volume use
  on your own responsibility; if you need this at scale, ask leboncoin about their
  professional/partner access rather than building on a private endpoint.
* **Prefer an official API when one exists** — that is what the eBay adapter is
  for. Depop's API is explicitly private; Wallapop's terms likewise forbid
  systematic extraction and external tools
  ([wallapop terms](https://about.wallapop.com/en/legal-terms-and-conditions/));
  Etsy has a real API but marketplace-wide listing access depends on app review.
* **EU context.** Collecting public listing data is governed by database rights,
  contract and (if sellers are identifiable) data-protection rules, not by a
  blanket "public data is free" rule. The CJEU ties database-right infringement in
  *CV-Online Latvia v Melons* (C‑762/19) to extraction that undermines the
  maker's investment; France's Leboncoin ruling awarded damages over systematic
  copying; CNIL's guidance treats scraping as assessable case by case with
  minimisation and transparency duties. This tool therefore stores only listing
  ids, titles, URLs, prices, condition/size and timestamps — no seller
  identities, no photos, no contact details.
* **Do not** rotate IPs, reuse accounts to dodge limits, solve CAPTCHAs, or
  otherwise evade an access control. The adapters stop on 403 by design.
* This is engineering documentation, not legal advice.

## Browser extension

`extension/` is the same engine as a Manifest V3 Chrome extension, for people who
would rather not run a Python process — and, more importantly, because requests then
come from **your own browser profile**. That is what gets past the anti-bot layers
that refuse a datacenter IP (leboncoin's DataDome blocks this cloud host outright).

* A dashboard of real deals: photo, price, the market price it is compared against,
  why it matched, and an **Open listing** button that takes you to the product.
* Watches editable in the dashboard, desktop notifications when a bargain appears,
  a toolbar badge for what you have not dealt with.
* Install: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.
* `npm test` in `extension/` runs 85 tests: analyzer/scorer/parser **parity with this
  Python implementation**, storage + dedupe, the service worker against a fake
  `chrome`, the dashboard rendered in jsdom, and the manifest/permission rules Chrome
  enforces.
* Read `extension/README.md` before pointing it at Vinted or leboncoin — same terms
  caution as this project, and `acknowledge_terms` is required per watch.

## Verification status

Verified on this checkout (2026‑10‑12):

* `uv run pytest` → **88 passed**: analyzer robustness, size-matching
  tokenisation, the Vinted parser against a *real captured payload*, the
  leboncoin parser against *real captured search records*
  (`tests/fixtures/leboncoin_search.json` — 8 verbatim ad objects), adapter
  session/403/429/challenge behaviour for both marketplaces via
  `httpx.MockTransport`, alert delivery (json/text webhooks, failure isolation),
  the dashboard over real sockets (auth, JSON, SSE delivery, concurrent SQLite
  reads), store dedupe/price-history/TTL, and the pipeline end-to-end on the
  mock market.
* **Live, Vinted**: `doctor`, `scan`, `comps`, `watch --cycles 1`, `deals` and
  `serve` against `vinted.fr` — session bootstrap, pacing (~30 s for 4 requests),
  baselines from 49/16 comparables, deal detection, CSV/JSON export, cross-pass
  dedupe. The calibration numbers above come from those runs.
* **Live, alerts**: a `serve` process with a Vinted watch and a mock watch,
  driven over real sockets — `/healthz`, token auth (401/200), `/api/status` with
  per-watch market prices, `/api/deals`, the SSE stream, and one webhook POST per
  pass carrying the deals (no repeats on the next pass). A live Vinted pass
  delivered 2 `new_deals` and the mock watch 7, both observed on the event stream.
* **Live, leboncoin**: both transports reach the real endpoints and are refused
  with `HTTP 403` / a DataDome challenge from this datacenter IP, which the
  adapter reports and stops on (verified by running `doctor` against the live
  site). So the *request construction, challenge detection and failure path* are
  verified live; the *happy path* — parsing a live leboncoin response — could not
  be, from a cloud host, and the parser is instead pinned to real captured
  records. Run it from a home connection to exercise it end to end.
* **Not verified**: the eBay adapter's HTTP/auth layer, because it needs
  `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` that this environment does not have.
  Its response parsing and request construction are unit-tested against the
  documented payload shape, but the live path is untested until you add keys.
* **Not covered**: anything requiring a real browser — clicking "Enable desktop
  notifications" and seeing an OS notification appear. The notification path is
  driven by the same SSE event verified above, but the final OS-level popup is
  the one step that needs your eyes.

## Layout

```
src/marketwatch/
  models.py      Listing / Watch / PriceStats / Deal / WatchReport
  config.py      watches.yaml loading + validation
  analyzer.py    robust baseline, comparability rules, deal scoring
  adapters/      base (protocol, pacing, errors) · vinted · leboncoin · ebay · mock
  store.py       SQLite: listings, price_snapshots, alerts, comp_stats
  pipeline.py    baseline cache, one scan pass, watch loop
  notify.py      alert bus: console + webhook (ntfy/Discord/Slack/generic)
  dashboard.py   the local alert page: HTTP + SSE + browser notifications
  cli.py         doctor · watches · comps · scan · watch · serve · deals
  render.py      rich tables, JSON/CSV export
tests/           88 tests + fixtures
extension/       Manifest V3 browser extension: manifest.json, dashboard.html,
                 src/{background,dashboard}.js, src/core/* (port of the modules
                 above), src/ui/*, 85 node tests
```

### Adding a marketplace

Implement `search(query: SearchQuery) -> SearchResult`, return `Listing`
objects, and register the name in `adapters/base.py:get_adapter`. Normalisation
currency handling, pagination and error taxonomy are the adapter's job; the
analyzer, store and CLI need no changes.

## Next steps worth taking

* Persist every candidate listing (not just deals) to build per-item price
  history and a "cheapest seen in N days" signal.
* Sold-price data where available, which is a better baseline than asking prices.
* A per-product `min_discount` learned from how fast listings move.
