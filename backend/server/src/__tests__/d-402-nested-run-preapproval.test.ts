/** D-402 ruling 17 — a recipe that runs another recipe (D-232's local recipe op) is approved as one job with
 *  it, through `handleExecute`, the real notification block, the resumer and the question's own answer
 *  handler. "Morning routine" runs "Add a morning note" through a pack op bound to it; the note is a
 *  Records write, which asks, as in `d-402-run-question.test.ts`.
 *
 *  Before the ruling (measured 2026-11-18): the question listed the inner write, but no answer reached it.
 *  It was asked again at its step, and the outer run failed there ("Nested pause/resume is not
 *  implemented"), since an inner run cannot stop to ask. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  PREAPPROVAL_OWNER_CHAT_REF,
  RUN_QUESTION_ASK_KIND,
  type Checkpoint, type Commit, type ExecutionSource, type IngredientManifest, type RecipeDefinition,
  type RecordsExecutionBinding, type RecordsSchemaSnapshot,
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

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createRecordsStore } from '../records/store.js';
import { registerRunQuestionHandler } from '../run-question.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';
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
/** D-232 — a catalog whose ops run local recipes: an api binding of kind `mcp`, called with no connection. */
const routinesManifest = {
  slug: 'routines', name: 'Routines', description: 'Runs local recipes.', author: 'recued-core', version: 1,
  kind: 'connection', category: 'action', risk_tier: 'read', input: {}, output: {},
  operations: {
    run_add: { operation_id: 'routines.run_add', risk_tier: 'read', groups: ['g'], description: 'Add the morning note.' },
    run_remove: { operation_id: 'routines.run_remove', risk_tier: 'read', groups: ['g'], description: 'Remove the morning note.' },
  },
  operation_groups: { g: { group_id: 'g', operations: ['run_add', 'run_remove'], risk_floor: 'read' } },
  surfaces: { api: { transport: 'rest', default_base_url: 'https://fixture.invalid', auth: { kind: 'none' },
    executes: { run_add: { kind: 'mcp', tool: 'recued-core/add-note' }, run_remove: { kind: 'mcp', tool: 'recued-core/remove-note' } } } },
} as unknown as IngredientManifest;

const CHAT: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 't1' } as ExecutionSource;
const APP_SOURCE: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', tool_call_id: 'tc-1',
  mcp_token_id: 'mcp-token-1', contract_id: 'k-claude' } as ExecutionSource;
const APP_SNAPSHOT = () => ({ contract_id: 'k-claude', contract_version: 'v1',
  allowed_tools: ['f3-notes', 'routines', 'add-note', 'remove-note', 'morning-routine', 'tidy-routine'],
  approval_required: ['write', 'admin'], scope_restrictions: [], resolved_at: Date.now() });
const OWNER = { kind: 'owner_chat' as const };

const meta = (name: string) => ({ name, description: name, author: 'test', supported_platforms: ['test'] });
/** The inner recipe: adds a note, a write that can be approved ahead. */
const addNote = (title = 'Morning note'): RecipeDefinition => ({ recipe_id: 'add-note', version: 1, ttl: 60, metadata: meta('Add a morning note'),
  variables: { note_id: { label: 'Note', type: 'string' } }, prefetch_steps: [],
  steps: [{ id: 'add', ingredient: 'f3-notes', input: { operation: 'create', args: { id: '{{config.note_id}}', values: { title } } } }],
  output: { sidebar: [] } } as unknown as RecipeDefinition);
/** An inner recipe that deletes: a write that asks every time. */
const REMOVE_NOTE = { recipe_id: 'remove-note', version: 1, ttl: 60, metadata: meta('Remove the morning note'),
  variables: { note_id: { label: 'Note', type: 'string' } }, prefetch_steps: [],
  steps: [{ id: 'remove', ingredient: 'f3-notes', input: { operation: 'delete', args: { id: '{{config.note_id}}' } } }],
  output: { sidebar: [] } } as unknown as RecipeDefinition;
/** The outer recipe: runs an inner one, and nothing else. */
const outer = (recipe_id: string, name: string, operation: string): RecipeDefinition => ({ recipe_id, version: 1, ttl: 60, metadata: meta(name),
  variables: {}, prefetch_steps: [],
  steps: [{ id: 'invoke', ingredient: 'routines', input: { operation, args: { note_id: '{{context.note_id}}' } } }],
  output: { render: [{ type: 'json', source: 'step.invoke', label: 'nested' }] } } as unknown as RecipeDefinition);
const MORNING = outer('morning-routine', 'Morning routine', 'run_add');
const TIDY = outer('tidy-routine', 'Tidy routine', 'run_remove');

