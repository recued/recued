/** An approved held write that ran without a confirmed result is a record of its own (2026-11-19). It was in none:
 *  `readCompletedHeldEvidenceRows` skipped a `failed` receipt and an `unknown` one only marked the completed list
 *  incomplete, and the continuation that reports the outcome read no records at all (its turn has no owner
 *  message). Measured: after a rename whose dispatch errored, the model read the event, saw the new title and said
 *  the rename succeeded, in that continuation and again on later turns (6 of 6 runs). */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatPlanProposal, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { planApproval, registerPreflightHandler } from '@recued/gateway';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createHeldResultTurnStore } from '../storage/chat-held-result-store.js';
import { createChatOrchestrator, HELD_RESULT_UNCONFIRMED_SENTENCE, type ChatTurnInput } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createHeldResultContinuations, createCarriedHeldResults } from '../chat-held-results.js';
import { buildWaitedCallsContext } from '../chat-waited-calls-context.js';
import { createHeldChatWrites, createHoldTier1Write, createRunApprovedTier1Write,
  createHeldPlanAskAnswerer, createHoldExpiredReader, settleChatRun } from '../chat-held-writes.js';
import { handlePlanApprove } from '../chat-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';
import { STANDARD_BRIEF_ACTION_GUIDANCE } from '../chat-turn-executor.js';
import { boundRequestEvidence, readerRequestRecords, unconfirmedHeldActionState, UNCONFIRMED_HELD_ACTION_LIMITS,
  withoutUnsuccessfulAttemptEchoes, type CompletedHeldActionRows, type RequestExecutionEvidence } from '../chat-request-evidence.js';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';

beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });
const databases: Database.Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  __clearSessionBriefs(); __clearUnfoldedUserMessages();
});

// ── The store and the state ──────────────────────────────────────────────────────────────────────────────────────
const key = new Uint8Array(32).fill(4);
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
const storeFixture = () => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  createChatStore(db, () => key).createSession({ id: 's', now: 1 });
  let unlocked = true;
  const plans = createSqliteChatPlanStore(db, () => unlocked ? key : null, () => 100);
  const ran = async (id: string, receipt: 'completed' | 'failed' | 'unknown') => {
    const plan = planApproval.buildPlanProposal({ session_id: 's', turn_id: 'old', tool: 'calendar.update',
      tier: 1, classification: 'write', args: { source_id: 'evt_unconfirmed_51c2', summary: 'Review' },
      mintId: () => id, now: () => 2 });
    await plans.put({ ...plan, hold: { run_id: 'run-' + id } });
    await plans.resolve(plan.plan_id, 'approved', 3);
    await plans.consumeForDispatch!(plan.plan_id, 4, plan.turn_id);
    await plans.recordExecution!(plan.plan_id, receipt === 'completed'
      ? { status: 'completed', turn_id: plan.turn_id, run_id: 'run-' + id, result_ref: 'held-write:' + id }
      : receipt === 'failed'
        ? { status: 'failed', turn_id: plan.turn_id, reason: 'execution_error', detail: 'Transport failed after dispatch.', run_id: 'run-' + id }
        : { status: 'unknown', turn_id: plan.turn_id });
    return plan;
  };
  return { db, plans, ran, lock: () => { unlocked = false; } };
};
const stateFor = (rows: CompletedHeldActionRows, messages: readonly ChatMessage[] = [owner]) =>
  unconfirmedHeldActionState(rows, 's', messages, registry, 100);

