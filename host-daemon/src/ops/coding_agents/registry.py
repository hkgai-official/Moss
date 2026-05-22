"""Coding-agent runner registry.

See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §4."""
from __future__ import annotations

import os

from .base import CodingAgentRunner

_RUNNERS: dict[str, CodingAgentRunner] = {}


def register(runner: CodingAgentRunner) -> None:
    """Register a runner. Called once per provider at import time."""
    name = runner.provider_name
    if name in _RUNNERS:
        raise ValueError(f"runner already registered: {name}")
    _RUNNERS[name] = runner


def get_runner(provider: str) -> CodingAgentRunner | None:
    return _RUNNERS.get(provider)


def list_providers() -> list[str]:
    return sorted(_RUNNERS.keys())


def resolve_default() -> str:
    """Get the default provider name from MOSS_AGENT_PROVIDER env, validated."""
    name = os.environ.get("MOSS_AGENT_PROVIDER", "claude").strip().lower()
    if name not in _RUNNERS:
        raise ValueError(
            f"MOSS_AGENT_PROVIDER={name!r} not in registered providers "
            f"{list_providers()}"
        )
    return name
