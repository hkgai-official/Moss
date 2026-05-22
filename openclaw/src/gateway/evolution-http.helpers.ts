// src/gateway/evolution-http.helpers.ts
//
// Pure handler implementations for /api/evolution/* (v2.6 MOSS UI).
// The dispatcher in evolution-http.ts holds the auth check + path switch and
// delegates each case here. Keeping handlers in this helper file keeps
// evolution-http.ts small and lets us test handlers without re-asserting the
// HTTP envelope.
//
// Shared assumptions:
//  - dataDir = host data dir, mount point /home/node/.openclaw in container.
//  - flag pool path:   <dataDir>/evo-loop-state/flag-pool/<flag_id>.json
//  - flag batch path:  <dataDir>/evo-loop-state/flag-batch/<batch_id>/
//    * each batch dir contains _batch.json + <flag_id>.json files
//  - current loop:     <dataDir>/evo-loop-state/current/evolution-log.jsonl
//  - archived runs:    <dataDir>/evo-loop-state/archive/<trigger_id>/manifest.json
//
// The agent_id used when flagging a session is server-resolved via
// resolveAssistantIdentity (config-driven). We do NOT trust an agent_id field
// from the request payload.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { callHostDaemonOp } from "../evolution/docker-rpc.js";
import {
  EvolutionBusyError,
  EvolutionNotReadyError,
  forceClearBusy,
  getServiceStatus,
  triggerEvolutionLoop,
  type TriggerRequest,
} from "../evolution/loop.js";
import { UserMode } from "../evolution/modes/user-mode.js";
import { loadManifest, readFlagBatchWithDefaults, saveManifest } from "../evolution/state.js";
import { writeSwapRequest } from "../evolution/swap-writer.js";
import type { FlagBatch, FlagSnapshot } from "../evolution/types/flag-batch.js";
import { readUiSettings, writeUiSettings, type UiSettings } from "../evolution/ui-settings.js";
import { ulid } from "../evolution/ulid.js";

// ---------------------------------------------------------------------------
// Public request/response types (HTTP boundary only — internal callers use
// the underlying primitives directly)
// ---------------------------------------------------------------------------

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface HandlerCtx {
  dataDir: string;
  openclawRepoDir?: string;
}

// ---------------------------------------------------------------------------
// Auto-trigger mutex — guarantees that two concurrent /api/evolution/flag
// requests can't both fire `triggerEvolutionLoop()` and race on _batch.json.
// Chained promise (NOT setTimeout). lock = lock.then(work).
// ---------------------------------------------------------------------------

let autoTriggerLock: Promise<void> = Promise.resolve();

