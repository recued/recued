/** D-192 Slice 6c server-wiring — the create-plan approve dispatcher.
 *
 *  The `work-entity-create-plan.ts` leaf defines the `CreatePlanApprovedDispatcher`
 *  seam it can't implement (it stays free of the `handleExecute` import so
 *  `execute-handler` — which raises the ask — can import the leaf without a cycle,
 *  the same split the container pick uses). This module implements it: an approved
 *  answer EXECUTES each planned container create (`executeCreatePlan`, which
 *  persists the created id as the Source's stored selection), then dispatches a
 *  FRESH recipe run over `handleExecute`.
 *
 *  The re-run replays the SAME request (config verbatim — each container is
 *  resolved off the store now). On re-run, `resolveCreateDependencies` finds the
 *  stored selection(s) and auto-resolves the container(s) as PICKS; the write then
 *  flows through the NORMAL door. On DENY the answer handler dispatches nothing —
 *  no container is created, no orphan.
 *
 *  Idempotency (the leaf's dispatcher contract). `on_answer` is at-least-once: the
 *  re-run id is DETERMINISTIC per plan (`create-plan-<plan_id>`), and the
 *  dispatcher no-ops when an audit anchor already exists under it — mirroring the
 *  pick / saga dispatchers' at-entry guard. `executeCreatePlan` is itself
 *  idempotent per (source, ref, name) — an already-created+selected container is
 *  reused, never re-minted — closing the window between the container write and
 *  the re-run's anchor. */

import type { ExecutionSource, RecipeDefinition, WorkEntityKind } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type {
  CreatePlanApprovedDispatcher,
  CreatePlanNotifier,
  CreatePlanRerunRef,
} from './work-entity-create-plan.js';
import { registerCreatePlanHandler } from './work-entity-create-plan.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { WorkEntitySourceWriteExecutor } from './work-entity-write-executor.js';
import type { ExecuteRequest } from './types.js';

/** Deterministic run-id prefix for create-plan re-runs — one run per answered
 *  plan, so an at-least-once answer replay converges on the existing anchor
 *  instead of double-dispatching. */
export const CREATE_PLAN_RERUN_PREFIX = 'create-plan-';

/** The `ExecutionSource` a create-plan approval acts under. The OWNER approved by
 *  answering the ask — a `user`-channel `user_self` action; the synthetic
 *  `client_token_id` names the create-plan surface in audit (same posture as the
 *  container-pick / saga re-run sources). The original request's source is
 *  deliberately NOT replayed. Used both for the container creates (audited under
 *  the user action) and the re-run. */
const createPlanRerunSource = (): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'create-plan',
});

/** What the dispatcher needs from the surrounding server. `getExecuteDeps` +
 *  `auditLog` arrive by the same late-binding convention as the pick / saga
 *  dispatchers; `getWriteExecutor` is the lazy accessor for the boot-singleton
 *  write executor (null until the post-listener phase populates it) — the
 *  dispatcher derefs it at ANSWER time, long after boot. */
export interface CreateCreatePlanDispatcherDeps {
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** At-entry idempotency read — an existing anchor under the deterministic re-run
   *  id means a prior attempt already dispatched. */
  auditLog: AuditLogStore;
  /** The boot-singleton write executor (via a lazy ref accessor) whose
   *  `executeCreatePlan` runs the gated container write + persists the selection. */
  getWriteExecutor: () => WorkEntitySourceWriteExecutor | null;
}

