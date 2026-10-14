# marketwatch (browser extension)

Finds the listings that are actually cheap: it samples the market for a product, works
out what the item really sells for, and tells you when something is listed well below
that - on **Vinted** and **leboncoin**, from your own browser session.

Everything runs on your machine. There is no server, no account, no telemetry, and no
third-party API key: the extension calls the same endpoints the marketplaces' own web
apps call, with the cookies your browser already has.

The dashboard is the point: a clear list of what is worth buying, with the photo, the
numbers behind the verdict, and a button that opens the listing so you can go and buy it.

## Install (2 minutes, no build step)

Chrome, Edge, Brave, Vivaldi or any Chromium 120+:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. The dashboard opens by itself. Click **Try offline demo** to see it work with no
   network at all, then add a real watch.

Firefox is not supported yet (it needs a different extension API surface). Safari would
need an Xcode build; neither is worth pretending otherwise.

## The 60-second tour

| Where | What it does |
|---|---|
| **Scan now** | One pass: sample the market, then look for underpriced listings. |
| **Test notification** | Proves OS notifications work before you rely on them. |
| **Self-check** | One real request per marketplace, and it tells you what came back. Do this first: it takes 5 seconds and it tells you whether your IP/browser is being refused. |
| **Watches** | The products you want. One watch = one product on one marketplace. |
| **Markets** | For each watch: the median price, the spread, how many listings were kept, and why there is (or is not) a verdict. |
| **Activity** | A log of what happened, so a silent failure is impossible. |

A card appears when a listing is **`minDiscount` below the market median** *and* its
robust z-score is at or below `maxRobustZ` (a "how unusual is this" test that stops
one weird listing from being called a bargain). Each card shows the price, the market
price it is compared against, the discount, why it matched, the photo, and an **Open
listing** button. **Bought** and **Hide** keep the list honest; the toolbar badge counts
what you have not dealt with.

## Adding a watch

```yaml
name: iphone-13-128        # anything, shows up in the list
marketplace: vinted        # vinted | leboncoin | mock (offline demo)
searchText: iphone 13 128  # what you would type in the site's search box
minDiscount: 30            # percent under the market price that counts as a deal
maxRobustZ: -1.0           # "" to turn the "unusual" test off
minSampleSize: 8           # refuse to judge a market with fewer comparables
plausibleMinPrice: 80      # ignore listings outside this range (parts, "for repair")
plausibleMaxPrice: 900
mustMatch: iphone 13       # keep the comparison pool honest - see below
mustNotMatch: cracked, for parts
sizes: 128 Go
acknowledgeTerms: true     # required for vinted/leboncoin; read the section below
```

The numbers that decide whether the output is meaningful are `mustMatch` /
`mustNotMatch` / `sizes` (they define what counts as "the same product"),
`minSampleSize`, and `minDiscount` + `maxRobustZ`. Check your settings against real
data - the **Markets** panel shows the median and how many listings survived your
filters, and the log tells you when a pass found nothing and why.

Config keys accept both this extension's `camelCase` and the Python tool's
`snake_case` (`min_discount`, `plausible_min_price`, ...), so a watch from
`config/watches.yaml` in the Python project can be pasted in as-is.

## How the price is worked out

1. **Sample** the search over a few pages (`samplePages`) with your filters.
2. **Filter** to things that are plausibly the same product: not a part, not
   "for repair", inside your price range, matching your size/condition keywords.
3. **Estimate** the median and the MAD (a spread measure that one crazy listing cannot
   wreck), trimming outliers 3 robust sigmas out.
4. **Score** each fresh listing: `discount = (median - price) / median`, and
   `z = (price - median) / (1.4826 * MAD)`.
5. **Report** only what clears `minDiscount` *and* `maxRobustZ`, in a single currency
   (listings in another currency are never mixed into the same baseline).

