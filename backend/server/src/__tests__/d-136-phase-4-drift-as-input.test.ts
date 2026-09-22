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
 *       that source topic; the realtime event ALSO fires, carrying
 *       `recompute_enqueued: true` (D-283 restored it — P4 had
 *       suppressed it, which hid the topic-wide spend).
 *    3. PSI `'moderate'` transition on the same topic does NOT
 *       enqueue (only `'significant'` enqueues per spec §P4) but
 *       DOES raise the banner, without the `recompute_enqueued` flag
 *       (D-283).
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
  confidenceDriftSignalTask,
  processOneConfidenceDriftTopic,
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

describe('D-284 — a drift fire enqueues NOTHING', () => {
  /** ⛔⛔ THREE SUITES WERE REMOVED HERE, NOT FLIPPED, because the thing
   *  they tested no longer exists: the `sourceTopicAutoRecomputesOnDrift`
   *  closed list (helper deleted), the producer's enqueue-on-significant,
   *  and the round-12 governor call that admitted that enqueue. What
   *  replaces them is one guard on the property that now holds.
   *
   *  🔑 THE INVARIANT: a stored AI result is invalidated by a change to
   *  the QUESTION — input content, or the prompt/producer asking it — or
   *  by the user saying so. Never by a change in who answered or how they
   *  have been answering lately. D-275 applied it to the dedup key, D-279
   *  to the comparison; this was the last place it did not hold.
   *
   *  ⚠ Content-change already covers what matters: `purpose` fingerprints
   *  on `per_record_source_hash`, so an edited body misses the dedup probe
   *  and the next cycle recomputes that row unaided. Drift added exactly
   *  one case — re-ask an UNCHANGED input — and that measured 0/20
   *  category changes over three runs with no convergence.
   *
   *  ⏭ Detection is untouched: the banner still fires (D-283). */
  /** A refusal-rate crossing, so D-281's proportion test is what decides —
   *  the primary path, not the PSI fallback. */
  const seedSignificantShift = (): void => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE * 2, baselineStart, 0.9, 'b');
    seedManyPurposeRows(MIN_SAMPLE_COUNT_RECENT * 3, now - DRIFT_RECENT_WINDOW_MS / 2, 0.2, 'r');
  };

  it('a significant transition on purpose writes the signal and queues no rows', () => {
    seedSignificantShift();
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.fired).toBe('significant');

    // The drift row itself is written…
    expect(store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose')).not.toBeNull();

    // …and not one source row was marked for recompute.
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM data_enrichment
          WHERE topic = 'purpose' AND lifecycle_action_pending IS NOT NULL`,
      )
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it('and the banner still fires — detection was never the thing removed', () => {
    seedSignificantShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: 'enrichment_drift_detected',
      source_topic: 'purpose',
      severity: 'significant',
    });
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
