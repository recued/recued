/** D-177 N.15 slice 1 — "Allow in this chat" for a chat's own writes.
 *
 *  The owner: "perhaps the session grant can relex a little bit such as granting the kind & tool pair
 *  for this session", then "bounds can be 1 hour so batch writes are possible, suppose I have an event
 *  and want to update 20 attendees" and "100 is fine". A held write the owner's own chat made offers
 *  the answer; answered so, the write runs and the same kind of write in that conversation goes
 *  without asking for an hour, up to 100 times.
 *
 *  Through the REAL orchestrator, plan store, hold, notification block, resumer, and the REAL contract
 *  store under the session-grant resolver (its schema seeded as a server seeds it: a value the seed
 *  does not admit is refused by the store, which a faked store hid once before). */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA,
  deriveDelegationRuleSuggestionKey,
  isContractActive,
  KIND_GRANT_OPTION_ID,
  type AIOutput,
  type ChatDispatchContext,
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

import { handlePlanApprove, handlePlanCancel, type ChatRpcDeps } from '../chat-handler.js';
import { beginRoundGather, heldOnceAsked, heldRunOf, raiseRoundGather, takeRoundGather } from '../chat-gather.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createHeldPlanAskAnswerer, createHoldTier1Write } from '../chat-held-writes.js';
import { createHeldPlanEditor } from '../chat-plan-edits.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { tier1KindGrantHoldAnswer, tier1KindGrantOffer, useTier1KindGrant } from '../kind-grants.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { scheduledPromptHoldAlwaysAllow } from '../scheduled-prompt-preapproval.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import {
  createContractDefinitionStore, KindGrantMintError, type MintKindGrantInput,
} from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-d177-n15' };
const NOW = 1_762_000_000_000;
const HOUR = 60 * 60 * 1000;
const ALLOW = 'Allow in this chat';
/** What the answer lets happen, naming the write as D-341 names it (§N.15.6 ruling 3). */
const NOTE = '“Allow in this chat” stops asking about “Add a task” in this conversation, up to 100 times in the next'
  + ' hour. Its AI decides each one: what it says, and who or what it is for. You can end it sooner under Active'
  + ' passes.';
const entry = (name: string): ToolEntry => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification: 'write', concurrency_safe: false,
});
const TOOLS = ['work.create', 'calendar.create', 'memory.write'];

/** The owner's own app chat. */
const owner = (session_id: string, turn_id: string): ExecutionSource =>
  ({ channel: 'chat', actor: 'user_self', chat_session_id: session_id, turn_id, user_id: 'owner' }) as ExecutionSource;
/** A scheduled prompt's run, as the scheduler stamps it. */
const scheduled = (session_id: string, turn_id: string): ExecutionSource => ({
  channel: 'schedule', actor: 'system', schedule_id: 'ps_1', cron: '0 7 * * *', chat_session_id: session_id, turn_id,
  prompt_schedule: { schedule_id: 'ps_1', occurrence_id: 'ps_1:3:100', revision: 3, due_at: 1, cron: '0 7 * * *',
    prompt_sha256: '1'.repeat(64) },
}) as ExecutionSource;

