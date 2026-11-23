/** D-402 slice F2 (§7.6) — a pre-approval a caller holds: the owner's chats or an AI app, for one
 *  recipe version, covering the whole recipe (ruling 5), standing ("Always, for this recipe") or for
 *  one run ("Yes, this time"). Kept in D-341's table and matched at the same two gates, by the run's
 *  caller, its version and its id, never by the call; the trigger's page and its rpc never see one.
 *  Through `handleExecute` with the real gates: the commit gateway holds a chat run's click, as it
 *  holds a scheduled one (`d-341-trigger-preapproval.test.ts`). */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  coversWholeRecipe,
  preapprovalCallerOf,
  type BridgeResult,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
  type RecipeDefinition,
} from '@recued/contracts';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry,
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
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { triggerPreapprovalRecipeSha256 } from '../trigger-preapproval-rpc.js';

const OWNER = { kind: 'owner_chat' } as const;
const APP = { kind: 'ai_app', contract_id: 'k-claude' } as const;
const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

describe('D-402 slice F2 — the caller a run\'s own source names', () => {
  it('the owner\'s chat, in the app or a messenger, under no contract; an AI app by its contract; nothing else', () => {
    expect(preapprovalCallerOf({ channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u', turn_id: 't' } as ExecutionSource))
      .toEqual(OWNER);
    expect(preapprovalCallerOf({ channel: 'messenger', actor: 'user_self', platform: 'telegram' } as unknown as ExecutionSource)).toEqual(OWNER);
    expect(preapprovalCallerOf({ channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u', turn_id: 't',
      contract_id: 'k-household' } as ExecutionSource)).toBeUndefined();
    expect(preapprovalCallerOf(MCP('k-claude'))).toEqual(APP);
    expect(preapprovalCallerOf({ channel: 'schedule', actor: 'system', schedule_id: 'sch_1', cron: '* * * * *' } as ExecutionSource))
      .toBeUndefined();
    expect(preapprovalCallerOf({ channel: 'user', actor: 'user_self', user_id: 'u' } as ExecutionSource)).toBeUndefined();
  });
});

describe('D-402 slice F2 — the store keeps a caller\'s pre-approvals beside the triggers\'', () => {
  const call = (overrides: Record<string, unknown> = {}) => ({
    caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, op: 'dom-click', run_id: 'run-1', ...overrides,
  }) as Parameters<ReturnType<typeof createTriggerPreapprovalStore>['useCaller']>[0];

  it('"Always" covers every write of the version, with no count, for that caller alone', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const always = store.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: 1 });
    expect(always).toMatchObject({ caller: OWNER, recipe_id: 'file-bill', uses: 0 });
    expect(always.run_id).toBeUndefined();
    for (const op of ['dom-click', 'mail-send', 'shared-write', 'dom-click']) expect(store.useCaller(call({ op }), 2)?.id).toBe(always.id);
    expect(store.getCaller(always.id)?.uses).toBe(4);
    expect(store.runWrites('run-1')).toEqual([
      { preapproval_id: always.id, op: 'dom-click', uses: 2 }, { preapproval_id: always.id, op: 'mail-send', uses: 1 },
      { preapproval_id: always.id, op: 'shared-write', uses: 1 }]);
    // Another run of the same version: covered too.
    expect(store.useCaller(call({ run_id: 'run-2' }), 3)?.id).toBe(always.id);
    // Not another version, another recipe, or another caller.
    expect(store.useCaller(call({ recipe_sha256: V2 }), 3)).toBeUndefined();
    expect(store.useCaller(call({ recipe_id: 'other' }), 3)).toBeUndefined();
    expect(store.useCaller(call({ caller: APP }), 3)).toBeUndefined();
    // Ended: nothing.
    expect(store.revokeCaller(always.id, 4).revoked_at).toBe(4);
    expect(store.useCaller(call(), 5)).toBeUndefined();
  });

  it('"Yes, this time" covers its own run alone, and is spent before a standing one', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const once = store.grantCaller({ caller: APP, recipe_id: 'file-bill', recipe_sha256: V1, run_id: 'run-7', now: 1 });
    expect(once.run_id).toBe('run-7');
    expect(store.useCaller(call({ caller: APP, run_id: 'run-8' }), 2)).toBeUndefined();
    expect(store.useCaller(call({ caller: APP, run_id: 'run-7' }), 2)?.id).toBe(once.id);
    const always = store.grantCaller({ caller: APP, recipe_id: 'file-bill', recipe_sha256: V1, now: 3 });
    expect(store.useCaller(call({ caller: APP, run_id: 'run-7' }), 4)?.id).toBe(once.id);
    expect(store.useCaller(call({ caller: APP, run_id: 'run-8' }), 4)?.id).toBe(always.id);
    // Another AI app holds none of these.
    expect(store.useCaller(call({ caller: { kind: 'ai_app', contract_id: 'k-other' }, run_id: 'run-7' }), 4)).toBeUndefined();
  });

  it('a trigger\'s page and its rpc never see one, and it is never taken for "once a run"', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const row = store.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: 1 });
    expect(store.list()).toEqual([]);
    expect(store.get(row.id)).toBeUndefined();
    expect(() => store.revoke(row.id, 2)).toThrow(/no pre-approval/u);
    expect(store.listCallers().map((one) => one.id)).toEqual([row.id]);
    // As a reader before ruling 5 reads the row: every write is "*", which no op is, and its cap is 0.
    expect(coversWholeRecipe({ writes: ['*'], max_per_run: 0 })).toBe(true);
    expect(coversWholeRecipe({ writes: ['dom-click'], max_per_run: 0 })).toBe(false);
  });

  it('a trigger\'s row covering the whole recipe spends no cap a run (ruling 5); one granted before keeps its cap (ruling 9)', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const SCHEDULE = { kind: 'schedule', schedule_id: 'sch_1' } as const;
    const whole = store.grant({ trigger: SCHEDULE, recipe_id: 'r', recipe_sha256: V1, writes: ['*'], max_per_run: 0, now: 1 });
    const use = (op: string) => store.use({ trigger: SCHEDULE, recipe_id: 'r', recipe_sha256: V1, op, run_id: 'run-1' }, 2);
    for (const op of ['dom-click', 'mail-send', 'dom-click']) expect(use(op)?.id).toBe(whole.id);
    const before = createTriggerPreapprovalStore(new Database(':memory:'));
    const once = before.grant({ trigger: SCHEDULE, recipe_id: 'r', recipe_sha256: V1, writes: ['dom-click'], max_per_run: 1, now: 1 });
    const used = (op: string) => before.use({ trigger: SCHEDULE, recipe_id: 'r', recipe_sha256: V1, op, run_id: 'run-1' }, 2);
    expect(used('dom-click')?.id).toBe(once.id);
    expect(used('dom-click')).toBeUndefined();
    expect(used('mail-send')).toBeUndefined();
  });
});

