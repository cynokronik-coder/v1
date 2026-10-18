# marketwatch (browser extension)

Finds the listings that are actually cheap: it samples the market for a product, works
out what the item really sells for, and tells you when something is listed well below
that - across **eleven second-hand marketplaces**, from your own browser session. A second
page answers a different question: *which products are cheaper to buy than to resell,
right now?*

Everything runs on your machine. There is no server, no account, no telemetry. Two kinds
of network call leave your browser: the marketplaces' own endpoints (or, where you choose,
a data provider you brought a key for), and three public, key-less signal endpoints
(Wikimedia pageviews and GDELT news attention). eBay is the one marketplace with an
official search API, and it asks you for a free keyset if you want to use it.

## Install (2 minutes, no build step)

Chrome, Edge, Brave, Vivaldi or any Chromium 120+:

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. The dashboard opens by itself. Click **Try offline demo** to see it work with no
   network at all, then add a real watch, then read the **Marketplaces** page.

Firefox is not supported yet (it needs a different extension API surface). Safari would
need an Xcode build; neither is worth pretending otherwise.

After updating the code, come back to `chrome://extensions` and press **Reload** on the
card, then reopen the dashboard.

## The nine tools

One tool per page, listed in the rail down the left-hand side, which stays put while a
page scrolls. Every tool is reachable from the rail at any time.

| Tool | What it is for |
|---|---|
| **Deals** | The listings a watch found below its market price, with the numbers behind the verdict. Star the good ones, mark the rest bought or hidden. The watches, markets, self-check and activity panels live beside it. |
| **Opportunities** | Products that look cheaper to buy than to resell: buy-side price, resale reference(s) and whether each one is an asking price or a payout, fees, margin, demand, trend, confidence. |
| **Price check** | One keyword, one marketplace, straight to a median - the same estimator the scans use, without creating a watch. Use it to sanity-check a reference price. |
| **Catalogue** | The products an opportunities run samples: keyword, price band, which markets to buy on, which resale reference to price against, and an optional manual resale price. |
| **Marketplaces** | Every marketplace the engine knows, how it is reached, what its terms say, and a switch for each one. Plus the optional data providers. |
| **API keys** | Step-by-step setup for each key - the eBay keyset and each data provider - naming the exact Settings field it goes in and how to prove it works. Nothing here is required. |
| **Assistant** | Hand numbers over from ChatGPT, Claude or any MCP client - by pasting its answer, or through a small hosted queue - and review them before anything is applied. Optional, and nothing else depends on it. |
| **History** | Every scan pass and every opportunities run, newest first, plus a price line per watch so you can see a market move. |
| **Settings** | Intervals, transports, fees and thresholds, trend sources, your own hot keywords, and the fields the keys from the API keys page are pasted into. |

### Wiring up a key

Keys are optional: with none, the extension still works by reading pages from your own
browser. Each one buys one specific capability, and the **API keys** page spells out the
click-path for each - sign up, where in the vendor's dashboard the token lives, which
Settings field takes it, and which switch spends it (a SerpApi key does nothing until you
tick *use Google Shopping as an extra resale reference*, and an Apify token does nothing
until you tick the fallback *and* name an actor on the marketplace row).

| Key | Settings field(s) | What it unlocks |
|---|---|---|
| eBay developer keyset | `ebayClientId`, `ebayClientSecret`, `ebayMarketplaceId` | eBay as a buying source and the preferred resale reference. Free developer account, no seller account. |
| Apify | `apifyToken` (+ an actor id per marketplace row) | A scraper fallback for marketplaces with no open tab and no search URL. |
| SerpApi | `serpApiKey` | Google Shopping as an extra resale reference, and Google Trends as the demand signal. 250 searches/month free. |
| Bright Data | `brightDataToken`, `brightDataZone` | Fetch a marketplace page from their infrastructure when a site refuses your network. **Both** fields are needed. |
| Keepa | `keepaKey` | Amazon price history by ASIN. |

Keys are stored in this browser profile and sent to nobody but the vendor they belong to.
After pasting one, press **Test every enabled source** on the Marketplaces page: that makes
one real request and reports what actually happened.

