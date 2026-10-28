/** D-329 slice A — an AI app's Tier-1 write is held for the owner, and approving runs it.
 *
 *  The owner: "keep our story consistent". Over MCP no Tier-1 tool was held: a `write` tool
 *  ran as soon as its switches were on. It is now held as a write raw op is (a recipe-less
 *  checkpoint marked `tier1_tool`, the receipt behind the app's `action_ref`, the fanned-out
 *  ask) and resumed through the tool registry on fresh authority. Driven through the REAL
 *  `handleToolCall`, `buildPreflightAsk` and `createPreflightResumer`; only the registry's
 *  tool, the authority resolver and the grant gate are doubles, and each test that refuses
 *  checks the tool never ran. */

import { describe, expect, it } from 'vitest';
import {
  TIER1_HOLD_CATALOG_SLUG,
  isCheckpoint,
  qualifyWorkEntityId,
  RECUED_BUILTIN_SOURCE_ID,
  tier1WriteStaysInRecued,
  type ApprovalValueLabels,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type Checkpoint,
  type ExecutionSource,
  type InternalToolRegistry,
  type ToolEntry,
} from '@recued/contracts';
import { buildPreflightAsk, type PreflightNotifier } from '@recued/gateway';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type CheckpointStore,
} from '@recued/storage';
import { _testing } from '../mcp-server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { HELD_FOR_APPROVAL_MESSAGE } from '../run-result-agent-projection.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import Database from 'better-sqlite3';
import { createWriteRuleStore, type WriteRuleStore } from '../storage/write-rule-store.js';
import { writeRuleKeyHash, writeRuleKeyOf, writeRuleOccasionOf } from '@recued/contracts';

const NOW = 1_760_000_000_000;
const entry = (name: string, classification: ToolEntry['classification']): ToolEntry => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification, concurrency_safe: false,
});
const EVENT = { summary: 'Dentist', start_at: NOW + 3_600_000, end_at: NOW + 7_200_000, timezone: 'Europe/Dublin' };

