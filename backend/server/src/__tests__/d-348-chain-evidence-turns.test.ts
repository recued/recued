/** D-348 slice 1 — a request of the owner's chats, the calls it held, the owner's answer to each, and
 *  how each ended, kept as the evidence chains are learned from.
 *
 *  Through the REAL orchestrator (whole turns, a model's rounds), plan store, hold, notification
 *  block and resumer, with the chain store wired as the server wires it (`wire-chat-orchestrator.ts`,
 *  the execute deps). */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
} from '@recued/chat';
import {
  chainCallSignatureHash,
  chainRequestKeyHash,
  normalizeChainRequestWords,
  type AIOutput,
  type ChatDispatchResult,
  type Checkpoint,
  type ExecutionSource,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type CheckpointStore,
} from '@recued/storage';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createHoldTier1Write } from '../chat-held-writes.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createChainEvidenceStore } from '../storage/chain-evidence-store.js';
import { createChainRuleStore } from '../storage/chain-rule-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-d348' };
const NOW = 1_762_000_000_000;
const DAY = 86_400_000;
const entry = (name: string, classification: ToolEntry['classification'] = 'write'): ToolEntry => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification, concurrency_safe: false,
});
/** A call the gateway held for approval, as a recipe or a pack action returns it. */
const GATEWAY_HELD = 'gateway.held';
const TOOLS = ['work.create', 'memory.write', GATEWAY_HELD];

const scheduledPrompt = {
  schedule_id: 'ps_1', occurrence_id: 'ps_1:3:100', revision: 3, due_at: 1, cron: '0 7 * * *', prompt_sha256: '1'.repeat(64),
};

const fixture = (firstRounds: readonly AIOutput[]) => {
  let rounds = firstRounds;
  let clock = NOW;
  const now = () => clock;
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  chatStore.createSession({ id: 'chat-a', title: 'chat-a', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' } } as never);
  const plans = createSqliteChatPlanStore(db, undefined, now);
  const calls: string[] = [];
  /** Whether each dispatch carried the owner's yes (D-325's `owner_approved`). */
  const ownerApproved: boolean[] = [];
  const registry: InternalToolRegistry = {
    list: () => TOOLS.map((name) => entry(name, name === GATEWAY_HELD ? 'read' : 'write')),
    listByTier: (tier) => (tier === 1 ? TOOLS.map((name) => entry(name, name === GATEWAY_HELD ? 'read' : 'write')) : []),
    getByName: (name) => (TOOLS.includes(name) ? entry(name, name === GATEWAY_HELD ? 'read' : 'write') : null),
    dispatch: async (name, _args, ctx): Promise<ChatDispatchResult> => {
      calls.push(name);
      ownerApproved.push((ctx as { owner_approved?: boolean } | undefined)?.owner_approved === true);
      return name === GATEWAY_HELD
        ? { ok: true, run_id: 'run-gw', run_held: { kind: 'approval' }, result: { status: 'awaiting_approval' } } as ChatDispatchResult
        : { ok: true, result: { created: true } };
    },
    subscribeRefresh: () => () => undefined,
  };
  const rows = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); },
    get: async (id: string) => rows.get(id) ?? null,
    delete: async (id: string) => { rows.delete(id); },
    listByRun: async (r: string) => [...rows.values()].filter((c) => c.run_id === r),
    list: async () => [...rows.values()],
    size: async () => rows.size,
  } as unknown as CheckpointStore;
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore, channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
  });
  const chains = createChainEvidenceStore(db);
  const chainRules = createChainRuleStore(db, chains);
  // What the owner is told, through the real block.
  const notices: string[] = [];
  const notify = block.notify.bind(block);
  vi.spyOn(block, 'notify').mockImplementation(async (notice, ...rest) => {
    notices.push(notice.title ?? '');
    return notify(notice, ...rest);
  });
  let seq = 0;
  const executeDeps = {
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    internalRegistry: registry,
    tier1Registry: () => registry,
    checkpointStore,
    preflightNotifier: block,
    gatedActionStore: createGatedActionStore(createInMemoryCollection<GatedActionRecord>()),
    mcpActionStore: createMcpActionStore(createInMemoryCollection<McpActionRecord>()),
    approvalResumeAuthority: {
      resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({ admitted: true, execution_source }),
    },
    opAdmissionGate: { isOpGranted: () => true, isFrozenByPause: () => false },
    newId: () => `id-${String((seq += 1))}`,
    now,
    auditLog,
    chainEvidence: chains,
    chainRules,
  };
  registerPreflightHandler(block, {
    checkpointStore,
    resumer: createPreflightResumer({ auditLog, getExecuteDeps: () => executeDeps as unknown as ExecuteHandlerDeps }),
  });
  let round = 0;
  const events: Array<Record<string, unknown>> = [];
  const orchestrator = createChatOrchestrator({
    broadcast: { emit: (event: unknown) => { events.push(event as Record<string, unknown>); } } as never,
    executeAiCall: async () => ({ body: rounds[Math.min((round += 1), rounds.length) - 1]! }),
    chatStore,
    registry,
    selfSignature: signature,
    planApprovalStore: plans,
    auditLog,
    holdTier1Write: createHoldTier1Write(() => executeDeps as never),
    // As `wire-chat-orchestrator` wires them.
    chainEvidence: () => executeDeps.chainEvidence,
    chainRules: () => executeDeps.chainRules,
    now,
    mintId: () => `mint-${String((seq += 1))}`,
  });
  const table = (name: string) => db.prepare(`SELECT * FROM ${name}`).all() as Array<Record<string, unknown>>;
  const answer = async (option: string) => {
    const [ask] = await askStore.listByStatus('open');
    if (ask === undefined) throw new Error('no open ask');
    await block.submitAnswer({ ask_id: ask.ask_id, option, via: 'ui' });
  };
  /** A whole turn; `turnRounds` scripts its model, else the rounds the fixture was given. */
  const runTurn = (message: string, over: Record<string, unknown> = {}, turnRounds?: readonly AIOutput[]) => {
    round = 0;
    if (turnRounds !== undefined) rounds = turnRounds;
    return orchestrator.runTurn({ session_id: 'chat-a', picker_state: { current: 'self' }, message, ...over } as never);
  };
  return {
    orchestrator, chains, chainRules, notices, table, answer, runTurn, calls, ownerApproved,
    open: () => askStore.listByStatus('open'), events,
    tick: (ms: number) => { clock += ms; }, now,
    activities: async (action: string) => (await auditLog.listActivities()).filter((row) => row.action === action),
  };
};

