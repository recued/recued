/** D-329 slice B — a chat's Tier-1 write is held behind the ask every approval channel
 *  shows; approving it anywhere runs it, and the chat it came from hears the outcome.
 *
 *  Before: the card was single-use and in-app only, and approving it ran nothing until the
 *  owner sent another message. Driven through the REAL chat gate (`createChatOrchestrator`),
 *  the REAL SQLite plan store, the REAL hold (`createHoldTier1Write` → `holdTier1Call`), the
 *  REAL resumer, the REAL settlement (`createHeldChatWrites`) and the REAL card rpc
 *  (`handlePlanApprove` / `handlePlanCancel` over `createHeldPlanAskAnswerer`). Doubles: the
 *  tool registry's tools, the notification block (asks kept in a list, answers dispatched to
 *  the resumer as the block's handler would), and the authority and grant gates. Each test
 *  that must not run the write checks the tool never ran. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalValueLabels,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type Checkpoint,
  type ExecutionSource,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';
import type { PendingAsk } from '@recued/notification';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type CheckpointStore,
} from '@recued/storage';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import {
  createChatOrchestrator,
  HELD_WRITE_AWAITING_DETAIL,
  type ChatBroadcastEmitter,
} from '../chat-orchestrator.js';
import { handlePlanApprove, handlePlanCancel, type ChatRpcDeps } from '../chat-handler.js';
import {
  createHeldChatWrites,
  createHeldPlanAskAnswerer,
  createHoldExpiredReader,
  createHoldTier1Write,
  expiredHoldSettlement,
  heldWriteExpiredText,
  heldWriteReplyId,
  HELD_WRITE_REPLY_WAIT_MS,
  settleChatRun,
} from '../chat-held-writes.js';
import { createChatRunSettledSink } from '../chat-run-settled-sink.js';
import { createWriteRuleStore } from '../storage/write-rule-store.js';
import { useWriteRule } from '../write-rules.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer, type PreflightRunSettled } from '../preflight-resumer.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-d329' };
const NOW = 1_760_000_000_000;
const entry = (name: string, classification: ToolEntry['classification']): ToolEntry => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification, concurrency_safe: false,
});
const EVENT = { summary: 'Dentist', start_at: NOW + 3_600_000, end_at: NOW + 7_200_000, timezone: 'Europe/Dublin' };
const DONE = 'The action that waited for your approval, "Add a calendar event", is done.';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const harness = (opts: {
  tool?: string;
  result?: unknown;
  hold?: 'raw' | 'not_wired' | 'throws';
  source?: (session_id: string, turn_id: string) => ExecutionSource;
  askStatus?: () => PendingAsk['status'];
  granted?: () => boolean;
  writeRules?: boolean;
  /** The registry's `checkBeforeAsking`: what a call's own arguments refuse it for. */
  check?: (name: string, args: unknown) => ChatDispatchResult | null;
  /** The registry's `askValueLabels`: the names of the records a call names. */
  labels?: (name: string, args: unknown) => ApprovalValueLabels | undefined;
} = {}) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  const session_id = 'sess-d329';
  chatStore.createSession({
    id: session_id, title: 'test', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
  } as never);
  let clock = NOW;
  const now = () => clock;
  const plans = createSqliteChatPlanStore(db, undefined, now);
  const writeRules = opts.writeRules === true ? createWriteRuleStore(db) : undefined;
  const notices: Array<{ title?: string; text: string }> = [];
  const activity: Array<{ action: string; target: string; detail?: string }> = [];

  const calls: Array<{ name: string; args: unknown; ctx: ChatDispatchContext }> = [];
  const writeTool = opts.tool ?? 'calendar.create';
  const registry: InternalToolRegistry = {
    list: () => [entry(writeTool, 'write'), entry('calendar.search', 'read')],
    listByTier: (tier) => (tier === 1 ? [entry(writeTool, 'write'), entry('calendar.search', 'read')] : []),
    getByName: (name) => (name === writeTool ? entry(name, 'write') : name === 'calendar.search' ? entry(name, 'read') : null),
    dispatch: async (name, args, ctx): Promise<ChatDispatchResult> => {
      calls.push({ name, args, ctx });
      return { ok: true, result: opts.result ?? { created: true, event_id: 'evt-1' } };
    },
    ...(opts.check !== undefined ? { checkBeforeAsking: async (name: string, args: unknown) => opts.check!(name, args) } : {}),
    ...(opts.labels !== undefined ? { askValueLabels: async (name: string, args: unknown) => opts.labels!(name, args) } : {}),
    subscribeRefresh: () => () => undefined,
  };

  const checkpoints = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: async (cp: Checkpoint) => {
      if (opts.hold === 'not_wired') throw new Error('disk full');
      checkpoints.set(cp.checkpoint_id, cp);
    },
    get: async (id: string) => checkpoints.get(id) ?? null,
    delete: async (id: string) => { checkpoints.delete(id); },
    listByRun: async (run_id: string) => [...checkpoints.values()].filter((c) => c.run_id === run_id),
    list: async () => [...checkpoints.values()],
    size: async () => checkpoints.size,
  } as unknown as CheckpointStore;
  const asks: PendingAsk[] = [];
  const preflightNotifier = {
    ask: async (message: PendingAsk['message'], _options: unknown, handler: { kind: string; payload: Record<string, unknown> }) => {
      const ask_id = `ask-${asks.length + 1}`;
      asks.push({
        ask_id, message, options: [], handler_kind: handler.kind, handler_payload: handler.payload,
        fanout_channels: ['ui'], status: 'open', created_at: clock,
      } as unknown as PendingAsk);
      return { ask_id };
    },
    notify: async (message: { title?: string; text: string }) => { notices.push(message); },
    registerAskHandler: () => {},
  } as unknown as PreflightNotifier;
  const gatedActionStore = createGatedActionStore(createInMemoryCollection<GatedActionRecord>());
  const mcpActionStore = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
  let seq = 0;
  const executeDeps = {
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    internalRegistry: registry,
    tier1Registry: () => registry,
    checkpointStore,
    preflightNotifier,
    gatedActionStore,
    mcpActionStore,
    approvalResumeAuthority: {
      resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({ admitted: true, execution_source }),
    },
    opAdmissionGate: { isOpGranted: () => opts.granted?.() ?? true, isFrozenByPause: () => false },
    newId: () => `id-${(seq += 1)}`,
    now,
    ...(writeRules !== undefined ? { writeRules } : {}),
  };

  const broadcasted: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
  const broadcast: ChatBroadcastEmitter = { emit: (event) => { broadcasted.push(event); } };
  const waiting: Array<() => void> = [];
  const heldWrites = createHeldChatWrites({
    plans, chatStore, broadcast, signature, now, schedule: (run) => { waiting.push(run); },
  });
  const settling: Array<Promise<boolean>> = [];
  const settledRuns: PreflightRunSettled[] = [];
  const resumer = createPreflightResumer({
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    gatedActionStore,
    mcpActionStore,
    getExecuteDeps: () => executeDeps as unknown as ExecuteHandlerDeps,
    onRunSettled: (settled) => { settledRuns.push(settled); settling.push(heldWrites.settle(settled)); },
  });
  const checkpointOfRun = (run_id: string): Checkpoint => {
    const found = [...checkpoints.values()].find((c) => c.run_id === run_id);
    if (found === undefined) throw new Error(`no checkpoint for ${run_id}`);
    return found;
  };
  /** The notification block, as far as answering goes: an answer closes the ask and runs its
   *  handler, which for a preflight ask is the resumer. */
  const block = {
    listUnresolvedAsks: async () => asks
      .filter((a) => a.status === 'open' || a.status === 'answered')
      .map((a) => ({ ...a, status: opts.askStatus?.() ?? a.status })),
    submitAnswer: async (reply: { ask_id: string; option: string }) => {
      const ask = asks.find((a) => a.ask_id === reply.ask_id);
      if (ask === undefined) return 'ignored' as const;
      if (ask.status !== 'open') return 'closed' as const;
      ask.status = 'answered';
      const checkpoint = checkpointOfRun(ask.handler_payload.run_id as string);
      if (reply.option === 'approve') await resumer.resumeRun(checkpoint, {} as never);
      else await resumer.denyRun(checkpoint, {} as never);
      return 'answered' as const;
    },
  };
  /** Another channel (the phone, Telegram) answering the same ask. */
  const answerElsewhere = async (option: 'approve' | 'deny') => {
    const ask = asks.find((a) => a.status === 'open');
    if (ask === undefined) throw new Error('no open ask');
    await block.submitAnswer({ ask_id: ask.ask_id, option });
    await Promise.all(settling);
  };

  const holdWrite = createHoldTier1Write(() => executeDeps as never);
  let holdCalls = 0;
  let planAtHold: unknown;
  const orchestrator = createChatOrchestrator({
    chatStore,
    registry,
    broadcast,
    selfSignature: signature,
    planApprovalStore: plans,
    auditLog: { logActivity: async (entry: { action: string; target: string; detail?: string }) => { activity.push(entry); } } as never,
    useWriteRule: (source, tool, args) => useWriteRule(writeRules, source, tool, args, clock),
    holdTier1Write: async (call) => {
      holdCalls += 1;
      planAtHold = await plans.get(call.plan_id);
      if (opts.hold === 'throws') throw new Error('hold store went away');
      return holdWrite(call);
    },
    now,
    mintId: () => `mint-${(seq += 1)}`,
  });
  const dispatch = (turn_id: string, args: Record<string, unknown> = EVENT) =>
    orchestrator.dispatch.dispatchTool({
      session_id, turn_id, tool_name: writeTool, arg_values: args, picker_target: 'self',
      ...(opts.source !== undefined ? { execution_source: opts.source(session_id, turn_id) } : {}),
    } as never);
  const rpcDeps: ChatRpcDeps = {
    store: chatStore,
    orchestrator,
    selfSignature: signature,
    planApprovalStore: plans,
    broadcast,
    now,
    answerHeldPlanAsk: async (run_id, option) => {
      const answer = await createHeldPlanAskAnswerer(block as never,
        createHoldExpiredReader({ checkpointStore, gatedActionStore }))(run_id, option);
      await Promise.all(settling);
      return answer;
    },
  };
  /** The proposing turn answers: its assistant message, linked to its plans. */
  const answerTurn = async (turn_id: string) => {
    await chatStore.appendMessage({
      id: `answer-${turn_id}`, session_id, role: 'assistant', content: 'I have asked for your approval.',
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'test', model_id: 'test' }, turn_id, ts: clock,
    });
    await plans.linkTurnToMessage?.(session_id, turn_id, `answer-${turn_id}`);
  };
  /** Run the reply's next scheduled re-check (each one that still waits schedules another). */
  const runWaiting = async () => {
    const next = waiting.shift();
    if (next === undefined) return;
    next();
    await flush();
  };
  const record = async (plan_id: string) =>
    (await plans.listForSession!(session_id)).find((r) => r.plan.plan_id === plan_id);
  const reply = async (plan_id: string) =>
    (await chatStore.listMessages(session_id)).find((m) => m.id === heldWriteReplyId(plan_id));
  /** What retention's staleness guard does to a hold no one answered: the ask withdrawn, the
   *  receipt cancelled, the checkpoint gone. `tellChat` — and the chat is told, as the guard
   *  now does; without it the card finds out when it is pressed. */
  const expireHold = async (run_id: string, tellChat: boolean) => {
    const checkpoint = checkpointOfRun(run_id);
    for (const ask of asks) if (ask.handler_payload.run_id === run_id) ask.status = 'handled' as PendingAsk['status'];
    const action = await gatedActionStore.getBySubject(run_id, 'raw_op');
    await gatedActionStore.finish(action!.action_ref, { status: 'cancelled', status_message: 'expired',
      result: { code: 'RECIPE_APPROVAL_TIMEOUT' }, observed: { items: 1, succeeded: 0, failed: 0 } } as never);
    checkpoints.delete(checkpoint.checkpoint_id);
    // The same settlement retention's `onRawOpExpired` hands the chat's sink.
    if (tellChat) await heldWrites.settle(expiredHoldSettlement(checkpoint, clock)!);
  };
  return {
    db, plans, calls, checkpoints, asks, broadcasted, settledRuns, dispatch, rpcDeps, answerTurn, runWaiting,
    answerElsewhere, record, reply, session_id, waiting, writeRules, notices, activity, expireHold,
    holdCalls: () => holdCalls, planAtHold: () => planAtHold,
    tick: (ms: number) => { clock += ms; },
  };
};

