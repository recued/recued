import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D165_CONTRACT_SCHEMA, OWNER_OPERATION_SCOPE, operationSpecHash,
  type Checkpoint, type IngredientManifest, type OperationSpec, type PreflightOverrideOffer } from '@recued/contracts';
import { NEVER_ASK_OPERATION_OPTION_ID, type PreflightOverrideDecision } from '@recued/gateway';
import { createAskStore, type PendingAsk } from '@recued/notification';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { composeNotificationBlock } from '../composition/bin/wire-notification-block.js';
import { makeContractHandlers, upsertOwnerOperationOverride } from '../contract-handler.js';
import { createPreflightOwnerOverride } from '../preflight-owner-override.js';
import { createContractStore } from '../storage/contract-store.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { ensureSourceDependencyEntitySchema } from '../storage/source-dependency-entity-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createEventBus } from '../events/bus.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const NOW = 1_800_000_000_000;
const SLUG = 'policy-test/read';
const OPERATION: OperationSpec = { operation_id: SLUG + '.read', risk_tier: 'read', approval: 'ask', groups: ['recued-core/test.read'] };
const offer: PreflightOverrideOffer = { kind: 'never_ask', ingredient_id: SLUG, operation_id: OPERATION.operation_id,
  op_hash: operationSpecHash(OPERATION), approval: 'never' };
const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat', user_id: 'owner', turn_id: 'turn' } as const;
const checkpoint = (index = 1): Checkpoint => ({ checkpoint_id: `held-${index}`, run_id: `run-${index}`,
  recipe_id: 'fixture-recipe', recipe_source_hash: 'a'.repeat(64), gated_step_id: 'read', created_at: NOW,
  step_state: {} });

