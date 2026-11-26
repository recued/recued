import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type Checkpoint, type Commit,
  type ContractSnapshot, type OpenProjection, type RecipeDefinition, type SessionGrantMintContext } from '@recued/contracts';
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

const NOW = Date.now(), TOKEN = 'fixture-token', APP = 'ct-fixture-app';
const shipped = JSON.parse(readFileSync(join(__dirname, '../../../../community/recipes/send-composed-mail.json'), 'utf8')) as RecipeDefinition;
const RECIPE: RecipeDefinition = { ...shipped, recipe_id: 'session-checkpoint-recovery',
  steps: [{ ...shipped.steps[0]!, id: 'send_one' }, { ...shipped.steps[0]!, id: 'send_two' }], output: { render: [] } };
const CONFIG = { sender_mail_instance: 'fixture', to: ['recipient@example.invalid'], subject: 'Recovery', body: 'Fixture',
  cc: [], bcc: [], body_format: 'text', attachments: [], in_reply_to: '', reply_to: '', reconciliation_id: null, references: [] };
const SNAPSHOT: ContractSnapshot = { contract_id: APP, contract_version: 'v1', allowed_tools: ['mail-send', 'data-file-read'],
  approval_required: ['write', 'admin'], scope_restrictions: [], resolved_at: NOW };
const projection: OpenProjection = { version: 1, args: [{ path: 'to', skeleton: '{{config.to}}',
  roots: [{ ref: 'config.to', origin: 'config', pinned: 'recipient@example.invalid' }], derived_pinned: 'recipient@example.invalid' }] };
const ctx = (mode: 'exact' | 'open' = 'exact', checkpoint = 'cp-1'): SessionGrantMintContext => ({
  channel: 'mcp', actor: 'contracted_user', channel_session_id: `mcp:${TOKEN}`, source_contract_id: APP,
  ingredient_slug: 'mail-send', operation_id: 'mail-send', connection_name: 'fixture',
  recipe_id: RECIPE.recipe_id, recipe_hash: 'recipe-v1', risk_tier: 'write', pre_lift_approval: 'ask',
  arg_shape_hash: 'shape', canonical_payload_hash: 'payload-v1', ttl_ms: 60_000, max_uses: 2,
  approved_action_ref: JSON.stringify(['preflight', 'run', checkpoint]), decision_version: 1, grant_mode: mode,
  ...(mode === 'open' ? { pinned_projection_hash: 'projection-v1', open_pinned_projection_hash: 'projection-v1', open_projection: projection } : {}),
});