const planIdOf = (result: ChatDispatchResult): string => {
  if (result.ok || result.reason !== 'awaiting_approval') throw new Error('expected awaiting_approval');
  return /^plan_id=([^.\s]+)/.exec(result.detail ?? '')![1]!;
};

describe('D-329 B — a chat\'s Tier-1 write is held', () => {
  it('stores the proposal with its hold before the ask goes out, and tells the model it runs by itself', async () => {
    const h = harness();
    const result = await h.dispatch('turn-1');
    const plan_id = planIdOf(result);
    expect(h.calls).toEqual([]);
    // Linked at the moment the hold was raised: never approvable as a plain card meanwhile.
    expect(h.planAtHold()).toMatchObject({ plan_id, hold: { run_id: expect.any(String) } });
    const stored = await h.plans.get(plan_id);
    const [checkpoint] = [...h.checkpoints.values()];
    expect(checkpoint!.run_id).toBe(stored!.hold!.run_id);
    expect(checkpoint!.raw_op).toMatchObject({ tier1_tool: 'calendar.create', op_args: EVENT, correlation_id: plan_id });
    expect(result).toMatchObject({ ok: false, detail: `plan_id=${plan_id}. ${HELD_WRITE_AWAITING_DETAIL}` });
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed')).toMatchObject({ plan_id, held: true });
  });

  it('names the chat in the ask', async () => {
    const h = harness();
    await h.dispatch('turn-1');
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.message.text.split('\n')[0]).toBe('Your chat wants to add a calendar event.');
  });

  it('asked again in a later turn while the ask is out, it is that ask', async () => {
    const h = harness();
    const first = planIdOf(await h.dispatch('turn-1'));
    const second = planIdOf(await h.dispatch('turn-2'));
    expect(second).toBe(first);
    expect(h.holdCalls()).toBe(1);
    expect(h.asks).toHaveLength(1);
    expect(h.checkpoints.size).toBe(1);
  });

  it('different arguments are a different write, with their own ask', async () => {
    const h = harness();
    const first = planIdOf(await h.dispatch('turn-1'));
    const second = planIdOf(await h.dispatch('turn-2', { ...EVENT, summary: 'Dentist (moved)' }));
    expect(second).not.toBe(first);
    expect(h.asks).toHaveLength(2);
  });
});

