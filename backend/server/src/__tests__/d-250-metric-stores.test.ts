/** D-250 § D8.1 slice 1 — the two metric stores.
 *
 *  🔑 WHAT IS ACTUALLY UNDER TEST: not that a value round-trips, but that the two
 *  PRODUCTION MODELS cannot be mixed. The snapshot is replaced whole; an artifact
 *  advances. Every failure this suite is written against is one model's write reaching
 *  the other's data — a `record` in a replaced row, a reset reaching a best, a
 *  milestone re-stamped by a re-run.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { METRIC_ABSENT, METRIC_REGISTRY, metricValue } from '@recued/contracts';

import { createMetricArtifactStore } from '../metrics/artifact-store.js';
import { createMetricSnapshotStore, type MetricSnapshot } from '../metrics/snapshot-store.js';
import { METRIC_SNAPSHOT_PRIMARY_KEY } from '../metrics/schema.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-stores-'));
  db = new Database(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const snap = (over: Partial<MetricSnapshot> = {}): MetricSnapshot => ({
  computed_at: NOW,
  window: { from: NOW - 86_400_000, to: NOW },
  metrics: [{ metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.5) }],
  ...over,
});

// ────────────────────────────────────────────────────────────────
// 1. THE SNAPSHOT IS A SINGLETON, REPLACED WHOLE
// ────────────────────────────────────────────────────────────────

describe('D-250 § Open 9a — the daily snapshot', () => {
  it('round-trips', () => {
    const s = createMetricSnapshotStore(db);
    s.write(snap());
    expect(s.read()?.metrics[0]?.reading).toStrictEqual(metricValue(0.5));
  });

  it('⛔⛔ A SECOND WRITE REPLACES — there is no series and no read-back', () => {
    // Amendment 16: "always the most recent snapshot". If a second write appended,
    // Recued's metrics could become contribution-shaped by accident, which is the exact
    // thing refusing to keep history is meant to guarantee against.
    const s = createMetricSnapshotStore(db);
    s.write(snap());
    s.write(snap({ computed_at: NOW + 86_400_000, metrics: [
      { metric_id: 'autopilot', metric_version: 1, reading: metricValue(0.9) },
    ] }));
    expect(s.read()?.metrics[0]?.reading).toStrictEqual(metricValue(0.9));
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM metric_snapshot').get() as { n: number }).n,
    ).toBe(1);
  });

  it('⛔ THE SINGLETON IS ENFORCED BY THE SCHEMA, not by convention', () => {
    // A table that merely happened to hold one row would grow a series the first time
    // anything wrote with a different key.
    createMetricSnapshotStore(db);
    expect(() =>
      db.prepare('INSERT INTO metric_snapshot (id, data, computed_at) VALUES (?, ?, ?)')
        .run('2026-08-25', '{}', NOW),
    ).toThrow();
    expect(METRIC_SNAPSHOT_PRIMARY_KEY).toBe('singleton');
  });

  it('an absent reading survives the round trip as absent, never as 0', () => {
    const s = createMetricSnapshotStore(db);
    s.write(snap({ metrics: [{ metric_id: 'economy', metric_version: 1, reading: METRIC_ABSENT }] }));
    expect(s.read()?.metrics[0]?.reading.kind).toBe('absent');
  });

  it('⛔⛔ AN ARTIFACT METRIC IS REJECTED — a replaced row would erase a record', () => {
    // Burst is store: 'artifact'. Written here it would be silently overwritten by the
    // next cycle's lower observation, so a quiet week would erase a standing best. The
    // registry knows; refusing the mismatch is what stops a caller mixing the models.
    const s = createMetricSnapshotStore(db);
    expect(METRIC_REGISTRY.burst?.store).toBe('artifact');
    expect(() =>
      s.write(snap({ metrics: [{ metric_id: 'burst', metric_version: 1, reading: metricValue(47) }] })),
    ).toThrow(/cannot go in the snapshot/);
  });

  it('an unregistered metric is rejected', () => {
    const s = createMetricSnapshotStore(db);
    expect(() =>
      s.write(snap({ metrics: [{ metric_id: 'invented', metric_version: 1, reading: metricValue(1) }] })),
    ).toThrow(/not in the registry/);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. RECORDS ONLY ADVANCE
// ────────────────────────────────────────────────────────────────

describe('D-250 amendment 17 — a record advances from its own prior value', () => {
  it('⛔⛔ A LOWER OBSERVATION DOES NOT LOWER THE RECORD', () => {
    // computeActivityMetrics returns a WINDOW observation for Burst. If folding it in
    // replaced, a quiet week would erase a standing best — the failure the artifact
    // store exists to make impossible.
    const a = createMetricArtifactStore(db);
    expect(a.advanceRecord('burst', 47, NOW)).toBe(47);
    expect(a.advanceRecord('burst', 12, NOW + 1000)).toBe(47);
    expect(a.readRecord('burst')).toBe(47);
  });

  it('a higher observation advances it', () => {
    const a = createMetricArtifactStore(db);
    a.advanceRecord('burst', 47, NOW);
    expect(a.advanceRecord('burst', 60, NOW + 1000)).toBe(60);
  });

  it('is idempotent — replaying the same observation changes nothing', () => {
    const a = createMetricArtifactStore(db);
    a.advanceRecord('burst', 47, NOW);
    a.advanceRecord('burst', 47, NOW + 5000);
    expect(a.readRecord('burst')).toBe(47);
    // ⚠ And it does not re-stamp: a record's timestamp answers "when was this best
    // set", so re-stamping every cycle would make a months-old best look like today's.
    expect(a.entries().find((e) => e.key === 'burst')?.updated_at).toBe(NOW);
  });

  it('⛔ THERE IS NO GENERIC SETTER, and the counter path cannot reach a record', () => {
    // A raw set() is all it would take to undo every guarantee above.
    const a = createMetricArtifactStore(db);
    a.advanceRecord('burst', 47, NOW);
    expect(() => a.setCounter('burst', 1, NOW)).toThrow(/cannot be used as a 'counter'/);
    expect(() => a.earnMilestone('burst', NOW)).toThrow(/cannot be used as a 'once'/);
    expect(a.readRecord('burst')).toBe(47);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. MILESTONES ARE EARNED ONCE
// ────────────────────────────────────────────────────────────────

describe('D-250 amendment 17 — milestones', () => {
  it('⛔⛔ FIRST WRITE WINS — a re-run does not re-stamp the date', () => {
    // "First pack published" is a fact about a MOMENT. Re-stamping it on every cycle
    // would make it read as if it happened today, and the badge would stop being a
    // record of anything.
    const a = createMetricArtifactStore(db);
    expect(a.earnMilestone('first_pack_published', NOW)).toStrictEqual({
      newly_earned: true, earned_at: NOW,
    });
    expect(a.earnMilestone('first_pack_published', NOW + 30 * 86_400_000)).toStrictEqual({
      newly_earned: false, earned_at: NOW,
    });
  });

  it('newly_earned is the celebrate cue and fires exactly once', () => {
    const a = createMetricArtifactStore(db);
    const first = a.earnMilestone('first_peer_paired', NOW).newly_earned;
    const rest = [1, 2, 3].map((i) => a.earnMilestone('first_peer_paired', NOW + i).newly_earned);
    expect([first, ...rest]).toStrictEqual([true, false, false, false]);
  });

  it('unearned reads as absent, not as a zero date', () => {
    const a = createMetricArtifactStore(db);
    expect(a.hasMilestone('first_unattended_week')).toBe(false);
    expect(a.readMilestone('first_unattended_week')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. A STREAK IS TWO KEYS, AND THAT IS THE POINT
// ────────────────────────────────────────────────────────────────

describe('D-250 § D5.3 — Hands off is a counter plus a record', () => {
  it('⛔⛔ RESETTING THE CURRENT RUN CANNOT REACH THE LONGEST', () => {
    // One key holding both would make "the streak broke" and "the best ever" the same
    // write, so a single bad day would erase the record.
    const a = createMetricArtifactStore(db);
    a.setCounter('hands_off.current', 31, NOW);
    a.advanceRecord('hands_off.longest', 31, NOW);
    a.setCounter('hands_off.current', 0, NOW + 86_400_000); // an approval was needed
    expect(a.readCounter('hands_off.current')).toBe(0);
    expect(a.readRecord('hands_off.longest')).toBe(31);
  });

  it('a counter moves freely in both directions', () => {
    const a = createMetricArtifactStore(db);
    a.setCounter('hands_off.current', 5, NOW);
    a.setCounter('hands_off.current', 6, NOW + 1);
    a.setCounter('hands_off.current', 0, NOW + 2);
    expect(a.readCounter('hands_off.current')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. DURABILITY
// ────────────────────────────────────────────────────────────────

describe('D-250 — the stores persist across a reopen', () => {
  it('both survive, which is why the artifact store outlives audit eviction', () => {
    const path = join(dir, 'persist.db');
    const one = new Database(path);
    createMetricSnapshotStore(one).write(snap());
    createMetricArtifactStore(one).advanceRecord('burst', 47, NOW);
    one.close();

    const two = new Database(path);
    expect(createMetricSnapshotStore(two).read()?.computed_at).toBe(NOW);
    expect(createMetricArtifactStore(two).readRecord('burst')).toBe(47);
    two.close();
  });
});
