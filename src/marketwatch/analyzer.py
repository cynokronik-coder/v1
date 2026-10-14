"""Estimate the market price of a product and score listings against it.

Why robust statistics instead of a plain mean:
second-hand listing prices are right-skewed and full of junk (missing parts,
wrong model, EUR 1 placeholder listings). A mean is dragged around by those;
the median plus a MAD-based sigma is not. We therefore use:

  market price  = median of the comparable pool
  sigma         = 1.4826 * MAD          (consistent estimator for normal data)
  robust z      = (price - median) / sigma

A listing is only a "deal" when it is BOTH cheap in relative terms
(price <= median * (1 - min_discount)) AND a genuine statistical outlier
(z <= max_robust_z), and when that verdict rests on enough comparables.
"""

from __future__ import annotations

from statistics import fmean

from .models import Deal, Listing, PriceStats, Watch

MAD_TO_SIGMA = 1.4826


def median(values: list[float]) -> float:
    if not values:
        raise ValueError("median() of empty sequence")
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def quantile(values: list[float], p: float) -> float:
    """Linear-interpolation quantile (numpy/statistics 'inclusive' method)."""
    if not values:
        raise ValueError("quantile() of empty sequence")
    if not 0.0 <= p <= 1.0:
        raise ValueError("p must be in [0, 1]")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = p * (len(ordered) - 1)
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return ordered[low] * (1 - frac) + ordered[high] * frac


def mad(values: list[float], med: float | None = None) -> float:
    med = median(values) if med is None else med
    return median([abs(v - med) for v in values])


def robust_sigma(values: list[float], med: float | None = None) -> float:
    """MAD-based sigma, with a sane fallback for degenerate pools.

    When more than half the pool shares one price, MAD collapses to 0 and every
    z-score would be infinite. Falling back to 10% of the median keeps the
    outlier test meaningful instead of blowing up.
    """
    med = median(values) if med is None else med
    sigma = MAD_TO_SIGMA * mad(values, med)
    if sigma <= 0:
        sigma = max(0.1 * med, 1e-9)
    return sigma


def trim_outliers(prices: list[float], k: float = 3.0) -> tuple[list[float], float | None]:
    """Drop far outliers using Tukey fences (q1 - k*IQR, q3 + k*IQR).

    k=3 (rather than the usual 1.5) only removes extreme values, so a pool that
    is genuinely expensive-wide still describes itself honestly.
    """
    if len(prices) < 4:
        return list(prices), None
    q1, q3 = quantile(prices, 0.25), quantile(prices, 0.75)
    iqr = q3 - q1
    lower = q1 - k * iqr
    upper = q3 + k * iqr if iqr > 0 else None
    kept = [p for p in prices if p >= lower and (upper is None or p <= upper)]
    return (kept or list(prices)), lower


def build_stats(prices: list[float], currency: str, *, trim_k: float = 3.0) -> PriceStats:
    kept, lower_fence = trim_outliers(prices, trim_k)
    med = median(kept)
    return PriceStats(
        sample_size=len(prices),
        used_size=len(kept),
        currency=currency,
        median=med,
        mean=fmean(kept),
        q1=quantile(kept, 0.25),
        q3=quantile(kept, 0.75),
        mad=mad(kept, med),
        lower_fence=lower_fence,
    )


def is_plausible(listing: Listing, watch: Watch) -> bool:
    """Price band a real listing of this product lives in (junk filter)."""
    return watch.plausible_min_price <= listing.price <= watch.plausible_max_price


def matches_product(listing: Listing, watch: Watch) -> bool:
    """Is this the same product? (title keywords, size, condition)

    Matters as much for candidates as for the baseline: a "kids" or "case only"
    listing is cheap because it is a different thing, not a bargain.
    """
    if not watch.title_matches(listing.title):
        return False
    if not watch.value_matches(listing.size, watch.sizes):
        return False
    if not watch.value_matches(listing.condition, watch.conditions):
        return False
    return True


def is_comparable(listing: Listing, watch: Watch) -> bool:
    """Everything that must hold for a listing to enter the baseline pool."""
    return matches_product(listing, watch) and is_plausible(listing, watch)


def filter_comparables(listings: list[Listing], watch: Watch) -> list[Listing]:
    return [l for l in listings if is_comparable(l, watch)]


def score_listing(listing: Listing, stats: PriceStats, watch: Watch,
                  sigma: float | None = None) -> Deal | None:
    """Return a Deal when the listing clears both thresholds, else None."""
    if stats.median <= 0:
        return None
    if not matches_product(listing, watch):
        return None
    if not is_plausible(listing, watch):
        return None
    discount = 1.0 - (listing.price / stats.median)
    if discount < watch.min_discount:
        return None
    if sigma is None:
        sigma = robust_sigma_from_stats(stats)
    z = (listing.price - stats.median) / sigma
    if watch.max_robust_z is not None and z > watch.max_robust_z:
        return None
    return Deal(
        watch=watch.name,
        listing=listing,
        market_price=stats.median,
        discount_pct=discount,
        robust_z=z,
        landed_price=listing.landed_price,
        reasons=[
            f"{discount * 100:.1f}% below the {stats.currency} market median "
            f"({stats.median:.2f} over {stats.used_size} comparable listings)",
            f"robust z-score {z:.2f} "
            + (f"(<= {watch.max_robust_z})" if watch.max_robust_z is not None
               else "(reported, no z gate configured)"),
            f"condition={listing.condition or 'n/a'} size={listing.size or 'n/a'}",
        ],
        stats=stats,
    )


def robust_sigma_from_stats(stats: PriceStats) -> float:
    sigma = MAD_TO_SIGMA * stats.mad
    if sigma <= 0:
        sigma = max(0.1 * stats.median, 1e-9)
    return sigma


def explain_no_deals(candidates: list[Listing], stats: PriceStats | None,
                     watch: Watch, *, limit: int = 3) -> list[str]:
    """Why nothing was flagged: the cheapest few matches and their numbers.

    Tuning a watch means knowing whether the market is thin, the filters are
    too strict, or the thresholds are simply unreachable for this product.
    """
    if stats is None:
        return []
    matched = [c for c in candidates if matches_product(c, watch) and is_plausible(c, watch)]
    if not matched:
        return ["no listing matched the product filters (title / size / condition / price band)"]
    sigma = robust_sigma_from_stats(stats)
    notes = [
        f"z-gate is off (discount alone decides)" if watch.max_robust_z is None
        else f"thresholds: >= {watch.min_discount * 100:.0f}% under median "
             f"({stats.median * (1 - watch.min_discount):.2f} {stats.currency}) "
             f"and z <= {watch.max_robust_z}"
    ]
    for listing in sorted(matched, key=lambda l: l.price)[:limit]:
        discount = 1 - listing.price / stats.median
        z = (listing.price - stats.median) / sigma
        notes.append(
            f"closest match {listing.price:.2f} {listing.currency} "
            f"({discount * 100:.0f}% under, z {z:.2f}) - {listing.title[:60]}"
        )
    return notes


def find_deals(candidates: list[Listing], stats: PriceStats | None, watch: Watch) -> list[Deal]:
    """Score every candidate, best discount first."""
    if stats is None or stats.used_size < watch.min_sample_size:
        return []
    sigma = robust_sigma_from_stats(stats)
    deals = [d for d in (score_listing(c, stats, watch, sigma) for c in candidates) if d]
    deals.sort(key=lambda d: (d.discount_pct, -d.listing.price), reverse=True)
    return deals


def best_comparable_price(stats: PriceStats) -> float:
    """Reference floor we expect a fair listing to sit at or above."""
    return stats.q1