function withAutoTriggerLock<T>(fn: () => Promise<T>): Promise<T> {
  // Wrap so a thrown fn() doesn't poison the lock chain.
  const next = autoTriggerLock.then(fn, fn);
  autoTriggerLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Test-only: reset the module-level mutex chain. */
export function _resetAutoTriggerLockForTests(): void {
  autoTriggerLock = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function stateDir(dataDir: string): string {
  return path.join(dataDir, "evo-loop-state");
}
function flagPoolDir(dataDir: string): string {
  return path.join(stateDir(dataDir), "flag-pool");
}
function flagBatchDir(dataDir: string, batchId: string): string {
  return path.join(stateDir(dataDir), "flag-batch", batchId);
}
function flagBatchRoot(dataDir: string): string {
  return path.join(stateDir(dataDir), "flag-batch");
}
function archiveRoot(dataDir: string): string {
  return path.join(stateDir(dataDir), "archive");
}
function currentDir(dataDir: string): string {
  return path.join(stateDir(dataDir), "current");
}

// ---------------------------------------------------------------------------
// Auto-scan batch schema normalization
// ---------------------------------------------------------------------------
//
// Auto-scan _batch.json files (written by host-daemon/auto_scan.py) use "id"
// as the primary key instead of "batch_id", and omit legacy fields like
// status, threshold, trigger_mode, etc. This helper maps the auto-scan shape
// to the legacy shape expected by readFlagBatchWithDefaults, supplying sensible
// defaults for the missing fields.

function normalizeAutoScanBatch(raw: Record<string, unknown>): Record<string, unknown> {
  // If the record already has batch_id it's already normalized (or is legacy).
  if (typeof raw.batch_id === "string") {
    return raw;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  // Order matters: spread raw FIRST so our explicit defaults override any
  // partial/legacy values, then write batch_id LAST so it's always canonical
  // regardless of what `raw` contained.
  return {
    created_at: (raw.created_at as number | undefined) ?? 0,
    status: "current" as const,
    threshold: 0,
    trigger_mode: "auto" as const,
    triggered_at: null,
    triggered_evolution_trigger_id: null,
    flag_count: (raw.size as number | undefined) ?? 0,
    depth: (raw.depth as string | undefined) ?? "standard",
    created_by: "auto" as const,
    apply_state: (raw.apply_state as string | undefined) ?? "pending_evolution",
    // Pass through any extra fields (sealed, size, etc.) so callers can
    // inspect them if needed.
    ...raw,
    batch_id: id,
  };
}

// ---------------------------------------------------------------------------
// Agent + session resolution
// ---------------------------------------------------------------------------

/** Resolve the server-side agent id from the (config-driven) default agent.
 *  We do NOT trust an agent_id from the request payload — flagging is
 *  authenticated already, so the agent context is the gateway's own. */
function resolveAgentIdFromServer(dataDir: string): string {
  try {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    return agentId ?? "main";
  } catch {
    // Tests run without a real config; fall back to the conventional default.
    void dataDir;
    return "main";
  }
}

function sessionJsonlPath(dataDir: string, agentId: string, sessionId: string): string {
  return path.join(dataDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

interface ParsedSessionMessage {
  /** Raw object as parsed from a JSONL line (type==="message" or other). */
  raw: Record<string, unknown>;
  /** Inner message {role, content...}, when type==="message". */
  message: Record<string, unknown> | null;
  /** "user" / "assistant" / "tool" / undefined */
  role: string | null;
  /** Line index in file (0-based, JSONL order). */
  index: number;
}

/**
 * Pull the real user-typed text out of a session "user" message.
 *
 * OpenClaw chat injects a "Conversation info (untrusted metadata)" header
 * + sender block as part of EVERY inbound user message. For evolution
 * training we want only the actual user text, otherwise Locator gets
 * confused by the metadata noise.
 *
 * Strips:
 *   "Conversation info (untrusted metadata):\n```json\n{...}\n```\n\n"
 *   "Sender (untrusted metadata):\n```json\n{...}\n```\n\n"
 *   "[Wed 2026-05-13 11:53 UTC] "  ← inline timestamp prefix
 *
 * Falls back to the raw text if no metadata header is present.
 */
function extractCleanUserPrompt(userMsg: Record<string, unknown> | null | undefined): string {
  if (!userMsg) {
    return "";
  }
  const content = userMsg.content;
  let rawText = "";
  if (typeof content === "string") {
    rawText = content;
  } else if (Array.isArray(content)) {
    // OpenAI/Anthropic content blocks: [{type:"text", text:"..."}, ...]
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          rawText += b.text;
        }
      }
    }
  } else {
    rawText = JSON.stringify(content ?? "");
  }
  // Strip the well-known untrusted-metadata blocks (case sensitive — they
  // come from a single canonical OpenClaw template).
  const metadataBlock =
    /^(?:Conversation info|Sender) \(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*\n+/m;
  let cleaned = rawText;
  while (metadataBlock.test(cleaned)) {
    cleaned = cleaned.replace(metadataBlock, "");
  }
  // Strip leading inline timestamp "[Day YYYY-MM-DD HH:MM UTC] ".
  cleaned = cleaned.replace(/^\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\s*/, "");
  const trimmed = cleaned.trim();
  return trimmed.length > 0 ? trimmed : rawText;
}

function readSessionMessages(file: string): ParsedSessionMessage[] {
  const raw = fs.readFileSync(file, "utf8");
  const out: ParsedSessionMessage[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const isMessage = obj.type === "message";
    const inner =
      isMessage && obj.message && typeof obj.message === "object"
        ? (obj.message as Record<string, unknown>)
        : null;
    const role = typeof inner?.role === "string" ? inner.role : null;
    out.push({ raw: obj, message: inner, role, index: i });
  }
  return out;
}

/** Collect agent_trace for a flag: everything from messages[idx_of_userN]
 *  inclusive up to (but not including) the next user message OR end of file. */
function sliceTraceForUserTurn(
  msgs: ParsedSessionMessage[],
  userMessageIndex: number,
): { startIdx: number; endIdx: number; trace: Array<Record<string, unknown>> } | null {
  // userMessageIndex is the 0-based rank among user-role messages.
  let userOccurrence = 0;
  let startMsgIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") {
      if (userOccurrence === userMessageIndex) {
        startMsgIdx = i;
        break;
      }
      userOccurrence++;
    }
  }
  if (startMsgIdx < 0) {
    return null;
  }
  // Find next user message after start
  let endMsgIdx = msgs.length; // exclusive
  for (let j = startMsgIdx + 1; j < msgs.length; j++) {
    if (msgs[j].role === "user") {
      endMsgIdx = j;
      break;
    }
  }
  const trace: Array<Record<string, unknown>> = [];
  for (let k = startMsgIdx; k < endMsgIdx; k++) {
    const m = msgs[k];
    if (m.message) {
      trace.push(m.message);
    }
  }
  return { startIdx: startMsgIdx, endIdx: endMsgIdx - 1, trace };
}

// ---------------------------------------------------------------------------
// POST /api/evolution/flag
// ---------------------------------------------------------------------------

export async function handleFlag(
  ctx: HandlerCtx,
  body: { sessionId?: unknown; userMessageIndex?: unknown },
): Promise<HandlerResult> {
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const userMessageIndex =
    typeof body?.userMessageIndex === "number" && Number.isInteger(body.userMessageIndex)
      ? body.userMessageIndex
      : -1;
  if (!sessionId || userMessageIndex < 0) {
    return { status: 400, body: { error: "sessionId + userMessageIndex required" } };
  }
  const agentId = resolveAgentIdFromServer(ctx.dataDir);
  const jsonlPath = sessionJsonlPath(ctx.dataDir, agentId, sessionId);
  if (!fs.existsSync(jsonlPath)) {
    return { status: 404, body: { error: "session not found", agentId, sessionId } };
  }
  const msgs = readSessionMessages(jsonlPath);
  const slice = sliceTraceForUserTurn(msgs, userMessageIndex);
  if (!slice) {
    return {
      status: 422,
      body: { error: "userMessageIndex out of range", userMessageIndex },
    };
  }
  const userMsg = msgs.find((m) => m.index === slice.startIdx)?.message;
  const userText = extractCleanUserPrompt(userMsg);
  const snapshot: FlagSnapshot = {
    flag_id: ulid(),
    batch_id: "",
    flagged_at: Date.now(),
    flagged_by: agentId,
    user_prompt: { text: userText },
    agent_trace: slice.trace,
    tool_dispatches: [],
    agent_tool_registry_at_flag_time: [],
    source_session_id: sessionId,
    source_turn_range: [slice.startIdx, slice.endIdx],
    source_user_message_index: userMessageIndex,
  };
  // Write atomically (tmp + rename).
  const dir = flagPoolDir(ctx.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${snapshot.flag_id}.json`);
  const tmp = `${out}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, out);

  // Fire auto-trigger check serialized via the mutex; we deliberately do
  // NOT await — keep the HTTP response fast.
  void withAutoTriggerLock(() => maybeAutoTrigger(ctx.dataDir)).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[evolution-http] auto-trigger failed:", e);
  });
  return { status: 200, body: { flag_id: snapshot.flag_id } };
}

/** Read the pool, and when auto-mode + threshold is reached, fold the
 *  oldest-N flags into a new batch and trigger the loop. Runs inside the
 *  module-level mutex so concurrent POST /flag calls can't double-trigger. */