describe('standing owner policy decision recovery', () => {
  let directory: string;
  let db: Database.Database;
  const open = (ready = false) => {
    db = new Database(join(directory, 'state.sqlite'));
    ensureSourceDependencyEntitySchema(db);
    const store = createContractStore(db, { now: () => NOW }); store.seedSchema(D165_CONTRACT_SCHEMA);
    const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit_log'), createSQLiteCollection<ActivityEntry>(db, 'activities'));
    const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks'));
    const manifests = createManifestRegistry(join(directory, 'manifests'));
    const manifest: IngredientManifest = { slug: SLUG, name: 'Read fixture', description: 'Local policy fixture', author: 'recued-core',
      kind: 'connection', category: 'action', risk_tier: 'read', input: {}, output: {}, operations: { read: OPERATION },
      surfaces: { api: { transport: 'rest', default_base_url: 'https://example.test', auth: { kind: 'none' },
        executes: { read: { kind: 'rest', method: 'GET', path_template: '/items' } } } } };
    manifests.register(manifest);
    const rpc = { store, auditLog: audit, getManifest: (slug: string) => manifests.get(slug), listManifests: () => [manifest] };
    const actions = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'actions'));
    const standing = createPreflightOwnerOverride({ ...rpc, gatedActionStore: actions });
    // A missing recipe on recovery triggers the real resumer's integrity
    // refusal. No engine/provider effect is needed to qualify policy replay.
    const executeDeps: ExecuteHandlerDeps = { recipeStore: createRecipeStore(join(directory, 'recipes')),
      executorConfig: { manifests }, baseVault: {}, auditLog: audit };
    const notification = composeNotificationBlock({ db, auditLog: audit, checkpointStore: checkpoints,
      annotationStore: createAnnotationStore({ db, blobs: createBlobStore(join(directory, 'blobs')) }),
      eventBus: createEventBus(), getExecuteDeps: () => ready ? executeDeps : undefined,
      upsertOverride: standing.apply, captureOverridePolicy: standing.capturePolicy });
    const owner = (approval: 'never' | 'ask') => upsertOwnerOperationOverride(rpc,
      { ingredient_id: SLUG, operation_id: OPERATION.operation_id, policy: { approval } });
    const remove = () => makeContractHandlers(rpc)!.handlers['collection.operation.deleteOwnerOverride'](
      { ingredient_id: SLUG, operation_id: OPERATION.operation_id }, undefined as never);
    const policy = () => (store.get(OWNER_OPERATION_SCOPE, [SLUG, OPERATION.operation_id])?.value as { approval?: string } | undefined)?.approval;
    const receipts = () => db.prepare('SELECT * FROM preflight_owner_override_decisions').all();
    const seed = async (index = 1, terminal = false) => {
      const cp = checkpoint(index); await checkpoints.write(cp);
      await audit.append({ run_id: cp.run_id, recipe_id: cp.recipe_id!, recipe_hash: 'a'.repeat(64),
        started_at: NOW, finished_at: NOW, duration_ms: 0, commit_status: terminal ? 'succeeded' : 'awaiting_approval',
        checkpoint_id: cp.checkpoint_id, config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'user', instance_id: null,
        execution_source: source });
      return cp;
    };
    const decision = (): PreflightOverrideDecision => ({ decision_id: 'decision-1', answered_at: NOW + 1,
      holds: [{ run_id: 'run-1', checkpoint_id: 'held-1' }], policy_revision: standing.capturePolicy(offer)! });
    const raise = (cp: Checkpoint) => notification.block.ask({ title: 'Review read', text: 'Read this item?' },
      [{ id: NEVER_ASK_OPERATION_OPTION_ID, label: 'Never ask for this read' }, { id: 'deny', label: 'Deny' }],
      { kind: 'gateway.preflight', payload: { checkpoint_id: cp.checkpoint_id, run_id: cp.run_id,
        recipe_id: cp.recipe_id, gated_step_id: cp.gated_step_id, owner_override_offer: offer } });
    return { store, audit, checkpoints, asks, standing, owner, remove, policy, receipts, seed, decision, raise, notification, actions, manifests, rpc };
  };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'standing-policy-test-')); });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('applies an unchanged pinned decision first carried out after SQLite reopen', async () => {
    let env = open(); const cp = await env.seed(); const { ask_id } = await env.raise(cp);
    env.notification.block.beginStopping();
    await env.notification.block.submitAnswer({ ask_id, option: NEVER_ASK_OPERATION_OPTION_ID, via: 'ui' });
    expect(env.policy()).toBeUndefined(); expect(env.receipts()).toEqual([]);
    expect((await env.asks.get(ask_id))?.status).toBe('answered');
    db.close(); env = open(true); await env.notification.block.recoverPendingAsks();
    expect(env.policy()).toBe('never'); expect(env.receipts()).toHaveLength(1);
    expect((await env.asks.get(ask_id))?.status).toBe('handled');
  });

  it.each(['edit', 'delete'] as const)('preserves a later owner %s across single-answer SQLite recovery', async change => {
    let env = open(); const cp = await env.seed(); const { ask_id } = await env.raise(cp);
    expect((await env.asks.get(ask_id))?.handler_payload.owner_override_policy_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    await env.notification.block.submitAnswer({ ask_id, option: NEVER_ASK_OPERATION_OPTION_ID, via: 'ui' });
    expect(env.policy()).toBe('never'); expect(env.receipts()).toHaveLength(1);
    expect((await env.asks.get(ask_id))?.status).toBe('answered'); // runtime unavailable after the policy commit
    if (change === 'edit') await env.owner('ask'); else await env.remove();
    db.close(); env = open(true); await env.notification.block.recoverPendingAsks();
    expect(env.policy()).toBe(change === 'edit' ? 'ask' : undefined);
    expect((await env.asks.get(ask_id))?.status).toBe('handled');
    expect(await env.checkpoints.get(cp.checkpoint_id)).toBeNull();
    expect((await env.audit.get(cp.run_id))?.commit_status).toBe('failed');
    expect(env.receipts()).toHaveLength(1);
  });

  it('preserves a later policy while a closing batch resumes after SQLite reopen', async () => {
    let env = open(); let ask_id = '', approval_ref = '';
    for (const index of [1, 2]) {
      const cp = await env.seed(index);
      const registered = await env.notification.batchApprovals.registerHold({ source, run_id: cp.run_id,
        correlation_id: 'turn', channel_session_id: 'chat', ingredient_slug: SLUG, operation_id: OPERATION.operation_id,
        risk_tier: 'read', authorization_provenance: { pre_lift_approval: 'ask' }, recipe_id: cp.recipe_id!,
        recipe_hash: 'a'.repeat(64), arg_shape_hash: 'shape', canonical_payload_hash: `payload-${index}`, checkpoint: cp,
        ask_context: { risk_tier: 'read', owner_override_offer: offer } });
      expect(registered.kind).toBe('registered');
      if (registered.kind === 'registered') { ask_id = registered.ask_id; approval_ref = registered.approval_ref; }
    }
    await env.notification.block.submitAnswer({ ask_id, option: NEVER_ASK_OPERATION_OPTION_ID, via: 'ui' });
    expect(env.policy()).toBe('never'); expect((await env.notification.getBatch(approval_ref))?.state).toBe('closing');
    await env.owner('ask'); db.close(); env = open(true); await env.notification.block.recoverPendingAsks();
    expect(env.policy()).toBe('ask'); expect((await env.asks.get(ask_id))?.status).toBe('handled');
    expect((await env.notification.getBatch(approval_ref))?.state).toBe('answered');
    expect(await env.checkpoints.list()).toEqual([]); expect(env.receipts()).toHaveLength(1);
  });

  it('rolls policy back if its decision receipt cannot commit, then retries safely', async () => {
    const env = open(); await env.seed(); const decision = env.decision();
    db.exec(`CREATE TRIGGER reject_decision BEFORE INSERT ON preflight_owner_override_decisions
      BEGIN SELECT RAISE(ABORT,'Decision receipt unavailable'); END`);
    await expect(env.standing.apply(offer, decision)).rejects.toThrow('Decision receipt unavailable');
    expect(env.policy()).toBeUndefined(); expect(env.receipts()).toEqual([]);
    db.exec('DROP TRIGGER reject_decision'); await env.standing.apply(offer, decision);
    expect(env.policy()).toBe('never'); expect(env.receipts()).toHaveLength(1);
  });

  it('recognizes a commit whose acknowledgement was lost and never restores its policy on retry', async () => {
    let env = open(); await env.seed(); const decision = env.decision();
    const transaction = env.store.transaction.bind(env.store);
    env.store.transaction = write => { transaction(write); throw new Error('Commit acknowledgement lost'); };
    await expect(env.standing.apply(offer, decision)).rejects.toThrow('Commit acknowledgement lost');
    expect(env.policy()).toBe('never'); expect(env.receipts()).toHaveLength(1);
    env.store.transaction = transaction; await env.owner('ask'); db.close(); env = open();
    await env.standing.apply(offer, decision);
    expect(env.policy()).toBe('ask'); expect(env.receipts()).toHaveLength(1);
  });

  it.each(['edit_restore', 'delete_restore'] as const)('rejects an old policy pin after %s at an unchanged clock', async change => {
    const env = open(); await env.seed(); await env.owner('ask'); const decision = env.decision();
    if (change === 'edit_restore') await env.owner('never'); else await env.remove();
    await env.owner('ask'); await env.standing.apply(offer, decision);
    expect(env.policy()).toBe('ask');
    expect(env.receipts()).toEqual([expect.objectContaining({ outcome: 'superseded' })]);
  });

  it('rejects a changed operation before a fresh standing write', async () => {
    const env = open(); await env.seed(); const decision = env.decision();
    await env.owner('ask');
    const original = env.manifests.get(SLUG)!;
    env.manifests.register({ ...original, operations: { read: { ...OPERATION, description: 'Changed operation' } } });
    await expect(env.standing.apply(offer, decision)).rejects.toThrow('stale');
    expect(env.policy()).toBe('ask'); expect(env.receipts()).toEqual([]);
  });

  it('refuses a conflicting reuse of a recorded answer identity', async () => {
    const env = open(); await env.seed(); const decision = env.decision();
    await env.standing.apply(offer, decision); await env.owner('ask');
    await expect(env.standing.apply(offer, { ...decision, answered_at: decision.answered_at + 1 })).rejects.toThrow('identity was reused');
    expect(env.policy()).toBe('ask'); expect(env.receipts()).toHaveLength(1);
  });

  it.each([false, true])('handles a recipe-less standing approval with an already claimed receipt: %s', async claimed => {
    const env = open();
    const action = await env.actions.createHeld({ run_id: 'run-1', gated_step_id: 'raw', checkpoint_id: 'held-1' });
    if (claimed) await env.actions.claimDispatch(action.action_ref, { checkpoint_id: 'held-1', attempt_id: 'earlier' });
    const decision = { ...env.decision(), holds: [{ run_id: 'run-1', checkpoint_id: 'held-1', raw_op: true as const }] };
    await env.standing.apply(offer, decision);
    expect(env.policy()).toBe(claimed ? undefined : 'never');
    expect(env.receipts()).toEqual([expect.objectContaining({ outcome: claimed ? 'closed' : 'applied' })]);
  });

  it.each(['edit', 'delete'] as const)('preserves a later owner %s when a legacy answer has no policy pin', async change => {
    const env = open(); await env.seed(); await env.owner('ask');
    const { policy_revision: _revision, ...legacy } = env.decision();
    if (change === 'delete') await env.remove();
    await env.standing.apply(offer, legacy);
    expect(env.policy()).toBe(change === 'edit' ? 'ask' : undefined);
    expect(env.receipts()).toEqual([expect.objectContaining({ outcome: 'superseded' })]);
  });
});
