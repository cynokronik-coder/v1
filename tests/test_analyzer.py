import math

import pytest

from marketwatch.analyzer import (
    build_stats,
    find_deals,
    is_comparable,
    median,
    quantile,
    robust_sigma,
    score_listing,
    trim_outliers,
)
from marketwatch.models import Listing, Watch


def mk(price, title="iPhone 13 128GB black", condition="very good", size="128GB", **kw):
    return Listing(
        marketplace="mock", item_id=str(price), title=title, url="http://x/y",
        price=price, currency="EUR", condition=condition, size=size, **kw
    )


def test_median_and_quantile():
    assert median([3, 1, 2]) == 2
    assert median([4, 1, 3, 2]) == 2.5
    assert quantile([0, 10], 0.5) == 5
    assert quantile([1, 2, 3, 4], 0.25) == 1.75
    with pytest.raises(ValueError):
        median([])


def test_trim_outliers_only_removes_far_values():
    prices = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 1.0, 100000]
    kept, lower = trim_outliers(prices, k=3.0)
    assert 1.0 not in kept and 100000 not in kept
    assert len(kept) == 11 and lower is not None


def test_trim_outliers_keeps_small_pools_intact():
    kept, lower = trim_outliers([10, 20, 30])
    assert kept == [10, 20, 30] and lower is None


def test_robust_sigma_falls_back_when_mad_is_zero():
    flat = [100.0] * 12
    sigma = robust_sigma(flat)
    assert sigma > 0 and math.isclose(sigma, 10.0)  # 10% of the median
    stats = build_stats(flat, "EUR")
    assert stats.mad == 0 and stats.median == 100


def test_build_stats_is_robust_to_a_junk_outlier():
    pool = [200, 210, 220, 190, 205, 215, 195, 225, 185, 230, 1.0]
    stats = build_stats(pool, "EUR")
    assert stats.median == 207.5  # median of the 10 kept values (even count)
    assert stats.used_size == 10 and stats.sample_size == 11  # the 1.00 junk is trimmed
    assert stats.mad > 0


WATCH = Watch(
    name="iphone",
    search_text="iphone 13 128",
    marketplace="mock",
    must_match=["iphone 13"],
    must_not_match=["pro", "mini", "case"],
    plausible_min_price=100,
    plausible_max_price=600,
    min_discount=0.30,
    max_robust_z=-1.0,
    min_sample_size=8,
)


def test_comparability_filters():
    assert is_comparable(mk(300), WATCH)
    assert not is_comparable(mk(300, title="iPhone 13 Pro 128GB"), WATCH)      # must_not_match
    assert not is_comparable(mk(300, title="iPhone 13 mini 128GB"), WATCH)
    assert not is_comparable(mk(300, title="Samsung Galaxy S22"), WATCH)       # must_match
    assert not is_comparable(mk(1.0), WATCH)                                    # junk floor
    assert not is_comparable(mk(9999), WATCH)                                   # ceiling
    sized = WATCH.model_copy(update={"sizes": ["128GB"]})
    assert is_comparable(mk(300, size="128GB"), sized)
    assert not is_comparable(mk(300, size="256GB"), sized)


def test_score_listing_computes_discount_and_z():
    pool = [180, 190, 195, 200, 205, 210, 215, 220, 185, 225]
    stats = build_stats(pool, "EUR")
    deal = score_listing(mk(120), stats, WATCH)
    assert deal is not None
    assert deal.market_price == 202.5
    assert math.isclose(deal.discount_pct, 1 - 120 / 202.5, abs_tol=1e-9)
    assert deal.robust_z < -3
    assert "40.7% below" in deal.reasons[0]


def test_score_listing_rejects_small_discount():
    stats = build_stats([180, 190, 195, 200, 205, 210, 215, 220, 185, 225], "EUR")
    assert score_listing(mk(170), stats, WATCH) is None       # 15% under


def test_score_listing_rejects_when_market_is_dispersed():
    """25% under is not remarkable if the pool is that noisy."""
    noisy = [60, 80, 120, 200, 260, 320, 380, 140, 440, 500]
    stats = build_stats(noisy, "EUR")
    loose = WATCH.model_copy(update={"min_discount": 0.10})
    assert score_listing(mk(150), stats, loose) is None


def test_score_listing_rejects_junk_below_floor():
    stats = build_stats([180, 190, 195, 200, 205, 210, 215, 220, 185, 225], "EUR")
    assert score_listing(mk(1.0), stats, WATCH) is None


def test_find_deals_requires_enough_comparables():
    stats = build_stats([200, 210, 190], "EUR")
    assert find_deals([mk(100)], stats, WATCH) == []
    assert find_deals([mk(100)], None, WATCH) == []


def test_find_deals_sorted_by_discount():
    stats = build_stats([180, 190, 195, 200, 205, 210, 215, 220, 185, 225], "EUR")
    loose = WATCH.model_copy(update={"plausible_min_price": 10})
    deals = find_deals([mk(150), mk(100), mk(60)], stats, loose)
    assert [d.listing.price for d in deals] == [60, 100]  # best discount first
    assert deals[0].discount_pct >= deals[-1].discount_pct


def test_size_matching_is_token_aware_not_substring():
    w = WATCH.model_copy(update={"sizes": ["9", "42", "42,5", "UK 8"]})
    assert w.value_matches("US 9", w.sizes)          # whole number token
    assert w.value_matches("9", w.sizes)
    assert w.value_matches("42 EU", w.sizes)
    assert w.value_matches("UK 8", w.sizes)          # multi-word entry
    assert w.value_matches("42,5", w.sizes)          # decimal comma in the field
    assert not w.value_matches("39.5", w.sizes)      # 9 must not match 39.5
    assert not w.value_matches("142", w.sizes)       # 42 must not match 142
    # allowlist "42,5" and field "42.5" are the same size (comma normalised)
    assert w.value_matches("42.5", w.sizes)
    assert not w.value_matches("44", w.sizes)
    assert not w.value_matches(None, w.sizes)
    assert w.value_matches(None, [])                 # empty allowlist = all sizes


def test_condition_matching_still_allows_substrings():
    w = WATCH.model_copy(update={"conditions": ["bon état", "new"]})
    assert w.value_matches("Très bon état", w.conditions)
    assert w.value_matches("New with tags", w.conditions)
    assert not w.value_matches("Satisfaisant", w.conditions)


def test_z_gate_can_be_disabled():
    stats = build_stats([180, 190, 195, 200, 205, 210, 215, 220, 185, 225], "EUR")
    noisy = build_stats([60, 80, 120, 200, 260, 320, 380, 140, 440, 500], "EUR")
    off = WATCH.model_copy(update={"max_robust_z": None, "min_discount": 0.10})
    assert score_listing(mk(150), noisy, off) is not None   # discount alone decides
    assert score_listing(mk(150), noisy, WATCH.model_copy(update={"min_discount": 0.10})) is None


def test_explain_no_deals_reports_the_closest_matches():
    from marketwatch.analyzer import explain_no_deals

    stats = build_stats([180, 190, 195, 200, 205, 210, 215, 220, 185, 225], "EUR")
    notes = explain_no_deals([mk(150), mk(190)], stats, WATCH)
    assert "thresholds" in notes[0]
    assert len(notes) == 3 and "closest match 150.00" in notes[1]

    assert explain_no_deals([mk(150)], None, WATCH) == []
    filtered = explain_no_deals([mk(150, title="iPhone 13 Pro")], stats, WATCH)
    assert "no listing matched the product filters" in filtered[0]
