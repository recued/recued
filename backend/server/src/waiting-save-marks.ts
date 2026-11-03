/** D-336 — a save, once held, marks the saves still waiting for the owner that it asks again
 *  ("Asked again", slice O's open item) or contradicts ("Contradicts what was asked", slice S).
 *
 *  Slice O told a held save of the saves of the same fact waiting beside it ("Asked already"),
 *  but the earlier save's card named none of the later ones, so approving the newest first left
 *  the oldest unmarked. Once a save is held, a chat's or an AI app's, each held chat save of the
 *  same fact still waiting gains "Asked again: <the later save's summary>" on its card, kept
 *  with its proposal and sent to the cards open now (the owner, 2026-11-01: "Asked again"). An
 *  ask already delivered (Telegram, email, the approval list's own text) is not changed. The same
 *  fact is the same claim key, keyed by the owner's lookups, as slice O compares them.
 *
 *  Slice S: a held save that one still waiting contradicts marks it too, "Contradicts what was
 *  asked" (`contradicts_asked`), by the rule a note in memory is contradicted
 *  (`claimsContradict`). The later save's own card lists it when held. */

import { memoryClaimKey, type ChatPlanProposal } from '@recued/contracts';
import type { planApproval } from '@recued/gateway';

import type { BroadcastChatEvent, ChatBroadcastEmitter } from './chat-orchestrator.js';
import { claimOfCall, claimsContradict, type ClaimRecordLookups } from './memory-claim.js';

export interface WaitingSaveMarkerDeps {
  readonly plans: Pick<planApproval.PlanApprovalStore, 'listPendingRecords' | 'addMemoryConflict'>;
  readonly broadcast: ChatBroadcastEmitter;
  readonly ownerRecords: () => ClaimRecordLookups;
}

/** A proposal's card as `chat.plan_proposed` carries it, which an open card takes its
 *  conflicts from again (the chat's reducer keeps everything else as it was). */
export const planProposedEventOf = (plan: ChatPlanProposal): BroadcastChatEvent => ({
  kind: 'chat.plan_proposed',
  session_id: plan.session_id,
  turn_id: plan.turn_id,
  plan_id: plan.plan_id,
  ...(plan.retry_of_plan_id !== undefined ? { retry_of_plan_id: plan.retry_of_plan_id } : {}),
  tool: plan.tool,
  tier: plan.tier,
  ...(plan.resource_review ? { resource_review: plan.resource_review } : {}),
  args: plan.args,
  args_hash: plan.args_hash,
  created_at: plan.created_at,
  ...(plan.hold !== undefined ? { held: true as const } : {}),
  ...(plan.value_labels !== undefined ? { value_labels: plan.value_labels } : {}),
  ...(plan.hold !== undefined && plan.editable_args !== undefined ? { editable_args: plan.editable_args } : {}),
  ...(plan.memory_conflicts !== undefined ? { memory_conflicts: plan.memory_conflicts } : {}),
} as BroadcastChatEvent);

export const createWaitingSaveMarker = (deps: WaitingSaveMarkerDeps) =>
  async (call: { tool: string; args: Record<string, unknown>; run_id: string }): Promise<void> => {
    if (call.tool !== 'memory.write' || deps.plans.listPendingRecords === undefined || deps.plans.addMemoryConflict === undefined) return;
    const records = deps.ownerRecords();
    const claim = claimOfCall(call.args.claim, records);
    const summary = typeof call.args.summary === 'string' ? call.args.summary.trim() : '';
    if (claim === undefined || summary === '') return;
    const key = memoryClaimKey(claim);
    for (const { plan } of await deps.plans.listPendingRecords()) {
      // Its own card is the save just held; any other held save of the fact, any session's.
      if (plan.tool !== 'memory.write' || plan.hold === undefined || plan.hold.run_id === call.run_id) continue;
      const theirs = claimOfCall((plan.args as { claim?: unknown } | null | undefined)?.claim, records);
      if (theirs === undefined) continue;
      const kind = memoryClaimKey(theirs) === key ? 'asked_again' as const
        : claimsContradict(claim, theirs) ? 'contradicts_asked' as const : undefined;
      if (kind === undefined) continue;
      const updated = await deps.plans.addMemoryConflict(plan.plan_id, { kind, summary });
      if (updated !== undefined) {
        try { deps.broadcast.emit(planProposedEventOf(updated)); } catch { /* the card catches up on its next read */ }
      }
    }
  };
