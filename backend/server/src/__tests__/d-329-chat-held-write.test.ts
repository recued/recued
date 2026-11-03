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
  ANY_ARGUMENT,
  memoryClaimKey,
  type ApprovalValueLabels,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ChatPlanProposal,
  type Checkpoint,
  type ExecutionSource,
  type HeldCallNotices,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import { planApproval, type PreflightNotifier } from '@recued/gateway';
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
  HELD_WRITE_CARRIES_ON_DETAIL,
  type ChatBroadcastEmitter,
} from '../chat-orchestrator.js';
import { handlePlanApprove, handlePlanCancel, type ChatRpcDeps } from '../chat-handler.js';
import { notAskedYetMessage } from '../chat-carries-on.js';
import type { HeldResultContinuation } from '../chat-held-results.js';
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
import { createAskChatPlanFinder, handlePendingAsks } from '../history-handler.js';
import { listWaitingTier1Calls, type RawOpDispatchDeps } from '../raw-op-dispatch.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer, type PreflightRunSettled } from '../preflight-resumer.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { buildChatTier1Handlers, memoryAskNotices } from '../chat-tool-handlers.js';
import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';
import { createContactStore } from '../storage/contact-store.js';
import {
  handleMemoryDelete,
  handleMemorySaves,
  type MemoryRedactionRecord,
  type MemoryRpcDeps,
} from '../memory-rpc-handler.js';
import { createChatSavesReader, savesInMessages } from '../memory-save-count.js';
import { createHeldPlanEditor, ownerEditsFor } from '../chat-plan-edits.js';
import { ownerClaimRecords, type ClaimRecordLookups } from '../memory-claim.js';
import { createClaimLinker } from '../claim-link.js';
import { createWaitingSaveMarker } from '../waiting-save-marks.js';
import { createClaimLinkLedger } from '../storage/claim-link-ledger.js';

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
  /** D-336 slice Q — more write tools, so one turn holds two of them (the first is `tool`). */
  tools?: readonly string[];
  /** D-336 slice O's open item — a held save marks the earlier saves of its fact, as the
   *  server wires it (`onTier1Held`); `throws`, a marker that fails. */
  markWaitingSaves?: boolean | 'throws';
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
  /** D-336 (spec §41) — the contacts the card and the ask name people by. */
  contactStore?: unknown;
  /** D-336 slice G — the registry's `askNotices`: what a held call meets. */
  notices?: (
    name: string,
    args: unknown,
    ctx: ChatDispatchContext,
    /** D-336 slice O — the holds' stores, so real notices can read the saves still waiting. */
    stores: Pick<RawOpDispatchDeps, 'checkpointStore' | 'gatedActionStore'>,
  ) => HeldCallNotices | undefined | Promise<HeldCallNotices | undefined>;
  /** Runs the write instead of answering `result`: a real tool's handler. */
  run?: (name: string, args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>;
  /** D-336 slice E — the owner's lookups the card's change is checked by. */
  claimRecords?: ClaimRecordLookups;
  /** As the real block does: an ask whose handler finished is `handled`, and no longer
   *  among the unresolved. */
  handledAfterAnswer?: boolean;
  /** The channels the raised ask went to (its `fanout_channels`). */
  fanout?: readonly string[];
  /** D-337 — the conversation's continuation step. */
  continueConversation?: (continuation: HeldResultContinuation) => Promise<boolean>;
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
  const writeTool = opts.tools?.[0] ?? opts.tool ?? 'calendar.create';
  const writeTools = opts.tools ?? [writeTool];
  const registry: InternalToolRegistry = {
    list: () => [...writeTools.map((name) => entry(name, 'write')), entry('calendar.search', 'read')],
    listByTier: (tier) => (tier === 1 ? [...writeTools.map((name) => entry(name, 'write')), entry('calendar.search', 'read')] : []),
    getByName: (name) => (writeTools.includes(name) ? entry(name, 'write') : name === 'calendar.search' ? entry(name, 'read') : null),
    dispatch: async (name, args, ctx): Promise<ChatDispatchResult> => {
      calls.push({ name, args, ctx });
      if (opts.run !== undefined) return opts.run(name, args, ctx);
      return { ok: true, result: opts.result ?? { created: true, event_id: 'evt-1' } };
    },
    ...(opts.check !== undefined ? { checkBeforeAsking: async (name: string, args: unknown) => opts.check!(name, args) } : {}),
    ...(opts.labels !== undefined ? { askValueLabels: async (name: string, args: unknown) => opts.labels!(name, args) } : {}),
    ...(opts.notices !== undefined
      ? { askNotices: async (name: string, args: unknown, ctx: ChatDispatchContext) => opts.notices!(name, args, ctx, { checkpointStore, gatedActionStore }) }
      : {}),
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
    // D-336 slice E — the narrow writer an owner's change made while approving goes through.
    setArgOverrides: async (id: string, patch: { arg_overrides: Record<string, unknown> }) => {
      const found = checkpoints.get(id);
      if (found === undefined) throw new Error(`checkpoint ${id} not found`);
      const patched = { ...found, arg_overrides: patch.arg_overrides };
      checkpoints.set(id, patched);
      return patched;
    },
  } as unknown as CheckpointStore;
  const asks: PendingAsk[] = [];
  const preflightNotifier = {
    ask: async (message: PendingAsk['message'], _options: unknown, handler: { kind: string; payload: Record<string, unknown> }) => {
      const ask_id = `ask-${asks.length + 1}`;
      asks.push({
        ask_id, message, options: [], handler_kind: handler.kind, handler_payload: handler.payload,
        fanout_channels: opts.fanout ?? ['ui'], status: 'open', created_at: clock,
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
    // As production reads it (`approvalAskChannelsOf`): the ask's own record.
    approvalAskChannels: async (ask_id: string) => asks.find((a) => a.ask_id === ask_id)?.fanout_channels,
    ...(opts.markWaitingSaves === true
      ? { onTier1Held: (call: { tool: string; args: Record<string, unknown>; run_id: string }) => markWaitingSaves(call) }
      : opts.markWaitingSaves === 'throws' ? { onTier1Held: async () => { throw new Error('plans gone'); } } : {}),
  };

  const broadcasted: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
  const broadcast: ChatBroadcastEmitter = { emit: (event) => { broadcasted.push(event); } };
  const markWaitingSaves = createWaitingSaveMarker({ plans, broadcast, ownerRecords: () => opts.claimRecords ?? {} });
  const waiting: Array<() => void> = [];
  const heldWrites = createHeldChatWrites({
    plans, chatStore, broadcast, signature, now, schedule: (run) => { waiting.push(run); },
    ...(opts.continueConversation !== undefined ? { continueConversation: opts.continueConversation } : {}),
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
      if (opts.handledAfterAnswer === true) ask.status = 'handled' as PendingAsk['status'];
      return 'answered' as const;
    },
  };
  /** Another channel (the phone, Telegram) answering the same ask. */
  const answerElsewhere = async (option: 'approve' | 'deny', which?: (ask: PendingAsk) => boolean) => {
    const ask = asks.find((a) => a.status === 'open' && (which === undefined || which(a)));
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
    ...(opts.contactStore !== undefined ? { getContactStore: () => opts.contactStore as never } : {}),
  });
  /** `turn_state`: the turn's scratch, as one turn's calls share it (`buildTurnDriver`). */
  const dispatch = (turn_id: string, args: Record<string, unknown> = EVENT, tool: string = writeTool,
    turn_state?: Map<string, unknown>) =>
    orchestrator.dispatch.dispatchTool({
      session_id, turn_id, tool_name: tool, arg_values: args, picker_target: 'self',
      ...(opts.source !== undefined ? { execution_source: opts.source(session_id, turn_id) } : {}),
      ...(turn_state !== undefined ? { turn_state } : {}),
    } as never);
  // One answerer for the server, as `compose-listeners` makes it.
  const answerer = createHeldPlanAskAnswerer(block as never, createHoldExpiredReader({ checkpointStore, gatedActionStore }));
  const rpcDeps: ChatRpcDeps = {
    store: chatStore,
    orchestrator,
    selfSignature: signature,
    planApprovalStore: plans,
    broadcast,
    now,
    answerHeldPlanAsk: async (run_id, option, beforeApprove) => {
      const answer = await answerer(run_id, option, beforeApprove);
      await Promise.all(settling);
      return answer;
    },
    editHeldPlan: createHeldPlanEditor({ checkpointStore, plans }),
    ...(opts.claimRecords !== undefined ? { claimRecords: opts.claimRecords } : {}),
    auditLog: { logActivity: async (entry: { action: string; target: string; detail?: string }) => { activity.push(entry); } } as never,
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
    expect(result).toMatchObject({ ok: false, detail: `plan_id=${plan_id}. ${HELD_WRITE_CARRIES_ON_DETAIL}` });
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed')).toMatchObject({ plan_id, held: true });
    // D-337 — a step the user asked for after it waits too, even one that would ask itself (the
    // held run's words, `HELD_CARRIES_ON_MESSAGE`).
    expect(HELD_WRITE_CARRIES_ON_DETAIL).toContain('do not take a step that should only happen after it');
    expect(HELD_WRITE_CARRIES_ON_DETAIL).toContain('even one that would wait for approval too');
    expect(HELD_WRITE_CARRIES_ON_DETAIL).toContain('do not call it again');
  });

  it('tells the model where else the owner answers it, as a held run does', async () => {
    // A Telegram chat said the event waited "in the app" while its approval came with buttons
    // (live, 2026-11-01): told nothing of where the ask went, the model guessed.
    const h = harness({ fanout: ['ui', 'telegram', 'email'] });
    const result = await h.dispatch('turn-1');
    expect(result).toMatchObject({
      ok: false,
      detail: `plan_id=${planIdOf(result)}. ${HELD_WRITE_CARRIES_ON_DETAIL} This approval request also goes to the user `
        + 'on Telegram and by email; they can answer it there too. To answer by email, they reply to the approval '
        + 'email with one of the options it lists, such as Approve.',
    });
  });

  it('asked from a Telegram chat, it says to answer it there in Telegram', async () => {
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    const h = harness({ fanout: ['ui', 'telegram'], source: () => telegram });
    const result = await h.dispatch('turn-1');
    expect(result).toMatchObject({
      ok: false,
      detail: `plan_id=${planIdOf(result)}. ${HELD_WRITE_CARRIES_ON_DETAIL} `
        + 'This approval request also goes to the user on Telegram, where this conversation is: tell them they can '
      + 'answer it there in Telegram, with the buttons on the approval message.',
    });
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

  // D-336 (spec §41) — and the people the call carries, by the contacts they are.
  const contactStore = {
    resolveCanonicalEmail: (email: string) => ({ canonical_email: email, chain_depth: 0 }),
    get: (email: string) => (email === 'mia.whitfield@example.test' ? { email, name: 'Mia Whitfield' } : null),
    getByContactIdResolved: () => null,
  };
  const PEOPLE = { [ANY_ARGUMENT]: { 'mia.whitfield@example.test': 'Mia Whitfield <mia.whitfield@example.test>' } };

  it('names a contact the call carries on the card, its event, its hold and its ask, beside the records', async () => {
    const h = harness({ contactStore, labels: (name) => (name === 'calendar.create' ? NAMES : undefined) });
    const plan_id = planIdOf(await h.dispatch('turn-1', { ...EVENT, guest: 'mia.whitfield@example.test' }));
    expect((await h.plans.get(plan_id))!.value_labels).toEqual({ ...NAMES, ...PEOPLE });
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed')).toMatchObject({ plan_id, value_labels: { ...NAMES, ...PEOPLE } });
    expect([...h.checkpoints.values()][0]!.preflight_context?.value_labels).toEqual({ ...NAMES, ...PEOPLE });
    expect(h.asks[0]!.message.text).toContain('guest: Mia Whitfield <mia.whitfield@example.test>');
  });

  it('a record lookup that throws keeps the people\'s names', async () => {
    const h = harness({ contactStore, labels: () => { throw new Error('store went away'); } });
    const plan_id = planIdOf(await h.dispatch('turn-1', { ...EVENT, guest: 'mia.whitfield@example.test' }));
    expect((await h.plans.get(plan_id))!.value_labels).toEqual(PEOPLE);
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

describe('D-337 — an answered held write continues its conversation', () => {
  const continuing = (answer = true) => {
    const continued: HeldResultContinuation[] = [];
    return { continued, step: async (c: HeldResultContinuation) => { continued.push(c); return answer; } };
  };

  it('approved: the conversation goes on with the write and its result, and no fixed reply is written', async () => {
    const c = continuing();
    const h = harness({ continueConversation: c.step });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.answerElsewhere('approve');
    await flush();
    expect(h.calls).toHaveLength(1);
    expect((await h.record(plan_id))!.plan.status).toBe('approved');
    expect(c.continued).toHaveLength(1);
    expect(c.continued[0]).toMatchObject({
      session_id: h.session_id, turn_id: 'turn-1', tool_name: 'calendar.create', tier: 1, args: EVENT,
      outcome: 'ran', result: expect.objectContaining({ result: { created: true, event_id: 'evt-1' } }), title: 'Add a calendar event',
    });
    expect(c.continued[0]!.run_id).toBe((await h.plans.get(plan_id))!.hold!.run_id);
    expect(await h.reply(plan_id)).toBeUndefined();
    expect(h.waiting).toHaveLength(0);
  });

  it('declined: it goes on knowing the owner said no', async () => {
    const c = continuing();
    const h = harness({ continueConversation: c.step });
    await h.dispatch('turn-1');
    await h.answerTurn('turn-1');
    await h.answerElsewhere('deny');
    await flush();
    expect(h.calls).toEqual([]);
    expect(c.continued.map((x) => x.outcome)).toEqual(['refused']);
    expect(c.continued[0]).not.toHaveProperty('result');
  });

  it('expired: it goes on knowing no one answered', async () => {
    const c = continuing();
    const h = harness({ continueConversation: c.step });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.expireHold((await h.plans.get(plan_id))!.hold!.run_id, true);
    await flush();
    expect(c.continued.map((x) => x.outcome)).toEqual(['expired']);
    expect(await h.reply(plan_id)).toBeUndefined();
  });

  it('keeps the fixed reply when no continuation is queued', async () => {
    const c = continuing(false);
    const h = harness({ continueConversation: c.step });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.answerElsewhere('approve');
    await flush();
    expect(c.continued).toHaveLength(1);
    expect((await h.reply(plan_id))?.content).toBe(DONE);
  });

  it('a Telegram chat goes on as that Telegram chat', async () => {
    const c = continuing();
    const telegram = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as const;
    const h = harness({ continueConversation: c.step, source: () => telegram });
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    await h.answerTurn('turn-1');
    await h.answerElsewhere('approve');
    await flush();
    expect(c.continued).toHaveLength(1);
    expect(c.continued[0]).toMatchObject({ outcome: 'ran', source: telegram });
    expect(await h.reply(plan_id)).toBeUndefined();
  });
});

describe('D-337 slice K — while a call of its turn waits for the owner, a further one is not asked', () => {
  // The owner: "AI proposes it after". Told to wait, the model still put a step asked for after a
  // held one up for approval at once in 1 of 6 first answers, its approval then free to run it
  // first or after a no.
  const OTHER = { ...EVENT, summary: 'Haircut' };
  /** A recipe run held at a step that asks, as `wrapRecipeRunResult` projects it. */
  const heldRun = (): ChatDispatchResult => ({
    ok: true, run_held: { kind: 'approval' }, run_id: 'run-held-1',
    result: { status: 'awaiting_approval', awaiting_approval: true },
  });
  const contracted = (session_id: string, turn_id: string) => ({
    channel: 'chat', actor: 'user_self', chat_session_id: session_id, user_id: 'local', turn_id, contract_id: 'k-self',
  }) as ExecutionSource;

  it('a write after a held write: nothing is proposed, held or asked, and a later turn asks it', async () => {
    const h = harness();
    const turn = new Map<string, unknown>();
    planIdOf(await h.dispatch('turn-1', EVENT, 'calendar.create', turn));
    expect(await h.dispatch('turn-1', OTHER, 'calendar.create', turn))
      .toEqual({ ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('calendar.create') });
    expect(await h.plans.listForSession!(h.session_id)).toHaveLength(1);
    expect(h.holdCalls()).toBe(1);
    expect(h.asks).toHaveLength(1);
    expect(h.broadcasted.filter((e) => e.kind === 'chat.plan_proposed')).toHaveLength(1);
    expect(h.broadcasted.filter((e) => e.kind === 'chat.tool_call_completed').at(-1))
      .toMatchObject({ tool_name: 'calendar.create', status: 'error', reason: 'not_asked_yet' });
    // The conversation carried on (its own turn): the model makes the call then, and it is asked.
    planIdOf(await h.dispatch('turn-2', OTHER, 'calendar.create', new Map()));
    expect(h.asks).toHaveLength(2);
  });

  it('a run held for approval earlier in the turn holds back a write after it, in Telegram too', async () => {
    for (const source of [undefined, () => ({ channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' }) as ExecutionSource]) {
      const h = harness({ run: async () => heldRun(), ...(source !== undefined ? { source } : {}) });
      const turn = new Map<string, unknown>();
      expect(await h.dispatch('turn-1', { query: 'x' }, 'calendar.search', turn)).toMatchObject({ run_held: { kind: 'approval' } });
      expect(await h.dispatch('turn-1', EVENT, 'calendar.create', turn))
        .toEqual({ ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage('calendar.search') });
      expect(h.asks).toHaveLength(0);
      expect(h.holdCalls()).toBe(0);
    }
  });

  it('a wait that is not an approval (a container to pick) holds nothing back', async () => {
    const h = harness({ run: async () => ({ ok: true, run_held: { kind: 'container_pick' }, result: {} }) });
    const turn = new Map<string, unknown>();
    await h.dispatch('turn-1', { query: 'x' }, 'calendar.search', turn);
    planIdOf(await h.dispatch('turn-1', EVENT, 'calendar.create', turn));
    expect(h.asks).toHaveLength(1);
  });

  it('the waiting write called again in its turn is that ask, not held back', async () => {
    const h = harness();
    const turn = new Map<string, unknown>();
    const plan_id = planIdOf(await h.dispatch('turn-1', EVENT, 'calendar.create', turn));
    expect(planIdOf(await h.dispatch('turn-1', EVENT, 'calendar.create', turn))).toBe(plan_id);
    expect(h.asks).toHaveLength(1);
  });

  it('under a contract, where the conversation does not carry on, a held run holds nothing back', async () => {
    const h = harness({ run: async () => heldRun(), source: contracted });
    const turn = new Map<string, unknown>();
    await h.dispatch('turn-1', { query: 'x' }, 'calendar.search', turn);
    const write = await h.dispatch('turn-1', EVENT, 'calendar.create', turn);
    expect(write.ok === false && write.reason).toBe('awaiting_approval');
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


/** D-198 §13 — the Delete confirm counts an agent's earlier saves of a claim the owner
 *  deleted, and a deleted note's words survive only in the chat that saved it: on the
 *  approval card of a save held for the owner, or the call row of one a rule ran. Driven
 *  through this harness so those records are the ones the chat writes, with the REAL
 *  `memory.write` handler as the tool and the real memory and chat stores behind it. */
describe('D-198 §13 — an agent save the owner deleted is counted from the chat that saved it', () => {
  const MIA = "Dana Whitfield's daughter is called Mia";
  const DAY = 86_400_000;
  const memoryTool = () => {
    const store = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), {} as never, {});
    const redactions = createInMemoryCollection<MemoryRedactionRecord>();
    const handlers = buildChatTier1Handlers({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getUserMemoryStore: () => store,
      getMemoryRedactionStore: () => redactions,
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false, isOpGranted: () => true, isOwnerGoverned: () => true, isOwnerRecipeGranted: () => false,
      }),
    }) as Record<string, (args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>>;
    return { store, redactions, run: (name: string, args: unknown, ctx: ChatDispatchContext) => handlers[name]!(args, ctx) };
  };
  const owner = (m: ReturnType<typeof memoryTool>, h: ReturnType<typeof harness>): MemoryRpcDeps => ({
    auditLog: { get: async () => null } as never,
    userMemoryStore: m.store,
    redactionStore: m.redactions,
    readChatSaves: createChatSavesReader({ chatStore: h.rpcDeps.store, plans: h.plans }),
  });
  /** The one note `step` saved. */
  const savedBy = async (m: ReturnType<typeof memoryTool>, step: () => Promise<unknown>) => {
    const before = new Set((await m.store.list()).map((r) => r.memory_id));
    await step();
    const added = (await m.store.list()).filter((r) => !before.has(r.memory_id));
    expect(added).toHaveLength(1);
    return added[0]!;
  };

  it('held for the owner and approved, deleted, saved again: two saves, read from the approval cards', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run });
    const first = await savedBy(m, async () =>
      handlePlanApprove(h.rpcDeps, { plan_id: planIdOf(await h.dispatch('turn-1', { summary: MIA })) }));
    expect(first).toMatchObject({ summary: MIA, channel_session_id: h.session_id });
    await handleMemoryDelete(owner(m, h), { memory_id: first.memory_id });
    expect(await m.store.getRow(first.memory_id)).not.toHaveProperty('summary');
    // A save the owner refuses writes nothing, so it is no save.
    planIdOf(await h.dispatch('turn-2', { summary: MIA }));
    await h.answerElsewhere('deny');
    const again = await savedBy(m, async () =>
      handlePlanApprove(h.rpcDeps, { plan_id: planIdOf(await h.dispatch('turn-3', { summary: `${MIA}.` })) }));
    expect(await handleMemorySaves(owner(m, h), { memory_id: again.memory_id }))
      .toEqual({ memory_id: again.memory_id, saves: 2, agents: 1 });
  });

  it('run by a standing rule, deleted, run again: two saves, read from the call rows', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, writeRules: true });
    for (const [turn, summary] of [['turn-1', 'Dana prefers phone calls'], ['turn-2', 'The office closes at five'], ['turn-3', 'Ciarán starts on Monday']] as const) {
      await handlePlanApprove(h.rpcDeps, { plan_id: planIdOf(await h.dispatch(turn, { summary })) });
      h.tick(DAY);
    }
    const [suggestion] = h.writeRules!.listSuggestions(NOW + 3 * DAY);
    h.writeRules!.accept(suggestion!.key_hash, {}, NOW + 3 * DAY);
    const first = await savedBy(m, async () =>
      expect(await h.dispatch('turn-4', { summary: MIA })).toMatchObject({ ok: true }));
    await handleMemoryDelete(owner(m, h), { memory_id: first.memory_id });
    const again = await savedBy(m, async () =>
      expect(await h.dispatch('turn-5', { summary: MIA })).toMatchObject({ ok: true }));
    // Both ran with no card: their words are on the chat's call rows.
    expect(savesInMessages(await h.rpcDeps.store.listMessages(h.session_id))).toEqual([{ summary: MIA }, { summary: MIA }]);
    expect(await handleMemorySaves(owner(m, h), { memory_id: again.memory_id }))
      .toEqual({ memory_id: again.memory_id, saves: 2, agents: 1 });
  });
});

describe('D-336 slice E — the card changes a held save\'s relationship as part of approving it', () => {
  const DAY = 86_400_000;
  const DANA = { contact_id: 'c-dana', name: 'Dana Whitfield', email: 'dana@example.com' };
  const lookups: ClaimRecordLookups = {
    contact: (id) => (id === DANA.contact_id || id === DANA.email ? DANA : null),
    asset: (id) => (id === 'asset_bike' ? { asset_id: 'asset_bike', name: 'Blue bicycle' } : null),
  };
  const memoryTool = (records: ClaimRecordLookups = lookups) => {
    const store = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), {} as never, {});
    const handlers = buildChatTier1Handlers({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getUserMemoryStore: () => store,
      getMemoryRedactionStore: () => createInMemoryCollection<MemoryRedactionRecord>(),
      getOwnerClaimRecords: () => records,
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false, isOpGranted: () => true, isOwnerGoverned: () => true, isOwnerRecipeGranted: () => false,
      }),
    }) as Record<string, (args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>>;
    return { store, run: (name: string, args: unknown, ctx: ChatDispatchContext) => handlers[name]!(args, ctx) };
  };
  const SAVE = { summary: "Mia is Dana's daughter", claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } };
  /** The relationship the owner leaves on the card: Dana linked to her contact. */
  const LINKED = { subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'c-dana', name: 'Dana' } };
  /** As it is saved: the contact's name read from the contact. */
  const SAVED = { subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'c-dana', name: 'Dana Whitfield' } };
  const setup = (records?: ClaimRecordLookups, writeRules = false, handledAfterAnswer = false) => {
    const m = memoryTool(records);
    const h = harness({ tool: 'memory.write', run: m.run, claimRecords: lookups, writeRules, handledAfterAnswer });
    return { m, h };
  };

  it('slice N\'s open item — a held save\'s ask names the chat whose card can change it, before the question', async () => {
    const { h } = setup();
    planIdOf(await h.dispatch('turn-1', SAVE));
    const text = h.asks[0]!.message.text;
    expect(text).toContain('\n\nTo change it first, open the chat “test” in Recued.\n\nApprove?');
    // A write its card cannot change says nothing of it.
    const event = harness();
    planIdOf(await event.dispatch('turn-1'));
    expect(event.asks[0]!.message.text).not.toContain('To change it first');
  });

  it('a held save says its card may change the relationship and the summary, on its proposal and its event', async () => {
    const { h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    expect((await h.record(plan_id))!.plan.editable_args).toEqual(['claim', 'summary']);
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed'))
      .toMatchObject({ plan_id, held: true, editable_args: ['claim', 'summary'] });
  });

  /** Audit 2026-10-31 — the card took a change to the relationship only, and recall returns
   *  the summary: "sister of" was saved beside "Mia is Dana's daughter", and recalled so. */
  it('a summary corrected on the card is saved with the relationship, and is what recall returns', async () => {
    const { m, h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const sister = { subject: { text: 'Mia' }, relation: 'sister of', object: { text: 'Dana' } };
    const { plan } = await handlePlanApprove(h.rpcDeps, {
      plan_id, edited_args: { summary: "  Mia is Dana's sister ", claim: sister },
    });
    expect(h.calls[0]!.args).toEqual({ summary: "Mia is Dana's sister", claim: sister });
    expect(h.calls[0]!.ctx.owner_edits).toEqual(['summary', 'claim']);
    expect(plan.args).toEqual({ summary: "Mia is Dana's sister", claim: sister });
    expect((await m.store.list()).map((r) => r.summary)).toEqual(["Mia is Dana's sister"]);
    const recalled = await m.run('memory.search', { query: 'Mia Dana' }, h.calls[0]!.ctx);
    expect(recalled).toMatchObject({ ok: true, result: { memories: [{ summary: "Mia is Dana's sister" }] } });
    // The summary alone, the relationship as the agent sent it.
    const again = planIdOf(await h.dispatch('turn-2', { summary: 'Dana lives in Dublin' }));
    await handlePlanApprove(h.rpcDeps, { plan_id: again, edited_args: { summary: 'Dana lives in Cork' } });
    expect(h.calls[1]!.args).toEqual({ summary: 'Dana lives in Cork' });
    expect(h.calls[1]!.ctx.owner_edits).toEqual(['summary']);
  });

  it('a name linked on the card is saved linked: the save runs the owner\'s claim, and the card shows what ran', async () => {
    const { m, h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { claim: LINKED } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual({ summary: SAVE.summary, claim: SAVED });
    expect(h.calls[0]!.ctx.owner_edits).toEqual(['claim']);
    const rows = await m.store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ summary: SAVE.summary, claim: SAVED, claim_key: memoryClaimKey(SAVED) });
    // The contact it names links the note to her, as an agent's linked save does.
    expect(rows[0]!.provenance_entity_ids).toEqual(['dana@example.com']);
    expect(plan).toMatchObject({ status: 'approved', args: { summary: SAVE.summary, claim: SAVED } });
    expect(plan.args_hash).toBe(planApproval.computePlanArgsHash(plan.args));
    expect((await h.record(plan_id))!.execution).toMatchObject({ status: 'completed' });
    expect(h.activity.find((a) => a.action === 'chat_plan_approved')!.detail).toContain('"edited":["claim"]');
  });

  it('a relation in the owner\'s own words is saved as written; an agent can write it neither way', async () => {
    const { m, h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', { summary: "Lena is my cousin Sara's boyfriend's mother" }));
    const mine = { subject: { text: 'Lena' }, relation: "mother of my cousin's boyfriend", object: { text: 'cousin Sara' } };
    await handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { claim: mine } });
    expect((await m.store.list())[0]).toMatchObject({ claim: mine });
    const { owner_edits: _ownerEdits, ...agentCtx } = h.calls[0]!.ctx;
    // Agents keep to the list (§3.11) ...
    expect(await m.run('memory.write', { summary: 'Lena', claim: { subject: 'Lena', relation: mine.relation, object: 'cousin Sara' } }, agentCtx))
      .toMatchObject({ ok: false, reason: 'invalid_args' });
    // ... and a claim shaped as the owner's forms write it is not the owner's from a call.
    expect(await m.run('memory.write', { summary: 'Lena', claim: mine }, agentCtx))
      .toMatchObject({ ok: false, reason: 'invalid_args' });
    expect(await m.store.list()).toHaveLength(1);
  });

  it('a relationship cleared on the card saves the summary alone; one added to a save without one is saved', async () => {
    const { m, h } = setup();
    const cleared = planIdOf(await h.dispatch('turn-1', SAVE));
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id: cleared, edited_args: { claim: null } });
    expect(plan.args).toEqual({ summary: SAVE.summary });
    const added = planIdOf(await h.dispatch('turn-2', { summary: 'Dana rides a blue bicycle' }));
    const rides = { subject: { contact_id: 'c-dana', name: 'Dana' }, relation: 'owns', object: { asset_id: 'asset_bike', name: 'bike' } };
    await handlePlanApprove(h.rpcDeps, { plan_id: added, edited_args: { claim: rides } });
    const rows = await m.store.list();
    expect(rows.find((r) => r.summary === SAVE.summary)).not.toHaveProperty('claim');
    expect(rows.find((r) => r.summary === 'Dana rides a blue bicycle')).toMatchObject({
      claim: { subject: { contact_id: 'c-dana', name: 'Dana Whitfield' }, relation: 'owns', object: { asset_id: 'asset_bike', name: 'Blue bicycle' } },
    });
  });

  it('refused in the owner\'s words before anything is answered, and the card still approves as it was', async () => {
    const { h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    await expect(handlePlanApprove(h.rpcDeps, {
      plan_id, edited_args: { claim: { ...LINKED, object: { contact_id: 'c-gone', name: 'Ana Ruiz' } } },
    })).rejects.toMatchObject({ code: 'bad_request', message: 'Ana Ruiz is not in your contacts any more. Choose another contact, or write the name.' });
    await expect(handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { claim: { ...LINKED, relation: 'owns' } } }))
      .rejects.toMatchObject({ code: 'bad_request', message: '“owns” takes a thing as its second part, not a contact.' });
    await expect(handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: '  ' } }))
      .rejects.toMatchObject({ code: 'bad_request', message: 'Write what to remember, or say no to saving it.' });
    await expect(handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { replaces: 'umem_9' } }))
      .rejects.toMatchObject({ code: 'bad_request', message: "chat.plan.approve: 'replaces' cannot be changed while approving this" });
    expect(h.calls).toHaveLength(0);
    expect(h.asks.filter((a) => a.status === 'open')).toHaveLength(1);
    expect((await h.record(plan_id))!.plan).toMatchObject({ status: 'proposed', args: SAVE });
    expect([...h.checkpoints.values()][0]!.arg_overrides).toBeUndefined();
    await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(h.calls[0]!.args).toEqual(SAVE);
    expect(h.calls[0]!.ctx.owner_edits).toBeUndefined();
  });

  it('a card that takes no change refuses one rather than run what it first showed', async () => {
    const held = harness();
    const heldPlan = planIdOf(await held.dispatch('turn-1'));
    expect((await held.record(heldPlan))!.plan.editable_args).toBeUndefined();
    await expect(handlePlanApprove(held.rpcDeps, { plan_id: heldPlan, edited_args: { claim: null } }))
      .rejects.toMatchObject({ code: 'bad_request' });
    // A save whose hold could not be raised is a plain card, and takes none either.
    const m = memoryTool();
    const plain = harness({ tool: 'memory.write', run: m.run, claimRecords: lookups, hold: 'not_wired' });
    const plainPlan = planIdOf(await plain.dispatch('turn-1', SAVE));
    expect((await plain.record(plainPlan))!.plan).not.toHaveProperty('editable_args');
    await expect(handlePlanApprove(plain.rpcDeps, { plan_id: plainPlan, edited_args: { claim: LINKED } }))
      .rejects.toMatchObject({ code: 'bad_request', message: `chat.plan.approve: plan_id '${plainPlan}' takes no change while approving` });
    expect(held.calls).toHaveLength(0);
    expect((await plain.record(plainPlan))!.plan.status).toBe('proposed');
  });

  it('approved on the phone first: the card\'s change is not made, and what ran is the agent\'s', async () => {
    const { h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    await h.answerElsewhere('approve');
    await expect(handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { claim: LINKED } }))
      .rejects.toMatchObject({ code: 'bad_request' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual(SAVE);
    expect((await h.record(plan_id))!.plan.args).toEqual(SAVE);
  });

  it('checked again when it runs: a contact removed since it was approved refuses the save, in the owner\'s words', async () => {
    let removed = false;
    const { m, h } = setup({ contact: (id) => (removed ? null : lookups.contact!(id)), asset: lookups.asset! });
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    removed = true;
    await handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { claim: LINKED } });
    expect(await m.store.list()).toEqual([]);
    expect((await h.record(plan_id))!.execution).toMatchObject({
      // Named as the approval's check last read her.
      status: 'failed', detail: 'Dana Whitfield is not in your contacts any more. Choose another contact, or write the name.',
    });
  });

  it('an approval with a change is no evidence for a standing rule', async () => {
    const { h } = setup(undefined, true);
    for (const [turn, change] of [['turn-1', false], ['turn-2', true], ['turn-3', false]] as const) {
      const plan_id = planIdOf(await h.dispatch(turn, { summary: `${turn}: Mia is Dana's daughter`, claim: SAVE.claim }));
      await handlePlanApprove(h.rpcDeps, { plan_id, ...(change ? { edited_args: { claim: LINKED } } : {}) });
      h.tick(DAY);
    }
    expect(h.calls).toHaveLength(3);
    expect(h.writeRules!.listSuggestions(NOW + 3 * DAY)).toEqual([]);
    const plan_id = planIdOf(await h.dispatch('turn-4', { summary: 'Dana prefers phone calls' }));
    await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(h.writeRules!.listSuggestions(NOW + 4 * DAY)).toHaveLength(1);
  });

  /** Audit 2026-11-01 — the card answered from two devices at once, each with a change.
   *  The second's change to the hold, and its taking back, landed between the first's and
   *  its answer: the card said "Edit on device A" and memory saved the agent's words. */
  it('⛔ two answers with changes at once: what is saved is what the card shows', async () => {
    const { m, h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const answers = await Promise.allSettled([
      handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: 'Edit on device A' } }),
      handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: 'Edit on device B' } }),
    ]);
    const card = (await h.record(plan_id))!.plan;
    expect(card.status).toBe('approved');
    expect(h.calls).toHaveLength(1);
    expect((await m.store.list()).map((r) => r.summary)).toEqual([(card.args as { summary: string }).summary]);
    // The first answer is the card's; the second finds it answered, and changes nothing.
    expect(card.args).toEqual({ ...SAVE, summary: 'Edit on device A' });
    expect(answers.map((a) => a.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('the second finds it answered even once its ask is handled and gone, never "not ready yet"', async () => {
    const { m, h } = setup(undefined, false, true);
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const answers = await Promise.allSettled([
      handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: 'Edit on device A' } }),
      handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: 'Edit on device B' } }),
    ]);
    expect(answers.map((a) => a.status), JSON.stringify(answers.map((a) => (a.status === 'rejected' ? String(a.reason) : 'ok'))))
      .toEqual(['fulfilled', 'fulfilled']);
    expect((await m.store.list()).map((r) => r.summary)).toEqual(['Edit on device A']);
    expect((await h.record(plan_id))!.plan.args).toEqual({ ...SAVE, summary: 'Edit on device A' });
  });

  /** Audit 2026-11-01 (second) — a change whose proposal write threw stayed on the hold: the
   *  next yes, the card unchanged, saved "A failed edit" under "Mia is Dana's daughter". */
  it('⛔ a change that fails is taken back from the hold, and the next yes saves what the card shows', async () => {
    const { m, h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const run_id = (await h.record(plan_id))!.plan.hold!.run_id;
    const editHeld = h.plans.editHeld!.bind(h.plans);
    let failing = true;
    h.plans.editHeld = async (...args: Parameters<typeof editHeld>) => {
      if (failing) { failing = false; throw new Error('disk full'); }
      return editHeld(...args);
    };
    await expect(handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: 'A failed edit' } })).rejects.toThrow('disk full');
    // Taken back at once: the hold runs nothing the card does not show.
    expect([...h.checkpoints.values()].find((c) => c.run_id === run_id)!.arg_overrides ?? {}).toEqual({});
    expect((await h.record(plan_id))!.plan.args).toEqual(SAVE);
    await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual(SAVE);
    expect((await m.store.list()).map((r) => r.summary)).toEqual([SAVE.summary]);
  });

  it('⛔ a change left on the hold another way is not run: the yes runs what the card shows', async () => {
    const { m, h } = setup();
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const run_id = (await h.record(plan_id))!.plan.hold!.run_id;
    // As if taking the change back had failed too.
    const held = [...h.checkpoints.values()].find((c) => c.run_id === run_id)!;
    h.checkpoints.set(held.checkpoint_id, { ...held, arg_overrides: { summary: 'A failed edit', claim: null } });
    await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual(SAVE);
    expect(h.calls[0]!.ctx.owner_edits).toBeUndefined();
    expect((await m.store.list()).map((r) => [r.summary, r.claim !== undefined])).toEqual([[SAVE.summary, true]]);
    // A change the card shows is kept: it is what the owner approved.
    const shown = planIdOf(await h.dispatch('turn-2', SAVE));
    await handlePlanApprove(h.rpcDeps, { plan_id: shown, edited_args: { summary: 'Mia is Dana’s eldest daughter' } });
    expect(h.calls[1]!.args).toEqual({ ...SAVE, summary: 'Mia is Dana’s eldest daughter' });
  });

  it('the resume applies only what the tool takes a change to', () => {
    expect(ownerEditsFor('memory.write', { claim: null, replaces: 'umem_9' })).toEqual({ claim: null });
    expect(ownerEditsFor('memory.write', { replaces: 'umem_9' })).toBeUndefined();
    expect(ownerEditsFor('memory.write', { summary: 'Mine', replaces: 'umem_9' })).toEqual({ summary: 'Mine' });
    expect(ownerEditsFor('calendar.create', { claim: null })).toBeUndefined();
    expect(ownerEditsFor('memory.write', undefined)).toBeUndefined();
  });
});

