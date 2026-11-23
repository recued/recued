import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { ChatMessage, ChatPlanProposal, ToolEntry } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createSqliteGatedActionChangeClock } from '../gated-action-store.js';
import { boundRequestEvidence, completedHeldActionState, COMPLETED_HELD_ACTION_LIMITS,
  withoutUnsuccessfulAttemptEchoes, type CompletedHeldActionRows,
  type RequestExecutionEvidence } from '../chat-request-evidence.js';
import { groundingCorpusFromPacket, ungroundedArgumentsInCall } from '../tool-argument-grounding.js';
import { heldChatFixture } from './held-chat-write-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';

const databases: Database.Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
});
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
  const put = async (id: string, turn_id = 'old', args: unknown = { source_id: 'evt_completed_735ad', summary: 'evt_freeform_985ab' }) => {
    const plan = planApproval.buildPlanProposal({ session_id: 's', turn_id, tool: 'calendar.update',
      tier: 1, classification: 'write', args, mintId: () => id, now: () => 2 });
    await plans.put({ ...plan, hold: { run_id: 'run-' + id } }); return plan;
  };
  const complete = async (plan: ChatPlanProposal) => {
    await plans.resolve(plan.plan_id, 'approved', 3);
    await plans.consumeForDispatch!(plan.plan_id, 4, plan.turn_id);
    await plans.recordExecution!(plan.plan_id, { status: 'completed', turn_id: plan.turn_id,
      run_id: 'run-' + plan.plan_id, result_ref: 'held-write:' + plan.plan_id });
  };
  return { db, plans, put, complete, lock: () => { unlocked = false; } };
};
const stateFor = (rows: CompletedHeldActionRows, messages: readonly ChatMessage[] = [owner]) =>
  completedHeldActionState(rows, 's', messages, registry, 100);

it('reads only durable completed held executions and keeps identical actions tied to separate requests', async () => {
  const { db, plans, put, complete } = fixture();
  const first = await put('first'), second = await put('second', 'another');
  await complete(first); await complete(second);
  const pending = await put('pending'), approved = await put('approved'), denied = await put('denied');
  await plans.resolve(approved.plan_id, 'approved', 3); await plans.resolve(denied.plan_id, 'cancelled', 3);
  const uncertain = await put('uncertain');
  await plans.resolve(uncertain.plan_id, 'approved', 3);
  await plans.consumeForDispatch!(uncertain.plan_id, 4, uncertain.turn_id);
  await plans.recordExecution!(uncertain.plan_id, { status: 'unknown', turn_id: uncertain.turn_id });
  const changes = db.prepare('SELECT total_changes() AS n').get();
  const rows = await plans.readCompletedHeldEvidenceRows('s');
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(rows.records.map(r => r.plan.plan_id)).toEqual(['second', 'first']);
  expect(rows.incomplete).toBe(true); // The unknown dispatch is not an empty success observation.
  const state = stateFor(rows, [owner, { ...owner, id: 'owner-2', turn_id: 'another' }]);
  expect(state.actions.map(a => a.completed_for_request_id)).toEqual(['another', 'old']);
  expect(state.actions[0]?.args).toEqual(state.actions[1]?.args);
  expect((await plans.readCompletedHeldEvidenceRows('elsewhere')).records).toEqual([]);
  expect((await plans.get(pending.plan_id))?.consumed_at).toBeUndefined();
  expect((await plans.get(approved.plan_id))?.consumed_at).toBeUndefined();
});

