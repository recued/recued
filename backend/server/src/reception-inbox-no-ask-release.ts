/** D-210 Phase C — releasing a hold that carries NO durable ask.
 *
 *  ── Why this exists ────────────────────────────────────────────────
 *  The inbox release path is keyed on `anchor.ask_id`: approve answers
 *  the hold's `gateway.preflight` ask with `'approve'`, and the block's
 *  `on_answer` handler drives `PreflightResumer.resumeRun`. That chain
 *  needs an ask.
 *
 *  Phase C's `inbox_fanout_mode: 'notify'` deliberately raises NO ask —
 *  a held item fires a passive heads-up and is reviewed in the inbox. So
 *  the inbox needs a release path that reaches the resumer directly.
 *  (Owner chose this — "Option 1", faithful — over always minting the
 *  durable ask and varying only the device surface.)
 *
 *  It also fixes a pre-existing hole: an anchor can be `awaiting_approval`
 *  with no `ask_id` when the raise threw after the checkpoint write
 *  (`execute-handler` logs and leaves `ask_id` undefined). Today approve
 *  on such a hold returns `not_configured` and the item is stuck until a
 *  boot sweep re-raises. This path releases it.
 *
 *  ── What it must reproduce ─────────────────────────────────────────
 *  This is the no-ask twin of `createPreflightAnswerHandler`'s tail
 *  (`packages/gateway/src/preflight-reconciliation.ts`), and it must keep
 *  the same three steps in the same order:
 *
 *    1. rebuild the `PreflightAskContext`,
 *    2. `resumeRun` / `denyRun`,
 *    3. CONSUME the checkpoint (idempotent; a crash between 2 and 3
 *       leaves it for a boot-sweep retry, so the host's callbacks must
 *       stay safe to call again).
 *
 *  ⚠ THE CONTEXT IS REBUILT FROM THE CHECKPOINT, NOT FROM AN ASK.
 *  On the ask path the context is serialized into the ask's handler
 *  payload at raise time and read back at answer time. With no ask there
 *  is no payload — but everything the resumer actually requires
 *  (`recipe_id` + `gated_step_id`, or the `raw_op` discriminant) is
 *  already durable on the checkpoint itself, which is why no new
 *  persistence is needed. The optional `tool_slug` / `risk_tier` /
 *  `reason` trio is ask-BODY vocabulary — it exists to word the question
 *  put to a human. With no ask, no question was worded, and the resumer
 *  reads none of them. The boot sweep's own re-raise makes the same
 *  reduction (`preflight-boot-sweep.ts` rebuilds exactly this pair).
 *
 *  ⛔ `approved_at` IS LOAD-BEARING — SEE BELOW.
 *
 *  Spec: D-210 Phase C; D-157 § A.2 / N.3. */

import type { Checkpoint } from '@recued/contracts';
import type { CheckpointStore } from '@recued/storage';
import type { PreflightAskContext, PreflightResumer } from '@recued/gateway';

/** Rebuild the resume context for a hold that never had an ask.
 *
 *  Pure. Partitions on the `raw_op` discriminant exactly as
 *  `createPreflightAnswerHandler` does: a recipe-LESS raw-op door hold
 *  carries `raw_op` and no `recipe_id` / `gated_step_id`; a recipe-bound
 *  hold carries the pair. Both are required-and-exclusive by the
 *  `Checkpoint` guard, so this reads whichever the checkpoint actually
 *  has rather than asserting a shape. */
export const buildNoAskReleaseContext = (
  checkpoint: Checkpoint,
): PreflightAskContext => {
  if (checkpoint.raw_op !== undefined) {
    return { raw_op: { op_id: checkpoint.raw_op.op_id } };
  }
  return {
    ...(checkpoint.recipe_id !== undefined ? { recipe_id: checkpoint.recipe_id } : {}),
    ...(checkpoint.gated_step_id !== undefined
      ? { gated_step_id: checkpoint.gated_step_id }
      : {}),
  };
};

