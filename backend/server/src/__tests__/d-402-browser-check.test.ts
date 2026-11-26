/** D-402 slice H3 (§4.2 item 3, §7.4) — each browser a recipe names is checked before step 1, through
 *  `handleExecute` and the real routing (`createBridgeDispatcher` over a real registry and a pairing
 *  roster): a run one of them would stop is refused naming the browser and what is missing, with nothing
 *  done, not even its steps that need no browser; the question before a run is never raised for it; and
 *  its answer checks again, since a browser can go while the owner reads the question. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_ACTIONS,
  BROWSER_PASS_ALWAYS_OPTION_ID,
  RUN_QUESTION_ASK_KIND,
  type BridgeCapabilityProfile,
  type BridgeWireEnvelope,
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

import { recipeBrowserSettings } from '@recued/contracts';
import { createBridgeDispatcher, createBridgeResultListener } from '../bridges/dispatcher.js';
import { createDishStore } from '../dish-store.js';
import { useBrowserInstead, type DishHandlerDeps } from '../dish-handler.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { browserStepNeeds, browserStepRefusalMessage, runBrowserWork } from '../browser-step-check.js';
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

// A note added through a Records catalog op: a step with an effect, that needs no browser.
const NOTES = { publisher: 'core', pack_slug: 'h3-notes' };
const binding = (action: 'create'): RecordsExecutionBinding => ({ kind: 'core.records', action, entity: 'note',
  owner: NOTES, pack_version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: action });
const BINDINGS = { create: binding('create') };
const SCHEMA: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
  { key: 'id', kind: 'id', slot: 'pk', required: true }, { key: 'title', kind: 'string', slot: 's1', required: true },
] } } };
const notesManifest = {
  slug: 'h3-notes', name: 'Notes', description: 'Notes', author: 'core', kind: 'storage', version: 1, category: 'data',
  risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
  operations: { create: { operation_id: 'core.h3-notes.note.create', risk_tier: 'write', groups: ['notes.write'], description: 'Add a note.' } },
  operation_groups: { 'notes.write': { group_id: 'notes.write', operations: ['create'], risk_floor: 'write' } },
  surfaces: { records: { executes: BINDINGS, schema: SCHEMA } },
} as unknown as IngredientManifest;

const CHAT: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 't1' } as ExecutionSource;
const RUN_BUTTON: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'tok' } as ExecutionSource;

const ADD = { id: 'add', ingredient: 'h3-notes', input: { operation: 'create', args: { id: '{{context.note_id}}', values: { title: 'Read in two browsers' } } } };
/** A browser step reading the tabs open on a site, in the browser its setting names. */
const TABS = (id: string, key: string, site: string) => ({ id, op: 'core.dom.tabs', args: { target: `https://${site}/*`, bridge_id: `{{config.${key}}}` } });

/** Two paired browsers: their tokens, the owner's names, their lasting ids. */
const ROSTER = [
  { bridge_id: 'tok-work', bridge_label: 'Work', browser_id: 'inst-work' },
  { bridge_id: 'tok-home', bridge_label: 'Home', browser_id: 'inst-home' },
];
const profile = (granted_origins: string[]): BridgeCapabilityProfile => ({ software_version: '0.0.13', chrome_version: '140',
  permissions_granted: ['tabs', 'scripting'], granted_origins, offscreen_supported: true, alarms_supported: true,
  supported_actions: [...BRIDGE_ACTIONS] });

