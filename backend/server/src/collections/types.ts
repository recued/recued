/** Phase D (D-106) — server-side collection interfaces.
 *
 *  A `Collection` is a durable warehouse store keyed by
 *  `(platform, slug)`. The server runs one per mail account, file
 *  root, or webhook endpoint — a user with two IMAP accounts + one
 *  fs.watch root + one GitHub webhook endpoint runs four Collection
 *  instances. Each composes the same machinery (SQLite table + 64 KB
 *  CAS split + FTS5 companion + gated surface + warehouse events +
 *  sync adapter) behind a uniform read/write surface.
 *
 *  This module defines only the types — the in-memory registry lives
 *  in `./registry.ts`, the generic table in `./table.ts` (Commit 2),
 *  and the concrete adapters under `./mail/`, `./file/`, `./webhook/`.
 */

import type {
  CollectionHealth,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';

/** Outcome of a retention pass. Defined here (not in retention.ts)
 *  so it's part of the `Collection` contract — consumers don't need
 *  a second import path to read the return shape of
 *  `Collection.runRetention()`. */
export interface CollectionPruneResult {
  /** Rows removed from the collection table. */
  pruned_count: number;
  /** Sum of `size_bytes` of the pruned rows. */
  bytes_freed: number;
  /** Blob hashes that the pruned rows referenced — caller routes
   *  into the orphan-CAS sweep or eager delete. */
  blob_hashes_freed: string[];
  /** Wall-clock duration of the call. */
  duration_ms: number;
  /** Set when the run short-circuited before pruning. Today the
   *  only reason is `retention_days: 0` (file-adapter default). */
  skipped_reason?: 'retention_disabled';
}

/** Sync-lifecycle hook. Adapters (IMAP, Gmail, Graph, fs.watch,
 *  webhook listener) drive inbound data via their internal loop; the
 *  owning `Collection` exposes this narrow surface so the registry
 *  and drain orchestrator can start / stop that loop without
 *  reaching into adapter internals.
 *
 *  Both methods are idempotent — a second call in the same state is
 *  a no-op, not an error. The drain pipeline relies on this so a
 *  second `pause_collections` pass (e.g. after a failed restart
 *  attempt) doesn't blow up. */
export interface CollectionSyncAdapter {
  /** Begin (or resume) continuous sync. Fetch-loop adapters spin up
   *  their poll timers here; listener-style adapters register their
   *  HTTP route or fs.watch handle. Rejects when the underlying
   *  source is unreachable — callers should surface the error as
   *  `COLLECTION_SOURCE_UNREACHABLE`. */
  start(): Promise<void>;
  /** Stop sync cleanly — cancel timers, close sockets, drop fs.watch
   *  handles. Called by `Collection.close()` during the
   *  `pause_collections` drain step. */
  stop(): Promise<void>;
}

/** The registered unit. One per `(platform, slug)`. The registry
 *  owns the lifecycle; callers interact via the read/write surface
 *  below.
 *
 *  Concurrency model: all reads + writes are synchronous on a
 *  single DB connection (better-sqlite3 is single-threaded). The
 *  sync adapter runs on its own async loop + writes through the
 *  same surface — callers don't need to serialize. */
export interface Collection {
  readonly platform: CollectionPlatform;
  /** User-chosen account / endpoint slug. Case-sensitive; passed
   *  through from TOML verbatim. */
  readonly slug: string;
  /** Gated surface this collection writes through. Each collection
   *  owns its own gate, registered with the shared gate registry
   *  under the surface name `collection:{platform}:{slug}` (Commit 6). */
  readonly gate: StorageGate;

  // ── Mutations ──────────────────────────────────────────────────
  /** Insert or update a record. Replaces the prior value for
   *  `record.record_id` (idempotent on duplicate ingest) and emits
   *  the appropriate warehouse event (`created` on first write,
   *  `updated` thereafter). */
  upsert(record: CollectionRecord): void;
  /** Remove by `record_id`. Returns `true` when a row was present
   *  and deleted, `false` when the id was unknown. Emits `deleted`
   *  on success. */
  delete(record_id: string): boolean;

  // ── Reads ──────────────────────────────────────────────────────
  /** Fetch by `record_id` or `null` when the record doesn't exist. */
  get(record_id: string): CollectionRecord | null;
  /** Filtered listing — hot-field equality filters + `received_at`
   *  range + pagination. See `CollectionListQuery`. */
  list(query: CollectionListQuery): CollectionRecord[];
  /** FTS5 body search. Results sorted by rank (lowest first per
   *  FTS5 BM25 convention). CAS-stored records are NOT indexed
   *  (documented limit — matches Phase A's shared_store). */
  search(query: CollectionSearchQuery): CollectionSearchMatch[];

  // ── Lifecycle + metrics ────────────────────────────────────────
  readonly sync: CollectionSyncAdapter;
  /** Live health snapshot. Surfaced onto the heartbeat envelope
   *  `collections[]` array and via `collection.listEndpoints`. */
  health(): CollectionHealth;
  /** Run retention. Delegates to the collection's internal
   *  `CollectionRetention` instance (built in Commit 3). The handler
   *  for `collection.runRetention` calls this directly — admin /
   *  cascade callers go through `CollectionRetention.run()` so they
   *  can distinguish the skipped-reason variants. */
  runRetention(): Promise<CollectionPruneResult>;
  /** Stop sync loops, close connections, release timers. Called
   *  from the `pause_collections` drain step via
   *  `CollectionRegistry.dispose()`. Idempotent. */
  close(): Promise<void>;
}
