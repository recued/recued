import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '@recued/contracts';
import { createAuditLogStore, createCheckpointStore, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createGatedActionStore, type GatedActionRecord } from '../gated-action-store.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createCheckpointRetention } from '../checkpoint-retention.js';
import { createNoAskRelease } from '../reception-inbox-no-ask-release.js';
import { handleReceptionInboxApprove, handleReceptionInboxReject, type ReceptionInboxDeps } from '../reception-inbox-handler.js';
import { createInboxRejectionRecovery } from '../reception-inbox-rejection-recovery.js';
import { createReceptionInboxSubviewStore } from '../storage/reception-inbox-subview-store.js';

const NOW = 1_700_000_000_000;
const ADMIN = { instance_id: 'owner' };
const checkpoint: Checkpoint = { checkpoint_id: 'held', run_id: 'run', recipe_id: 'intake',
  gated_step_id: 'materialize', created_at: NOW - 2 * 86_400_000, step_state: {} };
const anchor = (): AuditEntry => ({ run_id: 'run', recipe_id: 'intake', recipe_hash: 'hash',
  started_at: checkpoint.created_at, finished_at: checkpoint.created_at, duration_ms: 0, commit_status: 'awaiting_approval',
  checkpoint_id: 'held', config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'reactive', instance_id: null });

describe('notify-only expiry coordination across SQLite restart', () => {
  let directory: string;
  let db: Database.Database;
  const open = (staleAfterDays: number | null = 1) => {
    db = new Database(join(directory, 'pair.sqlite'));
    const auditLog = createAuditLogStore(createSQLiteCollection<AuditEntry>(db, 'runs'), createSQLiteCollection<ActivityEntry>(db, 'activities'));
    const checkpoints = createSQLiteCollection<Checkpoint>(db, 'checkpoints');
    const checkpointStore = createCheckpointStore(checkpoints);
    const actions = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'actions'));
    const subviewStore = createReceptionInboxSubviewStore(db);
    const resumer = createPreflightResumer({ auditLog, getExecuteDeps: () => undefined, gatedActionStore: actions });
    const deps: ReceptionInboxDeps = { auditLog, checkpointStore, subviewStore,
      releaseWithoutAsk: createNoAskRelease({ resumer, checkpointStore }),
      resolveArgEditSchema: () => ({ fields: [] }), isReceptionOrigin: () => true,
      resolveSource: () => ({ top_tier_kind: 'form_response', source: { kind: 'intake_form', record_ref: 'submission' },
        args: {}, preview: { title: 'Submission' }, proposed_action: 'Save response' }),
      broadcast: () => {}, now: () => NOW,
    };
    return { deps, actions, checkpoints, recovery: createInboxRejectionRecovery(deps)!,
      retention: createCheckpointRetention({ auditLog, checkpointStore, gatedActionStore: actions,
        now: () => NOW, config: () => ({ staleAfterDays }) }),
    };
  };
  const seed = async (env: ReturnType<typeof open>) => {
    await env.deps.auditLog.append(anchor()); await env.deps.checkpointStore.write(checkpoint);
    await env.actions.createHeld({ run_id: 'run', recipe_id: 'intake', gated_step_id: 'materialize', checkpoint_id: 'held' });
  };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'notify-expiry-sqlite-')); });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('repairs a committed expiry after restart even when new expiry is disabled, then refuses late decisions', async () => {
    let env = open(); await seed(env);
    const finish = env.actions.finish.bind(env.actions);
    env.actions.finish = async (ref, outcome) => {
      if (outcome.status === 'cancelled') throw new Error('Expiry receipt write unavailable');
      return finish(ref, outcome);
    };
    expect(await env.retention.run()).toMatchObject({ expired: 0, failed: 1 });
    expect((await env.deps.auditLog.get('run'))?.errors?.map(error => error.code)).toEqual(['RECIPE_APPROVAL_TIMEOUT']);
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
    expect(await env.deps.checkpointStore.get('held')).not.toBeNull();
    db.close(); env = open(null);
    expect(await env.retention.run()).toMatchObject({ expired: 1, garbage_collected: 0, failed: 0 });
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('cancelled');
    expect(await env.deps.checkpointStore.get('held')).toBeNull();
    await expect(handleReceptionInboxApprove(env.deps, { hold_id: 'held' }, ADMIN)).rejects.toMatchObject({ code: 'hold_not_found' });
    await expect(handleReceptionInboxReject(env.deps, { hold_id: 'held' }, ADMIN)).rejects.toMatchObject({ code: 'hold_not_found' });
    expect(env.deps.subviewStore.list(10)).toEqual([]);
    expect((await env.deps.auditLog.listActivities(100)).filter(row => String(row.action).startsWith('reception.inbox.'))).toEqual([]);
  });

  it('preserves the accepted denial continuation through retention until receipt repair after restart', async () => {
    let env = open(); await seed(env);
    const finish = env.actions.finish.bind(env.actions);
    env.actions.finish = async (ref, outcome) => {
      if (outcome.status === 'denied') throw new Error('Denial receipt write unavailable');
      return finish(ref, outcome);
    };
    expect((await handleReceptionInboxReject(env.deps, { hold_id: 'held', reason: 'Original owner reason' }, ADMIN)).status).toBe('dismissed');
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
    expect(await env.retention.run()).toMatchObject({ expired: 0, garbage_collected: 0, deferred: 1, failed: 0 });
    expect(await env.deps.checkpointStore.get('held')).not.toBeNull();
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 1, discarded: 0, failed: 0 });
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('denied');
    expect(await env.deps.checkpointStore.get('held')).toBeNull();
    expect((await env.deps.auditLog.get('run'))?.errors?.map(error => error.code)).toEqual(['RECIPE_POLICY_DENIED']);
    expect(env.deps.subviewStore.list(10)).toEqual([expect.objectContaining({ reason: 'Original owner reason', dismissed_at: NOW })]);
    expect((await env.deps.auditLog.listActivities(100)).filter(row => String(row.action) === 'reception.inbox.rejected')).toHaveLength(1);
    expect(await env.deps.subviewStore.rejectionJournal!.list()).toEqual([]);
    expect(await env.retention.run()).toMatchObject({ inspected: 0, expired: 0, failed: 0 });
  });

  it('does not consume a checkpoint reassigned after the sweep captured its list snapshot', async () => {
    const env = open(); await seed(env);
    const list = env.deps.checkpointStore.list.bind(env.deps.checkpointStore);
    env.deps.checkpointStore.list = async () => {
      const snapshot = await list();
      // A foreign storage writer bypassed the normal once-only checkpoint API.
      await env.checkpoints.set('held', { ...checkpoint, run_id: 'foreign-run' });
      return snapshot;
    };
    expect(await env.retention.run()).toMatchObject({ deferred: 1, expired: 0, garbage_collected: 0, failed: 0 });
    expect((await env.deps.checkpointStore.get('held'))?.run_id).toBe('foreign-run');
    expect((await env.deps.auditLog.get('run'))?.commit_status).toBe('awaiting_approval');
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
  });
});
