/** Public-interest signals: the URLs we build, the growth we read, the blend we report. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  gdeltUrl,
  growthFromSeries,
  growthScore,
  parseGdelt,
  parsePageviews,
  scoreTrends,
  socialMatch,
  wikipediaUrl,
} from "../src/core/trends.js";

const NOW = Date.parse("2026-02-01T12:00:00Z");

function pageviewsPayload(values, startDay = 1) {
  return {
    items: values.map((views, index) => {
      const day = String(startDay + index).padStart(2, "0");
      return { timestamp: `202601${day}00`, views };
    }),
  };
}

test("the pageviews URL asks for the article, the window, and nothing else", () => {
  const url = wikipediaUrl({ article: "IPhone 13", days: 60, now: NOW });
  const parsed = new URL(url);
  assert.equal(parsed.host, "wikimedia.org");
  // 60 daily points ending yesterday (Wikimedia's data lags by about a day).
  assert.equal(parsed.pathname, "/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/IPhone_13/daily/20251203/20260131");
  assert.equal(wikipediaUrl({ article: null }), null);
  // An article with a space is written with an underscore and URL-encoded.
  assert.match(wikipediaUrl({ article: "GeForce 40 series", now: NOW }), /GeForce_40_series/);
});

test("the news-attention URL is a plain, key-less GDELT timeline call", () => {
  const url = gdeltUrl({ query: "iphone 13", days: 90 });
  const parsed = new URL(url);
  assert.equal(parsed.host, "api.gdeltproject.org");
  assert.equal(parsed.searchParams.get("query"), '"iphone 13"');
  assert.equal(parsed.searchParams.get("mode"), "timelinevol");
  assert.equal(parsed.searchParams.get("timespan"), "90d");
  assert.equal(gdeltUrl({ query: "" }), null);
});

test("growth compares the recent window with the one before it", () => {
  const rising = growthFromSeries(
    Array.from({ length: 40 }, (_v, index) => ({ date: `d${index}`, views: index < 26 ? 100 : 200 })),
    { recentDays: 14 },
  );
  assert.ok(rising.growth > 0.9, `expected a doubling, got ${rising.growth}`);
  assert.equal(rising.recentMean, 200);
  assert.equal(rising.priorMean, 100);

  const falling = growthFromSeries(
    Array.from({ length: 40 }, (_v, index) => ({ date: `d${index}`, views: index < 26 ? 200 : 100 })),
    { recentDays: 14 },
  );
  assert.ok(falling.growth < -0.4);

  assert.equal(growthFromSeries([], {}).growth, null);
  assert.equal(growthFromSeries([{ views: 1 }, { views: 2 }], { recentDays: 14 }).growth, null, "two points are not a trend");
});

test("the real payload shapes parse into a series", () => {
  const wiki = parsePageviews(pageviewsPayload([10, 12, 14, 16]));
  assert.deepEqual(wiki.series[0], { date: "2026-01-01", views: 10 });
  assert.equal(wiki.series.length, 4);

  const gdelt = parseGdelt({
    timeline: [{ series: [{ data: [{ date: "20260101T000000Z", value: 1.5 }, { date: "20260102T000000Z", value: 3 }] }] }],
  });
  assert.deepEqual(gdelt.series, [
    { date: "2026-01-01", views: 1.5 },
    { date: "2026-01-02", views: 3 },
  ]);
  assert.deepEqual(parsePageviews({}).series, []);
  assert.deepEqual(parseGdelt({ timeline: [] }).series, []);
});

test("growth becomes a 0..1 score you can reason about", () => {
  assert.equal(growthScore(-0.5), 0);
  assert.equal(growthScore(0), 0.5);
  assert.equal(growthScore(0.5), 1);
  assert.equal(growthScore(5), 1, "clamped, not a score of five");
  assert.equal(growthScore(null), null);
});

test("your own hot list matches words, not vibes", () => {
  const product = { keyword: "iphone 13 256", name: "iPhone 13", socialKeywords: ["iphone 13"] };
  assert.deepEqual(socialMatch({ product, hotKeywords: ["iphone 13"] }).matched, ["iphone 13"]);
  assert.equal(socialMatch({ product, hotKeywords: ["iphone 14"] }).score, 0);
  assert.equal(socialMatch({ product, hotKeywords: [] }).score, 0);
});

test("the blend only counts what was actually measured", () => {
  const wikiOnly = scoreTrends({
    wikipedia: { growth: 0.5, recentMean: 150, priorMean: 100, series: [1, 2] },
  });
  assert.equal(wikiOnly.score, 1);
  assert.equal(wikiOnly.measured, 1);
  assert.match(wikiOnly.reasons.join(" "), /Wikipedia pageviews/);
  assert.match(wikiOnly.reasons.join(" "), /\+50%/);

  const withSocial = scoreTrends({
    wikipedia: { growth: 0, recentMean: 100, priorMean: 100, series: [1, 2] },
    social: { matched: ["iphone 13"], score: 1 },
  });
  assert.ok(withSocial.score > 0.5 && withSocial.score < 1, "flat interest plus a hot keyword should land in between");
  assert.equal(withSocial.measured, 2);
  assert.match(withSocial.reasons.join(" "), /on your own hot list/);

  const nothing = scoreTrends({ errors: ["public interest unavailable (HTTP 404)"] });
  assert.equal(nothing.score, 0);
  assert.equal(nothing.measured, 0);
  assert.match(nothing.reasons.join(" "), /no trend data available/);
  assert.match(nothing.reasons.join(" "), /HTTP 404/);
});
