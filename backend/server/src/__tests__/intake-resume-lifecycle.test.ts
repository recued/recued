import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { createPreflightAnswerHandler } from '@recued/gateway';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore,
  type Channel, type PendingAsk, type NotificationSettings } from '@recued/notification';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { withBeforePreflightResume } from '../composition/bin/wire-notification-block.js';
import { createFormResponsePromotion } from '../ports/reception/form-response-promotion.js';
import { deriveFormSubmissionPiiKeyFromSubDek, sealFormSubmissionField } from '../ports/reception/form-pii.js';
import { createGatedActionStore, reconcileInterruptedGatedActionsAtBoot, type GatedActionRecord } from '../gated-action-store.js';
import { createFormResponseStore } from '../storage/form-response-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const NOW = 1_700_000_000_000;
const RECIPE = 'recued-core/reception-intake-review-then-approve-intake-materialize-1';
const KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x52));
const checkpoint: Checkpoint = { checkpoint_id: 'held', run_id: 'run', recipe_id: RECIPE,
  gated_step_id: 'materialize', created_at: NOW - 1000,
  step_state: { materialize: { input: { top_tier_kind: 'form_response', id: 'submission', metadata: {
    reception_form_submission_id: 'submission', reception_endpoint_id: 'endpoint', form_definition_id: 'form',
  } } } },
};
const anchor = (): AuditEntry => ({ run_id: 'run', recipe_id: RECIPE, recipe_hash: 'hash',
  started_at: NOW - 1000, finished_at: NOW - 1000, duration_ms: 0, commit_status: 'awaiting_approval',
  checkpoint_id: 'held', ask_id: 'ask', config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'reactive', instance_id: null,
  execution_source: { channel: 'reactive', actor: 'system', event_kind: 'composition.reception_form_submission', source_recipe: RECIPE },
});

