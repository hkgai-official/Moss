"""Coding-agent runners. Importing this package auto-registers built-ins.

Built-in providers: Claude Code CLI, OpenAI Codex CLI, DeepSeek-TUI, OpenCode.
Add a fifth by creating a new module that subclasses CodingAgentRunner,
then register its instance below.
"""
from .base import AgentStreamEvent, AgentTokens, CodingAgentRunner
from .claude import ClaudeRunner
from .codex import CodexRunner
from .deepseek_tui import DeepSeekTuiRunner
from .opencode import OpencodeRunner
from .registry import get_runner, list_providers, register, resolve_default

register(ClaudeRunner())
register(CodexRunner())
register(DeepSeekTuiRunner())
register(OpencodeRunner())

__all__ = [
    "AgentStreamEvent",
    "AgentTokens",
    "ClaudeRunner",
    "CodexRunner",
    "CodingAgentRunner",
    "DeepSeekTuiRunner",
    "OpencodeRunner",
    "get_runner",
    "list_providers",
    "register",
    "resolve_default",
]