it('lists the approved held writes that ran without a confirmed result, apart from the completed ones', async () => {
  const { plans, ran } = storeFixture();
  await ran('done', 'completed'); await ran('errored', 'failed'); await ran('lost', 'unknown');
  const rows = await plans.readCompletedHeldEvidenceRows('s');
  expect(rows.records.map(r => r.plan.plan_id)).toEqual(['done']);
  expect(rows.unconfirmed?.map(r => [r.plan.plan_id, r.execution.status])).toEqual([['lost', 'unknown'], ['errored', 'failed']]);
  expect(rows.unconfirmed_incomplete).toBe(false);
  const state = stateFor(rows);
  expect(state).toMatchObject({ observation: 'available', incomplete: false });
  expect(state.actions).toEqual([
    expect.objectContaining({ plan_id: 'lost', execution_status: 'unknown', effect_confirmation: 'not_established',
      attempted_for_request_id: 'old', owner_request: expect.objectContaining({ text: 'Change the event.' }) }),
    expect.objectContaining({ plan_id: 'errored', execution_status: 'failed', reason: 'execution_error',
      hold_run_id: 'run-errored' }),
  ]);
  expect(state.actions[1]).not.toHaveProperty('receipt');
  // The failure's detail is the tool's message to the turn that handled it; it does not ride every later turn.
  expect(state.actions[1]).not.toHaveProperty('detail');
});

it('is unavailable from an older reader and incomplete when a row cannot be read or checked', async () => {
  const { plans, ran, lock } = storeFixture();
  await ran('errored', 'failed');
  const rows = await plans.readCompletedHeldEvidenceRows('s');
  const { unconfirmed: _listed, ...older } = rows;
  expect(stateFor(older)).toMatchObject({ observation: 'unavailable', incomplete: true, actions: [] });
  expect(unconfirmedHeldActionState(undefined, 's', [], registry, 100)).toMatchObject({ observation: 'unavailable' });
  // No owner message for its request, or times out of order: not listed, and the list says so.
  expect(stateFor(rows, [])).toMatchObject({ incomplete: true, actions: [] });
  expect(stateFor({ ...rows, observed_at: 3 })).toMatchObject({ incomplete: true, actions: [] });
  for (let i = 0; i < UNCONFIRMED_HELD_ACTION_LIMITS.plans; i++) await ran('more-' + i, 'unknown');
  expect((await plans.readCompletedHeldEvidenceRows('s')).unconfirmed_incomplete).toBe(true);
  lock();
  expect(await plans.readCompletedHeldEvidenceRows('s')).toMatchObject({ unconfirmed: [], unconfirmed_incomplete: true });
});

it('rides in the reader\'s records and the bound, and grounds no identifier', async () => {
  const { plans, ran } = storeFixture();
  await ran('errored', 'failed');
  const state = stateFor(await plans.readCompletedHeldEvidenceRows('s'));
  expect(readerRequestRecords({ ...evidence, unconfirmed_held_actions: state }))
    .toEqual({ current_request: evidence.current_request, unconfirmed_held_actions: state });
  expect(readerRequestRecords({ ...evidence, unconfirmed_held_actions: { ...state, actions: [] } })).toBeUndefined();
  const raw = JSON.stringify({ request_execution_context: { ...evidence, unconfirmed_held_actions: state } });
  expect(raw).toContain('evt_unconfirmed_51c2');
  expect(withoutUnsuccessfulAttemptEchoes(raw)).not.toContain('evt_unconfirmed_51c2');
  const bounded = boundRequestEvidence({ ...evidence, unconfirmed_held_actions: state }, false, 700)!;
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(700);
  expect(bounded.unconfirmed_held_actions?.incomplete ?? bounded.coverage?.incomplete).toBe(true);
});

// ── The production flow: the continuation and the next owner turn read the record ───────────────────────────────
const signature = { server_kind: 'recued', version: 'test', instance_id: 'held-unconfirmed' } as const;
const args = { source_id: 'meeting', summary: 'Review' };
const ownerText = 'Set the summary of the event with source_id "meeting" to "Review".';
const tools: ToolEntry[] = ['calendar.update', 'calendar.get'].map(name => ({ name, tier: 1,
  classification: name === 'calendar.get' ? 'read' : 'write', description: name,
  arg_schema: { type: 'object' }, topic_tags: [], concurrency_safe: false }));

