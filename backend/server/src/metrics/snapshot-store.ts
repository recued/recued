/** D-250 § D8.1 slice 1 — the daily metric snapshot: one row, replaced whole. */

import type Database from 'better-sqlite3';

import { METRIC_REGISTRY, type MetricReading } from '@recued/contracts';

import { ensureMetricSchema, METRIC_SNAPSHOT_PRIMARY_KEY } from './schema.js';

export interface SnapshotMetric {
  readonly metric_id: string;
  readonly metric_version: number;
  readonly reading: MetricReading;
  /** ⚠ LOCAL ONLY, and PERSISTED ON PURPOSE. § D2 publishes the ratio and never these —
   *  but § D7's publish dialog owes the owner the figures it came from, and § D6's
   *  activity floor is evaluated against the denominator. Dropping them at the store (as
   *  the first cut did) makes the dialog unbuildable: the numbers exist only inside the
   *  compute call that produced them. */
  readonly numerator?: number;
  readonly denominator?: number;
}

export interface MetricSnapshot {
  readonly computed_at: number;
  readonly window: { readonly from: number; readonly to: number };
  readonly metrics: readonly SnapshotMetric[];
  /** ⚠ LOCAL ONLY. Diagnostics the dashboard renders and the submission path drops —
   *  § D2 publishes the ratio and never the counts. */
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface MetricSnapshotStore {
  read(): MetricSnapshot | undefined;
  write(snapshot: MetricSnapshot): void;
}

export const createMetricSnapshotStore = (db: Database.Database): MetricSnapshotStore => {
  ensureMetricSchema(db);
  const put = db.prepare(
    `INSERT INTO metric_snapshot (id, data, computed_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, computed_at = excluded.computed_at`,
  );
  const get = db.prepare(`SELECT data FROM metric_snapshot WHERE id = ?`);

  return {
    read() {
      const row = get.get(METRIC_SNAPSHOT_PRIMARY_KEY) as { data: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.data) as MetricSnapshot);
    },

    write(snapshot) {
      // ⛔⛔ AN ARTIFACT METRIC IN THE SNAPSHOT IS REJECTED, AND THIS IS A REAL GUARD
      // RATHER THAN TIDINESS. The snapshot is REPLACED WHOLE, so a `record` written
      // here would be silently overwritten by a lower observation — a quiet week would
      // erase a standing Burst. The registry already knows which store each metric
      // belongs to; refusing the mismatch is what stops the two models being mixed by
      // a caller that read the wrong compute function's output.
      for (const m of snapshot.metrics) {
        const def = METRIC_REGISTRY[m.metric_id];
        if (def === undefined) {
          throw new Error(`metric '${m.metric_id}' is not in the registry`);
        }
        if (def.store !== 'snapshot') {
          throw new Error(
            `metric '${m.metric_id}' is store: '${def.store}' and cannot go in the snapshot — `
              + `a replaced-whole row would erase a value that is meant to advance`,
          );
        }
      }
      put.run(METRIC_SNAPSHOT_PRIMARY_KEY, JSON.stringify(snapshot), snapshot.computed_at);
    },
  };
};
