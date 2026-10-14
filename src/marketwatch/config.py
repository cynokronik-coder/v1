"""Load the watch list (the products we track) from YAML."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from .models import Watch

DEFAULT_CONFIG = Path("config/watches.yaml")


class ConfigError(Exception):
    pass


def load_watches(path: str | Path | None = None) -> list[Watch]:
    cfg_path = Path(path) if path else Path(os.environ.get("MARKETWATCH_CONFIG", DEFAULT_CONFIG))
    if not cfg_path.exists():
        raise ConfigError(
            f"config file not found: {cfg_path}. "
            "Copy config/watches.example.yaml and adapt it."
        )
    try:
        raw: Any = yaml.safe_load(cfg_path.read_text())
    except yaml.YAMLError as exc:  # pragma: no cover - malformed user file
        raise ConfigError(f"invalid YAML in {cfg_path}: {exc}") from exc

    if not isinstance(raw, dict) or "watches" not in raw:
        raise ConfigError(f"{cfg_path} must contain a top-level 'watches:' list")

    defaults = raw.get("defaults") or {}
    watches: list[Watch] = []
    for idx, entry in enumerate(raw["watches"] or []):
        if not isinstance(entry, dict):
            raise ConfigError(f"watches[{idx}] must be a mapping")
        merged = {**defaults, **entry}
        try:
            watches.append(Watch(**merged))
        except ValidationError as exc:
            raise ConfigError(f"invalid watch 'watches[{idx}]' ({entry.get('name')}): {exc}") from exc

    seen: set[str] = set()
    for w in watches:
        if w.name in seen:
            raise ConfigError(f"duplicate watch name: {w.name}")
        seen.add(w.name)
    if not watches:
        raise ConfigError(f"no watches defined in {cfg_path}")
    return watches


def select_watches(watches: list[Watch], names: list[str] | None) -> list[Watch]:
    if not names:
        return watches
    wanted = {n.lower() for n in names}
    picked = [w for w in watches if w.name.lower() in wanted]
    missing = wanted - {w.name.lower() for w in picked}
    if missing:
        raise ConfigError(f"unknown watch(es): {', '.join(sorted(missing))}")
    return picked