const fixture = () => {
  const db = new Database(':memory:');
  const records = createRecordsStore(db, { now: () => Date.now() });
  records.installNamespace({ owner: NOTES, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'f3', schema: SCHEMA, bindings: BINDINGS });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(notesManifest);
  manifests.register(routinesManifest);
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  const contractStore = createContractStore(db);
  contractStore.put('grant', ['f3-notes', 'f3-notes', 'f3-notes', 'notes.write'], { allowed: true });
  contractStore.put('grant', ['routines', 'routines', 'routines', 'g'], { allowed: true });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const recipeStore = createRecipeStore('/nonexistent');
  for (const recipe of [addNote(), REMOVE_NOTE, MORNING, TIDY]) recipeStore.register(recipe);
  const installed = new Set([addNote().recipe_id, REMOVE_NOTE.recipe_id, MORNING.recipe_id, TIDY.recipe_id]);
  const stored = Object.assign(Object.create(recipeStore) as typeof recipeStore, {
    getStored: (id: string) => (installed.has(id) ? { recipe_id: id, pack_slug: null } : null),
  });
  const triggerPreapprovals = createTriggerPreapprovalStore(db);
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({ askStore, channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()) });
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
    recipeStore: stored, baseVault: {}, recordsStore: records, instanceId: 'd-402-r17',
    executorConfig: { manifests },
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    checkpointStore, auditLog, preflightNotifier: block, triggerPreapprovals, browserPasses: createBrowserPassStore(db),
    sessionGrantResolver: createSessionGrantResolver({ definitionStore }),
    aiAppNameOf: (contract_id: string) => (contract_id === 'k-claude' ? 'Claude Desktop' : undefined),
    approvalResumeAuthority: { resolve: ({ execution_source }: { execution_source: ExecutionSource }) => ({
      admitted: true, execution_source, contract_snapshot: APP_SNAPSHOT() }) },
  } as unknown as ExecuteHandlerDeps;
  const resumer = createPreflightResumer({ getExecuteDeps: () => deps, auditLog });
  registerPreflightHandler(block, { checkpointStore, resumer });
  registerRunQuestionHandler(block as never, { checkpointStore, resumer, store: triggerPreapprovals });
  const notes = () => records.ownerSearch({ owner: NOTES, entity: 'note', filters: {}, limit: 20 }).records.map((row) => row.id).sort();
  const run = (note_id: string, source: ExecutionSource = CHAT, recipe: RecipeDefinition = MORNING) => handleExecute(deps, {
    recipe_id: recipe.recipe_id, trigger_source: 'manual', execution_source: source, context: { note_id },
    ...(source.channel === 'mcp' ? { contract_snapshot: APP_SNAPSHOT() } : {}),
  } as Parameters<typeof handleExecute>[1]);
  const open = () => askStore.listByStatus('open');
  const answer = async (option: string) => {
    const [ask] = await open();
    await block.submitAnswer({ ask_id: ask!.ask_id, option, via: 'ui' });
  };
  /** The outer recipe's last run, as its audit row records it. */
  const lastRun = async (recipe_id = MORNING.recipe_id) => (await auditLog.listByRecipe(recipe_id, 20))
    .sort((a, b) => b.started_at - a.started_at)[0];
  return { run, open, answer, notes, lastRun, triggerPreapprovals, recipeStore, auditLog };
};

