/** R2 step 6 server-wiring — saga annotation writer + compensation
 *  dispatcher.
 *
 *  The `@recued/gateway` saga leaf
 *  (`packages/gateway/src/saga-reconciliation.ts`) defines two seams it
 *  cannot implement (public-boundary rule):
 *
 *    - `SagaAnnotationWriter` — persist the answer as a fresh
 *      annotation targeting `run:<run_id>`; mirrors
 *      `in-doubt-annotation-writer.ts` one grain up (run, not commit).
 *    - `SagaCompensationDispatcher` — an `undo` answer dispatches each
 *      derived plan as a FRESH recipe run over `handleExecute`. The
 *      run flows through the NORMAL door: the inline canonical recipe
 *      resolves at dispatch (`resolveCanonicalRecipeForDispatch`), the
 *      catalog gate holds the destructive delete at preflight
 *      (`approval: 'always'`), and only the user's preflight answer
 *      releases it. The `internal` channel threads
 *      `predecessor_commit_id` onto the run's `CommitRunIdentity` so
 *      the compensating commit links the row it undoes (D-153
 *      § compensating commits) — host-only, never wire-reachable.
 *
 *  Idempotency (the leaf's dispatcher contract). `on_answer` is
 *  at-least-once: a crash between dispatch and the block's
 *  mark-handled re-dispatches the same payload on next boot. The
 *  compensation run id is DETERMINISTIC per compensated commit
 *  (`saga-comp-<predecessor_commit_id>`), and the dispatcher no-ops
 *  when an audit anchor already exists under that run id — mirroring
 *  `PreflightResumer`'s at-entry guard. Deliberately conservative in
 *  the failed-anchor case: an anchor in ANY state means a dispatch
 *  already ran, and silently re-dispatching a destructive undo that
 *  failed is exactly the double-action the guard exists to prevent —
 *  the skip is logged prominently instead.
 */

import type {
  SagaAnnotationWriter,
  SagaCompensationDispatcher,
  SagaCompensationPlanRef,
  SagaNotifier,
  SagaReconciliationAnnotation,
} from '@recued/gateway';
import {
  SAGA_ANNOTATION_KEY,
  SAGA_TARGET_COLLECTION,
  registerSagaHandler,
} from '@recued/gateway';
import type { ExecutionSource, RecipeDefinition } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { AnnotationStore } from './storage/annotation-store.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { ExecuteRequest } from './types.js';

/** Synthetic `authored_by_recipe_id` for gateway-authored saga
 *  reconciliation annotations — same convention as
 *  `GATEWAY_IN_DOUBT_AUTHOR_ID` (kernel-namespace prefix signals
 *  "engine-emitted, not author-installable"). */
export const GATEWAY_SAGA_AUTHOR_ID = 'recued/saga-reconciliation';

/** Deterministic run-id prefix for compensation runs — one run per
 *  compensated commit, so an at-least-once answer replay converges on
 *  the existing anchor instead of double-dispatching. */
export const SAGA_COMPENSATION_RUN_PREFIX = 'saga-comp-';

/** The `ExecutionSource` a compensation run dispatches under. The
 *  user requested the undo by answering the saga ask — a `user`-channel
 *  `user_self` action; the synthetic `client_token_id` names the
 *  reconciliation surface in audit (same posture as the rpc path's
 *  `'unregistered'` fallback). */
const sagaCompensationSource = (): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'saga-reconciliation',
});

/** Build a `SagaAnnotationWriter` over `recued-server`'s
 *  `AnnotationStore`. Read-modify guard mirrors the in-doubt writer:
 *  the SQLite table has no UNIQUE on the triple, so an at-least-once
 *  retry short-circuits on the existing row instead of inserting a
 *  second one. */
