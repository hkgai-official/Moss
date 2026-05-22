<h1 align="center">MOSS</h1>

<p align="center">
  <strong>Self-Evolution through Source-Level Rewriting in Autonomous Agent Systems</strong>
</p>

<p align="center">
  <a href="https://github.com/hkgai-official/Moss/stargazers"><img src="https://img.shields.io/github/stars/hkgai-official/Moss?style=social" alt="GitHub Stars"></a>
  <a href="https://github.com/hkgai-official/Moss/blob/main/LICENSE"><img src="https://img.shields.io/github/license/hkgai-official/Moss" alt="License"></a>
  <a href="https://arxiv.org/pdf/2605.22794"><img src="https://img.shields.io/badge/arXiv-2605.22794-b31b1b.svg" alt="arXiv"></a>
</p>

---

## About

MOSS is a self-evolving AI assistant on the [OpenClaw](https://github.com/openclaw/openclaw) agent framework. A periodic background scan surfaces underperforming turns from recent sessions, and users can also report issues directly in conversation. MOSS curates these into a failure batch, rewrites its own TypeScript source to fix the underlying defects, verifies the candidate by replaying the batch on ephemeral trial workers, and — after explicit user authorization — performs an in-place container swap with health-probe-gated rollback.

## Quickstart

### Prerequisites

- Docker 24+
- Node 22+, pnpm 10
- Python 3.11+
- An openai-completions-compatible LLM endpoint (any of OpenAI / DeepSeek / a local Ollama / etc.)
- One coding-agent CLI installed and authenticated:
  - **Claude Code CLI 2.x** (default) — `claude --version`, login via `claude`
  - **OpenAI Codex CLI** — `codex login` or `OPENAI_API_KEY`
  - **DeepSeek-TUI** ([github.com/Hmbown/DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI)) — `~/.deepseek/config.toml`
  - **OpenCode** ([opencode.ai](https://opencode.ai)) — `opencode auth login`

### Install

```
git clone https://github.com/hkgai-official/Moss.git moss
cd moss
cp .env.example .env
# fill MOSS_MODEL_API_KEY
# optionally set MOSS_AGENT_PROVIDER (default: claude)
./scripts/setup.sh
```

First run builds the openclaw image (~5 min). On success, `setup.sh` prints the dashboard URL: `http://localhost:19799/?token=<your-token>`.

Re-run `setup.sh` after editing `.env` or pulling new code; it's idempotent.

## Use it

MOSS drives evolution entirely through conversation with the chat agent — no extra UI panel, no manual flag button. The agent receives system-prompt-injected guidance pointing at a `moss evo` CLI binary it can run via its `exec` tool, plus three terminal-event webhooks (`evolution-converged` / `evolution-failed` / `apply-complete`) that it surfaces to you proactively.

Failure evidence accumulates from two complementary channels:

1. **Passive auto-scan.** A periodic cron (default 30 min) scans every agent's new session content for under-performing turns and queues them into per-conversation batches.
2. **Conversational flag.** Tell the agent "add this conversation to a batch" and it runs `moss evo flag` for you.

Then talk to the agent:

```
You: "These last few answers haven't been great. Add this conversation to a batch."
Agent: [runs moss evo flag --agent X --session Y]

You: "Start evolution on the latest batch."
Agent: [runs moss evo start]

You: "It's taking too long, stop it."
Agent: [runs moss evo stop]
```

When the loop reaches `CONVERGED`, the swap waits for explicit user authorization — tell the agent "apply it" and it runs `moss evo apply`. Every intermediate artifact (diagnosis, plans, diffs, scoring matrices) is readable by the agent on demand, so you can audit what's about to land before authorizing.

## CLI

`moss` is bind-mounted into the gateway container; everything also runs from the host via `docker exec moss-gateway moss <cmd>`. All commands accept `--json`.

| Command | Purpose |
|---|---|
| `moss evo status` | Live state of the loop (idle / running + stage + iter) |
| `moss evo batches` | All batches: id / size / state / created |
| `moss evo batch <id>` | Detail of one batch (chunks, source sessions) |
| `moss evo start [<id>] [--depth shallow\|standard\|deep]` | Trigger evolution. No arg → latest non-empty batch (auto-seals open batches). `--depth` scales the iteration / round / trial budget per tier; default `standard` |
| `moss evo stop` | Stop the current loop (writes stop sentinel; loop exits at the next safe point) |
| `moss evo apply <id>` | Swap in a converged batch's image |
| `moss evo flag --agent <id> --session <id>` | Scan one session cursor → EOF and append weak chunks to that session's batch |
| `moss evo catch-up` | Run a full auto-scan pass across all agents (what the cron job does) |

Full agent-facing reference: `host-daemon/src/cli/moss_capability/evolution.md`.

## Coding-agent providers

Code modification is delegated to a pluggable external coding-agent CLI invoked as a host-side subprocess; MOSS retains stage ordering and verdicts. Set `MOSS_AGENT_PROVIDER` in `.env` and re-run `setup.sh`.

| Provider | `MOSS_AGENT_PROVIDER=` | Auth | Optional model override |
|---|---|---|---|
| Claude Code CLI (default) | `claude` | `~/.claude/` OAuth (run `claude` once) | _Claude account default_ |
| OpenAI Codex CLI | `codex` | `codex login` or `OPENAI_API_KEY` | `MOSS_CODEX_MODEL=gpt-5.4` |
| DeepSeek-TUI | `deepseek-tui` | `~/.deepseek/config.toml` | `MOSS_DEEPSEEK_MODEL=deepseek-reasoner` |
| OpenCode | `opencode` | `opencode auth login` or per-provider env vars (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …) | `MOSS_OPENCODE_MODEL=anthropic/claude-sonnet-4-6` |

MOSS does **not** manage these CLIs' credentials — install + authenticate each provider once via its own flow before pointing `MOSS_AGENT_PROVIDER` at it.

**Per-role overrides** (mixed-provider runs) are supported via the `agent_override` field on the `spawn-agent` RPC.

**Adding a provider**: implement `CodingAgentRunner` (4 methods: `provider_name`, `preflight`, `spawn_role`, `kill_orphans`) in a new file under `host-daemon/src/ops/coding_agents/` and register it in `__init__.py`. No dispatcher / RPC / TS changes needed; see `claude.py` as a template.

## Architecture

```
Browser  ───WebSocket───►  moss-gateway container  ◄── /usr/local/bin/moss (CLI bind-mount)
                                  │      │
                                  │      └── HTTP  /api/evolution/{trigger,stop,apply,status,batches}
                                  │      └── HTTP  /hooks/{evolution-converged,evolution-failed,apply-complete}
                                  │
                                  ▼ unix socket RPC  (/tmp/moss.sock)
                                  │
                      host-daemon  (Python, uvicorn)
                          ├─ auto_scan     cursor-tracked jsonl scanner → per-conversation batches
                          ├─ spawn_agent   spawn evolution roles via the active coding-agent CLI
                          ├─ trial_runner  ephemeral trial-worker containers replay the batch
                          ├─ docker_rpc    build + smoke-test candidate images
                          └─ supervisor    swap-req.json → compose recreate → 90s health probe
                                              ↳ rollback on failure
```

Each iteration runs a deterministic seven-stage pipeline: `Locate → Plan → Plan-Review → Implement → Code-Review → Task-Evaluate → Verdict`. Plan / Plan-Review and Implement / Code-Review each alternate within a multi-round inner loop until approval or a round-budget cap. Build and Trial are runtime affordances around Task-Evaluate, not separate reasoning stages. The loop iterates until `Verdict` returns `CONVERGED`, `NEED_MORE_WORK` (next iter), `FUNDAMENTAL_LIMIT_MODEL`, or `FUNDAMENTAL_LIMIT_ARCHITECTURE`.

## Configuration

| Variable | Purpose |
|---|---|
| `MOSS_MODEL_API_KEY` / `_BASE_URL` / `_ID` | The chat model OpenClaw and trial workers use |
| `MOSS_AGENT_PROVIDER` | `claude` (default) / `codex` / `deepseek-tui` / `opencode` |
| `MOSS_DATA_DIR` | Where MOSS persists state — sessions, batches, evolution loop history (default `${HOME}/.moss`) |
| `MOSS_FORCE_REBUILD=1` | Force `pnpm build` on next `setup.sh` (skips by default if `openclaw/dist/` is present) |
| `MOSS_FORCE_RECONFIG=1` | Overwrite `~/.moss/openclaw.json` from `.env` (preserves manual edits by default) |

See `.env.example` for the full set.

## Acknowledgments

MOSS is research on source-level self-evolution for application-level agentic systems.

Built on [OpenClaw](https://github.com/openclaw/openclaw) by Peter Steinberger (MIT). All code under `openclaw/` is vendored from upstream and remains under its original MIT license. MOSS-added code (the evolution module, host-daemon, scripts, and root-level integration) is licensed under Apache 2.0.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Star History

<a href="https://www.star-history.com/?repos=hkgai-official%2FMoss&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=hkgai-official/Moss&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=hkgai-official/Moss&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=hkgai-official/Moss&type=date&legend=top-left" />
  </picture>
</a>
