/** Phase B eviction cascade orchestrator.
 *
 *  Subscribes to every gate's `onStateChange` and runs a per-surface
 *  reclaim pipeline when the gate enters `pressure_managed`:
 *
 *    cache       → LRU eviction on L1 + L2
 *    audit       → retention pruner (age-based, then size-based)
 *    cache       → orphan CAS sweep of the ENCRYPTED cache_blobs root
 *                  (keepset = cache ∪ collection references)
 *    shared_store → orphan CAS sweep of the ENCRYPTED blobs root
 *                  (keepset = shared ∪ annotation references)
 *    vault       → no reclaim (per-publisher quota is the gate)
 *    account_store → no reclaim (user-writable; cleared by user or sync)
 *    schedules   → no reclaim (user content; listed and deleted manually)
 *
 *  Reclaim tuning:
 *   - **Debounce:** one pass per surface per `cascade.debounce_window_s`
 *     (default 60s). Bypass iff usage grew > 10% since the last run.
 *   - **Coalescing:** concurrent triggers on the same surface share a
 *     single in-flight Promise.
 *   - **Hysteresis:** a gate only returns to `running` after usage drops
 *     below `pressureAt × 0.9`. Handled by the gate itself via
 *     `recomputeState` after each `setUsed` / `addUsed` / `subUsed`.
 *   - **Budget:** each pipeline step caps rows / blobs per run so the
 *     reclaim never holds the event loop longer than ~200ms.
 *
 *  After every attempt, the cascade writes a `pressure_eviction_run`
 *  audit activity (reserve-classified, so it survives its own prune)
 *  and updates the persisted `last_reclaim` row. */

import type { StorageGate, StateChangeEvent } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { GateRegistry } from './storage-gates.js';
import type { PressureStateStore } from './pressure-state.js';
import type { AuditRetention } from './audit-retention.js';
import type { BlobStore } from './storage/blob-store.js';
import type { CacheStore } from '@recued/cache';
import type Database from 'better-sqlite3';
import type { CollectionRegistry } from './collections/registry.js';
import type { CollectionPlatform } from '@recued/contracts';

export interface CascadeConfig {
  /** Cooldown between reclaim attempts on the same surface. Default 60s. */
  debounceWindowMs: number;
  /** Maximum CAS blobs touched by a single orphan-sweep pass. Default 1000. */
  orphanScanMaxBlobs: number;
  /** Hysteresis — drop to `running` only below `pressureAt × hysteresisRatio`. */
  hysteresisRatio: number;
}

export const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
  debounceWindowMs: 60_000,
  orphanScanMaxBlobs: 1000,
  hysteresisRatio: 0.9,
};

export interface EvictionCascadeDeps {
  registry: GateRegistry;
  state: PressureStateStore;
  auditLog: AuditLogStore;
  cache?: CacheStore;
  /** The ENCRYPTED `cache_blobs` CAS root — cache values + every collection
   *  body (mail / calendar / file) share it. Swept on `cache` pressure with a
   *  keepset of cache ∪ collection references. */
  cacheBlobs?: BlobStore;
  /** The ENCRYPTED `blobs` CAS root — shared-store + annotation bodies. Swept on
   *  `shared_store` pressure with a keepset of shared ∪ annotation references.
   *  A separate root from `cacheBlobs` so either sweep can never reap the other
   *  content family's live blob. */
  sharedBlobs?: BlobStore;
  /** Reader for live cache blob-hash references — from
   *  `listReferencedBlobHashes(db)` against the SQLite cache table.
   *  Absent → cache-root orphan sweep skipped. */
  cacheBlobRefs?: () => Set<string>;
  /** Reader for live collection blob-hash references (every `collection_*`
   *  table). Collections share the `cache_blobs` root, so their live refs MUST
   *  join the cache-root keepset or the sweep would reap live collection bodies
   *  (returns an empty set when no collection tables exist). */
  collectionBlobRefs?: () => Set<string>;
  /** Reader for live shared_store blob-hash references. */
  sharedBlobRefs?: () => Set<string>;
  /** Reader for live annotation blob-hash references. Annotations share the
   *  `blobs` root, so their live refs MUST join the shared-root keepset
   *  or the sweep would reap live annotation bodies. */
  annotationBlobRefs?: () => Set<string>;
  /** Audit retention orchestrator (Commit 7). */
  auditRetention?: AuditRetention;
  /** Phase D collection registry. When wired, `collection:{platform}:{slug}`
   *  surface pressure events run the per-collection age-based pruner
   *  inline. Without it, collection surfaces report `not_evictable`
   *  even when they're mail/webhook — file collections always report
   *  not_evictable (user owns the filesystem; no auto-delete). */
  collectionRegistry?: CollectionRegistry;
  /** Live config — read on each pass so runtime reconfigure
   *  propagates without restart. */
  config: () => CascadeConfig;
  /** Time source — injectable for deterministic tests. */
  now?: () => number;
  /** SQLite handle — used for any inline queries (cache/shared blob
   *  reference lookup when custom readers aren't wired). Optional. */
  db?: Database.Database;
}

