/** Phase B audit retention pruner.
 *
 *  Two-pass reclaim for the `audit` gate:
 *   1. Age-based pass  — drop every non-reserve audit_entries row
 *      where `started_at < now - retention_days * 86400000`, and
 *      every non-reserve audit_activities row where
 *      `timestamp < now - retention_days * 86400000`.
 *   2. Size-based pass — if post-age usage still exceeds
 *      `prune_at_pct × quota`, drop oldest non-reserve rows up to
 *      `prune_max_rows_per_run`, never allowing the non-reserve
 *      tail to fall below the reserve floor (`quota × reserve_pct`).
 *
 *  Reserve rows (pressure-transition, kill-switch, quota-exceeded,
 *  account-mismatch-rejected, audit-retention-prune, etc.) are
 *  excluded from both passes — they're the ledger we care most
 *  about keeping. `'awaiting_approval'` run anchors are likewise
 *  excluded from both entry passes (D-157 N.8): a paused run's anchor
 *  is the user's pending approval, and pruning it would strand the
 *  run's checkpoint — see `nonAwaitingSql` below.
 *
 *  Bytes-freed are reported by the audit store's `onBytesChanged`
 *  hook, which feeds the audit gate. After the pruner runs, it
 *  `setUsed`s the gate to the recomputed total so rounding drift
 *  across many partial writes doesn't accumulate.
 *
 *  The pruner is idempotent and coalesces concurrent calls into a
 *  single in-flight Promise — two cron ticks firing close together
 *  share the same result. */

import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import { RESERVE_ACTIONS } from '@recued/storage';

export interface AuditRetentionConfig {
  /** Keep all entries younger than this. `null` disables age-based
   *  prune entirely (the post-D-120 default per
   *  `MEMORY_RETENTION_DEFAULT_DAYS`); size-based reclaim still runs.
   *  Wire format: the runtime-config schema carries `0` as the
   *  no-expiry sentinel; `bin.ts` collapses `0 → null` here. */
  retentionDays: number | null;
  /** Byte ceiling for the audit surface. Mirrors
   *  `audit.quota.bytes`. */
  quotaBytes: number;
  /** Size-based prune kicks in once usage > `pruneAtPct × quota`.
   *  Default 70. */
  pruneAtPct: number;
  /** Rows per size-based pass. Default 1000. */
  pruneMaxRowsPerRun: number;
  /** Reserve floor (percentage of quota) that size-based pass must
   *  leave intact — the pruner never evicts non-reserve rows when
   *  doing so would leave more reserve bytes than non-reserve. */
  reservePct: number;
}

export interface AuditRetentionDeps {
  db: Database.Database;
  auditLog: AuditLogStore;
  /** Optional — when wired, `setUsed` after prune keeps the gate
   *  aligned with live row totals. */
  gate?: StorageGate;
  now?: () => number;
  /** Live config view. Reads on every call so runtime reconfigure
   *  (Commit 11) takes effect without restart. */
  config: () => AuditRetentionConfig;
}

export interface PruneResult {
  /** Rows dropped across both tables. */
  rows_removed: number;
  /** Byte count released per `SUM(length(data))`. */
  bytes_freed: number;
  /** True when the age-based pass fired (i.e. the cutoff window
   *  removed at least one row). */
  age_pass_ran: boolean;
  /** True when the size-based pass fired. */
  size_pass_ran: boolean;
  /** Wall-clock duration of the whole pass. */
  duration_ms: number;
}

export interface AuditRetention {
  run(): Promise<PruneResult>;
  /** Cron-ready wrapper — never throws; logs errors on the audit log
   *  (via `audit_retention_prune` activity) and returns the result. */
  runSafe(): Promise<PruneResult | null>;
}

