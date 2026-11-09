/** D-341 slice B3 — a scheduled prompt's own standing pre-approval, at the chat's gate
 *  (`ChatOrchestratorDeps.useTriggerPreapproval`) and on its held writes' asks.
 *
 *  A scheduled prompt runs no recipe: its chat turn's AI decides its writes. So its pre-approval
 *  pins the prompt (the version of its text, as the scheduler stamps each occurrence) and names the
 *  Tier-1 writes it may make as D-329's write rules name them: the tool and what it writes on
 *  (`triggerPreapprovalTier1Op`). Everything here reads the run's own source, never the call's: the
 *  schedule, the prompt's version and the occurrence the cap per run counts in.
 *
 *  B5 (ruling 11): and its browser actions, all of them on any site, checked where the chat's switch
 *  is. ⛔ Not a recipe the turn starts, which is that recipe's run (B6), nor the turn that carries a
 *  conversation on after an approval, which runs as the owner's chat (ruling 13). */

import {
  describeTriggerPreapprovalOffer,
  scheduledPromptRunOf,
  TRIGGER_PREAPPROVAL_BROWSER_OP,
  triggerPreapprovalOfferOption,
  triggerPreapprovalTier1Op,
  type ExecutionSource,
  type TriggerPreapprovalOffer,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { TriggerPreapprovalStore } from './storage/trigger-preapproval-store.js';

/** The gate's step: spend one use of the scheduled prompt's pre-approval that names this write,
 *  within its cap per run, and audit it. Undefined (the write is held) for any other source, a
 *  write no pre-approval can name, none that covers it, or a store that fails. */
export const createScheduledPromptPreapprovalUse = (deps: {
  readonly store: Pick<TriggerPreapprovalStore, 'use'> | undefined;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
}) => (
  source: ExecutionSource,
  tool: string,
  args: unknown,
): { readonly preapproval_id: string; readonly uses: number } | undefined => {
  const run = scheduledPromptRunOf(source);
  const op = run !== undefined ? triggerPreapprovalTier1Op(tool, args) : undefined;
  if (run === undefined || op === undefined || deps.store === undefined) return undefined;
  const at = (deps.now ?? Date.now)();
  let used: ReturnType<TriggerPreapprovalStore['use']>;
  try {
    used = deps.store.use({
      trigger: run.trigger, recipe_id: run.trigger.schedule_id, recipe_sha256: run.prompt_sha256, op, run_id: run.run_id,
    }, at);
  } catch {
    return undefined; // fail closed: the write asks
  }
  if (used === undefined) return undefined;
  if (deps.auditLog !== undefined) {
    void deps.auditLog.logActivity({
      activity_id: `trigger_preapproval_used_${run.run_id}_${String(at)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: at,
      action: 'trigger_preapproval_used',
      target: used.id,
      detail: JSON.stringify({ run_id: run.run_id, tool, op, trigger: run.trigger, uses: used.uses }),
    }).catch(() => undefined);
  }
  return { preapproval_id: used.id, uses: used.uses };
};

/** D-341 slice B5 (ruling 11) — the browser's step: spend one use of the scheduled prompt's
 *  pre-approval of its browser actions, within its cap per run, and audit it. Checked where the
 *  chat's switch is (the commit gateway's pass seam), after the batches that are always asked about
 *  (putting the owner's files into a page). Undefined (the action asks) for any other source, none
 *  that covers it, or a store that fails. */
export const createScheduledPromptBrowserUse = (deps: {
  readonly store: Pick<TriggerPreapprovalStore, 'use'> | undefined;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
}) => (source: ExecutionSource | undefined): { readonly preapproval_id: string; readonly uses: number } | undefined => {
  const run = scheduledPromptRunOf(source);
  if (run === undefined || deps.store === undefined) return undefined;
  const op = TRIGGER_PREAPPROVAL_BROWSER_OP;
  const at = (deps.now ?? Date.now)();
  let used: ReturnType<TriggerPreapprovalStore['use']>;
  try {
    used = deps.store.use({
      trigger: run.trigger, recipe_id: run.trigger.schedule_id, recipe_sha256: run.prompt_sha256, op, run_id: run.run_id,
    }, at);
  } catch {
    return undefined; // fail closed: the action asks
  }
  if (used === undefined) return undefined;
  if (deps.auditLog !== undefined) {
    void deps.auditLog.logActivity({
      activity_id: `trigger_preapproval_used_${run.run_id}_${String(at)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: at,
      action: 'trigger_preapproval_used',
      target: used.id,
      detail: JSON.stringify({ run_id: run.run_id, op, trigger: run.trigger, uses: used.uses }),
    }).catch(() => undefined);
  }
  return { preapproval_id: used.id, uses: used.uses };
};

/** What a scheduled prompt's held browser action offers: "Always allow browser actions for this
 *  scheduled prompt", for this prompt's version, on any site. Undefined for any other source. */
export const scheduledPromptBrowserOffer = (source: ExecutionSource | undefined): TriggerPreapprovalOffer | undefined => {
  const run = scheduledPromptRunOf(source);
  return run === undefined ? undefined : {
    trigger: run.trigger, recipe_id: run.trigger.schedule_id, recipe_sha256: run.prompt_sha256,
    op: TRIGGER_PREAPPROVAL_BROWSER_OP, asks_ai: true,
  };
};

/** What a scheduled prompt's held Tier-1 write offers: "Always allow for this scheduled prompt", for
 *  this prompt's version and this write, as the gate would match it. Undefined for any other source
 *  and for a write no pre-approval can name. Its AI decides what it writes, and the ask says so. */
export const scheduledPromptPreapprovalOffer = (
  source: ExecutionSource,
  tool: string,
  args: unknown,
): TriggerPreapprovalOffer | undefined => {
  const run = scheduledPromptRunOf(source);
  const op = run !== undefined ? triggerPreapprovalTier1Op(tool, args) : undefined;
  if (run === undefined || op === undefined) return undefined;
  return {
    trigger: run.trigger, recipe_id: run.trigger.schedule_id, recipe_sha256: run.prompt_sha256, op, asks_ai: true,
  };
};

/** The offer a scheduled prompt's held write is made with: none where no answer could grant it (no
 *  granter here). One rule for the hold's ask and for its card's label, so the card never offers
 *  what the ask does not. */
export const scheduledPromptHoldOffer = (
  deps: { readonly triggerPreapprovalGranter?: unknown },
  source: ExecutionSource,
  tool: string,
  args: unknown,
): TriggerPreapprovalOffer | undefined =>
  deps.triggerPreapprovalGranter !== undefined ? scheduledPromptPreapprovalOffer(source, tool, args) : undefined;

/** That offer's option as the ask shows it and the card repeats it: its label, and what it lets
 *  happen in the ask's own words ("when it runs on its schedule": a scheduled prompt is its own
 *  recipe, as the ask names it). */
export const scheduledPromptHoldAlwaysAllow = (
  deps: { readonly triggerPreapprovalGranter?: unknown },
  source: ExecutionSource,
  tool: string,
  args: unknown,
): { readonly label: string; readonly note: string } | undefined => {
  const offer = scheduledPromptHoldOffer(deps, source, tool, args);
  return offer === undefined ? undefined
    : { label: triggerPreapprovalOfferOption(offer).label, note: describeTriggerPreapprovalOffer(offer, 'it') };
};
