/** Phase D (D-106) — warehouse collection shared types.
 *
 *  One shape behind every collection (mail / file / webhook). The
 *  server-side runtime builds adapters that populate a durable table
 *  per `(platform, slug)` pair, and exposes them via the kernel
 *  ingredients (`email-list`, `file-list`, `webhook-list`, etc.) —
 *  all of which dispatch to the `collection.*` rpc methods declared
 *  in `rpc/server-registry.ts`.
 *
 *  Records are append-mostly: adapters write on sync, retention
 *  prunes on age, recipes read via the kernel ingredients. Direct
 *  writes from recipes are NOT exposed — Phase D warehouse namespaces
 *  (`data.email.*`, `data.file.*`, `data.webhook.<endpoint>.*`) are
 *  read-only for recipes (D-106 #12). The `data.shared.*` path
 *  remains the writable sibling, owned by `shared-write`.
 */

import type { Actor } from './commits.js';

/** Identifiers for the warehouse platforms. Kept as a union rather
 *  than a string so handlers can exhaustively narrow on the platform
 *  discriminator. `'calendar'` was added in D-117 on top of the Phase
 *  D launch three (mail / file / webhook). `'service'` (D-118) is the
 *  fifth platform — typed process-execution endpoints rather than a
 *  stream of records, but rides on the same `collection_instances`
 *  row + capability-cache machinery. */
export type CollectionPlatform = 'mail' | 'file' | 'webhook' | 'calendar' | 'service';

/** One record inside a collection table. The shape is identical across
 *  mail / file / webhook; `(platform, slug)` identify which table a
 *  record lives in — they travel on the surrounding rpc envelope, not
 *  on the record itself, so records can be stored without redundant
 *  tags.
 *
 *  Body storage is split at 64 KB: ≤ 64 KB goes inline, above spills
 *  to the CAS filesystem with `blob_hash` pointing at the entry.
 *  `body_inline` and `blob_hash` are mutually exclusive — at most
 *  one is present. */
export interface CollectionRecord {
  /** Unique identifier inside this collection. Stable across re-syncs
   *  so repeated ingestion of the same source message is idempotent.
   *  Typical sources: IMAP `UID@folder`, SHA-256 of file path, ULID
   *  for webhook deliveries. */
  record_id: string;
  /** Unix-ms — first time this record landed in our store. Set once
   *  on insert and never modified; drives age-based retention. */
  received_at: number;
  /** Unix-ms — most recent modification (source-side or local).
   *  Updated on every upsert. */
  modified_at: number;
  /** Hand-specified "hot" fields indexed for cheap filtering. Per-
   *  collection schema:
   *    - mail: { from, subject, thread_id, folder, is_read, labels? }
   *    - file: { path, mime_type, size, mtime }
   *    - webhook: { method, headers_subset, remote_ip, query }
   *  Stored as JSON; queryable via SQLite `json_extract`. */
  hot_fields: Record<string, unknown>;
  /** Total body size in bytes (inline or blob). Drives gate
   *  accounting + retention size passes. */
  size_bytes: number;
  /** Source-provided ID (RFC-822 Message-ID, file path, webhook
   *  request id). Separate from `record_id` because `record_id` may
   *  hash `(source_id, slug)` to disambiguate across accounts. */
  source_id: string;
  /** Inline body when `size_bytes <= 64 * 1024`. UTF-8 text; callers
   *  that want HTML / binary reach into the CAS blob instead. */
  body_inline?: string;
  /** CAS blob hash when `size_bytes > 64 * 1024`. Points at the CAS
   *  entry under `{data_path}/cas/`. Mutually exclusive with
   *  `body_inline`. */
  blob_hash?: string;
  /** D-161 P1 — origin provenance facet: the actor of the execution
   *  that wrote this warehouse row. Collection rows (mail / calendar /
   *  file / webhook) are adapter-synced server-side and never recipe-
   *  written (see header), so the write-actor is always `'system'`,
   *  which the table stamps by column default. Read-back facet (I-5);
   *  absent on rows read before the column migration. */
  origin_actor?: Actor;
  /** D-161 P1 — contract in force on the writing execution. Always
   *  absent for the `'system'` sync writer; reserved for shape parity
   *  with the other stamped row kinds. */
  origin_contract_id?: string;
}