No machine learning, no black box: you can read the whole thing in
`src/core/analyzer.js`, and the Python tool this was ported from has the same numbers
checked against it (`tests/parity.test.js`).

## Terms of use - please actually read this

Vinted and leboncoin have **no public API for searching other people's listings**.
This extension uses the same endpoints their own web apps use, with your own browser
session, at a deliberately slow pace (about one request every 6-10 seconds). That is a
grey area: both sites' terms forbid scraping and bots, and leboncoin's `robots.txt`
says so explicitly.

So, the deal we make:

- It is **personal, low-volume use**, not a way to build a product on someone else's
  data. Keep it to the products you are actually shopping for.
- It **paces itself** and does not use several workers in parallel.
- It **never solves a CAPTCHA, rotates proxies, or hides who you are**. If a
  marketplace says no, it stops, logs it, and tells you what to do - it does not hammer
  through the wall.
- You can switch it off any time, and it leaves nothing behind on the marketplace side.
- `acknowledgeTerms: true` is required before a watch on those two marketplaces will
  run at all. It is your acknowledgement, not mine.

If a marketplace blocks you, the honest fix is: slow the interval down (Settings), and
open that marketplace in a normal tab so the browser has a real session. If it still
refuses, stop.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `storage` | Watches, cached price baselines, the deals found and the log. Local only. |
| `alarms` | The scheduled scan. |
| `notifications` | Desktop alerts when a bargain appears. |
| `tabs` | Opening a listing when you click a card or a notification. |
| `cookies` | Reading the marketplace's own `anon_id` cookie - the Vinted web API rejects requests without it. Nothing is stored or sent anywhere. |
| host access to `vinted.*` / `leboncoin.fr` | Only these sites are talked to, only for search requests. |

Nothing is read from or written to any other site, and no data leaves your machine.

## Troubleshooting

| Symptom | What it means |
|---|---|
| Self-check says `MarketplaceBlocked` | The site is refusing automated-looking access from your network. Open the site in a normal tab, browse a bit, then retry. Do not retry in a loop. |
| "no comparable listings ... all filtered out" | Your `mustMatch` / price range is too strict for that search, or the search returns parts and accessories. Loosen it or change `searchText`. |
| "only N comparables (minSampleSize=...)" | Not enough market data to be honest about a price. Lower `minSampleSize` (and trust the verdict less) or pick a broader `searchText`. |
| No deals for days | Normal. That is what "below market" means. Check the log line each pass: it says how many comparables were seen. If it is a lot and there are still no deals, the threshold is doing its job. |
| Prices show a different currency than the site | The marketplace's API is pricing your session in that currency. The comparison stays consistent (one currency per baseline), and the site is the truth when you click through. |

## Development

```bash
npm install         # dev dependency: jsdom, for the dashboard tests only
npm test            # 74 tests: parsers, analyzer parity, storage, service worker, UI
npm run lint        # syntax check on every shipped file
node live-check.mjs # optional: talks to the real Vinted/leboncoin endpoints
```

Layout:

```
manifest.json          MV3 entry point
dashboard.html/.css    the UI you look at
src/dashboard.js       DOM wiring only; logic lives in src/ui/
src/background.js      service worker: alarms, scan loop, notifications, badge, message API
src/core/models.js     data shapes + config validation
src/core/analyzer.js   the statistics (ported from the Python tool, parity-tested)
src/core/adapters/     vinted.js, leboncoin.js, mock.js, base.js (pacing, errors)
src/core/storage.js    chrome.storage + dedupe/alert rules + pruning
src/core/scan.js       one scan: baseline -> freshness -> scoring -> dedupe
```

The service worker is written as `createController({ chrome, fetchImpl })`, which is
why the whole scan -> notify -> badge path is testable in node with a fake `chrome`,
and the dashboard is tested by rendering the real HTML in jsdom against a fake worker.
`tests/parity.test.js` compares the JS analyzer, scorer and both parsers against
expected values generated by the Python implementation.