describe('D-329 B — a write its own arguments refuse is not put to the owner', () => {
  it('answers the model with the refusal: no proposal, no hold, no ask, nothing run', async () => {
    // ⛔ Live (2026-10-25): an AI sent an asset's details as `body`, the owner approved, and
    // only then did the create refuse `body`.
    const refusal: ChatDispatchResult = { ok: false, reason: 'invalid_args', detail: 'calendar.create: `summary` must not be empty' };
    const h = harness({ check: (_name, args) => ((args as { summary?: string }).summary === '' ? refusal : null) });
    expect(await h.dispatch('turn-1', { ...EVENT, summary: '' })).toEqual(refusal);
    expect(h.asks).toEqual([]);
    expect(h.holdCalls()).toBe(0);
    expect(h.calls).toEqual([]);
    expect(await h.plans.listForSession!(h.session_id)).toEqual([]);
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed')).toBeUndefined();
    expect(h.broadcasted.find((e) => e.kind === 'chat.tool_call_completed')).toMatchObject({ status: 'error', reason: 'invalid_args' });
    // A call it lets through is held as before.
    planIdOf(await h.dispatch('turn-2'));
    expect(h.asks).toHaveLength(1);
  });
});

describe('D-329 B — the card and the ask name the records a call names', () => {
  const NAMES = { summary: { Dentist: 'Dr Okafor, the dentist' } };
  it('records the names on the proposal, its event and its hold, and the ask reads them', async () => {
    const h = harness({ labels: (name) => (name === 'calendar.create' ? NAMES : undefined) });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect((await h.plans.get(plan_id))!.value_labels).toEqual(NAMES);
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed')).toMatchObject({ plan_id, value_labels: NAMES });
    const [checkpoint] = [...h.checkpoints.values()];
    expect(checkpoint!.preflight_context?.value_labels).toEqual(NAMES);
    expect(h.asks[0]!.message.text).toContain('Dr Okafor, the dentist');
    // The call itself is unchanged: what runs is what the model sent.
    expect((await h.plans.get(plan_id))!.args).toEqual(EVENT);
  });

  it('proposes and holds with no names when the lookup throws', async () => {
    const h = harness({ labels: () => { throw new Error('store went away'); } });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect((await h.plans.get(plan_id))!.value_labels).toBeUndefined();
    expect((await h.plans.get(plan_id))!.hold).toBeDefined();
  });
});