const harness = (opts: {
  resolve?: (source: ExecutionSource) => { admitted: true; execution_source: ExecutionSource } | { admitted: false; reason: string; detail: string };
  granted?: (op: string) => boolean;
  throwOnRun?: boolean;
  writeRules?: WriteRuleStore;
  /** The registry's `checkBeforeAsking`: what a call's own arguments refuse it for. */
  check?: (name: string, args: unknown) => ChatDispatchResult | null;
  /** The registry's `askValueLabels`: the names of the records a call names. */
  labels?: (name: string, args: unknown) => ApprovalValueLabels | undefined;
} = {}) => {
  let clock = NOW;
  const calls: Array<{ name: string; args: unknown; ctx: ChatDispatchContext }> = [];
  const registry: InternalToolRegistry = {
    list: () => [entry('calendar.create', 'write'), entry('calendar.search', 'read')],
    listByTier: (tier) => (tier === 1 ? [entry('calendar.create', 'write'), entry('calendar.search', 'read')] : []),
    getByName: (name) => (name === 'calendar.create' ? entry(name, 'write') : name === 'calendar.search' ? entry(name, 'read') : null),
    dispatch: async (name, args, ctx): Promise<ChatDispatchResult> => {
      calls.push({ name, args, ctx });
      if (opts.throwOnRun) throw new Error('provider went away');
      return { ok: true, result: { created: true, event_id: 'evt-1' } };
    },
    ...(opts.check !== undefined ? { checkBeforeAsking: async (name: string, args: unknown) => opts.check!(name, args) } : {}),
    ...(opts.labels !== undefined ? { askValueLabels: async (name: string, args: unknown) => opts.labels!(name, args) } : {}),
    subscribeRefresh: () => () => undefined,
  };
  const checkpoints = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: async (cp: Checkpoint) => { checkpoints.set(cp.checkpoint_id, cp); },
    get: async (id: string) => checkpoints.get(id) ?? null,
    delete: async (id: string) => { checkpoints.delete(id); },
    listByRun: async (run_id: string) => [...checkpoints.values()].filter((c) => c.run_id === run_id),
    list: async () => [...checkpoints.values()],
    size: async () => checkpoints.size,
  } as unknown as CheckpointStore;
  const asks: Array<{ message: { title: string; text: string }; handler: { kind: string; payload: Record<string, unknown> } }> = [];
  const notices: Array<{ title?: string; text: string }> = [];
  const preflightNotifier = {
    ask: async (message: unknown, _options: unknown, handler: unknown) => {
      asks.push({ message: message as never, handler: handler as never });
      return { ask_id: `ask-${asks.length}` };
    },
    notify: async (message: { title?: string; text: string }) => { notices.push(message); },
    registerAskHandler: () => {},
  } as unknown as PreflightNotifier;
  const gatedActionStore = createGatedActionStore(createInMemoryCollection<GatedActionRecord>());
  const mcpActionStore = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
  let seq = 0;
  const deps = {
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    internalRegistry: registry,
    tier1Registry: () => registry,
    ownerAdmitAll: true,
    mcpTokenId: 'tok-owner-cli',
    checkpointStore,
    preflightNotifier,
    gatedActionStore,
    mcpActionStore,
    approvalResumeAuthority: {
      resolve: ({ execution_source }: { execution_source: ExecutionSource }) =>
        opts.resolve?.(execution_source) ?? { admitted: true, execution_source },
    },
    opAdmissionGate: { isOpGranted: (_s: ExecutionSource, op?: string) => op === undefined || (opts.granted?.(op) ?? true), isFrozenByPause: () => false },
    newId: () => `id-${(seq += 1)}`,
    now: () => clock,
    ...(opts.writeRules !== undefined ? { writeRules: opts.writeRules } : {}),
  };
  const resumer = createPreflightResumer({
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    gatedActionStore,
    mcpActionStore,
    getExecuteDeps: () => deps as unknown as ExecuteHandlerDeps,
  });
  const call = (name: string, args: Record<string, unknown>) =>
    _testing.handleToolCall({ name, arguments: args } as never, deps as unknown as Parameters<typeof _testing.handleToolCall>[1]) as Promise<{
      structuredContent?: Record<string, unknown>; isError?: boolean; content: Array<{ text: string }>;
    }>;
  return { deps, calls, checkpoints, asks, notices, mcpActionStore, resumer, call, tick: (ms: number) => { clock += ms; } };
};

describe('D-329 A — an AI app\'s Tier-1 write is held', () => {
  it('holds a write instead of running it, and answers with an action to follow', async () => {
    const h = harness();
    const res = await h.call('calendar.create', EVENT);
    expect(h.calls).toEqual([]);
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toMatchObject({ status: 'awaiting_approval', awaiting_approval: true, tool: 'calendar.create',
      action_status: 'awaiting_approval', action_query_tool: 'recued_actionStatus' });
    // ⚠ Model-facing (chat-prompt log 2026-10-25l), pinned as text: the door says when to check.
    expect(res.structuredContent?.message).toBe(`${HELD_FOR_APPROVAL_MESSAGE} Do not call recued_actionStatus `
      + 'while you wait: until the user answers, it only reports awaiting_approval. When the user says they '
      + 'have answered, call recued_actionStatus once with this action_ref to learn the outcome.');
    const [checkpoint] = [...h.checkpoints.values()];
    expect(checkpoint!.raw_op).toMatchObject({ tier1_tool: 'calendar.create', op_id: 'calendar.create', operation: 'calendar.create',
      catalog_slug: TIER1_HOLD_CATALOG_SLUG, connection_name: '', op_args: EVENT, risk_tier: 'write' });
    expect(isCheckpoint(checkpoint)).toBe(true);
  });

  it('fans the ask out in the owner\'s words, with the details, and offers no session grant', async () => {
    const h = harness();
    await h.call('calendar.create', EVENT);
    expect(h.asks).toHaveLength(1);
    const [ask] = h.asks;
    expect(ask!.handler).toMatchObject({ kind: 'gateway.preflight', payload: { raw_op_id: 'calendar.create' } });
    expect(ask!.handler.payload).not.toHaveProperty('session_grant');
    expect(ask!.message.title).toBe('Approve: Add a calendar event');
    const lines = ask!.message.text.split('\n');
    expect(lines[0]).toBe('An AI agent wants to add a calendar event.');
    // The local calendar never leaves the server, so the consequence says so.
    expect(lines[1]).toBe('Write actions change your data in Recued, so Recued held it for you.');
    expect(lines[2]).toBe('Technical: tool calendar.create.');
    expect(ask!.message.text).toContain('Dentist');
  });

  it('leaves a read alone', async () => {
    const h = harness();
    await h.call('calendar.search', {});
    expect(h.calls.map((c) => c.name)).toEqual(['calendar.search']);
    expect(h.checkpoints.size).toBe(0);
    // Nobody approved it, so it carries no owner's approval.
    expect(h.calls[0]!.ctx.owner_approved).toBeUndefined();
  });
});

