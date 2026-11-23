/** D-341 slice B1 — a trigger's standing pre-approval on the server: the store that spends its
 *  uses (`storage/trigger-preapproval-store.ts`), how a recipe's ops are named
 *  (`trigger-preapproval-ops.ts`), the owner's rpc that grants, lists and ends one
 *  (`trigger-preapproval-rpc.ts`), and a held write of a scheduled or triggered run going through
 *  under one in `handleExecute`. The gates' own seams are the gateway's
 *  `d-341-trigger-preapproval-gate.test.ts` and the engine's
 *  `d-341-trigger-preapproval-catalog-gate.test.ts`; a webhook run's Records write through its door
 *  is the live drive's (`scripts/drives/d-341-trigger-preapproval-live.mjs`).
 *
 *  ⚠ The rpc's recipe is stored LOWERED, as an install stores it: a recipe registered with its
 *  authored `op` steps passed every test here while a real install matched nothing (live,
 *  2026-11-08). */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  browserActCallUploads,
  type BridgeResult,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type RecordsExecutionBinding,
  type RecordsSchemaSnapshot,
  type TriggerPreapprovalTrigger,
} from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import { canonicalJsonString, canonicalRecipeDefinition, type PackOpResolution } from '@recued/recipes';
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
import { createRecipeStore } from '../recipe-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractScanFn, createContractStore } from '../storage/contract-store.js';
import { createTriggerPreapprovalStore, type TriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import {
  createTriggerPreapprovalGranter,
  createTriggerPreapprovalRpcHandlers,
  createTriggerPreapprovalTargets,
  triggerPreapprovalRecipeSha256,
} from '../trigger-preapproval-rpc.js';
import {
  preapprovableOp, recipeAiSteps, recipeStepOpLabels, recipeStepOps, triggerPreapprovalOfferFor,
} from '../trigger-preapproval-ops.js';
import { createTriggerPreapprovalAdmission } from '../trigger-preapproval-admission.js';
import { createRecordsStore } from '../records/store.js';

const DAY = 86_400_000;
const APPROVAL = { run_id: 'approved-run', checkpoint_id: 'approved-checkpoint' };
const OP = 'recued-core.body-signals.daily_metric.batch';
const WEBHOOK: TriggerPreapprovalTrigger = { kind: 'webhook', ingress_id: 'whi_1' };
const SCHEDULE: TriggerPreapprovalTrigger = { kind: 'schedule', schedule_id: 'sch_1' };

const grantInput = (overrides: Partial<Parameters<TriggerPreapprovalStore['grant']>[0]> = {}) => ({
  trigger: WEBHOOK, door_contract_id: 'door-1', recipe_id: 'r', recipe_sha256: 'a'.repeat(64), writes: [OP],
  max_per_run: 1, now: 0, ...overrides,
});
const useCall = (overrides: Record<string, unknown> = {}) => ({
  trigger: WEBHOOK, door_contract_id: 'door-1', recipe_id: 'r', recipe_sha256: 'a'.repeat(64), op: OP, run_id: 'run-1',
  ...overrides,
}) as Parameters<TriggerPreapprovalStore['use']>[0];

describe('D-341 slice B1 — the store spends a pre-approval\'s uses', () => {
  it('spends one use a call, counted per run up to the run\'s cap, with no cap on its uses (ruling 10)', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const row = store.grant(grantInput({ max_per_run: 2 }));
    expect(row).toMatchObject({ uses: 0, max_per_run: 2, door_contract_id: 'door-1' });
    expect(row).not.toHaveProperty('max_uses');
    expect(row).not.toHaveProperty('expires_at');
    expect(store.use(useCall(), 1)).toMatchObject({ id: row.id, uses: 1, last_used_at: 1 });
    expect(store.use(useCall(), 2)).toMatchObject({ uses: 2 });
    // The run's cap is spent: a third write in the same run asks.
    expect(store.use(useCall(), 3)).toBeUndefined();
    expect(store.runUses(row.id, 'run-1')).toBe(2);
    // Each run after has its own cap, as long as it lasts: it has no end of its own.
    for (let run = 2; run <= 150; run += 1) expect(store.use(useCall({ run_id: `run-${String(run)}` }), 3 + run)?.id).toBe(row.id);
    expect(store.get(row.id)).toMatchObject({ uses: 151, last_used_at: 153 });
  });

  it('spends nothing on a write it does not cover, or once it has been ended', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const row = store.grant(grantInput());
    for (const [name, call] of [
      ['another op', useCall({ op: 'recued-core.body-signals.daily_metric.delete' })],
      ['another version', useCall({ recipe_sha256: 'b'.repeat(64) })],
      ['another recipe', useCall({ recipe_id: 'other' })],
      ['another webhook', useCall({ trigger: { kind: 'webhook', ingress_id: 'whi_2' } })],
      ['a door minted since', useCall({ door_contract_id: 'door-2' })],
      ['a schedule of the same id', useCall({ trigger: { kind: 'schedule', schedule_id: 'whi_1' } })],
    ] as const) expect(store.use(call, 1), name).toBeUndefined();
    expect(store.get(row.id)?.uses).toBe(0);

    const kept = createTriggerPreapprovalStore(new Database(':memory:'));
    const live = kept.grant(grantInput());
    expect(kept.revoke(live.id, 5)).toMatchObject({ revoked_at: 5 });
    // Ending one already ended keeps when it ended.
    expect(kept.revoke(live.id, 9)).toMatchObject({ revoked_at: 5 });
    expect(kept.use(useCall(), 6)).toBeUndefined();
    expect(() => kept.revoke('tpa_missing', 1)).toThrow(/no pre-approval tpa_missing/u);
  });

  it('spends the one granted first, then the next, within a run', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const first = store.grant(grantInput({ now: 1 }));
    const second = store.grant(grantInput({ now: 2 }));
    expect(store.use(useCall(), 3)?.id).toBe(first.id);
    // The first's cap a run is spent: the run's next write goes under the second, then asks.
    expect(store.use(useCall(), 4)?.id).toBe(second.id);
    expect(store.use(useCall(), 5)).toBeUndefined();
    expect(store.use(useCall({ run_id: 'run-2' }), 6)?.id).toBe(first.id);
    expect(store.list().map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it('counts a run\'s cap across its ops, and lists what each run made, per op, in order', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const DELETE = 'recued-core.body-signals.daily_metric.delete';
    const row = store.grant(grantInput({ writes: [OP, DELETE], max_per_run: 2 }));
    expect(store.use(useCall({ op: DELETE }), 1)).toMatchObject({ uses: 1 });
    expect(store.use(useCall(), 2)).toMatchObject({ uses: 2 });
    expect(store.use(useCall({ op: DELETE }), 3)).toBeUndefined();
    expect(store.runUses(row.id, 'run-1')).toBe(2);
    expect(store.runWrites('run-1')).toEqual([
      { preapproval_id: row.id, op: DELETE, uses: 1 }, { preapproval_id: row.id, op: OP, uses: 1 }]);
    expect(store.runWrites('run-2')).toEqual([]);
  });

  it('keeps its rows across a restart of the server', () => {
    const db = new Database(':memory:');
    const row = createTriggerPreapprovalStore(db).grant(grantInput());
    createTriggerPreapprovalStore(db).use(useCall(), 1);
    expect(createTriggerPreapprovalStore(db).get(row.id)).toEqual({ ...row, uses: 1, last_used_at: 1 });
  });

  it('rebuilds a table made with an end date and a use cap: its rows kept, lasting until they are ended', () => {
    const db = new Database(':memory:');
    // The table as B1 made it, with a row whose end date and use cap are both spent.
    db.exec(`CREATE TABLE trigger_preapprovals (id TEXT PRIMARY KEY, trigger_kind TEXT NOT NULL, trigger_ref TEXT NOT NULL,
      door_contract_id TEXT, recipe_id TEXT NOT NULL, recipe_sha256 TEXT NOT NULL, writes TEXT NOT NULL,
      max_per_run INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER)`);
    db.prepare(`INSERT INTO trigger_preapprovals VALUES ('tpa_old', 'webhook', 'whi_1', 'door-1', 'r', ?, ?, 1, 3, 3, 1, 2, NULL, 2)`)
      .run('a'.repeat(64), JSON.stringify([OP]));
    db.prepare(`INSERT INTO trigger_preapprovals VALUES ('tpa_gone', 'webhook', 'whi_1', 'door-1', 'r', ?, ?, 1, 3, 0, 1, 99, 5, NULL)`)
      .run('a'.repeat(64), JSON.stringify([OP]));
    const store = createTriggerPreapprovalStore(db);
    const columns = (db.prepare('PRAGMA table_info(trigger_preapprovals)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain('expires_at');
    expect(columns).not.toContain('max_uses');
    expect(store.get('tpa_old')).toMatchObject({ uses: 3, last_used_at: 2, door_contract_id: 'door-1', writes: [OP] });
    expect(store.get('tpa_gone')).toMatchObject({ revoked_at: 5 });
    // Its index came back with it, and its old row covers the next write.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'trigger_preapprovals_by_trigger'").get())
      .toBeDefined();
    expect(store.use(useCall(), 10)?.id).toBe('tpa_old');
    // A second boot finds nothing to rebuild.
    expect(createTriggerPreapprovalStore(db).get('tpa_old')).toMatchObject({ uses: 4 });
  });
});

// ── How a recipe's ops are named ─────────────────────────────────────────────────────────────────
// As an install stores the intake: its Records catalog, by the slug the install mints for it.
const CATALOG = 'records-0123456789abcdef0123456789abcdef';
const SEARCH = 'recued-core.body-signals.daily_metric.search';
const catalogManifest = {
  slug: CATALOG, name: 'Body signals', description: '', author: 'recued-core', kind: 'connection', category: 'action',
  risk_tier: 'read', input: {}, output: {},
  operations: {
    'daily_metric.batch': { operation_id: OP, risk_tier: 'write', groups: ['g'],
      description: 'Save up to 100 daily readings in one transaction, all or none. Upserts only: read the rows first.' },
    'daily_metric.search': { operation_id: SEARCH, risk_tier: 'read', groups: ['g'], description: 'Page a Body\'s daily readings.' },
  },
} as unknown as IngredientManifest;
const aiManifest = { slug: 'summarize-pack', kind: 'ai' } as unknown as IngredientManifest;
const manifestOf = (slug: string): IngredientManifest | null =>
  slug === CATALOG ? catalogManifest : slug === 'summarize-pack' ? aiManifest : null;
const PACKS: PackOpResolution = new Map([['recued-core.body-signals',
  { catalog_slug: CATALOG, operations: new Set(['daily_metric.batch', 'daily_metric.search']) }]]);
const installed = (id: string, operation: string) => ({ id, ingredient: CATALOG, input: { operation, args: {} } });

describe('D-341 slice B1 — the ops a recipe\'s steps call, named as the gate names them', () => {
  it('names an installed step by its catalog\'s operation id, and an authored one the same through its pack', () => {
    const ops = recipeStepOps(recipeOf([installed('read', 'daily_metric.search'), installed('save', 'daily_metric.batch'),
      { id: 'authored', op: OP, args: {} }, { id: 'total', transform: 'count', array: '{{step.read}}' }]), { manifestOf, packs: PACKS });
    expect(Object.fromEntries(ops)).toEqual({ read: SEARCH, save: OP, authored: OP });
  });

  it('names a kernel op by the ingredient it lowers to, and any other step by its slug', () => {
    const ops = recipeStepOps(recipeOf([{ id: 'act', op: 'core.dom.click', args: { target: '*://e/*', page: 'p', ref: 'e1' } },
      { id: 'send', ingredient: 'mail-send', input: {} }]), { manifestOf });
    expect(Object.fromEntries(ops)).toEqual({ act: 'dom-click', send: 'mail-send' });
  });

  it('names none for a target or operation the run decides, or a pack not installed; a vendor-neutral write by its neutral name (B7)', () => {
    const ops = recipeStepOps(recipeOf([
      { id: 'target', ingredient: '{{config.ingredient}}', input: {} },
      { id: 'operation', ingredient: CATALOG, input: { operation: '{{config.op}}', args: {} } },
      { id: 'unknown_op', ingredient: CATALOG, input: { operation: 'daily_metric.purge', args: {} } },
      { id: 'neutral', op: 'core.crm.deal.update', args: {} },
      // A vendor-neutral read never asks, and a delete always does: neither is named.
      { id: 'neutral_read', op: 'core.crm.deal.search', args: {} },
      { id: 'neutral_delete', op: 'core.crm.deal.delete', args: {} },
      { id: 'missing_pack', op: 'recued-core.other-pack.thing.write', args: {} },
      installed('save', 'daily_metric.batch'),
    ]), { manifestOf, packs: PACKS });
    // One step that names nothing leaves the others named.
    expect(Object.fromEntries(ops)).toEqual({ save: OP, neutral: 'core.crm.deal.update' });
  });

  it('finds the steps that ask an AI, counting what it cannot resolve as one', () => {
    expect(recipeAiSteps(recipeOf([installed('save', 'daily_metric.batch'), { id: 'total', transform: 'count', array: [] }]),
      { manifestOf, packs: PACKS })).toEqual([]);
    expect(recipeAiSteps(recipeOf([
      { id: 'summary', op: 'core.ai.summarize', args: { data: 'x' } },
      { id: 'legacy', ingredient: 'ai-prompt', input: {} },
      { id: 'pack_ai', ingredient: 'summarize-pack', input: {} },
      { id: 'decided', ingredient: '{{config.ingredient}}', input: {} },
      { id: 'missing_pack', op: 'recued-core.other-pack.thing.write', args: {} },
      installed('save', 'daily_metric.batch'),
    ]), { manifestOf, packs: PACKS })).toEqual(['summary', 'legacy', 'pack_ai', 'decided', 'missing_pack']);
  });

  it('pre-approves a call as its step\'s own op only when the call is that op', () => {
    const ops = new Map([['save', OP], ['act', 'dom-click']]);
    expect(preapprovableOp(ops, { slug: CATALOG, operation_id: OP, step_id: 'save', risk_tier: 'write' })).toBe(OP);
    expect(preapprovableOp(ops, { slug: 'dom-click', step_id: 'act', risk_tier: 'write' })).toBe('dom-click');
    for (const call of [
      { slug: CATALOG, operation_id: SEARCH, step_id: 'save' },
      { slug: CATALOG, step_id: 'save' },
      { slug: 'dom-write', step_id: 'act' },
      { slug: CATALOG, operation_id: OP },
      { slug: CATALOG, operation_id: OP, step_id: 'other' },
    ]) expect(preapprovableOp(ops, { ...call, risk_tier: 'write' }), JSON.stringify(call)).toBeUndefined();
  });
});

describe('D-341 slice B1 — the host\'s answer to a gate, for one run', () => {
  const admission = (stepOps = new Map([['save', OP], ['read', SEARCH]])) => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
    const read = vi.fn(() => stepOps);
    const hooks = createTriggerPreapprovalAdmission({
      store, run: { trigger: WEBHOOK, door_contract_id: 'door-1' }, recipe_id: 'r', recipe_sha256: 'a'.repeat(64),
      run_id: 'run-1', stepOps: read, auditLog, now: () => 7,
    });
    return { store, auditLog, read, hooks };
  };

  it('admits a call that is its step\'s own op, spending a use and auditing it', async () => {
    const { store, auditLog, read, hooks } = admission();
    const row = store.grant(grantInput({ max_per_run: 2 }));
    expect(hooks.admit({ slug: CATALOG, operation_id: OP, step_id: 'save', risk_tier: 'write' })).toBe(row.id);
    expect(store.runWrites('run-1')).toEqual([{ preapproval_id: row.id, op: OP, uses: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const used = (await auditLog.listActivities()).filter((a) => a.action === 'trigger_preapproval_used');
    expect(used.map((a) => [a.target, a.timestamp])).toEqual([[row.id, 7]]);
    expect(JSON.parse(used[0]!.detail!)).toEqual({ run_id: 'run-1', recipe_id: 'r', step_id: 'save', op: OP, trigger: WEBHOOK,
      uses: 1 });
    // The steps' ops are read once for the run.
    hooks.admit({ slug: CATALOG, operation_id: OP, step_id: 'save', risk_tier: 'write' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses a call that is not its step\'s own op, even one a pre-approval names', () => {
    const { store, hooks } = admission();
    store.grant(grantInput({ writes: [OP, SEARCH], max_per_run: 5 }));
    for (const call of [
      // The step `read` dispatched the batch: not what that step calls.
      { slug: CATALOG, operation_id: OP, step_id: 'read' },
      { slug: CATALOG, operation_id: OP },
      { slug: CATALOG, operation_id: OP, step_id: 'unknown' },
    ]) expect(hooks.admit({ ...call, risk_tier: 'write' }), JSON.stringify(call)).toBeNull();
    expect(store.runWrites('run-1')).toEqual([]);
  });

  it('admits nothing the store has no use for', () => {
    const { hooks } = admission();
    expect(hooks.admit({ slug: CATALOG, operation_id: OP, step_id: 'save', risk_tier: 'write' })).toBeNull();
  });
});

const recipeOf = (steps: Array<Record<string, unknown>>, recipe_id = 'save-readings'): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 60,
  metadata: { name: 'Save readings', description: 'Saves readings.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps, output: { sidebar: [] },
} as unknown as RecipeDefinition);

const rpcFixture = () => {
  const recipeStore = createRecipeStore('/nonexistent');
  // As installed: lowered, its steps naming the catalog and its operation, not the authored op.
  recipeStore.register(recipeOf([installed('read', 'daily_metric.search'), installed('save', 'daily_metric.batch')]));
  const consumers = new Map<string, Array<{ snapshot: {
    bindings: Array<{ binding_id: string; ingress_id: string }>;
    triggers: Array<{ binding_id: string; recipe_id: string; contract_id: string | null }>;
  } }>>([['save-readings', [{ snapshot: {
    bindings: [{ binding_id: 'b1', ingress_id: 'whi_1' }],
    triggers: [{ binding_id: 'b1', recipe_id: 'save-readings', contract_id: 'door-1' }],
  } }]]]);
  const schedules = new Map([['sch_1', { recipe_id: 'save-readings' }], ['sch_other', { recipe_id: 'other' }]]);
  const triggers = new Map([['trg_1', { recipe_id: 'save-readings' }]]);
  // B4 — a form paired with the recipe through its door; a reception endpoint's id may start with `-`.
  const pairs = new Map<string, { recipe_id: string; contract_id: string | null }>([
    ['-ep_1', { recipe_id: 'save-readings', contract_id: 'door-r1' }], ['ep_other', { recipe_id: 'other', contract_id: 'door-o' }],
  ]);
  const store = createTriggerPreapprovalStore(new Database(':memory:'));
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  let at = Date.UTC(2026, 10, 8);
  const rpc = createTriggerPreapprovalRpcHandlers({
    store, recipeStore, auditLog, now: () => at, manifestOf, packs: () => PACKS,
    targets: createTriggerPreapprovalTargets({
      webhooks: { consumersOfRecipe: (id) => consumers.get(id) ?? [] },
      schedules: { get: (id) => schedules.get(id) ?? null },
      triggers: { get: (id) => triggers.get(id) ?? null },
      receptions: { pairOf: (id) => pairs.get(id) ?? null },
    }),
  });
  return { rpc, store, recipeStore, consumers, schedules, pairs, auditLog, advance: (ms: number) => { at += ms; } };
};

describe('D-341 slice B1 — the owner grants, lists and ends one', () => {
  it('pins the installed version, as a run of it hashes it, and a webhook\'s door', async () => {
    const { rpc, recipeStore } = rpcFixture();
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({
      trigger: WEBHOOK, recipe_id: 'save-readings', writes: [OP],
    });
    const recipe = recipeStore.get('save-readings')!;
    expect(preapproval.recipe_sha256)
      .toBe(createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(recipe))).digest('hex'));
    expect(triggerPreapprovalRecipeSha256(recipe)).toBe(preapproval.recipe_sha256);
    expect(preapproval).toMatchObject({
      trigger: WEBHOOK, door_contract_id: 'door-1', writes: [OP], max_per_run: 1, uses: 0,
      state: 'live', recipe_name: 'Save readings', ai_steps: [],
      // In the owner's words: the first sentence of what its operation says it does.
      write_labels: ['Save up to 100 daily readings in one transaction, all or none'],
      description: 'Save readings, when its webhook runs it, may do this without asking: save up to 100 daily readings in'
        + ' one transaction, all or none. Once a run, until you end it.',
    });
    // Ruling 10 — no end date, no use cap.
    expect(preapproval).not.toHaveProperty('expires_at');
    expect(preapproval).not.toHaveProperty('max_uses');
  });

  it('refuses a recipe not installed, a write its steps don\'t make, a trigger that doesn\'t start it, a door-less webhook', async () => {
    const { rpc, consumers } = rpcFixture();
    const grant = rpc['collection.contract.grantTriggerPreapproval'];
    await expect(grant({ trigger: WEBHOOK, recipe_id: 'gone', writes: [OP] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(grant({ trigger: WEBHOOK, recipe_id: 'save-readings', writes: [OP, 'recued-core.body-signals.daily_metric.delete'] }))
      .rejects.toThrow(/Save readings does not call recued-core\.body-signals\.daily_metric\.delete/u);
    for (const trigger of [
      { kind: 'webhook', ingress_id: 'whi_2' },
      { kind: 'schedule', schedule_id: 'sch_other' },
      { kind: 'schedule', schedule_id: 'sch_missing' },
      { kind: 'event_trigger', trigger_id: 'trg_missing' },
    ]) {
      await expect(grant({ trigger, recipe_id: 'save-readings', writes: [OP] }), JSON.stringify(trigger))
        .rejects.toThrow(/does not start Save readings/u);
    }
    consumers.get('save-readings')![0]!.snapshot.triggers[0]!.contract_id = null;
    await expect(grant({ trigger: WEBHOOK, recipe_id: 'save-readings', writes: [OP] }))
      .rejects.toThrow(/that webhook cannot run Save readings yet/u);
    for (const limit of [{ max_uses: 30 }, { ttl_ms: DAY }]) {
      await expect(grant({ trigger: WEBHOOK, recipe_id: 'save-readings', writes: [OP], ...limit } as never), JSON.stringify(limit))
        .rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/it lasts until you end it/u) });
    }
    // A write named by its authored form only where that is the gate's name for it: the catalog's slug is not.
    await expect(grant({ trigger: SCHEDULE, recipe_id: 'save-readings', writes: [CATALOG] }))
      .rejects.toThrow(/does not call records-/u);
    // A schedule and an event trigger that run it are granted, with no door.
    for (const trigger of [SCHEDULE, { kind: 'event_trigger', trigger_id: 'trg_1' } as const]) {
      const { preapproval } = await grant({ trigger, recipe_id: 'save-readings', writes: [OP] });
      expect(preapproval).toMatchObject({ trigger, state: 'live' });
      expect(preapproval.door_contract_id).toBeUndefined();
    }
  });

  it('grants one for a recipe that asks an AI, and says its AI decides what it writes (ruling 8)', async () => {
    const { rpc, recipeStore } = rpcFixture();
    const grant = rpc['collection.contract.grantTriggerPreapproval'];
    recipeStore.register(recipeOf([{ id: 'summary', op: 'core.ai.summarize', args: { data: 'x' } }, installed('save', 'daily_metric.batch')]));
    const { preapproval } = await grant({ trigger: SCHEDULE, recipe_id: 'save-readings', writes: [OP] });
    expect(preapproval).toMatchObject({ state: 'live', ai_steps: ['summary'] });
    expect(preapproval.description).toContain('all or none. Its AI decides what it writes. Once a run, until you end it.');
    // The list says so too.
    expect((await rpc['collection.contract.listTriggerPreapprovals']()).preapprovals[0]).toMatchObject({ ai_steps: ['summary'] });
    // And one still written with authored ops is granted as before, with no AI.
    recipeStore.register(recipeOf([{ id: 'save', op: OP, args: {} }]));
    expect((await grant({ trigger: SCHEDULE, recipe_id: 'save-readings', writes: [OP] })).preapproval)
      .toMatchObject({ state: 'live', ai_steps: [] });
  });

  it('lists each with why it covers nothing now, and ends one; each decision audited', async () => {
    const { rpc, store, recipeStore, consumers, schedules, auditLog, advance } = rpcFixture();
    const grant = rpc['collection.contract.grantTriggerPreapproval'];
    const webhook = (await grant({ trigger: WEBHOOK, recipe_id: 'save-readings', writes: [OP] })).preapproval;
    const schedule = (await grant({ trigger: SCHEDULE, recipe_id: 'save-readings', writes: [OP] })).preapproval;
    const EVENT = { kind: 'event_trigger', trigger_id: 'trg_1' } as const;
    const used = (await grant({ trigger: EVENT, recipe_id: 'save-readings', writes: [OP] })).preapproval;
    for (let run = 0; run < 120; run += 1) {
      store.use({ trigger: EVENT, recipe_id: 'save-readings', recipe_sha256: used.recipe_sha256, op: OP, run_id: `x${String(run)}` },
        Date.UTC(2026, 10, 8));
    }
    const state = async () => Object.fromEntries((await rpc['collection.contract.listTriggerPreapprovals']()).preapprovals
      .map((row) => [row.id, row.state]));
    // Used 120 times and a year on, each is still on: it has no end of its own (ruling 10).
    advance(365 * DAY);
    expect(await state()).toEqual({ [webhook.id]: 'live', [schedule.id]: 'live', [used.id]: 'live' });

    // The webhook's door minted again: that one no longer covers its runs.
    consumers.get('save-readings')![0]!.snapshot.triggers[0]!.contract_id = 'door-2';
    expect((await state())[webhook.id]).toBe('detached');
    consumers.get('save-readings')![0]!.snapshot.triggers[0]!.contract_id = 'door-1';
    expect((await state())[webhook.id]).toBe('live');
    // The schedule removed: detached too.
    const fresh = (await grant({ trigger: SCHEDULE, recipe_id: 'save-readings', writes: [OP] })).preapproval;
    schedules.delete('sch_1');
    expect((await state())[fresh.id]).toBe('detached');

    // The recipe changed: every one granted for it is outdated, whatever its trigger.
    recipeStore.register(recipeOf([installed('save', 'daily_metric.batch'), installed('again', 'daily_metric.batch')]));
    expect((await state())[webhook.id]).toBe('outdated');

    const ended = (await rpc['collection.contract.revokeTriggerPreapproval']({ id: webhook.id })).preapproval;
    expect(ended).toMatchObject({ id: webhook.id, state: 'revoked' });
    await expect(rpc['collection.contract.revokeTriggerPreapproval']({ id: 'tpa_missing' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(rpc['collection.contract.revokeTriggerPreapproval']({})).rejects.toMatchObject({ code: 'bad_request' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const activities = await auditLog.listActivities();
    expect(activities.filter((a) => a.action === 'trigger_preapproval_granted')).toHaveLength(4);
    expect(activities.filter((a) => a.action === 'trigger_preapproval_granted').every((a) => !/max_uses|expires_at/u.test(a.detail ?? '')))
      .toBe(true);
    expect(activities.filter((a) => a.action === 'trigger_preapproval_revoked').map((a) => a.target)).toEqual([webhook.id]);
    expect(JSON.parse(activities.find((a) => a.target === webhook.id && a.action === 'trigger_preapproval_granted')!.detail!))
      .toMatchObject({ trigger: WEBHOOK, door_contract_id: 'door-1', writes: [OP] });
  });

  it('answers not_configured without a store', async () => {
    const rpc = createTriggerPreapprovalRpcHandlers({ manifestOf });
    await expect(rpc['collection.contract.listTriggerPreapprovals']()).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('D-341 slice B4 — a reception form\'s pre-approval', () => {
  const FORM = { kind: 'reception', endpoint_id: '-ep_1' } as const;

  it('is granted for the form paired with the recipe, pinning the form\'s door, in the form\'s words', async () => {
    const { rpc } = rpcFixture();
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({ trigger: FORM, recipe_id: 'save-readings',
      writes: [OP] });
    expect(preapproval).toMatchObject({
      trigger: FORM, door_contract_id: 'door-r1', writes: [OP], state: 'live',
      description: 'Save readings, when its form runs it, may do this without asking: save up to 100 daily readings in one'
        + ' transaction, all or none. Once a run, until you end it.',
    });
  });

  it('is refused for a form paired with another recipe or none, and for a pairing with no door yet', async () => {
    const { rpc, pairs } = rpcFixture();
    const grant = rpc['collection.contract.grantTriggerPreapproval'];
    for (const trigger of [{ kind: 'reception', endpoint_id: 'ep_other' }, { kind: 'reception', endpoint_id: 'ep_missing' }]) {
      await expect(grant({ trigger, recipe_id: 'save-readings', writes: [OP] }), JSON.stringify(trigger))
        .rejects.toThrow(/that form does not start Save readings/u);
    }
    pairs.set('-ep_1', { recipe_id: 'save-readings', contract_id: null });
    await expect(grant({ trigger: FORM, recipe_id: 'save-readings', writes: [OP] }))
      .rejects.toThrow(/that form cannot run Save readings yet; pair it with the recipe again/u);
  });

  it('stops covering when the form is paired again through a new door, or unpaired', async () => {
    const { rpc, pairs } = rpcFixture();
    const { preapproval } = await rpc['collection.contract.grantTriggerPreapproval']({ trigger: FORM, recipe_id: 'save-readings',
      writes: [OP] });
    const state = async () => (await rpc['collection.contract.listTriggerPreapprovals']()).preapprovals
      .find((row) => row.id === preapproval.id)!.state;
    pairs.set('-ep_1', { recipe_id: 'save-readings', contract_id: 'door-r2' });
    expect(await state()).toBe('detached');
    pairs.delete('-ep_1');
    expect(await state()).toBe('detached');
    pairs.set('-ep_1', { recipe_id: 'save-readings', contract_id: 'door-r1' });
    expect(await state()).toBe('live');
  });

  it('an answer from its ask is refused once the form\'s door changed since it asked', async () => {
    const { store, recipeStore } = rpcFixture();
    let door: string | null = 'door-r1';
    const granter = createTriggerPreapprovalGranter({ store, recipeStore, manifestOf, packs: () => PACKS,
      targets: createTriggerPreapprovalTargets({ receptions: { pairOf: () => ({ recipe_id: 'save-readings', contract_id: door }) } }) });
    const sha = triggerPreapprovalRecipeSha256(recipeStore.get('save-readings')!);
    const offer = { trigger: FORM, door_contract_id: 'door-r1', recipe_id: 'save-readings', recipe_sha256: sha, op: OP };
    door = 'door-r2';
    await expect(granter.grantOffer(offer, APPROVAL)).rejects.toThrow(/that form's door changed since it asked/u);
    door = null;
    await expect(granter.grantOffer(offer, APPROVAL)).rejects.toThrow(/that form cannot run Save readings yet/u);
    expect(store.list()).toEqual([]);
    door = 'door-r1';
    expect(await granter.grantOffer(offer, APPROVAL)).toMatchObject({ trigger: FORM, door_contract_id: 'door-r1', state: 'live' });
  });
});

// ── A held write of a triggered run, through `handleExecute` ────────────────────────────────────
// The owner's default admission (no grants): a scheduled or triggered run sits at `read`, so its
// browser click is held at the commit gateway. A click is the vehicle because the kernel carries it
// whole; a pack's op holds at the catalog gate instead (the engine's test, and the live drive).

const CLICK = { op: 'core.dom.click', args: { target: '*://example.test/*', page: '7:ABCDEF0123', ref: 'e12' } };
const scheduled = (schedule_id = 'sch_1') => ({
  channel: 'schedule', actor: 'system', schedule_id, cron: '0 7 * * *', source_recipe: 'click-daily',
}) as ExecutionSource;

const clicked = (): DispatchOutcome => ({
  kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.3', idempotency_key_seen: false, status: 'ok',
    outputs: { page: '7:ABCDEF0123', url: 'https://example.test/', title: 'Example' } } as BridgeResult,
});

const executeFixture = (steps: Array<Record<string, unknown>>, extra: Partial<ExecuteHandlerDeps> = {}) => {
  const recipe = recipeOf(steps, 'click-daily');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  const contractStore = createContractStore(new Database(':memory:'));
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const triggerPreapprovals = createTriggerPreapprovalStore(new Database(':memory:'));
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const sent = vi.fn<BridgeDispatcher['dispatch']>(async () => clicked());
  // The clicks the Bridge was asked for: a held click's element is read (`describe`) before it is
  // asked, and the page is read again (`reread`) after a click, neither of which is the click.
  const clicks = () => sent.mock.calls.map(([request]) => request).filter((request) => request.action === 'click')
    .map((request) => request.args.ref);
  const asks: string[] = [];
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    executorConfig: {
      manifests,
      bridgeDispatcherRef: () => ({ dispatch: sent, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    },
    baseVault: {},
    instanceId: 'd-341-b1',
    commitStore,
    checkpointStore: { write: vi.fn(async (_cp: Checkpoint) => undefined) } as unknown as ExecuteHandlerDeps['checkpointStore'],
    auditLog,
    triggerPreapprovals,
    preflightNotifier: {
      ask: vi.fn(async (message: { text: string }) => { asks.push(message.text); return { ask_id: `ask-${String(asks.length)}` }; }),
      registerAskHandler: vi.fn(),
      notify: vi.fn(async () => undefined),
    },
    ...extra,
  };
  const grant = (trigger: TriggerPreapprovalTrigger, overrides: { writes?: string[]; max_per_run?: number } = {}) =>
    triggerPreapprovals.grant({
      trigger, recipe_id: recipe.recipe_id, recipe_sha256: triggerPreapprovalRecipeSha256(recipe),
      writes: overrides.writes ?? ['dom-click'], max_per_run: overrides.max_per_run ?? 1, now: Date.now(),
    });
  const run = (execution_source: ExecutionSource, trigger_source = 'schedule') => handleExecute(deps, {
    recipe_id: recipe.recipe_id, trigger_source, execution_source,
  } as Parameters<typeof handleExecute>[1]);
  return { recipe, recipeStore, triggerPreapprovals, commitStore, auditLog, clicks, asks, grant, run };
};

describe('D-341 slice B1 — a triggered run\'s held write goes through under its pre-approval', () => {
  it('without one the scheduled run\'s click asks; with one it runs, its commit names it, and the use is audited', async () => {
    const asked = executeFixture([{ id: 'act', ...CLICK }]);
    expect((await asked.run(scheduled())).awaiting_approval).toBe(true);
    expect(asked.clicks()).toEqual([]);

    const f = executeFixture([{ id: 'act', ...CLICK }]);
    const row = f.grant(SCHEDULE);
    const response = await f.run(scheduled());
    expect(response.awaiting_approval, JSON.stringify(response.errors)).toBeFalsy();
    expect(f.asks).toEqual([]);
    expect(f.clicks()).toEqual(['e12']);
    expect(f.triggerPreapprovals.get(row.id)?.uses).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const used = (await f.auditLog.listActivities()).filter((a) => a.action === 'trigger_preapproval_used');
    expect(used.map((a) => a.target)).toEqual([row.id]);
    const detail = JSON.parse(used[0]!.detail!) as { run_id: string };
    expect(detail).toMatchObject({ recipe_id: 'click-daily', step_id: 'act', op: 'dom-click', trigger: SCHEDULE, uses: 1 });
    // The use is the run's, its outcome lists it, and the run's commit for the click names it.
    expect(f.triggerPreapprovals.runUses(row.id, detail.run_id)).toBe(1);
    expect(f.triggerPreapprovals.runWrites(detail.run_id)).toEqual([{ preapproval_id: row.id, op: 'dom-click', uses: 1 }]);
    const commits = await f.commitStore.listByRun(detail.run_id);
    expect(commits.map((commit) => [commit.tool, commit.trigger_preapproval])).toEqual([[expect.any(String), { id: row.id }]]);
  });

  it('⛔ never lets a browser batch put the owner\'s files into a page, which is always asked (D-335 AQ)', async () => {
    const act = (steps: Array<Record<string, unknown>>) => ({ id: 'act', op: 'core.dom.act',
      args: { target: '*://example.test/*', page: '7:ABCDEF0123', steps } });
    const upload = act([{ do: 'upload', ref: 'e7', file: `file:${'b'.repeat(32)}` }]);
    // It is an upload, as the gates read one: the check below is not vacuous.
    expect(browserActCallUploads(upload.args)).toBe(true);
    const uploads = executeFixture([upload]);
    const row = uploads.grant(SCHEDULE, { writes: ['dom-act'] });
    expect((await uploads.run(scheduled())).awaiting_approval).toBe(true);
    expect(uploads.triggerPreapprovals.get(row.id)?.uses).toBe(0);
    // The same pre-approval lets a batch that only clicks through.
    const clicks = executeFixture([act([{ do: 'click', ref: 'e12' }])]);
    const kept = clicks.grant(SCHEDULE, { writes: ['dom-act'] });
    expect((await clicks.run(scheduled())).awaiting_approval).toBeFalsy();
    expect(clicks.triggerPreapprovals.get(kept.id)?.uses).toBe(1);
  });

  it('⛔ never lets a pre-approval stand in for the review a proposed commitment always gets (D-192 F1)', async () => {
    const PROPOSE = { id: 'propose', op: 'core.work-entity.commitment.propose',
      args: { direction: 'outbound', statement: 'Send Dana the deck by Friday', idempotency_key: 'deck-1' } };
    // Held by its run's ceiling, its ask offers no "Always allow for this schedule": the ask is its review.
    const asked = executeFixture([PROPOSE]);
    expect((await asked.run(scheduled())).awaiting_approval).toBe(true);
    expect(asked.asks).toHaveLength(1);
    expect(asked.asks[0]).not.toContain('Always allow');
    // One granted on the trigger's page all the same admits nothing.
    const f = executeFixture([PROPOSE]);
    const row = f.grant(SCHEDULE, { writes: ['commitment-propose'] });
    expect((await f.run(scheduled())).awaiting_approval).toBe(true);
    expect(f.triggerPreapprovals.get(row.id)?.uses).toBe(0);
  });

  it('covers an event trigger\'s run by that trigger\'s own', async () => {
    const f = executeFixture([{ id: 'act', ...CLICK }]);
    f.grant({ kind: 'event_trigger', trigger_id: 'trg_1' });
    const response = await f.run({
      channel: 'reactive', actor: 'system', event_kind: 'mail_fact.parcel', source_recipe: 'click-daily', trigger_id: 'trg_1',
    } as ExecutionSource, 'event_trigger');
    expect(response.awaiting_approval, JSON.stringify(response.errors)).toBeFalsy();
    expect(f.clicks()).toEqual(['e12']);
  });

  it('covers an armed auto-run\'s tick by its own timer\'s, not another dish\'s (B1b)', async () => {
    const tick = (dish_id: string) => ({
      channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'click-daily', dish_id,
    } as ExecutionSource);
    const f = executeFixture([{ id: 'act', ...CLICK }]);
    const row = f.grant({ kind: 'auto_run', dish_id: 'dsh_1' });
    expect((await f.run(tick('dsh_2'), 'auto_run')).awaiting_approval).toBe(true);
    expect(f.clicks()).toEqual([]);
    const response = await f.run(tick('dsh_1'), 'auto_run');
    expect(response.awaiting_approval, JSON.stringify(response.errors)).toBeFalsy();
    expect(f.clicks()).toEqual(['e12']);
    expect(f.triggerPreapprovals.get(row.id)?.uses).toBe(1);
  });

  it('a hold that offers its trigger\'s pre-approval asks on its own, not in a batch, so it can offer it (found live, B1b)', async () => {
    const registerHold = vi.fn(async () => ({ kind: 'registered' as const, ask_id: 'batch-ask', approval_ref: 'ref' }));
    const batched = { batchApprovals: { registerHold } as unknown as ExecuteHandlerDeps['batchApprovals'] };
    const tick = (dish_id?: string) => ({ channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'click-daily',
      ...(dish_id !== undefined ? { dish_id } : {}) } as ExecutionSource);
    const f = executeFixture([{ id: 'act', ...CLICK }], batched);
    expect((await f.run(tick('dsh_1'), 'auto_run')).awaiting_approval).toBe(true);
    expect(registerHold).not.toHaveBeenCalled();
    expect(f.asks).toHaveLength(1);
    expect(f.asks[0]).toContain('“Always allow for this auto-run” stops asking about what');
    // A hold no trigger's run made still joins the batch, as before.
    const g = executeFixture([{ id: 'act', ...CLICK }], batched);
    expect((await g.run(tick(), 'auto_run')).awaiting_approval).toBe(true);
    expect(registerHold).toHaveBeenCalledTimes(1);
    expect(g.asks).toEqual([]);
  });

  it('asks for another schedule\'s run, the owner\'s own run, a changed recipe, and a write past the run\'s cap', async () => {
    const other = executeFixture([{ id: 'act', ...CLICK }]);
    other.grant(SCHEDULE);
    expect((await other.run(scheduled('sch_2'))).awaiting_approval).toBe(true);

    const chat = executeFixture([{ id: 'act', ...CLICK }]);
    chat.grant(SCHEDULE);
    expect((await chat.run({ channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 't' } as ExecutionSource)).awaiting_approval).toBe(true);

    const changed = executeFixture([{ id: 'act', ...CLICK }]);
    changed.grant(SCHEDULE);
    changed.recipeStore.register(recipeOf([{ id: 'act', ...CLICK, args: { ...CLICK.args, ref: 'e99' } }], 'click-daily'));
    expect((await changed.run(scheduled())).awaiting_approval).toBe(true);

    const twice = executeFixture([{ id: 'act', ...CLICK }, { id: 'again', ...CLICK, args: { ...CLICK.args, ref: 'e13' } }]);
    const row = twice.grant(SCHEDULE);
    const response = await twice.run(scheduled());
    expect(response.awaiting_approval).toBe(true);
    expect(twice.clicks()).toEqual(['e12']);
    expect(twice.triggerPreapprovals.get(row.id)?.uses).toBe(1);

    const neither = executeFixture([{ id: 'act', ...CLICK }]);
    neither.grant(SCHEDULE, { writes: ['dom-write'] });
    expect((await neither.run(scheduled())).awaiting_approval).toBe(true);
  });
});

// ── A held Records write of a scheduled run, at the catalog gate ─────────────────────────────────
// A pack's own op holds at the catalog gate, not the commit gateway: the path the Apple Health
// intake's write takes. A small Records catalog, its ops ordinary writes (the shared fixture's are
// all `approval: 'always'`, which no pre-approval covers).
const NOTES = { publisher: 'core', pack_slug: 'b1-notes' };
const noteBinding = (action: 'create' | 'update'): RecordsExecutionBinding => ({ kind: 'core.records', action, entity: 'note',
  owner: NOTES, pack_version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64), operation_digest: action });
const NOTE_BINDINGS = { create: noteBinding('create'), update: noteBinding('update') };
const NOTE_SCHEMA: RecordsSchemaSnapshot = { decimal_scale: 4, entities: { note: { kind: 'note', fields: [
  { key: 'id', kind: 'id', slot: 'pk', required: true }, { key: 'title', kind: 'string', slot: 's1', required: true },
] } } };
const UPDATE = 'core.b1-notes.note.update';
const notesManifest = {
  slug: 'b1-notes', name: 'Notes', description: 'Notes', author: 'core', kind: 'storage', version: 1, category: 'data',
  risk_tier: 'read', input: { operation: null, args: null }, output: { result: 'result' },
  operations: {
    create: { operation_id: 'core.b1-notes.note.create', risk_tier: 'write', groups: ['notes.write'] },
    update: { operation_id: UPDATE, risk_tier: 'write', groups: ['notes.write'] },
  },
  operation_groups: { 'notes.write': { group_id: 'notes.write', operations: ['create', 'update'], risk_floor: 'write' } },
  surfaces: { records: { executes: NOTE_BINDINGS, schema: NOTE_SCHEMA } },
} as unknown as IngredientManifest;

const recordsFixture = () => {
  const db = new Database(':memory:');
  const records = createRecordsStore(db, { now: () => Date.now() });
  records.installNamespace({ owner: NOTES, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'b1', schema: NOTE_SCHEMA, bindings: NOTE_BINDINGS });
  records.execute({ binding: NOTE_BINDINGS.create, principal: 'owner', args: { id: 'n1', values: { title: 'Draft' } } });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(notesManifest);
  const contractStore = createContractStore(db);
  contractStore.put('grant', ['b1-notes', 'b1-notes', 'b1-notes', 'notes.write'], { allowed: true });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const recipe = recipeOf([{ id: 'retitle', ingredient: 'b1-notes',
    input: { operation: 'update', args: { id: 'n1', expected_version: 1, expected_revision: 0, set: { title: 'Reviewed' } } } }], 'retitle-note');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const triggerPreapprovals = createTriggerPreapprovalStore(db);
  const asks: string[] = [];
  const deps: ExecuteHandlerDeps = {
    recipeStore, baseVault: {}, recordsStore: records, instanceId: 'd-341-b1-records',
    executorConfig: { manifests },
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    checkpointStore: { write: vi.fn(async (_cp: Checkpoint) => undefined) } as unknown as ExecuteHandlerDeps['checkpointStore'],
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    triggerPreapprovals,
    preflightNotifier: {
      ask: vi.fn(async (message: { text: string }) => { asks.push(message.text); return { ask_id: `ask-${String(asks.length)}` }; }),
      registerAskHandler: vi.fn(),
      notify: vi.fn(async () => undefined),
    },
  };
  const title = () => records.ownerSearch({ owner: NOTES, entity: 'note', filters: {}, limit: 5 }).records
    .find((row) => row.id === 'n1')?.title;
  const run = () => handleExecute(deps, { recipe_id: recipe.recipe_id, trigger_source: 'schedule', execution_source: scheduled() } as
    Parameters<typeof handleExecute>[1]);
  const grant = (writes = [UPDATE]) => triggerPreapprovals.grant({ trigger: SCHEDULE, recipe_id: recipe.recipe_id,
    recipe_sha256: triggerPreapprovalRecipeSha256(recipe), writes, max_per_run: 1, now: Date.now() });
  return { run, grant, title, asks, triggerPreapprovals };
};

describe('D-341 slice B1 — a scheduled run\'s Records write goes through under its pre-approval, at the catalog gate', () => {
  it('without one it asks and saves nothing; with one it saves, without asking, spending one use', async () => {
    const asked = recordsFixture();
    const held = await asked.run();
    expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
    expect(asked.title()).toBe('Draft');

    const f = recordsFixture();
    const row = f.grant();
    const response = await f.run();
    expect(response.awaiting_approval, JSON.stringify(response.errors)).toBeFalsy();
    expect(response.success, JSON.stringify(response.errors)).toBe(true);
    expect(f.asks).toEqual([]);
    expect(f.title()).toBe('Reviewed');
    expect(f.triggerPreapprovals.get(row.id)?.uses).toBe(1);
  });

  it('asks for a write the pre-approval doesn\'t name', async () => {
    const f = recordsFixture();
    f.grant(['core.b1-notes.note.create']);
    expect((await f.run()).awaiting_approval).toBe(true);
    expect(f.title()).toBe('Draft');
  });
});

// ── D-341 slice B2 — granted from the ask ────────────────────────────────────────────────────────
const CREATE = 'core.b1-notes.note.create';

describe('D-341 slice B2 — what a hold offers to grant', () => {
  const recipe = recipeOf([installed('read', 'daily_metric.search'), installed('save', 'daily_metric.batch')]);
  const run = { trigger: WEBHOOK, door_contract_id: 'door-1' };
  const ceiling = { pre_lift_approval: 'ask' };
  const offerFor = (held: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => triggerPreapprovalOfferFor({
    run, recipe, recipe_sha256: 'a'.repeat(64),
    held: { gated_step_id: 'save', slug: CATALOG, operation_id: OP, risk_tier: 'write', provenance: ceiling, single: true, ...held },
    deps: { manifestOf, packs: PACKS }, ...over,
  } as Parameters<typeof triggerPreapprovalOfferFor>[0]);

  it('offers the held step\'s own op, for the run\'s trigger, door and recipe version', () => {
    expect(offerFor()).toEqual({ trigger: WEBHOOK, door_contract_id: 'door-1', recipe_id: 'save-readings',
      recipe_sha256: 'a'.repeat(64), op: OP });
    // B4 — a form's run, through its door.
    const form = { kind: 'reception', endpoint_id: '-ep_1' } as const;
    expect(offerFor({}, { run: { trigger: form, door_contract_id: 'door-r1' } })).toEqual({ trigger: form,
      door_contract_id: 'door-r1', recipe_id: 'save-readings', recipe_sha256: 'a'.repeat(64), op: OP });
  });

  it('offers nothing a pre-approval could not admit', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['no trigger', {}, { run: undefined }],
      ['a webhook run without its door', {}, { run: { trigger: WEBHOOK } }],
      ['a form\'s run without its door', {}, { run: { trigger: { kind: 'reception', endpoint_id: '-ep_1' } } }],
      ['a foreach cover', { single: false }, {}],
      ['destructive', { risk_tier: 'destructive' }, {}],
      ['a review lift', { provenance: { pre_lift_approval: 'never', lift_reason: 'review_send' } }, {}],
      ['the owner\'s always', { provenance: { pre_lift_approval: 'always' } }, {}],
      ['no provenance', { provenance: undefined }, {}],
      ['a call that is not its step\'s op', { operation_id: SEARCH }, {}],
      ['an unknown step', { gated_step_id: 'other' }, {}],
    ];
    for (const [name, held, over] of cases) expect(offerFor(held, over), name).toBeUndefined();
  });

  it('offers it for a recipe that asks an AI too, marked so the ask says its AI decides (ruling 8)', () => {
    expect(offerFor({}, { recipe: recipeOf([{ id: 'sum', op: 'core.ai.summarize', args: {} }, installed('save', 'daily_metric.batch')]) }))
      .toEqual({ trigger: WEBHOOK, door_contract_id: 'door-1', recipe_id: 'save-readings', recipe_sha256: 'a'.repeat(64), op: OP,
        asks_ai: true });
  });

  it('names each write in the owner\'s words: the first sentence of what its operation does', () => {
    expect(Object.fromEntries(recipeStepOpLabels(recipe, { manifestOf, packs: PACKS }))).toEqual({
      [SEARCH]: 'Page a Body\'s daily readings',
      [OP]: 'Save up to 100 daily readings in one transaction, all or none',
    });
    // A step whose operation says nothing is named by its op.
    const bare = { ...catalogManifest, operations: { 'daily_metric.batch': { operation_id: OP, risk_tier: 'write' } } } as unknown as IngredientManifest;
    expect(Object.fromEntries(recipeStepOpLabels(recipeOf([installed('save', 'daily_metric.batch')]),
      { manifestOf: () => bare }))).toEqual({ [OP]: OP });
  });
});

describe('D-341 slice B2 — an answer grants what its hold offered', () => {
  const offer = (over: Record<string, unknown> = {}) => ({
    trigger: WEBHOOK, door_contract_id: 'door-1', recipe_id: 'save-readings', op: OP, ...over,
  });

  it('grants it for the whole recipe (D-402 ruling 10), audited as from an ask, and grants it once however often it is told', async () => {
    const { store, recipeStore, auditLog } = rpcFixture();
    const granter = createTriggerPreapprovalGranter({ store, recipeStore, manifestOf, packs: () => PACKS, auditLog,
      targets: createTriggerPreapprovalTargets({ webhooks: { consumersOfRecipe: () => [{ snapshot: {
        bindings: [{ binding_id: 'b1', ingress_id: 'whi_1' }], triggers: [{ binding_id: 'b1', recipe_id: 'save-readings', contract_id: 'door-1' }],
      } }] } }) });
    const sha = triggerPreapprovalRecipeSha256(recipeStore.get('save-readings')!);
    const granted = await granter.grantOffer(offer({ recipe_sha256: sha }) as never, APPROVAL);
    expect(granted).toMatchObject({ trigger: WEBHOOK, door_contract_id: 'door-1', writes: ['*'], max_per_run: 0, state: 'live' });
    expect(granted).not.toHaveProperty('expires_at');
    expect((await granter.grantOffer(offer({ recipe_sha256: sha }) as never, APPROVAL)).id).toBe(granted.id);
    expect(store.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const audited = (await auditLog.listActivities()).filter((a) => a.action === 'trigger_preapproval_granted');
    expect(audited.map((a) => JSON.parse(a.detail!).via)).toEqual(['ask']);
  });

  it('refuses one whose recipe or webhook door changed since it asked', async () => {
    const { store, recipeStore } = rpcFixture();
    let door = 'door-1';
    const granter = createTriggerPreapprovalGranter({ store, recipeStore, manifestOf, packs: () => PACKS,
      targets: createTriggerPreapprovalTargets({ webhooks: { consumersOfRecipe: () => [{ snapshot: {
        bindings: [{ binding_id: 'b1', ingress_id: 'whi_1' }], triggers: [{ binding_id: 'b1', recipe_id: 'save-readings', contract_id: door }],
      } }] } }) });
    const sha = triggerPreapprovalRecipeSha256(recipeStore.get('save-readings')!);
    await expect(granter.grantOffer(offer({ recipe_sha256: 'b'.repeat(64) }) as never, APPROVAL)).rejects.toThrow(/changed since it asked/u);
    door = 'door-2';
    await expect(granter.grantOffer(offer({ recipe_sha256: sha }) as never, APPROVAL)).rejects.toThrow(/door changed since it asked/u);
    expect(store.list()).toEqual([]);
  });
});

/** A scheduled run of a Records write, held and asked through the real notification block and
 *  answered through the real resumer, as a server composes them. */
const askFixture = (opts: {
  /** B6 — the prompt service a scheduled prompt's grant reads: its title and its text's version. */
  readonly prompts?: { version(schedule_id: string): Promise<{ title: string; prompt_sha256: string } | null> };
} = {}) => {
  const db = new Database(':memory:');
  const records = createRecordsStore(db, { now: () => Date.now() });
  records.installNamespace({ owner: NOTES, version: 1, storage_schema_hash: 'a'.repeat(64), declaration_hash: 'b'.repeat(64),
    artifact_digest: 'b2', schema: NOTE_SCHEMA, bindings: NOTE_BINDINGS });
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(notesManifest);
  const contractStore = createContractStore(db);
  contractStore.put('grant', ['b1-notes', 'b1-notes', 'b1-notes', 'notes.write'], { allowed: true });
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  // Each run adds the note its context names.
  const recipe = recipeOf([{ id: 'add', ingredient: 'b1-notes',
    input: { operation: 'create', args: { id: '{{context.note_id}}', values: { title: 'Morning note' } } } }], 'add-note');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const triggerPreapprovals = createTriggerPreapprovalStore(db);
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
  const granter = createTriggerPreapprovalGranter({ store: triggerPreapprovals, recipeStore, auditLog,
    manifestOf: (slug) => manifests.get(slug),
    ...(opts.prompts !== undefined ? { prompts: opts.prompts } : {}),
    targets: createTriggerPreapprovalTargets({ schedules: { get: (id) => (id === 'sch_1' ? { recipe_id: 'add-note' } : null) },
      // B1b — the dish dsh_1's timer runs it.
      timers: { recipeOf: (dish_id) => (dish_id === 'dsh_1' ? 'add-note' : undefined) } }) });
  const deps = {
    recipeStore, baseVault: {}, recordsStore: records, instanceId: 'd-341-b2',
    executorConfig: { manifests },
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    checkpointStore, auditLog, preflightNotifier: block,
    triggerPreapprovals, triggerPreapprovalGranter: granter,
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, { checkpointStore, resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }) });
  const notes = () => records.ownerSearch({ owner: NOTES, entity: 'note', filters: {}, limit: 20 }).records.map((row) => row.id).sort();
  const runAs = (execution_source: ExecutionSource, note_id: string, trigger_source = 'schedule') => handleExecute(deps, {
    recipe_id: 'add-note', trigger_source, execution_source, context: { note_id } } as Parameters<typeof handleExecute>[1]);
  const run = (note_id: string) => runAs(scheduled(), note_id);
  const open = () => askStore.listByStatus('open');
  return { recipe, run, runAs, notes, open, block, rows, triggerPreapprovals, auditLog, deps, recipeStore, granter };
};

describe('D-341 slice B2 — "Always allow for this schedule" from its ask', () => {
  it('the held write saves, the schedule\'s pre-approval is granted, and its next run saves without asking', async () => {
    const f = askFixture();
    const held = await f.run('n1');
    expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
    const [ask] = await f.open();
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', 'Always allow for this schedule', 'Deny']);
    expect([...f.rows.values()][0]!.preflight_context?.trigger_preapproval).toEqual({
      trigger: SCHEDULE, recipe_id: 'add-note', recipe_sha256: triggerPreapprovalRecipeSha256(f.recipe), op: CREATE,
    });

    await f.block.submitAnswer({ ask_id: ask!.ask_id, option: 'allow_trigger', via: 'ui' });
    expect(f.notes()).toEqual(['n1']);
    const [row] = f.triggerPreapprovals.list();
    // D-402 ruling 10 — every write of the version, with no count.
    expect(row).toMatchObject({ trigger: SCHEDULE, recipe_id: 'add-note', writes: ['*'], max_per_run: 0, uses: 0 });

    const next = await f.run('n2');
    expect(next.awaiting_approval, JSON.stringify(next.errors)).toBeFalsy();
    expect(await f.open()).toEqual([]);
    expect(f.notes()).toEqual(['n1', 'n2']);
    expect(f.triggerPreapprovals.get(row!.id)?.uses).toBe(1);
  });

  it('an auto-run\'s tick offers "Always allow for this auto-run"; answered, its next tick saves without asking (B1b)', async () => {
    const f = askFixture();
    const tick = (dish_id: string) => ({
      channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'add-note', dish_id,
    } as ExecutionSource);
    const held = await f.runAs(tick('dsh_1'), 'n1', 'auto_run');
    expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
    const [ask] = await f.open();
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', 'Always allow for this auto-run', 'Deny']);
    expect(ask!.message.text).toContain('stops asking about what "Save readings" writes when it runs on its own, until you end it on the auto-run\'s page');
    await f.block.submitAnswer({ ask_id: ask!.ask_id, option: 'allow_trigger', via: 'ui' });
    expect(f.notes()).toEqual(['n1']);
    const [row] = f.triggerPreapprovals.list();
    expect(row).toMatchObject({ trigger: { kind: 'auto_run', dish_id: 'dsh_1' }, recipe_id: 'add-note', writes: ['*'] });

    const next = await f.runAs(tick('dsh_1'), 'n2', 'auto_run');
    expect(next.awaiting_approval, JSON.stringify(next.errors)).toBeFalsy();
    expect(f.notes()).toEqual(['n1', 'n2']);
    // Another dish's timer still asks.
    expect((await f.runAs(tick('dsh_2'), 'n3', 'auto_run')).awaiting_approval).toBe(true);
  });

  it('a plain approve saves the held write and grants nothing: the next run asks again', async () => {
    const f = askFixture();
    await f.run('n1');
    const [ask] = await f.open();
    await f.block.submitAnswer({ ask_id: ask!.ask_id, option: 'approve', via: 'ui' });
    expect(f.notes()).toEqual(['n1']);
    expect(f.triggerPreapprovals.list()).toEqual([]);
    expect((await f.run('n2')).awaiting_approval).toBe(true);
  });

  it('a held write no trigger\'s run made is offered none: an unstamped scheduled prompt\'s, an unattended run with no trigger', async () => {
    // (A stamped scheduled prompt's recipe is offered its own, B6: below.)
    for (const source of [
      { channel: 'schedule', actor: 'system', schedule_id: 'sch_1', cron: '0 7 * * *',
        prompt_schedule: { prompt_id: 'p', schedule_id: 'sch_1', cron: '0 7 * * *' }, chat_session_id: 'chat-1', turn_id: 't' },
      { channel: 'reactive', actor: 'system', event_kind: 'data.note.created', source_recipe: 'add-note' },
    ] as ExecutionSource[]) {
      const f = askFixture();
      const held = await f.runAs(source, 'n1', 'manual');
      expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
      const [ask] = await f.open();
      expect(ask!.options.map((option) => option.id), JSON.stringify(source)).not.toContain('allow_trigger');
      expect([...f.rows.values()][0]!.preflight_context?.trigger_preapproval).toBeUndefined();
    }
  });
});

// ── D-341 slice B6 (ruling 12) — a recipe a scheduled prompt starts ─────────────────────────────
// The owner: "Allow per recipe". A scheduled prompt's AI starts an installed recipe (`recipe.run` or its
// own tool), whose run carries the prompt's source: its held write offers "Always allow for this
// scheduled prompt", pinned to the prompt's text and the recipe's version, within the prompt run's
// cap; never for an inline recipe, a connection or a vault the AI chose.

describe('D-341 slice B6 — a recipe a scheduled prompt starts, pre-approved recipe by recipe', () => {
  const V1 = '1'.repeat(64);
  const V2 = '2'.repeat(64);
  const PROMPT = { kind: 'prompt_schedule', schedule_id: 'ps_1' } as const;
  /** A run the scheduled prompt's AI started, as the turn's source carries it into the recipe's run. */
  const prompted = (occurrence: string, version: string = V1, schedule_id = 'ps_1') => ({
    channel: 'schedule', actor: 'system', schedule_id, cron: '0 7 * * *', chat_session_id: 'scheduled-ps_1', turn_id: `t-${occurrence}`,
    prompt_schedule: { schedule_id, occurrence_id: occurrence, revision: 3, due_at: 1, cron: '0 7 * * *', prompt_sha256: version },
  }) as ExecutionSource;
  const fixture = () => {
    const prompt = { version: V1 };
    const f = askFixture({ prompts: { version: async (id: string) => (id === 'ps_1'
      ? { title: 'Morning notes', prompt_sha256: prompt.version } : null) } });
    /** The recipe as the AI's `recipe.run` sends it: by id, with what else it chose. */
    const start = (source: ExecutionSource, note_id: string, extra: Record<string, unknown> = {}) => handleExecute(f.deps, {
      recipe_id: 'add-note', trigger_source: 'manual', execution_source: source, context: { note_id }, ...extra,
    } as Parameters<typeof handleExecute>[1]);
    return { ...f, prompt, start };
  };

  it('its held write offers it; answered, the note saves and it is granted; the next run saves without asking', async () => {
    const f = fixture();
    const held = await f.start(prompted('ps_1:3:100'), 'n1');
    expect(held.awaiting_approval, JSON.stringify(held.errors)).toBe(true);
    const [ask] = await f.open();
    expect(ask!.options.map((option) => option.label)).toEqual(['Approve', 'Always allow for this scheduled prompt', 'Deny']);
    expect(ask!.message.text).toContain('“Always allow for this scheduled prompt” stops asking about this write when it runs'
      + ' "Save readings" on its schedule, once a run, until you end it on the scheduled prompt\'s page or under Contracts. Its AI'
      + ' decides what it writes. A change to its prompt or to the recipe asks you again.');
    const sha = triggerPreapprovalRecipeSha256(f.recipe);
    expect([...f.rows.values()][0]!.preflight_context?.trigger_preapproval).toEqual({
      trigger: PROMPT, recipe_id: 'add-note', recipe_sha256: sha, op: CREATE, asks_ai: true, prompt_sha256: V1,
    });

    await f.block.submitAnswer({ ask_id: ask!.ask_id, option: 'allow_trigger', via: 'ui' });
    expect(f.notes()).toEqual(['n1']);
    const [row] = f.triggerPreapprovals.list();
    expect(row).toMatchObject({ trigger: PROMPT, recipe_id: 'add-note', recipe_sha256: sha, prompt_sha256: V1, writes: [CREATE],
      max_per_run: 1, uses: 0 });

    // Its next occurrence starts it again: saved without asking, one use.
    const next = await f.start(prompted('ps_1:3:200'), 'n2');
    expect(next.awaiting_approval, JSON.stringify(next.errors)).toBeFalsy();
    expect(await f.open()).toEqual([]);
    expect(f.notes()).toEqual(['n1', 'n2']);
    expect(f.triggerPreapprovals.get(row!.id)?.uses).toBe(1);
    // Within the prompt run's cap: a second start in that occurrence asks.
    expect((await f.start(prompted('ps_1:3:200'), 'n3')).awaiting_approval).toBe(true);
  });

  it('covers nothing else: an edited prompt, another scheduled prompt, a changed recipe, an inline recipe, an AI\'s vault', async () => {
    const f = fixture();
    const sha = triggerPreapprovalRecipeSha256(f.recipe);
    await f.granter.grantOffer({ trigger: PROMPT, recipe_id: 'add-note', recipe_sha256: sha, op: CREATE, asks_ai: true, prompt_sha256: V1 }, APPROVAL);
    expect((await f.start(prompted('ps_1:4:100', V2), 'e1')).awaiting_approval).toBe(true);
    expect((await f.start(prompted('ps_2:1:100', V1, 'ps_2'), 'e2')).awaiting_approval).toBe(true);
    // What the AI chose itself: none is offered, and none is covered. (A connection it chose: in the
    // HubSpot world, `d-341-neutral-write-preapproval.test.ts`, where a run's choice is taken.)
    for (const extra of [{ vault: { token: 'x' } }]) {
      const before = f.rows.size;
      expect((await f.start(prompted('ps_1:3:500'), 'e3', extra)).awaiting_approval, JSON.stringify(extra)).toBe(true);
      expect([...f.rows.values()].at(-1)!.preflight_context?.trigger_preapproval, JSON.stringify(extra)).toBeUndefined();
      expect(f.rows.size).toBe(before + 1);
    }
    const inline = await handleExecute(f.deps, { recipe: f.recipe, trigger_source: 'manual', execution_source: prompted('ps_1:3:600'),
      context: { note_id: 'e4' } } as Parameters<typeof handleExecute>[1]);
    expect(inline.awaiting_approval).toBe(true);
    expect([...f.rows.values()].at(-1)!.preflight_context?.trigger_preapproval).toBeUndefined();
    // The recipe updated: its version is no longer the one granted.
    f.recipeStore.register({ ...f.recipe, metadata: { ...f.recipe.metadata, description: 'Saves readings, now twice.' } } as RecipeDefinition);
    expect((await f.start(prompted('ps_1:3:700'), 'e5')).awaiting_approval).toBe(true);
    expect(f.notes()).toEqual([]);
    expect(f.triggerPreapprovals.list()[0]).toMatchObject({ uses: 0 });
  });

  it('an answer once the prompt or the recipe changed grants nothing; the prompt\'s card lists one under its recipe', async () => {
    const f = fixture();
    const sha = triggerPreapprovalRecipeSha256(f.recipe);
    const offer = { trigger: PROMPT, recipe_id: 'add-note', recipe_sha256: sha, op: CREATE, asks_ai: true, prompt_sha256: V1 } as const;
    f.prompt.version = V2;
    await expect(f.granter.grantOffer(offer, APPROVAL)).rejects.toThrow(/the prompt of Morning notes changed since it asked/u);
    f.prompt.version = V1;
    await expect(f.granter.grantOffer({ ...offer, recipe_sha256: 'c'.repeat(64) }, APPROVAL)).rejects.toThrow(/Save readings changed since it asked/u);
    expect(f.triggerPreapprovals.list()).toEqual([]);
    const granted = await f.granter.grantOffer(offer, APPROVAL);
    expect(granted).toMatchObject({ state: 'live', recipe_name: 'Save readings', prompt_sha256: V1,
      description: 'Save readings, when your scheduled prompt Morning notes runs it, may do this without asking: '
        + `${granted.write_labels[0]![0]!.toLowerCase()}${granted.write_labels[0]!.slice(1)}. Its AI decides what it writes.`
        + ' Once a run, until you end it.' });
    const { recipes } = await f.granter.choices({ trigger: PROMPT }, 'test');
    expect(recipes.map((recipe) => [recipe.recipe_id, recipe.preapprovals.map((row) => row.id)])).toEqual([
      ['ps_1', []], ['add-note', [granted.id]],
    ]);
    // An edit to the prompt ends it.
    f.prompt.version = V2;
    expect((await f.granter.list('test'))[0]!.state).toBe('outdated');
    await f.granter.revoke({ id: granted.id }, 'owner revoke');
    expect(await f.granter.grantOffer(offer, APPROVAL)).toMatchObject({ id: granted.id, state: 'revoked' });
    expect(f.triggerPreapprovals.list()).toHaveLength(1);
  });
});