## Where the data comes from (read this before trusting the numbers)

Twelve entries are registered in one file, `src/core/sources.js` (eleven real marketplaces
plus the offline demo), and the Marketplaces page is generated from it. Being straight about how
each one is reached matters more than the count, so:

| Source | How it is reached | Terms |
|---|---|---|
| **eBay** | Its **official Browse API**, with your free developer keyset | Documented API |
| **Vinted** | The catalog endpoint its own web app calls, through your session | Unofficial: terms forbid bots/scraping |
| **leboncoin** | Its own client's endpoints, from your tab where possible | Unofficial: `robots.txt` asks search robots not to crawl |
| **Back Market** | The product data its search page embeds, plus its trade-in quote page | Unofficial (its documented API is seller-only) |
| **Fnac**, **Cdiscount** | Their public search pages | Unofficial (both document seller APIs only) |
| **Easy Cash**, **Cash Express**, **Cash Converters** | The buy-back chains' own storefronts - the page you have open | Unofficial |
| **momox** | Its shop pages (a hard floor on what resale can fetch) | Unofficial |
| **Facebook Marketplace** | The page your logged-in tab is showing | **Prohibited** by Meta's terms - off by default, your call |
| **Offline demo** | A deterministic fake marketplace | Nothing leaves your machine |

**Two modes, and the difference is the point.**

- `search-url` - the extension builds a search URL from the registry (or one you paste in
  the Marketplaces page) and fetches it: inside one of *your own tabs* on that host when you
  have one open, otherwise from the service worker.
- `reads your tab` (`open-tab`) - the extension **builds no URL and makes no request at
  all**. You run the search yourself; it reads the results page you are looking at. This
  is the default for the sites whose search is client-rendered and whose URL cannot be
  relied on: what you see is what gets measured, and the site sees nothing it did not
  already serve. It is also the mode to prefer when a site is hostile to automation.

Failure is always explicit: a bot-protection challenge, a sign-in wall, a stale URL
template (HTTP 404), or an HTTP 200 with no recognisable product data each raise an error
that names which one it was and what to do instead. It never returns an empty list and
lets you believe the market is empty, and it never invents a price.

### eBay: do I need an account?