describe('D-329 A — a write its own arguments refuse is not put to the owner', () => {
  it('answers the app with the refusal: no checkpoint, no ask, nothing run', async () => {
    // ⛔ Live (2026-10-25): an approved asset create then refused `body`.
    const h = harness({ check: (_name, args) => ((args as { summary?: string }).summary === ''
      ? { ok: false, reason: 'invalid_args', detail: 'calendar.create: `summary` must not be empty' } : null) });
    const res = await h.call('calendar.create', { ...EVENT, summary: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('`summary` must not be empty');
    expect(h.checkpoints.size).toBe(0);
    expect(h.asks).toEqual([]);
    expect(h.calls).toEqual([]);
    // A call it lets through is held as before.
    expect((await h.call('calendar.create', EVENT)).structuredContent).toMatchObject({ status: 'awaiting_approval' });
    expect(h.asks).toHaveLength(1);
  });
});

describe('D-329 A — the ask names the records a call names', () => {
  it('records the names the registry gives on the hold, and the ask reads them', async () => {
    const h = harness({ labels: (name, args) => name === 'calendar.create' && (args as { summary?: string }).summary === 'Dentist'
      ? { summary: { Dentist: 'Dr Okafor, the dentist' } } : undefined });
    await h.call('calendar.create', EVENT);
    const [checkpoint] = [...h.checkpoints.values()];
    expect(checkpoint!.preflight_context?.value_labels).toEqual({ summary: { Dentist: 'Dr Okafor, the dentist' } });
    expect(h.asks[0]!.message.text).toContain('Dr Okafor, the dentist');
    // What runs is still what the app sent.
    expect(checkpoint!.raw_op!.op_args).toEqual(EVENT);
  });

  it('holds with no names when the registry gives none, or its lookup throws', async () => {
    const h = harness({ labels: () => { throw new Error('store went away'); } });
    expect((await h.call('calendar.create', EVENT)).structuredContent).toMatchObject({ status: 'awaiting_approval' });
    expect([...h.checkpoints.values()][0]!.preflight_context?.value_labels).toBeUndefined();
  });
});

describe('D-329 A — approving runs it', () => {
  it('runs the held call once, with its stored arguments, and completes the app\'s action', async () => {
    const h = harness();
    const res = await h.call('calendar.create', EVENT);
    const [checkpoint] = [...h.checkpoints.values()];
    await h.resumer.resumeRun(checkpoint!, {});
    expect(h.calls).toHaveLength(1);
    // D-325 — the owner answered the ask, so an asset reading it writes is their own sample.
    expect(h.calls[0]).toMatchObject({ name: 'calendar.create', args: EVENT,
      ctx: { channel: 'mcp_wire', mcp_token_id: 'tok-owner-cli', owner_approved: true } });
    const action = await h.mcpActionStore.getOwned(res.structuredContent!.action_ref as string, 'tok-owner-cli');
    expect(action).toMatchObject({ status: 'completed', result: { created: true, event_id: 'evt-1' } });
    // A second answer finds the checkpoint claimed and runs nothing.
    await h.resumer.resumeRun(checkpoint!, {});
    expect(h.calls).toHaveLength(1);
  });

  it('does not run when fresh authority refuses, and says why', async () => {
    const h = harness({ resolve: () => ({ admitted: false, reason: 'bearer_grant_revoked', detail: 'the key no longer grants calendar.create' }) });
    const res = await h.call('calendar.create', EVENT);
    await h.resumer.resumeRun([...h.checkpoints.values()][0]!, {});
    expect(h.calls).toEqual([]);
    expect(await h.mcpActionStore.getOwned(res.structuredContent!.action_ref as string, 'tok-owner-cli'))
      .toMatchObject({ status: 'failed' });
  });

  it('does not run when the tool\'s switch went off while it waited', async () => {
    let on = true;
    const h = harness({ granted: (op) => (op === 'primitive.calendar.create' ? on : true) });
    const res = await h.call('calendar.create', EVENT);
    on = false;
    await h.resumer.resumeRun([...h.checkpoints.values()][0]!, {});
    expect(h.calls).toEqual([]);
    const action = await h.mcpActionStore.getOwned(res.structuredContent!.action_ref as string, 'tok-owner-cli');
    expect(action).toMatchObject({ status: 'failed' });
  });

  it('reports a call that stopped while running as in doubt, and never runs it again', async () => {
    const h = harness({ throwOnRun: true });
    const res = await h.call('calendar.create', EVENT);
    const [checkpoint] = [...h.checkpoints.values()];
    await h.resumer.resumeRun(checkpoint!, {});
    await h.resumer.resumeRun(checkpoint!, {});
    expect(h.calls).toHaveLength(1);
    expect(await h.mcpActionStore.getOwned(res.structuredContent!.action_ref as string, 'tok-owner-cli'))
      .toMatchObject({ status: 'in_doubt' });
  });

  it('denying runs nothing and tells the app', async () => {
    const h = harness();
    const res = await h.call('calendar.create', EVENT);
    await h.resumer.denyRun([...h.checkpoints.values()][0]!, {});
    expect(h.calls).toEqual([]);
    expect(await h.mcpActionStore.getOwned(res.structuredContent!.action_ref as string, 'tok-owner-cli'))
      .toMatchObject({ status: 'denied' });
  });
});

describe('D-329 A — the hold\'s shape and words', () => {
  const held = (overrides: Record<string, unknown> = {}): Checkpoint => ({
    checkpoint_id: 'cp-1', run_id: 'run-1', step_state: {}, created_at: NOW,
    raw_op: { tier1_tool: 'work.create', op_id: 'work.create', operation: 'work.create', catalog_slug: TIER1_HOLD_CATALOG_SLUG,
      connection_name: '', op_args: { kind: 'task', title: 'Call the dentist' }, risk_tier: 'write',
      execution_source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't', mcp_token_id: 'k', contract_id: 'c' },
      ...overrides },
  } as Checkpoint);

  it('refuses a half-marked hold, either way round', () => {
    expect(isCheckpoint(held())).toBe(true);
    expect(isCheckpoint(held({ catalog_slug: 'hubspot-catalog' }))).toBe(false);
    expect(isCheckpoint(held({ op_id: 'calendar.create' }))).toBe(false);
    expect(isCheckpoint(held({ tier1_tool: undefined }))).toBe(false);
    expect(isCheckpoint(held({ tier1_session_id: 'chat-1' }))).toBe(true);
    expect(isCheckpoint(held({ tier1_session_id: '' }))).toBe(false);
    expect(isCheckpoint(held({ tier1_tool: undefined, catalog_slug: 'hubspot-catalog', op_id: 'x', operation: 'x',
      tier1_session_id: 'chat-1' }))).toBe(false);
  });

  it('says a write stays in Recued only when it provably does', () => {
    expect(tier1WriteStaysInRecued('work.create', { kind: 'task' })).toBe(true);
    expect(tier1WriteStaysInRecued('work.create', { kind: 'commitment' })).toBe(true);
    expect(tier1WriteStaysInRecued('calendar.create', {})).toBe(true);
    expect(tier1WriteStaysInRecued('calendar.create', { calendar_id: 'google-work' })).toBe(false);
    expect(tier1WriteStaysInRecued('work.update', { kind: 'task', id: 'task-123' })).toBe(false);
    const builtin = qualifyWorkEntityId({ kind: 'task', source_id: RECUED_BUILTIN_SOURCE_ID('task'), local_id: 'task-123' });
    expect(tier1WriteStaysInRecued('work.update', { kind: 'task', id: builtin })).toBe(true);
    expect(tier1WriteStaysInRecued('work.update', { kind: 'task', id: builtin, done: true })).toBe(true);
    expect(tier1WriteStaysInRecued('recipe.stop', {})).toBe(false);
    // The memory store has no outside half; a schedule's runs act on their own.
    expect(tier1WriteStaysInRecued('memory.write', { summary: 'x' })).toBe(true);
    expect(tier1WriteStaysInRecued('memory.forget', { memory_id: 'm1' })).toBe(true);
    expect(tier1WriteStaysInRecued('recipe.schedule', { recipe_id: 'r', mode: 'one_shot' })).toBe(false);
  });

  it('words a held task in the owner\'s words with its details', () => {
    const ask = buildPreflightAsk({ checkpoint: held(), context: { raw_op: { op_id: 'work.create' }, tool_slug: 'work.create', risk_tier: 'write' } });
    // The kind of thing it adds, not the tool's own title (2026-10-25).
    expect(ask.message.title).toBe('Approve: Add a task');
    expect(ask.message.text.split('\n').slice(0, 3)).toEqual([
      'An AI agent wants to add a task.',
      'Write actions change your data in Recued, so Recued held it for you.',
      'Technical: tool work.create.',
    ]);
    expect(ask.message.text).toContain('Call the dentist');
  });

  it('names the thing an update changes as the owner knows it, never by its id', () => {
    // ⛔ Live (2026-10-25): "id: we1:asset:recued.asset:local:e1a798e8…", so with two cars the
    // owner could not tell which one they were approving.
    const id = 'we1:asset:recued.asset:local:e1a798e8-8cb9-4cc1-89ed-e532efa2aa04';
    const update = held({ tier1_tool: 'work.update', op_id: 'work.update', operation: 'work.update',
      op_args: { kind: 'asset', id, readings: { odometer: { value: 12400, unit: 'km' } } } });
    const ask = buildPreflightAsk({
      checkpoint: { ...update, preflight_context: { value_labels: { id: { [id]: 'Family car' } } } } as Checkpoint,
      context: { raw_op: { op_id: 'work.update' }, tool_slug: 'work.update', risk_tier: 'write' },
    });
    expect(ask.message.title).toBe('Approve: Change a thing you own');
    expect(ask.message.text.split('\n')[0]).toBe('An AI agent wants to change a thing you own.');
    // Named as what it is, not "id: Family car", and its kind left to the title (2026-10-27).
    expect(ask.message.text).toContain('\n  Thing: Family car');
    expect(ask.message.text).not.toMatch(/^ {2}(kind|id): /m);
    expect(ask.message.text).not.toContain('e1a798e8');
    // With no name recorded (an older hold), the id is still shown.
    expect(buildPreflightAsk({ checkpoint: update, context: { raw_op: { op_id: 'work.update' }, tool_slug: 'work.update', risk_tier: 'write' } })
      .message.text).toContain('\n  Thing: we1:asset:recued.asset:local:e1a798e8');
  });

  it('names the thing a part belongs to, and the event a calendar change moves, as the owner knows them', () => {
    const part = held({ tier1_tool: 'work.create', op_id: 'work.create', operation: 'work.create',
      op_args: { kind: 'asset', title: 'Bike lock', belongs_to: 'asset-bike' } });
    const partAsk = buildPreflightAsk({
      checkpoint: { ...part, preflight_context: { value_labels: { belongs_to: { 'asset-bike': 'Road bike' } } } } as Checkpoint,
      context: { raw_op: { op_id: 'work.create' }, tool_slug: 'work.create', risk_tier: 'write' },
    });
    expect(partAsk.message.title).toBe('Approve: Add a thing you own');
    expect(partAsk.message.text).toContain('\n  title: Bike lock\n  Part of: Road bike');
    expect(partAsk.message.text).not.toMatch(/^ {2}(kind|belongs_to): /m);
    const move = held({ tier1_tool: 'calendar.update', op_id: 'calendar.update', operation: 'calendar.update',
      op_args: { source_id: 'evt-9', summary: 'Dentist (moved)' } });
    const moveAsk = buildPreflightAsk({
      checkpoint: { ...move, preflight_context: { value_labels: { source_id: { 'evt-9': 'Dentist, Tue 10:00' } } } } as Checkpoint,
      context: { raw_op: { op_id: 'calendar.update' }, tool_slug: 'calendar.update', risk_tier: 'write' },
    });
    expect(moveAsk.message.text).toContain('\n  Event: Dentist, Tue 10:00');
    expect(moveAsk.message.text).not.toContain('source_id');
  });

  it('names who proposed it: the owner\'s chat, their messenger or email chat, else an AI agent', () => {
    const opening = (execution_source: ExecutionSource) => buildPreflightAsk({
      checkpoint: held({ execution_source }),
      context: { raw_op: { op_id: 'work.create' }, tool_slug: 'work.create', risk_tier: 'write' },
    }).message.text.split('\n')[0];
    expect(opening({ channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'local' }))
      .toBe('Your chat wants to add a task.');
    expect(opening({ channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' }))
      .toBe('Your Slack chat wants to add a task.');
    expect(opening({ channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'me@example.com' }))
      .toBe('Your email chat wants to add a task.');
    expect(opening({ channel: 'messenger', actor: 'user_self', vendor: 'carrier-pigeon', from: 'x' }))
      .toBe('Your chat wants to add a task.');
    // Under a contract, the chat is not the owner's: a household member's, or a customer's.
    expect(opening({ channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '42', contract_id: 'k' }))
      .toBe('An AI agent wants to add a task.');
    expect(opening({ channel: 'chat', actor: 'contracted_user', chat_session_id: 's', user_id: 'u', contract_id: 'k' }))
      .toBe('An AI agent wants to add a task.');
  });
});

describe('D-329 — an AI app\'s repeat of a write still waiting is that write', () => {
  // An app that sends a held write again is retrying: the held answer tells it not to. Each
  // repeat raised its own ask, so approving both did the write twice, and a rule accepted
  // while the first waited ran the repeat at once and the first again on the yes.
  const ownerCli: ExecutionSource = {
    channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't', mcp_token_id: 'tok-owner-cli', contract_id: 'tok-owner-cli',
  };
  const actionRef = (res: { structuredContent?: Record<string, unknown> }): unknown => res.structuredContent?.action_ref;

  it('answers a repeat with the waiting request: one ask, one action, one run on the yes', async () => {
    const h = harness();
    const first = await h.call('calendar.create', EVENT);
    const again = await h.call('calendar.create', { ...EVENT });
    expect(h.asks).toHaveLength(1);
    expect(h.checkpoints.size).toBe(1);
    expect(again.structuredContent).toMatchObject({ status: 'awaiting_approval', awaiting_approval: true, action_status: 'awaiting_approval' });
    expect(actionRef(first)).toEqual(expect.any(String));
    expect(actionRef(again)).toBe(actionRef(first));
    await h.resumer.resumeRun([...h.checkpoints.values()][0]!, {});
    expect(h.calls).toHaveLength(1);
    expect((await h.mcpActionStore.getOwned(actionRef(first) as string, 'tok-owner-cli'))!.status).toBe('completed');
  });

  it('a rule accepted while it waits neither runs the repeat nor spends a use', async () => {
    const writeRules = createWriteRuleStore(new Database(':memory:'));
    const h = harness({ writeRules });
    const first = await h.call('calendar.create', EVENT);
    const key = writeRuleKeyOf(ownerCli, 'calendar.create', EVENT)!;
    const now = Date.now();
    for (let day = 0; day < 3; day += 1) {
      const at = now - (3 - day) * 86_400_000;
      writeRules.recordAnswer({ run_id: `seed-${day}`, key, outcome: 'approved', occasion: writeRuleOccasionOf(ownerCli, at), at });
    }
    writeRules.accept(writeRuleKeyHash(key), { max_uses: 5 }, now - 1);
    const again = await h.call('calendar.create', EVENT);
    expect(h.calls).toEqual([]);
    expect(actionRef(again)).toBe(actionRef(first));
    expect(writeRules.listRules(Date.now()).map((rule) => rule.uses_remaining)).toEqual([5]);
    await h.resumer.resumeRun([...h.checkpoints.values()][0]!, {});
    expect(h.calls).toHaveLength(1);
    // With nothing waiting, the rule stands in for the ask.
    await h.call('calendar.create', EVENT);
    expect(h.calls).toHaveLength(2);
    expect(h.asks).toHaveLength(1);
  });

  it('holds different details, or another app\'s identical call, as its own request', async () => {
    const h = harness();
    const first = await h.call('calendar.create', EVENT);
    const other = await h.call('calendar.create', { ...EVENT, summary: 'Dentist, again' });
    h.deps.mcpTokenId = 'tok-other-app';
    const otherApp = await h.call('calendar.create', EVENT);
    expect(h.asks).toHaveLength(3);
    expect(new Set([actionRef(first), actionRef(other), actionRef(otherApp)]).size).toBe(3);
  });

  it('asks again once the owner has answered, yes or no', async () => {
    const h = harness();
    await h.call('calendar.create', EVENT);
    await h.resumer.resumeRun([...h.checkpoints.values()][0]!, {});
    await h.call('calendar.create', EVENT);
    expect(h.asks).toHaveLength(2);
    await h.resumer.denyRun([...h.checkpoints.values()][0]!, {});
    // The answer handler deletes a refused hold's checkpoint after this; until it does, the
    // receipt says it was answered.
    expect(h.checkpoints.size).toBe(1);
    await h.call('calendar.create', EVENT);
    expect(h.asks).toHaveLength(3);
    expect(h.calls).toHaveLength(1);
  });

  it('raises one ask for identical calls that arrive together', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.call('calendar.create', EVENT), h.call('calendar.create', EVENT)]);
    expect(h.asks).toHaveLength(1);
    expect(h.checkpoints.size).toBe(1);
    expect(actionRef(b)).toBe(actionRef(a));
  });
});

describe('D-329 §3.4 — an AI app\'s approvals teach it a rule', () => {
  const ownerCli: ExecutionSource = {
    channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't', mcp_token_id: 'tok-owner-cli', contract_id: 'tok-owner-cli',
  };

  it('three approvals on three days suggest one, and the owner is told once', async () => {
    const writeRules = createWriteRuleStore(new Database(':memory:'));
    const h = harness({ writeRules });
    for (let day = 0; day < 3; day += 1) {
      await h.call('calendar.create', EVENT);
      await h.resumer.resumeRun([...h.checkpoints.values()].at(-1)!, {});
      h.tick(86_400_000);
    }
    expect(h.calls).toHaveLength(3);
    const [suggestion] = writeRules.listSuggestions(NOW + 2 * 86_400_000);
    expect(suggestion!.key).toEqual({ principal: { kind: 'ai_app', contract_id: 'tok-owner-cli' }, tool: 'calendar.create', scope: 'local' });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.title).toBe('A rule Recued suggests: Add a calendar event');
  });

  it('a live rule runs the write without holding it, one use at a time', async () => {
    const writeRules = createWriteRuleStore(new Database(':memory:'));
    const key = writeRuleKeyOf(ownerCli, 'calendar.create', EVENT)!;
    // The gate reads the rule on the wall clock, as it does in production.
    const now = Date.now();
    for (let day = 0; day < 3; day += 1) {
      const at = now - (3 - day) * 86_400_000;
      writeRules.recordAnswer({ run_id: `seed-${day}`, key, outcome: 'approved', occasion: writeRuleOccasionOf(ownerCli, at), at });
    }
    writeRules.accept(writeRuleKeyHash(key), { max_uses: 1 }, now - 1);
    const h = harness({ writeRules });
    const res = await h.call('calendar.create', EVENT);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.ctx.owner_approved).toBe(true);
    expect(h.checkpoints.size).toBe(0);
    expect(res.structuredContent).not.toMatchObject({ status: 'awaiting_approval' });
    // Spent: the next one asks.
    await h.call('calendar.create', EVENT);
    expect(h.calls).toHaveLength(1);
    expect(h.checkpoints.size).toBe(1);
  });
});

