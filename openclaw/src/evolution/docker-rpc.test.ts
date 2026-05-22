// Unit tests for the typed-wrapper translation logic in docker-rpc.ts.
//
// Slice 4 had this test launch the real Python host daemon and assert against
// stub responses. After Slice 2/3, the daemon's ops are real (docker shell-out
// + claude fork) and the stub fixtures no longer apply; daemon-against-real
// integration is now covered by `host-daemon/tests/test_stress.py` (pytest).
//
// What remains here: confirm the wire-format adapter (snake_case → camelCase
// + safe coercion) handles well-formed and malformed payloads. We mock
// rpc-client.rpcCall so no daemon, socket, or docker is touched.
import { afterEach, describe, expect, it, vi } from "vitest";

const rpcCallMock =
  vi.fn<
    (
      op: string,
      payload: Record<string, unknown>,
      opts?: unknown,
    ) => Promise<Record<string, unknown>>
  >();

vi.mock("./rpc-client.js", () => ({
  rpcCall: (op: string, payload: Record<string, unknown>, opts?: unknown) =>
    rpcCallMock(op, payload, opts),
}));

import { buildSmoke, dockerBuild, hardResetOpenclaw, runTrial } from "./docker-rpc.js";

afterEach(() => {
  rpcCallMock.mockReset();
});

describe("docker-rpc typed wrappers", () => {
  it("dockerBuild forwards snake_case payload and parses image_id/size_mb", async () => {
    rpcCallMock.mockResolvedValue({ image_id: "sha256:abc", size_mb: 128 });
    const r = await dockerBuild({ tag: "test:tag", contextDir: "/tmp/ctx" });
    expect(rpcCallMock).toHaveBeenCalledWith(
      "docker-build",
      { tag: "test:tag", context_dir: "/tmp/ctx" },
      undefined,
    );
    expect(r).toEqual({ imageId: "sha256:abc", sizeMb: 128 });
  });

  it("dockerBuild coerces missing/wrong-type fields safely", async () => {
    rpcCallMock.mockResolvedValue({});
    const r = await dockerBuild({ tag: "x", contextDir: "/c" });
    expect(r).toEqual({ imageId: "", sizeMb: 0 });
  });

  it("runTrial forwards snake_case payload and parses summary fields", async () => {
    rpcCallMock.mockResolvedValue({
      grade_summary_path: "/iter/grade_summary.json",
      n_passed: 9,
      n_failed: 3,
      mean_score: 0.74,
    });
    const r = await runTrial({
      imageTag: "openclaw:iter3",
      manifestPath: "/host/manifest.yaml",
      nTrials: 3,
      iterDir: "/host/iter",
      stage: "a",
    });
    expect(rpcCallMock).toHaveBeenCalledWith(
      "run-trial",
      {
        image_tag: "openclaw:iter3",
        manifest_path: "/host/manifest.yaml",
        n_trials: 3,
        iter_dir: "/host/iter",
        stage: "a",
      },
      undefined,
    );
    expect(r).toEqual({
      gradeSummaryPath: "/iter/grade_summary.json",
      nPassed: 9,
      nFailed: 3,
      meanScore: 0.74,
    });
  });

  it("buildSmoke ok=true result has null failed_step + string log_tail", async () => {
    rpcCallMock.mockResolvedValue({ ok: true, failed_step: null, log_tail: "all green\n" });
    const r = await buildSmoke({ imageTag: "test:tag" });
    expect(rpcCallMock).toHaveBeenCalledWith("build-smoke", { image_tag: "test:tag" }, undefined);
    expect(r).toEqual({ ok: true, failedStep: null, logTail: "all green\n" });
  });

  it("buildSmoke ok=false carries failed_step string through unchanged", async () => {
    rpcCallMock.mockResolvedValue({
      ok: false,
      failed_step: "tsgo",
      log_tail: "TS2304: cannot find name 'foo'",
    });
    const r = await buildSmoke({ imageTag: "x" });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("tsgo");
    expect(r.logTail).toBe("TS2304: cannot find name 'foo'");
  });

  it("hardResetOpenclaw forwards h_pre payload + parses ok", async () => {
    rpcCallMock.mockResolvedValue({ ok: true });
    const r = await hardResetOpenclaw({ hPre: "abc123" });
    expect(rpcCallMock).toHaveBeenCalledWith("hard-reset-openclaw", { h_pre: "abc123" }, undefined);
    expect(r).toEqual({ ok: true });
  });
});
