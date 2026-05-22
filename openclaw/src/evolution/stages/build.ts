// src/evolution/stages/build.ts
//
// Stage 6: docker build new image + run build_smoke (~3 min image-layer sanity
// check). Both go via host daemon RPC. Returns the per-iter image tag and
// pass/fail flags.
import { buildSmoke, dockerBuild } from "../docker-rpc.js";
import type { EvolutionLog } from "../evolution-log.js";
import { pathToHost } from "../path-mapping.js";

export interface BuildStageInput {
  iter: number;
  evolutionLog: EvolutionLog;
  /** Source tree to build the image from (container abs, will be path-mapped). */
  contextContainerDir: string;
  /** Tag to apply, e.g. "openclaw:v2.5-iter3" */
  imageTag: string;
}

export interface BuildStageResult {
  imageTag: string;
  imageId: string | null;
  buildOk: boolean;
  buildSmokeOk: boolean;
  smokeFailedStep: string | null;
  smokeLogTail: string;
}

export async function runBuildStage(input: BuildStageInput): Promise<BuildStageResult> {
  input.evolutionLog.append({
    iter: input.iter,
    stage: "build",
    event: "stage_start",
    data: { imageTag: input.imageTag },
  });

  let imageId: string | null = null;
  let buildOk = false;
  try {
    const r = await dockerBuild({
      tag: input.imageTag,
      contextDir: pathToHost(input.contextContainerDir),
    });
    imageId = r.imageId;
    buildOk = !!r.imageId;
  } catch (e) {
    input.evolutionLog.append({
      iter: input.iter,
      stage: "build",
      event: "error",
      data: { phase: "docker-build", message: String(e) },
    });
    return {
      imageTag: input.imageTag,
      imageId: null,
      buildOk: false,
      buildSmokeOk: false,
      smokeFailedStep: "docker-build",
      smokeLogTail: String(e),
    };
  }

  let buildSmokeOk = false;
  let smokeFailedStep: string | null = null;
  let smokeLogTail = "";
  try {
    const r = await buildSmoke({ imageTag: input.imageTag });
    buildSmokeOk = r.ok;
    smokeFailedStep = r.failedStep;
    smokeLogTail = r.logTail;
  } catch (e) {
    smokeFailedStep = "build-smoke";
    smokeLogTail = String(e);
    input.evolutionLog.append({
      iter: input.iter,
      stage: "build",
      event: "error",
      data: { phase: "build-smoke", message: String(e) },
    });
  }

  input.evolutionLog.append({
    iter: input.iter,
    stage: "build",
    event: "stage_end",
    data: { buildOk, buildSmokeOk, smokeFailedStep },
  });

  return {
    imageTag: input.imageTag,
    imageId,
    buildOk,
    buildSmokeOk,
    smokeFailedStep,
    smokeLogTail,
  };
}
