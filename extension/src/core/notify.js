/**
 * Turning a deal into something a human can act on: one line for a notification,
 * a payload for storage/the UI, and a chrome.notifications object.
 */

export function dealSummary(deal) {
  const listing = deal.listing;
  let title = String(listing.title || "(untitled)").trim();
  if (title.length > 60) title = `${title.slice(0, 57)}...`;
  return (
    `${title} - ${listing.price.toFixed(2)} ${listing.currency} ` +
    `(${(deal.discountPct * 100).toFixed(0)}% under market ` +
    `${deal.marketPrice.toFixed(2)} ${listing.currency}) [${deal.watch}/${listing.marketplace}]\n${listing.url}`
  );
}

export function dealPayload(deal) {
  const listing = deal.listing;
  return {
    key: `${deal.watch}|${listing.marketplace}|${listing.itemId}`,
    watch: deal.watch,
    marketplace: listing.marketplace,
    itemId: listing.itemId,
    title: listing.title,
    url: listing.url,
    imageUrl: listing.imageUrl,
    price: listing.price,
    currency: listing.currency,
    landedPrice: listing.landedPrice,
    marketPrice: deal.marketPrice,
    discountPct: Math.round(deal.discountPct * 10000) / 10000,
    robustZ: Math.round(deal.robustZ * 1000) / 1000,
    condition: listing.condition,
    size: listing.size,
    brand: listing.brand,
    reasons: deal.reasons,
    firstSeen: deal.firstSeen,
  };
}

export const NOTIFICATION_BUTTONS = [{ title: "Open listing" }];

/**
 * chrome.notifications payload. `title` is the product, `message` the numbers:
 * the point is to decide from the lock screen whether to go look.
 */
export function notificationFor(deal, { iconUrl = "icons/icon128.png" } = {}) {
  const listing = deal.listing;
  const title = String(listing.title || "(untitled)").trim();
  return {
    type: "basic",
    iconUrl,
    title: title.length > 90 ? `${title.slice(0, 87)}...` : title,
    message:
      `${listing.price.toFixed(2)} ${listing.currency} - ` +
      `${(deal.discountPct * 100).toFixed(0)}% under ${deal.marketPrice.toFixed(2)} ${listing.currency}` +
      `  (${deal.watch})`,
    contextMessage: [listing.brand, listing.size, listing.condition, listing.marketplace]
      .filter(Boolean)
      .join(" · "),
    priority: 2,
    requireInteraction: false,
    silent: false,
    buttons: NOTIFICATION_BUTTONS,
  };
}
