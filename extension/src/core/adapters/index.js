/** Adapter registry: marketplace name -> adapter instance. */

import { MarketplaceError } from "./base.js";
import { LeboncoinAdapter } from "./leboncoin.js";
import { MockAdapter } from "./mock.js";
import { VintedAdapter } from "./vinted.js";

export function getAdapter(marketplace, options = {}) {
  const key = String(marketplace || "").trim().toLowerCase();
  if (key === "vinted") return new VintedAdapter(options);
  if (key === "leboncoin" || key === "lbc") return new LeboncoinAdapter(options);
  if (key === "mock" || key === "fixture") return new MockAdapter(options);
  throw new MarketplaceError(`unknown marketplace '${marketplace}' (expected: vinted | leboncoin | mock)`);
}