// ── A chat's and an AI app's held write, through `handleExecute` ─────────────────────────────────

const CLICK = { op: 'core.dom.click', args: { target: '*://example.test/*', page: '7:ABCDEF0123', ref: 'e12' } };
const REMOVE = { op: 'core.data.calendar.delete', args: { event_id: 'ev-1' } };
const CHAT: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: 't1' } as ExecutionSource;
/** An AI app's call, as the MCP host sends it: a contracted user under its contract, with a snapshot of
 *  what the contract lets it do (`d-177-p3-mint-surface.test.ts`). */
const MCP = (contract_id: string): ExecutionSource => ({
  channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', tool_call_id: 'tool-call-1', mcp_token_id: 'mcp-token-1', contract_id,
}) as ExecutionSource;
const snapshotOf = (contract_id: string) => ({ contract_id, contract_version: 'v1', allowed_tools: ['dom-click'],
  approval_required: ['write', 'admin'], scope_restrictions: [], resolved_at: Date.now() });

const recipeOf = (steps: Array<Record<string, unknown>>, recipe_id = 'click-it'): RecipeDefinition => ({
  recipe_id, version: 1, ttl: 60,
  metadata: { name: 'Click it', description: 'Clicks it.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps, output: { sidebar: [] },
} as unknown as RecipeDefinition);

const clicked = (): DispatchOutcome => ({
  kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok',
    outputs: { page: '7:ABCDEF0123', url: 'https://example.test/', title: 'Example' } } as BridgeResult,
});

