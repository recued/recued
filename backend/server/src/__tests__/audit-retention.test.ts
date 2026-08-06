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

describe('audit index coverage for the execution-case compiler', () => {
  // ⛔ PLAN, not result. `execution-case-compiler.ts` filters the WHOLE audit
  // log on these two expressions, and both tables grow without bound — so
  // without an index the compiler's cost rises with everything the server has
  // ever done rather than with the case being compiled. The answers were
  // always right; only the plan was wrong. Measured: 200k audit rows,
  // 26.39ms → 2.09ms.
  const planFor = (sql: string): string => {
    const probe = new Database(':memory:');
    createSQLiteCollection<AuditEntry>(probe, 'audit_entries');
    createSQLiteCollection<ActivityEntry>(probe, 'audit_activities');
    ensureAuditIndexes(probe);
    const out = (probe.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail).join(' ; ');
    probe.close();
    return out;
  };

  it('SEARCHes chat-channel entries instead of scanning the log', () => {
    expect(planFor(
      `SELECT data FROM audit_entries
        WHERE json_extract(data, '$.execution_source.channel') = 'chat'
        ORDER BY json_extract(data, '$.started_at') ASC, key ASC`,
    )).toMatch(/SEARCH audit_entries USING INDEX/);
  });

  it('SEARCHes chat_tool_call activities instead of scanning', () => {
    expect(planFor(
      `SELECT data FROM audit_activities
        WHERE json_extract(data, '$.action') = 'chat_tool_call'`,
    )).toMatch(/SEARCH audit_activities USING INDEX/);
  });

  it('both indexes are PARTIAL — unrelated audit writes do not pay for them', () => {
    const probe = new Database(':memory:');
    createSQLiteCollection<AuditEntry>(probe, 'audit_entries');
    createSQLiteCollection<ActivityEntry>(probe, 'audit_activities');
    ensureAuditIndexes(probe);
    for (const name of ['audit_entries_exec_channel_idx', 'audit_activities_action_idx']) {
      const ddl = (probe
        .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`)
        .get(name) as { sql: string } | undefined)?.sql ?? '';
      expect(ddl, name).toMatch(/ WHERE /);
    }
    probe.close();
  });
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

  it('⛔ evicts the OLDEST rows first, and stops at the per-run cap', async () => {
    // ⛔ WHY THIS EXISTS. Every other size-pass test asserts only
    // `size_pass_ran === true` and `rows_removed > 0` — both of which are
    // satisfied by evicting the NEWEST rows, or by draining the whole table.
    // Reversing `ORDER BY … ASC` to `DESC` at `audit-retention.ts:203` and
    // `:223` was verified to leave the ENTIRE suite green (14 tests here, plus
    // eviction-cascade / phase-b-e2e / pressure-handler / wire-retention-
    // pruners — 63 more), while destroying the most recent audit history first.
    // That is the opposite of what a retention pruner is for: the newest
    // records are the ones an operator is about to need.
    //
    // The age pass is disabled by default (`audit.retention_days` defaults to
    // 0 ⇒ null), so the size pass is the ONLY live pass on a stock server —
    // which is what makes its eviction ORDER load-bearing rather than academic.
    const now = 1_000_000_000_000;
    // r-0 is the NEWEST (now - 1000), r-9 the OLDEST (now - 1009).
    for (let i = 0; i < 10; i++) {
      await auditLog.append(mkEntry({ run_id: `r-${i}`, started_at: now - 1000 - i }));
    }

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes: 100,
        pruneAtPct: 50,
        pruneMaxRowsPerRun: 5,
        reservePct: 0,
      }),
      now: () => now,
    });

    const r = await retention.run();
    expect(r.size_pass_ran).toBe(true);
    // The cap BOUNDS the pass — it does not drain the table. `> 0` passes on
    // both 1 and 10; this does not.
    expect(r.rows_removed).toBe(5);

    const survivors = (db
      .prepare(`SELECT json_extract(data, '$.run_id') AS run_id FROM audit_entries`)
      .all() as Array<{ run_id: string }>)
      .map((row) => row.run_id)
      .sort();
    // The five NEWEST survive; the five oldest are gone.
    expect(survivors).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
  });

  it('⛔ evicts the OLDEST activities first once the entries budget is spent', async () => {
    // The activities half is a SEPARATE `ORDER BY` (`$.timestamp`) reached only
    // through the `rowsRemoved < cap` carry-over, so it needs its own proof —
    // the entries assertion above cannot reach this statement at all.
    const now = 1_000_000_000_000;
    // a-0 newest (now), a-5 oldest (now - 5000). All non-reserve.
    for (let i = 0; i < 6; i++) {
      await auditLog.logActivity({
        activity_id: `a-${i}`,
        timestamp: now - i * 1000,
        action: 'install',
        target: 't',
      });
    }

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes: 100,
        pruneAtPct: 50,
        pruneMaxRowsPerRun: 3,
        reservePct: 0,
      }),
      now: () => now,
    });

    const r = await retention.run();
    expect(r.size_pass_ran).toBe(true);
    expect(r.rows_removed).toBe(3);

    // ⚠ Scoped to the SEEDED ids. The pass logs its own `reserve` activity into
    // this same table, so an unfiltered read returns a generated id too — which
    // is correct behaviour, not a leak, but it is not what this test is about.
    const survivors = (db
      .prepare(`SELECT json_extract(data, '$.activity_id') AS activity_id FROM audit_activities`)
      .all() as Array<{ activity_id: string }>)
      .map((row) => row.activity_id)
      .filter((id) => /^a-\d+$/.test(id))
      .sort();
    expect(survivors).toEqual(['a-0', 'a-1', 'a-2']);
  });

  it('⛔ STOPS at the non-reserve floor instead of draining to it', async () => {
    // ⛔ WHY THIS EXISTS. Every other size-pass test sets `reservePct: 0`, which
    // makes `reserveFloor` 0, which makes `minNonReserveFloor` 0, which makes
    // the floor `break` in BOTH delete loops UNREACHABLE. The guard shipped
    // with no coverage at all — and it is the one piece of that loop that
    // decides when to stop deleting.
    //
    // That mattered acutely when the per-row `measureAuditUsage()` full scan
    // was replaced by a running total: the running total feeds this comparison,
    // so a fix that was correct about performance and wrong about the
    // arithmetic would have deleted straight through the floor with every test
    // still green.
    const now = 1_000_000_000_000;
    // Rows are ~200 bytes each; 60 of them puts usage well over the trigger.
    for (let i = 0; i < 60; i++) {
      await auditLog.append(mkEntry({ run_id: `r-${i}`, started_at: now - 1000 - i }));
    }
    const usedBefore = (db
      .prepare(`SELECT COALESCE(SUM(length(data)),0) AS t FROM audit_entries`)
      .get() as { t: number }).t;

    const quotaBytes = Math.round(usedBefore / 0.8);
    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes,
        pruneAtPct: 50,          // trigger well below current usage
        pruneMaxRowsPerRun: 1000, // cap must NOT be what stops the pass
        reservePct: 40,          // floor = 40% of quota, and no reserve rows
      }),
      now: () => now,
    });

    const r = await retention.run();
    expect(r.size_pass_ran).toBe(true);

    const usedAfter = (db
      .prepare(`SELECT COALESCE(SUM(length(data)),0) AS t FROM audit_entries`)
      .get() as { t: number }).t;
    const floor = quotaBytes * 0.4;

    // It did real work...
    expect(r.rows_removed).toBeGreaterThan(0);
    // ...but STOPPED, rather than draining the table the cap would have allowed.
    expect(r.rows_removed).toBeLessThan(60);
    expect(usedAfter).toBeGreaterThanOrEqual(floor);
    expect(usedAfter).toBeLessThan(usedBefore);
  });

  it('⛔ carries the byte budget from the entries loop INTO the activities loop', async () => {
    // ⛔ WHY THIS EXISTS. The size pass deletes entries first, then activities,
    // sharing one budget — and the floor comparison is against total non-reserve
    // bytes ACROSS BOTH tables. Nothing covered that hand-off: no test seeded
    // both tables under quota pressure at once, so the activities loop's view of
    // the budget was unasserted.
    //
    // It matters specifically because the per-row `measureAuditUsage()` scan was
    // replaced by a running total. A mutation that RESTARTS that total in the
    // activities loop (rather than continuing it) went undetected by every test
    // including the floor one above — because with zero reserve rows the
    // restart is arithmetically identical. Real RESERVE rows are what make the
    // two differ, so this test seeds them.
    const now = 1_000_000_000_000;
    // Reserve rows: excluded from deletion, but counted in `reserveBytes` —
    // which is exactly the term a restart would drop.
    for (let i = 0; i < 8; i++) {
      await auditLog.logActivity({
        activity_id: `a-res-${i}`,
        timestamp: now - i,
        action: 'pressure_state_change', // auto-classified reserve
        target: 't',
      });
    }
    for (let i = 0; i < 30; i++) {
      await auditLog.append(mkEntry({ run_id: `r-${i}`, started_at: now - 1000 - i }));
    }
    for (let i = 0; i < 30; i++) {
      await auditLog.logActivity({
        activity_id: `a-user-${i}`,
        timestamp: now - 5000 - i,
        action: 'install',
        target: 't',
      });
    }

    const total = (): number => (db
      .prepare(
        `SELECT COALESCE((SELECT SUM(length(data)) FROM audit_entries),0)
              + COALESCE((SELECT SUM(length(data)) FROM audit_activities),0) AS t`,
      )
      .get() as { t: number }).t;
    const usedBefore = total();
    const quotaBytes = Math.round(usedBefore / 0.85);

    const retention = createAuditRetention({
      db, auditLog, gate,
      config: () => mkConfig({
        retentionDays: 30,
        quotaBytes,
        pruneAtPct: 50,
        pruneMaxRowsPerRun: 1000, // the cap must not be what stops the pass
        reservePct: 45,
      }),
      now: () => now,
    });

    const r = await retention.run();
    expect(r.size_pass_ran).toBe(true);
    expect(r.rows_removed).toBeGreaterThan(0);

    // Reserve rows are never touched, whichever loop was running.
    // ⚠ Scoped to the SEEDED ids: the pass emits its own
    // `audit_retention_prune` activity, which is auto-classified reserve, so an
    // unfiltered count reads 9. Correct behaviour, not a leak — but it is not
    // what this assertion is about.
    const reserveLeft = (db
      .prepare(
        `SELECT COUNT(*) c FROM audit_activities
          WHERE json_extract(data,'$.reserve') = 1
            AND json_extract(data,'$.activity_id') LIKE 'a-res-%'`,
      )
      .get() as { c: number }).c;
    expect(reserveLeft).toBe(8);

    // ⛔ The floor is measured on NON-RESERVE bytes, across both tables. A loop
    // that restarted the running total without subtracting `reserveBytes` would
    // over-count what it still had to spend and delete past this.
    const reserveBytes = (db
      .prepare(
        `SELECT COALESCE(SUM(length(data)),0) AS t FROM audit_activities
          WHERE json_extract(data,'$.reserve') = 1`,
      )
      .get() as { t: number }).t;
    const nonReserveAfter = total() - reserveBytes;
    const minNonReserveFloor = Math.max(0, quotaBytes * 0.45 - reserveBytes);
    expect(nonReserveAfter).toBeGreaterThanOrEqual(minNonReserveFloor);
    // ...and it did stop short of draining, so the floor is what stopped it.
    expect(r.rows_removed).toBeLessThan(60);
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
