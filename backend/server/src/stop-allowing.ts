/** D-402 slice F4 (§7.9, ruling 12) — "Stop allowing": end, at once, every standing permission one caller
 *  holds for one recipe, so nothing lets it run that recipe's writes without asking any more.
 *
 *  A caller is the owner's chats or one AI app (its contract). What it ends, for that caller and that
 *  recipe:
 *  - its pre-approvals, every version, and a live one-run row (`trigger_preapprovals`, F2);
 *  - its site passes for the recipe (D-335 slice F);
 *  - its session grants pinned to the recipe, "Allow in this chat" among them (D-177);
 *  - its delegation rules and quality delegations pinned to the recipe (D-177 N.13, D-202);
 *  - its write rules that name the recipe (D-329: the recipe a schedule runs).
 *  All of these apply before a pre-approval, so ending less would leave the recipe running unasked.
 *  Each is checked at every write, so a run already going asks at its next one.
 *
 *  The chat's "Don't ask about browser actions" switch belongs to the conversation, not the recipe, so
 *  it is not ended here: a run it let through says so, and the switch turns it off.
 *
 *  Never an approval: a revoke only removes. Never a grant: nothing here adds a permission. Audited
 *  once (`stop_allowing`), with what it ended. */

import {
  isContractActive,
  samePreapprovalCaller,
  type ContractDefinition,
  type PreapprovalCaller,
  type StopAllowingResult,
  type WriteRulePrincipal,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { BrowserPassStore } from './storage/browser-pass-store.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { TriggerPreapprovalStore } from './storage/trigger-preapproval-store.js';
import type { WriteRuleStore } from './storage/write-rule-store.js';

export interface StopAllowingDeps {
  readonly preapprovals?: Pick<TriggerPreapprovalStore, 'listCallers' | 'revokeCaller'>;
  readonly browserPasses?: Pick<BrowserPassStore, 'listPasses' | 'revoke'>;
  readonly definitions?: Pick<ContractDefinitionStore, 'list' | 'revokeSessionGrant' | 'revoke'>;
  readonly writeRules?: Pick<WriteRuleStore, 'listRules' | 'revoke'>;
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'>;
  readonly now?: () => number;
}


/** Who asked for it: the owner (in the app, a chat, or a run's result) or the AI app itself. */
export type StopAllowingBy = 'owner_app' | 'owner_chat' | 'run_result' | 'ai_app';

/** Whether a principal as a pass or a write rule names it is this caller. */
const isCaller = (principal: WriteRulePrincipal, caller: PreapprovalCaller): boolean =>
  principal.kind === caller.kind && (caller.kind === 'owner_chat' || (principal.kind === 'ai_app' && principal.contract_id === caller.contract_id));

/** Whether a grant is this caller's: an AI app's is bound to its contract; the owner's chats' is bound
 *  to none, and was made in a chat or a messenger (its conversation), or names them in its scope. */
const grantIsCallers = (def: ContractDefinition, caller: PreapprovalCaller): boolean => {
  const bound = def.bound_contract_id ?? undefined;
  if (caller.kind === 'ai_app') return bound === caller.contract_id;
  if (bound !== undefined) return false;
  if (def.channel_session_id !== undefined) return /^(chat|messenger):/u.test(def.channel_session_id);
  const channels = (def.scope as { channels?: readonly string[] } | undefined)?.channels ?? [];
  const actors = (def.scope as { actors?: readonly string[] } | undefined)?.actors;
  return channels.some((channel) => channel === 'chat' || channel === 'messenger') && (actors === undefined || actors.includes('user_self'));
};

/** End every standing permission `caller` holds for `recipe_id`, now. Each kind it cannot reach (no store
 *  wired) is left as it is and counts 0. Idempotent: what is already ended is not counted again. */
export const stopAllowing = (
  deps: StopAllowingDeps,
  input: { readonly caller: PreapprovalCaller; readonly recipe_id: string; readonly by: StopAllowingBy },
): StopAllowingResult => {
  const now = deps.now?.() ?? Date.now();
  const { caller, recipe_id } = input;
  let preapprovals = 0;
  for (const row of deps.preapprovals?.listCallers() ?? []) {
    if (row.revoked_at !== undefined || row.recipe_id !== recipe_id || !samePreapprovalCaller(row.caller, caller)) continue;
    deps.preapprovals!.revokeCaller(row.id, now);
    preapprovals += 1;
  }
  let site_passes = 0;
  for (const pass of deps.browserPasses?.listPasses(now) ?? []) {
    if (pass.key.recipe !== recipe_id || !isCaller(pass.key.principal, caller)) continue;
    deps.browserPasses!.revoke(pass.pass_id, now);
    site_passes += 1;
  }
  let session_grants = 0;
  let delegations = 0;
  for (const def of deps.definitions?.list() ?? []) {
    if (def.bound_recipe?.recipe_id !== recipe_id || !isContractActive(def, now) || !grantIsCallers(def, caller)) continue;
    if (def.grant_kind === 'session') {
      if (deps.definitions!.revokeSessionGrant(def.contract_id) !== null) session_grants += 1;
    } else if (def.grant_kind === 'delegation' || def.grant_kind === 'quality_delegation') {
      if (deps.definitions!.revoke(def.contract_id, 'stop-allowing') !== null) delegations += 1;
    }
  }
  let write_rules = 0;
  for (const rule of deps.writeRules?.listRules(now) ?? []) {
    if (rule.key.scope !== recipe_id || !isCaller(rule.key.principal, caller)) continue;
    deps.writeRules!.revoke(rule.rule_id, now);
    write_rules += 1;
  }
  const result = { preapprovals, site_passes, session_grants, delegations, write_rules };
  void deps.auditLog?.logActivity({
    activity_id: `stop_allowing_${String(now)}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now,
    action: 'stop_allowing',
    target: recipe_id,
    detail: JSON.stringify({ caller, by: input.by, ended: result }),
  }).catch(() => undefined);
  return result;
};

/** How many permissions it ended in all. */
export const stoppedCount = (result: StopAllowingResult): number =>
  result.preapprovals + result.site_passes + result.session_grants + result.delegations + result.write_rules;