it('requires original owner authority and consistent consumed approval, run identity and times', async () => {
  const { plans, put, complete } = fixture(); await complete(await put('done'));
  const rows = await plans.readCompletedHeldEvidenceRows('s'), record = rows.records[0]!;
  const badPlans: ChatPlanProposal[] = [
    { ...record.plan, status: 'proposed' }, { ...record.plan, consumed_at: undefined },
    { ...record.plan, resolved_at: 5 }, { ...record.plan, hold: undefined },
    { ...record.plan, hold: { run_id: 'wrong' } }, { ...record.plan, hold: { run_id: 'run-done', lapsed_at: 3 } },
    { ...record.plan, created_at: 0 }, { ...record.plan, session_id: 'other' }, { ...record.plan, tool: 'unknown' },
  ];
  for (const plan of badPlans) expect(stateFor({ ...rows, records: [{ ...record, plan }] }).actions).toEqual([]);
  for (const execution of [{ ...record.execution, turn_id: 'wrong' }, { ...record.execution, run_id: undefined }]) {
    expect(stateFor({ ...rows, records: [{ ...record, execution }] }).actions).toEqual([]);
  }
  expect(stateFor({ ...rows, observed_at: 99 }).actions).toEqual([]);
  expect(stateFor(rows, [{ ...owner, role: 'system' }]).actions).toEqual([]);
  expect(completedHeldActionState(undefined, 's', [], registry, 100))
    .toMatchObject({ observation: 'unavailable', incomplete: true, actions: [] });
});

it('bounds native reads and reports locked, corrupt or oversized receipt payloads as incomplete', async () => {
  const { db, plans, put, complete, lock } = fixture();
  for (let i = 0; i <= COMPLETED_HELD_ACTION_LIMITS.plans; i++) await complete(await put('p-' + i));
  const bounded = await plans.readCompletedHeldEvidenceRows('s');
  expect(bounded.records).toHaveLength(COMPLETED_HELD_ACTION_LIMITS.plans); expect(bounded.incomplete).toBe(true);
  const oversized = await put('large', 'old', { summary: 'x'.repeat(COMPLETED_HELD_ACTION_LIMITS.storedBytes) });
  await complete(oversized); await complete(await put('corrupt'));
  db.prepare('UPDATE chat_plans SET execution_blob_encrypted=? WHERE plan_id=?').run('invalid', 'corrupt');
  const rows = await plans.readCompletedHeldEvidenceRows('s');
  expect(rows.records.map(r => r.plan.plan_id)).not.toContain('corrupt');
  expect(rows.records.map(r => r.plan.plan_id)).not.toContain('large');
  lock(); expect(await plans.readCompletedHeldEvidenceRows('s')).toMatchObject({ records: [], incomplete: true });
});

it.each(['interrupted', 'restored', 'changed-journal'] as const)('validates native local proof after %s', async mode => {
  const c = await heldChatFixture();
  const { plan } = await c.ask('calendar.update', { calendar_id: 'local', source_id: 'meeting', summary: 'Confirmed' });
  await c.answer('approve'); const card = await c.card(plan.plan_id);
  expect(card.execution).toMatchObject({ status: 'completed', local_receipt: { kind: 'local_calendar' } });
  if (mode === 'interrupted') c.f.db.prepare("UPDATE chat_plans SET execution_status='unknown',execution_blob_encrypted=NULL WHERE plan_id=?").run(plan.plan_id);
  else if (mode === 'restored') createSqliteGatedActionChangeClock(c.f.db).rotateEpoch();
  else c.f.db.prepare("UPDATE local_mutation_receipts SET data='{}' WHERE owner_ref=?").run(plan.plan_id);
  const rows = await c.plans.readCompletedHeldEvidenceRows(c.session_id);
  if (mode === 'interrupted') expect(rows.records[0]?.execution).toMatchObject({ status: 'completed', recovered_from: 'unknown',
    local_receipt: card.execution?.status === 'completed' ? card.execution.local_receipt : undefined });
  else expect(rows).toMatchObject({ records: [], incomplete: true });
});

it('limits identifier authority to a completed action\'s fresh verified argument identifiers', async () => {
  const { plans, put, complete } = fixture(); await complete(await put('done'));
  const state = stateFor(await plans.readCompletedHeldEvidenceRows('s'));
  const raw = JSON.stringify({ request_execution_context: { ...evidence, completed_held_actions: state } });
  const grounded = withoutUnsuccessfulAttemptEchoes(raw);
  expect(grounded).toContain('evt_completed_735ad');
  expect(grounded).not.toContain('held-write:done'); expect(grounded).not.toContain('run-done');
  const bounded = boundRequestEvidence({ ...evidence, completed_held_actions: state }, false, 600)!;
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(600);
  expect(bounded.completed_held_actions?.incomplete ?? bounded.coverage?.incomplete).toBe(true);
});
