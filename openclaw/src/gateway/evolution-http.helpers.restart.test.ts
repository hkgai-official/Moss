// evolution-http.helpers.restart.test.ts
//
// Tests for handleRestart: recovers a batch left in apply_state=failed by
// archiving the prior run's current/ and delegating to handleTrigger.
//
// We don't exercise the full trigger path here (no live service); the tests
// focus on the restart-specific concerns:
//   - Argument validation (400 missing batch_id)
//   - Locator (404 when batch in neither legacy nor auto-scan)
//   - State gate (409 when apply_state != "failed")
//   - Archive behavior: current/ → archive/<oldTriggerId>/ when inputSetId
//     matches; current/ left alone when inputSetId doesn't match
//   - State reset: apply_state flipped pending_evolution + stop-sentinel
//     cleared before delegating to handleTrigger

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HandlerCtx } from "./evolution-http.helpers.js";

describe("handleRestart", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-http-restart-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFailedFlagBatch(batchId: string): string {
    const dir = path.join(tmpDir, "evo-loop-state", "flag-batch", batchId);
    fs.mkdirSync(dir, { recursive: true });
    const bp = path.join(dir, "_batch.json");
    fs.writeFileSync(
      bp,
      JSON.stringify(
        {
          batch_id: batchId,
          created_at: 1730000000000,
          status: "current",
          threshold: 4,
          trigger_mode: "manual",
          triggered_at: 1730000100000,
          flag_count: 4,
          apply_state: "failed",
          triggered_evolution_trigger_id: null,
          depth: "standard",
        },
        null,
        2,
      ),
    );
    return bp;
  }

  function writeCurrentManifest(triggerId: string, inputSetId: string): string {
    const currentDir = path.join(tmpDir, "evo-loop-state", "current");
    fs.mkdirSync(currentDir, { recursive: true });
    const mp = path.join(currentDir, "manifest.json");
    fs.writeFileSync(mp, JSON.stringify({ triggerId, inputSetId, schemaVersion: 6 }, null, 2));
    return mp;
  }

  it("returns 400 when batch_id is missing", async () => {
    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    const res = await handleRestart(ctx, {});
    expect(res.status).toBe(400);
  });

  it("returns 404 when batch exists in neither legacy nor auto-scan", async () => {
    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    const res = await handleRestart(ctx, { batch_id: "nonexistent" });
    expect(res.status).toBe(404);
  });

  it("returns 409 with helpful hint when batch is pending_evolution (no restart needed)", async () => {
    const batchId = "batch-pending-test";
    const dir = path.join(tmpDir, "evo-loop-state", "flag-batch", batchId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_batch.json"),
      JSON.stringify(
        {
          batch_id: batchId,
          created_at: 1730000000000,
          status: "current",
          threshold: 4,
          trigger_mode: "manual",
          flag_count: 4,
          apply_state: "pending_evolution",
          depth: "standard",
        },
        null,
        2,
      ),
    );
    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    const res = await handleRestart(ctx, { batch_id: batchId });
    expect(res.status).toBe(409);
    const body = res.body as Record<string, unknown>;
    expect(body.apply_state).toBe("pending_evolution");
    expect(String(body.hint)).toContain("trigger");
  });

  it("returns 409 with helpful hint when batch is running", async () => {
    const batchId = "batch-running-test";
    const dir = path.join(tmpDir, "evo-loop-state", "flag-batch", batchId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_batch.json"),
      JSON.stringify(
        {
          batch_id: batchId,
          created_at: 1730000000000,
          status: "current",
          threshold: 4,
          trigger_mode: "manual",
          flag_count: 4,
          apply_state: "running",
          depth: "standard",
        },
        null,
        2,
      ),
    );
    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    const res = await handleRestart(ctx, { batch_id: batchId });
    expect(res.status).toBe(409);
    const body = res.body as Record<string, unknown>;
    expect(String(body.hint)).toContain("stop");
  });

  it("on failed batch with matching current/, archives current/ before delegating", async () => {
    const batchId = "batch-restart-archive-test";
    const oldTriggerId = "old-trigger-uuid-1234";
    writeFailedFlagBatch(batchId);
    writeCurrentManifest(oldTriggerId, batchId);
    // Also drop a marker file so we can confirm the archive contains the
    // whole current/ subtree, not just manifest.json.
    fs.writeFileSync(
      path.join(tmpDir, "evo-loop-state", "current", "marker.txt"),
      "evidence-from-prior-run",
    );

    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    const res = await handleRestart(ctx, { batch_id: batchId });

    // The delegated handleTrigger will likely 503 (no live service), but
    // the archive step must have completed first.
    const archivedDir = path.join(tmpDir, "evo-loop-state", "archive", oldTriggerId);
    expect(fs.existsSync(archivedDir)).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, "manifest.json"))).toBe(true);
    expect(fs.readFileSync(path.join(archivedDir, "marker.txt"), "utf8")).toBe(
      "evidence-from-prior-run",
    );
    // current/ should be gone (renamed to archive).
    expect(fs.existsSync(path.join(tmpDir, "evo-loop-state", "current"))).toBe(false);
    // Whatever status the delegate returned, it's not 404 (batch was found).
    expect(res.status).not.toBe(404);
  });

  it("on failed batch with non-matching current/ (different batch), leaves current/ alone", async () => {
    const batchId = "batch-restart-no-archive";
    const otherBatchId = "some-other-batch";
    const otherTriggerId = "other-trigger-uuid";
    writeFailedFlagBatch(batchId);
    writeCurrentManifest(otherTriggerId, otherBatchId);

    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    await handleRestart(ctx, { batch_id: batchId });

    // current/ should still be there (it belongs to other batch).
    expect(fs.existsSync(path.join(tmpDir, "evo-loop-state", "current", "manifest.json"))).toBe(
      true,
    );
    // No archive subdir created for either trigger.
    expect(fs.existsSync(path.join(tmpDir, "evo-loop-state", "archive", otherTriggerId))).toBe(
      false,
    );
  });

  it("clears stop-requested.json sentinel as part of restart prep", async () => {
    const batchId = "batch-restart-sentinel-clear";
    writeFailedFlagBatch(batchId);
    const sentinel = path.join(tmpDir, "evo-loop-state", "stop-requested.json");
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, JSON.stringify({ batch_id: batchId }));

    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    await handleRestart(ctx, { batch_id: batchId });

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("resets apply_state to pending_evolution before delegating (visible even if delegate 503s)", async () => {
    const batchId = "batch-restart-state-reset";
    const bp = writeFailedFlagBatch(batchId);

    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    await handleRestart(ctx, { batch_id: batchId });

    // After delegate: handleTrigger may have flipped to "running" (if service
    // accepted) or rolled back to "pending_evolution" (if service unavailable).
    // Either way it's NO LONGER "failed", proving the gate was unblocked.
    const after = JSON.parse(fs.readFileSync(bp, "utf8"));
    expect(after.apply_state).not.toBe("failed");
  });

  it("returns 404 when given an auto-scan batch id that exists but is not in failed state", async () => {
    // Edge case: handleRestart should locate auto-scan batches via fallback,
    // same as handleTrigger. Set up a sealed auto-scan batch in pending state.
    const batchId = "auto-batch-fallback-test";
    const autoDir = path.join(tmpDir, "evo-loop-state", "auto-scan-batches", batchId);
    fs.mkdirSync(autoDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoDir, "_batch.json"),
      JSON.stringify(
        {
          id: batchId,
          batch_id: batchId,
          created_at: 1730000000000,
          sealed: true,
          size: 5,
          apply_state: "pending_evolution",
          depth: "standard",
        },
        null,
        2,
      ),
    );
    const { handleRestart } = await import("./evolution-http.helpers.js");
    const ctx: HandlerCtx = { dataDir: tmpDir };
    const res = await handleRestart(ctx, { batch_id: batchId });
    // Found the auto-scan batch (not 404); rejected on state gate.
    expect(res.status).toBe(409);
    expect((res.body as Record<string, unknown>).apply_state).toBe("pending_evolution");
  });
});
