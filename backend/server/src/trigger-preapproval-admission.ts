/** D-341 slice B1 — the host's answer to both gates for one run a trigger started: the commit
 *  gateway's for a single-op ingredient, the catalog gate's for a catalog op. Built in
 *  `handleExecute` from the run, never from the call:
 *  - the trigger, from the run's authenticated source (`triggeredRunOf`);
 *  - the recipe version, as the run hashes it (`authoredRecipeSha256`);
 *  - the op, from the step's own (`recipeStepOps`), and only when the call is that op
 *    (`preapprovableOp`).
 *  It spends a use in the store's transaction, audits it (`trigger_preapproval_used`), and gives
 *  the gate the pre-approval's id. Anything it cannot match leaves the ask standing. */

import { isBrowserActionSlug, type TriggeredRun, type TriggerPreapprovalHooks } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { TriggerPreapprovalStore } from './storage/trigger-preapproval-store.js';
import { preapprovableOp, type NeutralWriteOf } from './trigger-preapproval-ops.js';

export const createTriggerPreapprovalAdmission = (deps: {
  readonly store: Pick<TriggerPreapprovalStore, 'use'>;
  readonly run: TriggeredRun;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  readonly run_id: string;
  /** The op each of the version's own steps calls. Read once, on the first write the run holds:
   *  by then the run knows its packs. */
  readonly stepOps: () => ReadonlyMap<string, string>;
  /** B7 — what a CRM's catalog op serves, for a vendor-neutral write's call. */
  readonly neutralWriteOf?: NeutralWriteOf;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
}): TriggerPreapprovalHooks => {
  const now = deps.now ?? Date.now;
  let ops: ReadonlyMap<string, string> | undefined;
  return {
    admit: (call) => {
      // B6 — a recipe a scheduled prompt started: its browser actions are the prompt's own
      // pre-approval's (B5, at the pass seam), never this recipe's.
      if (deps.run.prompt_sha256 !== undefined && isBrowserActionSlug(call.slug)) return null;
      ops ??= deps.stepOps();
      const op = preapprovableOp(ops, call, deps.neutralWriteOf);
      if (op === undefined) return null;
      const at = now();
      const used = deps.store.use({
        ...deps.run, recipe_id: deps.recipe_id, recipe_sha256: deps.recipe_sha256, op, run_id: deps.run_id,
      }, at);
      if (used === undefined) return null;
      if (deps.auditLog !== undefined) {
        void deps.auditLog.logActivity({
          activity_id: `trigger_preapproval_used_${deps.run_id}_${String(at)}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: at,
          action: 'trigger_preapproval_used',
          target: used.id,
          detail: JSON.stringify({
            run_id: deps.run_id, recipe_id: deps.recipe_id, step_id: call.step_id, op, trigger: deps.run.trigger,
            uses: used.uses,
          }),
        }).catch(() => undefined);
      }
      return used.id;
    },
  };
};