describe('D-336 slice E — the plan table keeps an owner\'s change sealed', () => {
  const key = new Uint8Array(32).fill(7);
  const planTable = () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    createChatStore(db).createSession({
      id: 'sess-1', title: 'test', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
    } as never);
    return createSqliteChatPlanStore(db, () => key, () => NOW);
  };
  const heldPlan = (plans: ReturnType<typeof createSqliteChatPlanStore>) => {
    const args = { summary: "Mia is Dana's daughter", claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } };
    return plans.put({
      plan_id: 'plan-1', session_id: 'sess-1', turn_id: 'turn-1', tool: 'memory.write', tier: 1,
      classification: 'write', args, args_hash: planApproval.computePlanArgsHash(args), status: 'proposed',
      created_at: NOW, hold: { run_id: 'run-1' }, value_labels: { claim: { 'c-dana': 'Dana Whitfield' } },
    });
  };

  it('seals the new arguments to their own hash, keeps the names, and reads back what was changed', async () => {
    const plans = planTable();
    await heldPlan(plans);
    const args = { summary: "Mia is Dana's daughter", claim: { subject: { text: 'Mia' }, relation: 'daughter of', object: { contact_id: 'c-dana', name: 'Dana Whitfield' } } };
    const edited = await plans.editHeld!('plan-1', 'run-1', args);
    expect(edited).toMatchObject({ args, args_hash: planApproval.computePlanArgsHash(args), editable_args: ['claim', 'summary'],
      value_labels: { claim: { 'c-dana': 'Dana Whitfield' } } });
    expect(await plans.get('plan-1')).toEqual(edited);
  });

  it('leaves a plan held by another run, or already answered, as it is', async () => {
    const plans = planTable();
    await heldPlan(plans);
    expect(await plans.editHeld!('plan-1', 'run-2', { summary: 'other' })).toBeUndefined();
    await plans.resolve('plan-1', 'approved', NOW);
    expect(await plans.editHeld!('plan-1', 'run-1', { summary: 'other' })).toBeUndefined();
    expect((await plans.get('plan-1'))!.args).toMatchObject({ summary: "Mia is Dana's daughter" });
  });
});