async function maybeAutoTrigger(dataDir: string): Promise<void> {
  const settings = readUiSettings(dataDir);
  if (settings.user_mode.trigger_mode !== "auto") {
    return;
  }
  const threshold = settings.user_mode.threshold;
  const dir = flagPoolDir(dataDir);
  if (!fs.existsSync(dir)) {
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .toSorted((a, b) => a.mtime - b.mtime)
    .map((x) => x.f);
  if (files.length < threshold) {
    return;
  }
  const flagIds = files.slice(0, threshold).map((f) => f.replace(/\.json$/, ""));
  // compose via internal API path (created_by="auto"), then trigger.
  await composeBatchInternal(dataDir, {
    flag_ids: flagIds,
    user_label: null,
    depth: settings.user_mode.depth,
    trigger: true,
    created_by: "auto",
  });
}

// ---------------------------------------------------------------------------
// POST /api/evolution/unflag
// ---------------------------------------------------------------------------

export async function handleUnflag(
  ctx: HandlerCtx,
  body: { flag_id?: unknown },
): Promise<HandlerResult> {
  const flagId = typeof body?.flag_id === "string" ? body.flag_id : "";
  if (!flagId) {
    return { status: 400, body: { error: "flag_id required" } };
  }
  const p = path.join(flagPoolDir(ctx.dataDir), `${flagId}.json`);
  if (!fs.existsSync(p)) {
    return { status: 404, body: { error: "flag not found", flag_id: flagId } };
  }
  let snap: FlagSnapshot;
  try {
    snap = JSON.parse(fs.readFileSync(p, "utf8")) as FlagSnapshot;
  } catch {
    return { status: 500, body: { error: "flag file corrupt" } };
  }
  if (snap.batch_id && snap.batch_id !== "") {
    return {
      status: 409,
      body: { error: "flag locked into batch", batch_id: snap.batch_id },
    };
  }
  fs.unlinkSync(p);
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// GET /api/evolution/flag-pool
// ---------------------------------------------------------------------------

export async function handleFlagPoolList(ctx: HandlerCtx): Promise<HandlerResult> {
  const dir = flagPoolDir(ctx.dataDir);
  if (!fs.existsSync(dir)) {
    return { status: 200, body: [] };
  }
  const items: FlagSnapshot[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) {
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      items.push(JSON.parse(raw) as FlagSnapshot);
    } catch {
      // skip corrupt files
    }
  }
  items.sort((a, b) => a.flagged_at - b.flagged_at);
  return { status: 200, body: items };
}

// ---------------------------------------------------------------------------
// POST /api/evolution/compose-batch
// ---------------------------------------------------------------------------

interface ComposeBatchReq {
  flag_ids: string[];
  user_label: string | null;
  depth: "shallow" | "standard" | "deep";
  trigger: boolean;
  created_by?: "ui" | "auto";
}

function nowBatchId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  // Append 4 chars from a ulid to disambiguate sub-second concurrent composes
  // (auto-trigger + manual within the same second would otherwise collide and
  // overwrite _batch.json under mkdirSync({recursive:true})).
  const r4 = ulid().slice(-4);
  return `batch_user_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}_${r4}`;
}

