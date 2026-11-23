import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ChatMessage, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { STANDARD_BRIEF_ACTION_GUIDANCE } from '../chat-turn-executor.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages, parseStoredBrief } from '../chat-rolling-brief.js';
import { approvedActionState, boundRequestEvidence, pendingApprovalState, PENDING_APPROVAL_LIMITS,
  withoutUnsuccessfulAttemptEchoes, type RequestExecutionEvidence } from '../chat-request-evidence.js';
import { groundingCorpusFromPacket, ungroundedArgumentsInCall } from '../tool-argument-grounding.js';

const databases: Database.Database[] = [];
beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const at = 1_800_000_000_000;
const key = new Uint8Array(32).fill(8);
const entry: ToolEntry = { name: 'calendar.update', tier: 1, classification: 'write',
  description: 'Change the summary of an event.', topic_tags: [], concurrency_safe: false,
  arg_schema: { type: 'object', properties: { source_id: { type: 'string' }, summary: { type: 'string' } },
    required: ['source_id', 'summary'], additionalProperties: false } };
const registry: InternalToolRegistry = { getByName: name => name === entry.name ? entry : null,
  list: () => [entry], listByTier: () => [entry], subscribeRefresh: () => () => {},
  dispatch: async () => { throw new Error('This status-only test must not write'); } };
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  const chat = createChatStore(db, () => key);
  chat.createSession({ id: 's', now: at }); chat.createSession({ id: 'other', now: at });
  const plans = createSqliteChatPlanStore(db, () => key, () => at + 100);
  let n = 0;
  const put = async (args: Record<string, unknown> = { source_id: 'evt_proposal_only_735ad', summary: 'New summary' },
    extra: { session_id?: string; held?: boolean } = {}) => {
    const id = ++n;
    const proposal = planApproval.buildPlanProposal({ session_id: extra.session_id ?? 's', turn_id: 'owner-' + id,
      tool: entry.name, tier: 1, classification: 'write', args, mintId: () => 'plan-' + id, now: () => at,
      ...(extra.held ? { hold: { run_id: 'run-' + id } } : {}) });
    const stored = { ...proposal, ...(extra.held ? { hold: { run_id: 'run-' + id } } : {}) };
    await plans.put(stored); return stored;
  };
  return { db, chat, plans, put };
};
const currentEvidence = (): RequestExecutionEvidence => ({
  current_request: { request_id: 'now', message_id: 'owner-now', text: 'Continue.', received_at: at + 100 },
  successful_calls_for_current_request: [], earlier_requests: [], successful_actions_for_earlier_requests: [],
  recorded_assistant_replies: [],
});

it('reads pending approvals without mutation and observes subsequent approval and cancellation', async () => {
  const { db, plans, put } = fixture();
  const approved = await put(), cancelled = await put({ source_id: 'evt_b', summary: 'B' });
  const changes = db.prepare('SELECT total_changes() AS n').get();
  expect((await plans.readPendingEvidenceRows('s')).plans).toHaveLength(2);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  await plans.resolve(approved.plan_id, 'approved', at + 1);
  await plans.resolve(cancelled.plan_id, 'cancelled', at + 1);
  expect(pendingApprovalState(await plans.readPendingEvidenceRows('s'), 's', [], registry, at + 100))
    .toMatchObject({ observation: 'available', incomplete: false, plans: [] });
  expect((await plans.get(approved.plan_id))?.consumed_at).toBeUndefined();
  expect((await plans.readPendingEvidenceRows('s')).approved_plans?.map(plan => plan.plan_id)).toEqual([approved.plan_id]);
});

