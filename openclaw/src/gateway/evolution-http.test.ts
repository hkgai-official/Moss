import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FlagBatch, FlagSnapshot } from "../evolution/types/flag-batch.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { _resetAutoTriggerLockForTests } from "./evolution-http.helpers.js";
import { handleEvolutionHttpRequest } from "./evolution-http.js";

function mockReqRes(method: string, url: string, body?: unknown) {
  const req: Record<string, unknown> = {
    method,
    url,
    headers: { "content-type": "application/json" } as Record<string, string>,
    socket: { remoteAddress: "127.0.0.1" },
  };
  const res: Record<string, unknown> = {
    statusCode: 0,
    bodyText: "",
    setHeader: () => {},
    end(s?: string) {
      this.bodyText = s ?? "";
    },
  };
  req.on = (e: string, cb: (chunk?: Buffer) => void) => {
    if (e === "data" && body !== undefined) {
      cb(Buffer.from(JSON.stringify(body)));
    }
    if (e === "end") {
      cb();
    }
  };
  return {
    req: req as unknown as Parameters<typeof handleEvolutionHttpRequest>[0],
    res: res as unknown as Parameters<typeof handleEvolutionHttpRequest>[1],
    get body() {
      return (res as { bodyText: string }).bodyText;
    },
    get status() {
      return (res as { statusCode: number }).statusCode;
    },
    parsed(): unknown {
      try {
        return JSON.parse((res as { bodyText: string }).bodyText);
      } catch {
        return null;
      }
    },
  };
}

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-evohttp-"));
  fs.mkdirSync(path.join(dataDir, "evo-loop-state"), { recursive: true });
  _resetAutoTriggerLockForTests();
});

// ---------------------------------------------------------------------------
// Fixture helpers (session JSONL + flag pool/batch)
// ---------------------------------------------------------------------------

function writeSessionJsonl(
  dataDir_: string,
  agentId: string,
  sessionId: string,
  msgs: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  const dir = path.join(dataDir_, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "session",
      version: 7,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    }),
  );
  msgs.forEach((m, i) => {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `msg-${i}`,
        parentId: i === 0 ? null : `msg-${i - 1}`,
        timestamp: new Date().toISOString(),
        message: { role: m.role, content: m.content },
      }),
    );
  });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function writeFlag(
  dataDir_: string,
  flagId: string,
  overrides: Partial<FlagSnapshot> = {},
): string {
  const dir = path.join(dataDir_, "evo-loop-state", "flag-pool");
  fs.mkdirSync(dir, { recursive: true });
  const snap: FlagSnapshot = {
    flag_id: flagId,
    batch_id: "",
    flagged_at: Date.now(),
    flagged_by: "main",
    user_prompt: { text: "x" },
    agent_trace: [],
    tool_dispatches: [],
    agent_tool_registry_at_flag_time: [],
    source_session_id: "sess-1",
    source_turn_range: [0, 0],
    ...overrides,
  };
  const out = path.join(dir, `${flagId}.json`);
  fs.writeFileSync(out, JSON.stringify(snap, null, 2));
  return out;
}

function writeBatch(
  dataDir_: string,
  batchId: string,
  overrides: Partial<FlagBatch> = {},
): { dir: string; batchJson: string } {
  const dir = path.join(dataDir_, "evo-loop-state", "flag-batch", batchId);
  fs.mkdirSync(dir, { recursive: true });
  const batch: FlagBatch = {
    batch_id: batchId,
    created_at: Date.now(),
    status: "current",
    threshold: 4,
    trigger_mode: "manual",
    triggered_at: null,
    triggered_evolution_trigger_id: null,
    flag_count: 0,
    origin: "user",
    user_label: null,
    depth: "standard",
    created_by: "ui",
    apply_state: "pending_evolution",
    ...overrides,
  };
  const bp = path.join(dir, "_batch.json");
  fs.writeFileSync(bp, JSON.stringify(batch, null, 2));
  return { dir, batchJson: bp };
}

/** Write a minimal-but-valid manifest under archive/<manifestId>/manifest.json
 *  so handleApply's `findManifestJsonByTriggerId` returns a real payload (v2.6
 *  Fix 3: stubs are no longer accepted). The shape matches schemaVersion 6. */