describe('D-329 B — approving from the card runs it', () => {
  it('runs once with the reviewed arguments, settles the card, and replies after the turn\'s answer', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(plan.status).toBe('approved');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      name: 'calendar.create', args: EVENT,
      // D-325 — the owner approved it, so an asset reading it writes is their own sample.
      ctx: { channel: 'internal_function_call', session_id: h.session_id, turn_id: 'turn-1', owner_approved: true },
    });
    const settled = await h.record(plan_id);
    expect(settled!.plan).toMatchObject({ status: 'approved', consumed_at: NOW });
    expect(settled!.execution).toMatchObject({ status: 'completed', turn_id: 'turn-1', run_id: plan.hold!.run_id });
    expect(h.broadcasted.find((e) => e.kind === 'chat.tool_call_completed' && e.plan_id === plan_id))
      .toMatchObject({ status: 'ok' });
    // The turn has not answered yet, so "done" waits for "I asked".
    expect(await h.reply(plan_id)).toBeUndefined();
    await h.answerTurn('turn-1');
    await h.runWaiting();
    expect(await h.reply(plan_id)).toMatchObject({ role: 'assistant', turn_id: 'turn-1', content: DONE });
    expect(h.broadcasted.filter((e) => e.kind === 'chat.message_complete')).toHaveLength(1);
  });

  it('links the dedicated conversation after approving schedule creation', async () => {
    const h = harness({ tool: 'schedule.run_prompt', result: { session_id: 'scheduled-conversation' } });
    const plan_id = planIdOf(await h.dispatch('turn-1', { title: 'Morning mail', prompt: 'Summarize work mail.' }));
    await h.answerTurn('turn-1'); await handlePlanApprove(h.rpcDeps, { plan_id }); await flush();
    expect((await h.reply(plan_id))?.content).toContain('[Open scheduled conversation](#chat/session/scheduled-conversation)');
  });

  it('holds a scheduled prompt write and resumes it with scheduled provenance', async () => {
    const h = harness({ source: (session_id, turn_id) => ({ channel: 'schedule', actor: 'system', schedule_id: 'ps', cron: 'one_shot',
      chat_session_id: session_id, turn_id, prompt_schedule: { schedule_id: 'ps', occurrence_id: 'ps:1:1', revision: 1, due_at: 1, cron: 'one_shot' } }) });
    const plan_id = planIdOf(await h.dispatch('turn-1')); expect(h.calls).toHaveLength(0);
    await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.ctx.execution_source).toMatchObject({ channel: 'schedule', actor: 'system', schedule_id: 'ps' });
  });

  it('replies at once when the turn has already answered, and once only', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await handlePlanApprove(h.rpcDeps, { plan_id });
    await flush();
    expect((await h.reply(plan_id))?.content).toBe(DONE);
    // A settlement told twice writes one reply.
    await createHeldChatWrites({
      plans: h.plans, chatStore: createChatStore(h.db), broadcast: { emit: () => {} }, signature,
    }).settle(h.settledRuns[0]!);
    await flush();
    expect((await createChatStore(h.db).listMessages(h.session_id)).filter((m) => m.id === heldWriteReplyId(plan_id)))
      .toHaveLength(1);
  });

  it('replies anyway once the wait runs out (a turn that failed has no answer)', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await handlePlanApprove(h.rpcDeps, { plan_id });
    await h.runWaiting();
    expect(await h.reply(plan_id)).toBeUndefined();
    // Still waiting: the next re-check is scheduled.
    expect(h.waiting).toHaveLength(1);
    h.tick(HELD_WRITE_REPLY_WAIT_MS);
    await h.runWaiting();
    expect((await h.reply(plan_id))?.content).toBe(DONE);
  });

  it('a re-issue after approval never spends the held approval', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(h.calls).toHaveLength(1);
    const again = await h.dispatch('turn-2');
    expect(again).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(h.calls).toHaveLength(1);
  });

  it('the card cannot approve twice', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await handlePlanApprove(h.rpcDeps, { plan_id });
    await expect(handlePlanApprove(h.rpcDeps, { plan_id })).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.calls).toHaveLength(1);
  });
});