const fixture = (steps: unknown[], variables: Record<string, unknown> = { browser_1: 'inst-work', browser_2: 'inst-home' },
  timing: { tabsDelayMs?: number; heldBrowserDescribeTimeoutMs?: number; uninstalled?: boolean } = {}) => {
  const db = new Database(':memory:');
  const records = createRecordsStore(db, { now: () => Date.now() });
  records.installNamespace({ owner: NOTES, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'h3', schema: SCHEMA, bindings: BINDINGS });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(notesManifest);
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);

  // The real routing over a real registry: what a browser is sent, by token.
  const registry = createBridgeRegistry(), listener = createBridgeResultListener();
  const sent: Array<{ to: string; action: string }> = [];
  const connect = (token: 'tok-work' | 'tok-home', origins = ['*://*/*']) => registry.attach({ client_token_id: token,
    client_label: 'Chrome on macOS', session_id: `${token}-session`, online_since: 1, last_seen_at: 1, capabilities: profile(origins) });
  const dispatcher = createBridgeDispatcher({ registry, listener, pairedBridges: () => ROSTER,
    browserName: (id) => (id === 'inst-old' ? 'Old laptop' : undefined),
    transport: { cancel: async () => ({ ok: true }), send: async (to: string, envelope: BridgeWireEnvelope) => {
      if (envelope.kind !== 'command') throw new Error('Expected a command');
      const command = envelope.command;
      sent.push({ to, action: command.action });
      if (command.action === 'list_tabs' && timing.tabsDelayMs) await new Promise(resolve => setTimeout(resolve, timing.tabsDelayMs));
      const site = to === 'tok-work' ? 'a.example' : 'b.example';
      // A click, and the element it names, on b.example whichever browser it runs in: a test varies the
      // browser alone.
      const page = { page: '7:DOC1', url: 'https://b.example/orders', title: 'Orders' };
      const outputs = command.action === 'describe' ? { ...page, role: 'button', label: 'Send', protected: false }
        : command.action === 'click' ? { ...page, clicked: 1 }
        : command.action === 'reread' || command.action === 'inspect' ? { ...page, html: '<main><button ref="e1">Send</button></main>', truncated: false }
        : { tabs: [{ page: '7:DOC1', url: `https://${site}/orders`, title: `Orders on ${site}` }], truncated: false };
      listener.resolveResult({ command_id: command.command_id, status: 'ok', duration_ms: 1, bridge_version: '0.0.13',
        idempotency_key_seen: false, outputs });
      return { ok: true };
    } } });

  const contractStore = createContractStore(db);
  contractStore.put('grant', ['h3-notes', 'h3-notes', 'h3-notes', 'notes.write'], { allowed: true });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const recipe = {
    recipe_id: 'read-in-two-browsers', version: 1, ttl: 60,
    metadata: { name: 'Read in two browsers', description: 'Notes it, then reads in each browser.', author: 'test', supported_platforms: ['test'] },
    variables, prefetch_steps: [], steps, output: { sidebar: [] },
  } as unknown as RecipeDefinition;
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  // Installed, so a chat's run of it gets the question before a run (§7.4).
  const stored = Object.assign(Object.create(recipeStore) as typeof recipeStore, {
    getStored: (id: string) => (id === recipe.recipe_id ? { recipe_id: id, pack_slug: null } : null),
  });
  const triggerPreapprovals = createTriggerPreapprovalStore(db);
  const browserPasses = createBrowserPassStore(db);
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
  // The recipe's main dish, as an installed recipe has; its settings are the run's (D-319).
  const dishStore = createDishStore(db);
  dishStore.set({ dish_id: 'dsh_main', recipe_id: 'read-in-two-browsers', publisher_id: 'local', name: 'Main', is_default: true,
    config_overlay: {}, enabled: true, created_at: 1_000 });
  // The dish rpc as the server wires it (`ws-server.ts`): the recipe's browser settings, the browsers paired now.
  const dishDeps: DishHandlerDeps = { store: dishStore, now: () => 5_000,
    browserSettingsOf: (recipe_id) => (recipe_id === recipe.recipe_id
      ? { keys: recipeBrowserSettings(recipe).map((setting) => setting.key), variables: recipe.variables as Record<string, unknown> } : null),
    pairedBrowsers: () => dispatcher.listBrowsers?.() ?? [] };
  const deps = {
    recipeStore: timing.uninstalled ? recipeStore : stored, baseVault: {}, recordsStore: records, instanceId: 'd-402-h3', dishStore,
    executorConfig: { manifests, bridgeDispatcherRef: () => dispatcher },
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    checkpointStore, auditLog, preflightNotifier: block, triggerPreapprovals, browserPasses,
    sessionGrantResolver: createSessionGrantResolver({ definitionStore }),
    ...(timing.heldBrowserDescribeTimeoutMs !== undefined ? { heldBrowserDescribeTimeoutMs: timing.heldBrowserDescribeTimeoutMs } : {}),
  } as unknown as ExecuteHandlerDeps;
  const resumer = createPreflightResumer({ getExecuteDeps: () => deps, auditLog });
  registerPreflightHandler(block, { checkpointStore, resumer });
  registerRunQuestionHandler(block as never, { checkpointStore, resumer, store: triggerPreapprovals });
  const notes = () => records.ownerSearch({ owner: NOTES, entity: 'note', filters: {}, limit: 20 }).records.map((row) => row.id).sort();
  const run = (execution_source: ExecutionSource = RUN_BUTTON, config?: Record<string, unknown>, note_id = 'n1') => handleExecute(deps, {
    ...(timing.uninstalled ? { recipe } : { recipe_id: recipe.recipe_id }), trigger_source: 'manual', execution_source, context: { note_id },
    ...(config !== undefined ? { config } : {}),
  } as Parameters<typeof handleExecute>[1]);
  const open = () => askStore.listByStatus('open');
  const answer = async (option: string) => {
    const [ask] = await open();
    await block.submitAnswer({ ask_id: ask!.ask_id, option, via: 'ui' });
  };
  const lastErrors = async () => (await auditLog.listByRecipe(recipe.recipe_id, 10))
    .sort((a, b) => b.started_at - a.started_at)[0]?.errors ?? [];
  return { recipe, registry, connect, sent, run, notes, open, answer, lastErrors, triggerPreapprovals, dishStore, dishDeps, browserPasses };
};

