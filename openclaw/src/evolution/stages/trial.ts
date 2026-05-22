// src/evolution/stages/trial.ts
//
// Stage 7 + Stage 9: dispatch a benchmark run via host daemon RPC. Stage 7
// runs Stage A (training tasks), Stage 9 runs Stage C (validation set).
import { runTrial } from "../docker-rpc.js";
import type { EvolutionLog } from "../evolution-log.js";
import { pathToHost } from "../path-mapping.js";

export interface TrialStageInput {
  iter: number;
  evolutionLog: EvolutionLog;
  imageTag: string;
  manifestContainerPath: string; // container abs path to claweval batch manifest
  iterContainerDir: string; // where grade_summary.json lands
  nTrials: number;
  stage: "a" | "c";
}

export interface TrialStageResult {
  gradeSummaryPath: string; // host abs (returned by RPC)
  nPassed: number;
  nFailed: number;
  meanScore: number;
}

export async function runTrialStage(input: TrialStageInput): Promise<TrialStageResult> {
  input.evolutionLog.append({
    iter: input.iter,
    stage: input.stage === "a" ? "trial_a" : "trial_c",
    event: "stage_start",
    data: { imageTag: input.imageTag, nTrials: input.nTrials },
  });

  const r = await runTrial({
    imageTag: input.imageTag,
    manifestPath: pathToHost(input.manifestContainerPath),
    nTrials: input.nTrials,
    iterDir: pathToHost(input.iterContainerDir),
    stage: input.stage,
  });

  input.evolutionLog.append({
    iter: input.iter,
    stage: input.stage === "a" ? "trial_a" : "trial_c",
    event: "stage_end",
    data: { meanScore: r.meanScore, nPassed: r.nPassed, nFailed: r.nFailed },
  });
  return r;
}
