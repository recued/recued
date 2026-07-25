/** Phase D (D-106) — per-collection retention pruner.
 *
 *  Age-based only: rows with `received_at < now - retentionDays *
 *  86_400_000` are dropped from the underlying `CollectionTable`.
 *  Orphaned CAS blobs are surfaced on the result so callers (the
 *  eviction cascade in Commit 6) can feed them into the shared
 *  orphan-CAS sweep or an eager `BlobStore.delete()` path.
 *
 *  Three entry points in the broader system:
 *  1. Per-collection cron tick — default 1 h interval, wired inside
 *     each concrete adapter (Commit 10 for webhook, Commit 12 for
 *     mail). File adapter leaves this unwired because files default
 *     to `retention_days: 0` (the user owns the filesystem; we'd
 *     rather stop syncing than delete their records).
 *  2. Pressure-driven reclaim — the Phase B cascade orchestrator
 *     calls `run()` inline on a collection whose gate flips to
 *     `pressure_managed`. Same pruner, no separate size-based pass:
 *     age-based is enough for realistic mail / webhook loads, and
 *     the cascade falls through to the orphan-CAS sweep + the
 *     user-content block if age-based doesn't free enough.
 *  3. Manual admin rpc `collection.runRetention` (Commit 5's
 *     handler delegates here).
 *
 *  `retentionDays: 0` disables retention — the file adapter's
 *  default. `run()` returns a zero summary with
 *  `skipped_reason: 'retention_disabled'` so callers (pressure
 *  cascade) can fall through to the next step without mistakenly
 *  treating the no-op as a successful reclaim.
 *
 *  Concurrency: a second `run()` while one is in-flight returns the
 *  same Promise. Emits a reserve-class `collection_retention_prune`
 *  activity on any prune that actually removed rows; `runSafe`
 *  additionally logs the error path so cron failures never escape
 *  silently.
 */

import type { AuditLogStore } from '@recued/storage';
import type { CollectionPlatform } from '@recued/contracts';
import type { CollectionPruneResult } from './types.js';

export type { CollectionPruneResult };

export interface CollectionRetentionConfig {
  /** Integer days to keep. `0` disables retention entirely (file
   *  collections). Non-integer or negative values coerce to 0 — the
   *  pruner prefers a safe no-op over a surprise purge. */
  retentionDays: number;
}

/** Narrow surface the retention runner needs — every collection table
 *  (mail / file / webhook via the generic `CollectionTable`, calendar
 *  via `CalendarCollectionTable`) exposes a structurally identical
 *  `pruneOlderThan`. Typing it here keeps retention reusable across
 *  table shapes. */
export interface RetentionPrunable {
  pruneOlderThan(cutoff: number): {
    pruned_count: number;
    bytes_freed: number;
    blob_hashes_freed: string[];
  };
}

export interface CollectionRetentionDeps {
  table: RetentionPrunable;
  platform: CollectionPlatform;
  slug: string;
  /** Live config getter. Re-read on every call so
   *  `server.setConfigField` changes take effect without restart. */
  config: () => CollectionRetentionConfig;
  /** Optional audit log — a missing log means no `logActivity` fires,
   *  useful for tests and CLI-only modes. */
  auditLog?: AuditLogStore;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
}

export interface CollectionRetention {
  /** Run the pruner. Coalesces concurrent callers into one
   *  execution. Throws when the underlying table rejects a delete;
   *  callers that want the no-throw variant use `runSafe`. */
  run(): Promise<CollectionPruneResult>;
  /** Cron-ready wrapper — never throws. Logs the error via a
   *  `collection_retention_prune` activity with a `detail=error:…`
   *  string so the user sees the failure in the audit log. Returns
   *  `null` on error. */
  runSafe(): Promise<CollectionPruneResult | null>;
}

const MS_PER_DAY = 86_400_000;

const normalizeRetentionDays = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
};

export const createCollectionRetention = (
  deps: CollectionRetentionDeps,
): CollectionRetention => {
  let inflight: Promise<CollectionPruneResult> | null = null;

  const target = `collection:${deps.platform}:${deps.slug}`;
  const nowOf = (): number => deps.now?.() ?? Date.now();

  const runOnce = async (): Promise<CollectionPruneResult> => {
    const started = nowOf();
    const cfg = deps.config();
    const retentionDays = normalizeRetentionDays(cfg.retentionDays);
    if (retentionDays === 0) {
      return {
        pruned_count: 0,
        bytes_freed: 0,
        blob_hashes_freed: [],
        duration_ms: nowOf() - started,
        skipped_reason: 'retention_disabled',
      };
    }

    const cutoff = started - retentionDays * MS_PER_DAY;
    const { pruned_count, bytes_freed, blob_hashes_freed } =
      deps.table.pruneOlderThan(cutoff);

    // Audit only when actual work happened — a pruner that fires
    // every hour with nothing to do would flood the activity log
    // otherwise. `collection_retention_prune` auto-classifies as
    // reserve via RESERVE_ACTIONS (Phase D Commit 0), so the record
    // survives its own retention cycle.
    if (pruned_count > 0 && deps.auditLog) {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: nowOf(),
        action: 'collection_retention_prune',
        target,
        detail: `rows=${pruned_count} bytes=${bytes_freed} blobs=${blob_hashes_freed.length} cutoff=${cutoff}`,
      });
    }

    return {
      pruned_count,
      bytes_freed,
      blob_hashes_freed,
      duration_ms: nowOf() - started,
    };
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
        if (deps.auditLog) {
          try {
            await deps.auditLog.logActivity({
              activity_id: '',
              timestamp: nowOf(),
              action: 'collection_retention_prune',
              target,
              detail: `error: ${err instanceof Error ? err.message : String(err)}`,
            });
          } catch { /* best-effort */ }
        }
        return null;
      }
    },
  };
};
