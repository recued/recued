/** D-402 slice F3 (§7.4) — the question before a run, through `handleExecute`, the real notification
 *  block, the resumer and the question's own answer handler: a chat's run of an installed recipe that
 *  would ask where an approval ahead can stand in is held before its first step, nothing having run,
 *  and asked once about the whole run; each answer does what it says; the runs §7.4 excludes are never
 *  held for it. A note added through a Records catalog op is the write, as in D-341's tests. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  isCheckpoint,
  RUN_QUESTION_ASK_KIND,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type RecordsExecutionBinding,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry, type CheckpointStore,
} from '@recued/storage';

import type { BridgeDispatcher, DispatchOutcome } from '../bridges/dispatcher.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createRecordsStore } from '../records/store.js';
import { raiseRoundGather, type DeferredHold, type RoundMember } from '../chat-gather.js';
import { registerRunQuestionHandler } from '../run-question.js';
import { stopAllowing } from '../stop-allowing.js';
import { projectRunResultForAgent, RAN_WITHOUT_ASKING_MESSAGE, ranWithoutAskingSentence } from '../run-result-agent-projection.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';
import { createBrowserJobRegistry } from '../bridges/browser-job-registry.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractScanFn, createContractStore } from '../storage/contract-store.js';
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { triggerPreapprovalRecipeSha256 } from '../trigger-preapproval-rpc.js';

const NOTES = { publisher: 'core', pack_slug: 'f3-notes' };
const binding = (action: 'create' | 'delete'): RecordsExecutionBinding => ({ kind: 'core.records', action, entity: 'note',
  owner: NOTES, pack_version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: action });
const BINDINGS = { create: binding('create'), delete: binding('delete') };
const SCHEMA: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
  { key: 'id', kind: 'id', slot: 'pk', required: true }, { key: 'title', kind: 'string', slot: 's1', required: true },
] } } };
const notesManifest = {
  slug: 'f3-notes', name: 'Notes', description: 'Notes', author: 'core', kind: 'storage', version: 1, category: 'data',
  risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
  operations: {
    create: { operation_id: 'core.f3-notes.note.create', risk_tier: 'write', groups: ['notes.write'], description: 'Add a note.' },
    delete: { operation_id: 'core.f3-notes.note.delete', risk_tier: 'destructive', groups: ['notes.write'], description: 'Remove a note.' },
  },
  operation_groups: { 'notes.write': { group_id: 'notes.write', operations: ['create', 'delete'], risk_floor: 'write' } },
  surfaces: { records: { executes: BINDINGS, schema: SCHEMA } },
} as unknown as IngredientManifest;

const CHAT: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 't1' } as ExecutionSource;
const RUN_BUTTON: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'tok' } as ExecutionSource;
/** An AI app's call, as the MCP host sends it: a contracted user under its contract. */
const APP_SOURCE: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', tool_call_id: 'tc-1',
  mcp_token_id: 'mcp-token-1', contract_id: 'k-claude' } as ExecutionSource;
// The app's tools: the notes, and the browser reads a recipe of the Toolkit's shape uses (2026-11-23's cases below).
const APP_SNAPSHOT = () => ({ contract_id: 'k-claude', contract_version: 'v1', allowed_tools: ['f3-notes', 'dom-tabs', 'dom-open', 'dom-inspect', 'dom-act', 'dom-click'],
  approval_required: ['write', 'admin'], scope_restrictions: [], resolved_at: Date.now() });
const SCHEDULE: ExecutionSource = { channel: 'schedule', actor: 'system', schedule_id: 'sch_1', cron: '0 7 * * *', source_recipe: 'add-note' } as ExecutionSource;

const ADD = { id: 'add', ingredient: 'f3-notes', input: { operation: 'create', args: { id: '{{context.note_id}}', values: { title: 'Morning note' } } } };
const recipeOf = (steps: unknown[], extra: Record<string, unknown> = {}): RecipeDefinition => ({
  recipe_id: 'add-note', version: 1, ttl: 60,
  metadata: { name: 'Add a morning note', description: 'Adds a note.', author: 'test', supported_platforms: ['test'], ...extra },
  variables: {}, prefetch_steps: [], steps, output: { sidebar: [] },
} as unknown as RecipeDefinition);

