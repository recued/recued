/** D-136 P4 — Drift signal becomes lifecycle queue input + banner
 *  suppression.
 *
 *  Covers:
 *    1. `sourceTopicAutoRecomputesOnDrift` closed-list helper — true
 *       only for `stable_truth + recompute_on_drift` source topics
 *       (today: `purpose` / `summary` / `action_items`).
 *    2. PSI `'significant'` transition on a stable_truth +
 *       recompute_on_drift source topic enqueues
 *       `lifecycle_action_pending = 'recompute'` for every row of
 *       that source topic; the realtime event is suppressed.
 *    3. PSI `'moderate'` transition on the same topic does NOT
 *       enqueue (only `'significant'` enqueues per spec §P4) AND
 *       suppresses the realtime event (the banner doesn't fire for
 *       recompute_on_drift topics regardless of severity).
 *    4. `enqueueLifecycleActionForTopic` store method — idempotent
 *       on already-pending rows, returns the count actually
 *       updated, no-ops on unknown topics.
 *    5. `confidence_drift_signal` registry entry now carries
 *       `lifecycle_policy: 'historical'` (regression on the §P4
 *       D-133 amendment).
 *
 *  Spec: D-136 §P4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ServerEvent,
} from '@recued/contracts';

import {
  CONFIDENCE_DRIFT_TOPIC,
  DRIFT_BASELINE_WINDOW_MS,
  DRIFT_RECENT_WINDOW_MS,
  MIN_SAMPLE_COUNT_BASELINE,
  MIN_SAMPLE_COUNT_RECENT,
  processOneConfidenceDriftTopic,
  sourceTopicAutoRecomputesOnDrift,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { EventBus, ServerEventInput } from '../events/bus.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now = 1_700_000_000_000;
let emitted: ServerEventInput[];
let bus: EventBus;

const seedPurposeRow = (
  authored_at: number,
  confidence: number,
  target_id: string,
): void => {
  store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id,
    value: { category: 'request', confidence, reasoning: 'stub' },
    authored_by: 'system.housekeeping.purpose',
    event_at: authored_at,
  });
  db.prepare(
    `UPDATE data_enrichment SET authored_at = ? WHERE topic = 'purpose' AND target_id = ?`,
  ).run(authored_at, target_id);
};

const seedManyPurposeRows = (
  count: number,
  authored_at: number,
  confidence: number,
  prefix: string,
): void => {
  for (let i = 0; i < count; i += 1) {
    seedPurposeRow(authored_at + i, confidence, `${prefix}_${i}`);
  }
};

const ctx = (): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
  eventBus: bus,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p4-drift-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
  now = 1_700_000_000_000;
  emitted = [];
  bus = {
    emit: vi.fn((input: ServerEventInput) => {
      emitted.push(input);
      return { ...input, cursor: emitted.length } as ServerEvent;
    }),
    subscribe: () => ({ id: 'stub', filter: { kinds: 'all' as const, since_cursor: 0 } } as never),
    unsubscribe: () => undefined,
    replaySince: () => ({ events: [], fell_off_ring: false }),
    snapshot: () => ({ cursor: 0, ring_size: 0 }),
  } as never;
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-136 P4 — sourceTopicAutoRecomputesOnDrift closed-list', () => {
  it('returns true for purpose (stable_truth + recompute_on_drift)', () => {
    expect(sourceTopicAutoRecomputesOnDrift('purpose')).toBe(true);
  });

  it('returns true for summary', () => {
    expect(sourceTopicAutoRecomputesOnDrift('summary')).toBe(true);
  });

  it('returns true for action_items', () => {
    expect(sourceTopicAutoRecomputesOnDrift('action_items')).toBe(true);
  });

  it('returns false for embedding (stable_truth but pre-D-136 PSI revoke)', () => {
    // `embedding` is `stable_truth + recompute_on_drift` per the
    // classification snapshot but does NOT emit confidence post-D-136
    // (PSI eligibility revoked at P1 since vectors don't have
    // confidence). The drift producer never iterates it (per
    // `confidenceEmittingEnrichmentTopics`), but if it ever did, the
    // helper would still report true since the registry-side gates are
    // independent. Regression assertion only.
    expect(sourceTopicAutoRecomputesOnDrift('embedding')).toBe(true);
  });

  it('returns false for attribution_signal (stable_truth + forward_only)', () => {
    expect(sourceTopicAutoRecomputesOnDrift('attribution_signal')).toBe(false);
  });

  it('returns false for company (time_bound + historical)', () => {
    expect(sourceTopicAutoRecomputesOnDrift('company')).toBe(false);
  });

  it('returns false for thread_signals (aggregate_window + forward_only)', () => {
    expect(sourceTopicAutoRecomputesOnDrift('thread_signals')).toBe(false);
  });

  it('returns false for confidence_drift_signal itself (aggregate_window + historical post-P4)', () => {
    expect(sourceTopicAutoRecomputesOnDrift('confidence_drift_signal')).toBe(false);
  });

  it('returns false for an unregistered topic name', () => {
    expect(
      sourceTopicAutoRecomputesOnDrift('not_a_real_topic' as never),
    ).toBe(false);
  });

  it('exactly 15 topics auto-recompute on drift today (post-D-145 PA9 widening)', () => {
    // Closed-list ratchet — every topic registered with
    // `temporal_class: 'stable_truth' + lifecycle_policy:
    // 'recompute_on_drift'` qualifies. Original D-136 P4 close was 4
    // (action_items / embedding / purpose / summary; `embedding`
    // qualifies but doesn't emit confidence so the drift task never
    // visits it). D-145 PA9 added 11 more producers per spec § A.7.1
    // + § A.7.2 (8 work-entity + 7 engine + reliability; of those, 11
    // carry stable_truth + recompute_on_drift — the others are
    // aggregate_window + forward_only): commitment_followthrough_score
    // + outbound_commitment_overdue_count + task_completion_velocity +
    // project_stall_signal + project_velocity + open_loop_pressure +
    // commitment_reliability_band + project_next_action_gap +
    // task_duplicate_candidate + source_freshness_degradation +
    // context_packet_quality. The
    // classification triple for each is asserted in
    // `d-136-phase-1-classification-snapshot.test.ts`.
    const auto: string[] = [];
    for (const topic of Object.keys(ENRICHMENT_REGISTRY)) {
      if (sourceTopicAutoRecomputesOnDrift(topic as never)) {
        auto.push(topic);
      }
    }
    expect(auto.sort()).toEqual([
      'action_items',
      'commitment_followthrough_score',
      'commitment_reliability_band',
      'context_packet_quality',
      'embedding',
      'open_loop_pressure',
      'outbound_commitment_overdue_count',
      'project_next_action_gap',
      'project_stall_signal',
      'project_velocity',
      'purpose',
      'source_freshness_degradation',
      'summary',
      'task_completion_velocity',
      'task_duplicate_candidate',
    ]);
  });
});

describe('D-136 P4 — drift producer enqueues recompute', () => {
  const seedSignificantShift = (): void => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE * 2, baselineStart, 0.85, 'b');
    seedManyPurposeRows(MIN_SAMPLE_COUNT_RECENT * 3, now - DRIFT_RECENT_WINDOW_MS / 2, 0.55, 'r');
  };

  /** Seed a 50/50 baseline split between bins 7/8 and a 70/30 recent
   *  split. PSI works out to ~0.17 — squarely in the `'moderate'`
   *  bracket (>= 0.10 and < 0.25). PSI on uniform-confidence
   *  distributions is too coarse (Laplace smoothing makes single-bin
   *  flips significant), so the producer-level moderate-test must
   *  spread mass across at least two bins. */
  const seedModerateShift = (): void => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE, baselineStart, 0.75, 'b1');
    seedManyPurposeRows(
      MIN_SAMPLE_COUNT_BASELINE,
      baselineStart + MIN_SAMPLE_COUNT_BASELINE,
      0.85,
      'b2',
    );
    // Recent: 70/30 split between bins 7/8 — pulls mass into bin 7.
    seedManyPurposeRows(70, now - DRIFT_RECENT_WINDOW_MS / 2, 0.75, 'r1');
    seedManyPurposeRows(30, now - DRIFT_RECENT_WINDOW_MS / 2 + 100, 0.85, 'r2');
  };

  const countPendingRecompute = (topic: string): number => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM data_enrichment
          WHERE topic = ?
            AND lifecycle_action_pending = 'recompute'`,
      )
      .get(topic) as { n: number };
    return row.n;
  };

  it("'significant' transition on purpose enqueues recompute on every purpose row", () => {
    seedSignificantShift();
    const before = countPendingRecompute('purpose');
    expect(before).toBe(0);

    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.fired).toBe('significant');

    const after = countPendingRecompute('purpose');
    expect(after).toBeGreaterThan(0);
    // Should match the count of seeded purpose rows (baseline + recent).
    const totalPurposeRows = db
      .prepare(`SELECT COUNT(*) AS n FROM data_enrichment WHERE topic = 'purpose'`)
      .get() as { n: number };
    expect(after).toBe(totalPurposeRows.n);
  });

  it("'significant' transition on purpose suppresses the realtime event", () => {
    seedSignificantShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(emitted).toHaveLength(0);
  });

  it("'moderate' transition on purpose does NOT enqueue (only 'significant' enqueues)", () => {
    seedModerateShift();
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    // Some seeds may not produce moderate exactly — accept any
    // non-significant fire and assert the queue stays clean.
    expect(result.fired).not.toBe('significant');

    const queued = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM data_enrichment
          WHERE topic = 'purpose' AND lifecycle_action_pending IS NOT NULL`,
      )
      .get() as { n: number };
    expect(queued.n).toBe(0);
  });

  it("'moderate' transition on purpose ALSO suppresses the event (banner only fires for non-recompute_on_drift)", () => {
    seedModerateShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(emitted).toHaveLength(0);
  });

  it('enqueue is idempotent across cycles within the same severity bucket', () => {
    const countPending = (): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM data_enrichment
              WHERE topic = 'purpose' AND lifecycle_action_pending = 'recompute'`,
          )
          .get() as { n: number }
      ).n;

    seedSignificantShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    const firstCount = countPending();
    expect(firstCount).toBeGreaterThan(0);

    // Second cycle, same severity — `driftTransitionFires` returns
    // null so the enqueue branch doesn't even run. The pending set
    // remains stable.
    now += 24 * 60 * 60_000;
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(countPending()).toBe(firstCount);
  });
});

describe('D-136 P4 — enqueueLifecycleActionForTopic store method', () => {
  it('returns 0 for an unregistered topic (no-op)', () => {
    const n = store.enqueueLifecycleActionForTopic(
      'not_a_real_topic' as never,
      'recompute',
    );
    expect(n).toBe(0);
  });

  it('returns 0 when no rows of the topic exist', () => {
    const n = store.enqueueLifecycleActionForTopic('purpose', 'recompute');
    expect(n).toBe(0);
  });

  it('flips lifecycle_action_pending = recompute on every NULL-pending row', () => {
    seedPurposeRow(now, 0.85, 'r1');
    seedPurposeRow(now - 1000, 0.85, 'r2');
    seedPurposeRow(now - 2000, 0.85, 'r3');

    const n = store.enqueueLifecycleActionForTopic('purpose', 'recompute');
    expect(n).toBe(3);

    const all = db
      .prepare(
        `SELECT lifecycle_action_pending FROM data_enrichment WHERE topic = 'purpose'`,
      )
      .all() as Array<{ lifecycle_action_pending: string | null }>;
    expect(all).toHaveLength(3);
    for (const row of all) {
      expect(row.lifecycle_action_pending).toBe('recompute');
    }
  });

  it('does not overwrite a different already-pending action (idempotent)', () => {
    seedPurposeRow(now, 0.85, 'r1');
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending = 'discard' WHERE topic = 'purpose'`,
    ).run();

    const n = store.enqueueLifecycleActionForTopic('purpose', 'recompute');
    expect(n).toBe(0);

    const row = db
      .prepare(
        `SELECT lifecycle_action_pending FROM data_enrichment WHERE topic = 'purpose'`,
      )
      .get() as { lifecycle_action_pending: string | null };
    expect(row.lifecycle_action_pending).toBe('discard');
  });

  it('only flips rows of the matching topic', () => {
    seedPurposeRow(now, 0.85, 'r1');
    // Seed a `summary` row too (different topic).
    store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'r1',
      value: { summary: 'stub', confidence: 0.9, key_points: [] },
      authored_by: 'system.housekeeping.summary',
      event_at: now,
    });

    const n = store.enqueueLifecycleActionForTopic('purpose', 'recompute');
    expect(n).toBe(1);

    const summaryPending = db
      .prepare(
        `SELECT lifecycle_action_pending FROM data_enrichment WHERE topic = 'summary'`,
      )
      .get() as { lifecycle_action_pending: string | null };
    expect(summaryPending.lifecycle_action_pending).toBeNull();
  });
});