describe('D-336 slice F — a held contact change runs on the card\'s yes, as the owner\'s', () => {
  const DANA = 'dana.whitfield@example.test';
  const contactTool = () => {
    const db = new Database(':memory:');
    const contacts = createContactStore(db);
    contacts.upsertManual({ email: DANA, name: 'Dana Whitfield' }, 1, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const handlers = buildChatTier1Handlers({
      getContactStore: () => contacts,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false, isOpGranted: () => true, isOwnerGoverned: () => true, isOwnerRecipeGranted: () => false,
      }),
    }) as Record<string, (args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>>;
    return { contacts, run: (name: string, args: unknown, ctx: ChatDispatchContext) => handlers[name]!(args, ctx) };
  };

  it('writes nothing while it waits, then the birthday at the owner\'s rank on yes', async () => {
    const c = contactTool();
    const h = harness({ tool: 'contact.write', run: c.run });
    const plan_id = planIdOf(await h.dispatch('turn-1', { target_id: DANA, birthday: '--03-04' }));
    expect(h.calls).toHaveLength(0);
    expect(c.contacts.get(DANA)!.birthday).toBeUndefined();

    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(plan.status).toBe('approved');
    expect(h.calls).toHaveLength(1);
    // The resume says it is the owner's yes, which is what makes the write theirs.
    expect(h.calls[0]!.ctx.owner_approved).toBe(true);
    const dana = c.contacts.get(DANA)!;
    expect(dana.birthday).toBe('--03-04');
    expect(dana.projection_provenance?.birthday?.source).toBe('manual');
    expect((await h.record(plan_id))!.execution).toMatchObject({ status: 'completed' });
  });

  it('declined, it writes nothing', async () => {
    const c = contactTool();
    const h = harness({ tool: 'contact.write', run: c.run });
    const plan_id = planIdOf(await h.dispatch('turn-1', { target_id: DANA, birthday: '--03-04' }));
    await handlePlanCancel(h.rpcDeps, { plan_id });
    expect(h.calls).toHaveLength(0);
    expect(c.contacts.get(DANA)!.birthday).toBeUndefined();
  });
});