const fixture = (steps: unknown[] = [ADD], extra: Record<string, unknown> = {}, pack_slug: string | null = null) => {
  const db = new Database(':memory:');
  const records = createRecordsStore(db, { now: () => Date.now() });
  records.installNamespace({ owner: NOTES, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'f3', schema: SCHEMA, bindings: BINDINGS });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(notesManifest);
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  // A browser click goes through the commit gateway (a single-op ingredient), as a held write's does.
  const sent = vi.fn<BridgeDispatcher['dispatch']>(async (request): Promise<DispatchOutcome> => ({
    kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
    result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok',
      // A held click's element is described before a pass is used on its site.
      outputs: { page: '7:ABCDEF0123', url: 'https://example.test/', title: 'Example',
        ...(request.action === 'describe' ? { role: 'button', label: 'Send', protected: false } : {}) } } as never,
  }));
  const clicks = () => sent.mock.calls.map(([request]) => request).filter((request) => request.action === 'click').length;
  const contractStore = createContractStore(db);
  contractStore.put('grant', ['f3-notes', 'f3-notes', 'f3-notes', 'notes.write'], { allowed: true });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const recipe = recipeOf(steps, extra);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  // As installed: the pack it came with, if any (the Browser Toolkit's own recipes never get the question).
  const stored = Object.assign(Object.create(recipeStore) as typeof recipeStore, {
    getStored: (id: string) => (id === recipe.recipe_id ? { recipe_id: id, pack_slug } : null),
  });
  const triggerPreapprovals = createTriggerPreapprovalStore(db);
  const browserPasses = createBrowserPassStore(db);
  // D-402 — each fixture's own jobs: an AI app's runs in a job it started.
  const jobs = createBrowserJobRegistry();
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore, channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
  });
  const rows = new Map<string, Checkpoint>();
  const checkpointStore = {
    write: vi.fn(async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...rows.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  } as unknown as CheckpointStore;
  const deps = {
    recipeStore: stored, baseVault: {}, recordsStore: records, instanceId: 'd-402-f3',
    executorConfig: { manifests, bridgeDispatcherRef: () => ({ dispatch: sent, cancel: vi.fn(), canResolve: vi.fn(() => false) }) },
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    checkpointStore, auditLog, preflightNotifier: block, triggerPreapprovals, browserPasses, browserJobs: jobs,
    sessionGrantResolver: createSessionGrantResolver({ definitionStore }),
    aiAppNameOf: (contract_id: string) => (contract_id === 'k-claude' ? 'Claude Desktop' : undefined),
    // An AI app's run resumes only under its contract's authority as it stands then (as the server reads it).
    approvalResumeAuthority: { resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({
      admitted: true, execution_source, contract_snapshot: APP_SNAPSHOT() }) },
  } as unknown as ExecuteHandlerDeps;
  const resumer = createPreflightResumer({ getExecuteDeps: () => deps, auditLog });
  registerPreflightHandler(block, { checkpointStore, resumer });
  registerRunQuestionHandler(block as never, { checkpointStore, resumer, store: triggerPreapprovals });
  const notes = () => records.ownerSearch({ owner: NOTES, entity: 'note', filters: {}, limit: 20 }).records.map((row) => row.id).sort();
  const run = (note_id: string, execution_source: ExecutionSource = CHAT, defer_ask?: (hold: DeferredHold) => boolean) => handleExecute(deps, {
    recipe_id: 'add-note', trigger_source: execution_source.channel === 'schedule' ? 'schedule' : 'manual', execution_source,
    context: { note_id },
    ...(execution_source.channel === 'mcp' ? { contract_snapshot: APP_SNAPSHOT() } : {}),
  } as Parameters<typeof handleExecute>[1], defer_ask !== undefined ? { defer_ask } : undefined);
  const open = () => askStore.listByStatus('open');
  const answer = async (option: string) => {
    const [ask] = await open();
    await block.submitAnswer({ ask_id: ask!.ask_id, option, via: 'ui' });
  };
  return { recipe, run, notes, open, answer, rows, triggerPreapprovals, browserPasses, clicks, sent, jobs,
    version: triggerPreapprovalRecipeSha256(recipe) };
};

