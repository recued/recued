/** The in-process derivation of a resume request from a pause.
 *
 *  The HOST never does this directly: `execute-handler` persists the pause as a
 *  `Checkpoint` and `preflight-resumer` rebuilds `ctx.resumeFrom` from that row
 *  — carrying the gated step, the step-state snapshot, the foreach item
 *  progress, the chunked egress bound, and the approved identity triple. A
 *  harness that drives the engine in-process skips that round trip and used to
 *  hand-build the same object at seven sites, each carrying only the fields its
 *  author knew about. When a pause inside a `foreach` started carrying item
 *  progress, every one of them dropped it, and the resumed foreach refused
 *  (`checkpoint_foreach_progress_missing`) — a suite failure that read exactly
 *  like a product defect.
 *
 *  ⛔ ONE DERIVATION, CALLED. A field the pause carries and the resume needs is
 *  added here once; a builder that re-implements this list drifts the day the
 *  pause grows. `step_state` rides along because the host seeds `stores.step`
 *  from it before resuming (the engine does not). */
import type { ForeachCheckpointProgress, PreflightApprovedTarget } from '@recued/contracts';

import type { ExecutionContext } from './types.js';

/** `ctx.resumeFrom` plus the snapshot the caller seeds `stores.step` from. */
export type InProcessResumeFrom = NonNullable<ExecutionContext['resumeFrom']> & {
  readonly step_state: Record<string, unknown>;
};

/** The subset of a pause (`awaiting_approval` / `awaiting_peer`) the resume
 *  reads. Structural, so both pause shapes and a persisted checkpoint fit. */
export interface PauseToResume {
  readonly gated_step_id: string;
  readonly step_state: Record<string, unknown>;
  readonly execution_phase?: 'trigger' | 'prefetch' | 'sequential';
  readonly trigger_state?: Record<string, unknown>;
  readonly prefetch_completed?: string[];
  readonly foreach_progress?: ForeachCheckpointProgress;
  readonly egress_bound?: { readonly requests: number; readonly total_bytes: number };
  readonly ingredient_slug?: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
}

export const resumeFromApproval = (pause: PauseToResume): InProcessResumeFrom => {
  // The identity the owner approved. Every field the pause named is carried —
  // including an EMPTY `connection_name`: a connectionless records op carries
  // `''`, and the gate compares it, so dropping it re-asks forever. An empty
  // triple (a legacy bare pause) is kept as `{}`: the catalog gate treats that
  // as unapproved and asks again, which is the fail-closed reading.
  const approved_target: PreflightApprovedTarget = {
    ...(pause.ingredient_slug !== undefined ? { ingredient_slug: pause.ingredient_slug } : {}),
    ...(pause.operation_id !== undefined ? { operation_id: pause.operation_id } : {}),
    ...(pause.connection_name !== undefined ? { connection_name: pause.connection_name } : {}),
  };
  return {
    gated_step_id: pause.gated_step_id,
    step_state: structuredClone(pause.step_state),
    ...(pause.execution_phase ? { execution_phase: pause.execution_phase } : {}),
    ...(pause.trigger_state ? { trigger_state: structuredClone(pause.trigger_state) } : {}),
    ...(pause.prefetch_completed ? { prefetch_completed: [...pause.prefetch_completed] } : {}),
    ...(pause.foreach_progress !== undefined
      ? { foreach_progress: structuredClone(pause.foreach_progress) }
      : {}),
    ...(pause.egress_bound !== undefined ? { egress_bound: pause.egress_bound } : {}),
    approved_target,
  };
};