it('projects approved, unconsumed work without inventing execution, original identifier evidence or a new owner request', async () => {
  const { plans, put } = fixture(); const plan = await put(); await plans.resolve(plan.plan_id, 'approved', at + 1);
  const owner: ChatMessage = { id: 'original', session_id: 's', turn_id: plan.turn_id, role: 'user',
    content: 'Change this event.', ts: at, target_server: 'self', contributor: 'user',
    picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
    model_used: { provider: 'test', model_id: 'test' } };
  const rows = await plans.readPendingEvidenceRows('s');
  const state = approvedActionState(rows, 's', [owner], registry, at + 100);
  expect(state).toMatchObject({ observation: 'available', incomplete: false,
    actions: [{ plan_id: plan.plan_id, approval_status: 'approved', execution_status: 'not_dispatched',
      execution_on_continuation: 'later_dispatch', effect_confirmation: 'not_established_by_approval',
      owner_request: { text: owner.content } }] });
  const evidence = { ...currentEvidence(), approved_actions: state };
  const visible = JSON.stringify({ request_execution_context: evidence });
  expect(visible).toContain('evt_proposal_only_735ad');
  expect(withoutUnsuccessfulAttemptEchoes(visible)).not.toContain('evt_proposal_only_735ad');
  const bounded = boundRequestEvidence(evidence, false, 600)!;
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(600);
  expect(bounded.approved_actions?.incomplete ?? bounded.coverage?.incomplete).toBe(true);
  expect(approvedActionState(undefined, 's', [owner], registry, at + 100)).toMatchObject({ observation: 'unavailable', actions: [] });
  for (const invalid of [ { ...plan, status: 'cancelled' as const },
    { ...plan, status: 'approved' as const, resolved_at: at + 1, consumed_at: at + 2 },
    { ...plan, status: 'approved' as const, resolved_at: at + 101 },
    { ...plan, status: 'approved' as const, resolved_at: at + 1, hold: { run_id: 'expired', lapsed_at: at + 2 } } ]) {
    expect(approvedActionState({ ...rows, approved_plans: [invalid] }, 's', [owner], registry, at + 100).actions).toEqual([]);
  }
  expect(approvedActionState(rows, 'other', [owner], registry, at + 100).actions).toEqual([]);
  expect(approvedActionState(rows, 's', [], registry, at + 100).actions).toEqual([]);
  expect(approvedActionState(rows, 's', [owner], { getByName: () => null }, at + 100).actions).toEqual([]);
  const expired = createSqliteChatPlanStore(databases.at(-1)!, () => key,
    () => at + planApproval.PLAN_APPROVAL_CONSUMPTION_TTL_MS + 2);
  expect((await expired.readPendingEvidenceRows('s')).approved_plans).toEqual([]);
});

it('recovers the original approved owner outside the recent window, then dispatches once through the native gate', async () => {
  const { db, chat, plans, put } = fixture(); const plan = await put({ source_id: 'evt_native_735ad', summary: 'New summary' });
  const original = 'Change event evt_native_735ad to New summary.';
  for (let i = 0; i < 21; i++) await chat.appendMessage({ id: 'approved-owner-' + i, session_id: 's',
    turn_id: i === 0 ? plan.turn_id : 'aged-' + i, role: 'user', content: i === 0 ? original : 'Another status question.',
    ts: at + i, target_server: 'self',
    source_lifecycle: 'finalized', execution_source: { channel: 'chat', actor: 'user_self',
      chat_session_id: 's', turn_id: i === 0 ? plan.turn_id : 'aged-' + i, user_id: 'local-owner' },
    picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
    model_used: { provider: 'test', model_id: 'test' } });
  await plans.resolve(plan.plan_id, 'approved', at + 1);
  let writes = 0, calls = 0, n = 0, time = at + 100;
  const packets: RequestExecutionEvidence[] = [];
  const local: InternalToolRegistry = { ...registry, dispatch: async () => { writes++; return { ok: true, result: { updated: true } }; } };
  const store = createChatStore(db, () => key);
  await createChatOrchestrator({ chatStore: store, registry: local, planApprovalStore: plans,
    readPendingApprovalRows: id => plans.readPendingEvidenceRows(id),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' }, mintId: () => 'approved-native-' + (++n),
    now: () => ++time, broadcast: { emit: () => {} }, executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        return { body: { intent: 'Update the event.', constraints: [], pending: [], findings: [] } };
      }
      packets.push(packet.request_execution_context); calls++;
      return { body: { response: calls === 1 ? '' : 'The event was updated.', events: [],
        tool_calls: calls === 1 ? [{ tool: entry.name, args: plan.args }] : [] } };
    } }).runTurn({ session_id: 's', message: 'Continue the original update for event evt_native_735ad.', picker_state: { current: 'self' } });
  expect(packets[0]?.approved_actions?.actions).toEqual([expect.objectContaining({ plan_id: plan.plan_id,
    owner_request: expect.objectContaining({ text: original }) })]);
  expect(packets[1]).not.toHaveProperty('approved_actions'); // spent: an empty state is left out
  expect(writes).toBe(1); expect((await plans.get(plan.plan_id))?.consumed_at).toBeDefined();
  expect(await plans.listPending('s')).toEqual([]);
});