describe('intake approval recovery across SQLite reopen', () => {
  let directory: string;
  let db: Database.Database;
  const open = (locked: boolean) => {
    db = new Database(join(directory, 'pair.sqlite')); ensureReceptionSchema(db);
    const audit = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'runs'), createSQLiteCollection<ActivityEntry>(db, 'activities'));
    const checkpoints = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const asks = createAskStore(createSQLiteCollection<PendingAsk>(db, 'asks'));
    const submissions = createReceptionFormSubmissionStore(db), responses = createFormResponseStore(db);
    const actions = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'actions'));
    const calls = { source: 0, key: 0, created: 0, execution: 0 };
    const promote = createFormResponsePromotion({ auditLog: audit, gatedActionStore: actions,
      submissionStore: { findById: id => { calls.source++; return submissions.findById(id); } },
      formResponseStore: responses, onCreated: () => { calls.created++; },
      getFormSubmissionPiiKey: () => { calls.key++; if (locked) throw new Error('Vault locked'); return KEY; },
    });
    const executeDeps: ExecuteHandlerDeps = { recipeStore: createRecipeStore(join(directory, 'recipes')),
      executorConfig: { manifests: createManifestRegistry(join(directory, 'manifests')) },
      baseVault: {}, auditLog: audit, gatedActionStore: actions,
    };
    const resumer = withBeforePreflightResume(createPreflightResumer({ auditLog: audit,
      gatedActionStore: actions, getExecuteDeps: () => { calls.execution++; return executeDeps; },
    }), promote);
    const ui: Channel = { name: 'ui', capability: 'inline', owns_llm_egress: true,
      deliverAsk: async () => {}, deliverNotify: async () => {}, closeAsk: async () => {} };
    const block = createNotificationBlock({ askStore: asks, channels: [ui], isVaultUnlocked: () => !locked,
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'settings')), now: () => NOW,
    });
    block.registerAskHandler('gateway.preflight', createPreflightAnswerHandler({ checkpointStore: checkpoints, resumer }));
    return { audit, checkpoints, asks, submissions, responses, actions, calls, promote, block, executeDeps };
  };
  const seed = async (env: ReturnType<typeof open>, completed: boolean) => {
    const [email, blob] = await Promise.all([
      sealFormSubmissionField({ key: KEY, endpoint_id: 'endpoint', submission_id: 'submission', field: 'visitor_email', plaintext: 'visitor@example.test' }),
      sealFormSubmissionField({ key: KEY, endpoint_id: 'endpoint', submission_id: 'submission', field: 'submission_blob',
        plaintext: JSON.stringify({ fields: { project: 'Northwind' }, visitor_email: 'visitor@example.test' }) }),
    ]);
    env.submissions.insert({ submission_id: 'submission', endpoint_id: 'endpoint', form_definition_id: 'form', submitted_at: NOW - 1000,
      source_ip_hash: null, visitor_email_encrypted: email, submission_blob_encrypted: blob!, schema_version: 1, processing_outcome: 'processed',
      metadata: { definition_snapshot: { form_definition_id: 'form', fields: [{ name: 'project', label: 'Project', type: 'text', required: true }] } },
    });
    await env.audit.append(anchor()); await env.checkpoints.write(checkpoint);
    const held = await env.actions.createHeld({ run_id: 'run', recipe_id: RECIPE, gated_step_id: 'materialize', checkpoint_id: 'held' });
    await env.asks.create({ ask_id: 'ask', message: { title: 'Review intake', text: 'Accept response?' },
      options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
      handler_kind: 'gateway.preflight', handler_payload: { checkpoint_id: 'held', run_id: 'run', recipe_id: RECIPE, gated_step_id: 'materialize' },
      fanout_channels: ['ui'], created_at: NOW - 1000,
    });
    await env.asks.recordAnswer('ask', { option: 'approve', answered_at: NOW }, 'ui');
    if (completed) {
      // Seed the persisted state left by a successful first dispatch whose
      // checkpoint cleanup did not finish. The paired engine probe covers the
      // complete initial execution; this fixture qualifies durable recovery.
      await env.promote(checkpoint, { approved_at: NOW });
      env.responses.updateContent('submission', { values: { project: 'Owner corrected' }, visitor: { email: 'visitor@example.test' } }, NOW + 1);
      await env.actions.claimDispatch(held.action_ref, { checkpoint_id: 'held', attempt_id: 'initial-dispatch' });
      await env.actions.finish(held.action_ref, { status: 'succeeded', status_message: 'Completed', result: { accepted: true } });
      const terminal = { ...anchor(), commit_status: 'succeeded' as const, finished_at: NOW, duration_ms: 1000 };
      delete terminal.checkpoint_id; await env.audit.append(terminal);
      expect(env.calls.created).toBe(1);
    }
  };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'intake-recovery-sqlite-')); });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it.each(['none', 'before_delete_commit', 'after_delete_commit'] as const)(
    'retires completed answered approvals with a locked vault and %s cleanup failure', async failure => {
      let env = open(false); await seed(env, true); db.close(); env = open(true);
      if (failure !== 'none') {
        const remove = env.checkpoints.delete.bind(env.checkpoints);
        env.checkpoints.delete = async id => {
          if (failure === 'before_delete_commit') throw new Error('Checkpoint cleanup unavailable');
          await remove(id); throw new Error('Checkpoint cleanup response lost');
        };
      }
      await env.block.recoverPendingAsks();
      expect((await env.asks.get('ask'))?.status).toBe(failure === 'none' ? 'handled' : 'answered');
      expect((await env.checkpoints.get('held')) !== null).toBe(failure === 'before_delete_commit');
      expect(env.calls).toEqual({ source: 0, key: 0, created: 0, execution: 0 });
      db.close(); env = open(true); await env.block.recoverPendingAsks();
      expect((await env.asks.get('ask'))?.status).toBe('handled');
      expect(await env.checkpoints.get('held')).toBeNull();
      expect((await env.actions.getByCheckpoint('held'))?.status).toBe('succeeded');
      expect((await env.audit.get('run'))?.commit_status).toBe('succeeded');
      expect(env.responses.list()).toEqual([expect.objectContaining({ values: { project: 'Owner corrected' } })]);
      expect(env.calls).toEqual({ source: 0, key: 0, created: 0, execution: 0 });
    },
  );

  it('keeps a live answered approval pending across locked-vault recovery without publishing data', async () => {
    let env = open(false); await seed(env, false); db.close(); env = open(true);
    await env.block.recoverPendingAsks();
    expect((await env.asks.get('ask'))?.status).toBe('answered');
    expect(await env.checkpoints.get('held')).not.toBeNull();
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
    expect((await env.audit.get('run'))?.commit_status).toBe('awaiting_approval');
    expect(env.responses.list()).toEqual([]);
    expect(env.calls).toEqual({ source: 1, key: 1, created: 0, execution: 0 });
  });

  it.each(['before_boot_freeze', 'after_boot_freeze', 'audit_write_failure'] as const)(
    'reconciles a lost dispatch-claim response with a locked vault: %s', async boundary => {
      let env = open(false); await seed(env, false);
      // Persist the real pre-dispatch acceptance, then lose the response to a
      // committed receipt claim. The engine probe covers this full call chain.
      await env.promote(checkpoint, { approved_at: NOW });
      env.responses.updateContent('submission', { values: { project: 'Owner corrected' }, visitor: {} }, NOW + 1);
      const held = (await env.actions.getByCheckpoint('held'))!;
      const claim = env.actions.claimDispatch.bind(env.actions);
      env.actions.claimDispatch = async (...args) => {
        await claim(...args); throw new Error('Dispatch claim response lost');
      };
      await expect(env.actions.claimDispatch(held.action_ref, { checkpoint_id: 'held', attempt_id: 'lost-response' }))
        .rejects.toThrow('Dispatch claim response lost');
      db.close(); env = open(true);
      if (boundary !== 'before_boot_freeze') {
        expect(await reconcileInterruptedGatedActionsAtBoot(env.actions)).toBe(1);
      }
      expect((await env.audit.get('run'))?.commit_status).toBe('awaiting_approval');
      if (boundary === 'audit_write_failure') {
        env.audit.append = async () => { throw new Error('Audit repair unavailable'); };
      }
      const recipeReads = vi.spyOn(env.executeDeps.recipeStore, 'get');
      await env.block.recoverPendingAsks();
      expect((await env.actions.getByCheckpoint('held'))?.status).toBe('in_doubt');
      expect((await env.asks.get('ask'))?.status).toBe(boundary === 'audit_write_failure' ? 'answered' : 'handled');
      expect((await env.checkpoints.get('held')) !== null).toBe(boundary === 'audit_write_failure');
      expect(env.calls).toEqual({ source: 0, key: 0, created: 0, execution: 1 });
      expect(recipeReads).not.toHaveBeenCalled();
      db.close(); env = open(true); await env.block.recoverPendingAsks();
      expect((await env.asks.get('ask'))?.status).toBe('handled');
      expect(await env.checkpoints.get('held')).toBeNull();
      expect((await env.actions.getByCheckpoint('held'))?.status).toBe('in_doubt');
      expect((await env.audit.get('run'))?.commit_status).toBe('in_doubt');
      expect(env.responses.list()).toEqual([expect.objectContaining({ values: { project: 'Owner corrected' }, visitor: {} })]);
      expect(env.calls).toEqual({ source: 0, key: 0, created: 0, execution: boundary === 'audit_write_failure' ? 1 : 0 });
    },
  );
});
