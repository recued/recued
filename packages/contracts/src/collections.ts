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
   *    - mail: { from, subject, thread_id, folder, direction, is_read, labels? }
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
/** One collection's slice of a universal search — `collection.searchAll`.
 *
 *  ⛔⛔ GROUPED, NOT GLOBALLY RANKED, AND THAT IS THE WHOLE DESIGN. FTS5 `rank`
 *  is BM25 computed per index: a mail rank of -3.8 and a file rank of -2.1 are
 *  not comparable, because they are scored against different corpora with
 *  different term statistics. Interleaving them into one list produces an order
 *  that LOOKS authoritative and means nothing — the same class of lie as a
 *  snippet standing in for a record. Grouping sidesteps a comparison that has no
 *  right answer rather than papering over it with a fabricated unified score.
 *
 *  ⚠ `more` is approximate BY DESIGN, and inherits the reasoning from
 *  `more_matches` on the chat path: a store that returned exactly its quota
 *  probably has more, and a false *"there may be more"* is cheap where a false
 *  *"that is all"* is the bug. */
export interface CollectionSearchGroup {
  platform: CollectionPlatform;
  slug: string;
  matches: CollectionSearchMatch[];
  /** True when this group filled its per-group quota — see the caveat above. */
  more: boolean;
  source_freshness: CollectionSourceFreshness;
}

/** ⛔⛔ `snippet` WAS RETIRED FROM THIS SHAPE (2026-08-28). It was an FTS5
 *  `snippet()` — N tokens centred on the query terms — and every consumer that
 *  mattered read it as THE RECORD. A row could be retrieved perfectly and still
 *  hand on a fragment that stopped before the fact the question needed.
 *
 *  🔑 THE ROUND-TRIP TO THE BASE TABLE WAS ALREADY HAPPENING. Search resolves
 *  `WHERE record_id IN (...)` to hydrate `hot_fields`; the record's own text was
 *  one more column away the whole time. Using the index to find ids and the
 *  TABLE to fetch rows is the ordinary FTS pattern, and the window was standing
 *  in for a step that was already paid for.
 *
 *  ⚠ Nothing rendered it. `collection.search` returns this shape wholesale over
 *  rpc, but no webclient / MCP / door surface read `.snippet` — the model was
 *  its only consumer, which is why a preview-shaped content field was a
 *  correctness bug rather than a cosmetic one. */