describe('D-336 slice G — a held save is told the notes it meets, and its card and ask show them', () => {
  const MET: HeldCallNotices = {
    agent: 'It contradicts "Mia is Dana\'s daughter." (\'umem_1\'), which you saved.',
    memory_conflicts: [{ kind: 'contradicts', memory_id: 'umem_1', summary: "Mia is Dana's daughter." }],
  };
  const SISTER = { summary: "Mia is Dana's sister", claim: { subject: 'Mia', relation: 'sister of', object: 'Dana' } };

  it('slice J — its ask names the fact saved already, and a note of a kind this server does not know hides only itself', async () => {
    const already = { kind: 'saved_already', memory_id: 'umem_1', summary: "Mia is Dana's daughter." } as const;
    const notices: HeldCallNotices = {
      agent: 'Memory already holds this fact, as "Mia is Dana\'s daughter." (\'umem_1\'). Tell the user it is saved already: they can say no to this save.',
      // The second as a later server could store it, read back by this one.
      memory_conflicts: [already, { kind: 'a_later_kind', memory_id: 'umem_2', summary: 'Something else.' } as unknown as typeof already],
    };
    const h = harness({ tool: 'memory.write', notices: (name) => (name === 'memory.write' ? notices : undefined) });
    const answer = await h.dispatch('turn-1', { summary: "Dana's daughter is called Mia", claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } });
    const plan_id = planIdOf(answer);
    expect(!answer.ok && answer.detail).toBe(`plan_id=${plan_id}. ${HELD_WRITE_CARRIES_ON_DETAIL} ${notices.agent}`);
    expect(h.asks[0]!.message.text).toContain('Saved already: "Mia is Dana\'s daughter."');
    expect(h.asks[0]!.message.text).not.toContain('Something else');
    expect((await h.plans.get(plan_id))!.memory_conflicts).toEqual([already]);
    expect((await h.record(plan_id))!.plan.memory_conflicts).toEqual([already]);
  });

  it('records them on the proposal, its event and its hold, the ask reads them, and the model is told', async () => {
    const h = harness({ tool: 'memory.write', notices: (name) => (name === 'memory.write' ? MET : undefined) });
    const answer = await h.dispatch('turn-1', SISTER);
    const plan_id = planIdOf(answer);
    // The model reads it beside "it was sent to the owner".
    expect(!answer.ok && answer.detail).toBe(`plan_id=${plan_id}. ${HELD_WRITE_CARRIES_ON_DETAIL} ${MET.agent}`);
    expect((await h.plans.get(plan_id))!.memory_conflicts).toEqual(MET.memory_conflicts);
    expect(h.broadcasted.find((e) => e.kind === 'chat.plan_proposed')).toMatchObject({ plan_id, memory_conflicts: MET.memory_conflicts });
    const [checkpoint] = [...h.checkpoints.values()];
    expect(checkpoint!.preflight_context?.memory_conflicts).toEqual(MET.memory_conflicts);
    expect(h.asks[0]!.message.text).toContain('Contradicts: "Mia is Dana\'s daughter."');
    // A reloaded conversation shows them too; what runs is still what the model sent.
    expect((await h.record(plan_id))!.plan.memory_conflicts).toEqual(MET.memory_conflicts);
    expect((await h.plans.get(plan_id))!.args).toEqual(SISTER);
  });

  it('holds with nothing told when the lookup throws or finds nothing', async () => {
    const thrown = harness({ tool: 'memory.write', notices: () => { throw new Error('store went away'); } });
    const plan_id = planIdOf(await thrown.dispatch('turn-1', SISTER));
    expect((await thrown.plans.get(plan_id))!.memory_conflicts).toBeUndefined();
    expect((await thrown.plans.get(plan_id))!.hold).toBeDefined();
    const none = harness({ tool: 'memory.write', notices: () => undefined });
    const answer = await none.dispatch('turn-1', SISTER);
    expect(!answer.ok && answer.detail).toBe(`plan_id=${planIdOf(answer)}. ${HELD_WRITE_CARRIES_ON_DETAIL}`);
  });

  it('keeps them when the owner changes only the summary: the relationship they were found for stands', async () => {
    const h = harness({ tool: 'memory.write', notices: () => MET, claimRecords: {} });
    const plan_id = planIdOf(await h.dispatch('turn-1', SISTER));
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { summary: 'Mia and Dana are sisters' } });
    expect(plan.args).toEqual({ ...SISTER, summary: 'Mia and Dana are sisters' });
    // What a reload shows: the approval's own answer is the plan's shell, without them.
    expect((await h.plans.get(plan_id))!.memory_conflicts).toEqual(MET.memory_conflicts);
    expect((await h.record(plan_id))!.plan.memory_conflicts).toEqual(MET.memory_conflicts);
  });

  it('drops them when the owner changes the relationship on the card: they were for the one proposed', async () => {
    const h = harness({ tool: 'memory.write', notices: () => MET, claimRecords: {} });
    const plan_id = planIdOf(await h.dispatch('turn-1', SISTER));
    const changed = { subject: { text: 'Mia' }, relation: 'daughter of', object: { text: 'Dana' } };
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id, edited_args: { claim: changed } });
    expect(plan.status).toBe('approved');
    expect(plan.memory_conflicts).toBeUndefined();
    expect((await h.plans.get(plan_id))!.memory_conflicts).toBeUndefined();
  });
});

