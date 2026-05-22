"""Unit tests for UserMode trial helpers.

Only covers the pure-Python pieces (_build_user_mode_prompt). The
worker-spawn / agent-invoke / transcript-collection paths require docker
and are exercised by the UserMode trial helpers.

MOSS UserMode trial design: user-mode trial no longer carries
mock_replay_table / tool_endpoints — the candidate image is expected to be
self-contained (sandboxed tools live in the image). _build_user_mode_prompt
therefore just emits user_prompt + a short environment hint.
"""
from __future__ import annotations

from src.ops.trial_runner import _build_user_mode_prompt


def test_build_user_mode_prompt_starts_with_user_text():
    out = _build_user_mode_prompt("do the thing")
    assert out.startswith("do the thing")


def test_build_user_mode_prompt_includes_workspace_hint():
    out = _build_user_mode_prompt("anything")
    assert "/tmp_workspace" in out
    assert "Environment" in out


def test_build_user_mode_prompt_does_not_render_tool_block():
    # UserMode trial: no synthetic tool-endpoint block. The candidate
    # image carries its own tools; agent calls them directly. Any text that
    # would have rendered tools (`Tools available`, `curl localhost:9100`)
    # should NOT appear.
    out = _build_user_mode_prompt("ask anything")
    assert "Tools available" not in out
    assert "localhost:9100" not in out
    assert "curl" not in out


def test_build_user_mode_prompt_empty_user_prompt_still_emits_env_block():
    out = _build_user_mode_prompt("")
    assert "Environment" in out
    assert "/tmp_workspace" in out