/** List query for `collection.list`. Hot-field filters + `received_at`
 *  range + pagination. Filters are ANDed. Unknown filter keys are
 *  silently ignored so new hot fields added by a later adapter don't
 *  break older callers. */
export interface CollectionListQuery {
  platform: CollectionPlatform;
  slug: string;
  /** Hot-field filters. Keys match entries under `hot_fields`.
   *  Equality only — range / regex filters stay out-of-scope for
   *  Phase D (the FTS5 path handles text search). */
  filters?: Record<string, unknown>;
  /** Lower bound on `received_at` (inclusive, unix-ms). */
  since?: number;
  /** Upper bound on `received_at` (exclusive, unix-ms). */
  until?: number;
  /** Lower bound on `modified_at` (inclusive, unix-ms). Distinct from
   *  `since`: authors of the `file-watcher` kernel ingredient want to
   *  detect records whose underlying source was touched after a
   *  cursor — `received_at` only captures the first insert, whereas
   *  `modified_at` tracks re-syncs + local edits. Combines with
   *  `since` via AND when both are present. */
  modified_since?: number;
  /** Max records returned. Server clamps to an internal ceiling
   *  (typically 500) when omitted or above the ceiling. */
  limit?: number;
}

/** FTS5 search query for `collection.search`. `query` is a raw FTS5
 *  MATCH expression — callers should sanitize user-supplied text or
 *  funnel it through `value-hint`'s escape helper. */
export interface CollectionSearchQuery {
  platform: CollectionPlatform;
  slug: string;
  query: string;
  limit?: number;
}

/** One match row from `collection.search`. `rank` comes directly from
 *  FTS5's BM25 — smaller is better (FTS5 convention: negative numbers
 *  sort higher). `snippet` is a short highlighted excerpt around the
 *  first match. */
export interface CollectionSearchMatch {
  record_id: string;
  hot_fields: Record<string, unknown>;
  rank: number;
  snippet: string;
}

/** Adapter state. Values are intentionally narrow so the Phase G
 *  status card can render each as a discrete pill. Transitions are
 *  non-linear (an `idle` adapter can move directly to `error` on
 *  credential revocation), so callers must treat this as a flag, not
 *  a state-machine position. */
export type CollectionState =
  | 'connected'
  | 'disconnected'
  | 'syncing'
  | 'idle'
  | 'error';

/** Per-collection health snapshot. Surfaced on the heartbeat envelope
 *  `collections[]` array and inside `collection.listEndpoints`
 *  responses. All counters are live — the server never caches these,
 *  so every read is a fresh observation. */
export interface CollectionHealth {
  platform: CollectionPlatform;
  slug: string;
  /** Unix-ms of the most recent successful sync tick. 0 before the
   *  first successful sync (i.e. while the adapter is still doing its
   *  initial scan). */
  last_indexed_at: number;
  /** Adapter-specific queue depth — IMAP fetch backlog, file scan
   *  queue, webhook in-flight count. 0 when the adapter is caught up. */
  pending_queue_size: number;
  /** Rolling count of errors in the last 24 h. Cycles back to 0
   *  across the day boundary. */
  error_count_24h: number;
  state: CollectionState;
  /** Phase 7 (D-110) — per-instance authentication state. Independent
   *  from `state` because a mail / file instance can sit with an
   *  expired OAuth token while the adapter itself is quiescent. The
   *  extension's Server → Collections card renders this alongside
   *  `state` so the re-auth CTA surfaces without waiting for the next
   *  tick. Optional on the wire for backward compatibility — Phase D
   *  collections that haven't been re-emitted carry no value. */
  auth_state?: CollectionAuthState;
  /** D-117 — events in the warehouse within the current expansion
   *  window. Present only when `platform === 'calendar'`; consumers
   *  must narrow on the platform discriminator before reading. */
  event_count?: number;
  /** D-117 — events with `start_at` in the next 24 h. Present only
   *  when `platform === 'calendar'`. Dashboard tile consumes this. */
  upcoming_count_24h?: number;
}