const fixture = (opts: {
  resolver?: boolean;
  /** A model's rounds, for a whole turn (`runTurn`); each round's prompt is kept (`packets`). */
  rounds?: readonly AIOutput[];
  /** Where an approval goes, as its ask's record reads (D-329). */
  channels?: readonly string[];
} = {}) => {
  let clock = NOW;
  const now = () => clock;
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  for (const id of ['chat-a', 'chat-b']) {
    chatStore.createSession({ id, title: id, now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' } } as never);
  }
  const plans = createSqliteChatPlanStore(db, undefined, now);
  const calls: Array<{ name: string; args: unknown; ctx: ChatDispatchContext }> = [];
  const registry: InternalToolRegistry = {
    list: () => TOOLS.map(entry),
    listByTier: (tier) => (tier === 1 ? TOOLS.map(entry) : []),
    getByName: (name) => (TOOLS.includes(name) ? entry(name) : null),
    dispatch: async (name, args, ctx): Promise<ChatDispatchResult> => {
      calls.push({ name, args, ctx });
      return { ok: true, result: { created: true } };
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
  // The real contract store, its schema seeded as a server's boot seeds it.
  const contractStore = createContractStore(db, { now });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  let grantSeq = 0;
  const definitions = createContractDefinitionStore(contractStore, { now, newId: () => `ct_${String((grantSeq += 1))}` });
  const broadcasts: string[] = [];
  const resolver = createSessionGrantResolver({
    definitionStore: definitions, auditLog, now, broadcast: (event) => { broadcasts.push(`${event.op}:${event.contract_id}`); },
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
    ...(opts.resolver !== false ? { sessionGrantResolver: resolver } : {}),
    ...(opts.channels !== undefined ? { approvalAskChannels: async () => opts.channels } : {}),
  };
  registerPreflightHandler(block, {
    checkpointStore,
    resumer: createPreflightResumer({ auditLog, getExecuteDeps: () => executeDeps as unknown as ExecuteHandlerDeps }),
  });
  const resolverOf = () => (opts.resolver !== false ? resolver : undefined);
  // What the server tells the paired clients: the cards' events.
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  const bus = { emit: (event: unknown) => { events.push(event as { kind: string }); } };
  const packets: string[] = [];
  const rounds = opts.rounds;
  const orchestrator = createChatOrchestrator({
    ...(rounds !== undefined ? {
      executeAiCall: async (_manifest: unknown, aiInput: Record<string, unknown>) => {
        packets.push(String(aiInput['llm.prompt']));
        return { body: rounds[Math.min(packets.length, rounds.length) - 1]! };
      },
    } : {}),
    chatStore,
    registry,
    selfSignature: signature,
    planApprovalStore: plans,
    auditLog,
    broadcast: bus as never,
    holdTier1Write: createHoldTier1Write(() => executeDeps as never),
    // As `wire-chat-orchestrator` wires them.
    holdAlwaysAllow: (source, tool, args) =>
      scheduledPromptHoldAlwaysAllow(executeDeps as unknown as ExecuteHandlerDeps, source, tool, args)
      ?? tier1KindGrantHoldAnswer(resolverOf(), source, tool, args),
    useWriteRule: (source, tool, args) => useTier1KindGrant(resolverOf(), source, tool, args),
    now,
    mintId: () => `mint-${String((seq += 1))}`,
  });
  const rpcDeps: ChatRpcDeps = {
    store: chatStore,
    orchestrator,
    selfSignature: signature,
    planApprovalStore: plans,
    now,
    answerHeldPlanAsk: createHeldPlanAskAnswerer(block),
    editHeldPlan: createHeldPlanEditor({ checkpointStore, plans }),
    auditLog,
    broadcast: bus,
  } as ChatRpcDeps;
  let turns = 0;
  const dispatch = (
    session_id: string,
    tool = 'work.create',
    args: Record<string, unknown> = { kind: 'task', title: `Call attendee ${String(turns + 1)}` },
    source: (session_id: string, turn_id: string) => ExecutionSource = owner,
  ) => {
    const turn_id = `turn-${String((turns += 1))}`;
    return orchestrator.dispatch.dispatchTool({
      session_id, turn_id, tool_name: tool, arg_values: args, picker_target: 'self', execution_source: source(session_id, turn_id),
    } as never);
  };
  const open = () => askStore.listByStatus('open');
  const answer = async (option: string) => {
    const [ask] = await open();
    if (ask === undefined) throw new Error('no open ask');
    await block.submitAnswer({ ask_id: ask.ask_id, option, via: 'ui' });
  };
  const kindGrants = () => definitions.listSessionGrants('chat:chat-a').filter((row) => row.grant_mode === 'kind');
  const activities = async (action: string) => (await auditLog.listActivities()).filter((a) => a.action === action);
  const planOf = async (session_id: string, turn_id: string) =>
    (await plans.listForSession!(session_id)).find((record) => record.plan.turn_id === turn_id)!.plan;
  const plansOf = async (session_id: string, turn_id: string) =>
    (await plans.listForSession!(session_id)).filter((record) => record.plan.turn_id === turn_id).map((record) => record.plan);
  return {
    calls, dispatch, open, answer, rows, definitions, kindGrants, activities, rpcDeps, planOf, plansOf, broadcasts,
    orchestrator, events, packets,
    tick: (ms: number) => { clock += ms; }, turn: () => `turn-${String(turns)}`,
  };
};

describe('D-177 N.15 — "Allow in this chat"', () => {
  it('an owner\'s chat write offers it; answered so, the write runs, and 20 more tasks in this chat go without asking', async () => {
    const f = fixture();
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(f.calls).toHaveLength(0);
    const [ask] = await f.open();
    // In place of "Allow this session", which a chat's own write never had.
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', ALLOW, 'Deny']);
    expect(ask!.message.text).toContain(NOTE);
    expect([...f.rows.values()][0]!.preflight_context?.kind_grant).toEqual({
      channel: 'chat', actor: 'user_self', channel_session_id: 'chat:chat-a', ingredient_slug: 'recued:tier1',
      operation_id: 'work.create:task', risk_tier: 'write', name: 'Add a task',
      ttl_ms: HOUR, max_uses: 100,
    });

    await f.answer(KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const [grant] = f.kindGrants();
    expect(grant).toMatchObject({
      grant_kind: 'session', grant_mode: 'kind', channel_session_id: 'chat:chat-a', risk_tier: 'write',
      scope: { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['recued:tier1'], operation_ids: ['work.create:task'] },
      display_name: 'Allowed in this chat — Add a task', expiry_at: NOW + HOUR, max_uses: 100, uses_remaining: 100,
    });
    expect(grant!.bound_recipe).toBeUndefined();
    expect(grant!.arg_shape_hash).toBeUndefined();
    expect((await f.activities('session_grant_minted')).map((a) => JSON.parse(a.detail!).grant_mode)).toEqual(['kind']);
    expect(f.broadcasts).toEqual([`mint:${grant!.contract_id}`]);

    // The owner's case: 20 attendees, each its own task, other words each time.
    for (let n = 0; n < 20; n += 1) {
      expect(await f.dispatch('chat-a', 'work.create', { kind: 'task', title: `Tell attendee ${String(n)} the new time` }))
        .toMatchObject({ ok: true });
    }
    expect(f.calls).toHaveLength(21);
    expect(await f.open()).toEqual([]);
    expect(f.kindGrants()[0]!.uses_remaining).toBe(80);
    expect((await f.activities('write_rule_used'))).toHaveLength(20);
    // Each use tells the lists of passes, which show the uses left.
    expect(f.broadcasts.filter((event) => event === `update:${grant!.contract_id}`)).toHaveLength(20);
  });

  it('only that kind, in that conversation, for that hour, and until the owner ends it', async () => {
    const f = fixture();
    await f.dispatch('chat-a');
    await f.answer(KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    // Another kind asks, with its own offer.
    expect(await f.dispatch('chat-a', 'calendar.create', { title: 'Rehearsal', start: '2026-11-12T10:00:00Z' }))
      .toMatchObject({ ok: false, reason: 'awaiting_approval' });
    const other = (await f.open()).at(-1)!;
    expect(other.options.map((option) => option.label)).toEqual(['Approve', ALLOW, 'Deny']);
    expect(other.message.text).toContain('stops asking about “Add a calendar event, for your Recued calendar”');
    // Another conversation asks.
    expect(await f.dispatch('chat-b')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    // Past the hour (its last millisecond is still in it, as every grant's is), it asks again.
    f.tick(HOUR + 1);
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(f.calls).toHaveLength(1);
  });

  it('ended under Active passes, the next write asks again', async () => {
    const f = fixture();
    await f.dispatch('chat-a');
    await f.answer(KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: true });
    f.definitions.revoke(f.kindGrants()[0]!.contract_id, 'owner ended it');
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(f.calls).toHaveLength(2);
  });

  it('its card in the chat offers it too, and the card\'s answer grants it', async () => {
    const f = fixture();
    await f.dispatch('chat-a');
    const plan = await f.planOf('chat-a', f.turn());
    expect(plan.hold).toMatchObject({ always_allow: ALLOW, always_allow_note: NOTE });
    await handlePlanApprove(f.rpcDeps, { plan_id: plan.plan_id, always_allow: true });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.kindGrants()).toHaveLength(1);
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: true });
  });

  it('a plain yes grants nothing: the next write asks again', async () => {
    const f = fixture();
    await f.dispatch('chat-a');
    await f.answer('approve');
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.kindGrants()).toEqual([]);
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
  });

  it('a scheduled prompt\'s write offers its own pre-approval, never this; a save asked about every time offers neither', async () => {
    const f = fixture();
    await f.dispatch('chat-a', 'work.create', { kind: 'task', title: 'Water the plants' }, scheduled);
    expect((await f.open())[0]!.options.map((option) => option.id)).not.toContain(KIND_GRANT_OPTION_ID);
    await f.dispatch('chat-a', 'memory.write', { summary: 'Mia lives in Cork', despite_revoked: 'mem-1' });
    expect((await f.open()).at(-1)!.options.map((option) => option.id)).toEqual(['approve', 'deny']);
  });

  it('with nothing to mint it, nothing offers it', async () => {
    const f = fixture({ resolver: false });
    await f.dispatch('chat-a');
    expect((await f.open())[0]!.options.map((option) => option.id)).toEqual(['approve', 'deny']);
    expect((await f.planOf('chat-a', f.turn())).hold?.always_allow).toBeUndefined();
  });

  it('the staged-trust learner derives no key from it', async () => {
    const f = fixture();
    await f.dispatch('chat-a');
    await f.answer(KIND_GRANT_OPTION_ID);
    await vi.waitFor(() => expect(f.kindGrants()).toHaveLength(1));
    expect(deriveDelegationRuleSuggestionKey(f.kindGrants()[0]!)).toBeUndefined();
  });
});

describe('D-177 N.15 — who is offered it', () => {
  const chatSource = owner('chat-a', 't');
  it('the owner\'s app chat and messenger chats; never a scheduled run, an AI app or a chat under a contract', () => {
    expect(tier1KindGrantOffer(chatSource, 'work.create', { kind: 'task' })?.operation_id).toBe('work.create:task');
    const messenger = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource;
    expect(tier1KindGrantOffer(messenger, 'contact.write', { target_id: 'c-1' })).toMatchObject({
      channel: 'messenger', channel_session_id: 'messenger:telegram:42', operation_id: 'contact.write:change',
      name: 'Change a contact',
    });
    expect(tier1KindGrantOffer(scheduled('chat-a', 't'), 'work.create', { kind: 'task' })).toBeUndefined();
    // D-343 (the owner's day audit, 2026-11-15) — a day is recorded once: no pass is offered for it.
    expect(tier1KindGrantOffer(chatSource, 'episode.record', { day: '2026-11-15', records: [] })).toBeUndefined();
    const app = { channel: 'mcp', actor: 'contracted_user', contract_id: 'ct-app', mcp_token_id: 'tok' } as ExecutionSource;
    expect(tier1KindGrantOffer(app, 'work.create', { kind: 'task' })).toBeUndefined();
    const household = { ...chatSource, contract_id: 'ct-household' } as ExecutionSource;
    expect(tier1KindGrantOffer(household, 'work.create', { kind: 'task' })).toBeUndefined();
  });

  it('a write no rule names, or one the owner is asked about every time, gets none', () => {
    expect(tier1KindGrantOffer(chatSource, 'mail.send', { to: 'a@b.c' })).toBeUndefined();
    expect(tier1KindGrantOffer(chatSource, 'work.create', {})).toBeUndefined();
    expect(tier1KindGrantOffer(chatSource, 'memory.write', { despite_revoked: 'mem-1' })).toBeUndefined();
    expect(tier1KindGrantOffer(chatSource, 'memory.write', { summary: 'x' })?.name).toBe('Save to your memory');
  });
});

describe('D-177 N.15 — the store holds the ruled bounds, whatever a caller asks', () => {
  const stores = () => {
    const db = new Database(':memory:');
    const contractStore = createContractStore(db, { now: () => NOW });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    let n = 0;
    const definitions = createContractDefinitionStore(contractStore, { now: () => NOW, newId: () => `ct_${String((n += 1))}` });
    return { definitions, resolver: createSessionGrantResolver({ definitionStore: definitions, now: () => NOW }) };
  };
  const input = (over: Partial<MintKindGrantInput> = {}): MintKindGrantInput => ({
    minted_by: 'owner', display_name: 'Allowed in this chat — Add a task',
    scope: { channels: ['chat'], actors: ['user_self'], ingredient_ids: ['recued:tier1'], operation_ids: ['work.create:task'] },
    channel_session_id: 'chat:chat-a', risk_tier: 'write', approved_action_ref: 'run-1', expiry_at: NOW + HOUR, max_uses: 100,
    ...over,
  });
  const scope = input().scope;

  it('refuses a grant longer than an hour, over 100 uses, past one op or connection, or for anything but a write', () => {
    const { definitions } = stores();
    for (const bad of [
      { expiry_at: NOW + HOUR + 1 }, { expiry_at: NOW }, { max_uses: 101 }, { max_uses: 0 }, { max_uses: 1.5 },
      { risk_tier: 'admin' as const }, { risk_tier: 'read' as const },
      { scope: { ...scope, operation_ids: ['work.create:task', 'work.create:note'] } }, { scope: { ...scope, operation_ids: [] } },
      { scope: { ...scope, ingredient_ids: undefined } }, { scope: { ...scope, connection_names: ['hubspot', 'salesforce'] } },
      { channel_session_id: '' }, { approved_action_ref: '' }, { bound_recipe: { recipe_id: 'follow-up', recipe_hash: '' } },
    ]) {
      expect(() => definitions.mintKindGrant(input(bad))).toThrow(KindGrantMintError);
    }
    expect(definitions.listSessionGrants('chat:chat-a')).toEqual([]);
    expect(definitions.mintKindGrant(input())).toMatchObject({ grant_kind: 'session', grant_mode: 'kind', uses_remaining: 100 });
  });

  it('a spent use is announced to the lists of passes; a refused one is not', () => {
    const { definitions } = stores();
    const events: string[] = [];
    const resolver = createSessionGrantResolver({
      definitionStore: definitions, now: () => NOW, broadcast: (event) => { events.push(`${event.op}:${event.contract_id}`); },
    });
    const { contract_id } = definitions.mintKindGrant(input());
    expect(resolver.consume(contract_id, { operation_id: 'work.create:note' })).toBe(false);
    expect(events).toEqual([]);
    expect(resolver.consume(contract_id, { operation_id: 'work.create:task' })).toBe(true);
    expect(events).toEqual([`update:${contract_id}`]);
  });

  it('spends a use only on the op it names, and none past the 100th', () => {
    const { definitions } = stores();
    const { contract_id } = definitions.mintKindGrant(input());
    expect(definitions.consumeSessionGrant(contract_id, { operation_id: 'work.create:note' })).toBe(false);
    expect(definitions.consumeSessionGrant(contract_id, {})).toBe(false);
    expect(definitions.get(contract_id)!.uses_remaining).toBe(100);
    for (let n = 0; n < 100; n += 1) {
      expect(definitions.consumeSessionGrant(contract_id, { operation_id: 'work.create:task' })).toBe(true);
    }
    expect(definitions.consumeSessionGrant(contract_id, { operation_id: 'work.create:task' })).toBe(false);
    expect(definitions.get(contract_id)!.uses_remaining).toBe(0);
  });

  it('one approval mints one grant however often its answer arrives, and a retry never brings back one the owner ended', () => {
    const { definitions, resolver } = stores();
    const offer = tier1KindGrantOffer(owner('chat-a', 't'), 'work.create', { kind: 'task' })!;
    const id = resolver.mintKind(offer, 'run-1');
    expect(id).toBeDefined();
    expect(resolver.mintKind(offer, 'run-1')).toBe(id);
    expect(definitions.listSessionGrants('chat:chat-a')).toHaveLength(1);
    definitions.revoke(id!, 'owner ended it');
    expect(resolver.mintKind(offer, 'run-1')).toBe(id);
    expect(definitions.listSessionGrants('chat:chat-a').filter((row) => isContractActive(row, NOW))).toEqual([]);
  });

  it('an offer past the bounds mints nothing and throws nothing: the approved write goes on as a plain yes', () => {
    const { definitions, resolver } = stores();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const offer = { ...tier1KindGrantOffer(owner('chat-a', 't'), 'work.create', { kind: 'task' })!, ttl_ms: 2 * HOUR };
    expect(resolver.mintKind(offer, 'run-1')).toBeUndefined();
    expect(definitions.listSessionGrants('chat:chat-a')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kind_grant_mint_invalid'));
    warn.mockRestore();
  });
});

describe('D-177 §N.15.9 (1c-b) — a round\'s held writes of one kind are asked once, on one card', () => {
  /** One round of the owner's chat that adds a task per title: begun as the turn loop begins it, each
   *  call dispatched in it, and its approval raised when it ends. */
  const round = async (
    f: ReturnType<typeof fixture>,
    /** A task by its title, or a call's own arguments. */
    items: ReadonlyArray<string | Record<string, unknown>>,
    session_id = 'chat-a',
  ) => {
    const turn_id = 'turn-round';
    const turn_state = new Map<string, unknown>();
    const calls = items.map((item) => ({ tool: 'work.create', args: typeof item === 'string' ? { kind: 'task', title: item } : item }));
    beginRoundGather(turn_state, 0, calls);
    const results: ChatDispatchResult[] = [];
    for (const call of calls) {
      results.push(await f.orchestrator.dispatch.dispatchTool({
        session_id, turn_id, tool_name: call.tool, arg_values: call.args, picker_target: 'self',
        execution_source: owner(session_id, turn_id), turn_state,
      } as never));
    }
    const raised = await raiseRoundGather(takeRoundGather(turn_state));
    return { turn_id, results, raised };
  };
  const THREE = ['Call Ann', 'Call Ben', 'Call Cara'];

  it('held, none asked on its own; then one approval for the three, and each card is in the round\'s group', async () => {
    const f = fixture();
    const { turn_id, results } = await round(f, THREE);
    expect(results.every((result) => !result.ok && result.reason === 'awaiting_approval')).toBe(true);
    const asks = await f.open();
    expect(asks).toHaveLength(1);
    expect(asks[0]!.handler_kind).toBe('gateway.preflight.gathered');
    expect(asks[0]!.message.title).toBe('Approve: Add a task, 3 actions');
    expect(asks[0]!.options.map((option) => option.label)).toEqual(['Approve', ALLOW, 'Deny']);
    const group = `${turn_id}:round-0`;
    expect((await f.plansOf('chat-a', turn_id)).map((plan) => plan.hold?.group)).toEqual([group, group, group]);
    expect(f.events.filter((event) => event.kind === 'chat.plan_proposed').map((event) => event.group))
      .toEqual([group, group, group]);
    expect(f.calls).toHaveLength(0);
  });

  it('a yes on one card runs the three and answers each card', async () => {
    const f = fixture();
    const { turn_id } = await round(f, THREE);
    const [first] = await f.plansOf('chat-a', turn_id);
    await handlePlanApprove(f.rpcDeps, { plan_id: first!.plan_id });
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    expect(f.calls.map((call) => (call.args as { title: string }).title)).toEqual(THREE);
    expect((await f.plansOf('chat-a', turn_id)).map((plan) => plan.status)).toEqual(['approved', 'approved', 'approved']);
    expect(f.events.filter((event) => event.kind === 'chat.plan_resolved')).toHaveLength(3);
    expect(await f.open()).toEqual([]);
  });

  it('"Allow in this chat" on the card grants once and runs the three; the next task goes without asking', async () => {
    const f = fixture();
    const { turn_id } = await round(f, THREE);
    const [first] = await f.plansOf('chat-a', turn_id);
    await handlePlanApprove(f.rpcDeps, { plan_id: first!.plan_id, always_allow: true });
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    expect(f.kindGrants()).toHaveLength(1);
    expect(await f.dispatch('chat-a')).toMatchObject({ ok: true });
  });

  it('no on one card: none runs, and every card is cancelled', async () => {
    const f = fixture();
    const { turn_id } = await round(f, THREE);
    const [, second] = await f.plansOf('chat-a', turn_id);
    await handlePlanCancel(f.rpcDeps, { plan_id: second!.plan_id });
    await vi.waitFor(async () => expect((await f.plansOf('chat-a', turn_id)).map((plan) => plan.status))
      .toEqual(['cancelled', 'cancelled', 'cancelled']));
    expect(f.calls).toHaveLength(0);
  });

  it('each held result names its run beside it, and is told where the approval went once it is out (D-329)', async () => {
    const f = fixture();
    const { turn_id, results, raised } = await round(f, THREE);
    const plans = await f.plansOf('chat-a', turn_id);
    expect(results.map((result) => heldRunOf(result))).toEqual(plans.map((plan) => plan.hold?.run_id));
    const told = heldOnceAsked({ ...raised[0]!, approval_channels: ['ui', 'slack'] }, results[0]!);
    expect(told).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect((told as { detail: string }).detail).toContain('also goes to the user on Slack');
    expect((results[0] as { detail: string }).detail).not.toContain('Slack');
  });

  it('a write of another kind in the round is not asked: it waits after the first (slice K)', async () => {
    const f = fixture();
    const { results } = await round(f, ['Call Ann', { kind: 'note', title: 'Ann prefers mornings' }, 'Call Ben']);
    expect(results.map((result) => (result.ok ? 'ok' : result.reason)))
      .toEqual(['awaiting_approval', 'not_asked_yet', 'not_asked_yet']);
    // The round's one kept write is asked as its own.
    expect((await f.open()).map((ask) => ask.handler_kind)).toEqual(['gateway.preflight']);
    expect(f.calls).toHaveLength(0);
  });

  it('a round that adds one task asks as before, on its own card', async () => {
    const f = fixture();
    const { turn_id } = await round(f, ['Call Ann']);
    const asks = await f.open();
    expect(asks.map((ask) => ask.handler_kind)).toEqual(['gateway.preflight']);
    expect((await f.plansOf('chat-a', turn_id))[0]!.hold?.group).toBeUndefined();
  });
});

describe('D-177 §N.15.9 (1c-b) — in a whole turn of the owner\'s chat', () => {
  it('a round that adds three tasks asks once; the model reads each held, told where the approval went', async () => {
    const titles = ['Call Ann', 'Call Ben', 'Call Cara'];
    const f = fixture({
      channels: ['ui', 'slack'],
      rounds: [
        { response: '', events: [], tool_calls: titles.map((title) => ({ tool: 'work.create', args: { kind: 'task', title } })) },
        { response: 'They wait for your approval.', events: [], tool_calls: [] },
      ],
    });
    await f.orchestrator.runTurn({ session_id: 'chat-a', picker_state: { current: 'self' },
      message: `Add a task for each: ${titles.join(', ')}.` } as never);
    const asks = await f.open();
    expect(asks.map((ask) => ask.handler_kind)).toEqual(['gateway.preflight.gathered']);
    expect(f.calls).toHaveLength(0);
    // Each of the three, held, in the model's next round, and where its one approval went.
    expect(f.packets[1]!.split('awaiting_approval').length - 1).toBe(3);
    expect(f.packets[1]!.split('also goes to the user on Slack').length - 1).toBe(3);
  });
});
