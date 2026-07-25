/** D-136 §A.7 P5b — lifecycle queue drain consumer tests.
 *
 *  Covers:
 *    1. Empty queue: drain reports `pending_total: 0`, completes.
 *    2. 'recompute' rows: counted as `rows_recompute_dispatched`,
 *       LAP left intact for per-producer harness.
 *    3. 'discard' rows: tombstoned synchronously
 *       (`staleness_class = 'expired'` + `tombstoned_at` set).
 *    4. 'permanently_failed' rows: counted in
 *       `rows_permanently_failed_observed`, no other action.
 *    5. Dedup-hit rows (planner probeDedup match): LAP cleared +
 *       staleness_class flipped to 'fresh'. (Tested via the planner
 *       integration since the drain doesn't expose probeDedup wiring
 *       directly — it's a no-op until P6 wires the producer-version
 *       hash threading.)
 *    6. Trust-state filtering: 'manual' / 'off' topics surface in
 *       `rows_skipped_by_trust`.
 *    7. Pause-AI: AI-surface topics surface in `rows_skipped_by_pause_ai`.
 *    8. Budget gate: when `over_budget`, drain yields with
 *       'budget_exhausted'.
 *    9. Audit row emission: each drain pass writes one
 *       `lifecycle_queue_drain` audit row capturing the summary.
 *   10. Daily window rollover: drain re-zeroes counters when a day
 *       elapses since the last drain.
 *
 *  The drain task itself spends zero tokens — it observes + handles
 *  non-recompute actions. The "actually re-run producer" path lives
 *  on the per-producer harness's stale-sweep (which already exists
 *  pre-D-136) and lands at P6 in concert with the failure/retry path. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import {
  clearDefaultHousekeepingRegistry,
  registerHousekeepingTask,
  type HousekeepingContext,
  type HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import {
  LIFECYCLE_QUEUE_DRAIN_TASK_ID,
  lifecycleQueueDrainTask,
  readLatestDrainSummary,
} from '../housekeeping/tasks/lifecycle-queue-drain.js';
import {
  PLANNER_BUDGET_STATE_TASK_ID,
  persistBudgetState,
  readBudgetState,
} from '../housekeeping/cycle-planner.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

const buildCtx = (overrides?: Partial<HousekeepingContext>): HousekeepingContext => {
  const audit: Array<{ ts: number; action: string; detail: Record<string, unknown> }> = [];
  // Audit mocking — we wire `audit_entries` table for `readLatestDrainSummary`.
  db.exec(`CREATE TABLE IF NOT EXISTS audit_entries (
    key  TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`);
  const insertAudit = db.prepare(`INSERT INTO audit_entries (key, data) VALUES (?, ?)`);
  const ctx: HousekeepingContext = {
    db,
    bus: {
      emit: () => {},
      subscribe: () => () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    enrichmentStore: store,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recipeStore: {} as any,
    now: () => NOW,
    emitAuditRow: (row): void => {
      audit.push({ ts: row.ts, action: row.action, detail: row.detail });
      insertAudit.run(`audit_${audit.length}`, JSON.stringify({
        action: row.action,
        target: row.target,
        run_mode: row.run_mode,
        started_at: row.ts,
        success: 1,
        detail: row.detail,
      }));
    },
    ...overrides,
  };
  // Stash audit array on ctx for test-side inspection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).__auditRows = audit;
  return ctx;
};

const seedPurposeRow = (target_id: string): string => {
  const r = store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id,
    authored_by: 'system.housekeeping.purpose',
    value: { purpose: 'inquiry', confidence: 0.5 },
  });
  return r._id;
};

const enqueueAction = (
  row_id: string,
  action: 'recompute' | 'discard' | 'permanently_failed',
): void => {
  db.prepare(
    `UPDATE data_enrichment SET lifecycle_action_pending = ? WHERE _id = ?`,
  ).run(action, row_id);
};

const trustAuto = (topic: 'purpose'): void => {
  const trustStore = createTrustStore(db);
  trustStore.write(topic, { trust_state: 'auto', pool_policy: 'free_only' }, NOW);
};

const registerPurposeProducerTask = (): HousekeepingTaskInstance => {
  // Mock task registration so the drain's registry walk sees the
  // topic flagged ai-surface (the planner uses this to budget).
  const task: HousekeepingTaskInstance = {
    meta: {
      id: 'enrichment.purpose',
      description: 'mock',
      interruptible: true,
      kind: 'enrichment',
      tags: [],
    },
    topic: 'purpose',
    is_ai_surface: true,
    step: async () => ({ status: 'complete', cursor: { kind: 'complete' } }),
  };
  registerHousekeepingTask(task);
  return task;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p5b-drain-'));
  db = new Database(join(dir, 'warehouse.db'));
  store = createEnrichmentStore(db);
  ensureHousekeepingSchema(db);
  // P5b wired the budget singleton — also wire it explicitly to
  // exercise the `housekeeping_config` row read path.
  db.prepare(
    `INSERT INTO housekeeping_config (id, preset, cycle_budget_ms, cycle_interval_minutes, updated_at)
       VALUES ('singleton', 'balanced', 60000, 60, ?)`,
  ).run(NOW);
  clearDefaultHousekeepingRegistry();
});

afterEach(() => {
  store.close();
  db.close();
  clearDefaultHousekeepingRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── empty queue ────────────────────────────────────────────────────

describe('lifecycle-queue-drain — empty queue', () => {
  it('reports pending_total: 0 and completes', async () => {
    const ctx = buildCtx();
    const result = await lifecycleQueueDrainTask.step(
      ctx,
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    const summary = readLatestDrainSummary(ctx);
    expect(summary?.pending_total).toBe(0);
    expect(summary?.rows_tombstoned).toBe(0);
  });
});

// ── recompute rows ─────────────────────────────────────────────────

describe('lifecycle-queue-drain — recompute action', () => {
  it('counts recompute rows + leaves LAP for the per-producer harness', async () => {
    const r1 = seedPurposeRow('mail_1');
    const r2 = seedPurposeRow('mail_2');
    enqueueAction(r1, 'recompute');
    enqueueAction(r2, 'recompute');
    trustAuto('purpose');
    registerPurposeProducerTask();
    const trustStore = createTrustStore(db);

    const ctx = buildCtx({ trustStore });
    const result = await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    const summary = readLatestDrainSummary(ctx);
    expect(summary?.pending_total).toBe(2);
    expect(summary?.rows_recompute_dispatched).toBe(2);
    expect(summary?.rows_tombstoned).toBe(0);

    // LAP must remain set so the per-producer stale-sweep can
    // re-derive on its next idle cycle.
    const lapRows = db
      .prepare(
        `SELECT _id FROM data_enrichment WHERE lifecycle_action_pending = 'recompute'`,
      )
      .all() as Array<{ _id: string }>;
    expect(lapRows.map((r) => r._id).sort()).toEqual([r1, r2].sort());
  });
});

// ── discard rows ──────────────────────────────────────────────────

describe('lifecycle-queue-drain — discard action', () => {
  it('tombstones discard rows synchronously', async () => {
    const r1 = seedPurposeRow('mail_1');
    enqueueAction(r1, 'discard');
    trustAuto('purpose');
    registerPurposeProducerTask();
    const trustStore = createTrustStore(db);

    const ctx = buildCtx({ trustStore });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);

    const row = db
      .prepare(
        `SELECT staleness_class, tombstoned_at, tombstone_reason FROM data_enrichment WHERE _id = ?`,
      )
      .get(r1) as {
      staleness_class: string;
      tombstoned_at: number | null;
      tombstone_reason: string | null;
    };
    expect(row.staleness_class).toBe('expired');
    expect(row.tombstoned_at).not.toBeNull();
    expect(row.tombstone_reason).toBe('user_discarded');

    const summary = readLatestDrainSummary(ctx);
    expect(summary?.rows_tombstoned).toBe(1);
  });
});

// ── permanently_failed rows ───────────────────────────────────────

describe('lifecycle-queue-drain — permanently_failed observation', () => {
  it('counts permanently_failed rows but leaves them untouched', async () => {
    const r1 = seedPurposeRow('mail_1');
    enqueueAction(r1, 'permanently_failed');
    trustAuto('purpose');
    registerPurposeProducerTask();
    const trustStore = createTrustStore(db);

    const ctx = buildCtx({ trustStore });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);

    const row = db
      .prepare(`SELECT lifecycle_action_pending, tombstoned_at FROM data_enrichment WHERE _id = ?`)
      .get(r1) as { lifecycle_action_pending: string | null; tombstoned_at: number | null };
    expect(row.lifecycle_action_pending).toBe('permanently_failed');
    expect(row.tombstoned_at).toBeNull();

    const summary = readLatestDrainSummary(ctx);
    expect(summary?.rows_permanently_failed_observed).toBe(1);
    expect(summary?.rows_tombstoned).toBe(0);
    expect(summary?.rows_recompute_dispatched).toBe(0);
  });
});

// ── trust gating ──────────────────────────────────────────────────

describe('lifecycle-queue-drain — trust + pause-AI gating', () => {
  it("surfaces trust 'manual' rows in rows_skipped_by_trust", async () => {
    const r1 = seedPurposeRow('mail_1');
    enqueueAction(r1, 'recompute');
    // No trust row → registry default for AI-surface = 'manual' → skipped.
    registerPurposeProducerTask();
    const trustStore = createTrustStore(db);

    const ctx = buildCtx({ trustStore });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);

    const summary = readLatestDrainSummary(ctx);
    expect(summary?.rows_skipped_by_trust).toBe(1);
    expect(summary?.rows_recompute_dispatched).toBe(0);
  });

  it('surfaces paused-AI rows in rows_skipped_by_pause_ai', async () => {
    const r1 = seedPurposeRow('mail_1');
    enqueueAction(r1, 'recompute');
    trustAuto('purpose');
    registerPurposeProducerTask();
    const trustStore = createTrustStore(db);

    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(NOW + 60 * 60 * 1000);

    const ctx = buildCtx({ trustStore });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const summary = readLatestDrainSummary(ctx);
    expect(summary?.rows_skipped_by_pause_ai).toBe(1);
    expect(summary?.rows_recompute_dispatched).toBe(0);
  });
});

// ── budget gate ───────────────────────────────────────────────────

describe('lifecycle-queue-drain — budget gate', () => {
  it("yields 'budget_exhausted' when the planner reports over_budget", async () => {
    // Seed enough rows to push estimated_free_tokens past the budget.
    // DEFAULT_AI_TOKEN_ESTIMATE = 200, default budget = 1_000_000.
    // 5001 rows × 200 = 1_000_200 → over.
    // For tractability, lower the budget directly to a tiny value.
    db.prepare(
      `UPDATE housekeeping_config SET daily_token_budget_free = 100 WHERE id = 'singleton'`,
    ).run();
    const r1 = seedPurposeRow('mail_1');
    enqueueAction(r1, 'recompute');
    trustAuto('purpose');
    registerPurposeProducerTask();
    const trustStore = createTrustStore(db);

    const ctx = buildCtx({ trustStore });
    const result = await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    expect(result.status).toBe('yield');
    if (result.status === 'yield') {
      expect(result.reason).toBe('budget_exhausted');
    }
    const summary = readLatestDrainSummary(ctx);
    expect(summary?.over_budget).toBe(true);
  });
});

// ── audit row emission ────────────────────────────────────────────

describe('lifecycle-queue-drain — audit emission', () => {
  it('emits one lifecycle_queue_drain audit row per drain pass', async () => {
    const ctx = buildCtx();
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const rows = db
      .prepare(
        `SELECT key FROM audit_entries
           WHERE json_extract(data, '$.action') = 'lifecycle_queue_drain'`,
      )
      .all() as Array<{ key: string }>;
    expect(rows).toHaveLength(1);
  });
});

// ── daily window rollover ─────────────────────────────────────────

describe('lifecycle-queue-drain — daily budget window rollover', () => {
  it('seeds the budget_window_start on first drain', async () => {
    const ctx = buildCtx();
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const back = readBudgetState(db);
    expect(back.budget_window_start).not.toBeNull();
  });

  it('zeroes counters when more than 24h has elapsed', async () => {
    // Pre-seed an old window with consumed tokens.
    persistBudgetState(
      db,
      {
        tokens_consumed_today_free: 5000,
        tokens_consumed_today_byok: 10_000,
        budget_window_start: NOW - 30 * 60 * 60 * 1000, // 30h ago
      },
      NOW - 30 * 60 * 60 * 1000,
    );

    // Run drain with `now = NOW` (30h later).
    const ctx = buildCtx({ now: () => NOW });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const back = readBudgetState(db);
    expect(back.tokens_consumed_today_free).toBe(0);
    expect(back.tokens_consumed_today_byok).toBe(0);
    expect(back.budget_window_start).not.toBe(NOW - 30 * 60 * 60 * 1000);
  });
});

// ── meta + registration ───────────────────────────────────────────

describe('lifecycle-queue-drain — task meta', () => {
  it('exports stable task id', () => {
    expect(LIFECYCLE_QUEUE_DRAIN_TASK_ID).toBe('lifecycle-queue-drain');
    expect(lifecycleQueueDrainTask.meta.id).toBe(LIFECYCLE_QUEUE_DRAIN_TASK_ID);
  });

  it('is registered as kind: core', () => {
    expect(lifecycleQueueDrainTask.meta.kind).toBe('core');
    expect(lifecycleQueueDrainTask.topic).toBeUndefined();
    expect(lifecycleQueueDrainTask.is_ai_surface).toBeUndefined();
  });

  it('uses a distinct task id from the planner state row', () => {
    expect(LIFECYCLE_QUEUE_DRAIN_TASK_ID).not.toBe(PLANNER_BUDGET_STATE_TASK_ID);
  });
});

// ── state-store integration sanity ────────────────────────────────

describe('lifecycle-queue-drain — integrates with state-store', () => {
  it('does not corrupt unrelated state-store rows', async () => {
    // Pre-seed an unrelated state row (simulating the prior-cycle
    // state for `audit-compaction`); the drain should NOT touch it.
    const stateStore = createHousekeepingStateStore(db);
    stateStore.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'time', last_seen_at: NOW - 60_000 },
      last_status: 'complete',
      last_run_at: NOW - 60_000,
      consecutive_errors: 0,
    });

    const ctx = buildCtx();
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);

    const auditRow = stateStore.get('audit-compaction');
    expect(auditRow?.last_status).toBe('complete');
    expect(auditRow?.last_run_at).toBe(NOW - 60_000);
  });
});