/** Build the host-side `CreatePlanApprovedDispatcher`. */
export const createCreatePlanApprovedDispatcher = (
  deps: CreateCreatePlanDispatcherDeps,
): CreatePlanApprovedDispatcher => ({
  async dispatchApprovedPlan(rerun: CreatePlanRerunRef): Promise<void> {
    const run_id = `${CREATE_PLAN_RERUN_PREFIX}${rerun.plan_id}`;

    const anchor = await deps.auditLog.get(run_id);
    if (anchor !== null) {
      // A prior attempt already dispatched this plan — paused, succeeded, OR
      // failed. Never silently re-dispatch (the leaf's idempotency contract); a
      // failed re-run needs a fresh explicit create.
      console.warn(
        `[create-plan] re-run for plan ${rerun.plan_id} already dispatched `
          + `(run ${run_id}, status '${anchor.commit_status}') — skipping replay`,
      );
      return;
    }

    const executor = deps.getWriteExecutor();
    if (executor === null) {
      // Transient: the write executor is populated post-listener. Throw so the
      // answer redelivers on next boot; the at-entry anchor guard keeps the retry
      // convergent (no container was created yet).
      throw new Error(
        `[create-plan] dispatchApprovedPlan: write executor not yet populated — `
          + `plan ${rerun.plan_id} (transient; next boot will retry)`,
      );
    }

    // Execute each planned container create IN ORDER (dependency order — a later
    // plan may scope on an earlier one). `executeCreatePlan` persists each created
    // id as the Source's stored selection so the re-run resolves it as a pick, and
    // is idempotent per (source, ref, name) against an answer replay.
    for (const plan of rerun.plans) {
      const created = await executor.executeCreatePlan({
        source_id: rerun.source_id,
        kind: rerun.kind as WorkEntityKind,
        plan,
        identity: { execution_source: createPlanRerunSource() },
      });
      if (!created.ok) {
        // A container create failed BEFORE any run anchor exists → do NOT re-run
        // (the write would re-plan the same missing container). The user re-issues
        // the create to try again (fresh options).
        console.warn(
          `[create-plan] plan ${rerun.plan_id}: creating ${plan.ref} '${plan.name}' `
            + `failed — not re-running: ${created.reason}`,
        );
        return;
      }
    }

    const executeDeps = deps.getExecuteDeps();
    if (!executeDeps) {
      // Transient: bootstrap incomplete. The containers are already created +
      // selected, so a next-boot retry re-runs cleanly (the create is idempotent,
      // and the re-run resolves the containers as picks).
      throw new Error(
        `[create-plan] dispatchApprovedPlan: executeDeps not yet published — `
          + `plan ${rerun.plan_id} (transient; next boot will retry)`,
      );
    }

    const request: ExecuteRequest = {
      ...(rerun.recipe_id !== undefined
        ? { recipe_id: rerun.recipe_id }
        : { recipe: rerun.recipe as RecipeDefinition }),
      // Config verbatim — each container is resolved off its stored selection now.
      config: rerun.config,
      trigger_source: 'manual',
      execution_source: createPlanRerunSource(),
    };
    // D-192 6c.2c — the create-plan confirm the user just answered approved the
    // WHOLE plan: the container create(s) (executed above, admitted) AND this
    // pending write. Pre-admit the re-run's approved vendor create so it does not
    // degrade at the vendor op's `'ask'` gate — the write executor's standalone
    // spine has no pause path, so an un-admitted `ask` would fail and orphan the
    // container just created. SCOPED TO THE RAISING STEP (`rerun.raising_step_id`):
    // only the step whose create raised this plan is admitted, so a second
    // `ask`-create elsewhere in the replayed recipe still gates. Internal-only
    // override (unforgeable by a wire caller); `ask`→admit only, never a `deny`
    // bypass. Absent step id (legacy payload) → nothing admitted (fail-closed).
    const response = await handleExecute(executeDeps, request, {
      run_id,
      ...(typeof rerun.raising_step_id === 'string' && rerun.raising_step_id.length > 0
        ? { work_entity_write_preadmitted_step_id: rerun.raising_step_id }
        : {}),
    });
    if (response.awaiting_approval) {
      console.info(
        `[create-plan] re-run for plan ${rerun.plan_id} is held at the preflight `
          + `gate (run ${run_id}) — the write awaits the user's approval`,
      );
      return;
    }
    if (!response.success) {
      // The dispatch ran and failed (e.g. the container resolved but the vendor
      // write errored). The anchor now exists, so a replay will not re-dispatch.
      console.warn(
        `[create-plan] re-run ${run_id} failed: `
          + JSON.stringify(response.errors).slice(0, 500),
      );
    }
  },
});

/** Register the `work_entity.create_plan` answer handler on the notification
 *  block. Call once at boot alongside the preflight / in-doubt / saga / pick /
 *  container-pick registrations (`composeNotificationBlock`). */
export const registerCreatePlanResolution = (
  notifier: CreatePlanNotifier,
  deps: CreateCreatePlanDispatcherDeps,
): void => {
  registerCreatePlanHandler(notifier, createCreatePlanApprovedDispatcher(deps));
};