const fixture = (steps: Array<Record<string, unknown>>) => {
  const recipe = recipeOf(steps);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  const contractStore = createContractStore(new Database(':memory:'));
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const store = createTriggerPreapprovalStore(new Database(':memory:'));
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());
  const auditLog = createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>());
  const sent = vi.fn<BridgeDispatcher['dispatch']>(async () => clicked());
  const clicks = () => sent.mock.calls.map(([request]) => request).filter((request) => request.action === 'click').map((request) => request.args.ref);
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    executorConfig: { manifests, bridgeDispatcherRef: () => ({ dispatch: sent, cancel: vi.fn(), canResolve: vi.fn(() => false) }) },
    baseVault: {},
    instanceId: 'd-402-f2',
    commitStore,
    checkpointStore: { write: vi.fn(async (_cp: Checkpoint) => undefined) } as unknown as ExecuteHandlerDeps['checkpointStore'],
    auditLog,
    triggerPreapprovals: store,
    preflightNotifier: { ask: vi.fn(async () => ({ ask_id: 'ask-1' })), registerAskHandler: vi.fn(), notify: vi.fn(async () => undefined) },
  };
  const version = triggerPreapprovalRecipeSha256(recipe);
  const run = (execution_source: ExecutionSource) => handleExecute(deps, {
    recipe_id: recipe.recipe_id, trigger_source: 'manual', execution_source,
    ...(execution_source.channel === 'mcp' ? { contract_snapshot: snapshotOf((execution_source as { contract_id: string }).contract_id) } : {}),
  } as Parameters<typeof handleExecute>[1]);
  return { recipe, recipeStore, store, auditLog, commitStore, clicks, version, run };
};

describe('D-402 slice F2 — a chat\'s or an AI app\'s held write goes through under its caller\'s pre-approval', () => {
  it('in the owner\'s chat the click asks; under "Always" it runs, its use audited with the caller', async () => {
    const asked = fixture([{ id: 'act', ...CLICK }]);
    expect((await asked.run(CHAT)).awaiting_approval).toBe(true);
    expect(asked.clicks()).toEqual([]);

    const f = fixture([{ id: 'act', ...CLICK }]);
    const row = f.store.grantCaller({ caller: OWNER, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, now: Date.now() });
    const response = await f.run(CHAT);
    expect(response.awaiting_approval, JSON.stringify(response.errors)).toBeFalsy();
    expect(f.clicks()).toEqual(['e12']);
    expect(f.store.getCaller(row.id)?.uses).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const used = (await f.auditLog.listActivities()).filter((a) => a.action === 'trigger_preapproval_used');
    expect(used.map((a) => a.target)).toEqual([row.id]);
    const detail = JSON.parse(used[0]!.detail!) as { run_id: string };
    expect(detail).toMatchObject({ recipe_id: 'click-it', step_id: 'act', op: 'dom-click', caller: OWNER, uses: 1 });
    expect(f.store.runWrites(detail.run_id)).toEqual([{ preapproval_id: row.id, op: 'dom-click', uses: 1 }]);
    const commits = await f.commitStore.listByRun(detail.run_id);
    expect(commits.map((commit) => commit.trigger_preapproval)).toEqual([{ id: row.id }]);
  });

  it('an edited recipe asks again; one for another run, or ended, covers nothing', async () => {
    const f = fixture([{ id: 'act', ...CLICK }]);
    f.store.grantCaller({ caller: OWNER, recipe_id: f.recipe.recipe_id, recipe_sha256: 'c'.repeat(64), now: Date.now() });
    f.store.grantCaller({ caller: OWNER, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, run_id: 'another-run', now: Date.now() });
    const ended = f.store.grantCaller({ caller: OWNER, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, now: Date.now() });
    f.store.revokeCaller(ended.id, Date.now());
    expect((await f.run(CHAT)).awaiting_approval).toBe(true);
    expect(f.clicks()).toEqual([]);
    expect(f.store.listCallers().every((row) => row.uses === 0)).toBe(true);
  });

  it('⛔ a destructive step still asks under "Always", which spends nothing on it', async () => {
    const f = fixture([{ id: 'remove', ...REMOVE }]);
    const row = f.store.grantCaller({ caller: OWNER, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, now: Date.now() });
    expect((await f.run(CHAT)).awaiting_approval).toBe(true);
    expect(f.store.getCaller(row.id)?.uses).toBe(0);
  });

  it('an AI app\'s run goes through under its own contract\'s pre-approval, never another\'s or the owner\'s chats\'', async () => {
    const f = fixture([{ id: 'act', ...CLICK }]);
    f.store.grantCaller({ caller: OWNER, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, now: Date.now() });
    f.store.grantCaller({ caller: { kind: 'ai_app', contract_id: 'k-other' }, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, now: Date.now() });
    expect((await f.run(MCP('k-claude'))).awaiting_approval).toBe(true);
    expect(f.clicks()).toEqual([]);
    const mine = f.store.grantCaller({ caller: APP, recipe_id: f.recipe.recipe_id, recipe_sha256: f.version, now: Date.now() });
    expect((await f.run(MCP('k-claude'))).awaiting_approval).toBeFalsy();
    expect(f.clicks()).toEqual(['e12']);
    expect(f.store.getCaller(mine.id)?.uses).toBe(1);
  });
});