describe('D-329 B — refused at the resume', () => {
  it('a switch turned off while it waited: nothing runs, the card says it was not done, and so does the chat', async () => {
    let on = true;
    const h = harness({ granted: () => on });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    on = false;
    await handlePlanApprove(h.rpcDeps, { plan_id });
    await flush();
    expect(h.calls).toEqual([]);
    expect((await h.record(plan_id))!.execution).toMatchObject({ status: 'failed', reason: 'channel_denied' });
    expect((await h.reply(plan_id))?.content).toMatch(
      /^The action that waited for your approval, "Add a calendar event", did not complete: The contract no longer grants calendar\.create/,
    );
  });
});

describe('D-329 B — answered on another channel', () => {
  it('approved on the phone: it runs, and the card and the chat say so', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.answerElsewhere('approve');
    await flush();
    expect(h.calls).toHaveLength(1);
    expect((await h.record(plan_id))!.plan.status).toBe('approved');
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_resolved')).toMatchObject({ plan: { plan_id, status: 'approved' } });
    expect((await h.reply(plan_id))?.content).toBe(DONE);
  });

  it('declined on the phone: nothing runs, the card is cancelled, and the chat hears it', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.answerElsewhere('deny');
    await flush();
    expect(h.calls).toEqual([]);
    expect((await h.record(plan_id))!.plan.status).toBe('cancelled');
    expect((await h.reply(plan_id))?.content)
      .toBe('The action that waited for your approval, "Add a calendar event", was declined, so it was not done.');
  });
});

