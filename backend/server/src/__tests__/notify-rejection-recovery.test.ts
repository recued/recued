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
import { buildNoAskReleaseContext, createNoAskRelease } from '../reception-inbox-no-ask-release.js';
import { handleReceptionInboxReject, type ReceptionInboxDeps } from '../reception-inbox-handler.js';
import { createInboxRejectionRecovery } from '../reception-inbox-rejection-recovery.js';
import { createReceptionInboxSubviewStore } from '../storage/reception-inbox-subview-store.js';
import type { PendingInboxRejection } from '../storage/reception-inbox-rejection-journal.js';

const NOW = 1_700_000_000_000;
const ADMIN = { instance_id: 'owner' };
const checkpoint: Checkpoint = { checkpoint_id: 'held', run_id: 'run', recipe_id: 'intake',
  gated_step_id: 'materialize', created_at: NOW - 1000, step_state: {} };
const anchor = (): AuditEntry => ({ run_id: 'run', recipe_id: 'intake', recipe_hash: 'hash',
  started_at: NOW - 1000, finished_at: NOW - 1000, duration_ms: 0, commit_status: 'awaiting_approval',
  checkpoint_id: 'held', config_snapshot: {}, errors: [], trigger_url: null, trigger_source: 'reactive', instance_id: null });
const pending = (): PendingInboxRejection => ({ attempt_id: 'attempt', hold_id: 'held', run_id: 'run',
  recipe_id: 'intake', gated_step_id: 'materialize', rejected_at: NOW, phase: 'prepared',
  history: { top_tier_kind: 'form_response', source_record_ref: 'submission', reason: 'Original reason', door_contract_id: 'door' } });

