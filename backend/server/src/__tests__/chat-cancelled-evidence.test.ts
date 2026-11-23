import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { ChatMessage, ChatPlanProposal, ToolEntry } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { boundRequestEvidence, cancelledApprovalState, CANCELLED_APPROVAL_LIMITS,
  withoutUnsuccessfulAttemptEchoes, type RequestExecutionEvidence } from '../chat-request-evidence.js';
import { groundingCorpusFromPacket, ungroundedArgumentsInCall } from '../tool-argument-grounding.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const key = new Uint8Array(32).fill(3);
const registry = { getByName: (name: string): ToolEntry | null => name === 'calendar.update'
  ? { name, tier: 1, classification: 'write', description: name, topic_tags: [],
    concurrency_safe: false, arg_schema: { type: 'object' } } : null };
const owner: ChatMessage = { id: 'owner', session_id: 's', turn_id: 'old', target_server: 'self',
  role: 'user', content: 'Change the event.', ts: 1, contributor: 'user',
  picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
  model_used: { provider: 'test', model_id: 'test' } };
const evidence: RequestExecutionEvidence = {
  current_request: { request_id: 'now', message_id: 'now-owner', text: 'Status only.', received_at: 100 },
  successful_calls_for_current_request: [], earlier_requests: [], successful_actions_for_earlier_requests: [],
  recorded_assistant_replies: [],
};
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  createChatStore(db, () => key).createSession({ id: 's', now: 1 });
  let unlocked = true;
  const plans = createSqliteChatPlanStore(db, () => unlocked ? key : null, () => 100);
  const put = async (id: string, created_at = 2, args: unknown = { source_id: 'evt_cancelled_only_735ad' }) => {
    const plan = planApproval.buildPlanProposal({ session_id: 's', turn_id: 'old', tool: 'calendar.update',
      tier: 1, classification: 'write', args, mintId: () => id, now: () => created_at });
    await plans.put(plan); return plan;
  };
  return { db, plans, put, lock: () => { unlocked = false; } };
};
const stateFor = (plans: readonly ChatPlanProposal[], messages: readonly ChatMessage[] = [owner]) =>
  cancelledApprovalState({ observed_at: 100, plans, incomplete: false }, 's', messages, registry, 100);

it('reads cancellation in resolution order without consuming permission or preventing a fresh proposal', async () => {
  const { db, plans, put } = fixture();
  const oldest = await put('oldest', 2), newest = await put('newest', 3);
  await plans.resolve(newest.plan_id, 'cancelled', 4);
  await plans.resolve(oldest.plan_id, 'cancelled', 5);
  const fresh = await put('fresh', 6);
  const changes = db.prepare('SELECT total_changes() AS n').get();
  const rows = await plans.readCancelledEvidenceRows('s');
  expect(rows.plans.map(plan => plan.plan_id)).toEqual(['oldest', 'newest']);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(stateFor(rows.plans).plans[0]).toMatchObject({ plan_id: 'oldest', approval_status: 'cancelled',
    cancellation_reason: 'cancelled', execution_status: 'not_dispatched_by_this_plan', owner_request: { request_id: 'old' } });
  expect((await plans.readCancelledEvidenceRows('other')).plans).toEqual([]);
  await plans.resolve(fresh.plan_id, 'approved', 7);
  expect(await plans.consumeForDispatch!(fresh.plan_id, 8, 'new-owner-request')).toMatchObject({ consumed_at: 8 });
  expect((await plans.get(oldest.plan_id))?.status).toBe('cancelled');
});