describe('D-402 ruling 17 — a recipe that runs another is approved as one job with it', () => {
  it('the question names the recipe it runs, offers no "Ask me at each step", and "Yes, this time" runs both to the end', async () => {
    const f = fixture();
    expect((await f.run('n1')).awaiting_approval).toBe(true);
    const [ask] = await f.open();
    expect(ask!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    expect(ask!.message.text).toBe('Your chat asks to run it. It also runs “Add a morning note”. Without asking, it will: add a note.');
    expect(ask!.options.map((option) => option.id)).toEqual(['run_once', 'run_always', 'run_no']);
    await f.answer('run_once');
    // The inner write went through under this run's answer: no second ask, the note made, the outer run whole.
    await vi.waitFor(() => expect(f.notes()).toEqual(['n1']));
    expect(await f.open()).toEqual([]);
    expect((await f.lastRun())?.errors ?? []).toEqual([]);
    expect(f.triggerPreapprovals.listCallers()).toMatchObject([{ caller: OWNER, recipe_id: 'morning-routine', uses: 1,
      nested: { 'add-note': triggerPreapprovalRecipeSha256(addNote()) } }]);
  });

  it('"Always" covers the recipe it runs: the next run asks nothing; once that recipe changes, it asks again', async () => {
    const f = fixture();
    expect((await f.run('n1')).awaiting_approval).toBe(true);
    await f.answer('run_always');
    await vi.waitFor(() => expect(f.notes()).toEqual(['n1']));
    const next = await f.run('n2');
    expect(next.awaiting_approval, JSON.stringify(next.errors)).toBeFalsy();
    expect(next.success, JSON.stringify(next.errors)).toBe(true);
    expect(f.notes()).toEqual(['n1', 'n2']);
    // The inner recipe changed since: the "Always" was for the version the question showed, so it asks again.
    f.recipeStore.register(addNote('Changed note'));
    expect((await f.run('n3')).awaiting_approval).toBe(true);
    expect((await f.open())[0]!.message.text).toContain('It also runs “Add a morning note”.');
    expect(f.notes()).toEqual(['n1', 'n2']);
  });

  it('an "Always" granted before the ruling, which names no recipe it runs, asks; answered, the new one covers both', async () => {
    const f = fixture();
    f.triggerPreapprovals.grantCaller({ caller: OWNER, recipe_id: MORNING.recipe_id, recipe_sha256: triggerPreapprovalRecipeSha256(MORNING),
      now: Date.now() });
    expect((await f.run('n1')).awaiting_approval).toBe(true);
    await f.answer('run_always');
    await vi.waitFor(() => expect(f.notes()).toEqual(['n1']));
    expect(f.triggerPreapprovals.listCallers().filter((row) => row.nested !== undefined)).toHaveLength(1);
    expect((await f.run('n2')).success).toBe(true);
    expect(f.notes()).toEqual(['n1', 'n2']);
  });

  it('an AI app\'s run: asked by the app\'s name, and its "Yes" covers the recipe it runs', async () => {
    const f = fixture();
    expect((await f.run('n1', APP_SOURCE)).awaiting_approval).toBe(true);
    const [ask] = await f.open();
    expect(ask!.message.text).toBe('Claude Desktop asks to run it. It also runs “Add a morning note”. Without asking, it will: add a note.');
    await f.answer('run_once');
    await vi.waitFor(() => expect(f.notes()).toEqual(['n1']));
    expect(await f.open()).toEqual([]);
  });

  it('⛔ a recipe it runs that deletes: refused before step 1, naming it, and never asked about; nothing done', async () => {
    const f = fixture();
    const refused = await f.run('n1', CHAT, TIDY);
    expect(refused.awaiting_approval).toBeFalsy();
    expect(refused.success).toBe(false);
    expect(refused.errors).toMatchObject([{ code: 'ROLE_RESTRICTION', source: { recipe_id: 'tidy-routine', step_id: 'invoke' },
      message: '“Tidy routine” can’t start. It runs “Remove the morning note”, which would stop to ask you before it can remove a note. '
        + 'A recipe that another recipe runs can’t stop to ask, so nothing was done. Run “Remove the morning note” on its own, where it can ask.' }]);
    expect(await f.open()).toEqual([]);
    // Nothing ran: the inner recipe never started.
    expect(await f.auditLog.listByRecipe(REMOVE_NOTE.recipe_id, 5)).toEqual([]);
  });
});

describe('D-402 ruling 17 — the store keeps the recipes a run starts on a caller\'s row', () => {
  const SHA = (n: string) => n.repeat(64);
  it('granted with them, read back with them; used for a recipe of them only at its version', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    store.grantCaller({ caller: OWNER, recipe_id: 'morning-routine', recipe_sha256: SHA('a'), run_id: 'run-1', nested: { 'add-note': SHA('b') }, now: 1 });
    expect(store.listCallers()).toMatchObject([{ recipe_id: 'morning-routine', nested: { 'add-note': SHA('b') } }]);
    const call = { caller: OWNER, recipe_id: 'morning-routine', recipe_sha256: SHA('a'), op: 'core.f3-notes.note.create', run_id: 'run-1' };
    expect(store.useCaller({ ...call, nested: { recipe_id: 'add-note', recipe_sha256: SHA('c') } }, 2)).toBeUndefined();
    expect(store.useCaller({ ...call, nested: { recipe_id: 'add-note', recipe_sha256: SHA('b') } }, 3)).toMatchObject({ uses: 1 });
  });

  it('a table made before the column gets it; its rows name no recipe a run starts', () => {
    const db = new Database(':memory:');
    // The table as a server before the ruling made it: the column taken away again.
    createTriggerPreapprovalStore(db);
    db.exec('ALTER TABLE trigger_preapprovals DROP COLUMN nested');
    db.prepare(`INSERT INTO trigger_preapprovals (id, trigger_kind, trigger_ref, door_contract_id, recipe_id, recipe_sha256, prompt_sha256,
      writes, max_per_run, uses, created_at) VALUES ('cpa_old', 'owner_chat', ?, NULL, 'morning-routine', ?, NULL, '["*"]', 0, 0, 1)`)
      .run(PREAPPROVAL_OWNER_CHAT_REF, SHA('a'));
    const after = createTriggerPreapprovalStore(db);
    expect(after.listCallers().find((row) => row.id === 'cpa_old')).not.toHaveProperty('nested');
    after.grantCaller({ caller: OWNER, recipe_id: 'morning-routine', recipe_sha256: SHA('a'), nested: { 'add-note': SHA('b') }, now: 2 });
    expect(after.listCallers().filter((row) => row.nested !== undefined)).toHaveLength(1);
  });
});