it('keeps session, catalog, request identity and held-resume semantics separate', async () => {
  const { plans, put } = fixture();
  const plain = await put(), held = await put(undefined, { held: true });
  await put({ source_id: 'secret', summary: 'Private' }, { session_id: 'other' });
  const owner: ChatMessage = { id: 'owner', session_id: 's', turn_id: plain.turn_id, target_server: 'self',
    role: 'user', content: 'Change this event.', ts: at, contributor: 'user',
    picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
    model_used: { provider: 'test', model_id: 'test' } };
  const rows = await plans.readPendingEvidenceRows('s');
  const state = pendingApprovalState(rows, 's', [owner], registry, at + 100);
  expect(state.plans).toHaveLength(2); // Matching arguments do not merge two proposals.
  expect(state.plans.find(p => p.plan_id === plain.plan_id)).toMatchObject({
    execution_on_approval: 'later_dispatch', owner_request: { text: 'Change this event.' } });
  expect(state.plans.find(p => p.plan_id === held.plan_id)).toMatchObject({ execution_on_approval: 'host_resume' });
  expect(pendingApprovalState(rows, 'other', [], registry, at + 100).plans).toEqual([]);
  expect(pendingApprovalState(rows, 's', [], { getByName: () => null }, at + 100).plans).toEqual([]);
});

it('bounds encrypted reads and distinguishes incomplete or unavailable evidence from an empty list', async () => {
  const { db, plans, put } = fixture();
  for (let i = 0; i <= PENDING_APPROVAL_LIMITS.plans; i++) await put({ source_id: 'evt_' + i });
  expect(await plans.readPendingEvidenceRows('s')).toMatchObject({ incomplete: true });
  expect((await plans.readPendingEvidenceRows('s')).plans).toHaveLength(PENDING_APPROVAL_LIMITS.plans);
  const large = await put({ body: 'x'.repeat(PENDING_APPROVAL_LIMITS.storedBytes) });
  const corrupt = await put();
  db.prepare('UPDATE chat_plans SET args_encrypted=? WHERE plan_id=?').run('invalid', corrupt.plan_id);
  const rows = await plans.readPendingEvidenceRows('s');
  expect(rows.incomplete).toBe(true);
  expect(rows.plans.some(p => p.plan_id === large.plan_id || p.plan_id === corrupt.plan_id)).toBe(false);
  expect(pendingApprovalState(undefined, 's', [], registry, at + 100))
    .toMatchObject({ observation: 'unavailable', incomplete: true });
  const state = pendingApprovalState(rows, 's', [], registry, at + 100);
  const bounded = boundRequestEvidence({ ...currentEvidence(), pending_approvals: state }, false, 600)!;
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(600);
  expect(bounded.pending_approvals?.incomplete ?? bounded.coverage?.incomplete).toBe(true);
});

it('recovers identifier authority from an original owner record, not a recalled failed invocation', () => {
  const identifier = 'evt_failed_echo_735ad';
  const recalled = (kind: 'tool' | 'user', content: string) => JSON.stringify({
    recall_context: [{ tool_name: 'recall.search', status: 'ok', result: { ok: true,
      matches: [{ source: 'interaction', kind, item_id: 'original', completeness: 'complete', content }] } }],
  });
  const allowed = (body: string) => {
    const packet = withoutUnsuccessfulAttemptEchoes(body);
    return ungroundedArgumentsInCall({ source_id: identifier }, groundingCorpusFromPacket(packet),
      { tool: 'calendar.get', packet }).length === 0;
  };
  expect(allowed(recalled('tool', `calendar.update({"source_id":"${identifier}"}): {"ok":false}`))).toBe(false);
  expect(allowed(recalled('user', `Change the event with source_id "${identifier}".`))).toBe(true);
});