export const createSagaAnnotationWriter = (
  store: AnnotationStore,
): SagaAnnotationWriter => ({
  async writeReconciliation(
    annotation: SagaReconciliationAnnotation,
  ): Promise<void> {
    const existing = await store.annotationsForRecord(
      SAGA_TARGET_COLLECTION,
      annotation.run_id,
    );
    if (existing.some((row) => row.key === SAGA_ANNOTATION_KEY)) {
      return; // already reconciled — at-least-once retry, no-op
    }
    await store.annotate({
      target_collection: SAGA_TARGET_COLLECTION,
      target_id: annotation.run_id,
      key: SAGA_ANNOTATION_KEY,
      value: {
        answer: annotation.answer,
        answered_at: annotation.answered_at,
        run_id: annotation.run_id,
        recipe_id: annotation.recipe_id,
        landed_commit_ids: annotation.landed_commit_ids,
      },
      authored_by_recipe_id: GATEWAY_SAGA_AUTHOR_ID,
      source_record_hash: annotation.run_id,
      event_at: annotation.event_at,
    });
  },
});

/** What the dispatcher needs from the surrounding server. Both arrive
 *  by the same late-binding convention as `CreatePreflightResumerDeps`
 *  — the notification block (which registers the handler) is composed
 *  before `executeDeps` exists. */
export interface CreateSagaDispatcherDeps {
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** At-entry idempotency read — an existing anchor under the
   *  deterministic compensation run id means a prior attempt already
   *  dispatched. */
  auditLog: AuditLogStore;
}

/** Build the host-side `SagaCompensationDispatcher` over
 *  `handleExecute`. */
export const createSagaCompensationDispatcher = (
  deps: CreateSagaDispatcherDeps,
): SagaCompensationDispatcher => ({
  async dispatchCompensation(plan: SagaCompensationPlanRef): Promise<void> {
    const run_id = `${SAGA_COMPENSATION_RUN_PREFIX}${plan.predecessor_commit_id}`;

    const anchor = await deps.auditLog.get(run_id);
    if (anchor !== null) {
      // A prior attempt already dispatched this compensation — paused,
      // succeeded, OR failed. Never silently re-dispatch a destructive
      // undo (the leaf's idempotency contract); a failed undo needs a
      // fresh, explicit user request.
      console.warn(
        `[saga] compensation for commit ${plan.predecessor_commit_id} already `
          + `dispatched (run ${run_id}, status '${anchor.commit_status}') — skipping replay`,
      );
      return;
    }

    const executeDeps = deps.getExecuteDeps();
    if (!executeDeps) {
      // Transient: bootstrap incomplete. Throw so the answer redelivers
      // on next boot (the at-entry guard keeps the retry convergent).
      throw new Error(
        `[saga] dispatchCompensation: executeDeps not yet published — `
          + `commit ${plan.predecessor_commit_id} (transient; next boot will retry)`,
      );
    }

    const request: ExecuteRequest = {
      recipe: plan.recipe as RecipeDefinition,
      config: plan.config,
      trigger_source: 'manual',
      execution_source: sagaCompensationSource(),
    };
    const response = await handleExecute(executeDeps, request, {
      run_id,
      predecessor_commit_id: plan.predecessor_commit_id,
    });
    if (response.awaiting_approval) {
      console.info(
        `[saga] compensation for commit ${plan.predecessor_commit_id} is held `
          + `at the preflight gate (run ${run_id}) — awaiting the user's approval`,
      );
      return;
    }
    if (!response.success) {
      // The dispatch ran and failed before/at the gate (resolve
      // rejection surfaces as a thrown RpcError instead and never
      // reaches here with an anchor). Surface loudly; the anchor now
      // exists, so a replay will not re-dispatch.
      console.warn(
        `[saga] compensation run ${run_id} failed: `
          + JSON.stringify(response.errors).slice(0, 500),
      );
    }
  },
});

/** Register the `gateway.saga` answer handler on the notification
 *  block. Call once at boot alongside the preflight + in-doubt
 *  registrations (`composeNotificationBlock`). */
export const registerSagaReconciliation = (
  notifier: SagaNotifier,
  deps: { annotationStore: AnnotationStore } & CreateSagaDispatcherDeps,
): void => {
  registerSagaHandler(
    notifier,
    createSagaAnnotationWriter(deps.annotationStore),
    createSagaCompensationDispatcher({
      getExecuteDeps: deps.getExecuteDeps,
      auditLog: deps.auditLog,
    }),
  );
};
