import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import {
  createAuditLogStore,
  type AuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { createAuditRetention, type AuditRetentionConfig } from '../audit-retention.js';

const QUOTA = 50 * 1024 * 1024;

const mkGate = (): StorageGate => createStorageGate({
  quota: QUOTA,
  reservePct: 4,
  surface: 'audit',
});

const mkConfig = (
  overrides: Partial<AuditRetentionConfig> = {},
): AuditRetentionConfig => ({
  retentionDays: 30,
  quotaBytes: QUOTA,
  pruneAtPct: 70,
  pruneMaxRowsPerRun: 1000,
  reservePct: 4,
  ...overrides,
});

const mkEntry = (o: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: o.run_id ?? `r-${Math.random().toString(36).slice(2, 8)}`,
  recipe_id: 'r',
  recipe_hash: 'h',
  started_at: o.started_at ?? Date.now(),
  finished_at: (o.started_at ?? Date.now()) + 100,
  duration_ms: 100,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
  ...o,
});

describe('createAuditRetention', () => {
  let db: Database.Database;
  let gate: StorageGate;
  let auditLog: AuditLogStore;

  beforeEach(() => {
    db = new Database(':memory:');
    const entries = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
    const activities = createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
    ensureAuditIndexes(db);
    gate = mkGate();
    auditLog = createAuditLogStore(entries, activities, {
      onBytesChanged: (d) => gate.addUsed(d),
    });
  });

  it('age-based pass drops entries older than retention cutoff', async () => {
    const now = 1_000_000_000_000;
    // Two old entries + one fresh
    await auditLog.append(mkEntry({ run_id: 'old-1', started_at: now - 40 * 86_400_000 }));
    await auditLog.append(mkEntry({ run_id: 'old-2', started_at: now - 35 * 86_400_000 }));
    await auditLog.append(mkEntry({ run_id: 'new', started_at: now - 10 * 86_400_000 }));

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });

    const result = await retention.run();
    expect(result.rows_removed).toBeGreaterThanOrEqual(2);
    expect(result.age_pass_ran).toBe(true);
    expect(await auditLog.get('old-1')).toBeNull();
    expect(await auditLog.get('old-2')).toBeNull();
    expect(await auditLog.get('new')).not.toBeNull();
  });

  it('age-based pass skips reserve entries', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(
      mkEntry({ run_id: 'old-reserve', started_at: now - 40 * 86_400_000, reserve: true }),
    );
    await auditLog.append(
      mkEntry({ run_id: 'old-user', started_at: now - 40 * 86_400_000 }),
    );

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });

    await retention.run();
    expect(await auditLog.get('old-reserve')).not.toBeNull();
    expect(await auditLog.get('old-user')).toBeNull();
  });

  it('emits an audit_retention_prune activity when rows were pruned', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(mkEntry({ run_id: 'old', started_at: now - 40 * 86_400_000 }));

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });
    await retention.run();
    const activities = await auditLog.listActivities();
    const prune = activities.find((a) => a.action === 'audit_retention_prune');
    expect(prune).toBeDefined();
    expect(prune!.reserve).toBe(true); // auto-classified as reserve
    expect(prune!.detail).toContain('rows=');
  });

  it('retentionDays null skips the age-based pass entirely', async () => {
    const now = 1_000_000_000_000;
    // Year-old entry — would be pruned at any positive retention.
    await auditLog.append(mkEntry({ run_id: 'ancient', started_at: now - 365 * 86_400_000 }));
    await auditLog.append(mkEntry({ run_id: 'fresh', started_at: now - 1000 }));

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: null }),
      now: () => now,
    });
    const r = await retention.run();
    expect(r.age_pass_ran).toBe(false);
    expect(r.rows_removed).toBe(0);
    expect(await auditLog.get('ancient')).not.toBeNull();
    expect(await auditLog.get('fresh')).not.toBeNull();
  });

  it('retentionDays null still lets size-based pass reclaim quota pressure', async () => {
    const now = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) {
      await auditLog.append(
        mkEntry({ run_id: `r-${i}`, started_at: now - 1000 - i }),
      );
    }
    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: null,
        quotaBytes: 100,
        pruneAtPct: 50,
        pruneMaxRowsPerRun: 5,
        reservePct: 0,
      }),
      now: () => now,
    });
    const r = await retention.run();
    expect(r.age_pass_ran).toBe(false);
    expect(r.size_pass_ran).toBe(true);
    expect(r.rows_removed).toBeGreaterThan(0);
  });

  it('no activity emitted when nothing was pruned', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(mkEntry({ run_id: 'new', started_at: now - 1000 }));

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });
    const r = await retention.run();
    expect(r.rows_removed).toBe(0);
    const activities = await auditLog.listActivities();
    expect(activities.some((a) => a.action === 'audit_retention_prune')).toBe(false);
  });

  it('resyncs the gate via setUsed after prune', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(mkEntry({ run_id: 'old', started_at: now - 40 * 86_400_000 }));
    await auditLog.append(mkEntry({ run_id: 'new', started_at: now - 1000 }));

    // Artificially drift the gate so we can verify setUsed realigns.
    gate.setUsed(999_999_999);

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });
    await retention.run();
    // After prune, gate.used should equal the actual SUM(length(data))
    // across both tables — not the artificial value we set earlier.
    const row = db
      .prepare(
        `SELECT COALESCE(
           (SELECT SUM(length(data)) FROM audit_entries), 0
         ) + COALESCE(
           (SELECT SUM(length(data)) FROM audit_activities), 0
         ) AS total`,
      )
      .get() as { total: number };
    expect(gate.info().used).toBe(row.total);
  });

  it('size-based pass fires when usage exceeds pruneAtPct', async () => {
    const now = 1_000_000_000_000;
    // Fill well within the 30-day window so age-based won't drop anything.
    for (let i = 0; i < 10; i++) {
      await auditLog.append(
        mkEntry({ run_id: `r-${i}`, started_at: now - 1000 - i }),
      );
    }

    // Tiny quota so we trip the trigger easily.
    const smallQuota = 100;
    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes: smallQuota,
        pruneAtPct: 50,
        pruneMaxRowsPerRun: 5,
        reservePct: 0,
      }),
      now: () => now,
    });

    const r = await retention.run();
    expect(r.size_pass_ran).toBe(true);
    expect(r.rows_removed).toBeGreaterThan(0);
  });

  it('size-based pass never drops reserve rows', async () => {
    const now = 1_000_000_000_000;
    // Plenty of reserve rows, all recent.
    for (let i = 0; i < 5; i++) {
      await auditLog.logActivity({
        activity_id: `a-r-${i}`,
        timestamp: now - i,
        action: 'pressure_state_change',
        target: 't',
      });
    }
    // A few user rows.
    for (let i = 0; i < 3; i++) {
      await auditLog.logActivity({
        activity_id: `a-u-${i}`,
        timestamp: now - i,
        action: 'install',
        target: 't',
      });
    }

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes: 100,
        pruneAtPct: 1,
        pruneMaxRowsPerRun: 100,
        reservePct: 0,
      }),
      now: () => now,
    });
    await retention.run();
    const remaining = await auditLog.listActivities();
    // All 5 original reserve rows survive + the pruner's own
    // audit_retention_prune activity (auto-classified as reserve).
    const originalSurvivors = remaining.filter(
      (a) => a.reserve === true && a.action === 'pressure_state_change',
    );
    expect(originalSurvivors.length).toBe(5);
    // No non-reserve rows should have survived the size pass with
    // quota=100 + pruneAtPct=1.
    const remainingUser = remaining.filter((a) => a.reserve !== true);
    expect(remainingUser.length).toBe(0);
  });

  it('concurrent run() calls coalesce into one', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(mkEntry({ run_id: 'old', started_at: now - 40 * 86_400_000 }));

    let invocations = 0;
    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => { invocations++; return mkConfig({ retentionDays: 30 }); },
      now: () => now,
    });

    const [a, b] = await Promise.all([retention.run(), retention.run()]);
    // Both resolve with the same result; config should be read only once.
    expect(a).toBe(b);
    expect(invocations).toBe(1);
  });

  it('runSafe swallows exceptions and records an activity', async () => {
    // Force throw by passing a bogus config that trips the SQL path.
    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => { throw new Error('config boom'); },
      now: () => 1_000_000_000_000,
    });
    const result = await retention.runSafe();
    expect(result).toBeNull();
    const activities = await auditLog.listActivities();
    const err = activities.find((a) => a.action === 'audit_retention_prune');
    expect(err?.detail).toMatch(/error: /);
  });

  // D-157 N.8 (codex BLOCKER fold) — an `'awaiting_approval'` anchor is
  // the user's pending approval; pruning it strands the paused run's
  // checkpoint and hands the checkpoint sweep a false "orphan".
  it('age-based pass never drops an awaiting_approval anchor; the same-age terminal row prunes', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(mkEntry({
      run_id: 'old-awaiting',
      started_at: now - 40 * 86_400_000,
      commit_status: 'awaiting_approval',
    }));
    await auditLog.append(mkEntry({
      run_id: 'old-terminal',
      started_at: now - 40 * 86_400_000,
    }));

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });
    await retention.run();

    expect(await auditLog.get('old-awaiting')).not.toBeNull();
    expect(await auditLog.get('old-terminal')).toBeNull();
  });

  it('size-based pass never drops an awaiting_approval anchor under quota pressure', async () => {
    const now = 1_000_000_000_000;
    await auditLog.append(mkEntry({
      run_id: 'awaiting',
      started_at: now - 1000,
      commit_status: 'awaiting_approval',
    }));
    for (let i = 0; i < 5; i++) {
      await auditLog.append(
        mkEntry({ run_id: `terminal-${i}`, started_at: now - 900 - i }),
      );
    }

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes: 100,
        pruneAtPct: 1,
        pruneMaxRowsPerRun: 100,
        reservePct: 0,
      }),
      now: () => now,
    });
    const r = await retention.run();

    expect(r.size_pass_ran).toBe(true);
    expect(await auditLog.get('awaiting')).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(await auditLog.get(`terminal-${i}`)).toBeNull();
    }
  });

  it('an awaiting anchor becomes prunable once re-appended terminal (INSERT OR REPLACE retire)', async () => {
    const now = 1_000_000_000_000;
    const started = now - 40 * 86_400_000;
    await auditLog.append(mkEntry({
      run_id: 'retired',
      started_at: started,
      commit_status: 'awaiting_approval',
    }));

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({ retentionDays: 30 }),
      now: () => now,
    });
    await retention.run();
    expect(await auditLog.get('retired')).not.toBeNull();

    // The run terminates (deny / expiry) — same run_id, terminal status.
    await auditLog.append(mkEntry({
      run_id: 'retired',
      started_at: started,
      commit_status: 'failed',
    }));
    await retention.run();
    expect(await auditLog.get('retired')).toBeNull();
  });
});