function writeManifestFixture(
  dataDir_: string,
  manifestId: string,
  opts: { targetImage: string; startingImage: string; startingCommit?: string | null } = {
    targetImage: "openclaw:fixture-evolved",
    startingImage: "openclaw:fixture-base",
  },
): string {
  const dir = path.join(dataDir_, "evo-loop-state", "archive", manifestId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 6,
    mode: "user",
    evolutionDepth: "standard",
    flagBatchId: manifestId,
    triggerId: manifestId,
    triggerSource: "manual",
    triggeredAt: Date.now(),
    triggeredBy: "test",
    inputSetId: manifestId,
    inputManifestPath: dir,
    startingImage: opts.startingImage,
    startingCommit: opts.startingCommit ?? "0000000000000000000000000000000000000000",
    startingBranch: "main",
    evolutionBranch: `evo/${manifestId}`,
    params: {
      max_iter: 3,
      max_plan_rounds: 1,
      max_code_retries: 0,
      n_trials_per_task: 2,
      claweval_task_timeout_s: 300,
      validation_trials: 1,
      build_smoke_timeout_s: 240,
      docker_build_timeout_s: 600,
      consecutive_build_failures_for_abort: 3,
      consecutive_session_crashes_for_abort: 3,
      no_progress_streak_limit: 3,
      progress_no_approve_streak_limit: 4,
      locator_session_timeout_s: 1800,
      planner_session_timeout_s: 1800,
      plan_reviewer_session_timeout_s: 1500,
      implementer_session_timeout_s: 3600,
      code_reviewer_session_timeout_s: 1800,
      strategic_reviewer_timeout_s: 1200,
      task_evaluator_session_timeout_s: 1500,
      reviewer_session_timeout_s: 1200,
      plateau_no_improvement_iters: 1,
    },
    tasks: { stage_a: [], stage_c: [] },
    validationSet: manifestId,
    status: "converged",
    currentIteration: 1,
    currentStage: "done",
    iterations: [
      {
        iteration: 1,
        verdict: "approve",
        commitHash: "1111111111111111111111111111111111111111",
        imageTag: opts.targetImage,
        trainResults: [],
        validationRun: null,
        diagnosisMdPath: null,
        planMdPath: null,
        planReviewerMdPath: null,
        implementerMdPath: null,
        codeReviewerMdPath: null,
        reviewerMdPath: null,
        reviewerVerdict: null,
        taskEvaluations: {},
        elapsedS: 1,
        planRoundCount: 1,
        codeRoundCount: 1,
        sessionIdByRole: null,
      },
    ],
    streaks: {
      consecutiveBuildFailures: 0,
      consecutiveSessionCrashes: 0,
      noProgress: 0,
      progressNoApprove: 0,
    },
    bestScoreSoFar: 1,
    swapOutcome: null,
  };
  const p = path.join(dir, "manifest.json");
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

// ===========================================================================
// SKELETON / AUTH (existing 3 tests preserved)
// ===========================================================================

describe("evolution-http skeleton", () => {
  it("returns 405 on non-POST/GET", async () => {
    const mock = mockReqRes("DELETE", "/api/evolution/flag");
    const handled = await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(handled).toBe(true);
    expect(mock.status).toBe(405);
  });

  it("returns false for non-evolution paths", async () => {
    const mock = mockReqRes("GET", "/api/foo");
    const handled = await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(handled).toBe(false);
  });

  it("returns 401 when bearer auth is required and no token provided (path b)", async () => {
    const mock = mockReqRes("POST", "/api/evolution/flag", { sessionId: "x" });
    const auth: ResolvedGatewayAuth = {
      mode: "token",
      modeSource: "token",
      token: "secret-test-token-1234567890",
      allowTailscale: false,
    };
    const handled = await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir, auth });
    expect(handled).toBe(true);
    expect(mock.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/evolution/settings & POST /api/evolution/settings
// ===========================================================================

describe("evolution-http /api/evolution/settings", () => {
  it("GET returns defaults when no file exists", async () => {
    const mock = mockReqRes("GET", "/api/evolution/settings");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    const r = mock.parsed() as { user_mode: { trigger_mode: string; threshold: number } };
    expect(r.user_mode.trigger_mode).toBe("manual");
    expect(r.user_mode.threshold).toBe(4);
  });

  it("POST partial patch merges with defaults and round-trips", async () => {
    const post = mockReqRes("POST", "/api/evolution/settings", {
      user_mode: { trigger_mode: "auto", threshold: 7 },
    });
    await handleEvolutionHttpRequest(post.req, post.res, { dataDir });
    expect(post.status).toBe(200);
    const get = mockReqRes("GET", "/api/evolution/settings");
    await handleEvolutionHttpRequest(get.req, get.res, { dataDir });
    const r = get.parsed() as {
      user_mode: { trigger_mode: string; threshold: number; depth: string };
    };
    expect(r.user_mode.trigger_mode).toBe("auto");
    expect(r.user_mode.threshold).toBe(7);
    expect(r.user_mode.depth).toBe("standard"); // default preserved
  });
});

// ===========================================================================
// GET /api/evolution/flag-pool
// ===========================================================================

describe("evolution-http /api/evolution/flag-pool", () => {
  it("GET returns empty array when no pool", async () => {
    const mock = mockReqRes("GET", "/api/evolution/flag-pool");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    expect(mock.parsed()).toEqual([]);
  });

  it("GET lists flags written to pool, sorted by flagged_at", async () => {
    writeFlag(dataDir, "f1", { flagged_at: 100 });
    writeFlag(dataDir, "f2", { flagged_at: 50 });
    const mock = mockReqRes("GET", "/api/evolution/flag-pool");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    const arr = mock.parsed() as FlagSnapshot[];
    expect(arr.map((x) => x.flag_id)).toEqual(["f2", "f1"]);
  });
});

// ===========================================================================
// POST /api/evolution/flag
// ===========================================================================

describe("evolution-http POST /api/evolution/flag", () => {
  it("404 when session JSONL missing", async () => {
    const mock = mockReqRes("POST", "/api/evolution/flag", {
      sessionId: "no-such-sess",
      userMessageIndex: 0,
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(404);
  });

  it("422 when userMessageIndex out of range", async () => {
    writeSessionJsonl(dataDir, "main", "sess-A", [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    const mock = mockReqRes("POST", "/api/evolution/flag", {
      sessionId: "sess-A",
      userMessageIndex: 5,
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(422);
  });

  it("happy path writes flag-pool/<flag_id>.json with trace slice", async () => {
    writeSessionJsonl(dataDir, "main", "sess-A", [
      { role: "user", content: "first ask" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second ask" },
      { role: "assistant", content: "second reply" },
    ]);
    const mock = mockReqRes("POST", "/api/evolution/flag", {
      sessionId: "sess-A",
      userMessageIndex: 0,
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    const flagId = (mock.parsed() as { flag_id: string }).flag_id;
    expect(flagId).toMatch(/^[0-9A-Z]{26}$/);
    const poolFile = path.join(dataDir, "evo-loop-state/flag-pool", `${flagId}.json`);
    expect(fs.existsSync(poolFile)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(poolFile, "utf8")) as FlagSnapshot;
    // Trace should hold the first user + first assistant only.
    expect(snap.agent_trace.length).toBe(2);
    expect(snap.user_prompt.text).toBe("first ask");
    expect(snap.source_session_id).toBe("sess-A");
  });
});

// ===========================================================================
// POST /api/evolution/unflag
// ===========================================================================

describe("evolution-http POST /api/evolution/unflag", () => {
  it("404 when flag not found", async () => {
    const mock = mockReqRes("POST", "/api/evolution/unflag", { flag_id: "nope" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(404);
  });

  it("happy path deletes pool entry", async () => {
    writeFlag(dataDir, "f1");
    const mock = mockReqRes("POST", "/api/evolution/unflag", { flag_id: "f1" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, "evo-loop-state/flag-pool/f1.json"))).toBe(false);
  });

  it("409 when flag is locked into a batch", async () => {
    writeFlag(dataDir, "f1", { batch_id: "batch_user_LOCKED" });
    const mock = mockReqRes("POST", "/api/evolution/unflag", { flag_id: "f1" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(409);
  });
});

// ===========================================================================
// POST /api/evolution/compose-batch
// ===========================================================================

describe("evolution-http POST /api/evolution/compose-batch", () => {
  it("422 when no flag_ids", async () => {
    const mock = mockReqRes("POST", "/api/evolution/compose-batch", {
      flag_ids: [],
      depth: "standard",
      trigger: false,
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(422);
  });

  it("409 when one flag is already locked", async () => {
    writeFlag(dataDir, "f1");
    writeFlag(dataDir, "f2", { batch_id: "batch_user_OTHER" });
    const mock = mockReqRes("POST", "/api/evolution/compose-batch", {
      flag_ids: ["f1", "f2"],
      depth: "standard",
      trigger: false,
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(409);
  });

  it("happy path moves flags into flag-batch and writes _batch.json", async () => {
    writeFlag(dataDir, "f1");
    writeFlag(dataDir, "f2");
    const mock = mockReqRes("POST", "/api/evolution/compose-batch", {
      flag_ids: ["f1", "f2"],
      user_label: "return",
      depth: "deep",
      trigger: false,
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    const batchId = (mock.parsed() as { batch_id: string }).batch_id;
    // v2.6 Fix 2: 4-char ulid suffix (base32 0-9 A-Z minus I,L,O,U) prevents
    // sub-second concurrent-compose collisions.
    expect(batchId).toMatch(/^batch_user_\d{8}_\d{6}_[0-9A-Z]{4}$/);
    const batchDir = path.join(dataDir, "evo-loop-state/flag-batch", batchId);
    expect(fs.existsSync(path.join(batchDir, "_batch.json"))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, "f1.json"))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, "f2.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "evo-loop-state/flag-pool/f1.json"))).toBe(false);
    const batch = JSON.parse(
      fs.readFileSync(path.join(batchDir, "_batch.json"), "utf8"),
    ) as FlagBatch;
    expect(batch.user_label).toBe("return");
    expect(batch.depth).toBe("deep");
    expect(batch.flag_count).toBe(2);
    expect(batch.created_by).toBe("ui");
  });
});

// ===========================================================================
// POST /api/evolution/trigger
// ===========================================================================

describe("evolution-http POST /api/evolution/trigger", () => {
  it("404 when batch not found", async () => {
    const mock = mockReqRes("POST", "/api/evolution/trigger", { batch_id: "batch_user_nope" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(404);
  });

  it("409 when batch is not pending_evolution", async () => {
    writeBatch(dataDir, "batch_user_abc", { apply_state: "applied" });
    const mock = mockReqRes("POST", "/api/evolution/trigger", { batch_id: "batch_user_abc" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(409);
  });

  it("500 + rolls apply_state back to pending_evolution when service not started", async () => {
    // v2.6 Fix 1: tests run without startEvolutionService(), so the pre-check
    // in triggerForBatch detects status.started === false and returns 500
    // *after* rolling apply_state back to pending_evolution. (Previously the
    // generic Error escaped, leaving the batch stuck at "running" forever.)
    writeBatch(dataDir, "batch_user_xyz", { apply_state: "pending_evolution", depth: "shallow" });
    const mock = mockReqRes("POST", "/api/evolution/trigger", { batch_id: "batch_user_xyz" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(500);
    const body = mock.parsed() as { error: string };
    expect(body.error).toBe("evolution_service_not_started");
    // Critical: apply_state must be rolled back so user can retry.
    const bp = path.join(dataDir, "evo-loop-state/flag-batch/batch_user_xyz/_batch.json");
    const updated = JSON.parse(fs.readFileSync(bp, "utf8")) as FlagBatch;
    expect(updated.apply_state).toBe("pending_evolution");
    expect(updated.triggered_at).toBeNull();
  });
});

// ===========================================================================
// GET /api/evolution/active
// ===========================================================================

describe("evolution-http GET /api/evolution/active", () => {
  it("returns null batch_id when no current/", async () => {
    const mock = mockReqRes("GET", "/api/evolution/active");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    const r = mock.parsed() as { batch_id: string | null; recentEvents: unknown[] };
    expect(r.batch_id).toBeNull();
    expect(r.recentEvents).toEqual([]);
  });

  it("derives iter/stage/batch_id from last events", async () => {
    const dir = path.join(dataDir, "evo-loop-state/current");
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        ts: 1,
        iter: 0,
        stage: "init",
        event: "stage_start",
        data: { inputSetId: "batch_user_aa" },
      }),
      JSON.stringify({ ts: 2, iter: 2, stage: "code-loop", event: "stage_start", data: {} }),
    ];
    fs.writeFileSync(path.join(dir, "evolution-log.jsonl"), lines.join("\n") + "\n");
    const mock = mockReqRes("GET", "/api/evolution/active");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    const r = mock.parsed() as {
      batch_id: string | null;
      iter: number | null;
      stage: string | null;
      recentEvents: unknown[];
    };
    expect(r.iter).toBe(2);
    expect(r.stage).toBe("code-loop");
    expect(r.batch_id).toBe("batch_user_aa");
    expect(r.recentEvents.length).toBe(2);
  });
});

// ===========================================================================
// GET /api/evolution/batches
// ===========================================================================

describe("evolution-http GET /api/evolution/batches", () => {
  it("returns empty array when no batches", async () => {
    const mock = mockReqRes("GET", "/api/evolution/batches");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    expect(mock.parsed()).toEqual([]);
  });

  it("returns batches sorted by created_at desc with v2.6 defaults applied", async () => {
    writeBatch(dataDir, "batch_user_old", { created_at: 100 });
    writeBatch(dataDir, "batch_user_new", { created_at: 500 });
    const mock = mockReqRes("GET", "/api/evolution/batches");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    const arr = mock.parsed() as FlagBatch[];
    expect(arr.map((b) => b.batch_id)).toEqual(["batch_user_new", "batch_user_old"]);
  });
});

// ===========================================================================
// POST /api/evolution/apply, POST /api/evolution/discard
// ===========================================================================

describe("evolution-http POST /api/evolution/apply", () => {
  it("404 when manifest not found", async () => {
    const mock = mockReqRes("POST", "/api/evolution/apply", { manifest_id: "nope" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(404);
  });

  it("409 when batch is not ready_to_apply", async () => {
    writeBatch(dataDir, "batch_user_R", { apply_state: "pending_evolution" });
    const mock = mockReqRes("POST", "/api/evolution/apply", { manifest_id: "batch_user_R" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(409);
  });

  it("500 manifest_payload_missing when no manifest exists (v2.6 Fix 3 — no stub fallback)", async () => {
    // Apply must NOT silently swap against `openclaw:current` for a batch
    // that's marked ready_to_apply but has no manifest payload on disk.
    writeBatch(dataDir, "batch_user_NOMANIFEST", { apply_state: "ready_to_apply" });
    const mock = mockReqRes("POST", "/api/evolution/apply", {
      manifest_id: "batch_user_NOMANIFEST",
    });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(500);
    const body = mock.parsed() as { error: string; batch_id: string };
    expect(body.error).toBe("manifest_payload_missing");
    expect(body.batch_id).toBe("batch_user_NOMANIFEST");
    // No swap-req should have been written.
    expect(fs.existsSync(path.join(dataDir, "evo-loop-state/swap-req.json"))).toBe(false);
    // Batch should remain ready_to_apply (not flipped to applied).
    const bp = path.join(dataDir, "evo-loop-state/flag-batch/batch_user_NOMANIFEST/_batch.json");
    const updated = JSON.parse(fs.readFileSync(bp, "utf8")) as FlagBatch;
    expect(updated.apply_state).toBe("ready_to_apply");
  });

  it("happy path sets apply_state=applied + writes swap-req.json (with real manifest)", async () => {
    writeBatch(dataDir, "batch_user_R", { apply_state: "ready_to_apply" });
    writeManifestFixture(dataDir, "batch_user_R", {
      targetImage: "openclaw:r-evolved",
      startingImage: "openclaw:r-base",
    });
    const mock = mockReqRes("POST", "/api/evolution/apply", { manifest_id: "batch_user_R" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    const bp = path.join(dataDir, "evo-loop-state/flag-batch/batch_user_R/_batch.json");
    const updated = JSON.parse(fs.readFileSync(bp, "utf8")) as FlagBatch;
    expect(updated.apply_state).toBe("applied");
    expect(fs.existsSync(path.join(dataDir, "evo-loop-state/swap-req.json"))).toBe(true);
    const swap = JSON.parse(
      fs.readFileSync(path.join(dataDir, "evo-loop-state/swap-req.json"), "utf8"),
    ) as { target_image: string; previous_image: string; trigger_id: string };
    expect(swap.target_image).toBe("openclaw:r-evolved");
    expect(swap.previous_image).toBe("openclaw:r-base");
    expect(swap.trigger_id).toBe("batch_user_R");
  });
});

describe("evolution-http POST /api/evolution/discard", () => {
  it("404 when manifest not found", async () => {
    const mock = mockReqRes("POST", "/api/evolution/discard", { manifest_id: "nope" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(404);
  });

  it("409 when not ready_to_apply", async () => {
    writeBatch(dataDir, "batch_user_D", { apply_state: "applied" });
    const mock = mockReqRes("POST", "/api/evolution/discard", { manifest_id: "batch_user_D" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(409);
  });

  it("happy path sets apply_state=discarded (no swap-req)", async () => {
    writeBatch(dataDir, "batch_user_D", { apply_state: "ready_to_apply" });
    const mock = mockReqRes("POST", "/api/evolution/discard", { manifest_id: "batch_user_D" });
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(200);
    const bp = path.join(dataDir, "evo-loop-state/flag-batch/batch_user_D/_batch.json");
    const updated = JSON.parse(fs.readFileSync(bp, "utf8")) as FlagBatch;
    expect(updated.apply_state).toBe("discarded");
    expect(fs.existsSync(path.join(dataDir, "evo-loop-state/swap-req.json"))).toBe(false);
  });
});

// ===========================================================================
// GET /api/evolution/diff
// ===========================================================================

describe("evolution-http GET /api/evolution/diff", () => {
  it("400 when manifestId query param missing", async () => {
    const mock = mockReqRes("GET", "/api/evolution/diff");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(400);
  });

  it("404 when manifest not found", async () => {
    const mock = mockReqRes("GET", "/api/evolution/diff?manifestId=nope");
    await handleEvolutionHttpRequest(mock.req, mock.res, { dataDir });
    expect(mock.status).toBe(404);
  });
});
