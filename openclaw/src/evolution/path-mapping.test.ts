import { beforeAll, describe, expect, it } from "vitest";
import { expandHomePath, pathToContainer, pathToHost } from "./path-mapping.js";

describe("path-mapping", () => {
  beforeAll(() => {
    process.env.MOSS_DATA_DIR = "/host/data";
    process.env.MOSS_OPENCLAW_REPO_DIR = "/host/repo";
  });

  it("translates ~/.openclaw container path to host", () => {
    expect(pathToHost("/home/node/.openclaw/evo-loop-state/current/manifest.json")).toBe(
      "/host/data/evo-loop-state/current/manifest.json",
    );
  });

  it("translates /app container path to host", () => {
    expect(pathToHost("/app/src/evolution/loop.ts")).toBe("/host/repo/src/evolution/loop.ts");
  });

  it("expandHomePath expands ~/x to container abs", () => {
    expect(expandHomePath("~/foo/bar")).toBe("/home/node/.openclaw/foo/bar");
  });

  it("resolves relative paths against moss root (HOST_REPO_DIR/..)", () => {
    process.env.MOSS_OPENCLAW_REPO_DIR = "/host/repo/openclaw";
    expect(pathToHost("benchmark/x/y.yaml")).toBe("/host/repo/benchmark/x/y.yaml");
  });

  it("maps /benchmark to moss-root/benchmark", () => {
    process.env.MOSS_OPENCLAW_REPO_DIR = "/host/repo/openclaw";
    expect(pathToHost("/benchmark/claw-eval/manifests/x.yaml")).toBe(
      "/host/repo/benchmark/claw-eval/manifests/x.yaml",
    );
  });
});

describe("pathToContainer (reverse mapping for daemon-returned host paths)", () => {
  beforeAll(() => {
    process.env.MOSS_DATA_DIR = "/host/data";
    process.env.MOSS_OPENCLAW_REPO_DIR = "/host/repo/openclaw";
  });

  it("translates HOST_DATA_DIR prefix back to /home/node/.openclaw", () => {
    expect(
      pathToContainer("/host/data/evo-loop-state/current/iteration_1/grade_summary_stage_a.json"),
    ).toBe("/home/node/.openclaw/evo-loop-state/current/iteration_1/grade_summary_stage_a.json");
  });

  it("translates HOST_REPO_DIR prefix back to /app", () => {
    expect(pathToContainer("/host/repo/openclaw/src/evolution/loop.ts")).toBe(
      "/app/src/evolution/loop.ts",
    );
  });

  it("translates moss-root/benchmark back to /benchmark", () => {
    expect(pathToContainer("/host/repo/benchmark/claw-eval/manifests/x.yaml")).toBe(
      "/benchmark/claw-eval/manifests/x.yaml",
    );
  });

  it("leaves unmappable paths untouched", () => {
    expect(pathToContainer("/var/log/syslog")).toBe("/var/log/syslog");
  });

  it("is the left-inverse of pathToHost for HOST_DATA paths", () => {
    const containerPath = "/home/node/.openclaw/evo-loop-state/current/manifest.json";
    expect(pathToContainer(pathToHost(containerPath))).toBe(containerPath);
  });
});