describe('D-336 slice N — a held chat write\'s approval leads to its card in Chat', () => {
  const SAVE = { summary: "Mia is Dana's daughter", claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } };
  /** `notification.pending_asks` as `compose-listeners` wires it: the finder over the plans. */
  const pendingAsks = (h: ReturnType<typeof harness>, find = createAskChatPlanFinder(h.plans)) =>
    handlePendingAsks({ listOpenAsks: async () => h.asks.filter((ask) => ask.status === 'open'), findAskChatPlan: find });

  it('names a held save\'s card, which can change it, while it waits; once answered, nothing', async () => {
    const h = harness({ tool: 'memory.write' });
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const { asks } = await pendingAsks(h);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.chat_plan).toEqual({ session_id: h.session_id, plan_id, changeable: true });
    await h.answerElsewhere('approve');
    expect(await createAskChatPlanFinder(h.plans)(h.asks[0]!)).toBeNull();
  });

  it('names the card of a held write it cannot change, for review only', async () => {
    const h = harness();
    const plan_id = planIdOf(await h.dispatch('turn-1'));
    expect((await pendingAsks(h)).asks[0]!.chat_plan).toEqual({ session_id: h.session_id, plan_id });
  });

  it('names nothing once the hold lapses, the owner says no, or the plan is held by another run', async () => {
    const lapsed = harness({ tool: 'memory.write' });
    const lapsedPlan = planIdOf(await lapsed.dispatch('turn-1', SAVE));
    const ask = lapsed.asks[0]!;
    await lapsed.expireHold((await lapsed.plans.get(lapsedPlan))!.hold!.run_id, true);
    expect(await createAskChatPlanFinder(lapsed.plans)(ask)).toBeNull();

    const declined = harness({ tool: 'memory.write' });
    planIdOf(await declined.dispatch('turn-1', SAVE));
    await declined.answerElsewhere('deny');
    expect(await createAskChatPlanFinder(declined.plans)(declined.asks[0]!)).toBeNull();

    const other = harness({ tool: 'memory.write' });
    planIdOf(await other.dispatch('turn-1', SAVE));
    const elsewhere = { ...other.asks[0]!, handler_payload: { ...other.asks[0]!.handler_payload, run_id: 'run-elsewhere' } };
    expect(await createAskChatPlanFinder(other.plans)(elsewhere)).toBeNull();
  });

  it('names nothing for an ask that is not a hold\'s, and one unreadable plan costs only its own link', async () => {
    const h = harness({ tool: 'memory.write' });
    const plan_id = planIdOf(await h.dispatch('turn-1', SAVE));
    const held = h.asks[0]!;
    const peer = { ...held, ask_id: 'ask-peer', handler_kind: 'peer.admission' } as PendingAsk;
    expect(await createAskChatPlanFinder(h.plans)(peer)).toBeNull();
    h.asks.push({ ...held, ask_id: 'ask-broken', created_at: held.created_at - 1 } as PendingAsk);
    const find = createAskChatPlanFinder(h.plans);
    const { asks } = await pendingAsks(h, async (ask) => {
      if (ask.ask_id === 'ask-broken') throw new Error('unreadable');
      return find(ask);
    });
    expect(asks.map((ask) => [ask.ask_id, ask.chat_plan?.plan_id])).toEqual([[held.ask_id, plan_id], ['ask-broken', undefined]]);
  });
});

