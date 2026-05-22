// src/evolution/evolution-log.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionLog } from "./evolution-log.js";

describe("EvolutionLog", () => {
  it("appends events as one JSON line each", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "evlog-"));
    const log = new EvolutionLog(path.join(td, "evolution-log.jsonl"));
    log.append({ iter: 1, stage: "locator", event: "stage_start", data: {} });
    log.append({
      iter: 1,
      stage: "locator",
      event: "role_spawned",
      role: "locator",
      data: { addDirs: ["/x"] },
    });
    log.close();
    const lines = fs.readFileSync(path.join(td, "evolution-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const e1 = JSON.parse(lines[0]);
    expect(e1.stage).toBe("locator");
    expect(typeof e1.ts).toBe("number");
  });

  it("creates parent directory if missing", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "evlog-"));
    const nested = path.join(td, "nested", "more", "log.jsonl");
    const log = new EvolutionLog(nested);
    log.append({ iter: 1, stage: "x", event: "stage_start", data: {} });
    log.close();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("close is idempotent", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "evlog-"));
    const log = new EvolutionLog(path.join(td, "x.jsonl"));
    log.append({ iter: 1, stage: "y", event: "stage_end", data: {} });
    log.close();
    log.close();
  });
});
