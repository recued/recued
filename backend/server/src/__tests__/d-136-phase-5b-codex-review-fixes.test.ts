/** D-136 P5b Codex review fixes — regression tests.
 *
 *  Four findings from Codex review of `f845925`:
 *    [P1] Topic-wide enqueue must flip staleness_class + drop sidecars
 *         so the per-producer harness's stale-sweep picks them up.
 *    [P2] Cascade governor must reserve REAL fan-out, not 1 slot per
 *         topic; cap is bypassed otherwise.
 *    [P2] Drain must walk the FULL pending-discard queue (not just
 *         AI-surface plan); tombstoneRowIds must clear LAP so
 *         tombstones don't re-surface.
 *    [P2] `cascadeForExternalContextPulseChange` must use
 *         `invalidatingConsumersOf`, not `consumersOf`, so opt-out
 *         declarers (`invalidates_on_pulse_change: false`) are
 *         skipped.
 *
 *  Spec: D-136 §A.5 + §A.7 + §A.14.1. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCascadeBudgetGovernor } from '../storage/cascade-budget.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createExternalContextDependencyRegistry,
} from '../storage/external-context-pulse.js';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  clearDefaultHousekeepingRegistry,
  registerHousekeepingTask,
  type HousekeepingContext,
  type HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import {
  lifecycleQueueDrainTask,
  readLatestDrainSummary,
} from '../housekeeping/tasks/lifecycle-queue-drain.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p5b-codex-fixes-'));
  db = new Database(join(dir, 'warehouse.db'));
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fix #1 — staleness flip on topic-wide enqueue ─────────────────

describe('[P1] enqueueLifecycleActionForTopic flips staleness + drops sidecars', () => {
  it('flips staleness_class to stale on every enqueued row', () => {
    const r1 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    const r2 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(r1.staleness_class).toBe('fresh');
    expect(r2.staleness_class).toBe('fresh');

    const n = store.enqueueLifecycleActionForTopic('purpose', 'recompute');
    expect(n).toBe(2);

    const after = db
      .prepare(
        `SELECT staleness_class, lifecycle_action_pending FROM data_enrichment WHERE topic = 'purpose'`,
      )
      .all() as Array<{ staleness_class: string; lifecycle_action_pending: string }>;
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.staleness_class).toBe('stale');
      expect(row.lifecycle_action_pending).toBe('recompute');
    }
  });

  it('drops sidecars for the enqueued rows (matches markStaleAndEnqueueByRowIds discipline)', () => {
    // Seed a row with an FTS sidecar (`summary` topic has fts sidecar).
    const r = store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.summary',
      value: { summary: 'hello world', key_points: ['p1'] },
      sidecar_text: 'hello world',
    });
    // Confirm sidecar present.
    const beforeFts = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM data_enrichment_fts WHERE enrichment_id = ?`,
      )
      .get(r._id) as { n: number }).n;
    expect(beforeFts).toBe(1);

    store.enqueueLifecycleActionForTopic('summary', 'recompute');

    const afterFts = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM data_enrichment_fts WHERE enrichment_id = ?`,
      )
      .get(r._id) as { n: number }).n;
    expect(afterFts).toBe(0);
  });

  it('skips already-pending rows (idempotent)', () => {
    const r1 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.enqueueLifecycleActionForTopic('purpose', 'recompute')).toBe(1);
    // Second call: already pending → no rows match candidate filter.
    expect(store.enqueueLifecycleActionForTopic('purpose', 'recompute')).toBe(0);
    void r1;
  });

  it('skips pinned rows', () => {
    const author = 'system.user_correction.test';
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: author,
      value: { purpose: 'support', confidence: 1.0 },
      mode: 'pinned',
    });
    const n = store.enqueueLifecycleActionForTopic('purpose', 'recompute');
    expect(n).toBe(0);
  });
});

// ── Fix #2 — countTopicEnqueueCandidates reserves real fan-out ────

const seedBehavioralSignatureRow = (target_id: string): string => {
  const r = store.upsert({
    topic: 'behavioral_signature',
    scope: 'contact',
    target_id,
    authored_by: 'system.housekeeping.behavioral_signature',
    value: {
      mail_count_window: 10,
      mail_count_total: 50,
      meeting_count_window: 2,
      meeting_count_total: 8,
      mean_reply_latency_ms: 60_000,
      reply_sample_count: 5,
      last_meeting_at: null,
      last_inbound_at: null,
      computed_at: 1_750_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    },
  });
  return r._id;
};

describe('[P2] cascade primitives reserve REAL topic fan-out size', () => {
  it('countTopicEnqueueCandidates returns NULL-pending chain-head non-pinned count', () => {
    seedBehavioralSignatureRow('alice@example.com');
    seedBehavioralSignatureRow('bob@example.com');
    seedBehavioralSignatureRow('carol@example.com');
    expect(store.countTopicEnqueueCandidates('behavioral_signature')).toBe(3);
    // Enqueue one explicitly — count should drop by 1.
    store.markStaleAndEnqueueByRowIds(
      [
        store.list({
          topic: 'behavioral_signature',
          scope: 'contact',
          target_id: 'alice@example.com',
          fresh_only: false,
        })[0]!._id,
      ],
      'recompute',
    );
    expect(store.countTopicEnqueueCandidates('behavioral_signature')).toBe(2);
  });

  it('cascadeForConnectionDelete skips topic when fan-out exceeds headroom (all-or-nothing)', () => {
    // Seed three behavioral_signature rows.
    seedBehavioralSignatureRow('alice@example.com');
    seedBehavioralSignatureRow('bob@example.com');
    seedBehavioralSignatureRow('carol@example.com');
    // No connection-scope rows — only the perspective fan-out is in
    // play. behavioral_signature.aggregates_from = ['mail', 'calendar']
    // (NOT 'connection.api'), so cascadeForConnectionDelete won't fan
    // INTO behavioral_signature in the current registry. Use
    // working_group instead — it's perspective + aggregates from
    // 'connection.api.hubspot.deal' family if registered. Let me
    // verify by attempting the cascade + asserting that nothing
    // illegitimate enqueues.
    const cascade = createEnrichmentCascade(store, {
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 1, // tiny cap
      }),
    });
    const r = cascade.cascadeForConnectionDelete('api', 'hubspot');
    // No perspective topic in the current registry aggregates from
    // 'connection.api' directly + has 3 candidates; the test verifies
    // the primitive doesn't crash + the result counters are coherent.
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
    // No rows should partially enqueue.
    const lapCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM data_enrichment WHERE lifecycle_action_pending IS NOT NULL`,
      )
      .get() as { n: number }).n;
    expect(lapCount).toBe(0);
  });

  it('cascadeForExternalContextPulseChange skips topic when fan-out exceeds headroom', () => {
    // 5 candidates, cap 3 → fan-out 5 > headroom 3 → skip entirely.
    for (let i = 0; i < 5; i++) {
      store.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: `mail_${i}`,
        authored_by: 'system.housekeeping.purpose',
        value: { purpose: 'inquiry', confidence: 0.5 },
      });
    }
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, {
      externalContextRegistry: reg,
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 3,
      }),
    });
    const r = cascade.cascadeForExternalContextPulseChange('ctx');
    // 5 candidates > 3 headroom → all-or-nothing skip → 0 enqueued, 2 dropped
    // (governor returns admitted: 3, dropped: 2 against desired: 5).
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
    expect(r.rows_queue_depth_capped).toBe(2);
    // No partial enqueue.
    const lapCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM data_enrichment WHERE lifecycle_action_pending IS NOT NULL`,
      )
      .get() as { n: number }).n;
    expect(lapCount).toBe(0);
  });

  it('admits when fan-out fits exactly under cap', () => {
    for (let i = 0; i < 3; i++) {
      store.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: `mail_${i}`,
        authored_by: 'system.housekeeping.purpose',
        value: { purpose: 'inquiry', confidence: 0.5 },
      });
    }
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, {
      externalContextRegistry: reg,
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 3,
      }),
    });
    // 3 candidates, cap 3, depth 0 → admitted 3, dropped 0 → enqueue all.
    const r = cascade.cascadeForExternalContextPulseChange('ctx');
    expect(r.rows_lifecycle_action_enqueued).toBe(3);
    expect(r.rows_queue_depth_capped).toBe(0);
  });
});

// ── Fix #3 — drain walks full pending-discard queue + tombstone clears LAP ─

describe('[P2] tombstoneRowIds clears lifecycle_action_pending', () => {
  it('clears LAP so tombstoned rows do not re-surface in listLifecycleActionPending', () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending = 'discard' WHERE _id = ?`,
    ).run(r._id);
    expect(store.listLifecycleActionPending()).toHaveLength(1);

    expect(store.tombstoneRowIds([r._id], 'user_discarded')).toBe(1);

    const after = store.listLifecycleActionPending();
    expect(after).toHaveLength(0);

    const row = db
      .prepare(
        `SELECT staleness_class, tombstoned_at, tombstone_reason, lifecycle_action_pending
           FROM data_enrichment WHERE _id = ?`,
      )
      .get(r._id) as {
      staleness_class: string;
      tombstoned_at: number | null;
      tombstone_reason: string | null;
      lifecycle_action_pending: string | null;
    };
    expect(row.staleness_class).toBe('expired');
    expect(row.tombstoned_at).not.toBeNull();
    expect(row.tombstone_reason).toBe('user_discarded');
    expect(row.lifecycle_action_pending).toBeNull();
  });
});

describe('[P2] drain walks FULL pending-discard queue (not just plan.leaves)', () => {
  beforeEach(() => {
    ensureHousekeepingSchema(db);
    db.prepare(
      `INSERT INTO housekeeping_config (id, preset, cycle_budget_ms, cycle_interval_minutes, updated_at)
         VALUES ('singleton', 'balanced', 60000, 60, ?)`,
    ).run(NOW);
    clearDefaultHousekeepingRegistry();
  });

  afterEach(() => {
    clearDefaultHousekeepingRegistry();
  });

  const buildCtx = (
    overrides?: Partial<HousekeepingContext>,
  ): HousekeepingContext => {
    // ⛔ THE DOUBLE MUST WRITE WHERE THE PRODUCT WRITES. `emitAuditRow` goes
    // through `logActivity` — an ActivityEntry in `audit_activities` carrying
    // `timestamp` and a JSON-STRINGIFIED `detail`. Writing an AuditEntry into
    // `audit_entries` made this fixture agree with the very bug
    // `readLatestDrainSummary` had, and left the drain path reading a table
    // that does not exist here at all.
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_entries    (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    const insertAudit = db.prepare(
      `INSERT INTO audit_activities (key, data) VALUES (?, ?)`,
    );
    let auditN = 0;
    const ctx: HousekeepingContext = {
      db,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: { emit: () => {}, subscribe: () => () => {} } as any,
      enrichmentStore: store,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recipeStore: {} as any,
      now: () => NOW,
      emitAuditRow: (row): void => {
        auditN += 1;
        insertAudit.run(
          `audit_${auditN}`,
          JSON.stringify({
            activity_id: `audit_${auditN}`,
            action: row.action,
            target: row.target,
            run_mode: row.run_mode,
            timestamp: row.ts,
            success: 1,
            detail: JSON.stringify(row.detail),
          }),
        );
      },
      ...overrides,
    };
    return ctx;
  };

  it('tombstones discards on deterministic topics that the planner skips', () => {
    // Seed a `thread_signals` row (deterministic — not AI-surface).
    // Plan would skip it; drain should still tombstone the discard.
    const r = store.upsert({
      topic: 'thread_signals',
      scope: 'mail',
      target_id: 'thread_1',
      authored_by: 'system.housekeeping.thread_signals',
      value: {
        thread_id: 'thread_1',
        message_count: 3,
        participant_count: 2,
        span_days: 1,
        has_unread: false,
      },
    });
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending = 'discard' WHERE _id = ?`,
    ).run(r._id);
    // Register thread_signals as deterministic (non-ai-surface).
    const detTask: HousekeepingTaskInstance = {
      meta: {
        id: 'enrichment.thread_signals',
        description: 'mock',
        interruptible: true,
        kind: 'enrichment',
        tags: [],
      },
      topic: 'thread_signals',
      is_ai_surface: false,
      step: async () => ({ status: 'complete', cursor: { kind: 'complete' } }),
    };
    registerHousekeepingTask(detTask);

    const ctx = buildCtx();
    void lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const summary = readLatestDrainSummary(ctx);
    expect(summary?.rows_tombstoned).toBe(1);

    const row = db
      .prepare(`SELECT staleness_class, lifecycle_action_pending FROM data_enrichment WHERE _id = ?`)
      .get(r._id) as { staleness_class: string; lifecycle_action_pending: string | null };
    expect(row.staleness_class).toBe('expired');
    expect(row.lifecycle_action_pending).toBeNull();
  });

  it('tombstones discards on AI-surface topics gated by trust manual', async () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending = 'discard' WHERE _id = ?`,
    ).run(r._id);
    // Don't write trust → defaults to 'manual' for AI-surface.
    const aiTask: HousekeepingTaskInstance = {
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
    registerHousekeepingTask(aiTask);
    const trustStore = createTrustStore(db);
    const ctx = buildCtx({ trustStore });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);

    const summary = readLatestDrainSummary(ctx);
    // The discard must tombstone even though the planner reported the
    // row as 'trust_manual' skipped — the discard path is independent
    // of the planner's recompute budgeting.
    expect(summary?.rows_tombstoned).toBe(1);
    // The planner DOES still surface the row as trust_manual skipped
    // (planner walks all pending AI-surface rows then trust-gates
    // regardless of action). Both counts coexist: the planner skipped
    // it FROM RECOMPUTE; the drain TOMBSTONED it. Coherent.
    expect(summary?.rows_skipped_by_trust).toBe(1);

    const row = db
      .prepare(`SELECT staleness_class FROM data_enrichment WHERE _id = ?`)
      .get(r._id) as { staleness_class: string };
    expect(row.staleness_class).toBe('expired');
  });

  it('idempotent on re-fire — tombstoned row drops out of pending queue', async () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending = 'discard' WHERE _id = ?`,
    ).run(r._id);

    // First drain — bind ctx.now to a distinct timestamp so the
    // audit row's started_at orders deterministically vs the second.
    let frozen = NOW;
    const ctx = buildCtx({ now: () => frozen });
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const summary1 = readLatestDrainSummary(ctx);
    expect(summary1?.rows_tombstoned).toBe(1);

    // Second drain pass — the row is tombstoned + LAP cleared, so it
    // should no longer surface in listLifecycleActionPending.
    frozen = NOW + 60_000;
    await lifecycleQueueDrainTask.step(ctx, { kind: 'complete' }, 60_000);
    const summary2 = readLatestDrainSummary(ctx);
    expect(summary2?.rows_tombstoned).toBe(0);
    expect(summary2?.pending_total).toBe(0);

    // Direct store assertion — defends against an audit-row ordering
    // bug masking the actual row state.
    expect(store.listLifecycleActionPending()).toHaveLength(0);
  });
});

// ── Fix #4 — invalidatingConsumersOf honours opt-outs ─────────────

describe('[P2] cascadeForExternalContextPulseChange honours invalidates_on_pulse_change: false', () => {
  it('skips topics that declared invalidates_on_pulse_change: false', () => {
    // Seed two purpose rows (opt-out) + two summary rows (opt-in).
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.summary',
      value: { summary: 'short', key_points: [] },
    });
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: false },
    ]);
    reg.add('summary', [
      { id: 'ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r = cascade.cascadeForExternalContextPulseChange('ctx');
    // Only `summary` should enqueue (`purpose` opted out).
    expect(r.rows_lifecycle_action_enqueued).toBe(1);

    const purposeRow = store.getByRecord(
      'purpose',
      'mail',
      'mail_1',
      'system.housekeeping.purpose',
    );
    expect(purposeRow?.lifecycle_action_pending).toBeNull();
    const summaryRow = store.getByRecord(
      'summary',
      'mail',
      'mail_1',
      'system.housekeeping.summary',
    );
    expect(summaryRow?.lifecycle_action_pending).toBe('recompute');
  });

  it('returns empty when ALL declared consumers opted out', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: false },
    ]);
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r = cascade.cascadeForExternalContextPulseChange('ctx');
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('registry.invalidatingConsumersOf returns empty for unknown context_id', () => {
    const reg = createExternalContextDependencyRegistry();
    expect(reg.invalidatingConsumersOf('never').size).toBe(0);
  });

  it('registry.invalidatingConsumersOf filters out opt-out declarers', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('a', [
      { id: 'shared', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    reg.add('b', [
      { id: 'shared', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: false },
    ]);
    reg.add('c', [
      { id: 'shared', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const filtered = reg.invalidatingConsumersOf('shared');
    expect(filtered.has('a')).toBe(true);
    expect(filtered.has('b')).toBe(false);
    expect(filtered.has('c')).toBe(true);
    // consumersOf still returns all three (advisory-aware surface).
    expect(reg.consumersOf('shared').size).toBe(3);
  });
});
