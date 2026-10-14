/** The watch editor: form strings <-> a watch the scanner will actually run. */

import test from "node:test";
import assert from "node:assert/strict";

import { blankWatchForm, formToWatch, formatList, parseList, parseOptionalNumber, parsePercent, watchToForm } from "../src/ui/watch-form.js";
import { normalizeWatch } from "../src/core/models.js";

const FORM = {
  name: "iphone",
  marketplace: "vinted",
  searchText: "iphone 13 128",
  mustMatch: "iphone 13, 128 go\niphone 13 pro",
  mustNotMatch: "cracked",
  sizes: "128 Go",
  conditions: "Bon état",
  minDiscount: "40",
  maxRobustZ: "-1.0",
  minSampleSize: "12",
  plausibleMinPrice: "80",
  plausibleMaxPrice: "900",
  samplePages: "2",
  acknowledgeTerms: true,
};

test("form values become a watch the scanner accepts", () => {
  const watch = formToWatch(FORM);
  assert.equal(watch.name, "iphone");
  assert.equal(watch.minDiscount, 0.4); // 40 means 40%, not 40x
  assert.deepEqual(watch.mustMatch, ["iphone 13", "128 go", "iphone 13 pro"]);
  assert.deepEqual(watch.mustNotMatch, ["cracked"]);
  assert.equal(watch.maxRobustZ, -1);
  assert.equal(watch.acknowledgeTerms, true);
  assert.equal(watch.enabled, true);
});

test("a watch round-trips through the form without drifting", () => {
  const watch = formToWatch(FORM);
  const again = formToWatch(watchToForm(watch));
  assert.deepEqual(again, watch);
});

test("conditions are edited, not silently dropped on save", () => {
  // The editor used to have no conditions field, so saving rewrote them to [].
  const watch = formToWatch(FORM);
  assert.deepEqual(watch.conditions, ["Bon état"]);
  assert.equal(watchToForm(watch).conditions, "Bon état");
  assert.deepEqual(formToWatch({ ...FORM, conditions: "neuf, très bon état" }).conditions, ["neuf", "très bon état"]);
});

test("exact phrase is on for a new watch and round-trips both ways", () => {
  const blank = blankWatchForm("vinted");
  assert.equal(blank.exactPhrase, true, "a watch created here should insist on the phrase");
  assert.equal(formToWatch({ ...blank, name: "x", searchText: "iphone 13 256" }).exactPhrase, true);

  // Unticking it is respected, and a watch that stores false shows unticked.
  assert.equal(formToWatch({ ...FORM, exactPhrase: false }).exactPhrase, false);
  const off = formToWatch({ ...FORM, exactPhrase: false });
  assert.equal(watchToForm(off).exactPhrase, false);
  assert.equal(formToWatch(watchToForm(off)).exactPhrase, false);

  // A config written for the Python tool has no such field: it must stay off.
  const imported = formToWatch({ ...FORM, exactPhrase: undefined });
  assert.equal(imported.exactPhrase, true, "the form itself defaults to on");
  assert.equal(normalizeWatch({ name: "w", searchText: "x" }).exactPhrase, false, "the model defaults to off");
});

test("percentages, commas and 'off' are read the way a person types them", () => {
  assert.equal(parsePercent("40"), 0.4);
  assert.equal(parsePercent("40%"), 0.4);
  assert.equal(parsePercent("0.4"), 0.4);
  assert.equal(parsePercent("7,5"), 0.075);
  assert.throws(() => parsePercent(""), /required/);
  assert.throws(() => parsePercent("lots"), /must be a number/);
  assert.throws(() => parsePercent("150"), /between 0 and 99%/);

  assert.equal(parseOptionalNumber("", { field: "z" }), null);
  assert.equal(parseOptionalNumber("off", { field: "z" }), null);
  assert.equal(parseOptionalNumber("none", { field: "z" }), null);
  assert.equal(parseOptionalNumber("-1.5", { field: "z" }), -1.5);
  assert.throws(() => parseOptionalNumber("nope", { field: "max robust z" }), /max robust z/);
});

test("an invalid form is rejected with a message worth showing", () => {
  assert.throws(() => formToWatch({ ...FORM, name: "" }), /has no name/);
  assert.throws(() => formToWatch({ ...FORM, searchText: "" }), /has no searchText/);
  assert.throws(() => formToWatch({ ...FORM, marketplace: "wallapop" }), /unknown marketplace/);
  assert.throws(
    () => formToWatch({ ...FORM, plausibleMinPrice: "900", plausibleMaxPrice: "100" }),
    /must be below/,
  );
  assert.throws(() => formToWatch({ ...FORM, maxRobustZ: "high" }), /max robust z/);
});

test("list parsing handles what people actually paste", () => {
  assert.deepEqual(parseList("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(parseList("a\nb"), ["a", "b"]);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(["a", "", "b"]), ["a", "b"]);
  assert.equal(formatList(["a", "b"]), "a, b");
});

test("a blank form is valid enough to be a starting point", () => {
  const blank = blankWatchForm("leboncoin");
  assert.equal(blank.marketplace, "leboncoin");
  assert.throws(() => formToWatch(blank), /has no name/); // still needs a name
  assert.equal(formToWatch({ ...blank, name: "x", searchText: "velo" }).marketplace, "leboncoin");
});
