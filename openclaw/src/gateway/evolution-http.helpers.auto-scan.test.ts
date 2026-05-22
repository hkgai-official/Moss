// evolution-http.helpers.auto-scan.test.ts
//
// Tests that the evolution HTTP handlers (handleTrigger, handleStop,
// handleBatchesList, findBatchByManifestId path via handleApply) fall back to
// the auto-scan batch directory when no legacy flag-batch exists.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("evolution HTTP handlers — auto-scan batch fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-http-autoscan-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Creates a minimal sealed auto-scan batch fixture at
   * <dataDir>/evo-loop-state/auto-scan-batches/<batchId>/_batch.json.
   * The auto-scan schema uses "id" (not "batch_id") as the primary key.
   */
  function setupAutoScanBatch(dataDir: string, batchId: string): void {
    const autoDir = path.join(
      dataDir,
      "evo-loop-state",
      "auto-scan-batches",
      batchId,
    );
    fs.mkdirSync(autoDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoDir, "_batch.json"),
      JSON.stringify(
        {
          id: batchId,
          // Also expose as batch_id so readFlagBatchWithDefaults can pick it up
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
  }

  // ---------------------------------------------------------------------------
  // handleTrigger
  // ---------------------------------------------------------------------------

  it("handleTrigger finds an auto-scan batch when no legacy flag-batch exists", async () => {
    const { handleTrigger } = await import("./evolution-http.helpers.js");
    const batchId = "auto-batch-1730000000000";
    setupAutoScanBatch(tmpDir, batchId);
    const ctx = { dataDir: tmpDir } as any;

    const res = await handleTrigger(ctx, { batch_id: batchId });
    // Not 404 — the batch was found. It may 409/503 because no real loop is
    // running, but "batch not found" must not occur.
    expect(res.status).not.toBe(404);
  });

  it("handleTrigger returns 404 when batch exists in neither location", async () => {
    const { handleTrigger } = await import("./evolution-http.helpers.js");
    const ctx = { dataDir: tmpDir } as any;
    const res = await handleTrigger(ctx, { batch_id: "nonexistent-batch" });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Bug 1: handleTrigger should auto-seal an open batch with flag_count > 0
  // before triggering. Spec docs/specs/2026-05-19-evolution-control-surface.md
  // §2.3 says the user may trigger any non-empty batch (including one that is
  // still open); the handler must seal it (open → pending_evolution, sealed →
  // true) instead of returning 409 "batch not pending_evolution".
  // ---------------------------------------------------------------------------

  it("handleTrigger auto-seals an open auto-scan batch with flag_count > 0 then triggers", async () => {
    const { handleTrigger } = await import("./evolution-http.helpers.js");
    const batchId = "auto-batch-open-1730000001000";
    const autoDir = path.join(tmpDir, "evo-loop-state", "auto-scan-batches", batchId);
    fs.mkdirSync(autoDir, { recursive: true });
    const bp = path.join(autoDir, "_batch.json");
    fs.writeFileSync(
      bp,
      JSON.stringify(
        {
          id: batchId,
          batch_id: batchId,
          created_at: 1730000001000,
          sealed: false,
          size: 2,
          flag_count: 2,
          apply_state: "open",
          depth: "standard",
        },
        null,
        2,
      ),
    );

    const ctx = { dataDir: tmpDir } as any;
    const res = await handleTrigger(ctx, { batch_id: batchId });

    // Must not 409 "batch not pending_evolution" — auto-seal should have run.
    // It may 503/500 because triggerForBatch can't actually spawn in a unit
    // test, but the gate must not block this case.
    expect(
      !(res.status === 409 && (res.body as any)?.error === "batch not pending_evolution"),
    ).toBe(true);

    // The on-disk batch should be sealed (apply_state moved off "open").
    const updated = JSON.parse(fs.readFileSync(bp, "utf8"));
    expect(updated.apply_state).not.toBe("open");
    expect(updated.sealed).toBe(true);
  });

  it("handleTrigger rejects an open batch with flag_count == 0 (no auto-seal)", async () => {
    const { handleTrigger } = await import("./evolution-http.helpers.js");
    const batchId = "auto-batch-empty-1730000002000";
    const autoDir = path.join(tmpDir, "evo-loop-state", "auto-scan-batches", batchId);
    fs.mkdirSync(autoDir, { recursive: true });
    const bp = path.join(autoDir, "_batch.json");
    fs.writeFileSync(
      bp,
      JSON.stringify(
        {
          id: batchId,
          batch_id: batchId,
          created_at: 1730000002000,
          sealed: false,
          size: 0,
          flag_count: 0,
          apply_state: "open",
          depth: "standard",
        },
        null,
        2,
      ),
    );

    const ctx = { dataDir: tmpDir } as any;
    const res = await handleTrigger(ctx, { batch_id: batchId });
    // Empty batch — should still be rejected (no point evolving on nothing).
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The on-disk batch must remain "open" (no spurious seal).
    const updated = JSON.parse(fs.readFileSync(bp, "utf8"));
    expect(updated.apply_state).toBe("open");
    expect(updated.sealed).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // handleStop
  // ---------------------------------------------------------------------------

  it("handleStop flips apply_state to 'failed' for an auto-scan batch", async () => {
    const { handleStop } = await import("./evolution-http.helpers.js");
    const batchId = "auto-batch-1730000000001";
    setupAutoScanBatch(tmpDir, batchId);

    // Override apply_state to "running" so the flip condition triggers.
    const autoDir = path.join(
      tmpDir,
      "evo-loop-state",
      "auto-scan-batches",
      batchId,
    );
    const bp = path.join(autoDir, "_batch.json");
    const raw = JSON.parse(fs.readFileSync(bp, "utf8"));
    raw.apply_state = "running";
    fs.writeFileSync(bp, JSON.stringify(raw, null, 2));

    const ctx = { dataDir: tmpDir } as any;
    const res = await handleStop(ctx, { batch_id: batchId });
    expect(res.status).toBe(200);

    // Verify the on-disk batch was flipped to "failed".
    const updated = JSON.parse(fs.readFileSync(bp, "utf8"));
    expect(updated.apply_state).toBe("failed");
  });

  // ---------------------------------------------------------------------------
  // handleBatchesList
  // ---------------------------------------------------------------------------

  it("handleBatchesList returns auto-scan batches in the listing", async () => {
    const { handleBatchesList } = await import("./evolution-http.helpers.js");
    const batchId = "auto-batch-1730000000002";
    setupAutoScanBatch(tmpDir, batchId);

    const ctx = { dataDir: tmpDir } as any;
    const res = await handleBatchesList(ctx);
    expect(res.status).toBe(200);

    const batches = res.body as any[];
    const ids = batches.map((b: any) => b.batch_id ?? b.id);
    expect(ids).toContain(batchId);
  });

  it("handleBatchesList merges legacy flag-batches and auto-scan batches", async () => {
    const { handleBatchesList } = await import("./evolution-http.helpers.js");

    // Legacy flag-batch
    const legacyId = "batch-legacy-001";
    const legacyDir = path.join(
      tmpDir,
      "evo-loop-state",
      "flag-batch",
      legacyId,
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "_batch.json"),
      JSON.stringify(
        {
          batch_id: legacyId,
          created_at: 1720000000000,
          status: "current",
          threshold: 4,
          trigger_mode: "manual",
          triggered_at: null,
          triggered_evolution_trigger_id: null,
          flag_count: 3,
          depth: "standard",
          created_by: "cli",
          apply_state: "pending_evolution",
        },
        null,
        2,
      ),
    );

    // Auto-scan batch
    const autoId = "auto-batch-1730000000003";
    setupAutoScanBatch(tmpDir, autoId);

    const ctx = { dataDir: tmpDir } as any;
    const res = await handleBatchesList(ctx);
    expect(res.status).toBe(200);

    const batches = res.body as any[];
    const ids = batches.map((b: any) => b.batch_id ?? b.id);
    expect(ids).toContain(legacyId);
    expect(ids).toContain(autoId);
  });

  it("handleBatchesList returns empty array when neither directory exists", async () => {
    const { handleBatchesList } = await import("./evolution-http.helpers.js");
    const ctx = { dataDir: tmpDir } as any;
    const res = await handleBatchesList(ctx);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
