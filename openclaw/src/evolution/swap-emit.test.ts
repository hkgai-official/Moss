// src/evolution/swap-emit.test.ts
//
// Tests for the F1 fix — emitting swap-req.json from loop.ts when iter
// CONVERGED. The actual emit happens inline in runEvolutionLoop; this file
// covers the two helpers (readLastGoodImage + writeSwapRequest interplay)
// because mocking the full loop is overkill.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLastGoodImage } from "./loop.js";
import { readSwapRequest, writeSwapRequest } from "./swap-writer.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-emit-test-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("F1: emitSwapRequest plumbing", () => {
  it("readLastGoodImage returns null when file missing → caller falls back to startingImage", () => {
    expect(readLastGoodImage(stateDir)).toBeNull();
  });

  it("readLastGoodImage returns trimmed value when present", () => {
    fs.writeFileSync(path.join(stateDir, "last-good-image.txt"), "  moss:v2.5-iter3\n");
    expect(readLastGoodImage(stateDir)).toBe("moss:v2.5-iter3");
  });

  it("readLastGoodImage returns null on empty file (not empty string)", () => {
    fs.writeFileSync(path.join(stateDir, "last-good-image.txt"), "   ");
    expect(readLastGoodImage(stateDir)).toBeNull();
  });

  it("writeSwapRequest produces a supervisor-readable swap-req.json", () => {
    writeSwapRequest(stateDir, {
      targetImage: "moss:v2.6-iter1",
      previousImage: "moss:base",
      triggerId: "trig-1",
      batchId: "b-emit-1",
    });
    const parsed = readSwapRequest(stateDir);
    expect(parsed?.target_image).toBe("moss:v2.6-iter1");
    expect(parsed?.previous_image).toBe("moss:base");
    expect(parsed?.trigger_id).toBe("trig-1");
    expect(parsed?.batch_id).toBe("b-emit-1");
    expect(parsed?.ts).toBeGreaterThan(0);
  });

  it("composes readLastGoodImage + writeSwapRequest with last-good fallback", () => {
    fs.writeFileSync(path.join(stateDir, "last-good-image.txt"), "moss:v2.5-iter4");
    const previous = readLastGoodImage(stateDir) ?? "moss:base";
    writeSwapRequest(stateDir, {
      targetImage: "moss:v2.6-iter5",
      previousImage: previous,
      triggerId: "trig-2",
      batchId: "b-emit-2",
    });
    expect(readSwapRequest(stateDir)?.previous_image).toBe("moss:v2.5-iter4");
  });
});