export async function handleComposeBatch(
  ctx: HandlerCtx,
  body: Partial<ComposeBatchReq>,
): Promise<HandlerResult> {
  const flagIds = Array.isArray(body?.flag_ids)
    ? (body.flag_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (flagIds.length === 0) {
    return { status: 422, body: { error: "flag_ids must be non-empty" } };
  }
  const depth: ComposeBatchReq["depth"] =
    body?.depth === "shallow" || body?.depth === "standard" || body?.depth === "deep"
      ? body.depth
      : "standard";
  try {
    const out = await composeBatchInternal(ctx.dataDir, {
      flag_ids: flagIds,
      user_label:
        typeof body?.user_label === "string"
          ? body.user_label
          : body?.user_label === null
            ? null
            : null,
      depth,
      trigger: body?.trigger === true,
      created_by: "ui",
    });
    return { status: 200, body: { batch_id: out.batchId } };
  } catch (e) {
    if (e instanceof BatchComposeError) {
      return { status: e.status, body: { error: e.message, ...e.extra } };
    }
    throw e;
  }
}

class BatchComposeError extends Error {
  constructor(
    public status: number,
    msg: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(msg);
  }
}

interface ComposeBatchOutcome {
  batchId: string;
}

async function composeBatchInternal(
  dataDir: string,
  req: ComposeBatchReq,
): Promise<ComposeBatchOutcome> {
  const settings = readUiSettings(dataDir);
  const batchId = nowBatchId();
  const batchDir = flagBatchDir(dataDir, batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  // Validate all flags exist + are unlocked first (atomicity over best-effort).
  const flagPaths: Array<{ src: string; flagId: string }> = [];
  for (const flagId of req.flag_ids) {
    const src = path.join(flagPoolDir(dataDir), `${flagId}.json`);
    if (!fs.existsSync(src)) {
      throw new BatchComposeError(404, "flag not found", { flag_id: flagId });
    }
    const snap = JSON.parse(fs.readFileSync(src, "utf8")) as FlagSnapshot;
    if (snap.batch_id && snap.batch_id !== "") {
      throw new BatchComposeError(409, "flag already locked into batch", {
        flag_id: flagId,
        batch_id: snap.batch_id,
      });
    }
    flagPaths.push({ src, flagId });
  }
  // Move each flag: patch batch_id, write to batch dir, unlink original.
  for (const { src, flagId } of flagPaths) {
    const snap = JSON.parse(fs.readFileSync(src, "utf8")) as FlagSnapshot;
    snap.batch_id = batchId;
    const dst = path.join(batchDir, `${flagId}.json`);
    fs.writeFileSync(dst, JSON.stringify(snap, null, 2));
    fs.unlinkSync(src);
  }
  // _batch.json
  const batch: FlagBatch = {
    batch_id: batchId,
    created_at: Date.now(),
    status: "current",
    threshold: settings.user_mode.threshold,
    trigger_mode: settings.user_mode.trigger_mode,
    triggered_at: null,
    triggered_evolution_trigger_id: null,
    flag_count: req.flag_ids.length,
    origin: "user",
    user_label: req.user_label,
    depth: req.depth,
    created_by: req.created_by ?? "ui",
    apply_state: "pending_evolution",
  };
  const batchJson = path.join(batchDir, "_batch.json");
  fs.writeFileSync(batchJson, JSON.stringify(batch, null, 2));

  if (req.trigger) {
    // Mark running BEFORE fire-and-forget; if we wait we open a race with the
    // user clicking trigger again in the brief window. Also persist
    // triggered_evolution_trigger_id so the batch can be audit-traced back
    // to its evolution run even if the loop never logs it (e.g. crash mid-init).
    const triggerId = randomUUID();
    batch.apply_state = "running";
    batch.triggered_at = Date.now();
    batch.triggered_evolution_trigger_id = triggerId;
    fs.writeFileSync(batchJson, JSON.stringify(batch, null, 2));
    const outcome = triggerForBatch(dataDir, batchId, req.depth, triggerId);
    if (!outcome.ok) {
      // triggerForBatch already rolled apply_state back to pending_evolution.
      // Surface to the caller so compose-batch can return the correct HTTP
      // status (instead of silently leaving the user with batch_id + no loop).
      throw new BatchComposeError(outcome.status, outcome.error, {
        batch_id: batchId,
        detail: outcome.detail,
      });
    }
  }
  return { batchId };
}

/** Roll a batch's apply_state back to "pending_evolution" so a subsequent
 *  /trigger can succeed. Best-effort: failures here are logged but don't
 *  shadow the original cause. Used when triggerEvolutionLoop rejects either
 *  during its sync prologue (Busy/NotReady/NotStarted) or mid-loop. */
function rollbackApplyState(dataDir: string, batchId: string): void {
  try {
    const bp = path.join(flagBatchDir(dataDir, batchId), "_batch.json");
    if (!fs.existsSync(bp)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
    const batch = readFlagBatchWithDefaults(raw);
    // Only roll back if we actually own the "running" flip; never clobber a
    // terminal state (ready_to_apply / applied / discarded).
    if (batch.apply_state === "running") {
      batch.apply_state = "pending_evolution";
      batch.triggered_at = null;
      batch.triggered_evolution_trigger_id = null;
      fs.writeFileSync(bp, JSON.stringify(batch, null, 2));
    }
  } catch (rollbackErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[evolution-http] rollback of apply_state failed for ${batchId}: ${String(rollbackErr)}`,
    );
  }
}

type TriggerOutcome = { ok: true } | { ok: false; status: number; error: string; detail?: string };

/** Fire `triggerEvolutionLoop` for a batch.
 *
 *  Behaviour (Fix 1 — rollback on any trigger error):
 *  - Pre-check service status synchronously; if not started / boot-failed /
 *    busy, roll back `apply_state` and return a non-200 outcome so the HTTP
 *    handler can surface 500/503 to the caller.
 *  - Otherwise launch the loop fire-and-forget (it runs minutes-to-hours).
 *    Attach a `.catch()` that rolls back `apply_state` on async rejection —
 *    Busy/NotReady that slip through the pre-check (race with another
 *    trigger), service crashes, or any other Error.
 */
function triggerForBatch(
  dataDir: string,
  batchId: string,
  depth: "shallow" | "standard" | "deep",
  triggerId?: string,
): TriggerOutcome {
  // Pre-check: surface obvious failure modes to the HTTP caller synchronously.
  // (triggerEvolutionLoop is async, so its sync portion rejects asynchronously
  // and is invisible to a try/catch around the call.)
  const status = getServiceStatus();
  if (!status.started) {
    rollbackApplyState(dataDir, batchId);
    return { ok: false, status: 500, error: "evolution_service_not_started" };
  }
  if (status.bootError) {
    rollbackApplyState(dataDir, batchId);
    return {
      ok: false,
      status: 503,
      error: "evolution_service_not_ready",
      detail: status.bootError,
    };
  }
  if (status.busy) {
    rollbackApplyState(dataDir, batchId);
    return {
      ok: false,
      status: 503,
      error: "evolution_service_busy",
      detail: status.current?.inputSetId ?? undefined,
    };
  }

  const req: TriggerRequest = {
    triggerSource: "manual",
    triggeredBy: "ui:/api/evolution/trigger",
    inputSetId: batchId,
    inputManifestPath: flagBatchDir(dataDir, batchId), // user mode uses dir
    validationSet: batchId,
    startingImage: process.env.MOSS_IMAGE ?? "openclaw:current",
    startingBranch: "main",
    startingCommit: process.env.MOSS_H_PRE ?? null,
    mode: new UserMode(batchId),
    depth,
    flagBatchId: batchId,
    triggerId,
  };
  // Fire-and-forget (mirrors evolve-tool.ts). triggerEvolutionLoop returns a
  // Promise resolving when the loop completes — we keep the HTTP path snappy
  // and surface progress via evolution-log.jsonl.
  const p = triggerEvolutionLoop(req);
  p.catch((e: unknown) => {
    // Roll the apply_state back so a re-trigger isn't blocked at "running".
    // Covers: Busy/NotReady racing past the pre-check, mid-loop crashes, or
    // any other Error from runEvolutionLoop.
    rollbackApplyState(dataDir, batchId);
    const tag =
      e instanceof EvolutionBusyError
        ? "busy"
        : e instanceof EvolutionNotReadyError
          ? "not_ready"
          : "error";
    // eslint-disable-next-line no-console
    console.error(`[evolution-http] background trigger ${tag} for ${batchId}: ${String(e)}`);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// POST /api/evolution/trigger
// ---------------------------------------------------------------------------

export async function handleTrigger(
  ctx: HandlerCtx,
  body: { batch_id?: unknown; depth?: unknown },
): Promise<HandlerResult> {
  const batchId = typeof body?.batch_id === "string" ? body.batch_id : "";
  if (!batchId) {
    return { status: 400, body: { error: "batch_id required" } };
  }
  const depthOverride =
    body?.depth === "shallow" || body?.depth === "standard" || body?.depth === "deep"
      ? (body.depth as "shallow" | "standard" | "deep")
      : undefined;
  let dir = flagBatchDir(ctx.dataDir, batchId);
  let bp = path.join(dir, "_batch.json");
  if (!fs.existsSync(bp)) {
    // Fall back to auto-scan batch directory.
    const autoScanDir = path.join(stateDir(ctx.dataDir), "auto-scan-batches", batchId);
    const autoScanBp = path.join(autoScanDir, "_batch.json");
    if (fs.existsSync(autoScanBp)) {
      dir = autoScanDir;
      bp = autoScanBp;
    } else {
      return { status: 404, body: { error: "batch not found", batch_id: batchId } };
    }
  }
  const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
  const batch = readFlagBatchWithDefaults(normalizeAutoScanBatch(raw));
  // Spec docs/specs/2026-05-19-evolution-control-surface.md §2.3: a user may
  // trigger any non-empty batch including one still receiving chunks ("open").
  // Auto-seal it (open → pending_evolution, sealed → true) before the gate
  // check below; otherwise an auto-scan batch — which lands in "open" by
  // default — could never be triggered. "open" + `sealed` are auto-scan-only
  // (not in the FlagBatch schema), so we widen the type at the comparison /
  // assignment site rather than polluting the canonical union. The
  // downstream writeFileSync persists both fields.
  if ((batch.apply_state as string) === "open" && batch.flag_count > 0) {
    batch.apply_state = "pending_evolution";
    (batch as { sealed?: boolean }).sealed = true;
  }
  if (batch.apply_state !== "pending_evolution") {
    return {
      status: 409,
      body: { error: "batch not pending_evolution", apply_state: batch.apply_state },
    };
  }
  // Per-trigger depth override (shallow/standard/deep). When omitted, the
  // batch's existing `depth` field is used (auto-scan batches default to
  // "standard" via readFlagBatchWithDefaults). See evolution.md capability
  // doc for the budget table each tier maps to.
  if (depthOverride !== undefined) {
    batch.depth = depthOverride;
  }
  // Update apply_state to "running" before firing so a follow-up GET reflects state.
  const triggerId = randomUUID();
  batch.apply_state = "running";
  batch.triggered_at = Date.now();
  batch.triggered_evolution_trigger_id = triggerId;
  fs.writeFileSync(bp, JSON.stringify(batch, null, 2));
  const outcome = triggerForBatch(ctx.dataDir, batchId, batch.depth, triggerId);
  if (!outcome.ok) {
    // triggerForBatch already rolled apply_state back to "pending_evolution".
    return {
      status: outcome.status,
      body: { error: outcome.error, ...(outcome.detail ? { detail: outcome.detail } : {}) },
    };
  }
  return { status: 200, body: { manifest_id: batchId } };
}

// ---------------------------------------------------------------------------
// GET /api/evolution/active
// ---------------------------------------------------------------------------

export async function handleActive(ctx: HandlerCtx): Promise<HandlerResult> {
  const dir = currentDir(ctx.dataDir);
  if (!fs.existsSync(dir)) {
    return { status: 200, body: { batch_id: null, recentEvents: [] } };
  }
  // Heartbeat is the source-of-truth for "is a run currently active". When
  // the user clicks Stop, handleStop clears activeTrigger to null. We must
  // honor that even though evolution-log.jsonl may still be receiving
  // events from the orphan loop's in-flight LLM call (Stop sentinel is
  // only checked at iter boundaries, not mid-call).
  //
  // It also carries the inputSetId, which is the canonical batch_id for the
  // active run. Pulling it from heartbeat avoids a real bug where scanning
  // the last 200 evolution-log entries for `data.inputSetId` returned null
  // mid-run — inputSetId only appears in the `init` event (line 521 of loop.ts)
  // and gets buried after ~200 entries' worth of stage_start / role_event.
  const heartbeatFile = path.join(stateDir(ctx.dataDir), "heartbeat.json");
  let activeBatchId: string | null = null;
  if (fs.existsSync(heartbeatFile)) {
    try {
      const hb = JSON.parse(fs.readFileSync(heartbeatFile, "utf8")) as {
        activeTrigger?: { inputSetId?: unknown } | null;
      };
      if (hb.activeTrigger === null || hb.activeTrigger === undefined) {
        return { status: 200, body: { batch_id: null, recentEvents: [] } };
      }
      if (typeof hb.activeTrigger.inputSetId === "string") {
        activeBatchId = hb.activeTrigger.inputSetId;
      }
    } catch {
      // fall through to log-walking — best effort
    }
  }
  const logFile = path.join(dir, "evolution-log.jsonl");
  if (!fs.existsSync(logFile)) {
    return { status: 200, body: { batch_id: null, recentEvents: [] } };
  }
  const raw = fs.readFileSync(logFile, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  // Parse ALL lines (not just last 200) so the filter below can find
  // interesting events even after long stretches of role_event spam. A
  // typical evolution log fits in <5MB (~30k entries) — parsing is sub-second.
  // Previous "slice(-200) then filter" broke during locator's 10+ min runs
  // because all 200 trailing lines were role_event and recentEvents → [].
  const parsed: Array<Record<string, unknown>> = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l));
    } catch {
      // skip
    }
  }
  // Derive most recent {iter, stage, batch_id} from the latest entries.
  let iter: number | null = null;
  let stage: string | null = null;
  let batchId: string | null = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const e = parsed[i] as { iter?: number; stage?: string; data?: { inputSetId?: string } };
    if (iter == null && typeof e.iter === "number") {
      iter = e.iter;
    }
    if (stage == null && typeof e.stage === "string") {
      stage = e.stage;
    }
    if (batchId == null && typeof e.data?.inputSetId === "string") {
      batchId = e.data.inputSetId;
    }
    if (iter != null && stage != null && batchId != null) {
      break;
    }
  }
  // Pre-filter to "interesting" event types before windowing — otherwise the
  // last 20 entries are dominated by per-token role_event spam and the UI
  // panel renders empty. Each kind here corresponds to a line the UI
  // formatter actually displays.
  const interestingEvents = parsed.filter((e) => {
    const ev = (e as { event?: string }).event;
    return (
      ev === "stage_start" ||
      ev === "stage_end" ||
      ev === "task_start" ||
      ev === "verdict" ||
      ev === "error"
    );
  });
  const recentEvents = interestingEvents.slice(-20);
  return {
    status: 200,
    // Heartbeat-derived activeBatchId wins because it's set on every loop
    // tick from runEvolutionLoop's current{} block, not just at init time.
    body: { batch_id: activeBatchId ?? batchId, iter, stage, recentEvents },
  };
}

// ---------------------------------------------------------------------------
// GET /api/evolution/batches
// ---------------------------------------------------------------------------

export async function handleBatchesList(ctx: HandlerCtx): Promise<HandlerResult> {
  const out: FlagBatch[] = [];

  // Collect legacy flag-batches.
  const root = flagBatchRoot(ctx.dataDir);
  if (fs.existsSync(root)) {
    for (const sub of fs.readdirSync(root)) {
      const bp = path.join(root, sub, "_batch.json");
      if (!fs.existsSync(bp)) {
        continue;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
        out.push(readFlagBatchWithDefaults(raw));
      } catch {
        // skip malformed
      }
    }
  }

  // Collect auto-scan batches (fall-back / new engine).
  const autoScanRoot = path.join(stateDir(ctx.dataDir), "auto-scan-batches");
  if (fs.existsSync(autoScanRoot)) {
    for (const sub of fs.readdirSync(autoScanRoot)) {
      const bp = path.join(autoScanRoot, sub, "_batch.json");
      if (!fs.existsSync(bp)) {
        continue;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
        out.push(readFlagBatchWithDefaults(normalizeAutoScanBatch(raw)));
      } catch {
        // skip malformed
      }
    }
  }

  if (out.length === 0) {
    return { status: 200, body: [] };
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return { status: 200, body: out };
}

// ---------------------------------------------------------------------------
// POST /api/evolution/apply, POST /api/evolution/discard
// ---------------------------------------------------------------------------

function findBatchByManifestId(
  dataDir: string,
  manifestId: string,
): { batchPath: string; batch: FlagBatch } | null {
  // In v2.6 manifest_id == batch_id (one trigger per batch).
  const bp = path.join(flagBatchDir(dataDir, manifestId), "_batch.json");
  if (fs.existsSync(bp)) {
    const batch = readFlagBatchWithDefaults(JSON.parse(fs.readFileSync(bp, "utf8")));
    return { batchPath: bp, batch };
  }
  // Fall back to auto-scan batch directory.
  const autoScanBp = path.join(stateDir(dataDir), "auto-scan-batches", manifestId, "_batch.json");
  if (fs.existsSync(autoScanBp)) {
    const batch = readFlagBatchWithDefaults(
      normalizeAutoScanBatch(JSON.parse(fs.readFileSync(autoScanBp, "utf8"))),
    );
    return { batchPath: autoScanBp, batch };
  }
  return null;
}

function findManifestJsonByTriggerId(
  dataDir: string,
  manifestId: string,
): { manifestPath: string; manifest: ReturnType<typeof loadManifest> } | null {
  // First, try current/manifest.json — if its inputSetId/triggerId matches.
  const cur = path.join(currentDir(dataDir), "manifest.json");
  if (fs.existsSync(cur)) {
    try {
      const m = loadManifest(cur);
      if (m.triggerId === manifestId || m.inputSetId === manifestId) {
        return { manifestPath: cur, manifest: m };
      }
    } catch {
      // ignore
    }
  }
  // Else look in archive/<manifestId>/manifest.json directly.
  const ar = path.join(archiveRoot(dataDir), manifestId, "manifest.json");
  if (fs.existsSync(ar)) {
    try {
      return { manifestPath: ar, manifest: loadManifest(ar) };
    } catch {
      return null;
    }
  }
  // Else scan archive/*/manifest.json for matching inputSetId.
  if (fs.existsSync(archiveRoot(dataDir))) {
    for (const sub of fs.readdirSync(archiveRoot(dataDir))) {
      const p = path.join(archiveRoot(dataDir), sub, "manifest.json");
      if (!fs.existsSync(p)) {
        continue;
      }
      try {
        const m = loadManifest(p);
        if (m.triggerId === manifestId || m.inputSetId === manifestId) {
          return { manifestPath: p, manifest: m };
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

export async function handleApply(
  ctx: HandlerCtx,
  body: { manifest_id?: unknown },
): Promise<HandlerResult> {
  const manifestId = typeof body?.manifest_id === "string" ? body.manifest_id : "";
  if (!manifestId) {
    return { status: 400, body: { error: "manifest_id required" } };
  }
  const hit = findBatchByManifestId(ctx.dataDir, manifestId);
  if (!hit) {
    return { status: 404, body: { error: "manifest not found", manifest_id: manifestId } };
  }
  if (hit.batch.apply_state !== "ready_to_apply") {
    return {
      status: 409,
      body: { error: "batch not ready_to_apply", apply_state: hit.batch.apply_state },
    };
  }
  // Resolve the manifest to find target image. We refuse to stub this in prod
  // — silently swapping to `openclaw:current` for a real-but-missing manifest
  // is dangerous (could roll the live image to a placeholder).
  const mInfo = findManifestJsonByTriggerId(ctx.dataDir, manifestId);
  if (!mInfo) {
    return {
      status: 500,
      body: { error: "manifest_payload_missing", batch_id: manifestId },
    };
  }
  const targetImage =
    mInfo.manifest.iterations?.slice(-1)[0]?.imageTag ?? mInfo.manifest.startingImage;
  if (!targetImage) {
    return {
      status: 500,
      body: { error: "manifest_target_image_missing", batch_id: manifestId },
    };
  }
  const previousImage = mInfo.manifest.startingImage ?? targetImage;
  const triggerId = mInfo.manifest.triggerId ?? manifestId;
  // Ensure stateDir exists (swap-writer requires it).
  fs.mkdirSync(stateDir(ctx.dataDir), { recursive: true });
  try {
    writeSwapRequest(stateDir(ctx.dataDir), {
      targetImage,
      previousImage,
      triggerId,
      batchId: hit.batch.batch_id,
    });
  } catch (e) {
    return {
      status: 500,
      body: { error: "failed to write swap-req.json", detail: String(e) },
    };
  }
  hit.batch.apply_state = "applied";
  fs.writeFileSync(hit.batchPath, JSON.stringify(hit.batch, null, 2));
  return { status: 200, body: { ok: true } };
}

export async function handleDiscard(
  ctx: HandlerCtx,
  body: { manifest_id?: unknown },
): Promise<HandlerResult> {
  const manifestId = typeof body?.manifest_id === "string" ? body.manifest_id : "";
  if (!manifestId) {
    return { status: 400, body: { error: "manifest_id required" } };
  }
  const hit = findBatchByManifestId(ctx.dataDir, manifestId);
  if (!hit) {
    return { status: 404, body: { error: "manifest not found", manifest_id: manifestId } };
  }
  if (hit.batch.apply_state !== "ready_to_apply") {
    return {
      status: 409,
      body: { error: "batch not ready_to_apply", apply_state: hit.batch.apply_state },
    };
  }
  hit.batch.apply_state = "discarded";
  fs.writeFileSync(hit.batchPath, JSON.stringify(hit.batch, null, 2));
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// POST /api/evolution/stop
// ---------------------------------------------------------------------------
//
// User-triggered cancellation of a running evolution. Writes a sentinel file
// that the loop polls between stages, marks batch.apply_state="failed", and
// clears the active heartbeat so the UI banner returns to idle. The loop
// honors the sentinel cooperatively — in-flight LLM calls may still take a
// few seconds to wind down.

export async function handleStop(
  ctx: HandlerCtx,
  body: { batch_id?: unknown },
): Promise<HandlerResult> {
  const batchId = typeof body?.batch_id === "string" ? body.batch_id : "";
  if (!batchId) {
    return { status: 400, body: { error: "batch_id required" } };
  }

  // Sentinel: loop reads <evo-loop-state>/stop-requested.json at each iter
  // boundary and bails out of the for-iter loop.
  const stateDir = path.join(ctx.dataDir, "evo-loop-state");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "stop-requested.json"),
      JSON.stringify({ batch_id: batchId, requested_at: Date.now() }, null, 2),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[evolution-http] stop sentinel write failed: ${String(e)}`);
  }

  // Mark batch as failed and clear trigger id so History shows it as stopped.
  // Check legacy flag-batch first, then auto-scan fallback.
  try {
    let bp = path.join(flagBatchDir(ctx.dataDir, batchId), "_batch.json");
    let isAutoScan = false;
    if (!fs.existsSync(bp)) {
      const autoScanBp = path.join(stateDir, "auto-scan-batches", batchId, "_batch.json");
      if (fs.existsSync(autoScanBp)) {
        bp = autoScanBp;
        isAutoScan = true;
      }
    }
    if (fs.existsSync(bp)) {
      const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
      const batch = readFlagBatchWithDefaults(isAutoScan ? normalizeAutoScanBatch(raw) : raw);
      if (batch.apply_state === "running" || batch.apply_state === "pending_evolution") {
        batch.apply_state = "failed";
        batch.triggered_evolution_trigger_id = null;
        fs.writeFileSync(bp, JSON.stringify(batch, null, 2));
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[evolution-http] stop batch flip failed: ${String(e)}`);
  }

  // Clear stale heartbeat so /api/evolution/active returns idle next poll.
  try {
    fs.writeFileSync(path.join(stateDir, "heartbeat.json"), "{}");
  } catch {
    // best effort
  }

  // Release the in-process busy flag so subsequent triggers don't hit 503.
  // The orphan loop keeps running in background until its next yield point
  // honors the stop sentinel — but the service is unblocked immediately.
  forceClearBusy();

  // Kill orphan coding-agent CLI processes on host (best-effort; sentinel
  // still ensures loop stops at next yield point even if this RPC fails —
  // e.g. daemon down). Walks all registered providers (Claude, Codex, ...).
  try {
    await callHostDaemonOp("kill-orphan", {});
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[evolution-http] kill-orphan RPC failed: ${String(e)}`);
  }

  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// POST /api/evolution/restart
// ---------------------------------------------------------------------------
//
// Recover a batch left in apply_state="failed" (typically after `moss evo
// stop`) by archiving the previous run's evidence and re-triggering a fresh
// evolution. Architecture is fresh-start-only (loop.ts:486 "v0 does not
// support resuming between mid-iter states"), so we cannot reuse completed
// iter work in-place — but the previous current/ is preserved under
// archive/<oldTriggerId>/ for debug. True iter-level resume is tracked as
// v2.7 work (requires loop.ts main-loop changes).
//
// Preconditions:
//   - Batch exists (legacy flag-batch or auto-scan).
//   - Batch apply_state is "failed". Other states are NOT restartable:
//       pending_evolution → caller should use /api/evolution/trigger directly
//       running           → wait for current run or call /stop first
//       ready_to_apply / applied / discarded → terminal-by-user-intent;
//           restart would silently destroy a usable converged result
//   - Service not busy with another batch (delegated check via handleTrigger).
//
// Effect:
//   - If <stateDir>/current/manifest.json's inputSetId matches this batch,
//     rename current/ → archive/<oldTriggerId>/ (preserves evidence).
//   - Remove stop-requested.json sentinel if present (loop also clears on
//     entry; this is defensive).
//   - Reset _batch.json apply_state to "pending_evolution" + clear stale
//     trigger fields.
//   - Delegate to handleTrigger for the actual loop spawn.
//
// Response: same as handleTrigger ({ manifest_id }) plus
// archived_previous_trigger when an archive was made.

export async function handleRestart(
  ctx: HandlerCtx,
  body: { batch_id?: unknown },
): Promise<HandlerResult> {
  const batchId = typeof body?.batch_id === "string" ? body.batch_id : "";
  if (!batchId) {
    return { status: 400, body: { error: "batch_id required" } };
  }

  // Locate _batch.json (legacy flag-batch or auto-scan-batches).
  let dir = flagBatchDir(ctx.dataDir, batchId);
  let bp = path.join(dir, "_batch.json");
  let isAutoScan = false;
  if (!fs.existsSync(bp)) {
    const autoScanDir = path.join(stateDir(ctx.dataDir), "auto-scan-batches", batchId);
    const autoScanBp = path.join(autoScanDir, "_batch.json");
    if (fs.existsSync(autoScanBp)) {
      dir = autoScanDir;
      bp = autoScanBp;
      isAutoScan = true;
    } else {
      return { status: 404, body: { error: "batch not found", batch_id: batchId } };
    }
  }

  const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
  const batch = readFlagBatchWithDefaults(isAutoScan ? normalizeAutoScanBatch(raw) : raw);

  if (batch.apply_state !== "failed") {
    return {
      status: 409,
      body: {
        error: "batch not restartable",
        apply_state: batch.apply_state,
        hint:
          batch.apply_state === "pending_evolution"
            ? "use /api/evolution/trigger (no restart needed)"
            : batch.apply_state === "running"
              ? "wait for current run or call /api/evolution/stop first"
              : "terminal state — apply or discard before restart",
      },
    };
  }

  // Archive prior current/ if it belongs to this batch. If current/ is for
  // a DIFFERENT batch (rare — service is single-active, but possible if the
  // user restarts after a different batch ran in between), leave it alone
  // and let the fresh trigger overwrite. loop.ts's bootRecover would archive
  // at next daemon boot anyway.
  const sdir = stateDir(ctx.dataDir);
  const currentDir = path.join(sdir, "current");
  const currentManifestPath = path.join(currentDir, "manifest.json");
  let archivedTriggerId: string | null = null;
  if (fs.existsSync(currentManifestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(currentManifestPath, "utf8")) as {
        triggerId?: string;
        inputSetId?: string;
      };
      if (prev.inputSetId === batchId && typeof prev.triggerId === "string" && prev.triggerId) {
        const archiveDir = path.join(sdir, "archive", prev.triggerId);
        fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
        try {
          fs.renameSync(currentDir, archiveDir);
          archivedTriggerId = prev.triggerId;
        } catch (e) {
          // Non-fatal — fresh trigger will overwrite current/.
          // eslint-disable-next-line no-console
          console.error(`[evolution-http] restart archive failed: ${String(e)}`);
        }
      }
    } catch {
      // Manifest unreadable — skip archive, fresh trigger handles it.
    }
  }

  // Clear stop sentinel defensively (loop also clears on entry).
  const stopSentinel = path.join(sdir, "stop-requested.json");
  if (fs.existsSync(stopSentinel)) {
    try {
      fs.unlinkSync(stopSentinel);
    } catch {
      // Best effort.
    }
  }

  // Reset apply_state so handleTrigger's gate passes. Clear stale trigger
  // fields so the freshly-generated triggerId fully owns the new run.
  batch.apply_state = "pending_evolution";
  batch.triggered_at = null;
  batch.triggered_evolution_trigger_id = null;
  fs.writeFileSync(bp, JSON.stringify(batch, null, 2));

  const result = await handleTrigger(ctx, { batch_id: batchId });
  if (result.status === 200 && archivedTriggerId) {
    return {
      status: 200,
      body: { ...(result.body as object), archived_previous_trigger: archivedTriggerId },
    };
  }
  return result;
}


// ---------------------------------------------------------------------------
// GET /api/evolution/diff?manifestId=X
// ---------------------------------------------------------------------------

function sanitizeForOutput(s: string): string {
  // Strip ASCII control characters except newline (0x0A) and tab (0x09).
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x09 || (c >= 0x20 && c !== 0x7f)) {
      out += s[i];
    }
  }
  return out;
}

async function runGit(repoDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errs.push(c));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} exited ${code}: ${Buffer.concat(errs).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function handleDiff(ctx: HandlerCtx, query: URLSearchParams): Promise<HandlerResult> {
  const manifestId = query.get("manifestId");
  if (!manifestId) {
    return { status: 400, body: { error: "manifestId query param required" } };
  }
  const mInfo = findManifestJsonByTriggerId(ctx.dataDir, manifestId);
  if (!mInfo) {
    return { status: 404, body: { error: "manifest not found", manifest_id: manifestId } };
  }
  const from = mInfo.manifest.startingCommit;
  const last = mInfo.manifest.iterations?.slice(-1)[0];
  const to = last?.commitHash ?? null;
  if (!from || !to) {
    return {
      status: 200,
      body: { commits: { from, to, message: "no diff available" }, files: [] },
    };
  }
  const repoDir = ctx.openclawRepoDir;
  if (!repoDir || !fs.existsSync(path.join(repoDir, ".git"))) {
    return {
      status: 200,
      body: {
        commits: { from, to, message: "repo not available" },
        files: [],
      },
    };
  }
  try {
    const stat = await runGit(repoDir, ["diff", "--stat", `${from}..${to}`]);
    const fullDiff = await runGit(repoDir, ["diff", `${from}..${to}`]);
    // Naive split by file from --stat output: "<path> | <n> +-"
    const files: Array<{ path: string; diff: string }> = [];
    const statLines = stat
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.includes("|"));
    for (const sl of statLines) {
      const idx = sl.lastIndexOf("|");
      const pname = sl.slice(0, idx).trim();
      if (pname && !pname.startsWith(" ")) {
        files.push({ path: pname, diff: "" });
      }
    }
    // Fall back: one entry covering the full diff if --stat didn't yield rows.
    if (files.length === 0) {
      files.push({ path: "(full)", diff: sanitizeForOutput(fullDiff) });
    } else {
      files[0].diff = sanitizeForOutput(fullDiff);
    }
    return {
      status: 200,
      body: { commits: { from, to, message: stat.trim() }, files },
    };
  } catch (e) {
    return {
      status: 500,
      body: { error: "git diff failed", detail: String(e) },
    };
  }
}

