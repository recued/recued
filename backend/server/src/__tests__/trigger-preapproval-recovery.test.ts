import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRIGGER_PREAPPROVAL_OPTION_ID, TRIGGER_PREAPPROVAL_BROWSER_OP,
  type Checkpoint, type IngredientManifest, type RecipeDefinition, type TriggerPreapprovalOffer } from '@recued/contracts';
import { buildPreflightAsk, createPreflightAnswerHandler } from '@recued/gateway';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore,
  type Channel, type PendingAsk, type NotificationSettings } from '@recued/notification';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createTriggerPreapprovalStore } from '../storage/trigger-preapproval-store.js';
import { createTriggerPreapprovalGranter, createTriggerPreapprovalTargets, triggerPreapprovalRecipeSha256 } from '../trigger-preapproval-rpc.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const NOW = Date.now();
const TRIGGER = { kind: 'schedule', schedule_id: 'sch_1' } as const;
const SLUG = 'records-0123456789abcdef0123456789abcdef';
const OP = 'recovery.notes.note.write';
const manifest: IngredientManifest = { slug: SLUG, name: 'Notes', description: 'Recovery fixture', author: 'recued-core',
  kind: 'connection', category: 'action', risk_tier: 'read', input: {}, output: {}, operations: {
    'note.write': { operation_id: OP, risk_tier: 'write', approval: 'ask', groups: ['g'], description: 'Save a note.' },
  } };
