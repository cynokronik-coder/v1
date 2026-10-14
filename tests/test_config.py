from pathlib import Path

import pytest

from marketwatch.config import ConfigError, load_watches, select_watches

EXAMPLE = Path("config/watches.example.yaml")


def test_example_config_is_valid():
    watches = load_watches(EXAMPLE)
    assert [w.name for w in watches] == [
        "nike-air-max-90", "iphone-13-128", "demo-offline", "iphone-13-lbc", "thinkpad-t480"
    ]
    air = watches[0]
    assert air.marketplace == "vinted" and air.domain == "vinted.fr"
    assert air.must_not_match and air.sizes == ["42", "42.5", "43", "44"]
    # defaults block is inherited
    assert air.min_sample_size == 8 and watches[1].min_sample_size == 8
    # per-watch override wins
    assert air.min_discount == 0.35 and watches[1].plausible_min_price == 120
    # the shipped offline demo must always work: it is the documented first run
    assert watches[2].marketplace == "mock" and watches[2].search_text == "pixel 8"
    # the leboncoin example carries the marketplace-specific filter keys
    lbc = watches[3]
    assert lbc.marketplace == "leboncoin" and lbc.domain == "www.leboncoin.fr"
    assert lbc.filters["category"] == ["2978"]
    assert lbc.filters["ad_type"] == ["offer"] and lbc.filters["owner_type"] == ["private"]
    assert lbc.sample_pages == 4          # a leboncoin page holds at most 35 ads
    assert lbc.max_robust_z is None


def test_missing_file(monkeypatch, tmp_path):
    monkeypatch.delenv("MARKETWATCH_CONFIG", raising=False)
    with pytest.raises(ConfigError, match="not found"):
        load_watches(tmp_path / "nope.yaml")


def test_duplicate_names_and_bad_entries(tmp_path):
    dup = tmp_path / "dup.yaml"
    dup.write_text("watches:\n  - {name: a, search_text: x}\n  - {name: a, search_text: y}\n")
    with pytest.raises(ConfigError, match="duplicate"):
        load_watches(dup)

    bad = tmp_path / "bad.yaml"
    bad.write_text("watches:\n  - {search_text: x}\n")
    with pytest.raises(ConfigError, match="invalid watch"):
        load_watches(bad)

    empty = tmp_path / "empty.yaml"
    empty.write_text("watches: []\n")
    with pytest.raises(ConfigError, match="no watches"):
        load_watches(empty)


def test_select_watches():
    watches = load_watches(EXAMPLE)
    assert [w.name for w in select_watches(watches, ["THINKPAD-T480"])] == ["thinkpad-t480"]
    assert len(select_watches(watches, None)) == 5
    with pytest.raises(ConfigError, match="unknown"):
        select_watches(watches, ["typo"])


def test_acknowledge_terms_defaults_to_false_and_is_per_watch():
    """The CLI warns until this is explicitly acknowledged."""
    watches = load_watches(EXAMPLE)
    assert all(w.acknowledge_terms is False for w in watches)
    acked = load_watches(EXAMPLE)
    acked[0].acknowledge_terms = True
    assert acked[0].acknowledge_terms is True