export interface NoAskReleaseDeps {
  /** The DECORATED host resumer — the one `withBeforePreflightResume`
   *  wrapped. It MUST be the decorated instance: the intake acceptance
   *  hook (`form-response-promotion.ts`) lives on that decoration, and
   *  the whole point of keeping it there is that Inbox, the global
   *  queue, batch approval and boot recovery all run the same durable
   *  pre-resume effects. Binding the bare resumer here would give the
   *  no-ask path a quietly different approval semantics. */
  readonly resumer: PreflightResumer;
  /** Consumes the checkpoint after the resume/deny — step 3. */
  readonly checkpointStore: Pick<CheckpointStore, 'delete'>;
}

/** Release one ask-less hold. `approved_at` is supplied by the CALLER
 *  (the inbox rpc, off its own clock seam) rather than minted here, so
 *  the approval moment the promotion hook records is the same instant the
 *  audit row carries.
 *
 *  ⛔ WHY `approved_at` IS REQUIRED, NOT OPTIONAL.
 *  `PreflightAskContext.approved_at` normally comes from the durable
 *  ask's ANSWER (`answer.answered_at`). A no-ask release has no answer —
 *  and `form-response-promotion.ts` FAILS CLOSED without it:
 *
 *      if (typeof approvedAt !== 'number' || !Number.isSafeInteger(approvedAt)
 *          || approvedAt < 0) throw invalid(`… no valid durable approval timestamp`);
 *
 *  That check sits BEFORE the hook's unpaired early-return, so an
 *  unsupplied `approved_at` does not merely break D-200 paid intakes — it
 *  throws for EVERY reviewed intake, and it throws at the promotion hook,
 *  i.e. after the owner clicked approve, as a throw rather than a
 *  refusal. Making the parameter required is the point: the type system
 *  refuses to let a caller forget it.
 *
 *  (The hook `Math.max`es it against `row.submitted_at`, so a synthesized
 *  value only has to be a real timestamp, not a reconstructed one.)
 *
 *  Deny carries no timestamp — `denyRun` writes its own audit row and the
 *  promotion hook never runs on that leg. */
export const createNoAskRelease = (deps: NoAskReleaseDeps) => async (
  checkpoint: Checkpoint,
  decision: { kind: 'approve'; approved_at: number } | { kind: 'deny' },
): Promise<void> => {
  const context = buildNoAskReleaseContext(checkpoint);
  if (decision.kind === 'approve') {
    await deps.resumer.resumeRun(checkpoint, {
      ...context,
      approved_at: decision.approved_at,
    });
  } else {
    await deps.resumer.denyRun(checkpoint, context);
  }
  // Consume — idempotent, and deliberately AFTER the resume/deny so a
  // crash in between leaves the checkpoint for the boot sweep rather
  // than losing the hold entirely.
  //
  // ⚠ KNOWN, ACCEPTED: unlike the ask path, this leg has NO serializer. The
  // ask path is serialized by the notification block's per-`ask_id`
  // answer handling; with no ask there is nothing to serialize on. So the
  // checkpoint-retention staleness sweep can land its `failed` row in the
  // window between `resumeRun` and this delete, leaving an audit row that
  // denies a dispatch which actually happened.
  //
  // Deleting FIRST would close that window (`resumeRun` takes the
  // `Checkpoint` by value, so it does not need the row), but it trades a
  // rare wrong-audit-row for a crash that loses the submission outright.
  // The current order is the better trade: the visitor's request survives.
  // Revisit only if the ordering ever has to serve an at-most-once claim
  // stronger than "the run resumed".
  await deps.checkpointStore.delete(checkpoint.checkpoint_id);
};

/** The seam the inbox handler holds. Narrow on purpose: the handler
 *  decides WHETHER a hold is ask-less and owns the approval moment; the
 *  wire layer owns the resumer plumbing. */
export type ReleaseHeldOpWithoutAsk = ReturnType<typeof createNoAskRelease>;
