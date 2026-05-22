// Tests for `validateBootEnv` after its mode-3 refactor: instead of
// fs.existsSync + execFileSync('git rev-parse HEAD') (which can't see the
// host openclaw repo from inside the moss-gateway container), it now
// `await getBaselineCommit()` against the host daemon. See
// docs/specs/2026-05-18-evolution-preflight-rpc.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock docker-rpc.js so we can control what getBaselineCommit returns/throws.
vi.mock("../docker-rpc.js", () => ({
  getBaselineCommit: vi.fn(),
}));

// Import AFTER vi.mock so the SUT picks up the mocked module.
import { validateBootEnv } from "../loop.js";
import { getBaselineCommit } from "../docker-rpc.js";

const HEX40 = "abcdef0123456789abcdef0123456789abcdef01"; // 40 hex chars

describe("validateBootEnv (RPC mode)", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOSS_DATA_DIR = "/host/.moss";
    process.env.MOSS_OPENCLAW_REPO_DIR = "/host/openclaw";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("returns hPre from RPC on success and does not touch fs", async () => {
    vi.mocked(getBaselineCommit).mockResolvedValue({
      hPre: HEX40,
      repoDir: "/host/openclaw",
    });
    const r = await validateBootEnv({});
    expect(r).toEqual({ error: null, hPre: HEX40 });
    expect(vi.mocked(getBaselineCommit)).toHaveBeenCalledTimes(1);
  });

  it("returns an error without calling RPC when MOSS_DATA_DIR is unset", async () => {
    delete process.env.MOSS_DATA_DIR;
    const r = await validateBootEnv({});
    expect(r.hPre).toBeNull();
    expect(r.error).toMatch(/MOSS_DATA_DIR/);
    expect(vi.mocked(getBaselineCommit)).not.toHaveBeenCalled();
  });

  it("surfaces RPC 'not set' error from daemon as bootError", async () => {
    vi.mocked(getBaselineCommit).mockRejectedValue(
      new Error("MOSS_OPENCLAW_REPO_DIR not set"),
    );
    const r = await validateBootEnv({});
    expect(r.hPre).toBeNull();
    expect(r.error).toMatch(/MOSS_OPENCLAW_REPO_DIR not set/);
  });

  it("surfaces RPC 'not a git repo' error from daemon as bootError", async () => {
    vi.mocked(getBaselineCommit).mockRejectedValue(
      new Error("openclaw repo missing or not a git repo at /host/openclaw"),
    );
    const r = await validateBootEnv({});
    expect(r.hPre).toBeNull();
    expect(r.error).toMatch(/not a git repo/);
  });

  it("rejects an obviously invalid hPre returned by RPC (defensive)", async () => {
    vi.mocked(getBaselineCommit).mockResolvedValue({
      hPre: "not-a-real-sha",
      repoDir: "/host/openclaw",
    });
    const r = await validateBootEnv({});
    expect(r.hPre).toBeNull();
    expect(r.error).toMatch(/unexpected value|invalid/i);
  });
});
