/** D-192 Slice 6b server-wiring — the container-pick re-run dispatcher.
 *
 *  The `work-entity-container-pick.ts` leaf defines the
 *  `ContainerPickRerunDispatcher` seam it can't implement (it stays free of the
 *  `handleExecute` import so `execute-handler` — which raises the ask — can
 *  import the leaf without a cycle, the same split the connection pick uses).
 *  This module implements it: a chosen answer PERSISTS the pick as the Source's
 *  stored selection, then dispatches a FRESH recipe run over `handleExecute`.
 *
 *  The re-run replays the SAME request (config verbatim — the container is
 *  resolved off the store now, NOT merged into config like the connection pick).
 *  On re-run, `resolveCreateDependencies` finds the stored selection and
 *  auto-resolves the container; the create then flows through the NORMAL door
 *  (dispatch-resolve → catalog gate → preflight approval). The pick
 *  DISAMBIGUATES; the gate is the gate.
 *
 *  Idempotency (the leaf's dispatcher contract). `on_answer` is at-least-once:
 *  the re-run id is DETERMINISTIC per pick (`container-pick-<pick_id>`), and the
 *  dispatcher no-ops when an audit anchor already exists under it — mirroring the
 *  pick / saga dispatchers' at-entry guard, including the conservative
 *  failed-anchor posture (never silently re-dispatch; log the skip). */

import type { ExecutionSource, RecipeDefinition } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type {
  ContainerPickNotifier,
  ContainerPickRerunDispatcher,
  ContainerPickRerunRef,
} from './work-entity-container-pick.js';
import { registerContainerPickHandler } from './work-entity-container-pick.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { SourceDependencyEntityStore } from './storage/source-dependency-entity-store.js';
import type { ExecuteRequest } from './types.js';

/** Deterministic run-id prefix for container-pick re-runs — one run per answered
 *  pick, so an at-least-once answer replay converges on the existing anchor
 *  instead of double-dispatching a vendor create. */
export const CONTAINER_PICK_RERUN_PREFIX = 'container-pick-';

/** The `ExecutionSource` a container-pick re-run dispatches under. The OWNER
 *  picked the container by answering the ask — a `user`-channel `user_self`
 *  action; the synthetic `client_token_id` names the pick surface in audit (same
 *  posture as the connection-pick / saga re-run sources). The original request's
 *  source is deliberately NOT replayed: a persisted-then-replayed source would
 *  forge channel / actor provenance for a dispatch the owner (not the original
 *  channel) initiated — and the re-run still passes every gate. */
const containerPickRerunSource = (): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'container-pick',
});

/** What the dispatcher needs from the surrounding server. `getExecuteDeps` +
 *  `auditLog` arrive by the same late-binding convention as the pick / saga
 *  dispatchers (the notification block, which registers the handler, is composed
 *  before `executeDeps` exists); `store` is the D-192 dependency store the pick
 *  is persisted into. */
export interface CreateContainerPickDispatcherDeps {
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** At-entry idempotency read — an existing anchor under the deterministic
   *  re-run id means a prior attempt already dispatched. */
  auditLog: AuditLogStore;
  /** The dependency store the chosen container is persisted into as the Source's
   *  stored default, so the re-run auto-resolves it. */
  store: Pick<SourceDependencyEntityStore, 'select'>;
}

/** Build the host-side `ContainerPickRerunDispatcher` over `handleExecute`. */
export const createContainerPickRerunDispatcher = (
  deps: CreateContainerPickDispatcherDeps,
): ContainerPickRerunDispatcher => ({
  async dispatchPickedCreate(rerun: ContainerPickRerunRef): Promise<void> {
    const run_id = `${CONTAINER_PICK_RERUN_PREFIX}${rerun.pick_id}`;

    const anchor = await deps.auditLog.get(run_id);
    if (anchor !== null) {
      // A prior attempt already dispatched this pick — paused, succeeded, OR
      // failed. Never silently re-dispatch (the leaf's idempotency contract); a
      // failed re-run needs a fresh explicit create.
      console.warn(
        `[container-pick] re-run for pick ${rerun.pick_id} already dispatched `
          + `(run ${run_id}, status '${anchor.commit_status}') — skipping replay`,
      );
      return;
    }

    // Persist the pick as this Source's stored default BEFORE the re-run so the
    // re-run's create auto-resolves the container off the store. `select` returns
    // false when the id is no longer cached (the container was vendor-deleted /
    // the list re-fetched + pruned between raise and answer) — a rare edge; the
    // re-run would only re-ask, so skip the dispatch and let the user re-issue
    // the create (which re-fetches fresh options).
    const selected = deps.store.select(
      rerun.source_id,
      rerun.dependency_ref,
      rerun.entity_pk,
    );
    if (!selected) {
      console.warn(
        `[container-pick] pick ${rerun.pick_id}: container '${rerun.entity_pk}' `
          + `is no longer available for '${rerun.dependency_ref}' on Source `
          + `'${rerun.source_id}' — not re-running; re-issue the create to choose again`,
      );
      return;
    }

    const executeDeps = deps.getExecuteDeps();
    if (!executeDeps) {
      // Transient: bootstrap incomplete. Throw so the answer redelivers on next
      // boot (the at-entry guard keeps the retry convergent). The selection is
      // already persisted, so the retry re-runs cleanly.
      throw new Error(
        `[container-pick] dispatchPickedCreate: executeDeps not yet published — `
          + `pick ${rerun.pick_id} (transient; next boot will retry)`,
      );
    }

    const request: ExecuteRequest = {
      ...(rerun.recipe_id !== undefined
        ? { recipe_id: rerun.recipe_id }
        : { recipe: rerun.recipe as RecipeDefinition }),
      // Config verbatim — the container is resolved off the stored selection, not
      // merged into config (unlike the connection pick's slot binding).
      config: rerun.config,
      trigger_source: 'manual',
      execution_source: containerPickRerunSource(),
    };
    // D-192 6c.2c — the container pick DISAMBIGUATES; it never AUTHORIZES (leaf
    // doc § "the gate is the gate"; the ask prompt promises "Writes still ask for
    // approval before anything happens"). So the re-run's vendor create is NOT
    // pre-admitted here — it flows through the normal gate exactly like any create
    // (on the run-less write-executor spine an `ask` degrades; closing that is the
    // separate baseline-admission follow-on, not the pick's job to grant).
    const response = await handleExecute(executeDeps, request, { run_id });
    if (response.awaiting_approval) {
      console.info(
        `[container-pick] re-run for pick ${rerun.pick_id} is held at the preflight `
          + `gate (run ${run_id}) — the create awaits the user's approval`,
      );
      return;
    }
    if (!response.success) {
      // The dispatch ran and failed (e.g. the container resolved but the vendor
      // create errored). The anchor now exists, so a replay will not re-dispatch.
      console.warn(
        `[container-pick] re-run ${run_id} failed: `
          + JSON.stringify(response.errors).slice(0, 500),
      );
    }
  },
});

/** Register the `work_entity.container_pick` answer handler on the notification
 *  block. Call once at boot alongside the preflight / in-doubt / saga / pick
 *  registrations (`composeNotificationBlock`). */
export const registerContainerPickResolution = (
  notifier: ContainerPickNotifier,
  deps: CreateContainerPickDispatcherDeps,
): void => {
  registerContainerPickHandler(notifier, createContainerPickRerunDispatcher(deps));
};