describe('D-402 slice F3 — a chat\'s run is held before step 1 and asked once about the whole run', () => {
  it('asks before anything runs, in the owner\'s words, with four answers; the hold names where the run begins', async () => {
    const f = fixture();
    const held = await f.run('n1');
    expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
    expect(f.notes()).toEqual([]);
    const [ask] = await f.open();
    expect(ask!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    expect(ask!.message.title).toBe('Run “Add a morning note”?');
    expect(ask!.message.text).toBe('Your chat asks to run it. Without asking, it will: add a note.');
    expect(ask!.options.map((option) => option.label)).toEqual(['Yes, this time', 'Always, for this recipe', 'Ask me at each step', 'No']);
    const [checkpoint] = [...f.rows.values()];
    expect(checkpoint).toMatchObject({ gated_step_id: 'add', run_question: { caller: { kind: 'owner_chat' }, recipe_sha256: f.version, always: true } });
    expect(isCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toBe(true);
    // ⛔ A hold this version cannot read is no hold at all, never an ordinary hold of its first step.
    expect(isCheckpoint({ ...JSON.parse(JSON.stringify(checkpoint)), run_question: { caller: { kind: 'owner_chat' } } })).toBe(false);
  });

  it('"Yes, this time": the run starts, its write covered for this run alone; the next run asks again', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_once');
    expect(f.notes()).toEqual(['n1']);
    expect(await f.open()).toEqual([]);
    const [once] = f.triggerPreapprovals.listCallers();
    expect(once).toMatchObject({ caller: { kind: 'owner_chat' }, recipe_id: 'add-note', recipe_sha256: f.version, uses: 1 });
    expect(once!.run_id).toBeDefined();
    // F4 — used, and ended with its run.
    expect(once!.revoked_at).toBeDefined();
    expect((await f.run('n2')).awaiting_approval).toBe(true);
    expect((await f.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
  });

  it('"Always, for this recipe": the run starts, and a later one runs without asking at all', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_always');
    expect(f.notes()).toEqual(['n1']);
    const later = await f.run('n2');
    expect(later.awaiting_approval, JSON.stringify(later.errors)).toBeFalsy();
    expect(await f.open()).toEqual([]);
    expect(f.notes()).toEqual(['n1', 'n2']);
    expect(f.triggerPreapprovals.listCallers().map((row) => [row.run_id, row.uses])).toEqual([[undefined, 2]]);
  });

  it('"Ask me at each step": the run starts and its write asks at its step, as before', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_each_step');
    expect(f.notes()).toEqual([]);
    const [ask] = await f.open();
    expect(ask!.handler_kind).not.toBe(RUN_QUESTION_ASK_KIND);
    expect(ask!.options.map((option) => option.id)).toContain('approve');
    await f.answer('approve');
    expect(f.notes()).toEqual(['n1']);
    expect(f.triggerPreapprovals.listCallers()).toEqual([]);
  });

  it('⛔ "Ask me at each step" on a click its first step makes: the click still asks, never let through by the answer', async () => {
    const f = fixture([{ id: 'click', op: 'core.dom.click', args: { target: '*://example.test/*', page: '7:ABCDEF0123', ref: 'e12' } }]);
    await f.run('n1');
    expect((await f.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    await f.answer('run_each_step');
    expect(f.clicks()).toBe(0);
    const [ask] = await f.open();
    expect(ask!.handler_kind).not.toBe(RUN_QUESTION_ASK_KIND);
    await f.answer('approve');
    expect(f.clicks()).toBe(1);
  });

  it('"No": the run ends declined, nothing having run', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_no');
    expect(f.notes()).toEqual([]);
    expect(await f.open()).toEqual([]);
    expect(f.rows.size).toBe(0);
    expect(f.triggerPreapprovals.listCallers()).toEqual([]);
  });
});

describe('D-402 slice F3d — an AI app\'s run', () => {
  it('is asked about by the app\'s name, "Always" included since it can be taken back (ruling 4); "Yes" runs it', async () => {
    const f = fixture();
    expect((await f.run('n1', APP_SOURCE)).awaiting_approval).toBe(true);
    const [ask] = await f.open();
    expect(ask!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    expect(ask!.message.text).toBe('Claude Desktop asks to run it. Without asking, it will: add a note.');
    expect(ask!.options.map((option) => option.label)).toEqual(['Yes, this time', 'Always, for this recipe', 'Ask me at each step', 'No']);
    await f.answer('run_once');
    expect(f.notes()).toEqual(['n1']);
    expect(f.triggerPreapprovals.listCallers()).toMatchObject([{ caller: { kind: 'ai_app', contract_id: 'k-claude' }, uses: 1 }]);
  });

  it('the app\'s "Always" covers its later runs, never your chats\', and once ended from your chat it asks again', async () => {
    const f = fixture();
    expect((await f.run('n1', APP_SOURCE)).awaiting_approval).toBe(true);
    await f.answer('run_always');
    expect(f.notes()).toEqual(['n1']);
    expect(f.triggerPreapprovals.listCallers().map((row) => [row.caller.kind, row.run_id ?? null])).toEqual([['ai_app', null]]);
    const later = await f.run('n2', APP_SOURCE);
    expect(later.awaiting_approval, JSON.stringify(later.errors)).toBeFalsy();
    expect(f.notes()).toEqual(['n1', 'n2']);
    // The app's "Always" is the app's: your chats are still asked.
    expect((await f.run('n3', CHAT)).awaiting_approval).toBe(true);
    await f.answer('run_no');
    // "Stop letting Claude Desktop add notes without asking": the app asks again.
    expect(stopAllowing({ preapprovals: f.triggerPreapprovals },
      { caller: { kind: 'ai_app', contract_id: 'k-claude' }, recipe_id: 'add-note', by: 'owner_chat' }).preapprovals).toBe(1);
    expect((await f.run('n4', APP_SOURCE)).awaiting_approval).toBe(true);
    expect(f.notes()).toEqual(['n1', 'n2']);
  });
});

describe('D-402 ruling 13 — a round that runs one recipe several times asks once', () => {
  it('each run is held and kept for the round\'s end; one question for all three; one answer starts each', async () => {
    const f = fixture();
    const kept: RoundMember[] = [];
    const keep = (hold: DeferredHold) => { kept.push({ ...hold, tool_name: 'recipe.run', call_key: 'recipe.run:add-note' }); return true; };
    for (const note of ['n1', 'n2', 'n3']) expect((await f.run(note, CHAT, keep)).awaiting_approval).toBe(true);
    expect(await f.open()).toEqual([]);
    expect(f.notes()).toEqual([]);
    await raiseRoundGather(kept);
    const open = await f.open();
    expect(open.map((ask) => ask.handler_kind)).toEqual([RUN_QUESTION_ASK_KIND]);
    expect(open[0]!.message.title).toBe('Run “Add a morning note” 3 times?');
    expect(open[0]!.options.map((option) => option.label)).toEqual(['Yes, these times', 'Always, for this recipe', 'Ask me at each step', 'No']);
    await f.answer('run_once');
    expect(f.notes()).toEqual(['n1', 'n2', 'n3']);
    expect(await f.open()).toEqual([]);
    // One pre-approval for each run, each used by its run alone.
    const rows = f.triggerPreapprovals.listCallers();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.run_id)).size).toBe(3);
    expect(rows.every((row) => row.uses === 1)).toBe(true);
  });
});