describe('recipe session-grant checkpoint decisions', () => {
  let directory: string, clock: number, deliveries: number, pauseFirst: boolean, call: number;
  let db: Database.Database;
  let started: Promise<void>, released: Promise<void>, signalStarted: () => void, release: () => void;
  const open = () => {
    db = new Database(join(directory, 'state.sqlite'));
    const contracts = createContractStore(db); contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const definitions = createContractDefinitionStore(contracts);
    const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit'), createSQLiteCollection<ActivityEntry>(db, 'activity'));
    const resolver = createSessionGrantResolver({ definitionStore: definitions, auditLog: audit });
    const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const askRows = createSQLiteCollection<PendingAsk>(db, 'pending_asks'), asks = createAskStore(askRows);
    const block = createNotificationBlock({ askStore: asks, channels: [createUiChannel({ busSink: () => undefined })],
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')) });
    const recipes = createRecipeStore(join(directory, 'recipes')); recipes.register(RECIPE);
    const deps: ExecuteHandlerDeps = { recipeStore: recipes,
      executorConfig: { manifests: createManifestRegistry(), kernelDispatchers: { mailSend: async () => {
        deliveries++; if (pauseFirst && deliveries === 1) { signalStarted(); await released; }
        return { source_id: 'fixture', message_id: `m${deliveries}`, sent_at: clock, _id: null, _collection: 'data.mail' as const };
      } } }, baseVault: {}, auditLog: audit, checkpointStore: checkpoints, preflightNotifier: block,
      commitStore: createCommitStore(createSQLiteCollection<Commit>(db, 'commits')), sessionGrantResolver: resolver,
      gatedActionStore: createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'receipts')),
      approvalResumeAuthority: { resolve: ({ execution_source }) => ({ admitted: true, execution_source, contract_snapshot: SNAPSHOT }) },
      listSendCapableMailboxes: () => [{ name: 'fixture', address: 'owner@example.invalid', provider: 'Fixture' }],
    };
    registerPreflightHandler(block, { checkpointStore: checkpoints,
      resumer: createPreflightResumer({ auditLog: audit, getExecuteDeps: () => deps }) });
    const run = async () => {
      const result = await handleExecute(deps, { recipe_id: RECIPE.recipe_id, config: CONFIG, trigger_source: 'mcp',
        execution_source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'fixture', tool_call_id: `call-${++call}`,
          mcp_token_id: TOKEN, contract_id: APP }, contract_snapshot: SNAPSHOT });
      return { held: (result as { awaiting_approval?: boolean }).awaiting_approval === true,
        ask: (await asks.listByStatus('open')).at(-1) };
    };
    const current = async () => (await asks.listByStatus('open')).at(-1)!;
    const answer = (ask: PendingAsk) => block.submitAnswer({ ask_id: ask.ask_id, option: 'allow_session', via: 'ui' });
    const grants = () => definitions.listSessionGrants(`mcp:${TOKEN}`);
    const decisions = () => db.prepare('SELECT * FROM session_grant_decisions').all();
    return { contracts, definitions, resolver, audit, checkpoints, asks, askRows, block, run, current, answer, grants, decisions };
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'session-grant-recovery-')); clock = NOW; deliveries = 0; pauseFirst = false; call = 0;
    started = new Promise(resolve => { signalStarted = resolve; }); released = new Promise(resolve => { release = resolve; });
    vi.spyOn(Date, 'now').mockImplementation(() => clock); vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { release(); if (db?.open) db.close(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

  it('honors fresh Allow this session at the next actual checkpoint after revocation and SQLite reopen', async () => {
    let env = open(); pauseFirst = true; const first = await env.run(); expect(first.held).toBe(true);
    const answering = env.answer(first.ask!);
    await Promise.race([started, answering.then(() => { throw new Error('Answer returned before the dispatcher barrier'); })]);
    const original = env.grants()[0]!; env.definitions.revoke(original.contract_id, 'Owner ended the pass');
    release(); await answering; const second = await env.current(); expect(deliveries).toBe(1);
    expect(second.handler_payload.run_id).toBe(first.ask!.handler_payload.run_id);
    expect(second.handler_payload.checkpoint_id).not.toBe(first.ask!.handler_payload.checkpoint_id);
    db.close(); env = open(); await env.block.recoverPendingAsks(); await env.answer(await env.current());
    expect(deliveries).toBe(2); expect(env.grants()).toHaveLength(2); expect(env.decisions()).toHaveLength(2);
    expect(env.definitions.get(original.contract_id)?.revoked_at).toBe(NOW);
    expect((await env.run()).held).toBe(false); expect(deliveries).toBe(4);
    expect(env.grants().find(row => row.revoked_at === undefined)).toMatchObject({ grant_mode: 'open', bound_contract_id: APP });
  });

  it.each(['exact', 'open'] as const)('a fresh %s checkpoint can regrant an otherwise identical dispatch', mode => {
    const env = open(), first = ctx(mode); env.resolver.mint(first);
    const original = env.grants()[0]!; env.definitions.revoke(original.contract_id, 'Owner ended it');
    env.resolver.mint(ctx(mode, 'cp-2'));
    expect(env.grants()).toHaveLength(2); expect(env.decisions()).toHaveLength(2);
    expect(env.resolver.match(first)).not.toBeNull();
    const before = env.grants(); env.resolver.mint(first); expect(env.grants()).toEqual(before);
  });

  it.each(['exact', 'open'] as const)('%s replay preserves spent uses, revocation, and a later expired selection', async mode => {
    let env = open(); const first = ctx(mode); env.resolver.mint(first); const original = env.grants()[0]!;
    expect(env.resolver.consume(original.contract_id, { source_contract_id: APP, pinned_projection_hash: first.pinned_projection_hash })).toBe(true);
    await vi.waitFor(async () => expect((await env.audit.listActivities()).filter(row => row.action === 'session_grant_minted')).toHaveLength(1));
    const spent = env.definitions.get(original.contract_id); db.close(); env = open();
    env.resolver.mint(first); expect(env.definitions.get(original.contract_id)).toEqual(spent);
    expect(env.resolver.consume(original.contract_id, { source_contract_id: APP, pinned_projection_hash: first.pinned_projection_hash })).toBe(true);
    const exhausted = env.definitions.get(original.contract_id); env.resolver.mint(first);
    expect(env.definitions.get(original.contract_id)).toEqual(exhausted); expect(exhausted?.uses_remaining).toBe(0);
    env.definitions.revoke(original.contract_id, 'Owner ended it'); const revoked = env.definitions.get(original.contract_id);
    env.resolver.mint(first); expect(env.definitions.get(original.contract_id)).toEqual(revoked);
    const second = ctx(mode, 'cp-2'); env.resolver.mint(second);
    const fresh = env.grants().find(row => row.revoked_at === undefined)!; clock += second.ttl_ms + 1;
    env.resolver.mint(second); expect(env.definitions.get(fresh.contract_id)).toEqual(fresh);
    expect(env.resolver.match(second)).toBeNull(); expect(env.grants()).toHaveLength(2); expect(env.decisions()).toHaveLength(2);
  });

  it.each(['exact', 'open'] as const)('%s decisions reject changed authority or offered bounds under one identity', mode => {
    const env = open(), first = ctx(mode); env.resolver.mint(first); const before = env.grants();
    const changedIdentity = mode === 'exact' ? { canonical_payload_hash: 'other-payload' } : { pinned_projection_hash: 'other-projection' };
    for (const changed of [changedIdentity, { channel_session_id: 'mcp:other' }, { source_contract_id: 'ct-other' },
      { operation_id: 'other-op' }, { recipe_hash: 'recipe-v2' }, { ttl_ms: 30_000 }, { max_uses: 3 }]) {
      env.resolver.mint({ ...first, ...changed });
      expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('identity was reused with a different scope'));
    }
    expect(env.grants()).toEqual(before); expect(env.decisions()).toHaveLength(1);
  });

  it('open replay allows riding payload changes without replacing the selected grant or resetting uses', () => {
    const env = open(), first = ctx('open'); env.resolver.mint(first); const original = env.grants()[0]!;
    env.resolver.consume(original.contract_id, { source_contract_id: APP, pinned_projection_hash: first.pinned_projection_hash });
    const before = env.definitions.get(original.contract_id);
    env.resolver.mint({ ...first, canonical_payload_hash: 'different-subject-and-body' });
    expect(env.definitions.get(original.contract_id)).toEqual(before); expect(env.grants()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
  });

  it('retains a committed decision after lost acknowledgement and subsequent revocation', () => {
    let env = open(); const keep = env.definitions.mintSessionGrantForDecision.bind(env.definitions);
    env.definitions.mintSessionGrantForDecision = (...args) => { keep(...args); throw new Error('Grant acknowledgement lost'); };
    env.resolver.mint(ctx()); const original = env.grants()[0]!; expect(original).toBeDefined();
    env.definitions.revoke(original.contract_id, 'Owner ended it'); db.close(); env = open(); env.resolver.mint(ctx());
    expect(env.grants()).toHaveLength(1); expect(env.definitions.get(original.contract_id)?.revoked_at).toBe(NOW); expect(env.decisions()).toHaveLength(1);
  });

  it('rolls the grant back if its decision cannot commit, then converges once on retry', () => {
    const env = open(); db.exec(`CREATE TRIGGER reject_session_decision BEFORE INSERT ON session_grant_decisions
      BEGIN SELECT RAISE(ABORT,'Session decision unavailable'); END`);
    env.resolver.mint(ctx()); expect(env.grants()).toEqual([]); expect(env.decisions()).toEqual([]);
    db.exec('DROP TRIGGER reject_session_decision'); env.resolver.mint(ctx()); env.resolver.mint(ctx());
    expect(env.grants()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
  });

  it('fails closed when a recorded decision has lost its grant', () => {
    const env = open(); env.resolver.mint(ctx()); env.contracts.delete(CONTRACT_DEFINITION_SCOPE, [env.grants()[0]!.contract_id]);
    env.resolver.mint(ctx()); expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining('missing or changed session grant'));
    expect(env.grants()).toEqual([]); expect(env.decisions()).toHaveLength(1);
  });

  it('recovers a persisted legacy recipe choice as one-time approval without creating a pass', async () => {
    let env = open(); const first = await env.run(); const ask = first.ask!;
    const payload = { ...ask.handler_payload }; delete payload.session_grant_decision_version;
    await env.askRows.set(ask.ask_id, { ...ask, handler_payload: payload }); env.block.beginStopping(); await env.answer(ask);
    db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(deliveries).toBe(1); expect((await env.asks.get(ask.ask_id))?.status).toBe('handled');
    expect(env.grants()).toEqual([]); expect(env.decisions()).toEqual([]);
    expect((await env.current()).handler_payload.checkpoint_id).not.toBe(ask.handler_payload.checkpoint_id);
  });
});
