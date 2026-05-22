# Where to look — role-specific path hints

This file is rendered per-role by the orchestrator's
`render_path_tree_section(role, batch_id, iteration, round)` helper. Only
the section matching your role is INCLUDE'd into the role's prompt; template
variables (`{batch_id}`, `{iteration}`, `{round}`, `{prev}` = `{iteration}-1`)
are substituted at render time.

Your cwd is the MOSS openclaw source tree (`<moss-root>/openclaw/`).
The orchestrator also passes `--add-dir` for the current iter_dir
(`~/.moss/evo-loop-state/current/iteration_<N>/`) so iter artifacts are readable.

In Read/Bash calls, prefer absolute paths or cwd-relative paths into the
openclaw/ tree.

---

## For all roles (always available)

You have read access to:

- `openclaw/` ← OpenClaw source tree (full read; only Implementer has write inside its scope)
- `~/.moss/evo-loop-state/current/` ← all iteration artifacts (current and prior)
- `src/evolution/architecture-map.md` ← runtime architecture overview (32KB; OpenClaw hooks/seams/pitfalls)

You can ALWAYS Read/Grep beyond the paths listed below — they're starting
points, not boundaries. Spawning Explore / general-purpose sub-agents to
trace OpenClaw call graphs is encouraged and FREE.

### Read blacklist (all roles)

```
openclaw/AGENTS.md, openclaw/CLAUDE.md       ← maintainer workflow noise
openclaw/.pi/                                  ← agent prompt config (D1 placebo trap)
openclaw/.env*                                 ← secrets
openclaw/docs/, README.md, CHANGELOG.md, VISION.md, SECURITY.md, CONTRIBUTING.md
openclaw/apps/, ui/, Swabble/, vendor/         ← unrelated frontend / native apps
openclaw/.github/, fly*.toml, render.yaml, appcast.xml
openclaw/node_modules/
```

---

## Role: Locator (iter {iteration})

You produce `iteration_{iteration}/diagnosis.md`. No inlined primary input —
you must explore actively.

### iter == 1 (no prior iter)

- `~/.moss/evo-loop-state/current/iteration_0/traces/stage_a_train/<task>/`
  ← baseline trial transcripts (your PRIMARY evidence for failure-mode diagnosis)
- `~/.moss/evo-loop-state/current/iteration_0/grade_summary.json`
  ← per-trial outcome table
- `openclaw/src/` ← code-level verification of any hypothesis you form

### iter > 1 (cross-iter sweep MANDATORY — you must cite prior strategic-reviewer)

- `~/.moss/evo-loop-state/current/iteration_{prev}/traces/stage_a_train/<task>/`
  ← latest trial transcripts (post-prior-fix evidence)
- For K = 1..{prev}:
  - `~/.moss/evo-loop-state/current/iteration_K/diagnosis.md` ← prior Locator output
  - `~/.moss/evo-loop-state/current/iteration_K/plan.md` ← prior Planner output
  - `~/.moss/evo-loop-state/current/iteration_K/plan-reviewer.md` ← prior Plan Reviewer
  - `~/.moss/evo-loop-state/current/iteration_K/implementer.md` ← prior Implementer
  - `~/.moss/evo-loop-state/current/iteration_K/code-reviewer.md` ← prior Code Reviewer
  - `~/.moss/evo-loop-state/current/iteration_K/strategic-reviewer.md` ← prior Strategic Reviewer (★ mandatory cite)

---

## Role: Planner (iter {iteration}, plan-round {round})

You produce `iteration_{iteration}/plan.md`. No inlined primary input —
read diagnosis + arch-map + verify hook seams in source before writing.

### Always

- `~/.moss/evo-loop-state/current/iteration_{iteration}/diagnosis.md`
  ← Locator output (just produced this iter — your starting point)
- `src/evolution/architecture-map.md` ← arch invariants
- `openclaw/src/` ← verify file:line hook seams BEFORE claiming them

### iter > 1 cross-iter (mandatory)

- For K = 1..{prev}:
  - `~/.moss/evo-loop-state/current/iteration_K/plan.md`
  - `~/.moss/evo-loop-state/current/iteration_K/plan-reviewer.md`
  - `~/.moss/evo-loop-state/current/iteration_K/strategic-reviewer.md`
    ← ★ mandatory: explain in your plan "why structurally different from iter K"

### round > 0 within plan-loop

