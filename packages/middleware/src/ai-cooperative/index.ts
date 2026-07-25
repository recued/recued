/** D-145 PB5 — AI-cooperative substrate barrel.
 *
 *  Pure helpers used by the orchestrator policy + the single-stage
 *  synthesis composer + PB13 Dry Run wrapper to:
 *    - drive the visible multi-turn AI ↔ Recued loop with per-round
 *      Transparency Stream emission (`multi-turn-loop.ts`)
 *    - enforce `fixed_slots` invariant on alternatives
 *      (`enforce-fixed-slots.ts`)
 *    - process kernel-ingredient `ActionResult<T>` through the gate +
 *      empty-alternatives passthrough (`process-action-result.ts`)
 *
 *  Spec: § B.6. */

export {
  enforceFixedSlots,
  type EnforceFixedSlotsResult,
} from './enforce-fixed-slots.js';

export {
  processActionResult,
  buildFixedSlotDriftEvent,
  FIXED_SLOT_DRIFT_EVENT_KIND,
  type ProcessActionResultOutput,
} from './process-action-result.js';

export {
  runMultiTurnLoop,
  resolveMaxRounds,
  buildMultiTurnRoundStartedEvent,
  buildMultiTurnRoundCompletedEvent,
  buildMultiTurnLoopTerminatedEvent,
  MULTI_TURN_ROUND_STARTED_KIND,
  MULTI_TURN_ROUND_COMPLETED_KIND,
  MULTI_TURN_LOOP_TERMINATED_KIND,
  type MultiTurnRoundOutcome,
  type MultiTurnRoundBody,
  type RunMultiTurnLoopInput,
  type RunMultiTurnLoopResult,
} from './multi-turn-loop.js';