// ---------------------------------------------------------------------------
// GET /api/evolution/scores?manifestId=X — Demo Mode score curve.
// ---------------------------------------------------------------------------

interface PerTaskScores {
  [taskId: string]: number;
}

interface ScoresResponse {
  baseline: { mean: number; perTask: PerTaskScores } | null;
  iters: Array<{ iter: number; mean: number; perTask: PerTaskScores; verdict: string | null }>;
  verdict: string | null;
  templateId: string | null;
}

function meanFromTrainResults(trs: { score: number }[]): number {
  if (trs.length === 0) {
    return 0;
  }
  return trs.reduce((a, b) => a + b.score, 0) / trs.length;
}

function perTaskFromTrainResults(trs: Array<{ task: string; score: number }>): PerTaskScores {
  const groups: Record<string, number[]> = {};
  for (const tr of trs) {
    (groups[tr.task] ??= []).push(tr.score);
  }
  const out: PerTaskScores = {};
  for (const [k, v] of Object.entries(groups)) {
    out[k] = v.reduce((a, b) => a + b, 0) / v.length;
  }
  return out;
}

function readBaselineForDemo(templateId: string): {
  mean: number;
  perTask: PerTaskScores;
} | null {
  // Reads benchmark/claw-eval/baseline-traces/<templateId>/
  // expecting per-task subdirs with trial_*/result.json files.
  const benchRoot = fs.existsSync("/benchmark")
    ? "/benchmark"
    : process.env.MOSS_OPENCLAW_REPO_DIR
      ? path.join(path.dirname(process.env.MOSS_OPENCLAW_REPO_DIR), "benchmark")
      : null;
  if (!benchRoot) {
    return null;
  }
  const dir = path.join(benchRoot, "claw-eval/baseline-traces", templateId);
  if (!fs.existsSync(dir)) {
    return null;
  }
  const perTask: PerTaskScores = {};
  for (const taskDir of fs.readdirSync(dir)) {
    const taskPath = path.join(dir, taskDir);
    let isDir = false;
    try {
      isDir = fs.statSync(taskPath).isDirectory();
    } catch {
      /* skip */
    }
    if (!isDir) {
      continue;
    }
    const trialScores: number[] = [];
    for (const trial of fs.readdirSync(taskPath)) {
      const rp = path.join(taskPath, trial, "result.json");
      if (!fs.existsSync(rp)) {
        continue;
      }
      try {
        const r = JSON.parse(fs.readFileSync(rp, "utf8")) as Record<string, unknown>;
        const grade = (r.grade as Record<string, unknown> | undefined) ?? {};
        const s = (grade.task_score ?? r.task_score ?? 0) as number;
        if (typeof s === "number") {
          trialScores.push(s);
        }
      } catch {
        /* skip */
      }
    }
    if (trialScores.length > 0) {
      perTask[taskDir] = trialScores.reduce((a, b) => a + b, 0) / trialScores.length;
    }
  }
  const taskMeans = Object.values(perTask);
  if (taskMeans.length === 0) {
    return null;
  }
  return {
    mean: taskMeans.reduce((a, b) => a + b, 0) / taskMeans.length,
    perTask,
  };
}