const IN_TWO = [ADD, TABS('read_work', 'browser_1', 'a.example'), TABS('read_home', 'browser_2', 'b.example')];

describe('D-402 slice H3 — every browser checked before step 1', () => {
  // Until 2026-11-23 the gate listed the tabs, within the configured observation deadline, before it let a batch of reads
  // through, and a listing too slow made it ask. Opening a page is a read since then (the owner: "make all reads & open as
  // normal read permission"), so a batch of reads is let through without a listing, however slow the tabs answer.
  it('admits a batch of reads without listing the tabs first, however slow they answer', async () => {
    const f = fixture([{ id: 'read_home', op: 'core.dom.act', args: { target: 'https://b.example/*',
      bridge_id: '{{config.browser}}', steps: [{ url: 'https://b.example/orders', do: 'read' }] } }],
    { browser: 'inst-home' }, { tabsDelayMs: 100, heldBrowserDescribeTimeoutMs: 20, uninstalled: true });
    f.connect('tok-home');
    const ran = await f.run(CHAT);
    expect(ran.awaiting_approval ?? false, JSON.stringify(ran.errors)).toBe(false);
    expect(await f.open()).toHaveLength(0);
    // Finish the delayed transport replies before the fixture is discarded.
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('both connected and allowed: the run goes, each browser reading its own site', async () => {
    const f = fixture(IN_TWO);
    f.connect('tok-work'); f.connect('tok-home');
    const done = await f.run();
    expect(done.success, JSON.stringify(done.errors)).toBe(true);
    expect(f.notes()).toEqual(['n1']);
    expect(f.sent.map((row) => row.to)).toEqual(['tok-work', 'tok-home']);
  });

  it('⛔ one not connected: refused naming it, and nothing done, not even the note before any browser step', async () => {
    const f = fixture(IN_TWO);
    f.connect('tok-work');
    const refused = await f.run();
    expect(refused.success).toBe(false);
    expect(refused.errors).toMatchObject([{ code: 'ROLE_RESTRICTION', source: { step_id: 'read_home' },
      message: '“Home” is not connected: open Chrome with its Browser Bridge. Nothing was done.',
      details: { browsers: [{ step_id: 'read_home', setting: 'browser_2', browser_id: 'inst-home', problem: 'offline', name: 'Home' }] } }]);
    expect(f.notes()).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it('a site its browser may not act on, said as the owner reads it', async () => {
    const f = fixture(IN_TWO);
    f.connect('tok-work', ['https://elsewhere.example/*']); f.connect('tok-home');
    const refused = await f.run();
    expect(refused.errors).toMatchObject([{ message: '“Work” may not act on a.example: allow that site in its Browser Bridge. Nothing was done.' }]);
    expect([f.notes(), f.sent]).toEqual([[], []]);
  });

  it('a browser no longer paired, by the name its pairing left: choose the one to use instead', async () => {
    const f = fixture(IN_TWO, { browser_1: 'inst-work', browser_2: 'inst-old' });
    f.connect('tok-work'); f.connect('tok-home');
    const refused = await f.run();
    expect(refused.errors).toMatchObject([{ message: '“Old laptop”, the browser this recipe acts in, is no longer paired: '
      + 'choose the browser to use instead in the recipe\'s settings. Nothing was done.' }]);
    expect([f.notes(), f.sent]).toEqual([[], []]);
  });

  it('slice H3b — a Bridge too old for what its step asks: refused naming the browser and its version, nothing done', async () => {
    // Home acts on a row (D-402 slice G), which needs a Bridge that checks the row at the step (`row_checks`).
    const inRow = { id: 'open_bob', op: 'core.dom.act', args: { target: 'https://b.example/*', bridge_id: '{{config.browser_2}}',
      page: '7:DOC1', steps: [{ do: 'click', text: 'Open', within: { text: ['Bob'] } }] } };
    const f = fixture([ADD, TABS('read_work', 'browser_1', 'a.example'), inRow]);
    f.connect('tok-work'); f.connect('tok-home');
    const refused = await f.run();
    expect(refused.errors).toMatchObject([{ code: 'ROLE_RESTRICTION', source: { step_id: 'open_bob' },
      message: '“Home” has a Browser Bridge too old for this recipe (0.0.13): update it. Nothing was done.',
      details: { browsers: [{ step_id: 'open_bob', problem: 'update', name: 'Home', version: '0.0.13' }] } }]);
    expect([f.notes(), f.sent]).toEqual([[], []]);
  });

  it('the run\'s own settings are what is checked: a dish that moves both steps to Work runs with Home gone', async () => {
    const f = fixture(IN_TWO);
    f.connect('tok-work');
    const done = await f.run(RUN_BUTTON, { browser_2: 'inst-work' });
    expect(done.success, JSON.stringify(done.errors)).toBe(true);
    expect(f.sent.map((row) => row.to)).toEqual(['tok-work', 'tok-work']);
  });
});

describe('D-402 slice H3c — "Use this browser instead" (ruling 14)', () => {
  it('a fresh pairing: the run names the browser gone, offers the new one, and once moved the next run goes', async () => {
    // Home was paired again: its old pairing is gone, and the new one is connected as Home.
    const f = fixture(IN_TWO, { browser_1: 'inst-work', browser_2: 'inst-old' });
    f.connect('tok-work'); f.connect('tok-home');
    const refused = await f.run();
    expect([f.notes(), f.sent]).toEqual([[], []]);
    expect(refused.run_needs).toEqual([{ kind: 'browser', step_id: 'read_home', problem: 'not_paired', setting: 'browser_2',
      browser_id: 'inst-old', name: 'Old laptop', dish_id: 'dsh_main', instead: { browser_id: 'inst-home', name: 'Home' } }]);
    const need = refused.run_needs![0] as { dish_id: string; browser_id: string; instead: { browser_id: string } };
    expect(useBrowserInstead(f.dishDeps, { dish_id: need.dish_id, from: need.browser_id, to: need.instead.browser_id }).moved).toEqual(['browser_2']);
    const done = await f.run();
    expect(done.success, JSON.stringify(done.errors)).toBe(true);
    expect(done.run_needs).toBeUndefined();
    expect(f.sent.map((row) => row.to)).toEqual(['tok-work', 'tok-home']);
  });

  it('⛔ a browser only not connected is never offered one the run already uses', async () => {
    const f = fixture(IN_TWO);
    f.connect('tok-work');
    const refused = await f.run();
    expect(refused.run_needs).toEqual([{ kind: 'browser', step_id: 'read_home', problem: 'offline', setting: 'browser_2',
      browser_id: 'inst-home', name: 'Home', dish_id: 'dsh_main' }]);
  });
});

describe('D-402 slice H3 — the question before a run (§7.4)', () => {
  it('slice H4a — a recipe that reads in Work and acts in Home: each action named by its browser, and what crosses', async () => {
    const CLICK = { id: 'send_home', op: 'core.dom.click', args: { target: 'https://b.example/*', bridge_id: '{{config.browser_2}}',
      page: '7:DOC1', ref: 'e1' } };
    const f = fixture([TABS('read_work', 'browser_1', 'a.example'), CLICK]);
    f.connect('tok-work'); f.connect('tok-home');
    expect((await f.run(CHAT)).awaiting_approval).toBe(true);
    const [ask] = await f.open();
    expect(ask!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    expect(ask!.message.text).toBe('Your chat asks to run it. Without asking, it will: act in Home on b.example. '
      + 'In Work it reads a.example. What it reads in Work is used in Home.');
  });

  const ASKS = [ADD, TABS('read_home', 'browser', 'b.example')];
  const one = { browser: 'inst-home' };

  it('is never raised for a run that cannot start', async () => {
    const f = fixture(ASKS, one);
    const refused = await f.run(CHAT);
    expect(refused.awaiting_approval).toBeFalsy();
    expect(refused.errors).toMatchObject([{ message: '“Home” is not connected: open Chrome with its Browser Bridge. Nothing was done.' }]);
    expect(await f.open()).toEqual([]);
    expect([f.notes(), f.sent]).toEqual([[], []]);
  });

  it('⛔ its answer checks again: a browser gone while the owner read the question stops the run, nothing done', async () => {
    const f = fixture(ASKS, one);
    f.connect('tok-home');
    expect((await f.run(CHAT)).awaiting_approval).toBe(true);
    expect((await f.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    f.registry.detach('tok-home');
    await f.answer('run_once');
    expect([f.notes(), f.sent]).toEqual([[], []]);
    expect(await f.lastErrors()).toMatchObject([{ code: 'ROLE_RESTRICTION',
      message: '“Home” is not connected: open Chrome with its Browser Bridge. Nothing was done.' }]);
    // The one run's approval ends with the run it was for.
    const granted = f.triggerPreapprovals.listCallers();
    expect(granted).toHaveLength(1);
    expect(granted[0]!.revoked_at).toBeDefined();
  });

  it('slice H4 (§8 item 7) — "Always" holds the run to its browser: once the dish moves to another, the next run asks again', async () => {
    const f = fixture(ASKS, one);
    f.connect('tok-home'); f.connect('tok-work');
    expect((await f.run(CHAT, undefined, 'n1')).awaiting_approval).toBe(true);
    await f.answer('run_always');
    expect(f.notes()).toEqual(['n1']);
    const [always] = f.triggerPreapprovals.listCallers();
    expect([always!.run_id, always!.browsers]).toEqual([undefined, { browser: 'inst-home' }]);
    // Covered: the next run in Home goes without asking.
    const covered = await f.run(CHAT, undefined, 'n2');
    expect(covered.awaiting_approval, JSON.stringify(covered.errors)).toBeFalsy();
    expect(f.notes()).toEqual(['n1', 'n2']);
    // The dish now acts in Work: the "Always" was for Home, so the run is asked about again, nothing done.
    useBrowserInstead(f.dishDeps, { dish_id: 'dsh_main', from: 'inst-home', to: 'inst-work' });
    const asked = await f.run(CHAT, undefined, 'n3');
    expect(asked.awaiting_approval).toBe(true);
    expect((await f.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    expect(f.notes()).toEqual(['n1', 'n2']);
    // Answered, it runs in Work, the dish's browser now.
    await f.answer('run_once');
    expect(f.notes()).toEqual(['n1', 'n2', 'n3']);
    expect(f.sent.map((row) => row.to)).toEqual(['tok-home', 'tok-home', 'tok-work']);
  });

  it('slice H4c — a site pass holds the write to the browser it was granted in: moved to another, the write asks', async () => {
    const CLICK = { id: 'send_home', op: 'core.dom.click', args: { target: 'https://b.example/*', bridge_id: '{{config.browser}}',
      page: '7:DOC1', ref: 'e1' } };
    const f = fixture([CLICK], one);
    f.connect('tok-home'); f.connect('tok-work');
    f.browserPasses.mint({ key: { principal: { kind: 'owner_chat' }, recipe: f.recipe.recipe_id, site: 'https://b.example', browser: 'inst-home' },
      host: 'b.example', kind: 'always', now: Date.now() });
    // In Home: the pass covers the click, so no question, and it runs without asking.
    const done = await f.run(CHAT, undefined, 'n1');
    expect(done.awaiting_approval, JSON.stringify(done.errors)).toBeFalsy();
    expect(f.sent.filter((row) => row.action === 'click').map((row) => row.to)).toEqual(['tok-home']);
    // Moved to Work: Home's pass is not Work's. Asked about the run, then, step by step, the click asks too.
    useBrowserInstead(f.dishDeps, { dish_id: 'dsh_main', from: 'inst-home', to: 'inst-work' });
    expect((await f.run(CHAT, undefined, 'n2')).awaiting_approval).toBe(true);
    expect((await f.open())[0]!.handler_kind).toBe(RUN_QUESTION_ASK_KIND);
    await f.answer('run_each_step');
    const [held] = await f.open();
    // The click's own ask, held at its step.
    expect(held).toBeDefined();
    expect(held!.handler_kind).not.toBe(RUN_QUESTION_ASK_KIND);
    expect(held!.options.map((option) => option.id)).toContain('approve');
    expect(f.sent.filter((row) => row.action === 'click').map((row) => row.to)).toEqual(['tok-home']);
  });

  it('slice H4c — "Always allow on b.example", answered on the held click, is a pass for the browser it ran in', async () => {
    const CLICK = { id: 'send_home', op: 'core.dom.click', args: { target: 'https://b.example/*', bridge_id: '{{config.browser}}',
      page: '7:DOC1', ref: 'e1' } };
    const f = fixture([CLICK], one);
    f.connect('tok-home'); f.connect('tok-work');
    expect((await f.run(CHAT, undefined, 'n1')).awaiting_approval).toBe(true);
    await f.answer('run_each_step');
    const [held] = await f.open();
    expect(held!.options.map((option) => option.id)).toContain(BROWSER_PASS_ALWAYS_OPTION_ID);
    // Slice H4d — the ask says its answers are for Home alone, by the owner's name for it.
    expect(held!.message.text).toContain('Both are for “Home” alone: in another browser, each still asks.');
    await f.answer(BROWSER_PASS_ALWAYS_OPTION_ID);
    expect(f.sent.filter((row) => row.action === 'click').map((row) => row.to)).toEqual(['tok-home']);
    // ⛔ The answer is read back from the hold, and its pass is Home's: the hold kept the browser it offered.
    expect(f.browserPasses.listPasses(Date.now()).map((pass) => pass.key.browser)).toEqual(['inst-home']);
    // In Home the next run is covered: no question, and the click runs without asking.
    const again = await f.run(CHAT, undefined, 'n2');
    expect(again.awaiting_approval, JSON.stringify(again.errors)).toBeFalsy();
    expect(f.sent.filter((row) => row.action === 'click').map((row) => row.to)).toEqual(['tok-home', 'tok-home']);
    // Moved to Work, Home's pass covers nothing there: the run asks.
    useBrowserInstead(f.dishDeps, { dish_id: 'dsh_main', from: 'inst-home', to: 'inst-work' });
    expect((await f.run(CHAT, undefined, 'n3')).awaiting_approval).toBe(true);
  });

  it('with the browser back, the next run asks, and "Yes, this time" runs it', async () => {
    const f = fixture(ASKS, one);
    f.connect('tok-home');
    expect((await f.run(CHAT)).awaiting_approval).toBe(true);
    await f.answer('run_once');
    expect(f.notes()).toEqual(['n1']);
    expect(f.sent.map((row) => row.to)).toEqual(['tok-home']);
  });
});

describe('D-402 slice H3 — what the run checks, read from the recipe', () => {
  const recipe = (variables: Record<string, unknown>, steps: unknown[]) => ({ recipe_id: 'r', variables, steps } as unknown as RecipeDefinition);
  it('each browser step\'s setting, the run\'s value over the recipe\'s, and its site when known before step 1', () => {
    expect(browserStepNeeds(recipe({ browser: 'inst-work', site: 'https://c.example/*' }, [
      { id: 'a', op: 'core.dom.act', args: { target: 'https://a.example/*', bridge_id: '{{config.browser}}' } },
      { id: 'b', op: 'core.dom.act', args: { target: '{{config.site}}', bridge_id: '{{config.browser}}' } },
      { id: 'c', op: 'core.dom.act', args: { target: '{{step.found.url}}', bridge_id: '{{config.browser}}' } },
    ]), { browser: 'inst-home' })).toEqual([
      { step_id: 'a', setting: 'browser', browser_id: 'inst-home', target: 'https://a.example/*' },
      { step_id: 'b', setting: 'browser', browser_id: 'inst-home', target: 'https://c.example/*' },
      { step_id: 'c', setting: 'browser', browser_id: 'inst-home' },
    ]);
  });
  it('nothing for a setting holding no browser (routing\'s to choose), nor a caller\'s own choice of browser', () => {
    const steps = [{ id: 'a', op: 'core.dom.act', args: { target: 'https://a.example/*', bridge_id: '{{config.browser}}' } }];
    expect(browserStepNeeds(recipe({ browser: '' }, steps), {})).toEqual([]);
    expect(browserStepNeeds(recipe({ browser: { label: 'Browser', type: 'string', default: '' } }, steps), { browser: 'tok-work' })).toEqual([]);
  });
  it('slice H4a — what the run does in each browser, in step order, by the owner\'s names: a site it acts on is not also read', () => {
    const steps = [
      { id: 'read_a', op: 'core.dom.act', args: { target: 'https://a.example/*', bridge_id: '{{config.work}}', steps: [{ do: 'read' }] } },
      { id: 'tabs_c', op: 'core.dom.tabs', args: { target: 'https://c.example/*', bridge_id: '{{config.work}}' } },
      // Opening a page is a read since 2026-11-23: its site is read, not acted on.
      { id: 'open_d', op: 'core.dom.open', args: { target: 'https://d.example/*', bridge_id: '{{config.work}}', address: 'https://d.example/x' } },
      { id: 'read_b', op: 'core.dom.act', args: { target: 'https://b.example/*', bridge_id: '{{config.home}}', steps: [{ do: 'read' }] } },
      { id: 'type_b', op: 'core.dom.act', args: { target: 'https://b.example/*', bridge_id: '{{config.home}}', steps: [{ do: 'type', ref: 'e1', value: 'x' }] } },
    ];
    const names: Record<string, string> = { 'inst-work': 'Work', 'inst-home': 'Home' };
    expect(runBrowserWork(recipe({ work: 'inst-work', home: 'inst-home' }, steps), {}, (id) => names[id])).toEqual([
      { name: 'Work', reads: ['a.example', 'c.example', 'd.example'], acts: [] },
      { name: 'Home', reads: [], acts: ['b.example'] },
    ]);
  });

  it('each browser and what it is missing, said once each', () => {
    const at = { step_id: 'a', setting: 'browser', browser_id: 'inst-work' };
    expect(browserStepRefusalMessage([
      { ...at, problem: 'offline', name: 'Work' }, { ...at, step_id: 'b', problem: 'offline', name: 'Work' },
      { ...at, problem: 'site', name: 'Home', site: 'b.example' }, { ...at, problem: 'not_paired' },
    ])).toBe('“Work” is not connected: open Chrome with its Browser Bridge. “Home” may not act on b.example: allow that site in its '
      + 'Browser Bridge. The browser this recipe acts in is no longer paired: choose the browser to use instead in the recipe\'s settings. '
      + 'Nothing was done.');
  });
});
