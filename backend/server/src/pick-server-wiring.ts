/** Doc §4 close-out server-wiring — the pick re-run dispatcher.
 *
 *  The `@recued/gateway` pick leaf
 *  (`packages/gateway/src/pick-resolution.ts`) defines the
 *  `PickRerunDispatcher` seam it cannot implement (public-boundary
 *  rule): a candidate answer dispatches a FRESH recipe run over
 *  `handleExecute` with the chosen binding merged into `config`. The
 *  run flows through the NORMAL door: the canonical recipe resolves at
 *  dispatch (`resolveCanonicalRecipeForDispatch`), the catalog gate
 *  enforces grants per (operation × connection), and writes pause at
 *  preflight approval. The pick DISAMBIGUATES; the gate is the gate.
 *
 *  (Candidate derivation lives in `pick-candidates.ts` — the
 *  execute-handler imports it while this module imports the
 *  execute-handler, so one module would be an import cycle.)
 *
 *  Idempotency (the leaf's dispatcher contract). `on_answer` is
 *  at-least-once: the re-run id is DETERMINISTIC per pick
 *  (`pick-rerun-<pick_id>`, the pick id minted once at ask build),
 *  and the dispatcher no-ops when an audit anchor already exists
 *  under it — mirroring the saga compensation dispatcher's at-entry
 *  guard, including its conservative failed-anchor posture (never
 *  silently re-dispatch; log the skip). */

import type { ExecutionSource, RecipeDefinition } from '@recued/contracts';
import type {
  PickNotifier,
  PickRerunDispatcher,
  PickRerunRef,
} from '@recued/gateway';
import { registerPickHandler } from '@recued/gateway';
import type { AuditLogStore } from '@recued/storage';

import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import type { ExecuteRequest } from './types.js';

/** Deterministic run-id prefix for pick re-runs — one run per answered
 *  pick, so an at-least-once answer replay converges on the existing
 *  anchor instead of double-dispatching. */
export const PICK_RERUN_PREFIX = 'pick-rerun-';

/** The `ExecutionSource` a pick re-run dispatches under. The OWNER
 *  picked the connection by answering the ask — a `user`-channel
 *  `user_self` action; the synthetic `client_token_id` names the pick
 *  surface in audit (same posture as the saga compensation source).
 *  The original request's source is deliberately NOT replayed: a
 *  persisted-then-replayed `ExecutionSource` would forge channel /
 *  actor provenance for a dispatch the owner, not the original
 *  channel, initiated — and the re-run still passes every gate. */
const pickRerunSource = (): ExecutionSource => ({
  channel: 'user',
  actor: 'user_self',
  user_id: 'local',
  client_token_id: 'pick-resolution',
});

/** What the dispatcher needs from the surrounding server. Both arrive
 *  by the same late-binding convention as the saga dispatcher — the
 *  notification block (which registers the handler) is composed before
 *  `executeDeps` exists. */
export interface CreatePickDispatcherDeps {
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** At-entry idempotency read — an existing anchor under the
   *  deterministic re-run id means a prior attempt already
   *  dispatched. */
  auditLog: AuditLogStore;
}

/** Build the host-side `PickRerunDispatcher` over `handleExecute`. */
export const createPickRerunDispatcher = (
  deps: CreatePickDispatcherDeps,
): PickRerunDispatcher => ({
  async dispatchPickedRun(rerun: PickRerunRef): Promise<void> {
    const run_id = `${PICK_RERUN_PREFIX}${rerun.pick_id}`;

    const anchor = await deps.auditLog.get(run_id);
    if (anchor !== null) {
      // A prior attempt already dispatched this pick — paused,
      // succeeded, OR failed. Never silently re-dispatch (the leaf's
      // idempotency contract); a failed re-run needs a fresh explicit
      // run.
      console.warn(
        `[pick] re-run for pick ${rerun.pick_id} already dispatched `
          + `(run ${run_id}, status '${anchor.commit_status}') — skipping replay`,
      );
      return;
    }

    const executeDeps = deps.getExecuteDeps();
    if (!executeDeps) {
      // Transient: bootstrap incomplete. Throw so the answer redelivers
      // on next boot (the at-entry guard keeps the retry convergent).
      throw new Error(
        `[pick] dispatchPickedRun: executeDeps not yet published — `
          + `pick ${rerun.pick_id} (transient; next boot will retry)`,
      );
    }

    const request: ExecuteRequest = {
      ...(rerun.recipe_id !== undefined
        ? { recipe_id: rerun.recipe_id }
        : { recipe: rerun.recipe as RecipeDefinition }),
      config: { ...rerun.config, [rerun.variable]: rerun.connection_name },
      trigger_source: 'manual',
      execution_source: pickRerunSource(),
    };
    const response = await handleExecute(executeDeps, request, { run_id });
    if (response.awaiting_approval) {
      console.info(
        `[pick] re-run for pick ${rerun.pick_id} is held at the preflight `
          + `gate (run ${run_id}) — awaiting the user's approval`,
      );
      return;
    }
    if (!response.success) {
      // The dispatch ran and failed (e.g. the chosen candidate cleared
      // the op-set check but failed full resolve / a step failed). The
      // anchor now exists, so a replay will not re-dispatch.
      console.warn(
        `[pick] re-run ${run_id} failed: `
          + JSON.stringify(response.errors).slice(0, 500),
      );
    }
  },
});

/** Register the `gateway.pick` answer handler on the notification
 *  block. Call once at boot alongside the preflight / in-doubt / saga
 *  registrations (`composeNotificationBlock`). */
export const registerPickResolution = (
  notifier: PickNotifier,
  deps: CreatePickDispatcherDeps,
): void => {
  registerPickHandler(notifier, createPickRerunDispatcher(deps));
};
