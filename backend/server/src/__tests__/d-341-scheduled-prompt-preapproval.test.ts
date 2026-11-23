/** D-341 slice B3 — a scheduled prompt's own standing pre-approval: its held Tier-1 write offers
 *  "Always allow for this scheduled prompt", the answer grants it for the prompt's version and that
 *  write, and the next run's same write goes through the chat's gate without asking.
 *
 *  Driven through the REAL chat gate (`createChatOrchestrator`), the REAL plan store, the REAL hold
 *  (`createHoldTier1Write` → `holdTier1Call`), the REAL notification block and preflight answer
 *  handler (so the ask's options and its answer are the real ones), the REAL resumer, the REAL
 *  trigger pre-approval store and granter. Doubles: the AI tools' registry, the resume authority
 *  and the grant gate, and the prompt service (its title and the version of its text).
 *
 *  The chat's approval card offers it too (the follow-up after B3): through the REAL card rpc
 *  (`handlePlanApprove` over `createHeldPlanAskAnswerer`), with the label wired as the server
 *  wires it (`scheduledPromptHoldAlwaysAllow`). */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatDispatchContext,
  ChatDispatchResult,
  Checkpoint,
  ExecutionSource,
  InternalToolRegistry,
  RecuedServerSignature,
  ToolEntry,
} from '@recued/contracts';
import { planApproval, PREFLIGHT_HANDLER_KIND, registerPreflightHandler } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type CheckpointStore,
} from '@recued/storage';

import { handlePlanApprove, type ChatRpcDeps } from '../chat-handler.js';
import { createChatOrchestrator, type BroadcastChatEvent } from '../chat-orchestrator.js';
import { createHeldPlanAskAnswerer, createHoldTier1Write } from '../chat-held-writes.js';
import { createHeldPlanEditor } from '../chat-plan-edits.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createScheduledPromptPreapprovalUse, scheduledPromptHoldAlwaysAllow } from '../scheduled-prompt-preapproval.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { createTriggerPreapprovalGranter, createTriggerPreapprovalRpcHandlers } from '../trigger-preapproval-rpc.js';
import { planProposedEventOf } from '../waiting-save-marks.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-d341-b3' };
const NOW = 1_762_000_000_000;
const V1 = '1'.repeat(64);
const V2 = '2'.repeat(64);
const TASK = 'work.create:task';
const PROMPT = { kind: 'prompt_schedule', schedule_id: 'ps_1' } as const;
const entry = (name: string): ToolEntry => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: [], classification: 'write', concurrency_safe: false,
});

/** A scheduled prompt's run, as the scheduler stamps it: its occurrence and its prompt's version
 *  (`null`: an occurrence queued before the stamp). */
const scheduled = (occurrence: string, version: string | null = V1, schedule_id = 'ps_1') =>
  (session_id: string, turn_id: string): ExecutionSource => ({
    channel: 'schedule', actor: 'system', schedule_id, cron: '0 7 * * *', chat_session_id: session_id, turn_id,
    prompt_schedule: { schedule_id, occurrence_id: occurrence, revision: 3, due_at: 1, cron: '0 7 * * *',
      ...(version !== null ? { prompt_sha256: version } : {}) },
  }) as ExecutionSource;
const ownerChat = (session_id: string): ExecutionSource =>
  ({ channel: 'chat', actor: 'user_self', chat_session_id: session_id, user_id: 'owner' }) as ExecutionSource;

