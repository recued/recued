/** A native held/RPC approval has no paired successful Chat tool row. Its real
 * receipt must survive an automatic tool-free reply, skipped/failed folds and
 * SQLite reopen, without making an identical new owner request disappear. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createHeldResultTurnStore } from '../storage/chat-held-result-store.js';
import { createChatOrchestrator, type ChatTurnInput } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createHeldResultContinuations, createCarriedHeldResults } from '../chat-held-results.js';
import { buildWaitedCallsContext } from '../chat-waited-calls-context.js';
import { createHeldChatWrites, createHoldTier1Write, createRunApprovedTier1Write,
  createHeldPlanAskAnswerer, createHoldExpiredReader, settleChatRun } from '../chat-held-writes.js';
import { handlePlanApprove } from '../chat-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { calendarChatUpdateInput } from '../collections/calendar/chat-update-input.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages, parseStoredBrief } from '../chat-rolling-brief.js';
import type { RequestExecutionEvidence } from '../chat-request-evidence.js';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { resourceFixtureDisposers } from './preapproval-resources-fixture.js';

beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });
afterEach(async () => {
  for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose();
  __clearSessionBriefs(); __clearUnfoldedUserMessages();
});
const signature = { server_kind: 'recued', version: 'test', instance_id: 'held-completion' } as const;
const args = { calendar_id: 'local', source_id: 'meeting', summary: 'Confirmed meeting' };
const ownerText = 'Set the summary of local event with source_id "meeting" to "Confirmed meeting".';
const tools: ToolEntry[] = ['calendar.update', 'calendar.get'].map(name => ({ name, tier: 1,
  classification: name === 'calendar.get' ? 'read' : 'write', description: name,
  arg_schema: { type: 'object' }, topic_tags: [], concurrency_safe: false }));

it('recovers the completed held action after a tool-free native continuation and SQLite reopen', async () => {
  let f = await ordinaryLocalFixture();
  const key = new Uint8Array(32).fill(8), session = 'held-completion';
  let phase: 'propose' | 'status' | 'read' | 'fresh' = 'propose';
  let issued = false, failFold = false, paused = true, active = 0, ids = 0, folds = 0;
  const packets: { phase: string; host: boolean; evidence?: RequestExecutionEvidence }[] = [];
  const writers: unknown[] = [];
  const automatic: ChatTurnInput[] = [];
  const tick = () => { f.clock.now++; };
  const make = () => {
    ensureChatSchema(f.db);
    const store = createChatStore(f.db, () => key);
    if (!store.getSession(session)) store.createSession({ id: session, now: f.clock.now });
    store.setRollingBriefEnabled(true);
    const plans = createSqliteChatPlanStore(f.db, () => key, () => f.clock.now);
    const turnStore = createHeldResultTurnStore(f.db, () => f.clock.now);
    const broadcast = { emit: () => {} };
    const registry: InternalToolRegistry = { list: () => tools, listByTier: () => tools,
      getByName: name => tools.find(tool => tool.name === name) ?? null, subscribeRefresh: () => () => {},
      dispatch: async (name, input) => {
        tick();
        return name === 'calendar.get' ? { ok: true, result: f.calendar.table.get('meeting')!.event }
          : { ok: true, result: await f.execution.executorConfig.kernelDispatchers!.calendarUpdate!(calendarChatUpdateInput(input as Record<string, unknown>)) };
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
      // Optional lookup lets this exact regression run on the pre-fix source:
      // the actual reader packet, rather than a missing-method exception, fails.
      readCompletedHeldActionRows: plans.readCompletedHeldEvidenceRows?.bind(plans),
      buildInFlightContext: (source, telling) => buildWaitedCallsContext(store.toolCalls, source,
        id => new Set([...turnStore.delivered(id), ...(telling ?? [])])),
      carriedHeldResults: id => carry?.(id) ?? Promise.resolve(undefined),
      holdTier1Write: createHoldTier1Write(() => f.execution), settleHeldCall: async () => undefined,
      getResourceReview: () => f.execution.executorConfig.resourceReview, validateLocalMutation: () => {},
      selfSignature: signature, broadcast, auditLog: f.execution.auditLog,
      now: () => f.clock.now, mintId: () => 'completion-' + (++ids),
      executeAiCall: async (_manifest, input) => {
        tick();
        const packet = JSON.parse(String(input['llm.prompt']));
        if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
          folds++; writers.push(packet);
          if (failFold) throw new Error('Deliberately unavailable closing writer');
          return { body: { intent: ownerText, constraints: [], pending: [], findings: [] } };
        }
        packets.push({ phase, host, evidence: packet.request_execution_context });
        // An automatic native result is never scripted as another owner request.
        if (!host && !issued && (phase === 'propose' || phase === 'fresh' || phase === 'read')) {
          issued = true;
          return { body: { response: '', events: [], tool_calls: [{ tool: phase === 'read' ? 'calendar.get' : 'calendar.update', args }] } };
        }
        return { body: { response: host ? 'The summary was updated.' : 'Status recorded.', events: [],
          tool_calls: [], nothing_outstanding: true } };
      },
    });
    const observed = { ...raw, runTurn: async (input: ChatTurnInput) => {
      active++; host = input.held_results !== undefined;
      if (input.held_results) automatic.push(input);
      try { return await raw.runTurn(input); } finally { active--; host = false; }
    } };
    const queued = withQueuedChatTurns(observed, { db: f.db, store, getKey: () => key, pollMs: 5,
      isPaused: () => paused, broadcast });
    const queue = queued.turnQueue;
    if (!queue) throw new Error('The native Chat queue is unavailable');
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
    return { store, plans, queue, queued, rpc };
  };
  let state = make();
  const idle = () => vi.waitFor(async () => {
    expect((await state.queue.snapshot(session)).turns.filter(t => ['queued', 'running', 'cancelling'].includes(t.status))).toEqual([]);
    expect(active).toBe(0);
  }, { timeout: 30_000, interval: 10 });
  const reopen = async () => {
    paused = true; state.queue.close(); f = await f.reopenOrdinary();
    __clearSessionBriefs(); __clearUnfoldedUserMessages(); state = make();
  };
  const ownerTurn = async (message: string) => {
    issued = false; tick(); paused = false;
    await state.queued.runTurn({ session_id: session, message, picker_state: { current: 'self' } });
    await idle();
  };
  try {
    await ownerTurn(ownerText);
    const plan = (await state.plans.listPending(session))[0]!;
    expect(plan.hold?.run_id).toBeTruthy();
    paused = true; tick();
    await handlePlanApprove(state.rpc, { plan_id: plan.plan_id });
    await vi.waitFor(async () => expect((await state.plans.listForSession!(session))[0]?.execution?.status).toBe('completed'));
    await vi.waitFor(async () => expect((await state.queue.snapshot(session)).turns.some(t => t.status === 'queued')).toBe(true));
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
    const completedCard = (await state.plans.listForSession!(session))[0]!;
    const foldsBefore = folds;
    await reopen(); phase = 'status'; paused = false; await idle();
    expect(automatic).toHaveLength(1);
    expect(folds).toBe(foldsBefore); // No closing fold carried the held result.
    expect((await state.store.listMessages(session)).filter(m => m.tool_call?.state === 'succeeded')).toEqual([]);
    // Recover the original authorized row through the native receipt anchor,
    // even once it is outside the recent owner-message window.
    for (let i = 0; i < 20; i++) {
      tick();
      await state.store.appendMessage({ id: 'aged-' + i, session_id: session, turn_id: 'aged-' + i,
        role: 'user', content: 'Another status question.', ts: f.clock.now, target_server: 'self',
        picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'test', model_id: 'test' },
        source_lifecycle: 'finalized', execution_source: { channel: 'chat', actor: 'user_self', user_id: 'realm',
          chat_session_id: session, turn_id: 'aged-' + i } });
    }
    const check = () => {
      const evidence = packets.filter(p => !p.host).at(-1)!.evidence;
      // An empty list is left out of the reader's records (`readerRequestRecords`).
      expect(evidence).not.toHaveProperty('successful_actions_for_earlier_requests');
      expect(evidence?.completed_held_actions).toMatchObject({ observation: 'available', incomplete: false,
        actions: [{ plan_id: plan.plan_id, completed_for_request_id: plan.turn_id, args,
          owner_request: { request_id: plan.turn_id, text: ownerText }, approval_status: 'approved', execution_status: 'completed',
          receipt: { run_id: plan.hold!.run_id, local_receipt: completedCard.execution!.status === 'completed'
            ? completedCard.execution!.local_receipt : undefined } }] });
      expect(evidence?.completed_held_actions?.actions[0]).not.toHaveProperty('result');
    };
    await reopen(); await ownerTurn('Continue.'); check();
    phase = 'read'; failFold = true;
    const beforeFailedFold = folds;
    await ownerTurn('Check the local event, then report its status.');
    expect(folds).toBeGreaterThan(beforeFailedFold);
    failFold = false; phase = 'status'; await reopen(); await ownerTurn('Continue.'); check();
    expect(parseStoredBrief(JSON.parse((await state.store.readSessionBrief(session))!))).toBeTruthy();
    phase = 'fresh'; await ownerTurn(ownerText + ' Do it again as a new request.');
    const next = (await state.plans.listPending(session))[0]!;
    expect(next.args).toEqual(args); expect(next.turn_id).not.toBe(plan.turn_id);
    expect(next.consumed_at).toBeUndefined();
    expect(f.calendar.table.get('meeting')!.event.summary).toBe(args.summary);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
  } finally { paused = true; state.queue.close(); }
});