export interface ReclaimSummary {
  surface: string;
  ran: boolean;
  bytes_freed: number;
  steps_run: string[];
  success: boolean;
  reason_if_skipped?: 'debounced' | 'coalesced' | 'no_such_surface' | 'not_evictable' | 'closed';
  duration_ms: number;
}

export interface EvictionCascade {
  /** Run reclaim on a specific surface now. `force: true` bypasses the
   *  debounce but still respects in-flight coalescing. */
  reclaim(surface: string, opts?: { force?: boolean }): Promise<ReclaimSummary>;
  /** Detach and drain — removes the cascade's event listeners from every gate,
   *  rejects new reclaim admission, and waits for active passes to finish.
   *  For tests + graceful shutdown. */
  close(): Promise<void>;
}

const EVICTABLE_SURFACES = new Set(['cache', 'audit', 'shared_store']);

const COLLECTION_SURFACE_PREFIX = 'collection:';

/** Break a `collection:{platform}:{slug}` surface name into its
 *  parts. Returns `null` when the shape doesn't match — callers
 *  treat the surface as a regular string in that case. */
const parseCollectionSurface = (
  surface: string,
): { platform: CollectionPlatform; slug: string } | null => {
  if (!surface.startsWith(COLLECTION_SURFACE_PREFIX)) return null;
  const rest = surface.slice(COLLECTION_SURFACE_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx >= rest.length - 1) return null;
  const platform = rest.slice(0, idx) as CollectionPlatform;
  const slug = rest.slice(idx + 1);
  if (platform !== 'mail' && platform !== 'file' && platform !== 'webhook') {
    return null;
  }
  return { platform, slug };
};

/** File collections are never auto-evictable (the user owns the
 *  filesystem). Mail / webhook run age-based retention inline on
 *  pressure. */
const isCollectionSurfaceEvictable = (
  parsed: { platform: CollectionPlatform; slug: string },
): boolean => parsed.platform === 'mail' || parsed.platform === 'webhook';

/** Create the cascade, subscribe it to every gate's `onStateChange`,
 *  and wire the retention pruner + orphan sweep into the pipeline. */