const fixture = (opts: { granter?: boolean } = {}) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  const session_id = 'scheduled-ps_1';
  chatStore.createSession({
    id: session_id, title: 'Morning bills', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
  } as never);
  const plans = createSqliteChatPlanStore(db, undefined, () => NOW);
  const calls: Array<{ name: string; args: unknown; ctx: ChatDispatchContext }> = [];
  const registry: InternalToolRegistry = {
    list: () => [entry('work.create'), entry('calendar.create')],
    listByTier: (tier) => (tier === 1 ? [entry('work.create'), entry('calendar.create')] : []),
    getByName: (name) => (name === 'work.create' || name === 'calendar.create' ? entry(name) : null),
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
  const triggerPreapprovals = createTriggerPreapprovalStore(db);
  // The prompt as its service reads it now: its title, and the version of its text.
  const prompt: { version: string; gone: boolean; fails: boolean } = { version: V1, gone: false, fails: false };
  const prompts = {
    version: async (schedule_id: string) => {
      if (prompt.fails) throw new Error('Chat vault is locked.');
      return schedule_id === 'ps_1' && !prompt.gone ? { title: 'Morning bills', prompt_sha256: prompt.version } : null;
    },
  };
  const granter = createTriggerPreapprovalGranter({
    store: triggerPreapprovals, recipeStore: createRecipeStore('/nonexistent'), manifestOf: () => null, prompts, auditLog,
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
    now: () => NOW,
    auditLog,
    triggerPreapprovals,
    ...(opts.granter !== false ? { triggerPreapprovalGranter: granter } : {}),
  };
  registerPreflightHandler(block, {
    checkpointStore,
    resumer: createPreflightResumer({ auditLog, getExecuteDeps: () => executeDeps as unknown as ExecuteHandlerDeps }),
  });
  const events: BroadcastChatEvent[] = [];
  const orchestrator = createChatOrchestrator({
    chatStore,
    registry,
    selfSignature: signature,
    planApprovalStore: plans,
    auditLog,
    broadcast: { emit: (event) => { events.push(event); } },
    holdTier1Write: createHoldTier1Write(() => executeDeps as never),
    // As `wire-chat-orchestrator` wires it: the label of the offer the hold's ask is made with.
    holdAlwaysAllow: (source, tool, args) => scheduledPromptHoldAlwaysAllow(executeDeps, source, tool, args),
    useTriggerPreapproval: createScheduledPromptPreapprovalUse({ store: triggerPreapprovals, auditLog, now: () => NOW }),
    now: () => NOW,
    mintId: () => `mint-${String((seq += 1))}`,
  });
  // The card's rpc, as the server wires it.
  const rpcDeps: ChatRpcDeps = {
    store: chatStore,
    orchestrator,
    selfSignature: signature,
    planApprovalStore: plans,
    now: () => NOW,
    answerHeldPlanAsk: createHeldPlanAskAnswerer(block),
    editHeldPlan: createHeldPlanEditor({ checkpointStore, plans }),
    auditLog,
  } as ChatRpcDeps;
  const planOf = async (turn_id: string) =>
    (await plans.listForSession!(session_id)).find((record) => record.plan.turn_id === turn_id)!.plan;
  const dispatch = (
    turn_id: string,
    source: (session_id: string, turn_id: string) => ExecutionSource,
    args: Record<string, unknown> = { kind: 'task', title: 'Pay the gas bill' },
    tool = 'work.create',
  ) => orchestrator.dispatch.dispatchTool({
    session_id, turn_id, tool_name: tool, arg_values: args, picker_target: 'self', execution_source: source(session_id, turn_id),
  } as never);
  const open = () => askStore.listByStatus('open');
  const answer = async (option: string) => {
    const [ask] = await open();
    if (ask === undefined) throw new Error('no open ask');
    await block.submitAnswer({ ask_id: ask.ask_id, option, via: 'ui' });
  };
  const activities = async (action: string) => (await auditLog.listActivities()).filter((a) => a.action === action);
  return {
    session_id, calls, dispatch, open, answer, triggerPreapprovals, granter, prompt, prompts, auditLog, activities, rows,
    events, rpcDeps, planOf,
  };
};

describe('D-341 slice B3 — "Always allow for this scheduled prompt"', () => {
  it('its held write offers it; answered so, the write runs and the prompt\'s pre-approval is granted; its next run\'s write runs without asking', async () => {
    const f = fixture();
    const held = await f.dispatch('turn-1', scheduled('ps_1:3:100'));
    expect(held).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(f.calls).toHaveLength(0);
    const [ask] = await f.open();
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', 'Always allow for this scheduled prompt', 'Deny']);
    // Named as the owner's own scheduled prompt, with what the answer lets happen.
    expect(ask!.message.text).toContain('Your scheduled prompt wants to add a task');
    expect(ask!.message.text).toContain('“Always allow for this scheduled prompt” stops asking about this write when it runs on its'
      + ' schedule, once a run, until you end it on the scheduled prompt\'s page or under Contracts. Its AI decides what it writes.'
      + ' A change to its prompt asks you again.');
    expect([...f.rows.values()][0]!.preflight_context?.trigger_preapproval).toEqual({
      trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, op: TASK, asks_ai: true,
    });

    await f.answer('allow_trigger');
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]!.ctx).toMatchObject({ owner_approved: true, execution_source: { channel: 'schedule', schedule_id: 'ps_1' } });
    const [granted] = f.triggerPreapprovals.list();
    expect(granted).toMatchObject({ trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, writes: [TASK], max_per_run: 1, uses: 0 });
    expect((await f.activities('trigger_preapproval_granted')).map((a) => JSON.parse(a.detail!).via)).toEqual(['ask']);

    // Its next run: the same kind of write, other values, goes through without asking.
    const next = await f.dispatch('turn-2', scheduled('ps_1:3:200'), { kind: 'task', title: 'Pay the water bill' });
    expect(next).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.ctx).toMatchObject({ owner_approved: true });
    expect(await f.open()).toEqual([]);
    expect(f.triggerPreapprovals.list()[0]).toMatchObject({ uses: 1 });
    const [used] = await f.activities('trigger_preapproval_used');
    expect(used).toMatchObject({ target: granted!.id });
    expect(JSON.parse(used!.detail!)).toMatchObject({ run_id: 'prompt:ps_1:3:200', op: TASK, trigger: PROMPT, uses: 1 });
  });

  it('covers nothing else: an edited prompt, another scheduled prompt, another write, a write past its cap, the owner\'s chat', async () => {
    const f = fixture();
    await f.granter.grant({ trigger: PROMPT, recipe_id: 'ps_1', writes: [TASK] }, 'test');
    // Each call its own values: a call repeated while its ask is out is that ask, which would
    // answer for the pre-approval before it was ever asked.
    const task = (title: string) => ({ kind: 'task', title });
    // A run of the edited prompt asks; its ask offers a pre-approval for the new text.
    expect(await f.dispatch('t-edit', scheduled('ps_1:4:100', V2), task('Edited'))).toMatchObject({ reason: 'awaiting_approval' });
    expect([...f.rows.values()].at(-1)!.preflight_context?.trigger_preapproval).toMatchObject({ recipe_sha256: V2 });
    expect(await f.dispatch('t-other', scheduled('ps_2:1:100', V1, 'ps_2'), task('Other'))).toMatchObject({ reason: 'awaiting_approval' });
    expect(await f.dispatch('t-cal', scheduled('ps_1:3:300'), { summary: 'Dentist', start_at: NOW, end_at: NOW + 1 }, 'calendar.create'))
      .toMatchObject({ reason: 'awaiting_approval' });
    // Once a run: the first task of a run goes through, its second asks.
    expect(await f.dispatch('t-run-1', scheduled('ps_1:3:400'), task('One'))).toMatchObject({ ok: true });
    expect(await f.dispatch('t-run-2', scheduled('ps_1:3:400'), task('Two'))).toMatchObject({ reason: 'awaiting_approval' });
    // An occurrence queued before the stamp names no version, so it asks.
    expect(await f.dispatch('t-old', scheduled('ps_1:2:100', null), task('Old'))).toMatchObject({ reason: 'awaiting_approval' });
    // The owner's own chat has its write rules, never a scheduled prompt's pre-approval.
    expect(await f.dispatch('t-chat', ownerChat, task('Chat'))).toMatchObject({ reason: 'awaiting_approval' });
    expect(f.calls.map((call) => (call.args as { title?: string }).title)).toEqual(['One']);
    expect(await f.open()).toHaveLength(6);
  });

  it('a call whose ask is still out is that ask: a pre-approval granted meanwhile does not run it a second time', async () => {
    const f = fixture();
    await f.dispatch('turn-1', scheduled('ps_1:3:100'));
    await f.granter.grant({ trigger: PROMPT, recipe_id: 'ps_1', writes: [TASK] }, 'test');
    // The same call from its next run, while the first one's ask is out.
    expect(await f.dispatch('turn-2', scheduled('ps_1:3:200'))).toMatchObject({ reason: 'awaiting_approval' });
    expect(f.calls).toHaveLength(0);
    expect(f.triggerPreapprovals.list()[0]).toMatchObject({ uses: 0 });
    expect(await f.open()).toHaveLength(1);
  });

  it('where no answer could grant one, none is offered', async () => {
    const f = fixture({ granter: false });
    await f.dispatch('turn-1', scheduled('ps_1:3:100'));
    const [ask] = await f.open();
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', 'Deny']);
    expect([...f.rows.values()][0]!.preflight_context?.trigger_preapproval).toBeUndefined();
  });

  it('an answer whose prompt changed since it asked approves the write and grants nothing; a plain approve grants nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = fixture();
      await f.dispatch('turn-1', scheduled('ps_1:3:100'));
      f.prompt.version = V2;
      await f.answer('allow_trigger');
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      expect(f.triggerPreapprovals.list()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the prompt of Morning bills changed since it asked'));

      const g = fixture();
      await g.dispatch('turn-1', scheduled('ps_1:3:100'));
      await g.answer('approve');
      await vi.waitFor(() => expect(g.calls).toHaveLength(1));
      expect(g.triggerPreapprovals.list()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('D-341 slice B3 — the owner\'s rpc over a scheduled prompt\'s pre-approvals', () => {
  it('grants one for its own prompt\'s version, names its writes in the owner\'s words, and says its AI decides', async () => {
    const f = fixture();
    const rpc = createTriggerPreapprovalRpcHandlers({ granter: f.granter, manifestOf: () => null });
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({ trigger: PROMPT, recipe_id: 'ps_1', writes: [TASK] });
    expect(preapproval).toMatchObject({
      trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, state: 'live', recipe_name: 'Morning bills',
      write_labels: ['Add a task'], ai_steps: ['prompt'],
      description: 'Morning bills, when it runs on its schedule, may do this without asking: add a task. Its AI decides what it'
        + ' writes. Once a run, until you end it.',
    });
    const grant = rpc['collection.contract.grantTriggerPreapproval'];
    await expect(grant({ trigger: PROMPT, recipe_id: 'other', writes: [TASK] })).rejects.toThrow(/names its own prompt/u);
    for (const write of ['recued-core.body-signals.daily_metric.batch', 'mail.send:outbox']) {
      await expect(grant({ trigger: PROMPT, recipe_id: 'ps_1', writes: [write] }), write)
        .rejects.toThrow(/names its AI's writes as a write rule does/u);
    }
    await expect(grant({ trigger: { kind: 'prompt_schedule', schedule_id: 'ps_9' }, recipe_id: 'ps_9', writes: [TASK] }))
      .rejects.toMatchObject({ code: 'not_found' });
    f.prompt.fails = true;
    await expect(grant({ trigger: PROMPT, recipe_id: 'ps_1', writes: [TASK] })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('lists each with why it covers nothing now, and its page lists its prompt with none on offer', async () => {
    const f = fixture();
    const rpc = createTriggerPreapprovalRpcHandlers({ granter: f.granter, manifestOf: () => null });
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({ trigger: PROMPT, recipe_id: 'ps_1', writes: [TASK] });
    const state = async () => (await rpc['collection.contract.listTriggerPreapprovals']()).preapprovals[0]!.state;
    expect(await state()).toBe('live');
    f.prompt.version = V2;
    expect(await state()).toBe('outdated');
    f.prompt.gone = true;
    expect(await state()).toBe('detached');
    // Unreadable now (a locked vault), it is not called changed or gone.
    f.prompt.gone = false;
    f.prompt.fails = true;
    expect(await state()).toBe('live');
    f.prompt.fails = false;
    f.prompt.version = V1;

    const { recipes } = await rpc['collection.contract.triggerPreapprovalChoices']({ trigger: PROMPT });
    expect(recipes).toEqual([expect.objectContaining({
      recipe_id: 'ps_1', recipe_name: 'Morning bills', ai_steps: ['prompt'], writes: [],
      preapprovals: [expect.objectContaining({ id: preapproval.id, state: 'live' })],
    })]);
    expect((await rpc['collection.contract.triggerPreapprovalChoices']({ trigger: { kind: 'prompt_schedule', schedule_id: 'ps_9' } }))
      .recipes).toEqual([]);
    await rpc['collection.contract.revokeTriggerPreapproval']({ id: preapproval.id });
    expect(await state()).toBe('revoked');
  });
});

describe('D-341 slice B3 — the gate\'s step, alone', () => {
  it('stands in only for a stamped scheduled prompt\'s write a live pre-approval names; a store that fails asks', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    store.grant({ trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, writes: [TASK], max_per_run: 2, now: 0 });
    const use = createScheduledPromptPreapprovalUse({ store, now: () => NOW });
    expect(use(scheduled('ps_1:3:1')('s', 't'), 'work.create', { kind: 'task' })).toMatchObject({ uses: 1 });
    expect(use(ownerChat('s'), 'work.create', { kind: 'task' })).toBeUndefined();
    expect(use(scheduled('ps_1:3:1', null)('s', 't'), 'work.create', { kind: 'task' })).toBeUndefined();
    expect(use(scheduled('ps_1:3:1')('s', 't'), 'mail.send', { to: 'a@example.test' })).toBeUndefined();
    expect(createScheduledPromptPreapprovalUse({ store: undefined })(scheduled('ps_1:3:1')('s', 't'), 'work.create', { kind: 'task' }))
      .toBeUndefined();
    const failing = { use: () => { throw new Error('database is locked'); } };
    expect(createScheduledPromptPreapprovalUse({ store: failing })(scheduled('ps_1:3:1')('s', 't'), 'work.create', { kind: 'task' }))
      .toBeUndefined();
  });
});

const ALWAYS = 'Always allow for this scheduled prompt';
/** What it lets happen, as the ask says it before its question. */
const ALWAYS_NOTE = '“Always allow for this scheduled prompt” stops asking about this write when it runs on its schedule,'
  + ' once a run, until you end it on the scheduled prompt\'s page or under Contracts. Its AI decides what it writes.'
  + ' A change to its prompt asks you again.';

describe('D-341 — the chat\'s approval card offers "Always allow for this scheduled prompt" too', () => {
  it('its card carries the ask\'s label; approved with it, the write runs and the pre-approval is granted; its next run asks nothing', async () => {
    const f = fixture();
    await f.dispatch('turn-1', scheduled('ps_1:3:100'));
    const plan = await f.planOf('turn-1');
    expect(plan.hold).toMatchObject({ always_allow: ALWAYS, always_allow_note: ALWAYS_NOTE });
    // The card the conversation shows, in the ask's own words.
    const proposed = f.events.find((event) => event.kind === 'chat.plan_proposed');
    expect(proposed).toMatchObject({ plan_id: plan.plan_id, held: true, always_allow: ALWAYS, always_allow_note: ALWAYS_NOTE });
    const [ask] = await f.open();
    expect(ask!.options.find((option) => option.id === 'allow_trigger')!.label).toBe(ALWAYS);
    expect(ask!.message.text).toContain(ALWAYS_NOTE);

    const { plan: approved } = await handlePlanApprove(f.rpcDeps, { plan_id: plan.plan_id, always_allow: true });
    expect(approved.status).toBe('approved');
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]!.ctx).toMatchObject({ owner_approved: true });
    expect(f.triggerPreapprovals.list()).toEqual([
      expect.objectContaining({ trigger: PROMPT, recipe_id: 'ps_1', recipe_sha256: V1, writes: [TASK] }),
    ]);
    expect((await f.activities('trigger_preapproval_granted')).map((a) => JSON.parse(a.detail!).via)).toEqual(['ask']);
    const [said] = await f.activities('chat_plan_approved');
    expect(JSON.parse(said!.detail!)).toMatchObject({ plan_id: plan.plan_id, always_allow: true });

    expect(await f.dispatch('turn-2', scheduled('ps_1:3:200'), { kind: 'task', title: 'Pay the water bill' }))
      .toMatchObject({ ok: true });
    expect(await f.open()).toEqual([]);
  });

  it('a plain yes from the card grants nothing, and its audit names no always-allow', async () => {
    const f = fixture();
    await f.dispatch('turn-1', scheduled('ps_1:3:100'));
    const plan = await f.planOf('turn-1');
    await handlePlanApprove(f.rpcDeps, { plan_id: plan.plan_id });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.triggerPreapprovals.list()).toEqual([]);
    const [said] = await f.activities('chat_plan_approved');
    expect(JSON.parse(said!.detail!)).not.toHaveProperty('always_allow');
  });

  it('a card whose ask offers none carries none, and refuses it with nothing answered: the owner\'s chat, no granter', async () => {
    for (const [f, source] of [[fixture(), ownerChat], [fixture({ granter: false }), scheduled('ps_1:3:100')]] as const) {
      await f.dispatch('turn-1', source);
      const plan = await f.planOf('turn-1');
      expect(plan.hold).toBeDefined();
      expect(plan.hold!.always_allow).toBeUndefined();
      expect(plan.hold!.always_allow_note).toBeUndefined();
      expect(f.events.find((event) => event.kind === 'chat.plan_proposed')).not.toHaveProperty('always_allow');
      expect(f.events.find((event) => event.kind === 'chat.plan_proposed')).not.toHaveProperty('always_allow_note');
      await expect(handlePlanApprove(f.rpcDeps, { plan_id: plan.plan_id, always_allow: true }))
        .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('offers no standing pre-approval') });
      expect(await f.open()).toHaveLength(1);
      expect(f.calls).toEqual([]);
    }
  });

  it('always_allow that is not true or false is refused before anything is answered', async () => {
    const f = fixture();
    await f.dispatch('turn-1', scheduled('ps_1:3:100'));
    const plan = await f.planOf('turn-1');
    await expect(handlePlanApprove(f.rpcDeps, { plan_id: plan.plan_id, always_allow: 'yes' }))
      .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('always_allow must be true or false') });
    expect(await f.open()).toHaveLength(1);
    expect(f.calls).toEqual([]);
  });

  it('a plan whose ask no longer offers it is refused in the owner\'s words, not approved once', async () => {
    const plan = {
      plan_id: 'plan-1', session_id: 's', turn_id: 't', tool: 'work.create', tier: 1, classification: 'write',
      args: {}, args_hash: 'h', status: 'proposed', created_at: 1, hold: { run_id: 'run-1', always_allow: ALWAYS },
    };
    const answers: string[] = [];
    const deps = {
      planApprovalStore: { get: async () => plan },
      answerHeldPlanAsk: async (_run_id: string, option: string) => { answers.push(option); return 'ignored' as const; },
    } as unknown as ChatRpcDeps;
    await expect(handlePlanApprove(deps, { plan_id: 'plan-1', always_allow: true })).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringContaining(`no longer offers "${ALWAYS}"; say yes once instead`),
    });
    // The second answer by its card's name: the answerer sends the one the open ask offers.
    expect(answers).toEqual(['allow_offered']);
  });

  it('a plain card, with no hold, refuses it and stays as it is', async () => {
    const { hold: _hold, ...plain } = {
      plan_id: 'plan-1', session_id: 's', turn_id: 't', tool: 'mail.send', tier: 2, classification: 'write',
      args: {}, args_hash: 'h', status: 'proposed', created_at: 1, hold: undefined,
    };
    const resolved: string[] = [];
    const deps = {
      planApprovalStore: { get: async () => plain, resolve: async (id: string) => { resolved.push(id); return { ...plain, status: 'approved' }; } },
    } as unknown as ChatRpcDeps;
    await expect(handlePlanApprove(deps, { plan_id: 'plan-1', always_allow: true })).rejects.toMatchObject({
      code: 'bad_request', message: expect.stringContaining('offers no standing pre-approval'),
    });
    expect(resolved).toEqual([]);
    // And `false` is a plain yes.
    expect((await handlePlanApprove(deps, { plan_id: 'plan-1', always_allow: false })).plan.status).toBe('approved');
  });
});