/** D-117 — narrow variant emitted by the calendar adapter. Requires
 *  the calendar-specific counters; assignable to `CollectionHealth`.
 *  Consumers that want to treat calendar health rows distinctly
 *  narrow with `health.platform === 'calendar'` and then read the
 *  mandatory calendar-specific fields through this interface. */
export interface CalendarCollectionHealth extends CollectionHealth {
  platform: 'calendar';
  event_count: number;
  upcoming_count_24h: number;
}

/** Phase 7 (D-110) — instance capability model.
 *
 *  Populated at enroll time by the adapter's `probeCaps()`, cached on
 *  the `collection_instances` DB row, and read at parseRecipe time so
 *  capability mismatches ("file-write against a read-only adapter")
 *  surface as install-time errors rather than runtime surprises.
 *
 *  Every adapter returns all seven fields — the interface exists so
 *  recipes gate on caps, not on adapter identity. This preserves the
 *  portability property the D-110 spec promises: switching a recipe
 *  from an fs-backed to an s3-backed instance just works as long as
 *  caps remain sufficient.
 *
 *  Runtime gate: effective caps at call time are
 *  `cached_caps AND auth_state === 'healthy'`. Transient auth expiry
 *  flips `auth_state` without rewriting the cached caps shape, so
 *  the next successful probe restores the adapter automatically. */
export interface FileCollectionCaps {
  /** Always `'yes'` — any adapter in the registry can list + fetch. A
   *  write-only sink has no place in the file-collection model (no
   *  recipes would read from it). */
  read: 'yes';
  /** Whether the adapter can write new records on behalf of recipes.
   *  `'no'` for read-only sources like `ext-downloads` (the server
   *  owns the canonical copy once a download streams over — uploading
   *  back to the browser is out of scope). */
  write: 'yes' | 'no';
  /** Whether the adapter can delete records. Write-capable adapters
   *  without delete permission (e.g. an S3 bucket IAM policy that
   *  allows PutObject but not DeleteObject) sit at `write: 'yes',
   *  delete: 'no'`. The `file-move` ingredient refuses a destination
   *  at `write: 'yes', delete: 'no'` only when the source cleanup
   *  would fail — the caps combination itself is legal. */
  delete: 'yes' | 'no';
  /** Observation mode — `'realtime'` fires events as the underlying
   *  source changes (`fs.watch`, S3 bucket notifications,
   *  `chrome.downloads` listeners); `'poll'` runs a scheduled scan;
   *  `'none'` means the instance is a one-shot query surface. */
  watch: 'realtime' | 'poll' | 'none';
  /** Mirror policy — `'required'` means the adapter copies content
   *  into the warehouse on every event (ext-downloads has no durable
   *  source, so mirror is the only coherent model); `'optional'` is
   *  user-configurable per instance; `'disabled'` means records stay
   *  as pointers into the source and the collection carries metadata
   *  only. */
  mirror: 'optional' | 'required' | 'disabled';
  /** Credential style. `'keys'` covers S3-style access/secret pairs;
   *  `'oauth'` is token-refresh-based (Dropbox, Google Drive when
   *  they land); `'none'` is for adapters that rely on the host
   *  process identity (`fs`, `ext-downloads`). */
  auth: 'none' | 'oauth' | 'keys';
  /** How the adapter names records. Consumers (recipes, kernel
   *  ingredients) normalise paths against this — an `fs` `posix`
   *  adapter accepts forward-slash paths; an `s3-key` adapter accepts
   *  keys without the bucket prefix; a `uri` adapter (webhooks,
   *  cloud-hosted endpoints) accepts absolute URIs. */
  path_style: 'posix' | 's3-key' | 'uri';
}

/** Phase 7 — `file-stat` output shape.
 *
 *  Cheap metadata read for a single record inside a file-adapter
 *  instance. Every adapter implements `statRecord` so recipes can
 *  ask "does this exist?" / "how large is it?" / "when did it
 *  change?" without paying for the full body.
 *
 *  When `exists: false`, the other fields are intentionally absent
 *  rather than zeroed — a missing file has no meaningful size or
 *  modified_at. Callers branch on `exists` before reading the rest.
 *
 *  `mime` is adapter-best-effort. fs derives from file extension;
 *  s3 reports the object's stored Content-Type; ext-downloads reads
 *  `chrome.downloads.mime`. May be absent when the adapter has no
 *  way to determine it. */