const addTask = (title: string): AIOutput => ({ response: '', events: [], tool_calls: [{ tool: 'work.create', args: { kind: 'task', title } }] });
const done = (text = 'It waits for your approval.'): AIOutput => ({ response: text, events: [], tool_calls: [] });
const keyOf = (words: string) => chainRequestKeyHash(normalizeChainRequestWords(words));

describe('D-348 slice 1 — in a whole turn of the owner\'s app chat', () => {
  it('its held write is kept under its request, with the owner\'s answer and how it ended', async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    const ack = await f.runTurn('Add the weekly review task.');
    expect(f.calls).toEqual([]);
    await vi.waitFor(() => expect(f.table('chain_requests')).toHaveLength(1));
    const [request] = f.table('chain_requests');
    expect(request).toMatchObject({
      request_id: ack.turn_id, session_id: 'chat-a', key_hash: keyOf('Add the weekly review task.'),
      occasion: `chat:chat-a|${String(Math.floor(NOW / DAY))}`,
    });
    expect(await f.chains.open('request', ack.turn_id, request!.words_encrypted as string)).toBe('Add the weekly review task.');
    expect(f.table('chain_runs').map((row) => row.request_id)).toEqual([ack.turn_id]);

    await f.answer('approve');
    await vi.waitFor(() => expect(f.calls).toEqual(['work.create']));
    await vi.waitFor(() => expect(f.table('chain_calls')[0]).toMatchObject({ outcome: 'ran' }));
    expect(f.table('chain_calls')[0]).toMatchObject({
      request_id: ack.turn_id, answer: 'approved', is_delete: 0,
      signature_hash: chainCallSignatureHash({ op: 'tier1:work.create:task', pins: {} }),
    });
  });

  it('refused, it is kept as refused', async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    await f.runTurn('Add the weekly review task.');
    await f.answer('deny');
    await vi.waitFor(() => expect(f.table('chain_calls')).toHaveLength(1));
    expect(f.table('chain_calls')[0]).toMatchObject({ answer: 'refused', outcome: null });
    expect(f.calls).toEqual([]);
  });

  it('a call the gateway held (a recipe\'s step, a pack action) is the request\'s too', async () => {
    const f = fixture([{ response: '', events: [], tool_calls: [{ tool: GATEWAY_HELD, args: {} }] }, done()]);
    const ack = await f.runTurn('Send Ann the agenda');
    await vi.waitFor(() => expect(f.table('chain_runs')).toHaveLength(1));
    expect(f.table('chain_runs')[0]).toMatchObject({ run_id: 'run-gw', request_id: ack.turn_id });
  });

  it('a turn that holds nothing keeps nothing', async () => {
    const f = fixture([done('Hello.')]);
    await f.runTurn('Hello there');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.table('chain_requests')).toEqual([]);
    expect(f.table('chain_runs')).toEqual([]);
  });

  it('a scheduled prompt\'s turn teaches nothing (Q5)', async () => {
    const f = fixture([addTask('Water the plants'), done()]);
    await f.runTurn('Add the watering task', { scheduled_prompt: scheduledPrompt });
    expect(await f.open()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.table('chain_requests')).toEqual([]);
    expect(f.table('chain_runs')).toEqual([]);
  });

  it('a turn that carries a held call\'s conversation on is part of the request that made the call', async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    const first = await f.runTurn('Add the weekly review task.');
    await vi.waitFor(() => expect(f.table('chain_runs')).toHaveLength(1));
    // Answered, the conversation carries on (D-337); until then a second write of the turn's waits.
    await f.answer('approve');
    await vi.waitFor(() => expect(f.calls).toEqual(['work.create']));
    // The continuation D-337 queues: the record of the answer, never the owner's words.
    const next = await f.runTurn('Approved: Add a task', {
      continuation_of_turn_id: first.turn_id,
      held_results: [{ tool_name: 'work.create', tier: 1, args: { kind: 'task', title: 'Weekly review' }, status: 'ok',
        result: { created: true }, started_at: NOW, completed_at: NOW }],
    }, [addTask('Book the room'), done('That one waits too.')]);
    expect(next.turn_id).not.toBe(first.turn_id);
    await vi.waitFor(() => expect(f.table('chain_runs')).toHaveLength(2));
    expect(f.table('chain_runs').map((row) => row.request_id)).toEqual([first.turn_id, first.turn_id]);
    expect(f.table('chain_requests')).toHaveLength(1);
  });
});