describe('D-402 slice F3b — what the owner already granted covers the run: no question', () => {
  it('"Allow in this chat" for its write, answered at the step: the chat\'s next run goes through without the question', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_each_step');
    const [stepAsk] = await f.open();
    expect(stepAsk!.options.map((option) => option.id)).toContain('allow_kind');
    await f.answer('allow_kind');
    expect(f.notes()).toEqual(['n1']);
    const next = await f.run('n2');
    expect(next.awaiting_approval, JSON.stringify(next.errors)).toBeFalsy();
    expect(await f.open()).toEqual([]);
    expect(f.notes()).toEqual(['n1', 'n2']);
  });

  it('a site pass for a browser step\'s site: no question, the click goes through', async () => {
    const click = { id: 'click', op: 'core.dom.click', args: { target: 'https://example.test/*', page: '7:ABCDEF0123', ref: 'e12' } };
    const asked = fixture([click]);
    expect((await asked.run('n1')).awaiting_approval).toBe(true);
    expect((await asked.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    const f = fixture([click]);
    f.browserPasses.mint({ key: { principal: { kind: 'owner_chat' }, recipe: 'add-note', site: 'https://example.test' },
      host: 'example.test', kind: 'always', now: Date.now() });
    const response = await f.run('n1');
    expect((await f.open()).map((ask) => ask.handler_kind)).toEqual([]);
    expect(response.awaiting_approval, JSON.stringify(response.errors)).toBeFalsy();
    expect(f.clicks()).toBe(1);
  });

  // D-402 (2026-11-23) — an AI app's pass "until this job ends" covers its runs in that job, and no others.
  it('an AI app\'s pass until its job ends: no question in that job, the question once it is over', async () => {
    const click = { id: 'click', op: 'core.dom.click', args: { target: 'https://example.test/*', page: '7:ABCDEF0123', ref: 'e12' } };
    const f = fixture([click]);
    const app = { mcp_token_id: 'mcp-token-1', agent_id: 'agent-1' };
    const job = f.jobs.start(app);
    f.browserPasses.mint({ key: { principal: { kind: 'ai_app', contract_id: 'k-claude' }, recipe: 'add-note', site: 'https://example.test' },
      host: 'example.test', kind: 'session', channel_session_id: `job:${job.job_id}`, expires_at: job.expires_at, now: Date.now() });
    const inJob = await f.run('n1', APP_SOURCE);
    expect((await f.open()).map((ask) => ask.handler_kind)).toEqual([]);
    expect(inJob.awaiting_approval, JSON.stringify(inJob.errors)).toBeFalsy();
    expect(f.clicks()).toBe(1);
    f.jobs.end(app);
    expect((await f.run('n2', APP_SOURCE)).awaiting_approval).toBe(true);
    expect((await f.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    expect(f.clicks()).toBe(1);
  });
});

describe('D-402 slice F3 — the runs that never get the question', () => {
  const heldBy = async (f: ReturnType<typeof fixture>, source: ExecutionSource = CHAT) => {
    const response = await f.run('n1', source);
    const [ask] = await f.open();
    return { held: response.awaiting_approval === true, question: ask?.handler_kind === RUN_QUESTION_ASK_KIND };
  };

  it('the Run button\'s, a schedule\'s, a kernel recipe\'s and the Browser Toolkit\'s own: each asks as before, or not at all', async () => {
    expect(await heldBy(fixture(), RUN_BUTTON)).toEqual({ held: false, question: false });
    expect(await heldBy(fixture(), SCHEDULE)).toEqual({ held: true, question: false });
    expect(await heldBy(fixture([ADD], { author: 'recued' }))).toEqual({ held: true, question: false });
    expect(await heldBy(fixture([ADD], {}, 'browser-toolkit'))).toEqual({ held: true, question: false });
  });

  it('a recipe whose only asking step can\'t be approved ahead asks at that step, never the question', async () => {
    const remove = { id: 'remove', ingredient: 'f3-notes', input: { operation: 'delete', args: { id: 'n1' } } };
    expect(await heldBy(fixture([remove]))).toEqual({ held: true, question: false });
  });

  it('a standing "Always" this caller holds for this version: no question, the write goes through', async () => {
    const f = fixture();
    f.triggerPreapprovals.grantCaller({ caller: { kind: 'owner_chat' }, recipe_id: 'add-note', recipe_sha256: f.version, now: Date.now() });
    expect(await heldBy(f)).toEqual({ held: false, question: false });
    expect(f.notes()).toEqual(['n1']);
  });
});

describe('D-402 slice F5 (§7.10) — the run says what ran without asking, and what let it', () => {
  const OWNER_CALLER = { kind: 'owner_chat' };
  const said = (response: unknown) => (projectRunResultForAgent(response) as { ran_without_asking?: string }).ran_without_asking;

  it('"Always" for your chats: its next run says so, with how to take it back; the model never sees the record', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_always');
    const later = await f.run('n2');
    expect(later.let_through).toEqual({ caller: OWNER_CALLER, writes: [{ by: 'always', count: 1 }] });
    const projected = projectRunResultForAgent(later) as Record<string, unknown>;
    expect(Object.keys(projected)[0]).toBe('ran_without_asking');
    expect(projected.ran_without_asking).toBe('What it changed ran without asking the user, since the user chose “Always” for this recipe.'
      + ' If the user wants to be asked again, recipe.stop_allowing ends that.');
    expect(projected).not.toHaveProperty('let_through');
  });

  it('an AI app\'s "Always": named as the app\'s, and the app is told how to give it up', async () => {
    const f = fixture();
    await f.run('n1', APP_SOURCE);
    await f.answer('run_always');
    const later = await f.run('n2', APP_SOURCE);
    expect(later.let_through).toEqual({ caller: { kind: 'ai_app', contract_id: 'k-claude' }, writes: [{ by: 'always', count: 1 }] });
    expect(said(later)).toBe('What it changed ran without asking the user, since the user chose “Always” for this app and this recipe.'
      + ' If the user asks you to check with them first again, recued_stopAllowing gives that up.');
    expect(JSON.stringify(projectRunResultForAgent(later))).not.toContain('k-claude');
  });

  it('"Allow in this chat" and a site pass each say so; a run that asked says nothing of it', async () => {
    const f = fixture();
    await f.run('n1');
    await f.answer('run_each_step');
    await f.answer('allow_kind');
    const next = await f.run('n2');
    expect(next.let_through).toEqual({ caller: OWNER_CALLER, writes: [{ by: 'grant', count: 1 }] });
    expect(said(next)).toContain('since the user allowed it ahead of time, in this conversation or for this recipe.');

    const click = { id: 'click', op: 'core.dom.click', args: { target: 'https://example.test/*', page: '7:ABCDEF0123', ref: 'e12' } };
    const passed = fixture([click]);
    passed.browserPasses.mint({ key: { principal: { kind: 'owner_chat' }, recipe: 'add-note', site: 'https://example.test' },
      host: 'example.test', kind: 'always', now: Date.now() });
    const response = await passed.run('n1');
    expect(response.let_through).toEqual({ caller: OWNER_CALLER, writes: [{ by: 'site_pass', count: 1 }] });
    expect(said(response)).toContain('since the user gave this recipe a site pass for that site.');

    const asked = fixture();
    const held = await asked.run('n1');
    expect(held.let_through).toBeUndefined();
    expect(said(held)).toBeUndefined();
  });

  it('the words: one reason per kind, in order; the switch alone keeps its own sentence; no hint for what ends with the run', () => {
    expect(ranWithoutAskingSentence(undefined, 2)).toBe(RAN_WITHOUT_ASKING_MESSAGE);
    expect(ranWithoutAskingSentence({ caller: { kind: 'owner_chat' }, writes: [{ by: 'switch', count: 3 }] })).toBe(RAN_WITHOUT_ASKING_MESSAGE);
    expect(ranWithoutAskingSentence({ caller: { kind: 'owner_chat' }, writes: [{ by: 'this_run', count: 2 }] }))
      .toBe('What it changed ran without asking the user, since the user approved this run before it started.');
    expect(ranWithoutAskingSentence({ caller: { kind: 'owner_chat' }, writes: [{ by: 'this_run', count: 1 }, { by: 'site_pass', count: 1 }] }, 1))
      .toBe('What it changed ran without asking the user, since the user approved this run before it started, and the user gave this'
        + ' recipe a site pass for that site, and “Don’t ask about browser actions” is on in this chat.'
        + ' If the user wants to be asked again, recipe.stop_allowing ends that.');
    expect(ranWithoutAskingSentence({ writes: [{ by: 'trigger', count: 1 }] }))
      .toBe('What it changed ran without asking the user, since the user approved ahead what this runs.');
    expect(ranWithoutAskingSentence({ writes: [] })).toBeUndefined();
  });
});

describe('D-402 slice D5 (ruling 11) — a step run for each item of a list: the question says the most it can run', () => {
  const said = async (steps: unknown[]) => {
    const f = fixture(steps);
    const held = await f.run('n1');
    expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
    const [ask] = await f.open();
    return ask!.message.text;
  };
  const TITLES = [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }, { title: 'f' }];
  const CUT = { id: 'cut', transform: 'slice', array: TITLES, start: 0, end: 3 };

  it('a cut the recipe writes bounds it, through a filter and a map of the list too', async () => {
    expect(await said([CUT, { ...ADD, foreach: '{{step.cut}}' }]))
      .toBe('Your chat asks to run it. Without asking, it will: add a note, up to 3 times.');
    expect(await said([{ ...CUT, start: 1, end: 6 },
      { id: 'kept', transform: 'filter', array: '{{step.cut}}', field: 'title', operator: 'is_not_empty' },
      { id: 'shaped', transform: 'map', array: '{{step.kept}}', expression: { title: '{{item.title}}' } },
      { ...ADD, foreach: '{{step.shaped}}' }])).toBe('Your chat asks to run it. Without asking, it will: add a note, up to 5 times.');
  });

  it('a list the recipe writes bounds a loop over it by its length, through a map (slice D5c)', async () => {
    expect(await said([{ id: 'pages', transform: 'map', array: ['a', 'b', 'c'], expression: { title: '{{item}}' } },
      { ...ADD, foreach: '{{step.pages}}' }])).toBe('Your chat asks to run it. Without asking, it will: add a note, up to 3 times.');
  });

  it('a question asked of a page is AI the run uses: the question says what it reads goes to your AI models (slice E1)', async () => {
    const asked = { id: 'act_1', op: 'core.dom.act', args: { target: 'https://example.test/*', steps: [{ url: 'https://example.test/order',
      do: 'ask', question: 'Whether the order is paid.' }] } };
    expect(await said([asked, ADD])).toContain('What it reads goes to your AI models.');
    expect(await said([ADD])).not.toContain('AI');
  });

  it('a collect\'s most items bounds the records of its Act call', async () => {
    const collect = { id: 'act_1', op: 'core.dom.act', args: { target: 'https://example.test/*', steps: [{ url: 'https://example.test/list',
      do: 'collect', items: 'li', fields: { value: { selector: ':scope' } }, max_pages: 1, max_items: 20, max_seconds: 10 }] } };
    expect(await said([collect, { ...ADD, foreach: '{{step.act_1.tabs.0.reads.0.collection.records}}' }])).toContain('add a note, up to 20 times');
  });

  it('a loop adds its bound to the same write\'s other steps; a list nothing bounds counts once, as before', async () => {
    expect(await said([CUT, { ...ADD, foreach: '{{step.cut}}' }, { ...ADD, id: 'add_again' }]))
      .toBe('Your chat asks to run it. Without asking, it will: add a note, up to 4 times.');
    expect(await said([CUT, { ...ADD, id: 'add_first' }, { ...ADD, foreach: '{{step.cut}}' }]))
      .toBe('Your chat asks to run it. Without asking, it will: add a note, up to 4 times.');
    expect(await said([{ id: 'all', transform: 'flatten', array: [TITLES] }, { ...ADD, foreach: '{{step.all}}' }])).toBe('Your chat asks to run it. Without asking, it will: add a note.');
    // A cut that leaves nothing, or one whose end a setting gives, bounds nothing the question can say.
    expect(await said([{ ...CUT, end: 0 }, { ...ADD, foreach: '{{step.cut}}' }])).toBe('Your chat asks to run it. Without asking, it will: add a note.');
    expect(await said([{ ...CUT, end: '{{config.most}}' }, { ...ADD, foreach: '{{step.cut}}' }]))
      .toBe('Your chat asks to run it. Without asking, it will: add a note.');
  });
});

// 2026-11-23 (the owner: "make all reads & open as normal read permission, which does not need ask, it is more align with
// human expectation") — a read that opens the page it names asks no one. The live drive that found the question had saved
// the Toolkit's reads one by one, so they were not the Toolkit pack's own (whose recipes never get the question), and every
// read an AI app asked for was held before step 1 for its possible open.
describe('a read that opens its page asks no one, from the chat or an AI app', () => {
  const PAGE = 'https://example.test/';
  const READ_STEPS = [
    { id: 'found', op: 'core.dom.tabs', args: { target: '*://*/*', address: PAGE } },
    { id: 'shown', transform: 'any', conditions: ['{{step.found.tabs}} is_not_empty'] },
    { id: 'opened', op: 'core.dom.open', args: { target: '*://*/*', address: PAGE }, skip_when: '{{step.shown}} equal true' },
    { id: 'tab', transform: 'coalesce', values: ['{{step.found.tabs.0.page}}', '{{step.opened.page}}'] },
    { id: 'read', op: 'core.dom.inspect', args: { target: '*://*/*', page: '{{step.tab}}', form: 'text' } },
  ];
  it.each([['the chat', CHAT], ['an AI app', APP_SOURCE]] as const)('%s: no question, nothing held, and the page is opened', async (_who, source) => {
    const f = fixture(READ_STEPS);
    const response = await f.run('n1', source);
    expect(response.awaiting_approval, JSON.stringify(response.errors)).not.toBe(true);
    expect(await f.open()).toEqual([]);
    // The open step ran: no tab showed the page, and nothing stood between it and the Bridge.
    expect(f.sent.mock.calls.map(([request]) => request.action)).toContain('open_tab');
  });

  // 2026-11-23 (the owner: "make the go read no ask default too") — going to an address reads, as opening a page does.
  it.each([['the chat', CHAT], ['an AI app', APP_SOURCE]] as const)('%s: going to an address raises no question either', async (_who, source) => {
    const f = fixture([{ id: 'act_1', op: 'core.dom.act', args: { target: 'https://example.test/*', steps: [{ url: PAGE,
      do: 'go', address: 'https://example.test/next' }, { do: 'read' }] } }]);
    const response = await f.run('n1', source);
    expect(response.awaiting_approval, JSON.stringify(response.errors)).not.toBe(true);
    expect(await f.open()).toEqual([]);
    expect(f.sent.mock.calls.map(([request]) => request.action)).toContain('navigate');
  });

  // 2026-11-23 (the owner: "make Collects that turn pages read too") — a collect that turns pages reads as well.
  it.each([['the chat', CHAT], ['an AI app', APP_SOURCE]] as const)('%s: a collect that turns pages raises no question either', async (_who, source) => {
    const f = fixture([{ id: 'act_1', op: 'core.dom.act', args: { target: 'https://example.test/*', steps: [{ url: PAGE,
      do: 'collect', items: 'li', fields: { value: { selector: ':scope' } }, next: { text: 'Next' }, max_pages: 5 }] } }]);
    const response = await f.run('n1', source);
    expect(response.awaiting_approval, JSON.stringify(response.errors)).not.toBe(true);
    expect(await f.open()).toEqual([]);
    // The collect began: its first read of the page went to the Bridge, nothing standing before it.
    expect(f.sent.mock.calls.map(([request]) => request.action)).toContain('reread');
  });
});
