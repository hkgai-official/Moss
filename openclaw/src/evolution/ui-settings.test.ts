import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  readUiSettings,
  writeUiSettings,
  DEFAULT_UI_SETTINGS,
  type UiSettings,
} from "./ui-settings.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moss-uis-"));
});

describe("ui-settings", () => {
  it("returns DEFAULT when file missing", () => {
    expect(readUiSettings(tmp)).toEqual(DEFAULT_UI_SETTINGS);
  });
  it("round-trips a write", () => {
    const s: UiSettings = {
      user_mode: { trigger_mode: "auto", threshold: 7, depth: "deep" },
      demo_mode: { depth: "standard" },
    };
    writeUiSettings(tmp, s);
    expect(readUiSettings(tmp)).toEqual(s);
  });
  it("merges partial updates", () => {
    writeUiSettings(tmp, { user_mode: { trigger_mode: "auto" } } as any);
    expect(readUiSettings(tmp).user_mode.trigger_mode).toBe("auto");
    expect(readUiSettings(tmp).user_mode.threshold).toBe(4); // default kept
  });
  it("coerces invalid threshold to default", () => {
    fs.mkdirSync(path.join(tmp, "evo-loop-state"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "evo-loop-state/ui-settings.json"),
      JSON.stringify({ user_mode: { threshold: "garbage" } }),
    );
    expect(readUiSettings(tmp).user_mode.threshold).toBe(4);
  });
  it("coerces invalid trigger_mode to default", () => {
    fs.mkdirSync(path.join(tmp, "evo-loop-state"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "evo-loop-state/ui-settings.json"),
      JSON.stringify({ user_mode: { trigger_mode: "hacked" } }),
    );
    expect(readUiSettings(tmp).user_mode.trigger_mode).toBe("manual");
  });
  it("coerces invalid depth to default", () => {
    fs.mkdirSync(path.join(tmp, "evo-loop-state"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "evo-loop-state/ui-settings.json"),
      JSON.stringify({ demo_mode: { depth: "hyper" } }),
    );
    expect(readUiSettings(tmp).demo_mode.depth).toBe("shallow");
  });
  it("atomic write does not leave .tmp file behind on success", () => {
    writeUiSettings(tmp, { user_mode: { trigger_mode: "auto" } } as any);
    const files = fs.readdirSync(path.join(tmp, "evo-loop-state"));
    expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
