import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_PASS_ALWAYS_OPTION_ID, BROWSER_PASS_SESSION_OPTION_ID, BROWSER_PASS_REQUEST_OPTION_ID, BROWSER_PASS_JOB_OPTION_ID,
  BROWSER_PASS_SESSION_TTL_MS, BROWSER_REQUEST_PASS_TTL_MS,
  type BrowserPassAnswerKind, type BrowserPassOffer, type Checkpoint, type RecipeDefinition } from '@recued/contracts';
import { buildPreflightAsk, createPreflightAnswerHandler } from '@recued/gateway';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore,
  type Channel, type PendingAsk, type NotificationSettings } from '@recued/notification';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';
import { createBrowserPassRpcHandlers } from '../browser-pass-rpc.js';
import { recordBrowserPassAnswer } from '../browser-passes.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const NOW = Date.now();
const recipe: RecipeDefinition = { recipe_id: 'browser-pass-recovery', version: 1, ttl: 60,
  metadata: { name: 'Browser pass recovery', description: 'Local recovery fixture', author: 'test', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'write', ingredient: 'dom-click', input: {} }], output: { render: [] } };
const OFFER: BrowserPassOffer = { key: { principal: { kind: 'owner_chat' }, recipe: recipe.recipe_id, site: 'https://example.invalid' },
  host: 'example.invalid', channel_session_id: 'chat:recovery' };
const approval = (index = 1) => ({ run_id: `run-${index}`, checkpoint_id: `held-${index}` });
const decision = (kind: BrowserPassAnswerKind, now = NOW, index = 1) => ({
  approval_ref: JSON.stringify(['preflight', `run-${index}`, `held-${index}`]), offer: OFFER, kind, now,
});
interface SiteRow { pass_id: string; revoked_at: number | null; expires_at: number | null; uses: number }
interface RequestRow { channel_session_id: string; generation_id: string; started_at: number; expires_at: number; ended_at: number | null; uses: number }