describe('D-336 slice O — a held save is told of the saves of its fact still waiting', () => {
  const DAUGHTER = { subject: 'Mia', relation: 'daughter of', object: 'Dana Whitfield' };
  const FIRST = { summary: "Dana Whitfield's daughter is called Mia", claim: DAUGHTER };
  const SECOND = { summary: "Mia is Dana Whitfield's daughter", claim: DAUGHTER };
  const THIRD = { summary: 'Dana Whitfield 的女儿叫 Mia', claim: DAUGHTER };
  const ASKED = (summary: string) =>
    `You asked to save this fact already, as "${summary}", still waiting for the owner. `
    + 'Tell the user it was asked already: they can say no to this one.';
  /** The real `memory.write` and its notices over one memory store, reading the harness's own
   *  holds for the saves still waiting (`listWaitingTier1Calls`), as the server wires it. */
  const memoryTool = () => {
    const store = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), {} as never, {});
    let held: Pick<RawOpDispatchDeps, 'checkpointStore' | 'gatedActionStore'> = {};
    const deps: Parameters<typeof buildChatTier1Handlers>[0] = {
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getUserMemoryStore: () => store,
      getMemoryRedactionStore: () => createInMemoryCollection<MemoryRedactionRecord>(),
      getWaitingCalls: (tool) => listWaitingTier1Calls(held, tool),
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false, isOpGranted: () => true, isOwnerGoverned: () => true, isOwnerRecipeGranted: () => false,
      }),
    };
    const handlers = buildChatTier1Handlers(deps) as Record<string, (args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>>;
    return {
      store,
      run: (name: string, args: unknown, ctx: ChatDispatchContext) => handlers[name]!(args, ctx),
      notices: (name: string, args: unknown, ctx: ChatDispatchContext, stores: typeof held) => {
        held = stores;
        return name === 'memory.write' ? memoryAskNotices(deps, args, ctx) : undefined;
      },
    };
  };

  it('names the save still waiting on the later one\'s card and ask, and tells the model; the first names none', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices });
    const first = planIdOf(await h.dispatch('turn-1', FIRST));
    const answer = await h.dispatch('turn-2', SECOND);
    const second = planIdOf(answer);
    expect(!answer.ok && answer.detail).toBe(`plan_id=${second}. ${HELD_WRITE_CARRIES_ON_DETAIL} ${ASKED(FIRST.summary)}`);
    expect(h.asks[1]!.message.text).toContain(`Asked already: "${FIRST.summary}"`);
    // Kept with the proposal, as the card reads it, and read back by the plan store.
    expect((await h.record(second))!.plan.memory_conflicts).toEqual([{ kind: 'asked_already', summary: FIRST.summary }]);
    expect((await h.record(first))!.plan.memory_conflicts).toBeUndefined();
    expect(h.asks[0]!.message.text).not.toContain('Asked already');
  });

  it('once the first is approved, a later save meets it in memory, and still the other one waiting', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices });
    planIdOf(await h.dispatch('turn-1', FIRST));
    planIdOf(await h.dispatch('turn-2', SECOND));
    await h.answerElsewhere('approve');
    const saved = await m.store.list();
    expect(saved.map((row) => row.summary)).toEqual([FIRST.summary]);
    const third = planIdOf(await h.dispatch('turn-3', THIRD));
    expect((await h.record(third))!.plan.memory_conflicts).toEqual([
      { kind: 'saved_already', memory_id: saved[0]!.memory_id, summary: FIRST.summary },
      { kind: 'asked_already', summary: SECOND.summary },
    ]);
  });

  it('a save the owner said no to is not waiting, and neither is one of another fact', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices });
    planIdOf(await h.dispatch('turn-1', FIRST));
    await h.answerElsewhere('deny');
    planIdOf(await h.dispatch('turn-2', { summary: 'Mia is Sam Whitfield\'s daughter', claim: { ...DAUGHTER, object: 'Sam Whitfield' } }));
    const later = planIdOf(await h.dispatch('turn-3', SECOND));
    expect((await h.record(later))!.plan.memory_conflicts).toBeUndefined();
  });

  it('its open item — once a later save is held, the earlier card says "Asked again", kept and sent', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices, markWaitingSaves: true });
    const first = planIdOf(await h.dispatch('turn-1', FIRST));
    expect((await h.record(first))!.plan.memory_conflicts).toBeUndefined();
    const second = planIdOf(await h.dispatch('turn-2', SECOND));
    expect((await h.record(first))!.plan.memory_conflicts).toEqual([{ kind: 'asked_again', summary: SECOND.summary }]);
    // The later card still says it asked already.
    expect((await h.record(second))!.plan.memory_conflicts).toEqual([{ kind: 'asked_already', summary: FIRST.summary }]);
    // Sent to the card open now, as the card's own event.
    const resent = h.broadcasted.filter((e) => e.kind === 'chat.plan_proposed' && e.plan_id === first);
    expect(resent).toHaveLength(2);
    expect(resent[1]).toMatchObject({ held: true, memory_conflicts: [{ kind: 'asked_again', summary: SECOND.summary }] });
    // A third, in Chinese: both earlier cards hear of it.
    planIdOf(await h.dispatch('turn-3', THIRD));
    expect((await h.record(first))!.plan.memory_conflicts).toEqual([
      { kind: 'asked_again', summary: SECOND.summary }, { kind: 'asked_again', summary: THIRD.summary },
    ]);
    expect((await h.record(second))!.plan.memory_conflicts).toEqual([
      { kind: 'asked_already', summary: FIRST.summary }, { kind: 'asked_again', summary: THIRD.summary },
    ]);
  });

  it('its open item — a save of another fact marks none, and nor is a card already answered', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices, markWaitingSaves: true });
    const first = planIdOf(await h.dispatch('turn-1', FIRST));
    planIdOf(await h.dispatch('turn-2', { summary: "Mia is Sam Whitfield's daughter", claim: { ...DAUGHTER, object: 'Sam Whitfield' } }));
    expect((await h.record(first))!.plan.memory_conflicts).toBeUndefined();
    // The first open ask is the first save's.
    await h.answerElsewhere('approve');
    expect((await h.record(first))!.plan.status).toBe('approved');
    planIdOf(await h.dispatch('turn-3', SECOND));
    expect((await h.record(first))!.plan.memory_conflicts).toBeUndefined();
  });

  it('its open item — a marker that fails never fails the hold that told it', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices, markWaitingSaves: 'throws', fanout: ['ui', 'email'] });
    planIdOf(await h.dispatch('turn-1', FIRST));
    const result = await h.dispatch('turn-2', SECOND);
    const second = planIdOf(result);
    expect((await h.record(second))!.plan.status).toBe('proposed');
    expect(h.asks).toHaveLength(2);
    // Held as any other: the model is told where else it is answered.
    expect(result.ok ? '' : result.detail).toContain('This approval request also goes to the user');
  });

  it('its open item — the plan table adds a later save once, sealed with the rest, and leaves an answered card', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    createChatStore(db).createSession({
      id: 'sess-1', title: 'test', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
    } as never);
    const plans = createSqliteChatPlanStore(db, () => new Uint8Array(32).fill(7), () => NOW);
    await plans.put({
      plan_id: 'plan-1', session_id: 'sess-1', turn_id: 'turn-1', tool: 'memory.write', tier: 1, classification: 'write',
      args: FIRST, args_hash: planApproval.computePlanArgsHash(FIRST), status: 'proposed', created_at: NOW, hold: { run_id: 'run-1' },
    });
    const again = { kind: 'asked_again', summary: SECOND.summary } as const;
    expect((await plans.addMemoryConflict!('plan-1', again))!.memory_conflicts).toEqual([again]);
    expect((await plans.addMemoryConflict!('plan-1', again))!.memory_conflicts).toEqual([again]);
    // Slice S: and a save asked since that this one contradicts, read back the same.
    const contradicted = { kind: 'contradicts_asked', summary: "Mia is Dana Whitfield's sister" } as const;
    expect((await plans.addMemoryConflict!('plan-1', contradicted))!.memory_conflicts).toEqual([again, contradicted]);
    expect((await plans.get('plan-1'))!.memory_conflicts).toEqual([again, contradicted]);
    const stored = db.prepare('SELECT memory_conflicts_encrypted FROM chat_plans').get() as { memory_conflicts_encrypted: string };
    expect(stored.memory_conflicts_encrypted).not.toContain('Whitfield');
    await plans.resolve('plan-1', 'approved', NOW);
    expect(await plans.addMemoryConflict!('plan-1', { kind: 'asked_again', summary: 'another' })).toBeUndefined();
  });

  it('slice S — a later save contradicting one still waiting: its card, ask and answer say so, and the first card hears of it', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices, markWaitingSaves: true });
    const SISTER = { summary: "Mia is Dana Whitfield's sister", claim: { ...DAUGHTER, relation: 'sister of' } };
    const first = planIdOf(await h.dispatch('turn-1', FIRST));
    const answer = await h.dispatch('turn-2', SISTER);
    const second = planIdOf(answer);
    expect(!answer.ok && answer.detail).toBe(`plan_id=${second}. ${HELD_WRITE_CARRIES_ON_DETAIL} `
      + `It contradicts "${FIRST.summary}", which you asked to save, still waiting for the owner. `
      + 'Tell the user, and ask which is right: they can say no to the wrong one.');
    expect(h.asks[1]!.message.text).toContain(`Contradicts what was asked: "${FIRST.summary}"`);
    expect((await h.record(second))!.plan.memory_conflicts).toEqual([{ kind: 'contradicts_asked', summary: FIRST.summary }]);
    // The first card hears of the later one, kept and sent; its ask, sent already, is unchanged.
    expect((await h.record(first))!.plan.memory_conflicts).toEqual([{ kind: 'contradicts_asked', summary: SISTER.summary }]);
    const resent = h.broadcasted.filter((e) => e.kind === 'chat.plan_proposed' && e.plan_id === first);
    expect(resent.at(-1)).toMatchObject({ held: true, memory_conflicts: [{ kind: 'contradicts_asked', summary: SISTER.summary }] });
    expect(h.asks[0]!.message.text).not.toContain('Contradicts');
  });

  it('slice S — a tie that can hold beside it marks neither card', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices, markWaitingSaves: true });
    const first = planIdOf(await h.dispatch('turn-1', FIRST));
    const second = planIdOf(await h.dispatch('turn-2', {
      summary: "Mia is Dana Whitfield's goddaughter", claim: { ...DAUGHTER, relation: 'goddaughter of' },
    }));
    expect((await h.record(first))!.plan.memory_conflicts).toBeUndefined();
    expect((await h.record(second))!.plan.memory_conflicts).toBeUndefined();
  });

  it('lists the holds of the tool it is asked for only, oldest first', async () => {
    const source: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'sess-1', user_id: 'local' };
    const hold = (run_id: string, tool: string, created_at: number) => ({
      checkpoint_id: `cp-${run_id}`, run_id, created_at, step_state: {},
      raw_op: {
        tier1_tool: tool, op_id: tool, operation: tool, catalog_slug: '', connection_name: '',
        op_args: { summary: run_id }, execution_source: source, risk_tier: 'write',
      },
    }) as unknown as Checkpoint;
    const checkpointStore = { list: async () => [hold('b', 'memory.write', 2), hold('c', 'calendar.create', 1), hold('a', 'memory.write', 1)] };
    const waiting = await listWaitingTier1Calls({ checkpointStore: checkpointStore as never }, 'memory.write');
    expect(waiting.map((call) => [call.run_id, call.args.summary])).toEqual([['a', 'a'], ['b', 'b']]);
  });

  it('reads a waiting save as it will run: a claim the owner changed on its card', async () => {
    const m = memoryTool();
    const h = harness({ tool: 'memory.write', run: m.run, notices: m.notices });
    planIdOf(await h.dispatch('turn-1', FIRST));
    // As the card's yes writes it before answering (slice E), in the owner's form's shape.
    const [checkpoint] = [...h.checkpoints.values()];
    checkpoint!.arg_overrides = { claim: { subject: { text: 'Mia' }, relation: 'sister of', object: { text: 'Dana Whitfield' } } };
    const daughter = planIdOf(await h.dispatch('turn-2', SECOND));
    // Not the same fact as it will run: the sister it now says contradicts this one (slice S).
    expect((await h.record(daughter))!.plan.memory_conflicts).toEqual([{ kind: 'contradicts_asked', summary: FIRST.summary }]);
    const sister = planIdOf(await h.dispatch('turn-3', { summary: "Mia is Dana Whitfield's sister", claim: { ...DAUGHTER, relation: 'sister of' } }));
    expect((await h.record(sister))!.plan.memory_conflicts).toEqual([
      { kind: 'asked_already', summary: FIRST.summary }, { kind: 'contradicts_asked', summary: SECOND.summary },
    ]);
  });
});