describe('D-341 — the card\'s answerer gives "allow_trigger" only to an ask that offers it', () => {
  const blockWith = (offered: readonly string[]) => {
    const submitted: string[] = [];
    const block = {
      listUnresolvedAsks: async () => [{
        ask_id: 'ask-1', status: 'open', handler_kind: PREFLIGHT_HANDLER_KIND, handler_payload: { run_id: 'run-1' },
        options: offered.map((id) => ({ id, label: id })),
      }],
      submitAnswer: async ({ option }: { option: string }) => { submitted.push(option); return 'answered' as const; },
    };
    return { block: block as never, submitted };
  };

  it('offered, it answers it after the owner\'s change is written; not offered, nothing is written or answered', async () => {
    const offered = blockWith(['approve', 'allow_trigger', 'deny']);
    const changes: string[] = [];
    expect(await createHeldPlanAskAnswerer(offered.block)('run-1', 'allow_offered', async () => { changes.push('written'); }))
      .toBe('answered');
    expect(offered.submitted).toEqual(['allow_trigger']);
    expect(changes).toEqual(['written']);

    const plain = blockWith(['approve', 'deny']);
    expect(await createHeldPlanAskAnswerer(plain.block)('run-1', 'allow_offered', async () => { changes.push('again'); }))
      .toBe('ignored');
    expect(plain.submitted).toEqual([]);
    expect(changes).toEqual(['written']);

    // A no writes no change.
    const deny = blockWith(['approve', 'allow_trigger', 'deny']);
    expect(await createHeldPlanAskAnswerer(deny.block)('run-1', 'deny', async () => { changes.push('denied'); })).toBe('answered');
    expect(changes).toEqual(['written']);
  });
});

