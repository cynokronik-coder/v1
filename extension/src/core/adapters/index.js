/**
 * Adapter registry: marketplace id -> adapter instance.
 *
 * Four marketplaces have a dedicated adapter because they need one: Vinted (anon
 * cookie, catalogue endpoint), leboncoin (three transports behind one facade),
 * eBay (OAuth + the only documented search API) and Back Market (a page whose
 * embedded payload is unusual enough to deserve its own parser). Everything else
 * in core/sources.js is served by the generic page adapter, driven by the
 * registry's own host list, URL template and mode.
 *
 * That is the point of the registry: adding a marketplace is a data change, not a
 * new file.
 */

import { MarketplaceError } from "./base.js";
import { BackMarketAdapter } from "./backmarket.js";
import { EbayAdapter } from "./ebay.js";
import { LeboncoinAdapter } from "./leboncoin.js";
import { MockAdapter } from "./mock.js";
import { createPageAdapter } from "./page-source.js";
import { VintedAdapter } from "./vinted.js";
import { MODE, SOURCE_IDS, sourceById } from "../sources.js";

export function getAdapter(marketplace, options = {}) {
  const source = sourceById(marketplace);
  if (!source) {
    throw new MarketplaceError(
      `unknown marketplace '${marketplace}' (expected: ${SOURCE_IDS.join(" | ")})`,
    );
  }
  switch (source.id) {
    case "vinted":
      return new VintedAdapter(options);
    case "leboncoin":
      return new LeboncoinAdapter(options);
    case "ebay":
      return new EbayAdapter(options);
    case "backmarket":
      return new BackMarketAdapter(options);
    case "mock":
      return new MockAdapter(options);
    default:
      return createPageAdapter(source, options);
  }
}

export { MODE, sourceById };
