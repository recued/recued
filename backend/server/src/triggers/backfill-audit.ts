/** D-124 Phase 2.4 — backfill audit row.
 *
 *  One sync-level `collection_backfill` activity row per drain
 *  completion. Steady-state delta sync emits no row. Per-record
 *  Memory rows still come from the recipe runs that live events
 *  trigger — D-124 Phase 2.2's suppression keeps the trigger pipeline
 *  silent during the drain, so no per-record activity reaches Memory's
 *  feed during backfill anyway. The single row at completion is the
 *  only sync-level breadcrumb users see for "yes, this enrollment did
 *  finish indexing."
 *
 *  Shape (packed into the activity entry's `detail` field as JSON):
 *    {
 *      status: 'complete' | 'partial' | 'failed',
 *      duration_ms: number,
 *      records_imported: number,
 *      records_failed: number,
 *      earliest_record_event_at: number | null,
 *      latest_record_event_at: number | null,
 *      run_mode: 'backfill',
 *    }
 *
 *  `target` is `<platform>:<slug>` so list / filter queries can scope
 *  by collection without parsing JSON.
 *
 *  Crash semantics. If the process crashes mid-backfill, no row is
 *  emitted. On restart, the adapter resumes from cursor position and
 *  writes the row when the drain genuinely completes — Phase 2.1's
 *  `backfill_complete` bool is idempotent, so restart catches up
 *  without polluting the audit log with stale "partial" rows.
 *  `'partial'` is reserved for adapter-detected per-record permanent
 *  failures (the provider couldn't ingest a row but the drain itself
 *  progressed). */

import type { AuditLogStore } from '@recued/storage';

export const COLLECTION_BACKFILL_ACTION = 'collection_backfill' as const;

export type BackfillAuditStatus = 'complete' | 'partial' | 'failed';

/** Shape encoded into the activity entry's `detail` field. Consumers
 *  parse `JSON.parse(entry.detail ?? '{}')` and match on this shape.
 *  Includes `run_mode` so future bistemporal queries (D-120 Phase 7.5)
 *  can filter by it without a separate column on the activity entry. */
export interface BackfillAuditDetail {
  status: BackfillAuditStatus;
  duration_ms: number;
  records_imported: number;
  records_failed: number;
  earliest_record_event_at: number | null;
  latest_record_event_at: number | null;
  run_mode: 'backfill';
}

export interface BackfillAuditRecorder {
  /** Record one successful import. `event_at` is the underlying
   *  real-world date for the record (mail `received_at`, calendar
   *  `start_at`, file `mtime`). Pass `null` when the source has no
   *  meaningful event date. Calls after `finish()` are no-ops. */
  recordImport(event_at: number | null): void;
  /** Record one permanent rejection — provider couldn't ingest this
   *  record but the drain itself is progressing. Different from a
   *  thrown exception (which is caught at the drain boundary and
   *  resolves to `'failed'`). Calls after `finish()` are no-ops. */
  recordFailure(): void;
  /** Emit the single sync-level row. Idempotent — second call is a
   *  no-op. `explicitStatus` overrides the auto-derived classification
   *  (`failed` if zero records imported and at least one error;
   *  `partial` if some imported and some failed; `complete` otherwise).
   *  The drain's catch path passes `'failed'` even when zero records
   *  were attempted. */
  finish(explicitStatus?: BackfillAuditStatus): Promise<void>;
}

export interface CreateBackfillAuditRecorderDeps {
  auditLog: AuditLogStore | undefined;
  platform: string;
  slug: string;
  now?: () => number;
  /** Activity-id factory. Defaults to a millisecond + random suffix
   *  matching the existing convention used by other auto-emitting
   *  audit sites (`server-boot`, `audit-retention-prune`). */
  newActivityId?: () => string;
  /** Best-effort logger for emit failures. The audit-log surface can
   *  be backpressured / quota-limited; we never block the drain on it. */
  log?: (level: 'warn', msg: string, data?: unknown) => void;
}

const defaultNewActivityId = (now: number): string =>
  `cb-${now}-${Math.random().toString(36).slice(2, 8)}`;

const deriveStatus = (
  imported: number,
  failed: number,
): BackfillAuditStatus => {
  if (failed === 0) return 'complete';
  if (imported === 0) return 'failed';
  return 'partial';
};

export const createBackfillAuditRecorder = (
  deps: CreateBackfillAuditRecorderDeps,
): BackfillAuditRecorder => {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  let imported = 0;
  let failed = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  let finished = false;

  return {
    recordImport(event_at) {
      if (finished) return;
      imported += 1;
      if (event_at !== null && Number.isFinite(event_at)) {
        if (earliest === null || event_at < earliest) earliest = event_at;
        if (latest === null || event_at > latest) latest = event_at;
      }
    },
    recordFailure() {
      if (finished) return;
      failed += 1;
    },
    async finish(explicitStatus) {
      if (finished) return;
      finished = true;
      if (!deps.auditLog) return;
      const finishedAt = now();
      const detail: BackfillAuditDetail = {
        status: explicitStatus ?? deriveStatus(imported, failed),
        duration_ms: finishedAt - startedAt,
        records_imported: imported,
        records_failed: failed,
        earliest_record_event_at: earliest,
        latest_record_event_at: latest,
        run_mode: 'backfill',
      };
      try {
        await deps.auditLog.logActivity({
          activity_id: deps.newActivityId?.() ?? defaultNewActivityId(finishedAt),
          timestamp: finishedAt,
          action: COLLECTION_BACKFILL_ACTION,
          target: `${deps.platform}:${deps.slug}`,
          detail: JSON.stringify(detail),
        });
      } catch (err) {
        deps.log?.(
          'warn',
          `collection_backfill audit emit failed for ${deps.platform}:${deps.slug}`,
          { err: err instanceof Error ? err.message : String(err) },
        );
      }
    },
  };
};