export interface FileRecordStat {
  exists: boolean;
  /** File size in bytes. Present when `exists: true`. */
  size_bytes?: number;
  /** Last-modified timestamp in unix ms (UTC). Present when
   *  `exists: true` AND the adapter can report it — some S3-
   *  compatible stores with clock-skewed responses may omit. */
  modified_at_ms?: number;
  /** Best-effort MIME. Absent when the adapter cannot determine it. */
  mime?: string;
}

/** Phase 7 (D-110) — per-instance authentication state.
 *
 *  Values are intentionally narrow so the Server → Collections card
 *  can render each as a discrete pill. Transitions are non-linear:
 *  a `healthy` OAuth instance can move directly to `expired` on the
 *  next refresh failure without an intermediate `degraded` state.
 *
 *  Effective caps at dispatch time are `caps AND auth_state ===
 *  'healthy'` — any other state shorts every write + delete to a
 *  runtime `AUTH_EXPIRED` error, independently from the cached caps. */
export type CollectionAuthState =
  | 'healthy'
  | 'expired'
  | 'unauthorized'
  | 'degraded';

/** Phase 7 (D-110) — hardcoded file-adapter registry keys.
 *
 *  Every string that ships in a DB row must parse to one of these. We
 *  keep it closed: new adapters require an upstream contribution so
 *  we can audit the probe + security posture; plugin adapters are
 *  explicitly non-goal per D-110. Kept in `contracts` so the
 *  extension UI + server validator share the same canonical list. */
export type FileAdapterType = 'fs' | 's3' | 'ext-downloads';

/** D-117 — union of every per-platform capability shape. Calendar
 *  was added in D-117; service (D-118) is the next entrant — its
 *  cap shape encodes install / lifecycle / invoke / health surfaces
 *  rather than read/write/delete. Mail / webhook still ride on the
 *  placeholder file caps from the D-111 autopromote
 *  (`PLACEHOLDER_URI_CAPS`). Future platforms widen this union;
 *  consumers narrow by `platform` discriminator on the surrounding
 *  row before reading caps fields. */
export type CollectionCaps =
  | FileCollectionCaps
  | import('./calendar.js').CalendarCollectionCaps
  | import('./service.js').ServiceCollectionCaps;

/** Phase 7 (D-110) — DB-backed instance row surfaced over the rpc
 *  `collection.listInstances`. Carries everything parseRecipe needs
 *  to validate a recipe's ingredient/instance pairing: the slug
 *  users reference in `target`, the adapter identity (for UI
 *  rendering), the cached caps (for gating), and the current
 *  auth_state (so an expired instance shows up as a warning, not a
 *  silent caps match).
 *
 *  `config` is NOT on this shape — it may carry secrets (S3 access
 *  keys) and stays encrypted in the DB. The extension reads it
 *  through a dedicated `collection.file.getConfig` rpc that
 *  redacts secret fields. */
export interface CollectionInstanceRow {
  slug: string;
  platform: CollectionPlatform;
  /** The registry key — `'fs'` / `'s3'` / `'ext-downloads'` for file,
   *  `'gmail'` / `'graph'` / `'imap'` for mail, `'webhook'` for the
   *  existing webhook collection, `'gcal'` / `'graph'` / `'caldav'`
   *  for calendar (D-117). Drives which enroll/update form the UI
   *  renders. */
  adapter_type: string;
  /** Cached capability shape. File rows carry `FileCollectionCaps`,
   *  calendar rows carry `CalendarCollectionCaps`. Consumers narrow
   *  on `platform` before reading platform-specific cap fields. */
  caps: CollectionCaps;
  auth_state: CollectionAuthState;
  /** Unix-ms of the last successful sync tick for this instance.
   *  Surfaced for the "Last synced" UI label. `null` before the
   *  first tick. */
  last_synced_at: number | null;
}