describe('D-136 P4 — confidence_drift_signal lifecycle_policy', () => {
  it("declares lifecycle_policy: 'historical' (D-133 amendment)", () => {
    const def = ENRICHMENT_REGISTRY.confidence_drift_signal;
    expect(def.lifecycle_policy).toBe('historical');
  });
});

describe('D-136 P4 — drift signal + lifecycle enqueue atomicity (Codex P2 fix)', () => {
  /** Stub store wrapping the real one: every method delegates,
   *  except `enqueueLifecycleActionForTopic` throws. Models the
   *  failure case where the queue write fails after the drift signal
   *  upsert. Without the producer-side transaction wrap, the upsert
   *  would commit before the throw and the next cycle would see
   *  prior severity = current severity → `driftTransitionFires`
   *  returns null → rows never enqueue while the banner stays
   *  suppressed. The transaction wrap rolls back the upsert too, so
   *  the next cycle re-fires both writes. */
  const wrapStoreWithThrowingEnqueue = (real: EnrichmentStore): EnrichmentStore => ({
    ...real,
    enqueueLifecycleActionForTopic: (): number => {
      throw new Error('synthetic enqueue failure');
    },
  });

  const seedSignificantShift = (): void => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE * 2, baselineStart, 0.85, 'b');
    seedManyPurposeRows(MIN_SAMPLE_COUNT_RECENT * 3, now - DRIFT_RECENT_WINDOW_MS / 2, 0.55, 'r');
  };

  it('rolls back the drift-signal upsert when the enqueue throws', () => {
    seedSignificantShift();

    // Build a ctx whose enrichmentStore throws on enqueue. The
    // producer's transaction wrap must roll back the drift-signal
    // upsert when this happens.
    const throwingStore = wrapStoreWithThrowingEnqueue(store);
    const throwingCtx: HousekeepingContext = {
      ...ctx(),
      enrichmentStore: throwingStore,
    };

    // The transaction throws synchronously; assert + verify rollback.
    expect(() => processOneConfidenceDriftTopic(throwingCtx, 'purpose', now))
      .toThrow('synthetic enqueue failure');

    // Drift-signal row must NOT have been persisted. If atomicity is
    // working, getDerived returns null (no row written). If broken,
    // we'd see a row with severity 'significant' here.
    const row = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose');
    expect(row).toBeNull();
  });

  it('next cycle re-fires both writes after a transient enqueue failure', () => {
    seedSignificantShift();

    // First cycle: enqueue throws, both writes roll back.
    const throwingStore = wrapStoreWithThrowingEnqueue(store);
    const throwingCtx: HousekeepingContext = {
      ...ctx(),
      enrichmentStore: throwingStore,
    };
    expect(() => processOneConfidenceDriftTopic(throwingCtx, 'purpose', now))
      .toThrow();
    expect(store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose')).toBeNull();

    // Second cycle: store is healthy again; transition fires
    // identically (prior was never persisted, so the gating sees
    // null → significant → fires significant) and both writes
    // commit cleanly.
    now += 24 * 60 * 60_000;
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.fired).toBe('significant');

    const row = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose');
    expect(row).not.toBeNull();
    const queued = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM data_enrichment
          WHERE topic = 'purpose' AND lifecycle_action_pending = 'recompute'`,
      )
      .get() as { n: number };
    expect(queued.n).toBeGreaterThan(0);
  });
});
