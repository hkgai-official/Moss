// src/evolution/index.ts
//
// Module entry for the evolution subsystem. Slice 4 wires the real 9-stage
// state machine. Slice 5 calls `startEvolutionService` from the OpenClaw
// boot sequence, then `triggerEvolutionLoop` from the `/evolve` slash command.

export {
  startEvolutionService,
  triggerEvolutionLoop,
  getServiceStatus,
  validateBootEnv,
  EvolutionBusyError,
  EvolutionNotReadyError,
  type ServiceDeps,
  type ServiceHandle,
  type TriggerRequest,
  type RunOutcome,
} from "./loop.js";