it('gives the continuation and the next owner turn the record of a held write whose result is unconfirmed', async () => {
  const f = await ordinaryLocalFixture();
  const chatKey = new Uint8Array(32).fill(9), session = 'held-unconfirmed';
  let issued = false, paused = true, active = 0, ids = 0, summary = 'Planning';
  const packets: { host: boolean; system: string; message: string; records?: Record<string, any>; reasons: unknown[] }[] = [];
  const tick = () => { f.clock.now++; };
  ensureChatSchema(f.db);
  const store = createChatStore(f.db, () => chatKey);
  store.createSession({ id: session, now: f.clock.now });
  store.setRollingBriefEnabled(true);
  const plans = createSqliteChatPlanStore(f.db, () => chatKey, () => f.clock.now);
  const turnStore = createHeldResultTurnStore(f.db, () => f.clock.now);
  const broadcast = { emit: () => {} };
  const registry: InternalToolRegistry = { list: () => tools, listByTier: () => tools,
    getByName: name => tools.find(tool => tool.name === name) ?? null, subscribeRefresh: () => () => {},
    dispatch: async (name, input) => {
      tick();
      if (name === 'calendar.get') return { ok: true, result: { source_id: 'meeting', summary } };
      // The change lands, and the dispatch still reports an error: whether it applied is not known.
      summary = String((input as Record<string, unknown>).summary);
      return { ok: false, reason: 'execution_error', detail: 'Transport failed after dispatch; whether it applied is unknown.' };
    } };
  f.execution.tier1Registry = () => registry;
  f.execution.now = () => f.clock.now;
  f.execution.runApprovedTier1Write = createRunApprovedTier1Write({ plans,
    getResourceReview: () => f.execution.executorConfig.resourceReview, broadcast, now: () => f.clock.now });
  let carry: ReturnType<typeof createCarriedHeldResults> | undefined;
  let host = false;
  const raw = createChatOrchestrator({ chatStore: store, registry, planApprovalStore: plans,
    readPendingApprovalRows: id => plans.readPendingEvidenceRows(id),
    readCancelledApprovalRows: id => plans.readCancelledEvidenceRows(id),
    readCompletedHeldActionRows: plans.readCompletedHeldEvidenceRows?.bind(plans),
    buildInFlightContext: (source, telling) => buildWaitedCallsContext(store.toolCalls, source,
      id => new Set([...turnStore.delivered(id), ...(telling ?? [])])),
    carriedHeldResults: id => carry?.(id) ?? Promise.resolve(undefined),
    holdTier1Write: createHoldTier1Write(() => f.execution), settleHeldCall: async () => undefined,
    getResourceReview: () => f.execution.executorConfig.resourceReview, validateLocalMutation: () => {},
    selfSignature: signature, broadcast, auditLog: f.execution.auditLog,
    now: () => f.clock.now, mintId: () => 'unconfirmed-' + (++ids),
    executeAiCall: async (_manifest, input) => {
      tick();
      const system = String(input['llm.system_prompt']), packet = JSON.parse(String(input['llm.prompt']));
      if (system.startsWith(BRIEF_INSTRUCTION)) return { body: { intent: ownerText, constraints: [], pending: [], findings: [] } };
      packets.push({ host, system, message: String(packet.user_message), records: packet.request_execution_context,
        reasons: (packet.prior_tool_calls ?? []).map((call: { reason?: unknown }) => call.reason) });
      if (!host && !issued) {
        issued = true;
        return { body: { response: '', events: [], tool_calls: [{ tool: 'calendar.update', args }] } };
      }
      return { body: { response: 'The title reads Review; the rename itself was not confirmed.', events: [],
        tool_calls: [], nothing_outstanding: true } };
    },
  });
  const observed = { ...raw, runTurn: async (input: ChatTurnInput) => {
    active++; host = input.held_results !== undefined;
    try { return await raw.runTurn(input); } finally { active--; host = false; }
  } };
  const queued = withQueuedChatTurns(observed, { db: f.db, store, getKey: () => chatKey, pollMs: 5,
    isPaused: () => paused, broadcast });
  const queue = queued.turnQueue!;
  carry = createCarriedHeldResults({ turns: turnStore, queue });
  const continuations = createHeldResultContinuations({ turns: turnStore, queue,
    runTurn: input => observed.runTurn(input), later: () => { throw new Error('Unexpected retry'); } });
  const held = createHeldChatWrites({ plans, chatStore: store, broadcast, signature,
    now: () => f.clock.now, continueConversation: continuations.continueWith });
  registerPreflightHandler(f.block, { checkpointStore: f.execution.checkpointStore!,
    resumer: createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
      gatedActionStore: f.execution.gatedActionStore,
      onRunSettled: settleChatRun(held, async () => { throw new Error('Unexpected ordinary settlement'); }) }) });
  const rpc = { store, orchestrator: queued, selfSignature: signature, planApprovalStore: plans,
    broadcast, now: () => f.clock.now, auditLog: f.execution.auditLog,
    answerHeldPlanAsk: createHeldPlanAskAnswerer(f.block, createHoldExpiredReader({
      checkpointStore: f.execution.checkpointStore!, gatedActionStore: f.execution.gatedActionStore! })) };
  const idle = () => vi.waitFor(async () => {
    expect((await queue.snapshot(session)).turns.filter(t => ['queued', 'running', 'cancelling'].includes(t.status))).toEqual([]);
    expect(active).toBe(0);
  }, { timeout: 30_000, interval: 10 });
  const ownerTurn = async (message: string) => {
    tick(); paused = false;
    await queued.runTurn({ session_id: session, message, picker_state: { current: 'self' } });
    await idle();
  };
  try {
    await ownerTurn(ownerText);
    const plan = (await plans.listPending(session))[0]! as ChatPlanProposal;
    tick();
    await handlePlanApprove(rpc, { plan_id: plan.plan_id });
    await vi.waitFor(async () => expect((await plans.listForSession!(session))[0]?.execution?.status).toBe('failed'));
    paused = false; await idle();
    expect(summary).toBe('Review');
    const expected = { observation: 'available', incomplete: false, actions: [expect.objectContaining({
      plan_id: plan.plan_id, attempted_for_request_id: plan.turn_id, tool_name: 'calendar.update', args,
      owner_request: expect.objectContaining({ text: ownerText }), approval_status: 'approved',
      execution_status: 'failed', reason: 'execution_error', effect_confirmation: 'not_established' })] };
    // The continuation that reports the outcome: its records are those of the request it continues.
    const continuation = packets.filter(p => p.host);
    expect(continuation.length).toBeGreaterThan(0);
    expect(continuation[0]!.records?.unconfirmed_held_actions).toMatchObject(expected);
    expect(continuation[0]!.system).toContain(STANDARD_BRIEF_ACTION_GUIDANCE);
    // Its own message says what a read can show after the error (the owner's "do the still open items").
    expect(continuation[0]!.message).toContain(HELD_RESULT_UNCONFIRMED_SENTENCE);
    // The next owner turn.
    await ownerTurn('Continue.');
    const next = packets.filter(p => !p.host).at(-1)!;
    expect(next.records?.unconfirmed_held_actions).toMatchObject(expected);
    expect(next.records).not.toHaveProperty('completed_held_actions.actions.0');
    expect(STANDARD_BRIEF_ACTION_GUIDANCE).toContain('unconfirmed_held_actions ran with no confirmed result');
    // The owner's next turn proposes the same write again without reading the event: not held, and the model is told
    // to read first (the owner, 2026-11-19: "do check against re-proposing an unconfirmed rename").
    issued = false;
    const plansBefore = (await plans.listForSession!(session)).length;
    await ownerTurn(ownerText);
    expect((await plans.listForSession!(session)).length).toBe(plansBefore);
    expect(packets.at(-1)!.reasons).toContain('unconfirmed_attempt');
  } finally { paused = true; queue.close(); }
});
