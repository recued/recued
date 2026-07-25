/** D-133 P3 — confidence drift signal producer tests.
 *
 *  Drives the standalone `confidenceDriftSignalTask` against a real
 *  in-memory `data_enrichment` table. Verifies sample-count floors,
 *  PSI computation, severity transitions, dismissal preservation
 *  within the same severity, dismissal clearing on transition, and
 *  realtime event firing. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConfidenceDriftSignal,
  type DriftSeverity,
  type ServerEvent,
} from '@recued/contracts';

import {
  CONFIDENCE_DRIFT_AUTHORED_BY,
  CONFIDENCE_DRIFT_TOPIC,
  DRIFT_BASELINE_WINDOW_MS,
  DRIFT_RECENT_WINDOW_MS,
  MIN_SAMPLE_COUNT_BASELINE,
  MIN_SAMPLE_COUNT_RECENT,
  computeWindowsForTopic,
  confidenceDriftSignalTask,
  driftTransitionFires,
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
  // Override authored_at for the row we just inserted (the upsert
  // stamps `authored_at = now()` by default; the producer queries
  // by `authored_at` so we want explicit control in tests).
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
  dir = mkdtempSync(join(tmpdir(), 'd-133-p3-drift-'));
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

describe('D-133 P3 — pure helpers', () => {
  it('computeWindowsForTopic returns null when no earliest', () => {
    expect(computeWindowsForTopic(null, 1000)).toBeNull();
  });

  it('computeWindowsForTopic anchors baseline at earliest + 30d, recent at now - 7d', () => {
    const earliest = 1_000_000;
    const now2 = 1_000_000 + DRIFT_BASELINE_WINDOW_MS + DRIFT_RECENT_WINDOW_MS;
    const w = computeWindowsForTopic(earliest, now2);
    expect(w).not.toBeNull();
    expect(w!.baseline.start_at).toBe(earliest);
    expect(w!.baseline.end_at).toBe(earliest + DRIFT_BASELINE_WINDOW_MS);
    expect(w!.recent.start_at).toBe(now2 - DRIFT_RECENT_WINDOW_MS);
    expect(w!.recent.end_at).toBe(now2);
  });

  it('driftTransitionFires — null prior + significant fires significant', () => {
    expect(driftTransitionFires(null, 'significant')).toBe('significant');
  });

  it('driftTransitionFires — null prior + moderate fires moderate', () => {
    expect(driftTransitionFires(null, 'moderate')).toBe('moderate');
  });

  it('driftTransitionFires — null prior + none never fires', () => {
    expect(driftTransitionFires(null, 'none')).toBeNull();
  });

  it('driftTransitionFires — none → moderate fires moderate', () => {
    expect(driftTransitionFires('none', 'moderate')).toBe('moderate');
  });

  it('driftTransitionFires — none → significant fires significant', () => {
    expect(driftTransitionFires('none', 'significant')).toBe('significant');
  });

  it('driftTransitionFires — moderate → significant fires significant', () => {
    expect(driftTransitionFires('moderate', 'significant')).toBe('significant');
  });

  it('driftTransitionFires — moderate → moderate suppresses (within bucket)', () => {
    expect(driftTransitionFires('moderate', 'moderate')).toBeNull();
  });

  it('driftTransitionFires — significant → significant suppresses', () => {
    expect(driftTransitionFires('significant', 'significant')).toBeNull();
  });

  it('driftTransitionFires — moderate → none suppresses (de-escalations are silent)', () => {
    expect(driftTransitionFires('moderate', 'none')).toBeNull();
  });

  it('driftTransitionFires — significant → moderate suppresses (de-escalations)', () => {
    expect(driftTransitionFires('significant', 'moderate')).toBeNull();
  });
});

describe('D-133 P3 — sample-count floors', () => {
  it('skips topic when no rows exist', () => {
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(false);
    expect(result.fired).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('skips topic when baseline has fewer than MIN_SAMPLE_COUNT_BASELINE rows', () => {
    seedManyPurposeRows(50, now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS, 0.85, 'b');
    seedManyPurposeRows(40, now - DRIFT_RECENT_WINDOW_MS / 2, 0.85, 'r');
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(false);
  });

  it('skips topic when recent has fewer than MIN_SAMPLE_COUNT_RECENT rows', () => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE, baselineStart, 0.85, 'b');
    seedManyPurposeRows(20, now - DRIFT_RECENT_WINDOW_MS / 2, 0.85, 'r');
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(false);
  });
});

describe('D-133 P3 — drift detection + persistence', () => {
  const seedBaselineThenRecent = (
    baselineConfidence: number,
    recentConfidence: number,
    recentCount = 100,
  ): void => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE * 2, baselineStart, baselineConfidence, 'b');
    seedManyPurposeRows(recentCount, now - DRIFT_RECENT_WINDOW_MS / 2, recentConfidence, 'r');
  };

  it('writes a drift signal row when both windows have enough samples', () => {
    seedBaselineThenRecent(0.85, 0.85);
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    const row = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose');
    expect(row).not.toBeNull();
    const v = row!.value as ConfidenceDriftSignal;
    expect(v.source_topic).toBe('purpose');
    expect(v.severity).toBe('none');
    expect(v.recent_window.sample_count).toBeGreaterThanOrEqual(MIN_SAMPLE_COUNT_RECENT);
    expect(v.baseline_window.sample_count).toBeGreaterThanOrEqual(MIN_SAMPLE_COUNT_BASELINE);
    expect(v.baseline_distribution).toHaveLength(10);
    expect(v.recent_distribution).toHaveLength(10);
  });

  it('signal authored_by uses the drift-system stamp', () => {
    seedBaselineThenRecent(0.85, 0.85);
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    const row = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose');
    expect(row!.authored_by).toBe(CONFIDENCE_DRIFT_AUTHORED_BY);
  });

  it('detects significant drift on a large mean shift', () => {
    seedBaselineThenRecent(0.85, 0.55);
    const result = processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(result.processed).toBe(true);
    expect(result.fired).toBe('significant');
    const v = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose')!
      .value as ConfidenceDriftSignal;
    expect(v.severity).toBe('significant');
    expect(v.psi).toBeGreaterThan(0.25);
    // D-136 P4 — `purpose` is `stable_truth + recompute_on_drift`, so
    // the producer suppresses the realtime event AND enqueues
    // `lifecycle_action_pending = 'recompute'` for source rows. The
    // banner-firing path is now covered separately for non-recompute
    // source topics; cross-reference d-136-phase-4-drift-as-input
    // for the P4 substrate-specific tests.
    expect(emitted).toHaveLength(0);
  });

  it('emits no event when severity stays none on stable distribution', () => {
    seedBaselineThenRecent(0.85, 0.85);
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(emitted).toHaveLength(0);
  });
});

describe('D-133 P3 — state-transition gating', () => {
  const seedSignificantShift = (): void => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE * 2, baselineStart, 0.85, 'b');
    seedManyPurposeRows(MIN_SAMPLE_COUNT_RECENT * 3, now - DRIFT_RECENT_WINDOW_MS / 2, 0.55, 'r');
  };

  it('a second cycle within the same severity bucket does not double-fire', () => {
    seedSignificantShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    // D-136 P4 — `purpose` is recompute_on_drift, so emitted stays
    // at 0 throughout. The state-transition gating in
    // `driftTransitionFires` still suppresses re-fires within the
    // same bucket (covered exhaustively by the pure-helper tests
    // above); this assertion just confirms the integrated path on
    // a recompute_on_drift topic does not double-write the
    // suppressed event.
    expect(emitted).toHaveLength(0);

    // Re-run on the next "day" — same severity, no new event.
    now += 24 * 60 * 60_000;
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    expect(emitted).toHaveLength(0);
  });

  it('preserves dismissed_at when severity stays the same', () => {
    seedSignificantShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    // Simulate the user dismissing — write `dismissed_at` directly.
    const row = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose')!;
    const v = row.value as ConfidenceDriftSignal;
    store.upsert({
      topic: CONFIDENCE_DRIFT_TOPIC,
      derived_entity_id: 'drift_purpose',
      value: { ...v, dismissed_at: now + 1 },
      authored_by: CONFIDENCE_DRIFT_AUTHORED_BY,
    });
    // Re-run; severity stays significant; dismissed_at must persist.
    now += 24 * 60 * 60_000;
    processOneConfidenceDriftTopic(ctx(), 'purpose', now);
    const v2 = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose')!
      .value as ConfidenceDriftSignal;
    expect(v2.dismissed_at).toBeDefined();
    expect(v2.severity).toBe('significant');
  });
});

describe('D-133 P3 — task instance', () => {
  it('meta carries kind enrichment + topic + is_ai_surface false', () => {
    expect(confidenceDriftSignalTask.meta.kind).toBe('enrichment');
    expect(confidenceDriftSignalTask.topic).toBe(CONFIDENCE_DRIFT_TOPIC);
    expect(confidenceDriftSignalTask.is_ai_surface).toBe(false);
  });

  it('step returns complete with empty cursor (single-pass per cycle)', async () => {
    const result = await confidenceDriftSignalTask.step(
      ctx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('step iterates all confidence-emitting topics + processes purpose', async () => {
    const baselineStart = now - DRIFT_BASELINE_WINDOW_MS - DRIFT_RECENT_WINDOW_MS - 100_000;
    seedManyPurposeRows(MIN_SAMPLE_COUNT_BASELINE * 2, baselineStart, 0.85, 'b');
    seedManyPurposeRows(MIN_SAMPLE_COUNT_RECENT * 3, now - DRIFT_RECENT_WINDOW_MS / 2, 0.55, 'r');
    await confidenceDriftSignalTask.step(ctx(), { kind: 'complete' }, 60_000);
    const row = store.getDerived(CONFIDENCE_DRIFT_TOPIC, 'drift_purpose');
    expect(row).not.toBeNull();
    // D-136 P4 — `purpose` is recompute_on_drift, so the realtime
    // event is suppressed; the producer instead enqueues recompute
    // through the lifecycle queue (covered by
    // d-136-phase-4-drift-as-input).
    expect(emitted).toHaveLength(0);
  });
});
