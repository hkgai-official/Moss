# MOSS Self-Evolution

Use `moss evo` for self-evolution control. Requires moss-gateway and host-daemon running. All commands also accept `--json` for machine-readable output.

## Common commands

- **Status:** `moss evo status` — one-line live state (idle / running / which stage / which iter)
- **List batches:** `moss evo batches` — table of all batches with id, size, state, created timestamp
- **Show one batch:** `moss evo batch <batch-id>` — detail: chunks list, source agents/sessions, verdict, apply_state
- **Start evolution:** `moss evo start [<batch-id>] [--depth shallow|standard|deep]` — no arg = pick latest non-empty batch. If the batch is still receiving chunks, it is sealed (closed to new chunks) immediately, then evolution begins.

  **Depth tier — always ask the user before choosing.** The three tiers trade time + LLM cost for thoroughness; the user owns this trade-off because it directly affects how long they wait and how much their API budget is spent. Before running `moss evo start`, summarize the three options in your own words and ask which they want (or whether to use the default `standard`). Do not silently pick `deep` to "be thorough" or `shallow` to "be quick" — confirm.

  | Tier | max iterations | plan rounds | code retries | trials / task | plateau guard | rough time + cost |
  |---|---|---|---|---|---|---|
  | `shallow` | 3 | 1 | 0 | 2 | 1 | ~15-30 min, smallest API spend — good for a quick try on a simple bug |
  | `standard` *(default)* | 5 | 2 | 1 | 3 | 2 | ~1-2 hours, moderate API spend — recommended for most cases |
  | `deep` | 8 | 3 | 2 | 5 | 3 | ~3-5+ hours, largest API spend — for important regressions or after `shallow` / `standard` failed to converge |

  All five numbers (max_iter, max_plan_rounds, max_code_retries, n_trials_per_task, plateau_no_improvement_iters) scale together per tier; you cannot mix-and-match.
- **Stop running evolution:** `moss evo stop` — writes stop sentinel. The current iteration finishes the in-flight stage, then exits cleanly. The batch is marked apply_state=failed; use `moss evo restart <batch-id>` if the user wants to start over.
- **Restart a stopped batch:** `moss evo restart <batch-id>` — only valid when the batch is in apply_state=failed (i.e., after `moss evo stop`). The previous run's evidence (manifest, iter dirs, logs) is archived under `archive/<old-trigger-id>/` for post-mortem; the batch is then re-triggered from scratch. **The loop architecture is fresh-start-only — completed iters from the prior run are NOT resumed; the new run starts from iter 1.** True iter-level resume is planned for v2.7. Refuses with hint when the batch is in any other state (pending_evolution → use start; running → use stop first; converged/applied → terminal).
- **Apply converged version:** `moss evo apply <batch-id>` — writes swap-req. Supervisor will swap the OpenClaw container within seconds. Probe window is 90 seconds; if the new version fails to respond, auto-rollback to the previous version.
- **Flag current session:** `moss evo flag --agent <agent-id> --session <session-id>` — when the user says "add this to a batch" or similar, run this. Both ids come from your system prompt's Runtime line. The command scans the current session from cursor to EOF; the user's complaint message and surrounding context become a chunk in the current open batch.
- **Catch-up (cron entry):** `moss evo catch-up` — scans all agents' new session content. Used by the periodic cron job; rarely invoked manually.

## Reading detailed evolution state

You have read access to the evolution state filesystem at `/home/node/.openclaw/evo-loop-state/`. Use the standard Read or Grep tool to inspect:

- `<batch-id>/manifest.json` — batch state, current verdict, iter count
- `<batch-id>/_batch.json` — apply_state, sealed, chunk metadata
- `<batch-id>/iter-<N>/plan/plan-attempt-*.md` — planner output per round (read this when the user asks "what is it planning to change?" or "why this approach?")
- `<batch-id>/iter-<N>/code/code-attempt-*.md` — code-loop output
- `<batch-id>/iter-<N>/build/log.txt` — build logs (read when the user asks about build failures)
- `<batch-id>/finalize/summary.md` — convergence summary (read when answering "what did the evolution change?")
- `<batch-id>/evolution-log.jsonl` — full event stream (last few lines often suffice)
- `heartbeat.json` (top level) — current live status of any in-progress run

## Handling webhook notifications

You will receive system messages when these events happen. Each carries a pre-rendered `human_summary` field.

- **evolution-converged** — A batch's evolution converged. Proactively tell the user the result. Offer to summarize from `finalize/summary.md`. Ask if they want to `moss evo apply <batch-id>`.
- **evolution-failed** — A batch's evolution failed. Tell the user the failed stage and error. Offer to read the log file at the path in the message.
- **apply-complete** — A version swap finished. The message indicates success or rollback. If success, briefly tell the user the new version is live and what was changed (read `finalize/summary.md` of the applied batch). If rollback, tell the user the swap failed and the previous version is back.

## Notes

- **Evolution is expensive.** It runs LLM calls for planning, coding, evaluation. If the user wants to stop a run, invoke `moss evo stop` immediately — do not wait.
- **Apply triggers a container swap.** Your current process will be replaced by the new version. After apply, the new instance of you will receive an `apply-complete` system message to re-orient.
- **Failed batches stay on disk.** Do not delete them. They are useful evidence for post-mortem analysis.
- **For scripts:** Add `--json` for parsable output.
- **For `flag --agent` and `--session`:** Always read these values from the Runtime line in your system prompt. Do not fabricate them. If the Runtime line is unclear, ask the user once.
- **Multiple sessions are possible.** Auto-scan covers all of them globally. Batches contain chunks from any agent/session combination.

## Operating rules (always)

1. Do not invoke `moss evo apply` without the user's explicit go-ahead in the current turn.
2. Do not invoke `moss evo start` on an empty batch (size 0). Tell the user why.
3. When the user expresses dissatisfaction with one of your own responses ("that's wrong", "this isn't what I wanted") and asks to record it, run `moss evo flag --agent X --session Y`.
4. Treat the user's complaint phrasing itself as important evidence — do not paraphrase it before flagging. The flag captures the raw session content automatically.
5. Never modify files under `evo-loop-state/`. You have read-only access by design.