describe('D-336 slice Q — a save is linked to the contact its turn added, once both have run', () => {
  /** Bench task 416's turn: "My niece Mia was born on 2 June 2015". */
  const MIA = { name: 'Mia', birthday: '2015-06-02' };
  const NIECE = { summary: "Mia is the owner's niece", claim: { subject: 'Mia', relation: 'niece of', object: 'owner' } };
  /** The real `contact.write` and `memory.write` over one contact store and one memory store,
   *  each telling the linker what it made as it runs, as the server wires them. */
  const setup = (writeRules = false, more: {
    /** As a Telegram or Slack chat runs it, whose source names no turn. */
    source?: (session_id: string, turn_id: string) => ExecutionSource;
    /** The turn a continuation's turn carries on (D-337's turn store), as the server wires it. */
    rootTurnOf?: (turn_id: string) => string | undefined;
  } = {}) => {
    const db = new Database(':memory:');
    const contacts = createContactStore(db);
    const store = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), {} as never, {});
    const redactions = createInMemoryCollection<MemoryRedactionRecord>();
    const records = ownerClaimRecords({ contacts });
    const events: unknown[] = [];
    const ledger = createClaimLinkLedger(db);
    const linker = createClaimLinker({
      ledger: () => ledger, memory: () => store, contacts: () => contacts, ownerRecords: () => records,
      redactions: () => redactions, bus: () => ({ emit: (event: unknown) => { events.push(event); } }) as never,
      ...(more.rootTurnOf !== undefined ? { rootTurnOf: more.rootTurnOf } : {}),
    });
    const handlers = buildChatTier1Handlers({
      getContactStore: () => contacts,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => undefined,
      getUserMemoryStore: () => store,
      getMemoryRedactionStore: () => redactions,
      getOwnerClaimRecords: () => records,
      onRecordMade: linker.recordMade,
      getOpAdmissionGate: () => ({
        isFrozenByPause: () => false, isOpGranted: () => true, isOwnerGoverned: () => true, isOwnerRecipeGranted: () => false,
      }),
    }) as Record<string, (args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>>;
    const h = harness({
      tools: ['contact.write', 'memory.write'],
      run: (name, args, ctx) => handlers[name]!(args, ctx),
      ...(writeRules ? { writeRules: true } : {}),
      ...(more.source !== undefined ? { source: more.source } : {}),
    });
    /** The contact a held add made, from its receipt. */
    const addedBy = async (plan_id: string) => {
      const execution = (await h.record(plan_id))!.execution;
      if (execution?.status !== 'completed' || execution.made?.kind !== 'contact') throw new Error('no contact made');
      return contacts.get(execution.made.target_id)!;
    };
    const note = async () => {
      const rows = await store.list();
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    return { h, contacts, store, redactions, events, addedBy, note };
  };
  const approve = async (h: ReturnType<typeof harness>, plan_id: string) => {
    const { plan } = await handlePlanApprove(h.rpcDeps, { plan_id });
    expect(plan.status).toBe('approved');
  };

  it('the add approved first, then the save: the save names the Mia the turn added, and is linked to her', async () => {
    const s = setup();
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(s.h, add);
    const mia = await s.addedBy(add);
    expect((await s.h.record(add))!.execution).toMatchObject({ made: { kind: 'contact', target_id: mia.email, name: 'Mia' } });
    expect(await s.store.list()).toEqual([]);
    await approve(s.h, save);
    const saved = await s.note();
    expect((await s.h.record(save))!.execution).toMatchObject({ made: { kind: 'memory', memory_id: saved.memory_id } });
    expect(saved.claim).toEqual({ subject: { contact_id: mia.contact_id, name: 'Mia' }, relation: 'niece of', object: { owner: true } });
    expect(saved.provenance_entity_ids).toEqual([mia.email]);
    // Found on her page now, not as matched by name.
    expect((await s.store.listClaimEnd(`contact:${mia.contact_id}`)).map((row) => row.memory_id)).toEqual([saved.memory_id]);
    expect(await s.store.listClaimEnd('text:mia')).toEqual([]);
    expect(saved.summary).toBe(NIECE.summary);
    expect(s.events).toEqual([{ kind: 'memory', subkind: 'user', id: saved.memory_id }]);
  });

  it('the save approved first, then the add: linked when the add runs', async () => {
    const s = setup();
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(s.h, save);
    const before = await s.note();
    expect(before.claim).toEqual({ subject: { text: 'Mia' }, relation: 'niece of', object: { owner: true } });
    expect(s.events).toEqual([]);
    await approve(s.h, add);
    const mia = await s.addedBy(add);
    const saved = await s.note();
    expect(saved.claim).toEqual({ subject: { contact_id: mia.contact_id, name: 'Mia' }, relation: 'niece of', object: { owner: true } });
    expect(saved.provenance_entity_ids).toEqual([mia.email]);
    // Only the link: the note is still the one the owner said yes to, by the AI that saved it.
    const rest = ({ claim: _c, claim_key: _k, claim_subject: _s, claim_object: _o, provenance_entity_ids: _p, ...row }: UserMemoryRow) => row;
    expect(rest(saved)).toEqual(rest(before));
    expect(s.events).toEqual([{ kind: 'memory', subkind: 'user', id: saved.memory_id }]);
  });

  it('a save a standing rule ran in the turn is linked to the contact the turn added, once that is approved', async () => {
    const s = setup(true);
    const DAY = 86_400_000;
    // Three saves approved on three days teach the owner's rule for saving notes.
    for (const [turn, who] of [['turn-a', 'Ann'], ['turn-b', 'Ben'], ['turn-c', 'Cy']] as const) {
      await approve(s.h, planIdOf(await s.h.dispatch(turn, { summary: `${who} likes tea`, claim: { subject: who, relation: 'likes', object: 'tea' } }, 'memory.write')));
      s.h.tick(DAY);
    }
    const [suggestion] = s.h.writeRules!.listSuggestions(NOW + 3 * DAY);
    expect(suggestion!.key).toMatchObject({ tool: 'memory.write' });
    s.h.writeRules!.accept(suggestion!.key_hash, {}, NOW + 3 * DAY);
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    // The save runs now, by the rule, before the add is approved.
    expect(await s.h.dispatch('turn-1', NIECE, 'memory.write')).toMatchObject({ ok: true });
    const before = (await s.store.list()).find((row) => row.summary === NIECE.summary)!;
    expect(before.claim).toMatchObject({ subject: { text: 'Mia' } });
    await approve(s.h, add);
    const mia = await s.addedBy(add);
    const saved = (await s.store.list()).find((row) => row.summary === NIECE.summary)!;
    expect(saved.claim).toEqual({ subject: { contact_id: mia.contact_id, name: 'Mia' }, relation: 'niece of', object: { owner: true } });
  });

  it('the add held, the save made in the turn that carries the reply on once it is approved: linked', async () => {
    // D-337 slice K: while the add waits, the save is not asked; the turn that carries the
    // conversation on after the approval makes it. Live, it was never linked (bench task 424).
    const s = setup(false, { rootTurnOf: (turn) => (turn === 'turn-2' ? 'turn-1' : undefined) });
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    await approve(s.h, add);
    const mia = await s.addedBy(add);
    const save = planIdOf(await s.h.dispatch('turn-2', NIECE, 'memory.write'));
    await approve(s.h, save);
    expect((await s.note()).claim).toEqual({ subject: { contact_id: mia.contact_id, name: 'Mia' }, relation: 'niece of', object: { owner: true } });
  });

  it('a save in a later turn that carries nothing on stays as words', async () => {
    const s = setup(false, { rootTurnOf: () => undefined });
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    await approve(s.h, add);
    await approve(s.h, planIdOf(await s.h.dispatch('turn-2', NIECE, 'memory.write')));
    expect((await s.note()).claim).toMatchObject({ subject: { text: 'Mia' } });
  });

  it('from a Telegram chat: the held add and save, approved later, are linked, their holds keeping the turn', async () => {
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    const s = setup(false, { source: () => telegram });
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    // Its source names no turn, so each hold keeps it.
    expect([...s.h.checkpoints.values()].map((c) => c.raw_op?.tier1_turn_id)).toEqual(['turn-1', 'turn-1']);
    await approve(s.h, add);
    await approve(s.h, save);
    const mia = await s.addedBy(add);
    expect((await s.note()).claim).toEqual({ subject: { contact_id: mia.contact_id, name: 'Mia' }, relation: 'niece of', object: { owner: true } });
  });

  it('an app chat\'s hold keeps no turn of its own: its source carries it', async () => {
    const s = setup();
    planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    expect([...s.h.checkpoints.values()].map((c) => c.raw_op?.tier1_turn_id)).toEqual([undefined]);
  });

  it('declined, the add links nothing, and the save stays as words', async () => {
    const s = setup();
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    await handlePlanCancel(s.h.rpcDeps, { plan_id: add });
    await approve(s.h, save);
    expect((await s.note()).claim).toMatchObject({ subject: { text: 'Mia' } });
    expect(s.events).toEqual([]);
  });

  it('a contact another turn added is not linked', async () => {
    const s = setup();
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-2', NIECE, 'memory.write'));
    await approve(s.h, add);
    await approve(s.h, save);
    expect((await s.note()).claim).toMatchObject({ subject: { text: 'Mia' } });
    expect((await s.note()).provenance_entity_ids).toBeUndefined();
  });

  it('a contact the turn changed, not added, is not linked: its id was the AI\'s to give', async () => {
    const s = setup();
    const known = s.contacts.createMentionOnlyContact({ name: 'Mia' }, NOW, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const change = planIdOf(await s.h.dispatch('turn-1', { target_id: known.email, birthday: '2015-06-02' }, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(s.h, change);
    await approve(s.h, save);
    expect(s.contacts.get(known.email)!.birthday).toBe('2015-06-02');
    expect((await s.h.record(change))!.execution).not.toHaveProperty('made');
    expect((await s.note()).claim).toMatchObject({ subject: { text: 'Mia' } });
  });

  it('two contacts the turn added under one name are not told apart: neither is linked', async () => {
    const s = setup();
    const first = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const second = planIdOf(await s.h.dispatch('turn-1', { name: 'Mia', birthday: '2017-09-12' }, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    for (const plan_id of [first, second, save]) await approve(s.h, plan_id);
    expect((await s.addedBy(first)).contact_id).not.toBe((await s.addedBy(second)).contact_id);
    expect((await s.note()).claim).toMatchObject({ subject: { text: 'Mia' } });
  });

  it('only words that are the name exactly, where the relation takes a person', async () => {
    const s = setup();
    // "My niece Mia works at Bloom": an add of Bloom as a contact, which a workplace never links to.
    const mia = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const bloom = planIdOf(await s.h.dispatch('turn-1', { name: 'Bloom' }, 'contact.write'));
    const works = planIdOf(await s.h.dispatch('turn-1', {
      summary: 'Mia works at Bloom', claim: { subject: '  Mia ', relation: 'works at', object: 'Bloom' },
    }, 'memory.write'));
    const other = planIdOf(await s.h.dispatch('turn-1', {
      summary: "Mia Whitfield is the owner's niece", claim: { subject: 'Mia Whitfield', relation: 'niece of', object: 'owner' },
    }, 'memory.write'));
    const lower = planIdOf(await s.h.dispatch('turn-1', {
      summary: 'mia is the niece', claim: { subject: 'mia', relation: 'niece of', object: 'owner' },
    }, 'memory.write'));
    for (const plan_id of [mia, bloom, works, other, lower]) await approve(s.h, plan_id);
    const added = await s.addedBy(mia);
    const rows = await s.store.list();
    expect(rows.find((row) => row.summary === 'Mia works at Bloom')!.claim)
      .toEqual({ subject: { contact_id: added.contact_id, name: 'Mia' }, relation: 'works at', object: { text: 'Bloom' } });
    expect(rows.find((row) => row.summary?.startsWith('Mia Whitfield') === true)!.claim).toMatchObject({ subject: { text: 'Mia Whitfield' } });
    expect(rows.find((row) => row.summary === 'mia is the niece')!.claim).toMatchObject({ subject: { text: 'mia' } });
  });

  it('an end the owner linked on the card stays as they left it', async () => {
    const s = setup();
    s.contacts.upsertManual({ email: 'mia.whitfield@example.test', name: 'Mia Whitfield' }, NOW, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const whitfield = s.contacts.get('mia.whitfield@example.test')!;
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(s.h, add);
    const linked = { subject: { contact_id: whitfield.contact_id!, name: 'Mia Whitfield' }, relation: 'niece of', object: { owner: true } };
    await handlePlanApprove({ ...s.h.rpcDeps, claimRecords: ownerClaimRecords({ contacts: s.contacts }) }, { plan_id: save, edited_args: { claim: linked } });
    expect((await s.note()).claim).toEqual(linked);
  });

  it('a save forgotten before the add ran stays as it was', async () => {
    const s = setup();
    const add = planIdOf(await s.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await s.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(s.h, save);
    const saved = await s.note();
    await s.redactions.set(saved.memory_id, { memory_id: saved.memory_id, redacted_at: NOW });
    await approve(s.h, add);
    expect((await s.note()).claim).toEqual(saved.claim);
    expect(s.events).toEqual([]);
  });

  it('a contact given an address since is linked by it, and one merged since to the contact it joined', async () => {
    const promoted = setup();
    const add = planIdOf(await promoted.h.dispatch('turn-1', MIA, 'contact.write'));
    const save = planIdOf(await promoted.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(promoted.h, add);
    const mia = await promoted.addedBy(add);
    promoted.contacts.promoteMentionOnlyToVerified({ contact_id: mia.contact_id!, email: 'mia@example.test' }, NOW,
      { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    // And renamed by the owner: the link names her as she is now.
    promoted.contacts.upsertManual({ email: 'mia@example.test', name: 'Mia Whitfield' }, NOW + 1, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    await approve(promoted.h, save);
    const linked = await promoted.note();
    expect(linked.claim).toMatchObject({ subject: { contact_id: promoted.contacts.get('mia@example.test')!.contact_id, name: 'Mia Whitfield' } });
    expect(linked.provenance_entity_ids).toEqual(['mia@example.test']);

    const merged = setup();
    merged.contacts.upsertManual({ email: 'mia.whitfield@example.test', name: 'Mia Whitfield' }, NOW, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const whitfield = merged.contacts.get('mia.whitfield@example.test')!;
    const mergedAdd = planIdOf(await merged.h.dispatch('turn-1', MIA, 'contact.write'));
    const mergedSave = planIdOf(await merged.h.dispatch('turn-1', NIECE, 'memory.write'));
    await approve(merged.h, mergedAdd);
    merged.contacts.setMergedInto([await merged.addedBy(mergedAdd)], whitfield.email, NOW);
    await approve(merged.h, mergedSave);
    // Named as the contact is now: a merge takes each field's strongest value (D-192).
    expect((await merged.note()).claim)
      .toMatchObject({ subject: { contact_id: whitfield.contact_id, name: merged.contacts.get(whitfield.email)!.name } });
    expect((await merged.note()).provenance_entity_ids).toEqual([whitfield.email]);
  });

  it('the plan table keeps what a receipt made, sealed with the rest of it, and drops a malformed one', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    createChatStore(db).createSession({
      id: 'sess-1', title: 'test', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
    } as never);
    const plans = createSqliteChatPlanStore(db, () => new Uint8Array(32).fill(7), () => NOW);
    const receipt = async (plan_id: string, made: unknown) => {
      await plans.put({
        plan_id, session_id: 'sess-1', turn_id: 'turn-1', tool: 'contact.write', tier: 1, classification: 'write',
        args: { name: 'Mia' }, args_hash: planApproval.computePlanArgsHash({ name: 'Mia' }), status: 'proposed', created_at: NOW,
      });
      await plans.resolve(plan_id, 'approved', NOW);
      await plans.markConsumed(plan_id, NOW, 'turn-1');
      await plans.recordExecution!(plan_id, { status: 'completed', turn_id: 'turn-1', result_ref: `reply-${plan_id}`, made } as never);
    };
    await receipt('plan-1', { kind: 'contact', target_id: 'mention-only-1@_recued.invalid', name: 'Mia Whitfield' });
    await receipt('plan-2', { kind: 'contact', target_id: 7, name: 'Mia' });
    const made = Object.fromEntries((await plans.listForTurn('sess-1', 'turn-1')).map((record) =>
      [record.plan.plan_id, record.execution?.status === 'completed' ? record.execution.made : 'none']));
    expect(made).toEqual({ 'plan-1': { kind: 'contact', target_id: 'mention-only-1@_recued.invalid', name: 'Mia Whitfield' }, 'plan-2': undefined });
    const stored = db.prepare('SELECT execution_blob_encrypted FROM chat_plans').all() as Array<{ execution_blob_encrypted: string }>;
    expect(stored.some((row) => row.execution_blob_encrypted.includes('Whitfield'))).toBe(false);
  });
});