export const createAuditRetention = (deps: AuditRetentionDeps): AuditRetention => {
  let inflight: Promise<PruneResult> | null = null;

  const cutoffMs = (now: number, retentionDays: number): number =>
    now - retentionDays * 86_400_000;

  const reserveSql = `(json_extract(data, '$.reserve') IS NULL OR json_extract(data, '$.reserve') != 1)`;

  // D-157 N.8 (codex BLOCKER fold) — an `'awaiting_approval'` run anchor
  // is the user's pending approval, the I-8 analog of an unreconciled
  // `in_doubt` commit: pruning it strands the paused run's checkpoint
  // (the resumer can no longer recover config / execution_source) and
  // hands the checkpoint sweep an "orphan" it would garbage-collect —
  // a dropped decision. Exempt from BOTH passes. Self-bounding: the row
  // is INSERT-OR-REPLACEd to a terminal status the moment the run
  // resumes / is denied / is expired by the checkpoint staleness guard,
  // and outstanding-approval volume is a handful of rows at most.
  const nonAwaitingSql = `(json_extract(data, '$.commit_status') IS NULL OR json_extract(data, '$.commit_status') != 'awaiting_approval')`;

  const measureAuditUsage = (): number => {
    const row = deps.db
      .prepare(
        `SELECT COALESCE(
           (SELECT SUM(length(data)) FROM audit_entries), 0
         ) + COALESCE(
           (SELECT SUM(length(data)) FROM audit_activities), 0
         ) AS total`,
      )
      .get() as { total: number };
    return row.total;
  };

  const measureReserveTotal = (): number => {
    const row = deps.db
      .prepare(
        `SELECT COALESCE(
           (SELECT SUM(length(data)) FROM audit_entries
              WHERE json_extract(data, '$.reserve') = 1), 0
         ) + COALESCE(
           (SELECT SUM(length(data)) FROM audit_activities
              WHERE json_extract(data, '$.reserve') = 1), 0
         ) AS total`,
      )
      .get() as { total: number };
    return row.total;
  };

  const ageBasedPrune = (cfg: AuditRetentionConfig, now: number): {
    rowsRemoved: number;
    bytesFreed: number;
  } => {
    if (cfg.retentionDays === null) return { rowsRemoved: 0, bytesFreed: 0 };
    const cutoff = cutoffMs(now, cfg.retentionDays);
    // Capture the bytes we're about to drop BEFORE deleting, since
    // `length(data)` is only computable while the row exists.
    const entriesBytes = deps.db
      .prepare(
        `SELECT COALESCE(SUM(length(data)), 0) AS total FROM audit_entries
           WHERE json_extract(data, '$.started_at') < ? AND ${reserveSql} AND ${nonAwaitingSql}`,
      )
      .get(cutoff) as { total: number };
    const activitiesBytes = deps.db
      .prepare(
        `SELECT COALESCE(SUM(length(data)), 0) AS total FROM audit_activities
           WHERE json_extract(data, '$.timestamp') < ? AND ${reserveSql}`,
      )
      .get(cutoff) as { total: number };

    const entriesRes = deps.db
      .prepare(
        `DELETE FROM audit_entries
           WHERE json_extract(data, '$.started_at') < ? AND ${reserveSql} AND ${nonAwaitingSql}`,
      )
      .run(cutoff);
    const activitiesRes = deps.db
      .prepare(
        `DELETE FROM audit_activities
           WHERE json_extract(data, '$.timestamp') < ? AND ${reserveSql}`,
      )
      .run(cutoff);

    return {
      rowsRemoved: entriesRes.changes + activitiesRes.changes,
      bytesFreed: entriesBytes.total + activitiesBytes.total,
    };
  };

  /** Drop oldest non-reserve rows across both tables until either
   *  the budget caps the work OR the reserve floor would be crossed.
   *  Returns { rowsRemoved, bytesFreed }. */
  const sizeBasedPrune = async (
    cfg: AuditRetentionConfig,
  ): Promise<{ rowsRemoved: number; bytesFreed: number }> => {
    const cap = cfg.pruneMaxRowsPerRun;
    const reserveFloor = Math.floor(cfg.quotaBytes * (cfg.reservePct / 100));
    // We never drop non-reserve rows below the reserve floor — if
    // reserve total already exceeds floor, the pruner is free to
    // shrink non-reserve to zero. The constraint is more subtle:
    // `non_reserve_bytes` should not fall below
    // `reserveFloor - reserve_bytes`. In practice just use the pruner
    // as a guard against runaway growth; this clause keeps us honest
    // when the reserve tier is nearly empty.
    const reserveBytes = measureReserveTotal();
    const minNonReserveFloor = Math.max(0, reserveFloor - reserveBytes);

    let rowsRemoved = 0;
    let bytesFreed = 0;

    // Age-oldest non-reserve entries — entries (by started_at) then
    // activities (by timestamp). Shared cap across both tables.
    const entriesOldest = deps.db
      .prepare(
        `SELECT key, length(data) AS len FROM audit_entries
           WHERE ${reserveSql} AND ${nonAwaitingSql}
           ORDER BY json_extract(data, '$.started_at') ASC
           LIMIT ?`,
      )
      .all(cap) as Array<{ key: string; len: number }>;
    for (const row of entriesOldest) {
      // Check floor BEFORE deleting.
      const nonReserveBytes = measureAuditUsage() - reserveBytes;
      if (nonReserveBytes - row.len < minNonReserveFloor) break;
      deps.db.prepare(`DELETE FROM audit_entries WHERE key = ?`).run(row.key);
      rowsRemoved++;
      bytesFreed += row.len;
    }

    if (rowsRemoved < cap) {
      const remaining = cap - rowsRemoved;
      const activitiesOldest = deps.db
        .prepare(
          `SELECT key, length(data) AS len FROM audit_activities
             WHERE ${reserveSql}
             ORDER BY json_extract(data, '$.timestamp') ASC
             LIMIT ?`,
        )
        .all(remaining) as Array<{ key: string; len: number }>;
      for (const row of activitiesOldest) {
        const nonReserveBytes = measureAuditUsage() - reserveBytes;
        if (nonReserveBytes - row.len < minNonReserveFloor) break;
        deps.db
          .prepare(`DELETE FROM audit_activities WHERE key = ?`)
          .run(row.key);
        rowsRemoved++;
        bytesFreed += row.len;
      }
    }

    return { rowsRemoved, bytesFreed };
  };

  const runOnce = async (): Promise<PruneResult> => {
    const start = deps.now?.() ?? Date.now();
    const cfg = deps.config();

    // Age-based pass no-ops when retention is null — user has opted
    // into "keep forever." Size-based reclaim still runs below
    // because it protects the quota, not the retention window.
    const ageRes = ageBasedPrune(cfg, start);
    const pruneTrigger = Math.floor(cfg.quotaBytes * (cfg.pruneAtPct / 100));
    let sizeRes = { rowsRemoved: 0, bytesFreed: 0 };
    let size_pass_ran = false;
    if (measureAuditUsage() > pruneTrigger) {
      size_pass_ran = true;
      sizeRes = await sizeBasedPrune(cfg);
    }

    const rows_removed = ageRes.rowsRemoved + sizeRes.rowsRemoved;
    const bytes_freed = ageRes.bytesFreed + sizeRes.bytesFreed;

    // Re-anchor the gate's `used` to the ground-truth byte total so
    // many per-row delta ticks don't drift the gate over time.
    if (deps.gate) deps.gate.setUsed(measureAuditUsage());

    const end = deps.now?.() ?? Date.now();
    const result: PruneResult = {
      rows_removed,
      bytes_freed,
      age_pass_ran: ageRes.rowsRemoved > 0,
      size_pass_ran,
      duration_ms: end - start,
    };

    // Emit an audit_retention_prune activity only when actual work
    // happened. Reserve-class (auto-classified by `RESERVE_ACTIONS`),
    // so it survives its own prune.
    if (rows_removed > 0) {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: end,
        action: 'audit_retention_prune',
        target: 'audit',
        detail: `rows=${rows_removed} bytes=${bytes_freed} age=${ageRes.rowsRemoved} size=${sizeRes.rowsRemoved}`,
      });
    }

    return result;
  };

  return {
    async run() {
      if (inflight) return inflight;
      inflight = runOnce().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async runSafe() {
      try {
        return await this.run();
      } catch (err) {
        // Pruner failures surface via an audit activity so the user
        // sees something went wrong without the cron crashing.
        try {
          await deps.auditLog.logActivity({
            activity_id: '',
            timestamp: deps.now?.() ?? Date.now(),
            action: 'audit_retention_prune',
            target: 'audit',
            detail: `error: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch { /* best-effort */ }
        return null;
      }
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Reserve-action export for other modules
// ────────────────────────────────────────────────────────────────

// Re-export so callers that need to check reserve classification
// without pulling in `@recued/storage` directly stay dependency-free
// at the server-side composition surface.
export { RESERVE_ACTIONS };
