import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, KIND_GRANT_OPTION_ID, KIND_GRANT_TTL_MS,
  readKindGrantOffer, type Checkpoint, type Commit, type KindGrantOffer, type RecipeDefinition } from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type PendingAsk, type NotificationSettings } from '@recued/notification';
import { createAuditLogStore, createCheckpointStore, createCommitStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';

const NOW = Date.now();
const REF = JSON.stringify(['preflight', 'run', 'checkpoint']);
const VERSION = { version: 1 } as const;
const OFFER: KindGrantOffer = { channel: 'chat', actor: 'user_self', channel_session_id: 'chat:recovery',
  ingredient_slug: 'mail-send', operation_id: 'mail-send', risk_tier: 'write', name: 'Send an email',
  ttl_ms: KIND_GRANT_TTL_MS, max_uses: 3 };
const recipeFor = (ops: string[]): RecipeDefinition => ({ recipe_id: 'kind-checkpoint-recovery', version: 1, ttl: 0,
  metadata: { name: 'Checkpoint recovery', description: 'Local recorded writes', author: 'test', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: ops.map((ingredient, index) => ({ id: `write_${index + 1}`, ingredient,
    input: ingredient === 'mail-send'
      ? { sender_mail_instance: 'fixture', to: ['recipient@example.invalid'], subject: 'Recovery', body: 'Fixture',
        cc: [], bcc: [], body_format: 'text', attachments: [], in_reply_to: '', reply_to: '', reconciliation_id: null, references: [] }
      : { slug: 'fixture-calendar', calendar_id: 'primary', event: { title: 'Recovery',
        start: '2026-11-20T10:00:00Z', end: '2026-11-20T10:30:00Z' } } })), output: { render: [] } });

describe('kind grants bind each saved approval checkpoint', () => {
  let directory: string;
  let db: Database.Database;
  let clock: number;
  let effects: string[];
  let pauseFirstMail: boolean;
  let started: Promise<void>, released: Promise<void>, signalStarted: () => void, release: () => void;
  const open = () => {
    db = new Database(join(directory, 'state.sqlite'));
    const contracts = createContractStore(db); contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const definitions = createContractDefinitionStore(contracts);
    const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit'), createSQLiteCollection<ActivityEntry>(db, 'activity'));
    const resolver = createSessionGrantResolver({ definitionStore: definitions, auditLog: audit });
    const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const askRows = createSQLiteCollection<PendingAsk>(db, 'pending_asks');
    const asks = createAskStore(askRows);
    const block = createNotificationBlock({ askStore: asks, channels: [createUiChannel({ busSink: () => undefined })],
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')) });
    const deps: ExecuteHandlerDeps = { recipeStore: createRecipeStore(join(directory, 'recipes')),
      executorConfig: { manifests: createManifestRegistry(), kernelDispatchers: {
        mailSend: async () => {
          effects.push('mail-send');
          if (pauseFirstMail && effects.length === 1) { signalStarted(); await released; }
          return { source_id: 'fixture', message_id: `m${effects.length}`, sent_at: clock, _id: null, _collection: 'data.mail' as const };
        },
        calendarCreate: async () => { effects.push('calendar-create'); return { source_id: 'fixture-event', ical_uid: 'fixture-uid' }; },
      } }, baseVault: {}, auditLog: audit, checkpointStore: checkpoints, preflightNotifier: block,
      commitStore: createCommitStore(createSQLiteCollection<Commit>(db, 'commits')), sessionGrantResolver: resolver,
      gatedActionStore: createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'receipts')),
      listSendCapableMailboxes: () => [{ name: 'fixture', address: 'owner@example.invalid', provider: 'Fixture' }],
    };
    registerPreflightHandler(block, { checkpointStore: checkpoints,
      resumer: createPreflightResumer({ auditLog: audit, getExecuteDeps: () => deps }) });
    const run = async (ops: string[]) => {
      const result = await handleExecute(deps, { recipe: recipeFor(ops), trigger_source: 'chat',
        execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'recovery', user_id: 'owner' } });
      return { held: (result as { awaiting_approval?: boolean }).awaiting_approval === true,
        ask: (await asks.listByStatus('open')).at(-1) };
    };
    const current = async () => (await asks.listByStatus('open')).at(-1)!;
    const answer = (ask: PendingAsk) => block.submitAnswer({ ask_id: ask.ask_id, option: KIND_GRANT_OPTION_ID, via: 'ui' });
    const offerFor = async (ask: PendingAsk) => readKindGrantOffer(
      (await checkpoints.get(String(ask.handler_payload.checkpoint_id)))?.preflight_context?.kind_grant)!;
    const grants = () => definitions.listSessionGrants('chat:recovery').filter(row => row.grant_mode === 'kind');
    const decisions = () => db.prepare('SELECT * FROM kind_grant_decisions').all();
    return { contracts, definitions, resolver, audit, checkpoints, asks, askRows, block, run, current, answer, offerFor, grants, decisions };
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'kind-grant-recovery-')); clock = NOW; effects = []; pauseFirstMail = false;
    started = new Promise(resolve => { signalStarted = resolve; }); released = new Promise(resolve => { release = resolve; });
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { release(); if (db?.open) db.close(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

  it('grants both operations from separate checkpoints of one actual engine run, including across SQLite reopen', async () => {
    let env = open(); const first = await env.run(['mail-send', 'calendar-create']); expect(first.held).toBe(true);
    await env.answer(first.ask!); expect(effects).toEqual(['mail-send']);
    const second = await env.current();
    expect(second.handler_payload.run_id).toBe(first.ask!.handler_payload.run_id);
    expect(second.handler_payload.checkpoint_id).not.toBe(first.ask!.handler_payload.checkpoint_id);
    db.close(); env = open(); await env.block.recoverPendingAsks(); await env.answer(await env.current());
    expect(effects).toEqual(['mail-send', 'calendar-create']); expect(env.decisions()).toHaveLength(2);
    expect(env.grants().map(row => row.scope.operation_ids?.[0]).sort()).toEqual(['calendar-create', 'mail-send']);
    expect((await env.run(['mail-send', 'calendar-create'])).held).toBe(false);
    expect(effects).toEqual(['mail-send', 'calendar-create', 'mail-send', 'calendar-create']);
  });

  it('honors fresh reapproval at a later checkpoint after revocation, while replay keeps the old grant revoked', async () => {
    let env = open(); pauseFirstMail = true;
    const first = await env.run(['mail-send', 'mail-send']); const firstOffer = await env.offerFor(first.ask!);
    const answering = env.answer(first.ask!);
    await Promise.race([started, answering.then(() => { throw new Error('Answer returned before the dispatcher barrier'); })]);
    const old = env.grants()[0]!; env.definitions.revoke(old.contract_id, 'Owner ended it'); release(); await answering;
    const second = await env.current(); expect(second.handler_payload.run_id).toBe(first.ask!.handler_payload.run_id);
    expect(second.handler_payload.checkpoint_id).not.toBe(first.ask!.handler_payload.checkpoint_id);
    db.close(); env = open(); await env.block.recoverPendingAsks(); await env.answer(await env.current());
    expect(env.grants()).toHaveLength(2); expect(env.decisions()).toHaveLength(2); expect(effects).toHaveLength(2);
    expect(env.resolver.mintKind(firstOffer, old.approved_action_ref!, VERSION)).toBe(old.contract_id);
    expect(env.definitions.get(old.contract_id)?.revoked_at).toBe(NOW);
    expect((await env.run(['mail-send'])).held).toBe(false); expect(effects).toHaveLength(3);
  });

  it.each(['spent', 'revoked', 'expired', 'exhausted'] as const)('replays a %s grant without resetting its lifetime, uses, or revocation', async state => {
    let env = open(); const offer = { ...OFFER, max_uses: state === 'exhausted' ? 1 : 3 };
    const id = env.resolver.mintKind(offer, REF, VERSION)!; expect(id).toBeDefined();
    if (state === 'spent' || state === 'exhausted') expect(env.resolver.consume(id, { operation_id: offer.operation_id })).toBe(true);
    if (state === 'revoked') env.definitions.revoke(id, 'Owner ended it');
    if (state === 'expired') clock += KIND_GRANT_TTL_MS + 1;
    await vi.waitFor(async () => expect((await env.audit.listActivities())
      .filter(row => row.action === 'session_grant_minted')).toHaveLength(1));
    const original = env.definitions.get(id); db.close(); env = open();
    expect(env.resolver.mintKind(offer, REF, VERSION)).toBe(id);
    expect(env.definitions.get(id)).toEqual(original); expect(env.grants()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
    if (state !== 'spent') expect(env.resolver.consume(id, { operation_id: offer.operation_id })).toBe(false);
    expect((await env.audit.listActivities()).filter(row => row.action === 'session_grant_minted')).toHaveLength(1);
  });

  it('refuses a changed operation, conversation, recipe version, or use budget under one approval identity', () => {
    const env = open(); const offer = { ...OFFER, recipe: { recipe_id: 'recipe', recipe_hash: 'v1' } };
    const id = env.resolver.mintKind(offer, REF, VERSION)!; expect(id).toBeDefined();
    for (const changed of [{ ...offer, operation_id: 'calendar-create' }, { ...offer, channel_session_id: 'chat:other' },
      { ...offer, recipe: { ...offer.recipe, recipe_hash: 'v2' } }, { ...offer, max_uses: 4 }]) {
      expect(env.resolver.mintKind(changed, REF, VERSION)).toBeUndefined();
      expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('identity was reused with a different offer'));
    }
    expect(env.grants().map(row => row.contract_id)).toEqual([id]); expect(env.decisions()).toHaveLength(1);
  });

  it('keeps a committed decision when its acknowledgement is lost and the owner revokes before retry', () => {
    let env = open(); const keep = env.definitions.mintKindGrantForDecision.bind(env.definitions);
    env.definitions.mintKindGrantForDecision = (...args) => { keep(...args); throw new Error('Grant acknowledgement lost'); };
    expect(env.resolver.mintKind(OFFER, REF, VERSION)).toBeUndefined();
    const original = env.grants()[0]!; env.definitions.revoke(original.contract_id, 'Owner ended it');
    db.close(); env = open();
    expect(env.resolver.mintKind(OFFER, REF, VERSION)).toBe(original.contract_id);
    expect(env.grants()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
    expect(env.definitions.get(original.contract_id)?.revoked_at).toBe(NOW);
  });

  it('rolls the grant back when its decision cannot commit, then retries exactly once', () => {
    const env = open();
    db.exec(`CREATE TRIGGER reject_kind_decision BEFORE INSERT ON kind_grant_decisions
      BEGIN SELECT RAISE(ABORT,'Kind decision unavailable'); END`);
    expect(env.resolver.mintKind(OFFER, REF, VERSION)).toBeUndefined();
    expect(env.grants()).toEqual([]); expect(env.decisions()).toEqual([]);
    db.exec('DROP TRIGGER reject_kind_decision');
    const id = env.resolver.mintKind(OFFER, REF, VERSION); expect(id).toBeDefined();
    expect(env.resolver.mintKind(OFFER, REF, VERSION)).toBe(id);
    expect(env.grants()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
  });

  it('fails closed instead of recreating a grant missing from a recorded decision', () => {
    const env = open(); const id = env.resolver.mintKind(OFFER, REF, VERSION)!;
    env.contracts.delete(CONTRACT_DEFINITION_SCOPE, [id]);
    expect(env.resolver.mintKind(OFFER, REF, VERSION)).toBeUndefined();
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('missing or changed kind grant'));
    expect(env.grants()).toEqual([]); expect(env.decisions()).toHaveLength(1);
  });

  it('recovers an unversioned saved choice as a one-time action approval without reviving a legacy grant', async () => {
    let env = open(); const first = await env.run(['mail-send']); const ask = first.ask!;
    const offer = await env.offerFor(ask);
    const original = env.resolver.mintKind(offer, String(ask.handler_payload.run_id))!;
    const payload = { ...ask.handler_payload }; delete payload.kind_grant_decision_version;
    await env.askRows.set(ask.ask_id, { ...ask, handler_payload: payload });
    env.block.beginStopping(); await env.answer(ask); env.definitions.revoke(original, 'Owner ended it');
    db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(effects).toEqual(['mail-send']); expect((await env.asks.get(ask.ask_id))?.status).toBe('handled');
    expect(env.grants()).toHaveLength(1); expect(env.definitions.get(original)?.revoked_at).toBe(NOW);
    expect(env.decisions()).toEqual([]); expect((await env.run(['mail-send'])).held).toBe(true);
  });
});