describe('D-329 B — cancelling the card', () => {
  it('declines the ask everywhere, so nothing can run it later', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    const { plan } = await handlePlanCancel(h.rpcDeps, { plan_id });
    expect(plan.status).toBe('cancelled');
    expect(h.asks[0]!.status).toBe('answered');
    expect(h.calls).toEqual([]);
  });

  it('is not a cancel when the ask was already approved somewhere else', async () => {
    let status: PendingAsk['status'] = 'open';
    const h = harness({ askStatus: () => status });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    // The phone's answer is recorded, its run not yet settled.
    status = 'answered';
    const { plan } = await handlePlanCancel(h.rpcDeps, { plan_id });
    expect(plan.status).toBe('proposed');
    expect((await h.plans.get(plan_id))!.status).toBe('proposed');
  });
});

describe('D-329 B — when nothing is held', () => {
  it('nothing written: the plain card, which its own re-issue spends', async () => {
    const h = harness({ hold: 'not_wired' });
    const result = await h.dispatch('turn-1');
    const plan_id = planIdOf(result);
    expect(result).toMatchObject({ detail: `plan_id=${plan_id}` });
    expect((await h.plans.get(plan_id))!.hold).toBeUndefined();
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(plan.status).toBe('approved');
    expect(h.calls).toEqual([]);
    await h.dispatch('turn-2');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.ctx.owner_approved).toBe(true);
  });

  it('a hold that may exist is never also approvable as a plain card', async () => {
    const h = harness({ hold: 'throws' });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect((await h.plans.get(plan_id))!.hold).toBeDefined();
    // The card finds no ask, and says so; it does not fall back to a plain approval.
    await expect(handlePlanApprove(h.rpcDeps, { plan_id })).rejects.toMatchObject({ code: 'conflict' });
    // Even approved by force, a re-issue cannot spend it.
    await h.plans.resolve(plan_id, 'approved', NOW);
    await h.dispatch('turn-2');
    expect(h.calls).toEqual([]);
  });

  it('a chat under a contract keeps the plain card: its resume could not re-read its authority', async () => {
    const h = harness({
      source: () => ({ channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '42', contract_id: 'k-house' }),
    });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect(h.holdCalls()).toBe(0);
    expect((await h.plans.get(plan_id))!.hold).toBeUndefined();
    // D-325 — its own re-issue spends the card, and runs it as that chat's call, never as
    // one the owner approved: a household member's reading is not the owner's sample.
    await handlePlanApprove(h.rpcDeps, { plan_id });
    await h.dispatch('turn-2');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.ctx.owner_approved).toBeUndefined();
  });

  it('so does the owner\'s own chat when it runs under a contract (self-restricted)', async () => {
    const h = harness({
      source: (session_id, turn_id) => ({
        channel: 'chat', actor: 'user_self', chat_session_id: session_id, user_id: 'local', turn_id, contract_id: 'k-self',
      }),
    });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect(h.holdCalls()).toBe(0);
    expect((await h.plans.get(plan_id))!.hold).toBeUndefined();
  });
});

