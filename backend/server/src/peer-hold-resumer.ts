/** D-234 § 234.4 — RESUMING A PEER HOLD.
 *
 *  🔑🔑 THERE IS NO ANSWER-INJECTION PATH HERE, AND THAT IS THE DESIGN, NOT A
 *  SHORTCUT. The answer is already recorded by the time this runs; re-instantiating
 *  the run makes the gated step RE-RUN, and `dispatchPeerAsk` finds the recorded
 *  answer and returns it instead of throwing. Idempotent-with-memory, exactly as
 *  § 234.1's admission ceiling re-runs and finds the recorded decision. So this
 *  file carries no answer, no option, no note — only "run that again".
 *
 *  ⛔ A SEPARATE ENTRY POINT FROM `PreflightResumer.resumeRun`, and deliberately
 *  so. That one's idempotency guard reads the anchor's `commit_status` expecting
 *  `awaiting_approval` and SKIPS anything else — a peer hold reaching it would be
 *  silently discarded as "an unexpected state". The two holds share the
 *  checkpoint substrate and nothing else: an approval resume is answered by the
 *  owner on this machine, a peer resume by a decision recorded from the wire.
 *
 *  ⚠ Deliberately NOT folded into that resumer by widening its guard. The guard
 *  is what makes a stale/duplicate answer a no-op, and the two holds have
 *  different staleness rules — an approval checkpoint is consumed by its answer,
 *  a peer hold is closed by its outbox row. Widening would have made one
 *  predicate serve two invariants, which is how the D-157 statuses got confused
 *  in the first place.
 */
import type { AuditLogStore } from '@recued/storage';
import type { Checkpoint } from '@recued/contracts';
import { isHeldRunAnchorStatus } from '@recued/contracts';

import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { ExecuteRequest } from './types.js';

export interface PeerHoldResumeDeps {
  readonly getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  readonly auditLog: Pick<AuditLogStore, 'get'>;
  readonly checkpoints: { listByRun(run_id: string): Promise<Checkpoint[]> };
}

export type PeerHoldResumeOutcome =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'skipped'; readonly reason: string };

/** Re-instantiate a run held on a peer answer, past its gate. */
export const resumePeerHold = async (
  target: { run_id: string; gated_step_id: string },
  deps: PeerHoldResumeDeps,
): Promise<PeerHoldResumeOutcome> => {
  const executeDeps = deps.getExecuteDeps();
  if (executeDeps === undefined) {
    // Transient (bootstrap). THROW rather than skip: the answer is durable, and
    // the caller's retry — or the next boot — should try again.
    throw new Error(
      `[peer-hold-resumer] executeDeps not yet published — run_id=${target.run_id}`,
    );
  }
  const anchor = await deps.auditLog.get(target.run_id);
  if (anchor === null) {
    return { kind: 'skipped', reason: `anchor run_id=${target.run_id} not found` };
  }
  // ⛔ HELD, OR THERE IS NOTHING TO RESUME. A terminal anchor means the run
  // already finished on a prior attempt (a duplicate answer delivery, or a boot
  // sweep racing this call) — the answer is recorded either way, so a no-op is
  // the correct and idempotent outcome. `isHeldRunAnchorStatus` is the shared
  // predicate rather than a literal compare, so a future held status joins here
  // by construction (the same ratchet `checkpoint-retention` hangs on).
  if (!isHeldRunAnchorStatus(anchor.commit_status)) {
    return {
      kind: 'skipped',
      reason: `anchor run_id=${target.run_id} is '${anchor.commit_status}', not held`,
    };
  }
  const checkpoints = await deps.checkpoints.listByRun(target.run_id);
  const checkpoint = checkpoints[0];
  if (checkpoint === undefined) {
    return { kind: 'skipped', reason: `no checkpoint for run_id=${target.run_id}` };
  }

  // ⚠ THE RUN-SHAPE COMES OFF THE PAUSED ANCHOR, not off this call. The resumed
  // gated step must resolve `{{config.*}}` / `{{context.*}}` against the values
  // the ORIGINAL run saw — anything else re-dispatches a different question than
  // the one the peer answered. Mirrors `PreflightResumer.buildResumeInputs`.
  const request: ExecuteRequest = {
    ...(checkpoint.recipe_snapshot !== undefined
      ? { recipe: checkpoint.recipe_snapshot }
      : { recipe_id: checkpoint.recipe_id! }),
    // ⚠ `?? {}` ON BOTH, and the first cut had neither. `config_snapshot` is
    // documented as required-and-never-stripped, and it is still NULL on a real
    // anchor here — a spread of null throws `Cannot convert undefined or null to
    // object`, which surfaced as "recorded but resume failed" with the answer
    // already durable. A snapshot-shaped field being absent in practice is the
    // ordinary case, not the exceptional one; the resume must degrade to "no
    // config" rather than strand a run whose answer already came home.
    config: { ...(anchor.config_snapshot ?? {}) },
    ...(anchor.context_snapshot != null
      && Object.keys(anchor.context_snapshot).length > 0
      ? { context: { ...anchor.context_snapshot } }
      : {}),
    ...(anchor.trigger_source != null
      ? { trigger_source: anchor.trigger_source }
      : {}),
  } as ExecuteRequest;

  await handleExecute(
    executeDeps,
    request,
    {
      // Same run identity, so the resumed execution lands on the SAME anchor
      // rather than minting a second run for one conversation.
      run_id: target.run_id,
      // ⛔⛔ `step_state` IS NOT OPTIONAL, and omitting it does not degrade — it
      // THROWS. `handleExecute` seeds the resumed run's `step.*` from it through
      // `assignOwnSafe`, which calls `Object.entries` on whatever it is given, so
      // an absent snapshot is a `TypeError` several frames below and surfaces as
      // "recorded but resume failed" with the answer already durable. It is also
      // the reason a resume is a resume at all: without the prior steps' outputs
      // the re-run would re-execute the whole recipe rather than continue it.
      resume_from: {
        gated_step_id: target.gated_step_id,
        step_state: checkpoint.step_state,
      },
    } as never,
  );
  return { kind: 'resumed' };
};