export interface CollectionSearchMatch {
  record_id: string;
  hot_fields: Record<string, unknown>;
  rank: number;
  /** When the record arrived. ⛔⛔ ABSENT UNTIL 2026-08-27, AND ITS ABSENCE MADE
   *  A RETRIEVED CONVERSATION UNORDERABLE. A search returns rows in RELEVANCE
   *  order, so a seven-message negotiation came back scrambled — measured,
   *  `n0 n4 n5 n3 n6 n1 n2` — with no date on any row. The reader could not tell
   *  the refusal in message 2 from the acceptance in message 6, and for a
   *  negotiation the ORDER IS THE MEANING: a discount applies to a price stated
   *  earlier, a quantity clears an MOQ stated earlier.
   *
   *  ⚠ The list path (no query) carried `received_at` the whole time. Two paths
   *  of ONE tool answered with different shapes, and the one a question reaches
   *  is the one that lost the fact.
   *
   *  Optional because a caller that pre-dates this may construct matches without
   *  it; every collection search path in this repo now populates it. */
  received_at?: number;
  /** The record's own text, hydrated from the base table by `record_id` —
   *  NOT a match-centred window.
   *
   *  ⛔⛔ THE SNIPPET IS A RELEVANCE PREVIEW AND IT WAS BEING READ AS CONTENT.
   *  `snippet()` returns N tokens centred on the match, so a row can be
   *  retrieved perfectly and still hand on a fragment that stops before the
   *  fact the question needs. Measured on bench 276 (a 7-message negotiation
   *  whose unit price is DERIVED, never stated): the right mail was reached
   *  11/11 and the answer was right 0/11, with SEVEN DISTINCT wrong totals,
   *  because the pivotal snippet cut at `"At that volume I can…"` — one token
   *  before the two discount rates. The same 7 messages rendered whole into a
   *  single api call answered 9-11/11 correct, so the arithmetic was never the
   *  problem: the model was not shown the numbers and filled the gap.
   *
   *  🔑 SEARCH IS THE ONLY CONTENT SURFACE FOR MOST COLLECTIONS. `work` has a
   *  `work.read`; mail / calendar / deal / account / contact / enrichment do
   *  not, so whatever search omits is unreachable for the rest of the turn —
   *  there is no second call that recovers the body. That is what makes a
   *  preview-shaped content field a correctness bug rather than a UX one.
   *
   *  Absent when the record is CAS-stored (not `body_inline`) or when the
   *  result set exhausted its character budget; `body_truncated` says which
   *  side of that line a given row fell on. */
  body?: string;
  /** True when `body` is NOT the whole record — either cut at the per-record
   *  cap or omitted entirely for budget. The reader needs to know it is
   *  holding a fragment, because the alternative is treating a cut-off body
   *  as a complete one, which is exactly the failure `body` exists to fix. */
  body_truncated?: boolean;
  /** True when the row matched only SOME of the query's terms — surfaced
   *  deliberately, because the record that CORRECTS a fact rarely restates the
   *  wording of the fact it corrects ("actually Ridgeway is 90 days" carries
   *  neither "renewal" nor "notice"), and an implicit AND makes it invisible
   *  while stale full matches are returned as the complete answer.
   *
   *  ⛔ THE LABEL IS THE POINT, NOT AN ANNOTATION. Unlabelled, a partial row is
   *  indistinguishable from retrieved evidence and the reader has no reason to
   *  discount it. Labelled, it arrives as a maybe. That distinction is the same
   *  disclose-don't-decide rule as `more_matches`: the substrate widens what is
   *  VISIBLE and declines to rule on what is true. */
  partial_match?: boolean;
  /** True when the row matched NO query term and is present only because it
   *  sits in a thread another row matched.
   *
   *  ⛔ DISTINCT FROM `partial_match` ON PURPOSE. A partial match still shares
   *  vocabulary with the question; this shares none — it is here because the
   *  CONVERSATION is relevant, not the text. Labelling it `partial_match` would
   *  overstate its claim, and the whole argument for surfacing weak rows rests
   *  on the label being accurate about WHY they are there:
   *      msg1  "…move from 30d to 90d?"                  ← matched
   *      msg2  "no lets be fair & change it to 60d"      ← thread_context
   *  msg2 is the answer and carries no query term at all. */
  thread_context?: boolean;
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
  /** Phase 7 (D-110) — per-instance authentication/configuration state,
   *  independent from `state` because a credential-backed collection can be
   *  expired or unauthorized while its adapter is quiescent. D-110 file
   *  adapters themselves are local/storage-only; OAuth cloud providers use
   *  connection-backed D-192 Sources. Optional on the wire for backward
   *  compatibility — Phase D collections that have not been re-emitted carry
   *  no value. */
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
  /** Credential style. D-110 file adapters permit `'keys'` (S3-style
   *  access/secret pairs) or `'none'` (host identity for `fs` and
   *  `ext-downloads`). The file registry rejects `'oauth'`: OAuth providers
   *  use connection-backed D-192 Sources and packs. The OAuth member remains
   *  in this shared legacy shape because pre-unification mail/webhook rows use
   *  `FileCollectionCaps` as their placeholder caps. */
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
 *  a `healthy` credential-backed instance can move directly to `expired` on
 *  its next credential check without an intermediate `degraded` state.
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
 *  explicitly non-goal per D-110. OAuth-provider connections are excluded:
 *  they register D-192 Sources and use installed packs for operations. Kept
 *  in `contracts` so the extension UI + server validator share the same
 *  canonical list. */
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

// ────────────────────────────────────────────────────────────────
// D-236 — source freshness, on the read that consumes the source
// ────────────────────────────────────────────────────────────────

/** D-236 — how long a collection may go without a clean sync before its reads
 *  are considered stale by default. Matches `FILE_SOURCE_STALE_AFTER_MS` and the
 *  work-entity Source declarations so the project has ONE default, not three. */
export const COLLECTION_SOURCE_STALE_AFTER_MS = 21_600_000; // 6h

/** D-236 — the freshness verdict for a collection instance, returned ALONGSIDE
 *  the records of the read that consumed it (`collection.list` → the kernel's
 *  `email-list` / `file-list` / `webhook-list` → `{{step.<id>.source_freshness}}`).
 *
 *  ⛔ WHY IT RIDES WITH THE READ RATHER THAN SITTING IN A NAMESPACE.
 *  `last_synced_at` has been stored per collection instance since D-110 and
 *  `CollectionHealth` has aggregated it since Phase D — and in 2,200 recipes
 *  NOTHING consumed either, because reaching them required a separate lookup a
 *  recipe author had to think to write. A fact that must be fetched separately
 *  from the data it qualifies is a fact that does not get fetched. Attaching it
 *  to the read makes it impossible to hold the records without also holding the
 *  verdict on how current they are.
 *
 *  🔑 `age_ms` IS THE LOAD-BEARING FIELD, not `stale`. The correct staleness
 *  threshold is a property of the DECISION, not of the source: a recipe asking
 *  "anything renewing this year?" tolerates hours of lag, while one asking "any
 *  reply in the last 3 days?" does not. `stale` is a convenience default at
 *  `COLLECTION_SOURCE_STALE_AFTER_MS`; a recipe inferring non-occurrence over a
 *  window should compare `age_ms` against ITS OWN window instead.
 *
 *  Mirrors `FileSourceFreshness` (`last_success_at` / `degraded` / `stale`) so
 *  there is one vocabulary for source freshness across the codebase, and adds
 *  the two facts a per-instance adapter can supply that a file Source cannot:
 *  `age_ms` (so a recipe can pick its own threshold) and `pending` (the adapter
 *  is mid-catch-up RIGHT NOW, which no timestamp can express). */
export interface CollectionSourceFreshness {
  /** Unix-ms of the most recent successful sync tick; `null` = never synced. */
  last_success_at: number | null;
  /** `now - last_success_at`; `null` when never synced. The field a recipe
   *  should compare against its own decision window. */
  age_ms: number | null;
  /** The instance cannot currently be trusted to be current regardless of
   *  time — auth is not healthy, the adapter is in `error`, or it logged
   *  errors in the last 24 h. */
  degraded: boolean;
  /** Adapter backlog at read time. `> 0` means records are known to be
   *  outstanding — the strongest available "this read is incomplete" signal,
   *  and the only one that does not depend on a threshold. */
  pending: number;
  /** Degraded, never-synced, backlogged, or older than the stale threshold.
   *  A convenience default — prefer `age_ms` for a window-relative decision. */
  stale: boolean;
}

/** D-236 — derive the freshness verdict from a live `CollectionHealth`. Pure.
 *
 *  `health === null` (no such instance, or an adapter whose `health()` threw)
 *  → never-synced + stale, matching `deriveFileSourceFreshness`'s treatment of a
 *  missing Source row. Fails toward "you cannot trust this read", which is the
 *  only safe direction for a fact whose whole purpose is to qualify an absence. */
export const deriveCollectionSourceFreshness = (
  health: CollectionHealth | null,
  now: number,
  staleAfterMs: number = COLLECTION_SOURCE_STALE_AFTER_MS,
): CollectionSourceFreshness => {
  if (health === null) {
    return { last_success_at: null, age_ms: null, degraded: false, pending: 0, stale: true };
  }
  // `last_indexed_at` is documented as 0 before the first successful sync.
  const last_success_at = health.last_indexed_at > 0 ? health.last_indexed_at : null;
  const age_ms = last_success_at === null ? null : Math.max(0, now - last_success_at);
  const pending = health.pending_queue_size;
  const degraded =
    (health.auth_state !== undefined && health.auth_state !== 'healthy')
    || health.state === 'error'
    || health.error_count_24h > 0;
  const stale =
    degraded || last_success_at === null || pending > 0 || (age_ms ?? 0) > staleAfterMs;
  return { last_success_at, age_ms, degraded, pending, stale };
};

/** D-236 — derive the verdict from a collection's `health()` THUNK, tolerating a
 *  throwing adapter.
 *
 *  ⛔ Exists so the try/catch is written ONCE. Six call sites now need it —
 *  `collection.list` / `.get` / `.search` plus `calendar-list` / `-get` /
 *  `-search` — and six hand-rolled copies of "swallow the throw, fail toward
 *  stale" is six chances for one of them to quietly fail toward FRESH instead,
 *  which is the one direction that turns this fact back into the bug it exists
 *  to fix. A misbehaving adapter must never fail the read the caller actually
 *  asked for (the policy `handleCollectionListEndpoints` already applies), but
 *  it must also never render as "current". */
export const collectionSourceFreshnessOf = (
  health: () => CollectionHealth,
  now: number,
  staleAfterMs: number = COLLECTION_SOURCE_STALE_AFTER_MS,
): CollectionSourceFreshness => {
  let snapshot: CollectionHealth | null;
  try {
    snapshot = health();
  } catch {
    snapshot = null;
  }
  return deriveCollectionSourceFreshness(snapshot, now, staleAfterMs);
};

/** D-237 P1 — one instance's verdict, keyed by the slug it qualifies.
 *
 *  The AI-facing reads fan out across EVERY instance of a platform, so a single
 *  verdict cannot describe them: one mailbox synced a minute ago and another
 *  broken for a week are one `mail.search` result. Mirrors the shape the CRM
 *  trio already ships (`crm_freshness: CrmConnectionFreshness[]`, keyed by
 *  `connection_name`) rather than inventing a second convention for the same
 *  question. */
export interface CollectionSourceFreshnessEntry extends CollectionSourceFreshness {
  /** The instance this verdict is about — joins to the `collection_slug`
   *  carried on each match. */
  collection_slug: string;
}

/** D-237 P1 — derive the per-instance verdicts for a fan-out read.
 *
 *  ⛔ Exists for the reason `collectionSourceFreshnessOf` exists one level down:
 *  the three AI-facing handlers would otherwise each hand-roll the same map, and
 *  a per-handler copy is a per-handler chance to drop an instance from the array
 *  — which renders as "that mailbox is fine" rather than as an error. Fails the
 *  same direction as its callee: an adapter whose `health()` throws is reported
 *  stale, never omitted.
 *
 *  ⚠ An EMPTY input yields an EMPTY array, and that is not the same fact as "the
 *  sources are fresh". A caller with no instances at all must say so separately
 *  — the AI reads `collections: []` for that, and the two are different
 *  questions (no mailbox enrolled vs. an enrolled mailbox that is behind). */
export const collectionSourceFreshnessFanOut = (
  collections: ReadonlyArray<{ slug: string; health: () => CollectionHealth }>,
  now: number,
  staleAfterMs: number = COLLECTION_SOURCE_STALE_AFTER_MS,
): CollectionSourceFreshnessEntry[] =>
  collections.map((c) => ({
    collection_slug: c.slug,
    ...collectionSourceFreshnessOf(c.health, now, staleAfterMs),
  }));