it('requires an authorized owner row and sound cancellation metadata, and distinguishes expiry', async () => {
  const { plans, put } = fixture(); const original = await put('cancelled');
  const plan = (await plans.resolve(original.plan_id, 'cancelled', 4))!;
  const excluded = [
    { ...plan, status: 'proposed' as const }, { ...plan, consumed_at: 3 },
    { ...plan, resolved_at: undefined }, { ...plan, resolved_at: 101 },
    { ...plan, resolved_at: 1 }, { ...plan, session_id: 'other' }, { ...plan, tool: 'unregistered' },
  ];
  for (const invalid of excluded) expect(stateFor([invalid]).plans).toEqual([]);
  expect(stateFor([plan], []).incomplete).toBe(true);
  expect(stateFor([plan], [{ ...owner, role: 'assistant' }]).plans).toEqual([]);
  expect(stateFor([{ ...plan, hold: { run_id: 'run', lapsed_at: 4 }, target_instance: 'mail-account-b' }]).plans[0])
    .toMatchObject({ cancellation_reason: 'expired_unanswered', target_instance: 'mail-account-b' });
  expect(cancelledApprovalState(undefined, 's', [], registry, 100))
    .toMatchObject({ observation: 'unavailable', incomplete: true });
});

it('bounds stored history and reports oversized or unreadable evidence as incomplete', async () => {
  const { db, plans, put, lock } = fixture();
  for (let i = 0; i <= CANCELLED_APPROVAL_LIMITS.plans; i++) {
    const plan = await put('p-' + i); await plans.resolve(plan.plan_id, 'cancelled', 3 + i);
  }
  expect(await plans.readCancelledEvidenceRows('s')).toMatchObject({ incomplete: true });
  expect((await plans.readCancelledEvidenceRows('s')).plans).toHaveLength(CANCELLED_APPROVAL_LIMITS.plans);
  const large = await put('large', 2, { body: 'x'.repeat(CANCELLED_APPROVAL_LIMITS.storedBytes) });
  await plans.resolve(large.plan_id, 'cancelled', 30);
  const corrupt = await put('corrupt'); await plans.resolve(corrupt.plan_id, 'cancelled', 31);
  db.prepare('UPDATE chat_plans SET args_encrypted=? WHERE plan_id=?').run('invalid', corrupt.plan_id);
  expect((await plans.readCancelledEvidenceRows('s')).plans.map(p => p.plan_id)).not.toContain('large');
  expect((await plans.readCancelledEvidenceRows('s')).plans.map(p => p.plan_id)).not.toContain('corrupt');
  lock();
  expect(await plans.readCancelledEvidenceRows('s')).toMatchObject({ incomplete: true, plans: [] });
});

it.each(['proposed', 'cancelled'] as const)('marks one corrupt %s row incomplete even without overflow', async status => {
  const { db, plans, put } = fixture(); const plan = await put('corrupt');
  if (status === 'cancelled') await plans.resolve(plan.plan_id, 'cancelled', 3);
  db.prepare('UPDATE chat_plans SET args_encrypted=? WHERE plan_id=?').run('invalid', plan.plan_id);
  const rows = status === 'cancelled' ? await plans.readCancelledEvidenceRows('s') : await plans.readPendingEvidenceRows('s');
  expect(rows).toMatchObject({ plans: [], incomplete: true });
});

it('does not grant identifiers from a cancelled plan\'s unexecuted arguments', async () => {
  const { plans, put } = fixture(); const plan = await put('cancelled');
  const state = stateFor([(await plans.resolve(plan.plan_id, 'cancelled', 4))!]);
  const raw = JSON.stringify({ request_execution_context: { ...evidence, cancelled_approvals: state } });
  const grounded = withoutUnsuccessfulAttemptEchoes(raw);
  expect(raw).toContain('evt_cancelled_only_735ad');
  expect(grounded).not.toContain('evt_cancelled_only_735ad');
  expect(ungroundedArgumentsInCall({ source_id: 'evt_cancelled_only_735ad' }, groundingCorpusFromPacket(grounded),
    { tool: 'calendar.get', packet: grounded }).length).toBeGreaterThan(0);
  const bounded = boundRequestEvidence({ ...evidence, cancelled_approvals: state }, false, 600)!;
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(600);
  expect(bounded.cancelled_approvals?.incomplete ?? bounded.coverage?.incomplete).toBe(true);
});
