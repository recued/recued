/** D-341 slice B1 — the host's answer to both gates for one run a trigger started: the commit
 *  gateway's for a single-op ingredient, the catalog gate's for a catalog op. Built in
 *  `handleExecute` from the run, never from the call:
 *  - the trigger, from the run's authenticated source (`triggeredRunOf`);
 *  - the recipe version, as the run hashes it (`authoredRecipeSha256`);
 *  - the op, from the step's own (`recipeStepOps`), and only when the call is that op
 *    (`preapprovableOp`).
 *  It spends a use in the store's transaction, audits it (`trigger_preapproval_used`), and gives
 *  the gate the pre-approval's id. Anything it cannot match leaves the ask standing. */

import { isBrowserActionSlug, type PreapprovalBrowsers, type PreapprovalCaller, type TriggeredRun, type TriggerPreapprovalHooks } from '@recued/contracts';
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

/** D-402 slice F2 (§7.6) — the host's answer to both gates for a run the owner's chat or an AI app
 *  started, from the pre-approvals that caller holds for this recipe version: this run's own ("Yes,
 *  this time"), else a standing one ("Always, for this recipe"). Found by the run's caller
 *  (`preapprovalCallerOf`), its recipe version and its id, never by the call; the op from the step's
 *  own, as a trigger's (`preapprovableOp`). Each covers the whole recipe (ruling 5): any write of the
 *  version's own steps, with no count. What no pre-approval covers (destructive, a review, "always
 *  ask", an upload) the gates never put to it. Each use is spent in the store's transaction and
 *  audited as a trigger's is (`trigger_preapproval_used`, naming the caller). */
/** D-402 ruling 17 — the outermost run of a nested one (D-232): its recipe, the version it ran, its run, and
 *  the browsers its settings named. What a nested run's write may be covered by. */
export interface CallerPreapprovalOuterRun {
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  readonly run_id: string;
  readonly browsers?: PreapprovalBrowsers;
}

export const createCallerPreapprovalAdmission = (deps: {
  readonly store: Pick<TriggerPreapprovalStore, 'useCaller'>;
  readonly caller: PreapprovalCaller;
  /** D-402 slice H4 (§7.6) — the browsers the run's settings name. A row holds each site's writes to the
   *  browsers it was granted for, so one granted before a browser setting changed covers nothing here.
   *  The run's settings are fixed for the run, and each browser step goes only to the browser its setting
   *  names (slice H2), so checking them once per write here is checking every write's browser. */
  readonly browsers?: PreapprovalBrowsers;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  readonly run_id: string;
  readonly stepOps: () => ReadonlyMap<string, string>;
  readonly neutralWriteOf?: NeutralWriteOf;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
  /** D-402 slice F5 — told of each use: this run's "Yes, this time", or a standing "Always". */
  readonly onUse?: (used: { readonly this_run: boolean }) => void;
  /** D-402 ruling 17 — for a run another recipe's run started (D-232): the outermost run, whose answer
   *  covers this recipe's writes when its row names this recipe at this version. */
  readonly outer?: CallerPreapprovalOuterRun;
}): TriggerPreapprovalHooks => {
  const now = deps.now ?? Date.now;
  let ops: ReadonlyMap<string, string> | undefined;
  return {
    admit: (call) => {
      ops ??= deps.stepOps();
      const op = preapprovableOp(ops, call, deps.neutralWriteOf);
      if (op === undefined) return null;
      const at = now();
      const used = deps.store.useCaller({
        caller: deps.caller, recipe_id: deps.recipe_id, recipe_sha256: deps.recipe_sha256, op, run_id: deps.run_id,
        ...(deps.browsers !== undefined ? { browsers: deps.browsers } : {}),
      }, at)
        // Ruling 17 — else the outermost run's answer, which names this recipe at this version.
        ?? (deps.outer === undefined ? undefined : deps.store.useCaller({
          caller: deps.caller, recipe_id: deps.outer.recipe_id, recipe_sha256: deps.outer.recipe_sha256, op, run_id: deps.outer.run_id,
          ...(deps.outer.browsers !== undefined ? { browsers: deps.outer.browsers } : {}),
          nested: { recipe_id: deps.recipe_id, recipe_sha256: deps.recipe_sha256 },
        }, at));
      if (used === undefined) return null;
      if (deps.auditLog !== undefined) {
        void deps.auditLog.logActivity({
          activity_id: `trigger_preapproval_used_${deps.run_id}_${String(at)}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: at,
          action: 'trigger_preapproval_used',
          target: used.id,
          detail: JSON.stringify({
            run_id: deps.run_id, recipe_id: deps.recipe_id, step_id: call.step_id, op, caller: deps.caller,
            ...(used.run_id !== undefined ? { this_run: true } : {}), uses: used.uses,
            ...(used.recipe_id !== deps.recipe_id ? { by_outer_run: { run_id: deps.outer?.run_id, recipe_id: used.recipe_id } } : {}),
          }),
        }).catch(() => undefined);
      }
      deps.onUse?.({ this_run: used.run_id !== undefined });
      return used.id;
    },
  };
};