describe('D-341 — the plan store keeps the card\'s label with its hold', () => {
  it('stores it, reads it back, drops it with a hold never raised, and adds its column to an older table', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    createChatStore(db).createSession({
      id: 's', title: 'Morning bills', now: 1, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
    } as never);
    const plans = createSqliteChatPlanStore(db, undefined, () => NOW);
    const args = { kind: 'task', title: 'Pay the gas bill' };
    const proposal = {
      plan_id: 'plan-1', session_id: 's', turn_id: 't', tool: 'work.create', tier: 1 as const, classification: 'write' as const,
      args, args_hash: planApproval.computePlanArgsHash(args), status: 'proposed' as const, created_at: NOW,
      hold: { run_id: 'run-1', always_allow: ALWAYS, always_allow_note: ALWAYS_NOTE },
    };
    await plans.put(proposal as never);
    expect((await plans.get('plan-1'))!.hold).toEqual({ run_id: 'run-1', always_allow: ALWAYS, always_allow_note: ALWAYS_NOTE });
    // A card re-sent to a conversation that missed it (`planProposedEventOf`) offers it too.
    expect(planProposedEventOf((await plans.get('plan-1'))!))
      .toMatchObject({ held: true, always_allow: ALWAYS, always_allow_note: ALWAYS_NOTE });
    expect((await plans.unlinkHold!('plan-1', 'run-1'))!.hold).toBeUndefined();
    expect(db.prepare('SELECT hold_always_allow, hold_always_allow_note FROM chat_plans').get())
      .toEqual({ hold_always_allow: null, hold_always_allow_note: null });

    await plans.put({ ...proposal, plan_id: 'plan-2', hold: { run_id: 'run-2' } } as never);
    expect((await plans.get('plan-2'))!.hold).toEqual({ run_id: 'run-2' });

    db.exec('ALTER TABLE chat_plans DROP COLUMN hold_always_allow');
    db.exec('ALTER TABLE chat_plans DROP COLUMN hold_always_allow_note');
    ensureChatSchema(db);
    const columns = (db.prepare('PRAGMA table_info(chat_plans)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['hold_always_allow', 'hold_always_allow_note']));
  });
});
