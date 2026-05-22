import type { NormalizedUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(safe));
}

export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const providers = params.config?.models?.providers ?? {};
  const entry = providers[provider]?.models?.find((item) => item.id === model);
  return entry?.cost;
}

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function estimateUsageCost(params: {
  usage?: NormalizedUsage | UsageTotals | null;
  cost?: ModelCostConfig;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  if (!usage || !cost) {
    return undefined;
  }
  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);
  const total =
    input * cost.input +
    output * cost.output +
    cacheRead * cost.cacheRead +
    cacheWrite * cost.cacheWrite;
  if (!Number.isFinite(total)) {
    return undefined;
  }
  return total / 1_000_000;
}

// ---------------------------------------------------------------------------
// resolveCostForActiveModel — used by evolution stage-helper to compute USD
// from token counts when a coding-agent runner (e.g. Codex) doesn't report
// cost natively. Memoizes the OpenClawConfig so we read disk at most once
// per process; tests inject via __setConfigForTest().
//
// See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §6.2.
// ---------------------------------------------------------------------------

let _configMemo: OpenClawConfig | null = null;

function _config(): OpenClawConfig {
  if (!_configMemo) {
    _configMemo = loadConfig();
  }
  return _configMemo;
}

/** TEST-ONLY seam: inject a mock config (or null to clear the memo). */
export function __setConfigForTest(cfg: OpenClawConfig | null): void {
  _configMemo = cfg;
}

/** Look up per-(provider, model) cost config from openclaw.json.
 *  Returns undefined if no pricing entry exists (caller treats as "skip USD"). */
export function resolveCostForActiveModel(
  provider: string,
  model: string,
): ModelCostConfig | undefined {
  return resolveModelCostConfig({ provider, model, config: _config() });
}