describe('D-348 slice 1 — in a turn of the owner\'s messenger chat', () => {
  it('its held write is kept under the words the owner sent, on that conversation\'s day', async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    const sessionStore = createInMemorySessionStore();
    let handler: ((inbound: ChannelInbound) => void | Promise<void>) | null = null;
    const channel = {
      surface: 'messenger-telegram',
      async deliver() { /* the reply is not under test */ },
      onInbound(h: (inbound: ChannelInbound) => void | Promise<void>) { handler = h; },
    } as unknown as Channel;
    let turn: Promise<unknown> | undefined;
    channel.onInbound((inbound) => { turn = f.orchestrator.runMessengerTurn({ channel, sessionStore, inbound }); });
    const source = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource;
    sessionStore.append({ session_id: 'chat-a', surface: 'messenger-telegram', role: 'user', text: 'Add the weekly review task', ts: NOW });
    await handler!({
      session_id: 'chat-a', surface: 'messenger-telegram', text: 'Add the weekly review task', from: '42', source,
      dispatch_depth: 0, ts: NOW,
    } as ChannelInbound);
    await turn;
    await vi.waitFor(() => expect(f.table('chain_requests')).toHaveLength(1));
    expect(f.table('chain_requests')[0]).toMatchObject({
      key_hash: keyOf('Add the weekly review task'), occasion: `messenger:telegram:42|${String(Math.floor(NOW / DAY))}`,
    });
    expect(f.table('chain_runs')).toHaveLength(1);
  });
});

describe('D-348 slice 2 — the same request on three days, each approved', () => {
  it('opens its suggestion, tells the owner once, and lists the words and the call', async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    for (const n of [1, 2, 3]) {
      // Each week's task its own: a task created in Recued pins nothing, so the chain is one call.
      // (This harness resolves no card when its run settles, so a repeat of the same call would
      // read as the earlier ask, D-337 slice K.)
      await f.runTurn('Add the weekly review task.', {}, [addTask(`Weekly review, week ${String(n)}`), done()]);
      await f.answer('approve');
      await vi.waitFor(() => expect(f.calls).toHaveLength(n));
      await vi.waitFor(() => expect(f.table('chain_calls').filter((row) => row.outcome === 'ran')).toHaveLength(n));
      if (n < 3) {
        expect(await f.chainRules.listSuggestions(f.now())).toEqual([]);
        f.tick(DAY);
      }
    }
    await vi.waitFor(() => expect(f.notices).toEqual(['A rule Recued suggests: a request you repeat']));
    const [suggestion] = await f.chainRules.listSuggestions(f.now());
    expect(suggestion).toMatchObject({
      words: 'Add the weekly review task.', members: [{ signature: { op: 'tier1:work.create:task', pins: {} } }],
      evidence: { occasions: 3 },
    });
  });
});