export const createEvictionCascade = (
  deps: EvictionCascadeDeps,
): EvictionCascade => {
  const now = deps.now ?? (() => Date.now());
  const inflight = new Map<string, Promise<ReclaimSummary>>();
  const lastRun = new Map<string, { at: number; usedAtRun: number }>();
  const unsubscribes: Array<() => void> = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const runReclaim = async (
    surface: string,
    opts: { force?: boolean } = {},
  ): Promise<ReclaimSummary> => {
    const start = now();

    if (closed) {
      return {
        surface, ran: false, bytes_freed: 0, steps_run: [],
        success: false, reason_if_skipped: 'closed',
        duration_ms: 0,
      };
    }

    // Coalescing is an admission rule, not a debounce exception. In
    // particular, `force` may bypass the cooldown but must never start a
    // second pass over the same rows / blobs while one is active.
    const existing = inflight.get(surface);
    if (existing) {
      const result = await existing;
      return { ...result, ran: false, reason_if_skipped: 'coalesced' };
    }

    const cfg = deps.config();

    const gate = deps.registry.get(surface);
    if (!gate) {
      return {
        surface, ran: false, bytes_freed: 0, steps_run: [],
        success: false, reason_if_skipped: 'no_such_surface',
        duration_ms: 0,
      };
    }

    const collectionParsed = parseCollectionSurface(surface);
    const isCollection = collectionParsed !== null;
    const evictable = isCollection
      ? isCollectionSurfaceEvictable(collectionParsed)
      : EVICTABLE_SURFACES.has(surface);
    if (!evictable) {
      return {
        surface, ran: false, bytes_freed: 0, steps_run: [],
        success: false, reason_if_skipped: 'not_evictable',
        duration_ms: 0,
      };
    }

    // Debounce — unless `force: true`, or usage has grown > 10% since
    // the last attempt.
    const prior = lastRun.get(surface);
    if (prior && !opts.force) {
      const elapsed = start - prior.at;
      if (elapsed < cfg.debounceWindowMs) {
        const growthRatio = gate.info().used / Math.max(1, prior.usedAtRun);
        if (growthRatio <= 1.1) {
          return {
            surface, ran: false, bytes_freed: 0, steps_run: [],
            success: false, reason_if_skipped: 'debounced',
            duration_ms: 0,
          };
        }
      }
    }

    // The tracked unit includes persistence + audit finalization, not merely
    // the eviction pipeline. Shutdown must not close SQLite after the rows or
    // blobs are done while a last_reclaim / activity write is still pending.
    const run = (async (): Promise<ReclaimSummary> => {
      const summary = await runPipeline(surface, gate, cfg, start);
      lastRun.set(surface, { at: start, usedAtRun: gate.info().used });
      // Persist last_reclaim + conditionally clear entered_at when
      // the gate is back to `running`.
      deps.state.setLastReclaim(surface, {
        at: start,
        bytes_freed: summary.bytes_freed,
        success: summary.success,
        steps: summary.steps_run,
      });
      if (gate.info().state === 'running') {
        deps.state.clearSurface(surface);
      }
      // Audit the pass — reserve-classified by action name so it
      // survives its own retention prune.
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: start,
        action: 'pressure_eviction_run',
        target: surface,
        detail: `bytes_freed=${summary.bytes_freed} steps=${summary.steps_run.join(',')} success=${summary.success}`,
      });
      return summary;
    })();
    inflight.set(surface, run);
    try {
      return await run;
    } finally {
      // Do not let an older pass erase newer tracking if this invariant is
      // ever relaxed in the future.
      if (inflight.get(surface) === run) inflight.delete(surface);
    }
  };

  const runPipeline = async (
    surface: string,
    gate: StorageGate,
    cfg: CascadeConfig,
    start: number,
  ): Promise<ReclaimSummary> => {
    const steps_run: string[] = [];
    let bytes_freed = 0;
    // Re-parse the surface for Phase D collection surfaces — scope
    // local to this closure so the branch below has what it needs.
    const collectionParsed = parseCollectionSurface(surface);

    try {
      if (surface === 'cache' && deps.cache) {
        // LRU evict until we drop below `pressureAt × hysteresisRatio`.
        const info = gate.info();
        const target = Math.floor(info.pressureAt * cfg.hysteresisRatio);
        const before = info.used;
        await deps.cache.evictLRU(target);
        // Cache store's onBytesChanged already updated gate.used; read
        // the new value to compute bytes freed via the gate itself.
        const after = gate.info().used;
        bytes_freed += Math.max(0, before - after);
        steps_run.push('cache_lru');

        // Orphan CAS sweep on the ENCRYPTED cache_blobs root. Its keepset is
        // cache ∪ collection refs — collections share this root, so their live
        // bodies MUST be kept (omitting them is the data-loss bug this split
        // fixes). Shared / annotation refs do NOT belong here — they live in
        // the separate keyless root.
        if (deps.cacheBlobs && deps.cacheBlobRefs) {
          const keep = new Set<string>();
          deps.cacheBlobRefs().forEach((h) => keep.add(h));
          if (deps.collectionBlobRefs) deps.collectionBlobRefs().forEach((h) => keep.add(h));
          const sweepBefore = await deps.cacheBlobs.totalBytes();
          await deps.cacheBlobs.sweepOrphans(keep);
          const sweepAfter = await deps.cacheBlobs.totalBytes();
          const freed = Math.max(0, sweepBefore - sweepAfter);
          bytes_freed += freed;
          if (freed > 0) steps_run.push('orphan_cas_sweep');
        }
      } else if (surface === 'audit' && deps.auditRetention) {
        const before = gate.info().used;
        const result = await deps.auditRetention.run();
        if (result.age_pass_ran) steps_run.push('audit_age_prune');
        if (result.size_pass_ran) steps_run.push('audit_size_prune');
        const after = gate.info().used;
        bytes_freed += Math.max(0, before - after);
      } else if (surface === 'shared_store') {
        // No programmatic reclaim on user-writable shared_store — the
        // user deletes records explicitly. We still sweep orphan blobs
        // because a partial prior delete may have stranded CAS files.
        // Sweep the encrypted blobs root; keepset is shared ∪ annotation refs
        // (both write this root). Cache / collection refs do NOT belong here —
        // they live in the separate encrypted cache_blobs root.
        if (deps.sharedBlobs && deps.sharedBlobRefs) {
          const keep = new Set<string>();
          deps.sharedBlobRefs().forEach((h) => keep.add(h));
          if (deps.annotationBlobRefs) deps.annotationBlobRefs().forEach((h) => keep.add(h));
          const sweepBefore = await deps.sharedBlobs.totalBytes();
          await deps.sharedBlobs.sweepOrphans(keep);
          const sweepAfter = await deps.sharedBlobs.totalBytes();
          const freed = Math.max(0, sweepBefore - sweepAfter);
          bytes_freed += freed;
          if (freed > 0) steps_run.push('orphan_cas_sweep');
        }
      } else if (collectionParsed && deps.collectionRegistry) {
        // Phase D: per-collection age-based retention fires inline on
        // pressure. Mail / webhook only — file is handled by the
        // not_evictable branch above.
        const { platform, slug } = collectionParsed;
        const collection = deps.collectionRegistry.get(platform, slug);
        if (collection) {
          const before = gate.info().used;
          const result = await collection.runRetention();
          if (result.skipped_reason !== 'retention_disabled') {
            steps_run.push('collection_retention');
          }
          // Eager CAS cleanup for rows we just pruned. The global
          // orphan sweep still exists for other cleanup paths
          // (upsert-replaced blobs, partial deletes) but this pass
          // reclaims the bytes synchronously so the gate recovers
          // without waiting for the next cache/shared_store event.
          // Collection bodies live in the encrypted cache_blobs root, so
          // delete from there — NOT the separate shared root.
          if (deps.cacheBlobs && result.blob_hashes_freed.length > 0) {
            for (const hash of result.blob_hashes_freed) {
              try { await deps.cacheBlobs.delete(hash); } catch { /* best-effort */ }
            }
            steps_run.push('collection_cas_delete');
          }
          const after = gate.info().used;
          bytes_freed += Math.max(0, before - after);
        }
      }
    } catch (_err) {
      // Pipeline failures surface via the audit activity caller writes
      // with `success: false` — never propagate.
      return {
        surface,
        ran: true,
        bytes_freed,
        steps_run,
        success: false,
        duration_ms: now() - start,
      };
    }

    // Success if the gate is back to `running`. `pressure_managed` is
    // still pressure — the reclaim may have run but not freed enough.
    const afterInfo = gate.info();
    const success = afterInfo.state === 'running';
    return {
      surface,
      ran: true,
      bytes_freed,
      steps_run,
      success,
      duration_ms: now() - start,
    };
  };

  // Subscribe to every gate's state-change events.
  const onEvent = (event: StateChangeEvent): void => {
    const { surface } = event.info;
    if (event.next === 'pressure_managed' && event.previous === 'running') {
      // Persist entered_at so the heartbeat envelope can show
      // "pressure since HH:MM".
      deps.state.setEnteredAt(surface, event.at);
      // Fire-and-forget reclaim — users can also trigger it manually
      // via `server.runPressureReclaim`.
      void runReclaim(surface).catch(() => { /* logged inside */ });
    } else if (event.next === 'writes_blocked') {
      // Still try to reclaim once more — we might be able to recover.
      deps.state.setEnteredAt(surface, event.at);
      void runReclaim(surface).catch(() => { /* logged inside */ });
    } else if (event.next === 'running') {
      deps.state.clearSurface(surface);
    }
  };

  for (const gate of deps.registry.all()) {
    unsubscribes.push(gate.onStateChange(onEvent));
  }
  // Phase D: collection gates are registered after cascade construction
  // (bin.ts creates the registry, then the cascade, then registers
  // per-collection gates as each MailCollection / FileCollection /
  // WebhookCollection boots). Auto-subscribe so the cascade never
  // misses a state-change from a late-registered surface.
  unsubscribes.push(
    deps.registry.onGateRegistered((gate) => {
      unsubscribes.push(gate.onStateChange(onEvent));
    }),
  );

  return {
    reclaim(surface, opts) {
      return runReclaim(surface, opts);
    },
    close() {
      if (closePromise) return closePromise;

      // Set the admission latch synchronously, before detaching listeners or
      // snapshotting work, so no reclaim can enter outside the drain set.
      closed = true;
      for (const un of unsubscribes) {
        try { un(); } catch { /* best-effort listener cleanup */ }
      }
      unsubscribes.length = 0;

      const active = [...new Set(inflight.values())];
      closePromise = Promise.allSettled(active).then(() => undefined);
      return closePromise;
    },
  };
};
