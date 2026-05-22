// src/evolution/simulate-trigger.ts
//
// v2.6 user-mode evolution CLI entry. Run inside moss-gateway:
//
//   bun /app/src/evolution/simulate-trigger.ts <flag_batch_id> [--depth=...]
//
// Expects $MOSS_DATA_DIR/evo-loop-state/flag-batch/<flag_batch_id>/
// to already exist with one snapshot per flagged task. To seed that dir from
// a claweval batch's baseline trial transcripts (for task #21 simulation),
// (internal: previously scripts/simulate-user-mode.sh would build a trace-to-flag-batch
// converter then invokes this entry.
import { startEvolutionService, triggerEvolutionLoop } from "./loop.js";
import { UserMode } from "./modes/user-mode.js";
import type { EvolutionDepth } from "./state.js";

function parseDepth(args: string[]): EvolutionDepth {
  for (const a of args) {
    const m = a.match(/^--depth=(shallow|standard|deep)$/);
    if (m) return m[1] as EvolutionDepth;
  }
  return "standard";
}

function parseMaxIter(args: string[]): number | undefined {
  for (const a of args) {
    const m = a.match(/^--max-iter=(\d+)$/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const batchId = positional[0];
  if (!batchId) {
    console.error(
      "usage: bun simulate-trigger.ts <flag_batch_id> [--depth=shallow|standard|deep] [--max-iter=N]",
    );
    process.exit(2);
  }
  const depth = parseDepth(args);
  const overrideMaxIter = parseMaxIter(args);

  console.log(`[simulate-trigger] starting evolution service`);
  const service = await startEvolutionService({});
  if (service.bootError) {
    console.error(`[simulate-trigger] boot error: ${service.bootError}`);
    process.exit(3);
  }

  console.log(`[simulate-trigger] triggering user-mode evolution: batch=${batchId} depth=${depth}`);
  try {
    const outcome = await triggerEvolutionLoop({
      // EvolutionMode strategy — UserMode reads flag-batch/<batchId>/ from disk.
      mode: new UserMode(batchId),
      depth,
      flagBatchId: batchId,

      // user mode doesn't consume a claweval manifest; surface fields populated
      // for compatibility with the v2.5-era TriggerRequest contract.
      inputSetId: `user-mode-${batchId}`,
      inputManifestPath: "",
      validationSet: "",
      startingImage: process.env.MOSS_IMAGE ?? "moss:baseline",
      startingBranch: "master",
      startingCommit: process.env.MOSS_H_PRE ?? null,
      triggerSource: "manual",
      triggeredBy: "simulate-trigger.ts",
      stageATasks: [],
      overrideMaxIter,
    });
    console.log(`[simulate-trigger] DONE: ${JSON.stringify(outcome, null, 2)}`);
    process.exit(0);
  } catch (e) {
    console.error(`[simulate-trigger] FAILED:`, e);
    process.exit(1);
  } finally {
    await service.stop();
  }
}

void main();