const recipe: RecipeDefinition = { recipe_id: 'save-note', version: 1, ttl: 60,
  metadata: { name: 'Save note', description: 'Recovery fixture', author: 'test', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [{ id: 'write', ingredient: SLUG, input: { operation: 'note.write', args: {} } }],
  output: { render: [] } };
const OFFER: TriggerPreapprovalOffer = { trigger: TRIGGER, recipe_id: recipe.recipe_id,
  recipe_sha256: triggerPreapprovalRecipeSha256(recipe), op: OP };
const approval = (index = 1) => ({ run_id: `run-${index}`, checkpoint_id: `held-${index}` });

describe('trigger pre-approval decisions across SQLite recovery', () => {
  let directory: string;
  let db: Database.Database;
  const open = () => {
    db = new Database(join(directory, 'state.sqlite'));
    const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'audit'), createSQLiteCollection<ActivityEntry>(db, 'activity'));
    const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks'));
    const receipts = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'receipts'));
    const grants = createTriggerPreapprovalStore(db);
    const recipes = createRecipeStore(join(directory, 'recipes')); recipes.register(recipe);
    const granter = createTriggerPreapprovalGranter({ store: grants, recipeStore: recipes, auditLog: audit,
      manifestOf: slug => slug === SLUG ? manifest : null,
      targets: createTriggerPreapprovalTargets({ schedules: { get: id => id === 'sch_1' ? { recipe_id: recipe.recipe_id } : null } }),
    });
    let readFailures = 0;
    const manifests = createManifestRegistry(join(directory, 'manifests')); manifests.register(manifest);
    const executeDeps: ExecuteHandlerDeps = {
      recipeStore: { ...recipes, get: () => { readFailures++; throw new Error('Recipe read unavailable after the grant'); } },
      executorConfig: { manifests }, baseVault: {}, auditLog: audit, triggerPreapprovalGranter: granter, gatedActionStore: receipts,
    };
    const resumer = createPreflightResumer({ auditLog: audit, getExecuteDeps: () => executeDeps });
    const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
      deliverAsk: async () => {}, deliverNotify: async () => {}, closeAsk: async () => {} };
    const block = createNotificationBlock({ askStore: asks, channels: [ui],
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')) });
    block.registerAskHandler('gateway.preflight', createPreflightAnswerHandler({ checkpointStore: checkpoints, resumer }));
    const seed = async (index = 1, legacy = false) => {
      const cp: Checkpoint = { ...approval(index), recipe_id: recipe.recipe_id, recipe_source_hash: 'a'.repeat(64),
        gated_step_id: 'write', created_at: NOW, step_state: {},
        preflight_context: { trigger_preapproval: OFFER, gated_action_settlement_mode: 'returned_result' } };
      await checkpoints.write(cp);
      await audit.append({ run_id: cp.run_id, recipe_id: recipe.recipe_id, recipe_hash: 'a'.repeat(64), started_at: NOW,
        finished_at: NOW, duration_ms: 0, commit_status: 'awaiting_approval', checkpoint_id: cp.checkpoint_id,
        config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'schedule', instance_id: null,
        execution_source: { channel: 'schedule', actor: 'system', schedule_id: 'sch_1',
          cron: '0 7 * * *', source_recipe: recipe.recipe_id } });
      await receipts.createHeld({ ...approval(index), recipe_id: recipe.recipe_id, gated_step_id: 'write' });
      const ask = buildPreflightAsk({ checkpoint: cp, context: { recipe_id: cp.recipe_id, gated_step_id: cp.gated_step_id,
        risk_tier: 'write' } });
      if (legacy) delete ask.handler.payload.trigger_preapproval_decision_version;
      return block.ask(ask.message, ask.options, ask.handler);
    };
    const answer = (ask_id: string) => block.submitAnswer({ ask_id, option: TRIGGER_PREAPPROVAL_OPTION_ID, via: 'ui' });
    const future = () => grants.use({ ...OFFER, run_id: 'future-run' }, NOW);
    const decisions = () => db.prepare('SELECT * FROM trigger_preapproval_decisions').all();
    return { audit, checkpoints, asks, receipts, grants, granter, block, seed, answer, future, decisions, failures: () => readFailures };
  };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'trigger-decision-recovery-')); });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it.each(['normal', 'lost_grant_ack'] as const)('preserves owner revocation after %s and replays the original answer', async boundary => {
    let env = open(); const { ask_id } = await env.seed();
    if (boundary === 'lost_grant_ack') {
      const keep = env.grants.grantForDecision.bind(env.grants);
      env.grants.grantForDecision = (...args) => { keep(...args); throw new Error('Grant acknowledgement lost'); };
    }
    await env.answer(ask_id);
    expect(env.failures()).toBe(1); expect((await env.asks.get(ask_id))?.status).toBe('answered');
    const original = env.grants.list()[0]!; expect(original).toBeDefined(); expect(env.decisions()).toHaveLength(1);
    await env.granter.revoke({ id: original.id }, 'owner revoke'); db.close(); env = open();
    await env.block.recoverPendingAsks();
    expect(env.grants.list()).toEqual([expect.objectContaining({ id: original.id, revoked_at: expect.any(Number) })]);
    expect(env.future()).toBeUndefined(); expect(env.decisions()).toHaveLength(1);
    expect((await env.asks.get(ask_id))?.status).toBe('answered');
    expect((await env.receipts.getByCheckpoint('held-1'))?.status).toBe('awaiting_approval');
    expect(await env.checkpoints.get('held-1')).not.toBeNull();
  });

  it('binds a reused live grant to the decision before the owner revokes it', async () => {
    let env = open(); const { ask_id } = await env.seed();
    // D-402 ruling 10 — the answer grants every write of the version, which a grant of them all covers.
    const original = await env.granter.grant({ trigger: TRIGGER, recipe_id: recipe.recipe_id, writes: ['*'] }, 'owner grant');
    await env.answer(ask_id); expect(env.grants.list()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
    await env.granter.revoke({ id: original.id }, 'owner revoke'); db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.future()).toBeUndefined(); expect(env.grants.list()).toHaveLength(1);
  });

  it('D-402 ruling 9 and 10: a grant of one write, made before, stays as granted and does not stand in for the answer', async () => {
    const env = open(); const { ask_id } = await env.seed();
    const before = await env.granter.grant({ trigger: TRIGGER, recipe_id: recipe.recipe_id, writes: [OP] }, 'owner grant');
    await env.answer(ask_id);
    const rows = env.grants.list();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === before.id)).toMatchObject({ writes: [OP], max_per_run: 1 });
    expect(rows.find((row) => row.id !== before.id)).toMatchObject({ writes: ['*'], max_per_run: 0 });
  });

  it('allows a fresh explicit approval after revocation and leaves the old decision bound to the revoked grant', async () => {
    const env = open(); const first = await env.seed(); await env.answer(first.ask_id);
    const original = env.grants.list()[0]!; await env.granter.revoke({ id: original.id }, 'owner revoke');
    const second = await env.seed(2); await env.answer(second.ask_id);
    const fresh = env.grants.list().find(row => row.revoked_at === undefined)!;
    expect(fresh.id).not.toBe(original.id); expect(env.decisions()).toHaveLength(2);
    expect(await env.granter.grantOffer(OFFER, approval())).toMatchObject({ id: original.id, state: 'revoked' });
    await env.block.recoverPendingAsks(); expect(env.grants.list()).toHaveLength(2);
    expect(env.future()?.id).toBe(fresh.id);
  });

  it('rolls back the grant when its decision binding cannot commit, then retries once', async () => {
    const env = open(); await env.seed();
    db.exec(`CREATE TRIGGER reject_trigger_decision BEFORE INSERT ON trigger_preapproval_decisions
      BEGIN SELECT RAISE(ABORT,'Trigger decision unavailable'); END`);
    await expect(env.granter.grantOffer(OFFER, approval())).rejects.toThrow('Trigger decision unavailable');
    expect(env.grants.list()).toEqual([]); expect(env.decisions()).toEqual([]);
    db.exec('DROP TRIGGER reject_trigger_decision');
    const granted = await env.granter.grantOffer(OFFER, approval());
    expect((await env.granter.grantOffer(OFFER, approval())).id).toBe(granted.id);
    expect(env.grants.list()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
  });

  it('does not mint standing trust when recovering an unversioned legacy answer', async () => {
    let env = open(); const { ask_id } = await env.seed(1, true);
    const original = await env.granter.grant({ trigger: TRIGGER, recipe_id: recipe.recipe_id, writes: [OP] }, 'owner grant');
    env.block.beginStopping(); await env.answer(ask_id);
    await env.granter.revoke({ id: original.id }, 'owner revoke'); db.close(); env = open(); await env.block.recoverPendingAsks();
    expect(env.future()).toBeUndefined(); expect(env.grants.list()).toHaveLength(1); expect(env.decisions()).toEqual([]);
    expect(env.failures()).toBe(1); // The explicit action approval still reaches its resume.
  });

  it('refuses a changed offer under the same approval identity', async () => {
    const env = open(); await env.seed(); const original = await env.granter.grantOffer(OFFER, approval());
    await expect(env.granter.grantOffer({ ...OFFER, recipe_sha256: 'b'.repeat(64) }, approval()))
      .rejects.toThrow('identity was reused with a different offer');
    expect(env.grants.list().map(row => row.id)).toEqual([original.id]); expect(env.decisions()).toHaveLength(1);
  });

  it('fails closed if a recorded decision has lost its grant row', async () => {
    const env = open(); await env.seed(); const original = await env.granter.grantOffer(OFFER, approval());
    db.prepare('DELETE FROM trigger_preapprovals WHERE id=?').run(original.id);
    await expect(env.granter.grantOffer(OFFER, approval())).rejects.toThrow('refers to a missing pre-approval');
    expect(env.grants.list()).toEqual([]); expect(env.decisions()).toHaveLength(1);
  });

  it('converges two prompt granters after their async validation and retains revocation across both connections', async () => {
    const env = open(); const otherDb = new Database(join(directory, 'state.sqlite'));
    try {
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const prompt = { trigger: { kind: 'prompt_schedule', schedule_id: 'ps_1' }, recipe_id: 'ps_1',
        recipe_sha256: 'a'.repeat(64), op: TRIGGER_PREAPPROVAL_BROWSER_OP, asks_ai: true } as const;
      const config = { manifestOf: () => null, prompts: { version: async () => {
        await gate; return { title: 'Prompt', prompt_sha256: 'a'.repeat(64) };
      } } };
      const left = createTriggerPreapprovalGranter({ ...config, store: env.grants });
      const right = createTriggerPreapprovalGranter({ ...config, store: createTriggerPreapprovalStore(otherDb) });
      const first = left.grantOffer(prompt, approval()), second = right.grantOffer(prompt, approval());
      release(); const [a, b] = await Promise.all([first, second]); expect(a.id).toBe(b.id);
      expect(env.grants.list()).toHaveLength(1); expect(env.decisions()).toHaveLength(1);
      await left.revoke({ id: a.id }, 'owner revoke');
      expect(await right.grantOffer(prompt, approval())).toMatchObject({ id: a.id, state: 'revoked' });
      expect(env.grants.list()).toHaveLength(1);
    } finally { otherDb.close(); }
  });
});