describe('D-348 slice 4 — a request with a rule: its chat writes run without asking', () => {
  /** Three days of the request, each task approved, and the owner accepts the suggestion. */
  const ruled = async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    for (const n of [1, 2, 3]) {
      await f.runTurn('Add the weekly review task.', {}, [addTask(`Weekly review, week ${String(n)}`), done()]);
      await f.answer('approve');
      await vi.waitFor(() => expect(f.calls).toHaveLength(n));
      await vi.waitFor(() => expect(f.table('chain_calls').filter((row) => row.outcome === 'ran')).toHaveLength(n));
      f.tick(DAY);
    }
    const [suggestion] = await f.chainRules.listSuggestions(f.now());
    const { rule } = await f.chainRules.accept(suggestion!.key_hash, {}, f.now());
    return { f, rule };
  };

  it('the same request: its task runs without asking, spends one use, and is no evidence', async () => {
    const { f, rule } = await ruled();
    const runs = f.table('chain_runs').length;
    await f.runTurn('Add the weekly review task.', {}, [addTask('Weekly review, week 4'), done('Added.')]);
    expect(f.calls).toHaveLength(4);
    // Run as the owner's own yes, as a write a D-329 rule lets through is (D-325).
    expect(f.ownerApproved[3]).toBe(true);
    expect(await f.open()).toEqual([]);
    expect((await f.chainRules.listRules(f.now()))[0]).toMatchObject({ rule_id: rule.rule_id, uses_remaining: 99 });
    expect((await f.activities('chain_rule_used')).map((row) => JSON.parse(row.detail!)))
      .toEqual([{ rule_id: rule.rule_id, uses_remaining: 99, tier: 1 }]);
    expect(f.table('chain_runs')).toHaveLength(runs);
  });

  it('another wording, a write not on the chain, and a scheduled prompt still ask', async () => {
    const { f } = await ruled();
    await f.runTurn('Please add the weekly review task', {}, [addTask('Weekly review, week 4'), done()]);
    expect(await f.open()).toHaveLength(1);
    await f.answer('deny');
    await f.runTurn('Add the weekly review task.', {},
      [{ response: '', events: [], tool_calls: [{ tool: 'memory.write', args: { summary: 'The review is on Fridays' } }] }, done()]);
    expect(await f.open()).toHaveLength(1);
    await f.answer('deny');
    await f.runTurn('Add the weekly review task.', { scheduled_prompt: scheduledPrompt }, [addTask('Weekly review, week 5'), done()]);
    expect(await f.open()).toHaveLength(1);
    expect(f.calls).toHaveLength(3);
  });

  it('⛔ never while an ask for that very call is out: approving it later would run it twice', async () => {
    const f = fixture([addTask('Weekly review'), done()]);
    for (const n of [1, 2, 3]) {
      await f.runTurn('Add the weekly review task.', {}, [addTask(`Weekly review, week ${String(n)}`), done()]);
      await f.answer('approve');
      await vi.waitFor(() => expect(f.table('chain_calls').filter((row) => row.outcome === 'ran')).toHaveLength(n));
      f.tick(DAY);
    }
    // Asked on day 4 and not yet answered; then the owner accepts the rule.
    await f.runTurn('Add the weekly review task.', {}, [addTask('Weekly review, week 4'), done()]);
    expect(await f.open()).toHaveLength(1);
    const [suggestion] = await f.chainRules.listSuggestions(f.now());
    await f.chainRules.accept(suggestion!.key_hash, {}, f.now());
    // The very same call again: it is that ask, not a use of the rule.
    await f.runTurn('Add the weekly review task.', {}, [addTask('Weekly review, week 4'), done()]);
    expect(f.calls).toHaveLength(3);
    expect((await f.chainRules.listRules(f.now()))[0]!.uses_remaining).toBe(100);
  });

  it('a turn that carries the request on uses its rule', async () => {
    const { f } = await ruled();
    // The task runs on the rule; a note it also saves is not on the chain, and is held.
    const first = await f.runTurn('Add the weekly review task.', {}, [{ response: '', events: [], tool_calls: [
      { tool: 'work.create', args: { kind: 'task', title: 'Weekly review, week 4' } },
      { tool: 'memory.write', args: { summary: 'The review moved to Fridays' } },
    ] }, done()]);
    expect(f.calls).toHaveLength(4);
    expect(await f.open()).toHaveLength(1);
    await f.answer('approve');
    await vi.waitFor(() => expect(f.calls).toHaveLength(5));
    // The conversation carries on (D-337): a task it adds then is the request's, and runs on its rule.
    await f.runTurn('Approved: Save a note', {
      continuation_of_turn_id: first.turn_id,
      held_results: [{ tool_name: 'work.create', tier: 1, args: { kind: 'task', title: 'x' }, status: 'ok',
        result: { created: true }, started_at: NOW, completed_at: NOW }],
    }, [addTask('Weekly review, week 4, part 2'), done()]);
    expect(f.calls).toHaveLength(6);
    expect(await f.open()).toEqual([]);
  });
});