describe('D-402 slice F5 — the store tells each change to a pre-approval, once, after it is written', () => {
  it('granted, used and ended, for a caller\'s and a trigger\'s; ending one already ended tells nothing; a throwing listener changes nothing', async () => {
    const BetterSqlite = (await import('better-sqlite3')).default;
    const { createTriggerPreapprovalStore } = await import('../storage/trigger-preapproval-store.js');
    const store = createTriggerPreapprovalStore(new BetterSqlite(':memory:'));
    const seen: unknown[] = [];
    store.onChange(() => { throw new Error('a listener that throws'); });
    const stop = store.onChange((change) => { seen.push(change); });
    const sha = 'a'.repeat(64);
    const mine = store.grantCaller({ caller: { kind: 'owner_chat' }, recipe_id: 'file-bill', recipe_sha256: sha, now: 1 });
    expect(store.useCaller({ caller: { kind: 'owner_chat' }, recipe_id: 'file-bill', recipe_sha256: sha, op: 'notes.create', run_id: 'r1' }, 2))
      .toBeDefined();
    // No row covers another recipe: nothing used, nothing told.
    expect(store.useCaller({ caller: { kind: 'owner_chat' }, recipe_id: 'other', recipe_sha256: sha, op: 'notes.create', run_id: 'r1' }, 3))
      .toBeUndefined();
    store.revokeCaller(mine.id, 4);
    store.revokeCaller(mine.id, 5);
    const trigger = store.grant({ trigger: { kind: 'schedule', schedule_id: 'sch_1' }, recipe_id: 'daily-brief', recipe_sha256: sha,
      writes: ['*'], max_per_run: 0, now: 6 } as never);
    store.revoke(trigger.id, 7);
    expect(seen).toEqual([
      { change: 'granted', id: mine.id, holder: 'caller' },
      { change: 'used', id: mine.id, holder: 'caller' },
      { change: 'ended', id: mine.id, holder: 'caller' },
      { change: 'granted', id: trigger.id, holder: 'trigger' },
      { change: 'ended', id: trigger.id, holder: 'trigger' },
    ]);
    stop();
    store.grantCaller({ caller: { kind: 'owner_chat' }, recipe_id: 'file-bill', recipe_sha256: sha, now: 8 });
    expect(seen).toHaveLength(5);
  });
});

describe('D-402 slice H4 — a caller\'s pre-approval holds each site\'s writes to the browsers it was granted for', () => {
  const call = (overrides: Record<string, unknown> = {}) => ({
    caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, op: 'dom-act', run_id: 'run-1', ...overrides,
  }) as Parameters<ReturnType<typeof createTriggerPreapprovalStore>['useCaller']>[0];
  const TWO = { browser_1: 'inst-work', browser_2: 'inst-home' };

  it('kept with the row, and covering only a run whose settings name the same browsers', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const always = store.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, browsers: TWO, now: 1 });
    expect(store.getCaller(always.id)?.browsers).toEqual(TWO);
    expect(store.useCaller(call({ browsers: { browser_2: 'inst-home', browser_1: 'inst-work' } }), 2)?.id).toBe(always.id);
    // A browser setting changed: not covered, so the run asks again (§8 item 7).
    expect(store.useCaller(call({ browsers: { ...TWO, browser_2: 'inst-work' } }), 3)).toBeUndefined();
    expect(store.useCaller(call({ browsers: { browser_1: 'inst-work' } }), 3)).toBeUndefined();
    expect(store.useCaller(call(), 3)).toBeUndefined();
  });

  it('a recipe that names no browser is covered as before; a row granted before browsers were kept covers none that does', () => {
    const store = createTriggerPreapprovalStore(new Database(':memory:'));
    const plain = store.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: 1 });
    expect(store.getCaller(plain.id)).not.toHaveProperty('browsers');
    expect(store.useCaller(call(), 2)?.id).toBe(plain.id);
    expect(store.useCaller(call({ browsers: {} }), 2)?.id).toBe(plain.id);
    expect(store.useCaller(call({ browsers: TWO }), 2)).toBeUndefined();
  });

  it('a table made before the column opens, keeps its rows, and keeps browsers from then on', () => {
    const db = new Database(':memory:');
    createTriggerPreapprovalStore(db).grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V1, now: 1 });
    db.exec('ALTER TABLE trigger_preapprovals DROP COLUMN browsers');
    const reopened = createTriggerPreapprovalStore(db);
    expect(reopened.listCallers()).toHaveLength(1);
    const later = reopened.grantCaller({ caller: OWNER, recipe_id: 'file-bill', recipe_sha256: V2, browsers: TWO, now: 2 });
    expect(reopened.getCaller(later.id)?.browsers).toEqual(TWO);
  });
});
