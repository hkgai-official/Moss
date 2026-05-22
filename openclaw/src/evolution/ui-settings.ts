import * as fs from "node:fs";
import * as path from "node:path";

export type EvolutionDepth = "shallow" | "standard" | "deep";

export interface UiSettings {
  user_mode: {
    trigger_mode: "manual" | "auto";
    threshold: number;
    depth: EvolutionDepth;
  };
  demo_mode: {
    depth: EvolutionDepth;
  };
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  user_mode: { trigger_mode: "manual", threshold: 4, depth: "standard" },
  demo_mode: { depth: "shallow" },
};

const REL = "evo-loop-state/ui-settings.json";

// Internal recursive merge helper. Uses `any` for traversal ergonomics —
// the public boundary (readUiSettings / writeUiSettings) is strictly typed
// against UiSettings, so untyped recursion is contained to this function.
function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b)) {return b ?? a;}
  if (typeof a !== "object" || typeof b !== "object" || a == null || b == null) {return b ?? a;}
  const out: any = { ...a };
  for (const k of Object.keys(b)) {out[k] = deepMerge(a[k], b[k]);}
  return out;
}

// Per-field schema validation. Coerces or falls back to defaults for any
// missing/invalid field so corrupt or hostile ui-settings.json cannot leak
// non-numeric/non-enum values into downstream auto-trigger comparisons.
function validateUiSettings(s: unknown): UiSettings {
  const d = DEFAULT_UI_SETTINGS;
  if (s == null || typeof s !== "object") {return structuredClone(d);}
  const r = s as Record<string, unknown>;
  const user =
    typeof r.user_mode === "object" && r.user_mode !== null
      ? (r.user_mode as Record<string, unknown>)
      : {};
  const demo =
    typeof r.demo_mode === "object" && r.demo_mode !== null
      ? (r.demo_mode as Record<string, unknown>)
      : {};
  const isDepth = (v: unknown): v is EvolutionDepth =>
    v === "shallow" || v === "standard" || v === "deep";
  const isTrigger = (v: unknown): v is "manual" | "auto" => v === "manual" || v === "auto";
  return {
    user_mode: {
      trigger_mode: isTrigger(user.trigger_mode) ? user.trigger_mode : d.user_mode.trigger_mode,
      threshold:
        typeof user.threshold === "number" && Number.isInteger(user.threshold) && user.threshold > 0
          ? user.threshold
          : d.user_mode.threshold,
      depth: isDepth(user.depth) ? user.depth : d.user_mode.depth,
    },
    demo_mode: {
      depth: isDepth(demo.depth) ? demo.depth : d.demo_mode.depth,
    },
  };
}

export function readUiSettings(dataDir: string): UiSettings {
  const p = path.join(dataDir, REL);
  if (!fs.existsSync(p)) {return structuredClone(DEFAULT_UI_SETTINGS);}
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const merged = deepMerge(DEFAULT_UI_SETTINGS, raw);
    return validateUiSettings(merged);
  } catch {
    return structuredClone(DEFAULT_UI_SETTINGS);
  }
}

export function writeUiSettings(dataDir: string, patch: Partial<UiSettings>): UiSettings {
  const merged = deepMerge(readUiSettings(dataDir), patch);
  const validated = validateUiSettings(merged);
  const p = path.join(dataDir, REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write: write to a unique tmp path, then rename. rename(2) is
  // atomic on POSIX, so concurrent POSTs cannot leave a truncated file.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2));
  fs.renameSync(tmp, p);
  return validated;
}
