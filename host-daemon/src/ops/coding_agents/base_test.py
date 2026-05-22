"""Tests for coding_agents/base.py dataclasses + ABC contract."""
from __future__ import annotations

import pytest

from src.ops.coding_agents.base import (
    AgentStreamEvent,
    AgentTokens,
    CodingAgentRunner,
)


def test_agent_tokens_default_zero():
    t = AgentTokens()
    assert t.input == 0
    assert t.output == 0
    assert t.cache_read == 0
    assert t.cache_write == 0
    assert t.reasoning == 0


def test_agent_tokens_explicit():
    t = AgentTokens(input=100, output=20, cache_read=80, cache_write=5, reasoning=3)
    assert (t.input, t.output, t.cache_read, t.cache_write, t.reasoning) == (100, 20, 80, 5, 3)


def test_agent_stream_event_event_kind():
    e = AgentStreamEvent(kind="event", raw_event={"type": "system"})
    assert e.kind == "event"
    assert e.raw_event == {"type": "system"}
    assert e.exit_code is None
    assert e.message is None


def test_agent_stream_event_result_kind():
    e = AgentStreamEvent(
        kind="result",
        session_id="abc",
        tokens=AgentTokens(input=10),
        exit_code=0,
        elapsed_s=1.5,
        model="sonnet",
    )
    assert e.kind == "result"
    assert e.session_id == "abc"
    assert e.tokens is not None
    assert e.tokens.input == 10
    assert e.model == "sonnet"


def test_agent_stream_event_error_kind():
    e = AgentStreamEvent(kind="error", message="timeout")
    assert e.kind == "error"
    assert e.message == "timeout"
    assert e.session_id is None
    assert e.tokens is None


def test_coding_agent_runner_is_abstract():
    with pytest.raises(TypeError):
        CodingAgentRunner()  # type: ignore[abstract]
