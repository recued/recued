/** The owner's chat holding its own writes for approval (D-329), over Recued's own calendar: the
 *  real chat gate, plan store and hold, the real ask and answer path, the real resumer and
 *  settlement, and the approved run as the server wires it (`runApprovedTier1Write`). Only the
 *  tool registry is the test's: `calendar.update` reaches the real calendar, `note.add` changes
 *  nothing Recued can undo, and `remote.update` stands for a change Recued reviews but cannot undo
 *  (an event on another provider's calendar). `calendar.touch` reaches the real calendar too, but
 *  needs no ask (its pack lets it run); `routine.start` needs none either, and starts a run (one
 *  that holds when asked to). Each call keeps the review it ran under, if any. */

import { expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ChatDispatchResult, ExecutionSource, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';

import { CHAIN_REQUEST_STATE_KEY, openChainRequest } from '../chain-evidence.js';
import { createChatOrchestrator, type ChatBroadcastEmitter, type ChatOrchestratorDeps } from '../chat-orchestrator.js';
import { createHeldChatWrites, createHoldTier1Write, createRunApprovedTier1Write, settleChatRun } from '../chat-held-writes.js';
import { calendarChatUpdateInput } from '../collections/calendar/chat-update-input.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { currentResourceReview } from '../resource-review.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { createChainRuleStore } from '../storage/chain-rule-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';

const entry = (name: string, description: string): ToolEntry => ({ name, tier: 1, description,
  arg_schema: { type: 'object' }, topic_tags: ['calendar'], classification: 'write', concurrency_safe: false });

export const heldChatFixture = async (options: {
  /** A D-329 write rule the owner accepted: what it lets through without asking. */
  useWriteRule?: ChatOrchestratorDeps['useWriteRule'];
} = {}) => {
  const f = await ordinaryLocalFixture();
  ensureChatSchema(f.db);
  const chatKey = new Uint8Array(32).fill(8);
  const store = createChatStore(f.db, () => chatKey);
  const session_id = randomUUID();
  store.createSession({ id: session_id, now: f.clock.now });
  const plans = createSqliteChatPlanStore(f.db, () => chatKey, () => f.clock.now);
  const events: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
  const broadcast: ChatBroadcastEmitter = { emit: (event) => { events.push(event); } };
  const tools = [entry('calendar.update', 'Update local event'), entry('note.add', 'Add a note'),
    entry('remote.update', 'Update an event on another calendar'),
    { ...entry('calendar.touch', 'Update local event, without asking'), classification: 'unknown' as const },
    { ...entry('routine.start', 'Start a routine, without asking'), classification: 'unknown' as const }];
  let routines = 0;
  /** The review each call ran under, in order. */
  const reviewed: unknown[] = [];
  const invoke = vi.fn(async (name: string, args: unknown): Promise<ChatDispatchResult> => {
    reviewed.push(currentResourceReview());
    if (name === 'routine.start') {
      const run_id = `run-routine-${String((routines += 1))}`;
      // Asked to, it holds for the owner's approval, as a run with a held step does.
      return (args as { hold?: boolean }).hold === true
        ? { ok: true, run_id, run_held: { kind: 'approval' }, result: { held: true } }
        : { ok: true, run_id, result: { started: true } };
    }
    return name === 'calendar.update' || name === 'calendar.touch'
      ? { ok: true, result: await f.execution.executorConfig.kernelDispatchers!.calendarUpdate!(calendarChatUpdateInput(args as Record<string, unknown>)) }
      : { ok: true, result: { done: true } };
  });
  const registry: InternalToolRegistry = { list: () => tools, listByTier: (tier) => (tier === 1 ? tools : []),
    getByName: (name) => tools.find((tool) => tool.name === name) ?? null, dispatch: invoke, subscribeRefresh: () => () => {} };
  const chainEvidence = createChainEvidenceStore(f.db);
  const chainRules = createChainRuleStore(f.db, chainEvidence);
  f.execution.tier1Registry = () => registry;
  f.execution.chainEvidence = chainEvidence;
  f.execution.chainRules = chainRules;
  f.execution.now = () => f.clock.now;
  // As the server wires it (`wire-chat-orchestrator.ts`, through the execute deps).
  f.execution.runApprovedTier1Write = createRunApprovedTier1Write({ plans,
    getResourceReview: () => f.execution.executorConfig.resourceReview, broadcast, now: () => f.clock.now });
  /** The model's replies for a whole turn (`wholeTurn`), one per round. */
  const script: Array<{ response: string; tool_calls: Array<{ tool: string; args: Record<string, unknown> }> }> = [];
  const orchestrator = createChatOrchestrator({ chatStore: store, registry, broadcast, auditLog: f.execution.auditLog!,
    executeAiCall: async () => ({ body: { events: [], ...(script.shift() ?? { response: 'Done.', tool_calls: [] }) } }),
    selfSignature: { server_kind: 'recued', version: '1.0.0', instance_id: 'held-chat-write' }, planApprovalStore: plans,
    getResourceReview: () => f.execution.executorConfig.resourceReview, validateLocalMutation: () => undefined,
    holdTier1Write: createHoldTier1Write(() => f.execution as never),
    ...(options.useWriteRule !== undefined ? { useWriteRule: options.useWriteRule } : {}),
    chainEvidence: () => chainEvidence, chainRules: () => chainRules, now: () => f.clock.now });
  const held = createHeldChatWrites({ plans, chatStore: store, broadcast,
    signature: { server_kind: 'recued', version: '1.0.0', instance_id: 'held-chat-write' }, now: () => f.clock.now,
    // The reply waits for its turn's answer; no turn runs here, so it is never written.
    schedule: () => undefined });
  registerPreflightHandler(f.block, {
    checkpointStore: f.execution.checkpointStore!,
    resumer: createPreflightResumer({ getExecuteDeps: () => f.execution, auditLog: f.execution.auditLog!,
      gatedActionStore: f.execution.gatedActionStore, onRunSettled: settleChatRun(held, async () => undefined) }),
  });
  let turn = 0;
  /** A turn of the owner's chat that asked in `words`, calling `tool`: held, and the plan it made. */
  const ask = async (tool: string, args: Record<string, unknown>, words = 'Rename the team meeting') => {
    turn += 1;
    const turn_id = `turn-${String(turn)}`;
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: session_id, user_id: 'realm', turn_id } as ExecutionSource;
    const turn_state = new Map<string, unknown>();
    const request = openChainRequest(chainEvidence, { session_id, turn_id, source, words, at: f.clock.now });
    if (request !== undefined) turn_state.set(CHAIN_REQUEST_STATE_KEY, request);
    const result = await orchestrator.dispatch.dispatchTool({ session_id, turn_id, tool_name: tool, arg_values: args,
      picker_target: 'self', execution_source: source, turn_state });
    const plan = (await plans.listForSession!(session_id)).map((row) => row.plan).find((row) => row.turn_id === turn_id);
    return { result, plan: plan!, turn_id };
  };
  /** A whole turn of the owner's chat in `words`, its model calling `tool` once, then answering:
   *  the answer as the owner's app reads it. */
  const wholeTurn = async (tool: string, args: Record<string, unknown>, words = 'Rename the team meeting') => {
    script.push({ response: '', tool_calls: [{ tool, args }] }, { response: 'Done.', tool_calls: [] });
    await orchestrator.runTurn({ session_id, message: words, picker_state: { current: 'self' } });
    return (await store.listMessages(session_id)).filter((row) => row.role === 'assistant').at(-1)!;
  };
  /** The latest call row of the chat, as its line reads it. */
  const lastCall = () => {
    const row = f.db.prepare(`SELECT message_id FROM chat_messages WHERE session_id = ? AND role = 'tool'
      AND message_id NOT LIKE '%:result' ORDER BY ts DESC, rowid DESC LIMIT 1`).get(session_id) as { message_id: string } | undefined;
    return row === undefined ? undefined : store.toolCalls!.get(row.message_id);
  };
  /** The owner answers the open ask. */
  const answer = async (option: 'approve' | 'deny') => {
    const [open] = await f.block.listOpenAsks();
    if (open === undefined) throw new Error('No ask is open');
    await f.block.submitAnswer({ ask_id: open.ask_id, option, via: 'ui' });
  };
  /** The card as the owner's app reads it, once its outcome is recorded. */
  const card = async (plan_id: string) => {
    const read = async () => (await plans.listForSession!(session_id)).find((row) => row.plan.plan_id === plan_id);
    await vi.waitFor(async () => expect((await read())?.execution?.status).toMatch(/completed|failed|unknown/));
    return (await read())!;
  };
  /** The owner undoes a change in the app: a review, then their yes. */
  const undo = async (receipt_id: string) => {
    const handlers = f.composed.handlers.localUndo!;
    const review = await handlers.review(receipt_id, f.origin);
    return handlers.decide({ undo_id: review.undo_id, review_hash: review.review_hash, decision: 'approve' }, f.origin);
  };
  const receipts = () => (f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get() as number);
  return { f, plans, session_id, orchestrator, invoke, reviewed, events, chainEvidence, chainRules, ask, wholeTurn, answer, card, undo, receipts, lastCall,
    nextDay: () => { f.clock.now += 86_400_000; } };
};