describe('notify-only denial persistence and restart recovery', () => {
  let directory: string;
  let db: Database.Database;
  const open = (now = NOW) => {
    db = new Database(join(directory, 'pair.sqlite'));
    const runs = createSQLiteCollection<AuditEntry>(db, 'runs');
    const auditLog = createAuditLogStore(runs, createSQLiteCollection<ActivityEntry>(db, 'activities'));
    const checkpointStore = createCheckpointStore(createSQLiteCollection<Checkpoint>(db, 'checkpoints'));
    const actions = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, 'actions'));
    const subviewStore = createReceptionInboxSubviewStore(db);
    const resumer = createPreflightResumer({ auditLog, getExecuteDeps: () => undefined, gatedActionStore: actions });
    const deps: ReceptionInboxDeps = { auditLog, checkpointStore, subviewStore,
      releaseWithoutAsk: createNoAskRelease({ resumer, checkpointStore }),
      resolveArgEditSchema: () => ({ fields: [] }), isReceptionOrigin: () => true,
      resolveSource: () => ({ top_tier_kind: 'form_response', source: { kind: 'intake_form', record_ref: 'submission' },
        args: {}, preview: { title: 'Submission' }, proposed_action: 'Save response' }),
      broadcast: () => {}, now: () => now,
    };
    return { deps, runs, actions, resumer, journal: subviewStore.rejectionJournal!,
      recovery: createInboxRejectionRecovery(deps)!,
      rejected: async () => (await auditLog.listActivities(100)).filter(row => String(row.action) === 'reception.inbox.rejected'),
    };
  };
  const seed = async (env: ReturnType<typeof open>) => {
    await env.deps.auditLog.append(anchor());
    await env.deps.checkpointStore.write(checkpoint);
    await env.actions.createHeld({ run_id: 'run', recipe_id: 'intake', gated_step_id: 'materialize', checkpoint_id: 'held' });
  };
  const reject = (env: ReturnType<typeof open>, reason = 'Original reason') =>
    handleReceptionInboxReject(env.deps, { hold_id: 'held', reason }, ADMIN);
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'notify-denial-sqlite-')); });
  afterEach(() => { if (db?.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('does not write terminal history when the denial anchor fails before committing', async () => {
    const env = open(); await seed(env);
    const append = env.deps.auditLog.append.bind(env.deps.auditLog);
    env.deps.auditLog.append = async row => {
      if (row.commit_status === 'failed') throw new Error('denial not committed');
      await append(row);
    };
    await expect(reject(env)).rejects.toThrow('denial not committed');
    expect((await env.deps.auditLog.get('run'))?.commit_status).toBe('awaiting_approval');
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
    expect(await env.deps.checkpointStore.get('held')).not.toBeNull();
    expect(env.deps.subviewStore.list(10)).toEqual([]);
    expect(await env.rejected()).toEqual([]);
    expect(await env.journal.list()).toEqual([]);
  });

  it('accepts an after-commit error and repairs the receipt and checkpoint after SQLite reopen', async () => {
    let env = open(); await seed(env);
    const append = env.deps.auditLog.append.bind(env.deps.auditLog);
    env.deps.auditLog.append = async row => { await append(row); throw new Error('response lost after commit'); };
    expect((await reject(env)).status).toBe('dismissed');
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
    expect((await env.journal.get('held'))?.phase).toBe('accepted');
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 1, discarded: 0, failed: 0 });
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('denied');
    expect(await env.deps.checkpointStore.get('held')).toBeNull();
    expect(env.deps.subviewStore.list(10)).toEqual([expect.objectContaining({ reason: 'Original reason', dismissed_at: NOW })]);
    expect(await env.rejected()).toHaveLength(1);
    expect(await env.journal.list()).toEqual([]);
  });

  it('requires durable metadata before denial and recognizes a metadata write committed before an error', async () => {
    const env = open(); await seed(env);
    const prepare = env.journal.prepare;
    env.journal.prepare = async () => { throw new Error('journal unavailable'); };
    await expect(reject(env)).rejects.toThrow('journal unavailable');
    expect((await env.deps.auditLog.get('run'))?.commit_status).toBe('awaiting_approval');
    expect(await env.rejected()).toEqual([]);
    env.journal.prepare = async entry => { await prepare(entry); throw new Error('journal response lost'); };
    expect((await reject(env)).status).toBe('dismissed');
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('denied');
    expect(await env.rejected()).toHaveLength(1);
    expect(await env.journal.list()).toEqual([]);
  });

  it('replays partial history idempotently with the original reason and timestamp after restart', async () => {
    let env = open(); await seed(env);
    const log = env.deps.auditLog.logActivity.bind(env.deps.auditLog);
    env.deps.auditLog.logActivity = async row => { await log(row); throw new Error('history response lost'); };
    expect((await reject(env)).status).toBe('dismissed');
    expect(await env.deps.checkpointStore.get('held')).toBeNull();
    expect(await env.rejected()).toHaveLength(1);
    db.close(); env = open(NOW + 9999);
    expect((await reject(env, 'Retry must not replace original reason')).status).toBe('dismissed');
    expect(await env.rejected()).toEqual([expect.objectContaining({ timestamp: NOW, detail: 'rejected: Original reason' })]);
    expect(env.deps.subviewStore.list(10)).toEqual([expect.objectContaining({ dismissed_at: NOW, reason: 'Original reason' })]);
    expect(await env.journal.list()).toEqual([]);
  });

  it('discards a prepared-only record after restart without executing its denial', async () => {
    let env = open(); await seed(env); await env.journal.prepare(pending());
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 0, discarded: 1, failed: 0 });
    expect((await env.deps.auditLog.get('run'))?.commit_status).toBe('awaiting_approval');
    expect((await env.actions.getByCheckpoint('held'))?.status).toBe('awaiting_approval');
    expect(await env.deps.checkpointStore.get('held')).not.toBeNull();
    expect(await env.rejected()).toEqual([]);
    expect(env.deps.subviewStore.list(10)).toEqual([]);
  });

  it('recognizes a committed denial after crashing before accepting the metadata', async () => {
    let env = open(); await seed(env); await env.journal.prepare(pending());
    await env.resumer.denyRun(checkpoint, buildNoAskReleaseContext(checkpoint));
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 1, discarded: 0, failed: 0 });
    expect(await env.deps.checkpointStore.get('held')).toBeNull();
    expect(await env.rejected()).toHaveLength(1);
    expect(env.deps.subviewStore.list(10)[0]).toMatchObject({ reason: 'Original reason', door_contract_id: 'door' });
    expect(await env.journal.list()).toEqual([]);
  });

  it('does not mistake another checkpoint denial on the same run and step for this rejection', async () => {
    let env = open(); await seed(env); await env.journal.prepare(pending());
    await env.resumer.denyRun(checkpoint, buildNoAskReleaseContext(checkpoint));
    const denied = (await env.deps.auditLog.get('run'))!;
    denied.errors![0]!.details = { denied_by: 'owner', checkpoint_id: 'a-different-checkpoint' };
    await env.deps.auditLog.append(denied);
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 0, discarded: 1, failed: 0 });
    expect(await env.rejected()).toEqual([]);
    expect(env.deps.subviewStore.list(10)).toEqual([]);
    expect(await env.deps.checkpointStore.get('held')).not.toBeNull();
  });

  it('retains recovery metadata when checkpoint cleanup fails and never consumes a foreign replacement', async () => {
    let env = open(); await seed(env);
    env.deps.checkpointStore.delete = async () => { throw new Error('cleanup unavailable'); };
    expect((await reject(env)).status).toBe('dismissed');
    expect((await env.journal.get('held'))?.phase).toBe('accepted');
    // Simulate storage corruption outside the once-only checkpoint writer.
    await createSQLiteCollection<Checkpoint>(db, 'checkpoints').set('held', { ...checkpoint, run_id: 'foreign-run' });
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 0, discarded: 0, failed: 1 });
    expect((await env.deps.checkpointStore.get('held'))?.run_id).toBe('foreign-run');
    expect(await env.journal.get('held')).not.toBeNull();
    expect(await env.rejected()).toHaveLength(1);
  });

  it('keeps accepted history recoverable without a consumed checkpoint or a retained run anchor', async () => {
    let env = open(); await seed(env);
    env.deps.subviewStore.record = () => { throw new Error('history unavailable'); };
    expect((await reject(env)).status).toBe('dismissed');
    expect(await env.rejected()).toEqual([]);
    expect(await env.deps.checkpointStore.get('held')).toBeNull();
    await env.runs.delete('run');
    db.close(); env = open();
    expect(await env.recovery.recover()).toEqual({ recovered: 1, discarded: 0, failed: 0 });
    expect(env.deps.subviewStore.list(10)).toHaveLength(1);
    expect(await env.rejected()).toHaveLength(1);
    expect(await env.journal.list()).toEqual([]);
  });
});
