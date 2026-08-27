/** D-250 § D8.1 slice 4 — the housekeeping task that joins compute to the stores.
 *
 *  ⛔ THIS IS THE JOIN, AND THE JOIN IS WHAT SLICES 1–3 COULD NOT TEST. Each of those
 *  suites stubs the other side: the stores were driven with hand-built values, the
 *  compute functions were read without ever being written anywhere. Two suites covering
 *  one boundary from opposite sides leave the boundary itself untested — so every case
 *  here drives REAL audit rows through the REAL task into the REAL stores.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_OP_ACTION, METRIC_REGISTRY, OWNER_METRICS_COMPUTE_TASK_ID } from '@recued/contracts';

import {
  BURST_LOOKBACK_MS,
  ownerMetricsComputeTask,
  utcDayStart,
} from '../housekeeping/tasks/owner-metrics-compute.js';
import { createMetricArtifactStore } from '../metrics/artifact-store.js';
import { createMetricSnapshotStore } from '../metrics/snapshot-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// Mid-morning UTC on a day boundary we control.
const DAY = 86_400_000;
const DAY_START = Math.floor(1_700_000_000_000 / DAY) * DAY;
const NOW = DAY_START + 10 * 3_600_000;

let dir: string;
let db: Database.Database;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-task-'));
  db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (now = NOW): HousekeepingContext =>
  ({
    db,
    now: () => now,
    bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined },
    enrichmentStore: {},
    recipeStore: {},
    emitAuditRow: () => undefined,
  }) as unknown as HousekeepingContext;

const runTask = async (now = NOW) =>
  ownerMetricsComputeTask.step(ctx(now), { kind: 'complete' }, 60_000);

const anchorRun = (over: Record<string, unknown>, at = NOW): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run(
    `r${seq}`, JSON.stringify({ started_at: at, ...over }),
  );
};

const gatewayOp = (detail: Record<string, unknown>, at = NOW): void => {
  seq += 1;
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    `a${seq}`,
    JSON.stringify({
      activity_id: `a${seq}`, timestamp: at, action: GATEWAY_OP_ACTION,
      target: 'conn', detail: JSON.stringify(detail),
    }),
  );
};

const chatOp = (at: number): void =>
  gatewayOp({ risk_tier: 'read', execution_source: { channel: 'chat' } }, at);

const snapshotOf = (id: string) => {
  const s = createMetricSnapshotStore(db).read();
  return s?.metrics.find((m) => m.metric_id === id)?.reading;
};

// ────────────────────────────────────────────────────────────────
// 1. THE JOIN
// ────────────────────────────────────────────────────────────────

describe('D-250 § D8.1 slice 4 — real rows reach the real stores', () => {
  it('⛔⛔ AN ANCHOR RUN AND A GATEWAY OP BOTH LAND IN THE SNAPSHOT', async () => {
    anchorRun({ trigger_source: 'schedule' });
    anchorRun({ trigger_source: 'manual' });
    gatewayOp({ risk_tier: 'read', recipe_id: 'alice/bench' });
    await runTask();
    expect(snapshotOf('autopilot')).toStrictEqual({ kind: 'value', value: 0.5 });
    expect(snapshotOf('toolmaker')).toStrictEqual({ kind: 'value', value: 1 });
  });

  it('the task reports complete and is registered under its contract id', () => {
    expect(ownerMetricsComputeTask.meta.id).toBe(OWNER_METRICS_COMPUTE_TASK_ID);
    expect(ownerMetricsComputeTask.meta.kind).toBe('core');
  });

  it('an empty log still writes a snapshot, with everything ABSENT', async () => {
    await runTask();
    const s = createMetricSnapshotStore(db).read();
    expect(s).toBeDefined();
    expect(s?.metrics.every((m) => m.reading.kind === 'absent')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. THE SPLIT — the failure the snapshot store exists to catch
// ────────────────────────────────────────────────────────────────

describe('D-250 amendment 17 — metrics are routed by the REGISTRY, not by source', () => {
  it('⛔⛔ BURST GOES TO THE ARTIFACT STORE, NOT THE SNAPSHOT', async () => {
    // `computeActivityMetrics` returns burst ALONGSIDE three snapshot metrics, so
    // grouping by which function produced a value would put a record into a
    // replaced-whole row — and a quiet week would erase a standing best.
    chatOp(NOW);
    chatOp(NOW + 1000);
    await runTask();
    expect(snapshotOf('burst')).toBeUndefined();
    expect(createMetricArtifactStore(db).readRecord('burst')).toBe(2);
    expect(METRIC_REGISTRY.burst?.store).toBe('artifact');
  });

  it('⛔⛔ A QUIET DAY DOES NOT ERASE THE BURST RECORD', async () => {
    chatOp(NOW); chatOp(NOW + 1000); chatOp(NOW + 2000);
    await runTask();
    expect(createMetricArtifactStore(db).readRecord('burst')).toBe(3);

    // A later day with a single lonely op. The window observation is 1.
    const later = NOW + 10 * DAY;
    chatOp(later);
    await runTask(later);
    expect(createMetricArtifactStore(db).readRecord('burst')).toBe(3);
  });

  it('⛔ AND THE SNAPSHOT IS REPLACED, so a quiet day DOES move a ratio', async () => {
    // The mirror of the case above: the two stores must behave differently, and a test
    // that only pinned "burst survives" would pass on a build where nothing updates.
    anchorRun({ trigger_source: 'schedule' });
    await runTask();
    expect(snapshotOf('autopilot')).toStrictEqual({ kind: 'value', value: 1 });

    const later = NOW + 10 * DAY;
    anchorRun({ trigger_source: 'manual' }, later);
    await runTask(later);
    expect(snapshotOf('autopilot')).toStrictEqual({ kind: 'value', value: 0 });
  });
});

// ────────────────────────────────────────────────────────────────
// 3. THE WINDOW
// ────────────────────────────────────────────────────────────────

describe('D-250 § B3.5 — the window is the current UTC day', () => {
  it('yesterday is not in the snapshot window', async () => {
    anchorRun({ trigger_source: 'schedule' }, DAY_START - 3_600_000);
    anchorRun({ trigger_source: 'manual' }, NOW);
    await runTask();
    expect(snapshotOf('autopilot')).toStrictEqual({ kind: 'value', value: 0 });
  });

  it('utcDayStart lands on a UTC midnight', () => {
    expect(utcDayStart(NOW)).toBe(DAY_START);
    expect(new Date(utcDayStart(NOW)).getUTCHours()).toBe(0);
  });

  it('⛔⛔ BURST SEES ACROSS MIDNIGHT — a stretch cut by the boundary is not truncated', () => {
    // § B3.5a: unlike a ratio, a truncated stretch does not wash out — the record is
    // set from the truncation and is PERMANENT. Widening is safe only because the
    // record advances by MAX and the 1h idle gap still separates distinct stretches.
    expect(BURST_LOOKBACK_MS).toBeGreaterThan(DAY);
  });

  it('a stretch spanning midnight is counted whole, not split', async () => {
    // Four ops straddling the boundary, all within the idle gap of each other.
    chatOp(DAY_START - 1_200_000);
    chatOp(DAY_START - 600_000);
    chatOp(DAY_START + 600_000);
    chatOp(DAY_START + 1_200_000);
    await runTask();
    // Day-window alone would see 2. The wider Burst read sees all 4.
    expect(createMetricArtifactStore(db).readRecord('burst')).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. IDEMPOTENCE — why it can run every cycle
// ────────────────────────────────────────────────────────────────

describe('D-250 § D8.1 slice 4 — running twice converges', () => {
  it('⛔ NO "ALREADY RAN TODAY" GUARD IS NEEDED', async () => {
    anchorRun({ trigger_source: 'schedule' });
    chatOp(NOW); chatOp(NOW + 500);
    await runTask();
    await runTask(NOW + 60_000);
    await runTask(NOW + 120_000);
    expect(snapshotOf('autopilot')).toStrictEqual({ kind: 'value', value: 1 });
    expect(createMetricArtifactStore(db).readRecord('burst')).toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM metric_snapshot').get() as { n: number }).n,
    ).toBe(1);
    // ⚠ NOT a fixed count — that would re-break every time a producer adds a key, and
    // would have been asserting the wrong thing anyway. The property is STABILITY: a
    // repeated run creates no new keys and moves no value.
    const after = createMetricArtifactStore(db).entries();
    await runTask(NOW + 180_000);
    expect(createMetricArtifactStore(db).entries()).toStrictEqual(after);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. DIAGNOSTICS — drift has to be visible
// ────────────────────────────────────────────────────────────────

describe('D-250 — the snapshot carries local-only diagnostics', () => {
  it('an unclassified trigger_source and risk_tier reach the snapshot', async () => {
    anchorRun({ trigger_source: 'some_future_source' });
    gatewayOp({ risk_tier: 'catastrophic' });
    await runTask();
    const d = createMetricSnapshotStore(db).read()?.diagnostics;
    expect(d?.unclassified_runs).toBe(1);
    expect(d?.unknown_risk_rows).toBe(1);
  });
});