export async function handleScores(
  ctx: HandlerCtx,
  query: URLSearchParams,
): Promise<HandlerResult> {
  const manifestId = query.get("manifestId");
  if (!manifestId) {
    return { status: 400, body: { error: "manifestId query param required" } };
  }
  const mInfo = findManifestJsonByTriggerId(ctx.dataDir, manifestId);
  if (!mInfo) {
    return { status: 404, body: { error: "manifest not found", manifest_id: manifestId } };
  }
  const batchHit = findBatchByManifestId(ctx.dataDir, manifestId);
  const isDemoBatch = batchHit?.batch.origin === "demo";
  const templateId = batchHit?.batch.user_label ?? null;

  const iters = mInfo.manifest.iterations.map((it) => ({
    iter: it.iteration,
    mean: meanFromTrainResults(it.trainResults),
    perTask: perTaskFromTrainResults(it.trainResults),
    verdict: it.verdict ?? null,
  }));

  const baseline = isDemoBatch && templateId ? readBaselineForDemo(templateId) : null;

  const lastVerdict = mInfo.manifest.iterations.slice(-1)[0]?.verdict ?? null;

  const resp: ScoresResponse = {
    baseline,
    iters,
    verdict: lastVerdict,
    templateId,
  };
  return { status: 200, body: resp };
}

// ---------------------------------------------------------------------------
// GET/POST /api/evolution/settings
// ---------------------------------------------------------------------------

export async function handleSettingsGet(ctx: HandlerCtx): Promise<HandlerResult> {
  const s = readUiSettings(ctx.dataDir);
  return { status: 200, body: s };
}

export async function handleSettingsPost(
  ctx: HandlerCtx,
  body: Partial<UiSettings>,
): Promise<HandlerResult> {
  const out = writeUiSettings(ctx.dataDir, body ?? {});
  return { status: 200, body: out };
}

// Re-export for evolution-http.ts (kept here to centralize types).
export { saveManifest };

// Expose for the workspace-dir helper used elsewhere — quiet unused-import
// linter pre-emptively in case loadConfig grows test-only branches.
export const __agentScopePeek = { resolveAgentWorkspaceDir };