- `~/.moss/evo-loop-state/current/iteration_{iteration}/plan-reviewer.md`
  ← prior round's REJECT feedback — you MUST address every required modification
  (or add ## Disagreement rationale section if declining)

---

## Role: Plan Reviewer (iter {iteration}, plan-round {round})

You produce `iteration_{iteration}/plan-reviewer.md`. Spawned fresh each
round (no `--resume`); the current `plan.md` is your authoritative input.

### Inlined as primary input (rendered into prompt by orchestrator)

- `~/.moss/evo-loop-state/current/iteration_{iteration}/plan.md`
  ← the plan you're auditing
- `~/.moss/evo-loop-state/current/iteration_{iteration}/diagnosis.md`
  ← context Locator produced
- `src/evolution/architecture-map.md` ← arch invariants

### Path-referenced for verification (★ independent verification mandatory)

- `openclaw/src/`
  ← verify EVERY file:line claim in plan.md by reading the actual source.
  Do NOT trust the plan's seam claims — replicate them yourself.

### iter > 1 (déjà vu check — REJECT plans that re-tread known dead-ends)

- For K = 1..{prev}:
  - `~/.moss/evo-loop-state/current/iteration_K/strategic-reviewer.md`
    ← what plan styles previously failed (avoid re-approving same shape)
  - `~/.moss/evo-loop-state/current/iteration_K/plan.md`
    ← compare structure vs current plan

---

## Role: Implementer (iter {iteration}, code-round {round})

You produce `iteration_{iteration}/implementer.md` + actual code changes
under `openclaw/`.

cwd = `openclaw/` (writable per scope below)

### Inlined as primary input

- `~/.moss/evo-loop-state/current/iteration_{iteration}/plan.md`
  ← the plan you're implementing (★ LOCKED — you do NOT modify this file;
  if you discover the plan is unworkable, output `status: BLOCKED` instead
  of silently deviating)
- `src/evolution/architecture-map.md`

### Path-referenced

- `openclaw/src/` ← writable cwd (and test/, Dockerfile*, package.json, pnpm-*, tsdown.config.ts, tsconfig*.json, vitest.*.config.ts, patches/, extensions/, packages/, scripts/, git-hooks/)
- `~/.moss/evo-loop-state/current/iteration_{iteration}/revisions/code_round_{round}/implementer-scratch/`
  ← your draft impl-plan + scratch (writable working area)

### iter > 1

- `~/.moss/evo-loop-state/current/iteration_{prev}/implementer.md`
  ← what was implemented before; avoid re-doing the same change

### round > 0 within code-loop

- `~/.moss/evo-loop-state/current/iteration_{iteration}/revisions/code_round_{prev}/code-reviewer.md`
  ← prior round's REJECT feedback (orchestrator hard-resets the openclaw
  worktree between code-rounds; the plan stays locked)

---

## Role: Code Reviewer (iter {iteration}, code-round {round})

You produce `iteration_{iteration}/code-reviewer.md`. Spawned fresh each
round; the current commit's diff is your authoritative input.

### Inlined as primary input

- `~/.moss/evo-loop-state/current/iteration_{iteration}/plan.md`
  ← target spec (the contract Implementer was supposed to satisfy)
- `~/.moss/evo-loop-state/current/iteration_{iteration}/revisions/code_round_{round}/implementer.md`
  ← what Implementer claims they did
- git diff (current iter commit vs pre-iter HEAD)
  ← actual code change (★ verify Implementer's claims line-by-line)
- `src/evolution/architecture-map.md`

### Path-referenced for verification

- `openclaw/src/`
  ← verify the diff actually fires at runtime; trace sibling-task code paths
  to detect over-narrow / over-broad fixes

### iter > 1

- `~/.moss/evo-loop-state/current/iteration_{prev}/code-reviewer.md`
  ← prior approvals + déjà vu (what passed last iter but later regressed)

### round > 0

- `~/.moss/evo-loop-state/current/iteration_{iteration}/revisions/code_round_{prev}/code-reviewer.md`
  ← your prior round's reject — confirm Implementer addressed each
  required modification (do NOT re-approve a still-unaddressed item)

---

## Role: Strategic Reviewer (iter {iteration})

You produce `iteration_{iteration}/strategic-reviewer.md` with a single
`## Verdict` line: `APPROVE_CONVERGED` | `NEED_MORE_WORK` |
`FUNDAMENTAL_LIMIT_MODEL` | `FUNDAMENTAL_LIMIT_ARCHITECTURE`.

### Inlined as primary input

- `~/.moss/evo-loop-state/current/iteration_{iteration}/grade_summary.json`
  ← Stage A trial scores (per-task per-trial)
- `~/.moss/evo-loop-state/current/iteration_{iteration}/stage_c_run.json`
  ← validation_v1 holdout summary (general regression check)
- 1–2 paragraph summary of `iteration_{prev}/strategic-reviewer.md`
  (extracted into prompt by orchestrator — full file path-referenced below)
- `src/evolution/architecture-map.md` ← arch invariants

### Path-referenced (★ encouraged to grep on suspicion of circularity / oscillation)

- For K = 1..{prev}:
  - `~/.moss/evo-loop-state/current/iteration_K/diagnosis.md`
  - `~/.moss/evo-loop-state/current/iteration_K/plan.md`
  - `~/.moss/evo-loop-state/current/iteration_K/strategic-reviewer.md`
- `~/.moss/evo-loop-state/current/iteration_{iteration}/traces/stage_a_train/<task>/`
  ← sample 1–2 transcripts when oscillation detected (don't read all; sample)

### Verdict guidance

- `APPROVE_CONVERGED` — Stage A clean + Stage C no regression + plan
  addressed root cause (not surface symptom)
- `NEED_MORE_WORK` — partial progress; specific next-iter direction implied
- `FUNDAMENTAL_LIMIT_MODEL` — failure pattern is model-capability bound
  (e.g., reasoning depth) not architectural; further iters won't help
- `FUNDAMENTAL_LIMIT_ARCHITECTURE` — failure pattern is OpenClaw-architecture
  bound (e.g., hook seam doesn't exist where the fix needs it); requires
  upstream OpenClaw redesign, not in-loop iter