describe('browser-pass decisions across SQLite recovery', () => {
  let directory: string;
  let db: Database.Database;
  let clock: number;
  const open = () => {
    db = new Database(join(directory, 'state.sqlite'));
    const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit'), createSQLiteCollection<ActivityEntry>(db, 'activity'));
    const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks'));
    const receipts = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'receipts'));
    const passes = createBrowserPassStore(db);
    const rpc = createBrowserPassRpcHandlers({ store: passes, auditLog: audit });
    const recipes = createRecipeStore(join(directory, 'recipes')); recipes.register(recipe);
    let readFailures = 0;
    const executeDeps: ExecuteHandlerDeps = {
      recipeStore: { ...recipes, get: () => { readFailures++; throw new Error('Recipe read unavailable after the pass decision'); } },
      executorConfig: { manifests: createManifestRegistry(join(directory, 'manifests')) },
      baseVault: {}, auditLog: audit, browserPasses: passes, gatedActionStore: receipts,
    };
    const resumer = createPreflightResumer({ auditLog: audit, getExecuteDeps: () => executeDeps });
    const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
      deliverAsk: async () => {}, deliverNotify: async () => {}, closeAsk: async () => {} };
    const block = createNotificationBlock({ askStore: asks, channels: [ui],
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')) });
    block.registerAskHandler('gateway.preflight', createPreflightAnswerHandler({ checkpointStore: checkpoints, resumer }));
    const seed = async (index = 1, legacy = false, offer: BrowserPassOffer = OFFER) => {
      const cp: Checkpoint = { ...approval(index), recipe_id: recipe.recipe_id, recipe_source_hash: 'a'.repeat(64),
        gated_step_id: 'write', created_at: clock, step_state: {},
        preflight_context: { browser_pass: offer, tool_slug: 'dom-click', gated_action_settlement_mode: 'returned_result' } };
      await checkpoints.write(cp);
      await audit.append({ run_id: cp.run_id, recipe_id: recipe.recipe_id, recipe_hash: 'a'.repeat(64), started_at: clock,
        finished_at: clock, duration_ms: 0, commit_status: 'awaiting_approval', checkpoint_id: cp.checkpoint_id,
        config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'chat', instance_id: null,
        execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'recovery', user_id: 'owner' } });
      await receipts.createHeld({ ...approval(index), recipe_id: recipe.recipe_id, gated_step_id: 'write' });
      const ask = buildPreflightAsk({ checkpoint: cp, context: { recipe_id: cp.recipe_id, gated_step_id: 'write', risk_tier: 'write' } });
      if (legacy) delete ask.handler.payload.browser_pass_decision_version;
      return block.ask(ask.message, ask.options, ask.handler);
    };
    const answer = (ask_id: string, kind: BrowserPassAnswerKind) => block.submitAnswer({ ask_id, via: 'ui',
      option: kind === 'always' ? BROWSER_PASS_ALWAYS_OPTION_ID : kind === 'session' ? BROWSER_PASS_SESSION_OPTION_ID
        : kind === 'job' ? BROWSER_PASS_JOB_OPTION_ID : BROWSER_PASS_REQUEST_OPTION_ID });
    const end = async (kind: BrowserPassAnswerKind) => {
      if (kind === 'request') await rpc['collection.contract.setRequestPass']({ session_id: 'recovery', allow: false });
      else await rpc['collection.contract.revokeBrowserPass']({ pass_id: passes.listPasses(clock)[0]!.pass_id });
    };
    const sites = () => db.prepare('SELECT * FROM browser_passes ORDER BY pass_id').all() as SiteRow[];
    const request = () => db.prepare('SELECT * FROM browser_request_passes WHERE channel_session_id = ?')
      .get(OFFER.channel_session_id) as RequestRow | undefined;
    const state = (kind: BrowserPassAnswerKind) => kind === 'request' ? request() : sites();
    const future = (kind: BrowserPassAnswerKind) => kind === 'request' ? passes.useRequestPass(OFFER.channel_session_id, clock)
      : passes.use(OFFER.key, OFFER.channel_session_id, clock);
    const decisions = () => db.prepare('SELECT * FROM browser_pass_decisions').all();
    return { audit, checkpoints, asks, receipts, passes, rpc, block, seed, answer, end, sites, request, state, future, decisions,
      failures: () => readFailures };
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'browser-pass-decision-')); clock = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => { if (db?.open) db.close(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

  it.each(['always', 'session', 'request'] as const)('preserves the owner ending a %s pass when its interrupted answer recovers', async kind => {
    let env = open(); const { ask_id } = await env.seed(); await env.answer(ask_id, kind);
    expect(env.failures()).toBe(1); expect((await env.asks.get(ask_id))?.status).toBe('answered');
    expect(env.decisions()).toHaveLength(1);
    const selected = kind === 'request' ? env.request()!.generation_id : env.sites()[0]!.pass_id;
    expect(env.decisions()[0]).toMatchObject({ selection_ref: selected, kind });
    env.future(kind); await env.end(kind); const ended = env.state(kind);
    db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.state(kind)).toEqual(ended); expect(env.future(kind)).toBeUndefined();
    expect(env.decisions()).toHaveLength(1); expect(env.failures()).toBe(1);
    expect((await env.asks.get(ask_id))?.status).toBe('answered');
    expect((await env.receipts.getByCheckpoint('held-1'))?.status).toBe('awaiting_approval');
    expect(await env.checkpoints.get('held-1')).not.toBeNull();
  });

  // D-402 (2026-11-23) — an AI app's answer "until this job ends": a session pass whose conversation is its job, ending
  //   when the job does at the latest, kept as the session pass it is.
  it('keeps an AI app\'s pass until its job ends under the job, and no other conversation', async () => {
    const env = open();
    const job = { channel_session_id: 'job:j-1', expires_at: NOW + 20 * 60_000 };
    const APP_OFFER: BrowserPassOffer = { key: { ...OFFER.key, principal: { kind: 'ai_app', contract_id: 'k-app' } },
      host: OFFER.host, channel_session_id: 'mcp:tok-1', job };
    const { ask_id } = await env.seed(1, false, APP_OFFER);
    const ask = await env.asks.get(ask_id);
    const ids = ask!.options.map((option) => option.id);
    expect(ids.indexOf(BROWSER_PASS_JOB_OPTION_ID)).toBe(ids.indexOf(BROWSER_PASS_SESSION_OPTION_ID) - 1);
    expect(ask!.message.text).toContain('“Allow on example.invalid until this job ends” stops asking about');
    await env.answer(ask_id, 'job');
    expect(env.sites()).toEqual([expect.objectContaining({ expires_at: job.expires_at, uses: 0 })]);
    expect(env.decisions()[0]).toMatchObject({ kind: 'session', selection_ref: env.sites()[0]!.pass_id });
    expect(env.passes.use(APP_OFFER.key, 'mcp:tok-1', clock)).toBeUndefined();
    expect(env.passes.use(APP_OFFER.key, 'job:j-2', clock)).toBeUndefined();
    expect(env.passes.use(APP_OFFER.key, 'job:j-1', clock)).toMatchObject({ channel_session_id: 'job:j-1', uses: 1 });
    clock = job.expires_at;
    expect(env.passes.use(APP_OFFER.key, 'job:j-1', clock)).toBeUndefined();
    // The owner's chats have no job: an offer of theirs carrying one offers no such answer.
    const chat = await env.seed(2, false, { ...OFFER, job } as BrowserPassOffer);
    expect((await env.asks.get(chat.ask_id))!.options.map((option) => option.id)).not.toContain(BROWSER_PASS_JOB_OPTION_ID);
  });

  it('preserves an ended request pass after its committed grant acknowledgement was lost', async () => {
    let env = open(); const { ask_id } = await env.seed();
    const keep = env.passes.grantForDecision.bind(env.passes);
    env.passes.grantForDecision = input => { keep(input); throw new Error('Pass acknowledgement lost'); };
    await env.answer(ask_id, 'request'); expect(env.decisions()).toHaveLength(1);
    await env.end('request'); const ended = env.request();
    db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.request()).toEqual(ended); expect(env.future('request')).toBeUndefined();
    expect(env.failures()).toBe(1); expect(env.decisions()).toHaveLength(1);
  });

  it('binds a reused site pass without resetting its uses, and keeps it revoked on recovery', async () => {
    let env = open(); const original = env.passes.mint({ ...OFFER, kind: 'always', now: clock });
    env.future('always'); const { ask_id } = await env.seed(); await env.answer(ask_id, 'always');
    expect(env.sites()).toHaveLength(1); expect(env.sites()[0]).toMatchObject({ pass_id: original.pass_id, uses: 1 });
    expect(env.decisions()[0]).toMatchObject({ selection_ref: original.pass_id });
    await env.end('always'); db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.sites()).toHaveLength(1); expect(env.future('always')).toBeUndefined();
  });

  it.each(['always', 'request'] as const)('allows fresh explicit %s approval while replay leaves the old selection alone', async kind => {
    const env = open(); const first = await env.seed(); await env.answer(first.ask_id, kind);
    await env.end(kind);
    if (kind === 'request') {
      // The switch has its own fresh intent and generation, even if the clock did not move.
      const original = env.request()!.generation_id;
      await env.rpc['collection.contract.setRequestPass']({ session_id: 'recovery', allow: true });
      expect(env.request()!.generation_id).not.toBe(original);
      env.future(kind); const switched = env.request();
      await env.block.recoverPendingAsks(); expect(env.request()).toEqual(switched);
      await env.end(kind);
    }
    const second = await env.seed(2); await env.answer(second.ask_id, kind);
    expect(env.decisions()).toHaveLength(2); expect(env.future(kind)).toBeDefined();
    const current = env.state(kind);
    env.passes.grantForDecision(decision(kind));
    await env.block.recoverPendingAsks(); expect(env.state(kind)).toEqual(current);
    await env.end(kind); await env.block.recoverPendingAsks(); expect(env.future(kind)).toBeUndefined();
  });

  it.each(['session', 'request'] as const)('does not extend the lifetime or reset uses of an expired %s pass', async kind => {
    let env = open(); const { ask_id } = await env.seed(); await env.answer(ask_id, kind); env.future(kind);
    const original = env.state(kind);
    clock += kind === 'session' ? BROWSER_PASS_SESSION_TTL_MS : BROWSER_REQUEST_PASS_TTL_MS;
    db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.state(kind)).toEqual(original); expect(env.future(kind)).toBeUndefined();
    expect(env.failures()).toBe(1);
  });

  it('gives separate reviewed checkpoints in one run separate decisions', async () => {
    const env = open(); await env.seed(); const original = (await env.checkpoints.get('held-1'))!;
    const options = { pass: 'always', decision_version: 1 } as const;
    recordBrowserPassAnswer({ browserPasses: env.passes }, original, 'approved', options);
    const first = env.sites()[0]!.pass_id; await env.end('always');
    recordBrowserPassAnswer({ browserPasses: env.passes }, { ...original, checkpoint_id: 'held-2' }, 'approved', options);
    expect(env.decisions()).toHaveLength(2); expect(env.sites()).toHaveLength(2);
    const fresh = env.passes.listPasses(clock)[0]!; expect(fresh.pass_id).not.toBe(first);
    const before = env.sites(); recordBrowserPassAnswer({ browserPasses: env.passes }, original, 'approved', options);
    expect(env.sites()).toEqual(before); expect(env.future('always')).toMatchObject({ pass_id: fresh.pass_id });
  });

  it.each(['always', 'request'] as const)('rolls back the %s selection when its decision cannot commit, then converges on retry', kind => {
    const env = open();
    if (kind === 'request') {
      env.passes.startRequestPass(OFFER.channel_session_id, clock); env.future(kind);
      env.passes.endRequestPass(OFFER.channel_session_id, clock);
    }
    const before = env.state(kind);
    db.exec(`CREATE TRIGGER reject_browser_decision BEFORE INSERT ON browser_pass_decisions
      BEGIN SELECT RAISE(ABORT,'Browser decision unavailable'); END`);
    expect(() => env.passes.grantForDecision(decision(kind))).toThrow('Browser decision unavailable');
    expect(env.state(kind)).toEqual(before); expect(env.decisions()).toEqual([]);
    expect(db.prepare('SELECT * FROM browser_pass_keys').all()).toEqual([]);
    db.exec('DROP TRIGGER reject_browser_decision');
    env.passes.grantForDecision(decision(kind)); env.future(kind);
    const committed = env.state(kind);
    env.passes.grantForDecision(decision(kind, clock + 10));
    expect(env.state(kind)).toEqual(committed); expect(env.decisions()).toHaveLength(1);
  });

  it('rejects a different site, conversation, or pass choice under the same approval identity', () => {
    const env = open(); env.passes.grantForDecision(decision('always')); const before = env.sites();
    for (const changed of [
      { ...decision('always'), offer: { ...OFFER, key: { ...OFFER.key, site: 'https://other.invalid' } } },
      { ...decision('always'), offer: { ...OFFER, channel_session_id: 'chat:other' } },
      decision('request'),
    ]) expect(() => env.passes.grantForDecision(changed)).toThrow('identity was reused');
    expect(env.sites()).toEqual(before); expect(env.request()).toBeUndefined(); expect(env.decisions()).toHaveLength(1);
  });

  it('does not recreate a selected pass that was removed from storage', () => {
    const env = open(); env.passes.grantForDecision(decision('always'));
    db.prepare('DELETE FROM browser_passes').run();
    env.passes.grantForDecision(decision('always'));
    expect(env.sites()).toEqual([]); expect(env.future('always')).toBeUndefined(); expect(env.decisions()).toHaveLength(1);
  });

  it('recovers a legacy saved choice as a one-time approval without recreating a revoked pass', async () => {
    let env = open(); const { ask_id } = await env.seed(1, true);
    env.passes.mint({ ...OFFER, kind: 'always', now: clock });
    env.block.beginStopping(); await env.answer(ask_id, 'always'); await env.end('always');
    db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.future('always')).toBeUndefined(); expect(env.sites()).toHaveLength(1); expect(env.decisions()).toEqual([]);
    expect(env.failures()).toBe(1); // Its explicit action approval still reaches the resume.
  });

  it('gives legacy request rows stable generation identities without changing times, ended state, or uses', () => {
    db = new Database(join(directory, 'state.sqlite'));
    db.exec(`CREATE TABLE browser_request_passes (channel_session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, ended_at INTEGER, uses INTEGER NOT NULL DEFAULT 0)`);
    const insert = db.prepare('INSERT INTO browser_request_passes VALUES (?, ?, ?, ?, ?)');
    insert.run('chat:live', NOW, NOW + BROWSER_REQUEST_PASS_TTL_MS, null, 7);
    insert.run('chat:ended', NOW, NOW + BROWSER_REQUEST_PASS_TTL_MS, NOW + 1, 9);
    const original = db.prepare('SELECT * FROM browser_request_passes ORDER BY channel_session_id').all();
    const store = createBrowserPassStore(db);
    const migrated = db.prepare('SELECT * FROM browser_request_passes ORDER BY channel_session_id').all() as RequestRow[];
    expect(migrated.map(({ generation_id, ...row }) => { expect(generation_id).toEqual(expect.any(String)); return row; })).toEqual(original);
    expect(new Set(migrated.map(row => row.generation_id)).size).toBe(2);
    expect(store.requestPass('chat:live', NOW)?.uses).toBe(7); expect(store.requestPass('chat:ended', NOW)).toBeUndefined();
    createBrowserPassStore(db);
    expect(db.prepare('SELECT * FROM browser_request_passes ORDER BY channel_session_id').all()).toEqual(migrated);
  });
});