- You need a **free eBay developer account** (<https://developer.ebay.com/signin>) and a
  keyset (Client ID + Client Secret). Membership is free and there is no listing fee.
- You do **not** need a seller account. The Browse API is a buying/search API: eBay's
  requirements ask for a member account and a keyset, not a selling relationship. The
  free keyset is good for roughly 5,000 calls a day.
- Browse returns **current asking prices** for used/refurbished fixed-price listings
  (condition and buying-format filters work), which is what a resale reference needs.
- What it does **not** give you is sold-price history: eBay's Marketplace Insights is
  limited-release and not open to new users. So this tool quotes asking prices, and says
  so, instead of pretending an asking price is a sale.
- eBay's Buy API requirements still describe production use as intended for eBay partners
  and subject to approval - so treat your keyset as a personal one, which is exactly how
  this extension uses it (a handful of searches per run).

### Data providers: "can I connect a tool instead of scraping?"

Yes - optional, bring your own key, configured in **Settings → Data providers**. Nothing
is used until you paste a key, and your keys stay in this browser profile. Four are
wired up:

| Provider | What it adds | Notes |
|---|---|---|
| **Apify** | Runs a marketplace scraper ("actor") of your choosing and returns its dataset | Actor id is per-source. Its store is not an authorisation layer: pick actors you are allowed to use |
| **SerpApi** | **Google Shopping** prices as an extra resale reference, and **Google Trends** interest for the demand signal | A third-party interface to Google data, not a Google-authorised API |
| **Bright Data** | Fetches a marketplace page from their infrastructure; the same extractor parses it | A proxy/unlocker is not permission from the site |
| **Keepa** | Amazon price *history* by ASIN | The one place you can see how a product actually moved over time |

Two switches make them useful in practice: **Google Shopping as a resale reference** (one
SerpApi search per product - costs money, so it is off until you ask) and **Apify fallback
when a marketplace has no open tab and no search URL**.

A vendor returning data does not change the source site's terms. That is why each provider
lists what it covers and what it is not, and why a provider result is always labelled with
the provider's name on the card.

### What is deliberately absent

**Rakuten France** - Rakuten's own page says its French marketplace ceased activity on 30
September 2026, so there is nothing left to search there. **Amazon** - no public listing
search API; use Keepa if you want Amazon data. And there is still no honest way to read
"what is trending on TikTok": see the note under Opportunities.

## The exact-phrase filter

A watch has an **exact phrase** switch, on by default for watches created here. With it
on, a listing only counts if its **title or description contains the whole search text, as
consecutive whole words**:

- search `iphone 13 256` → matches `iPhone 13 256 Go bon état` and `IPHONE13 256Go`, and
  does **not** match `iPhone 13 Pro Max 256 Go`, `iPhone 130 256`, or a phone case.
- accents and punctuation are folded, and a letter/digit boundary counts as a word
  boundary, so `256Go` is read as `256 go`.
- when the marketplace gives us a description, it is searched too; when a listing's
  description is not in the payload, only the title can be checked.
- the Activity log and the Markets panel say how many listings the gate removed, because a
  filter that quietly empties a market is worse than no filter.

`mustMatch` / `mustNotMatch` remain the tool for model-level precision (they are regexes
against the title). A watch imported from the Python tool keeps this switch **off**,
because that tool has no such field - tick it in the editor if you want it.

## Opportunities

For every product in the catalogue, one run samples both sides of the market:

```
buy side   the acquisition price: the 15th percentile of the buy-side listings inside
           the price band (what you could realistically pay)
resale     every reference the product declares - eBay (official API), Back Market,
           momox, Fnac, Cdiscount, Google Shopping via SerpApi - or a price you typed in
fees       commission + payment processing + shipping you pay, subtracted before
           anything is called a margin
demand     favourites per listing, listing volume, how fresh the listings are
trend      Wikimedia pageviews for the product's article (free, key-less), optionally
           GDELT news attention (or Google Trends via SerpApi), plus the hot keywords
           you paste in yourself
```

**Several resale references quote the cheapest credible one, not the best.** If eBay says
320, Back Market says 199 and momox says 180, the card quotes 180 and shows the whole
table. The first offer that sells is the cheap one, so quoting the most flattering platform
would invent margin that does not exist. With a single reference nothing changes.

**A reference can be an asking price, and that is not a payout.** Two of these sources do
both jobs - Back Market and the cash-for-goods chains sell to the public *and* buy goods
outright - and a search returns the first number: what a buyer is charged. That is a
**ceiling**, not what you will be given for your item, and it is before Back Market keeps
its commission (11% by default, 12% on phones sold in France or Spain, 15-20% on
accessories; that is its published schedule, and your own contract with it may differ). So
the reference block turns amber and says *asking price*, and names the commission.

Back Market's other number is read separately and shown on the card as **Instant payout**:
one extra paced request to its trade-in ("reprise") page, which quotes what a refurbisher
pays. The gap is not a rounding error - measured 2026, an iPhone 13 Pro Max showed **up to
385 EUR** on Back Market's buyback page against refurbished **asks starting at 432 EUR** for
the same model. The payout is scored on its own line - net of the 10% trade-in commission
and the return logistics (10.90 EUR for phones and audio, 13.90 EUR for MacBooks, consoles
and tablets) - with its own verdict and a **break-even buy price**, which is the most the
item can cost before the trade-in route stops making money. It is never averaged into the
resale ask, because those are two different trades: money now with no buyer and no listing,
versus money later if it sells.

When its page cannot be read - the model is not in the buyback catalogue, an interstitial
was served, or the quote is only shown once you have answered its condition questions - the
card says **no trade-in quote read** and links to the flow. That is deliberate: a payout of
zero and no payout at all are different claims. The whole thing switches off in Settings
(*ask Back Market what it would pay*), which saves one request per product.

The verdict is `buy`, `watch`, `skip` or `insufficient data`, and the last one is used
whenever the sample is too thin - a beautiful margin computed from four listings is
labelled *not enough data* and stays that way. Every card shows its arithmetic, so you can
disagree with the weights and still use the numbers.

**What the trend column is not.** There is no API that returns "what is trending on
TikTok", and TikTok's own terms forbid automated collection. So the trend signal is public
interest (Wikimedia pageviews), optionally news attention (GDELT) or Google Trends (if you
have a SerpApi key), and the keywords *you* paste into Settings. Marketplace demand - the
favourites, the volume, the freshness - carries the most weight, because it is the only
signal with money behind it.

**Editing the catalogue.** The seed is 29 products across phones, consoles, PC parts,
cameras, sneakers, LEGO, instruments and more. Each one declares its **buy markets** and
its **resale references**, and the seed already spreads them across the ten marketplaces -
phones and consoles on Vinted/leboncoin/Easy Cash, tools on leboncoin/Easy Cash/Cash
Express, media on momox. Edit the keywords to match what you actually see; add your own;
set a **manual resale price** when you have read the price yourself (it always wins, and
works with no API keys at all). `estimatedRequests` in the catalogue panel tells you what
a full run will cost in requests before you press the button.

One run is slow on purpose: page sources pace themselves at 6-12 seconds per request, and
the run stops at a request budget you can see and change (`opportunityMaxRequests`).

## Asking an assistant for numbers

An assistant is good at one thing this tool is not: reading a page that defeated the
parsers. A buy-back flow that only shows its quote after you answer six condition
questions, a screenshot of a Vinted search, a retailer page that changed its markup -
the numbers exist, they are just not in a shape any adapter can reach. An assistant can
put them in a shape this tool reads.

**It cannot push anything into a browser extension.** An MV3 service worker has no
listening socket and is not allowed to open one; the dashboard is a page, not a server.
So there are exactly two ways in, and both end up in the same review inbox.

### Option 1 - paste (works today, with any assistant)

1. Open the **Assistant** page and press **Copy the instructions**.
2. Paste them into the chat, then ask your question (*"what does Back Market offer for an
   iPhone 13 128 GB?"*, *"read this page and give me the asking prices"*).
3. The assistant answers with one `json` block. Paste the whole answer into the box -
   the prose around the block is fine - and press **Import what is in the box**.
4. Each number appears under **Waiting for you**. Apply it, attach it to a different
   catalogue product, or dismiss it.

The instructions are generated from this build's own registry, so the marketplace names
the assistant is told it may use are the ones the validator accepts. That is the usual
reason a pasted answer fails: the model invents `wallapop`, and the import says so
instead of storing it.

### Option 2 - the live bridge (nothing to copy afterwards)

A deployed queue that an MCP client can post to, which this extension checks on an alarm.
The default address in Settings is the bridge deployed for this project; clear it and use
Option 1 if you would rather not use a server at all.

1. On the **Assistant** page, press **Generate a token** (this browser's key), then
   **Save bridge settings**.
2. Press **Copy the MCP address** - that is the bridge address with the token on the end.
3. In ChatGPT: **Settings → Connectors** (called Apps on some plans) → add a custom
   connector, paste that address, authentication **none**. If your plan has no connectors,
   Option 1 does the same job by hand.
4. Enable the connector for the conversation and ask: *"use marketwatch to queue the
   trade-in quote you can see for an iPhone 13 128 GB"*.
5. Press **Check now**. The number appears in the inbox.

The bridge exposes four MCP tools - `list_marketplaces`, `queue_reference`,
`queue_product`, `queue_status` - and holds nothing else. It is never told about your
watches, scans or deals, so the assistant cannot read them; there is no read path from
this extension to the bridge at all. See `bridge/README.md` for the worker itself.

### What importing can and cannot do

Every entry is one of three kinds, and the kind decides what Apply means:

| Kind | What it is | Apply does |
|---|---|---|
| `resale_ask` | what a buyer is **charged** | writes the product's manual resale price, labelled *imported* on the card |
| `trade_in_quote` | what a refurbisher **pays you** | marks it applied; the payout line uses it **only when the buyback page gave nothing** |
| `product` | a catalogue entry | appends it to the catalogue |

Three rules are worth stating plainly, because they are the reason this is an inbox and
not an import button:

- **No import changes anything by itself.** Every row waits for a click, so a wrong number
  cannot become a verdict while you are not looking.
- **An asking price can never be stored as a payout.** The two kinds are separate fields,
  a reference that says `"kind": "price"` is refused with the two options named, and the
  card keeps saying which one it is showing.
- **A number with no catalogue product is not guessed at.** If `leica q2` is not in the
  catalogue, the row asks you to pick a product; Apply stays disabled until you do.

### Deploying your own bridge

The worker is one file with no dependencies (`bridge/src/worker.js`), a D1 table it
creates itself, and one command to run locally:

```bash
cd bridge && npx wrangler dev --local   # then: node tests/smoke.mjs http://127.0.0.1:8787 <token>
```

`bridge/README.md` has the endpoints, the schema and the security model.

## Adding a watch

```yaml
name: iphone-13-128         # anything, shows up in the list
marketplace: vinted         # vinted | leboncoin | ebay | backmarket | fnac | cdiscount
                            # | easycash | cashexpress | cashconverters | momox
                            # | facebook | mock (offline demo)
searchText: iphone 13 128   # what you would type in the site's search box
exactPhrase: true           # only listings that contain the whole search text
minDiscount: 30             # percent under the market price that counts as a deal
maxRobustZ: -1.0            # "" to turn the "unusual" test off
minSampleSize: 8            # refuse to judge a market with fewer comparables
plausibleMinPrice: 80       # ignore listings outside this range (parts, "for repair")
plausibleMaxPrice: 900
mustMatch: iphone 13        # keep the comparison pool honest - see below
mustNotMatch: cracked, for parts
sizes: 128 Go
conditions: très bon état   # an allowlist, edited in the watch card
acknowledgeTerms: true      # required for the unofficial sources; see the section below
```

For the sites that only publish a book price (Easy Cash, Cash Express, Cash Converters,
momox) a watch is worth adding: a chain shop clearing stock is a genuine bargain when it
lands under the market median.

Config keys accept both this extension's `camelCase` and the Python tool's `snake_case`
(`min_discount`, `plausible_min_price`, ...), so a watch from `config/watches.yaml` in the
Python project can be pasted in as-is.

## How the price is worked out

1. **Sample** the search over a few pages (`samplePages`) with your filters.
2. **Filter** to things that are plausibly the same product: the exact-phrase gate, not a
   part, not "for repair", inside your price range, matching your size/condition keywords.
3. **Estimate** the median and the MAD (a spread measure that one crazy listing cannot
   wreck), trimming outliers 3 robust sigmas out.
4. **Score** each fresh listing: `discount = (median - price) / median`, and
   `z = (price - median) / (1.4826 * MAD)`.
5. **Report** only what clears `minDiscount` *and* `maxRobustZ`, in a single currency
   (listings in another currency are never mixed into the same baseline).

No machine learning, no black box: you can read the whole thing in `src/core/analyzer.js`,
and the Python tool this was ported from has the same numbers checked against it
(`tests/parity.test.js`).

## Tab transport (and why it exists)

DataDome refuses requests that look like a script rather than a browser. A request from the
extension's service worker carries `Origin: chrome-extension://…` and
`Sec-Fetch-Site: cross-site` - signals leboncoin's own client never sends. That is why a
search can work in your tab and fail in the extension, even with the same cookie.

So when you have **leboncoin.fr (or any other registered marketplace) open in a tab**, the
extension asks that tab to perform the search, in the page's own context, at the same slow
pace. It does not forge a user agent, rotate a proxy or solve a CAPTCHA: it is literally a
request made by the page you already have open. Without such a tab it falls back to the
JSON api and then the search page, exactly as before, and the Self-check tells you which
transport answered.

Set **leboncoin transport** in Settings to `auto` (default), `tab`, `api` or `page`. Every
other source's mode lives on the Marketplaces page (`auto`, `build the search URL`, `reads your
tab`).

## Terms of use - please actually read this

Most of these marketplaces have **no public API for searching other people's listings**,
and their terms forbid scraping and bots - Vinted's terms say so explicitly, Meta's say so
about automated collection, and leboncoin's `robots.txt` says so to crawlers. This
extension uses the same endpoints their own web apps use, with your own browser session, at
a deliberately slow pace (6-12 seconds per request), or reads a page you already have open.
In France/EU that is a grey-to-contractual area rather than an open door: low-volume
personal price research is a much better position than commercial aggregation, and it is
still not permission.

So, the deal we make:

- It is **personal, low-volume use**, not a way to build a product on someone else's data.
  Keep it to the products you are actually shopping for.
- It **paces itself**, never runs parallel workers, and the opportunities run stops after a
  request budget you can see in Settings (`opportunityMaxRequests`).
- It **never solves a CAPTCHA, rotates proxies, or hides who you are**. If a marketplace
  says no, it stops, logs it, and tells you what to do.
- It stores **no seller names, contact details, photos or addresses** - only what a price
  comparison needs (title, price, link, condition, and the image URL for the card).
- You can switch any source off in the Marketplaces page, and it leaves nothing behind on the
  marketplace side.
- `acknowledgeTerms: true` on a watch - or the per-source **terms acknowledged** box on the
  Marketplaces page, or **"I accept the terms"** in Settings, which covers a whole opportunities
  run - is required before those marketplaces are used at all. It is your acknowledgement,
  not mine.
- **Facebook Marketplace ships off** because Meta's terms are explicit about automated
  collection. Turning it on is your decision, and the row tells you what that means.

Wikipedia pageviews (`wikimedia.org`), GDELT (`api.gdeltproject.org`) and eBay's API are
fine: public, documented, and cheap in requests. If a marketplace blocks you, the honest
fix is to slow the interval down, open that marketplace in a normal tab so the request can
be made from a real session, or switch the source to *reads your tab*. If it still refuses,
stop.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `storage` | Watches, cached baselines, deals, history, catalogue, source settings and log. Local only. |
| `alarms` | The scheduled scan, and the much slower scheduled opportunities run. |
| `notifications` | Desktop alerts when a bargain appears. |
| `tabs` | Opening a listing when you click a card or a notification, and finding your own marketplace tab. |
| `cookies` | Reading the marketplace's own `anon_id` cookie - the Vinted web API rejects requests without it. Nothing is stored or sent anywhere. |
| `scripting` | Running one fetch (or reading the current document) inside a tab you already have open on that marketplace. Nothing is injected into any other page. |
| host access to the registered marketplaces, `api.ebay.com`, and the four provider hosts | Only the sites in `src/core/sources.js` plus the providers you configure. `tests/manifest.test.js` fails if a registry host is missing from the manifest. |
| host access to `*.freebuff.page` | The bridge deployed for this project, if you switch it on. The bridge answers a token and nothing else, and it deliberately sends no CORS headers - extension host access is what makes the poll possible without opening the queue to any browser page. Pointing at your own deployment means adding its host here. |

Nothing is read from or written to any other site, and no data leaves your machine except
the request you asked for.

## Troubleshooting

| Symptom | What it means |
|---|---|
| A source says `needs an open tab` | That site's search is client-rendered: open it, search for the product yourself, then run. Or paste a working search URL template in the Marketplaces page to switch it to automatic. |
| Self-check says `MarketplaceBlocked` | The site is refusing automated-looking access from your network. Open the site in a normal tab, browse a bit, then retry - the next scan will use that tab. Do not retry in a loop. |
| `the search URL template ... has probably gone stale` | The site changed its search path. Open the site, run the search, copy the URL, and paste it into that source's row with `{query}` where the keyword goes. |
| `HTTP 200 but no product data could be read` | Its markup changed, or its results load client-side. Switch that source to *reads your tab*. |
| Self-check says leboncoin is blocked even with a tab open | The block is on your network or account, not on the request shape. Stop and try later. |
| "no comparable listings ... all filtered out" | The exact-phrase gate, your `mustMatch`, or the price range is too strict. The log says how many the phrase gate removed. |
| "only N comparables (minSampleSize=...)" | Not enough market data to be honest about a price. Lower `minSampleSize`, or pick a broader `searchText`. |
| eBay says it needs credentials | Paste your free keyset in Settings; a seller account is not needed, but the Browse API scope must be enabled on the keyset. |
| Opportunities are all "not enough data" | One side of the market is thin. Widen the keyword, lower `opportunityMinConfidence`, add a resale reference, or set a manual resale price. |
| A product shows a low resale price you disagree with | That is the conservative rule: the cheapest credible reference is quoted. Remove the reference you do not trust from the product's `also price against` field. |
| "Back Market returned no product data" | Its markup changed or an interstitial was served. Type the price in yourself - that reference always works. |
| "no trade-in quote read" | Back Market's buyback page was not readable, or the model is not in its buyback catalogue. The card links to the flow: read the offer there and type it in, or set a manual resale price. |
| No deals for days | Normal. That is what "below market" means. Check the log line each pass: it says how many comparables were seen. |
| I edited a field and it reverted | Fixed in 0.2.0: the 5-second refresh no longer rebuilds an editor you are typing into (watch cards, catalogue rows and source rows all keep what you typed). If you see it again, it is a bug - the History page and the Activity log show what the worker thought it had. |

## Development

```bash
npm install          # dev dependency: jsdom, for the dashboard tests only
npm test             # 239 tests: extractors, page adapters, providers, source registry,
                     # analyzer parity, phrase gate, adapter discipline, tab transport,
                     # opportunity math, multi-reference resale, trends, storage, service
                     # worker, and the dashboard rendered in jsdom
npm run lint         # node --check on every shipped file
node live-check.mjs  # optional: talks to the real Vinted/leboncoin endpoints
```

Layout:

```
manifest.json          MV3 entry point (version 0.3.0)
dashboard.html/.css    the UI you look at
src/dashboard.js       DOM wiring only; logic lives in src/ui/ and src/core/
src/background.js      service worker: alarms, scan loop, opportunities run,
                       notifications, badge, per-source settings, message API
src/core/sources.js    THE registry: every marketplace, how it is reached, its terms,
                       its pacing, its credentials - plus the four data providers
src/core/models.js     data shapes + config validation (marketplace lists derived
                       from the registry, so there is only one list)
src/core/analyzer.js   the statistics (ported from the Python tool, parity-tested)
                       + the exact-phrase gate
src/core/adapters/     index.js (routing), page-source.js (the generic page adapter),
                       html-extract.js (JSON-LD / embedded JSON / markup extraction),
                       vinted.js, leboncoin.js (api | page | tab), ebay.js,
                       backmarket.js, mock.js, base.js (pacing, errors)
src/core/providers.js  Apify / SerpApi / Bright Data / Keepa connectors
src/core/tab-transport.js  run a request - or read the document - in your own tabs
src/core/storage.js    chrome.storage + dedupe/alert rules + history + pruning
src/core/scan.js       one scan: baseline -> freshness -> scoring -> dedupe
src/core/catalog.js    the product catalogue (the seed, its coverage, its validation)
src/core/opportunity.js      fees, acquisition price, multi-reference resale, verdict
src/core/opportunity-scan.js one opportunities run (sequential, budgeted)
src/core/trends.js     public-interest signals (Wikimedia, GDELT, your keywords)
src/ui/                format.js, views.js, watch-form.js - pure and tested
```

Adding a marketplace is a **data change**, not a new file: add an entry to
`src/core/sources.js`, add its host to `manifest.json` (the manifest test enforces both),
and it gets an adapter, a Sources row, a tab lookup and pacing for free. Only Vinted,
leboncoin, eBay and Back Market have dedicated adapters, because only those four need one.

The service worker is written as `createController({ chrome, fetchImpl, tabTransport })`,
which is why the whole scan -> notify -> badge path, the opportunities run, the tab
transport and the source settings are testable in node with a fake `chrome`, and why the
dashboard is tested by rendering the real HTML in jsdom against a fake worker - and, in
`tests/integration.test.js`, against the real worker. `tests/parity.test.js` compares the JS
analyzer, scorer and both parsers against expected values generated by the Python
implementation; the new features live behind fields the Python tool does not have, so that
comparison still means what it says.