describe('D-329 B — a messenger chat', () => {
  it('names the messenger, runs on approval, and replies into that conversation', async () => {
    const h = harness({ source: () => ({ channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' }) });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect(h.asks[0]!.message.text.split('\n')[0]).toBe('Your Telegram chat wants to add a calendar event.');
    await h.answerTurn('turn-1');
    await h.answerElsewhere('approve');
    await flush();
    // Run in the conversation it came from, though a messenger's source names none.
    expect(h.calls[0]!.ctx).toMatchObject({ channel: 'internal_function_call', session_id: h.session_id,
      execution_source: { channel: 'messenger', vendor: 'telegram' } });
    expect([...h.checkpoints.values()]).toEqual([]);
    expect(await h.reply(plan_id)).toMatchObject({ session_id: h.session_id, content: DONE });
  });
});

describe('D-329 B — the settlement claims only held writes', () => {
  it('a held write\'s run writes no tool-call result row; another run still does', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.answerElsewhere('approve');
    const store = createChatStore(h.db);
    const sink = settleChatRun(
      createHeldChatWrites({ plans: h.plans, chatStore: store, broadcast: { emit: () => {} }, signature }),
      createChatRunSettledSink(store, signature, { emit: () => {} }),
    );
    const held = h.settledRuns[0]!;
    await sink(held);
    const other: PreflightRunSettled = { ...held, run_id: 'run-recipe', tool_name: 'acme/report', result: { success: true } };
    await sink(other);
    const ids = (await store.listMessages(h.session_id)).map((m) => m.id);
    expect(ids).not.toContain(`settle:${held.run_id}`);
    expect(ids).toContain('settle:run-recipe');
    expect(ids.filter((id) => id === heldWriteReplyId(plan_id))).toHaveLength(1);
  });

  it('a run that is not a held write is left to the tool-row sink', async () => {
    const h = harness();
    const claimed = await createHeldChatWrites({
      plans: h.plans, chatStore: createChatStore(h.db), broadcast: { emit: () => {} }, signature,
    }).settle({ execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: h.session_id, user_id: 'local' },
      run_id: 'run-recipe', tool_name: 'recipe.run', result: { success: true }, ts: NOW });
    expect(claimed).toBe(false);
  });
});

describe('D-329 B — the plan table', () => {
  it('an existing table gains the hold column', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chat_plans (
      plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, message_id TEXT,
      tool TEXT NOT NULL, tier INTEGER NOT NULL, classification TEXT NOT NULL, args_encrypted TEXT NOT NULL,
      args_hash TEXT NOT NULL, target_instance TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      resolved_at INTEGER, consumed_at INTEGER, execution_status TEXT, execution_turn_id TEXT,
      execution_blob_encrypted TEXT, execution_updated_at INTEGER)`);
    ensureChatSchema(db);
    const columns = (db.prepare('PRAGMA table_info(chat_plans)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('hold_run_id');
    expect(columns).toContain('value_labels_encrypted');
  });
});

describe('D-329 §3.4 — the chat\'s approvals teach a write rule', () => {
  const DAY = 86_400_000;
  const approveOn = async (h: ReturnType<typeof harness>, turn: string) => {
    const plan_id = planIdOf(await h.dispatch(turn));
    await handlePlanApprove(h.rpcDeps, { plan_id });
    h.tick(DAY);
  };

  it('three approvals on three days suggest one, and the owner is told once', async () => {
    const h = harness({ writeRules: true });
    await approveOn(h, 'turn-1');
    await approveOn(h, 'turn-2');
    expect(h.writeRules!.listSuggestions(NOW + 2 * DAY)).toEqual([]);
    await approveOn(h, 'turn-3');
    expect(h.calls).toHaveLength(3);
    const [suggestion] = h.writeRules!.listSuggestions(NOW + 3 * DAY);
    expect(suggestion!.key).toEqual({ principal: { kind: 'owner_chat' }, tool: 'calendar.create', scope: 'local' });
    expect(h.notices.map((n) => n.title)).toEqual(['A rule Recued suggests: Add a calendar event']);
  });

  it('a refusal holds it back', async () => {
    const h = harness({ writeRules: true });
    await approveOn(h, 'turn-1');
    planIdOf(await h.dispatch('turn-2'));
    await h.answerElsewhere('deny');
    h.tick(DAY);
    await approveOn(h, 'turn-3');
    await approveOn(h, 'turn-4');
    expect(h.writeRules!.listSuggestions(NOW + 4 * DAY)).toEqual([]);
  });

  it('a live rule runs the write with no card and no ask, spends a use, and is audited', async () => {
    const h = harness({ writeRules: true });
    await approveOn(h, 'turn-1');
    await approveOn(h, 'turn-2');
    await approveOn(h, 'turn-3');
    const [suggestion] = h.writeRules!.listSuggestions(NOW + 3 * DAY);
    h.writeRules!.accept(suggestion!.key_hash, { max_uses: 1 }, NOW + 3 * DAY);
    const asksBefore = h.asks.length;
    const result = await h.dispatch('turn-4');
    expect(result).toMatchObject({ ok: true });
    expect(h.calls).toHaveLength(4);
    expect(h.calls[3]!.ctx.owner_approved).toBe(true);
    expect(h.asks).toHaveLength(asksBefore);
    expect(h.activity.find((a) => a.action === 'write_rule_used')).toMatchObject({
      target: `${h.session_id}:turn-4:calendar.create`,
    });
    // The one use is spent: the next one asks again.
    expect(await h.dispatch('turn-5')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(h.calls).toHaveLength(4);
  });

  it('never runs a call whose ask is still out: approving that one later would run it twice', async () => {
    const h = harness({ writeRules: true });
    await approveOn(h, 'turn-1');
    await approveOn(h, 'turn-2');
    await approveOn(h, 'turn-3');
    const pending = planIdOf(await h.dispatch('turn-4'));
    const [suggestion] = h.writeRules!.listSuggestions(NOW + 3 * DAY);
    h.writeRules!.accept(suggestion!.key_hash, {}, NOW + 3 * DAY);
    const again = await h.dispatch('turn-5');
    expect(planIdOf(again)).toBe(pending);
    expect(h.calls).toHaveLength(3);
    expect(h.writeRules!.listRules(NOW + 3 * DAY)[0]!.uses_remaining).toBe(100);
  });
});

describe('D-329 — an approval that expired unanswered', () => {
  const EXPIRED = heldWriteExpiredText('Add a calendar event');

  it('told by the staleness guard: the card lapses, nothing runs, and the chat hears it', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    const run_id = (await h.plans.get(plan_id))!.hold!.run_id;
    await h.expireHold(run_id, true);
    await flush();
    const plan = (await h.record(plan_id))!.plan;
    expect(plan).toMatchObject({ status: 'cancelled', hold: { run_id, lapsed_at: NOW } });
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_resolved')).toMatchObject({ plan: { plan_id, status: 'cancelled' } });
    expect((await h.reply(plan_id))?.content).toBe(EXPIRED);
    expect(h.calls).toEqual([]);
    // And the card cannot approve it now.
    await expect(handlePlanApprove(h.rpcDeps, { plan_id })).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.calls).toEqual([]);
  });

  it('never told: pressing Approve lapses the card instead of erroring', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    const run_id = (await h.plans.get(plan_id))!.hold!.run_id;
    await h.expireHold(run_id, false);
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(plan).toMatchObject({ status: 'cancelled', hold: { run_id, lapsed_at: NOW } });
    expect(h.calls).toEqual([]);
  });

  it('an ask not raised yet is no expiry: Approve says to try again, and the card still waits', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    h.asks.length = 0;
    await expect(handlePlanApprove(h.rpcDeps, { plan_id })).rejects.toMatchObject({ code: 'conflict' });
    expect((await h.plans.get(plan_id))!.status).toBe('proposed');
  });
});