// A chat with the note on reads the records (`chat-standard-note-absorbed.test.ts`); one with the note off and a
// contract turn read none.
it.each(['disabled', 'contract'] as const)('does not read owner evidence for %s chat', async mode => {
  const { chat } = fixture();
  chat.setRollingBriefEnabled(mode !== 'disabled');
  let reads = 0, calls = 0;
  const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
    calls++;
    expect(JSON.parse(String(input['llm.prompt'])).request_execution_context).toBeUndefined();
    expect(input['llm.system_prompt']).not.toContain(STANDARD_BRIEF_ACTION_GUIDANCE);
    return { body: { response: 'Hello.', events: [], tool_calls: [] } };
  };
  const orchestrator = createChatOrchestrator({
    chatStore: { ...chat, readRequestEvidenceWindow: async () => {
      reads++; return { messages: [], incomplete: false, excluded_reply_turn_ids: [] };
    } }, registry,
    readCancelledApprovalRows: async () => { reads++; throw new Error('Owner cancellation evidence must stay out of this surface'); },
    readCompletedHeldActionRows: async () => { reads++; throw new Error('Owner completion evidence must stay out of this surface'); },
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' },
    broadcast: { emit: () => {} },
    executeAiCall,
  });
  if (mode === 'contract') {
    await orchestrator.runLlmGatewayTurn!({ session_id: 's', user_id: 'customer', contract_id: 'contract-a',
      content: { chat_tail: [], user_message: 'Hello.' }, allowed_tool_names: [],
      resolve_contract_snapshot: () => null, execute_ai_call: executeAiCall, model_layer: 'byok' });
  } else {
    await orchestrator.runTurn({ session_id: 's', message: 'Hello.', picker_state: { current: 'self' } });
  }
  expect(reads).toBe(0); expect(calls).toBe(1);
});

it('uses native pending state in reader packets, then retires it after cancellation and reload', async () => {
  const { db, chat, plans } = fixture(); chat.setRollingBriefEnabled(true);
  const packets: RequestExecutionEvidence[] = [];
  let n = 0, first = true, folds = 0, time = at;
  const create = () => createChatOrchestrator({
    chatStore: createChatStore(db, () => key), registry, planApprovalStore: plans,
    readPendingApprovalRows: id => plans.readPendingEvidenceRows(id),
    readCancelledApprovalRows: id => plans.readCancelledEvidenceRows(id),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' },
    mintId: () => 'native-' + (++n), now: () => ++time, broadcast: { emit: () => {} },
    executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        folds++;
        return { body: { intent: 'Wait for approval.', constraints: [], pending: ['The summary change awaits approval.'], findings: [] } };
      }
      expect(input['llm.system_prompt']).toContain(STANDARD_BRIEF_ACTION_GUIDANCE);
      packets.push(packet.request_execution_context);
      if (first) { first = false; return { body: { response: '', events: [],
        tool_calls: [{ tool: 'calendar.update', args: { source_id: 'evt_native_735ad', summary: 'New summary' } }] } }; }
      return { body: { response: 'No change was executed.', events: [], tool_calls: [], nothing_outstanding: true } };
    },
  });
  await create().runTurn({ session_id: 's',
    message: 'Change the summary of event with source_id "evt_native_735ad" to "New summary".',
    picker_state: { current: 'self' } });
  const pending = await plans.readPendingEvidenceRows('s');
  expect(pending.plans).toHaveLength(1); expect(folds).toBeGreaterThan(0);
  expect(parseStoredBrief(JSON.parse((await chat.readSessionBrief('s'))!))?.intent).toBe('Wait for approval.');
  await plans.resolve(pending.plans[0]!.plan_id, 'cancelled', ++time);
  // Age the original request out of the recent window; the closed-plan anchor
  // must recover the actual authorized owner row rather than trusting arguments.
  for (let i = 0; i < 20; i++) {
    await chat.appendMessage({ id: 'aged-' + i, session_id: 's', turn_id: 'aged-' + i,
      role: 'user', content: 'Another status question.', ts: ++time, target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
      model_used: { provider: 'test', model_id: 'test' }, source_lifecycle: 'finalized',
      execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', turn_id: 'aged-' + i, user_id: 'local-owner' } });
  }
  __clearSessionBriefs(); __clearUnfoldedUserMessages();
  packets.length = 0;
  await create().runTurn({ session_id: 's', message: 'What is the status?', picker_state: { current: 'self' } });
  expect(packets[0]).not.toHaveProperty('pending_approvals'); // none pending: an empty state is left out
  expect(packets[0]?.cancelled_approvals?.plans).toEqual([expect.objectContaining({
    plan_id: pending.plans[0]!.plan_id, approval_status: 'cancelled',
    owner_request: expect.objectContaining({ text: 'Change the summary of event with source_id "evt_native_735ad" to "New summary".' }),
  })]);
  expect((await plans.get(pending.plans[0]!.plan_id))?.status).toBe('cancelled');
});
