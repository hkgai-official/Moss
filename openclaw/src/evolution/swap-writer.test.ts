// Unit tests for swap-writer.ts.
//
// Atomic-write semantics matter: the supervisor watches for swap-req.json
// existence and parses the contents. We assert:
//   - basic success: file written with snake_case fields, ts present
//   - no .tmp file left behind after success
//   - empty-input validation rejects bad payloads BEFORE touching disk
//   - missing stateDir rejected (no auto-mkdir)
//   - readSwapRequest round-trips the on-disk shape
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSwapRequest, writeSwapRequest } from "./swap-writer.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-writer-test-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("writeSwapRequest happy path", () => {
  it("writes snake_case JSON with ts and returns the path", () => {
    const before = Date.now();
    const p = writeSwapRequest(stateDir, {
      targetImage: "openclaw:v2.5-iter3",
      previousImage: "openclaw:v2.5-baseline",
      triggerId: "t-uuid-1",
      batchId: "batch-1",
    });
    const after = Date.now();
    expect(p).toBe(path.join(stateDir, "swap-req.json"));
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed.target_image).toBe("openclaw:v2.5-iter3");
    expect(parsed.previous_image).toBe("openclaw:v2.5-baseline");
    expect(parsed.trigger_id).toBe("t-uuid-1");
    expect(parsed.batch_id).toBe("batch-1");
    expect(parsed.ts).toBeGreaterThanOrEqual(before);
    expect(parsed.ts).toBeLessThanOrEqual(after);
  });

  it("does NOT leave a .tmp file behind", () => {
    writeSwapRequest(stateDir, {
      targetImage: "x:1",
      previousImage: "x:0",
      triggerId: "t-1",
      batchId: "b-1",
    });
    expect(fs.existsSync(path.join(stateDir, "swap-req.json.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "swap-req.json"))).toBe(true);
  });

  it("trims whitespace from input fields before writing", () => {
    writeSwapRequest(stateDir, {
      targetImage: "  openclaw:new  ",
      previousImage: "openclaw:old\n",
      triggerId: "  t-1\t",
      batchId: "  b-2  ",
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "swap-req.json"), "utf8"));
    expect(parsed.target_image).toBe("openclaw:new");
    expect(parsed.previous_image).toBe("openclaw:old");
    expect(parsed.trigger_id).toBe("t-1");
    expect(parsed.batch_id).toBe("b-2");
  });

  it("overwrites a stale swap-req.json (subsequent triggers)", () => {
    writeSwapRequest(stateDir, {
      targetImage: "old:image",
      previousImage: "old-prev",
      triggerId: "t-old",
      batchId: "b-old",
    });
    writeSwapRequest(stateDir, {
      targetImage: "new:image",
      previousImage: "new-prev",
      triggerId: "t-new",
      batchId: "b-new",
    });
    const parsed = readSwapRequest(stateDir);
    expect(parsed?.trigger_id).toBe("t-new");
    expect(parsed?.target_image).toBe("new:image");
    expect(parsed?.batch_id).toBe("b-new");
  });

  it("includes batch_id in the on-disk JSON", () => {
    writeSwapRequest(stateDir, {
      targetImage: "img:new",
      previousImage: "img:old",
      triggerId: "t-1",
      batchId: "batch-2",
    });
    const got = readSwapRequest(stateDir);
    expect(got).not.toBeNull();
    expect(got!.batch_id).toBe("batch-2");
    expect(got!.target_image).toBe("img:new");
  });
});

describe("writeSwapRequest input validation", () => {
  it("rejects empty targetImage", () => {
    expect(() =>
      writeSwapRequest(stateDir, { targetImage: "", previousImage: "p", triggerId: "t", batchId: "b" }),
    ).toThrow(/targetImage is required/);
  });

  it("rejects whitespace-only previousImage", () => {
    expect(() =>
      writeSwapRequest(stateDir, { targetImage: "x", previousImage: "  ", triggerId: "t", batchId: "b" }),
    ).toThrow(/previousImage is required/);
  });

  it("rejects empty triggerId", () => {
    expect(() =>
      writeSwapRequest(stateDir, { targetImage: "x", previousImage: "p", triggerId: "", batchId: "b" }),
    ).toThrow(/triggerId is required/);
  });

  it("rejects empty batchId", () => {
    expect(() =>
      writeSwapRequest(stateDir, { targetImage: "x", previousImage: "p", triggerId: "t", batchId: "" }),
    ).toThrow(/batchId is required/);
  });

  it("rejects missing stateDir (does NOT auto-create)", () => {
    expect(() =>
      writeSwapRequest(path.join(stateDir, "no-such"), {
        targetImage: "x",
        previousImage: "p",
        triggerId: "t",
        batchId: "b",
      }),
    ).toThrow(/stateDir does not exist/);
  });

  it("rejected inputs do NOT touch disk", () => {
    try {
      writeSwapRequest(stateDir, { targetImage: "", previousImage: "p", triggerId: "t", batchId: "b" });
    } catch {
      // expected
    }
    expect(fs.existsSync(path.join(stateDir, "swap-req.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "swap-req.json.tmp"))).toBe(false);
  });
});

describe("readSwapRequest", () => {
  it("returns null when no swap-req exists", () => {
    expect(readSwapRequest(stateDir)).toBeNull();
  });

  it("round-trips written content", () => {
    writeSwapRequest(stateDir, {
      targetImage: "openclaw:rt",
      previousImage: "openclaw:rt-prev",
      triggerId: "t-rt",
      batchId: "b-rt",
    });
    const r = readSwapRequest(stateDir);
    expect(r).not.toBeNull();
    expect(r?.target_image).toBe("openclaw:rt");
    expect(r?.previous_image).toBe("openclaw:rt-prev");
    expect(r?.trigger_id).toBe("t-rt");
    expect(r?.batch_id).toBe("b-rt");
  });
});
