/** D-139 Phase 1a.1 — engagement substrate storage.
 *
 *  Three SQLite tables driving the engagement layer:
 *
 *    - `engagements` — per-row engagement records keyed on the
 *      composite primary key `(connection_id, target_id)` per Pass-3
 *      R3.2. Carries the full Pass-4 evidence-quality contract surface
 *      (authorship + direction + dedupe_confidence + lifecycle_state +
 *      tz hint + vendor_modstamp) + the body-state machine + per-entity
 *      bistemporal time fields + the tombstone columns. Body inline
 *      content is server-internal; resolver projections strip body for
 *      MCP responses by default per § A.9.5.
 *    - `engagement_edges` — first-class many-to-many association
 *      table per § A.4. Composite UNIQUE on `(connection_id,
 *      engagement_target_id, edge_type, target_id)`; tombstone-on-
 *      disassociate via `deleted_at`; index on
 *      `(connection_id, engagement_target_id)` for the reconciler write
 *      path + index on `connection_id` for the connection-delete
 *      cascade.
 *    - `engagement_inbound_event_ledger` — replay-window dedup table
 *      per § A.3.8. Composite UNIQUE on `(connection_id, vendor,
 *      idempotency_key)`. D-123 housekeeping compacts entries older
 *      than `ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS` (24h).
 *    - `engagement_dedupe_candidates` — multi-candidate ambiguity
 *      surface per Pass-5 R5.6. Resolver joins per-row to populate
 *      `dedupe_candidates: Array<...>` on probable-confidence rows.
 *
 *  All four tables are server-internal — no cross-cloud sync (D-097 / D-168).
 *
 *  D-138 identity-resolution: the contact-edge writer routes every
 *  `edge_type='contact'` write through `resolveContactIdentity` BEFORE
 *  insert. Loser-email engagements attach to survivor canonical rows
 *  on first ingest. Read-side identity-expansion in
 *  `data.contact.<email>.engagements` resolves loser-email queries
 *  through D-138's `merged_into` chain to the survivor's full member
 *  set per § A.5.0.
 *
 *  Spec: D-139 § A.3, § A.3.5, § A.3.8, § A.4, § A.5,
 *  § A.5.0, § A.5.1. */

import type Database from 'better-sqlite3';
import {
  type Authorship,
  type AttachmentMeta,
  type BodyState,
  type CoverageMetadata,
  type DedupeAcceptance,
  type DedupeConfidence,
  DEDUPE_RESOLUTION_STATE_VALUES,
  type DedupeResolutionState,
  type Direction,
  type EngagementDedupeCandidateProjection,
  type EngagementDedupeCandidateRow,
  type EngagementEdge,
  type EngagementEdgeTargetKind,
  type EngagementEdgeType,
  type EngagementInboundDeliveryPath,
  type EngagementInboundEventLedgerRow,
  type EngagementRow,
  type EngagementVendor,
  type EngagementsResolverArgs,
  type EngagementsResolverCursor,
  type EngagementsResolverResult,
  type EngagementsResolverRow,
  ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP,
  ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS,
  ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE,
  ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS,
  ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE,
  decodeEngagementsCursor,
  encodeEngagementsCursor,
  isAuthorship,
  isBodyState,
  isDedupeConfidence,
  isDirection,
  isEngagementEdgeTargetKind,
  isEngagementEdgeType,
  isEngagementInboundDeliveryPath,
  isEngagementLifecycleState,
  resolveContactIdentity,
  type EngagementLifecycleState,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Table names
// ────────────────────────────────────────────────────────────────

export const ENGAGEMENTS_TABLE = 'engagements';
export const ENGAGEMENT_EDGES_TABLE = 'engagement_edges';
export const ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE =
  'engagement_inbound_event_ledger';
export const ENGAGEMENT_DEDUPE_CANDIDATES_TABLE =
  'engagement_dedupe_candidates';

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

export class EngagementInvalidError extends Error {
  readonly code = 'ENGAGEMENT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'EngagementInvalidError';
  }
}

export class EngagementCursorInvalidError extends Error {
  readonly code = 'ENGAGEMENT_CURSOR_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'EngagementCursorInvalidError';
  }
}

// ────────────────────────────────────────────────────────────────
// Schema bootstrap
// ────────────────────────────────────────────────────────────────

/** Idempotent schema bootstrap. Safe to call on every boot.
 *
 *  Pre-launch zero-migration discipline (per
 *  `feedback_pre_launch_no_migration.md`): every CREATE uses
 *  `IF NOT EXISTS`; no `ALTER TABLE` paths needed since this is a
 *  fresh substrate. Future column additions land via the same
 *  `addColumn` helper pattern the contact / enrichment stores use. */
export const ensureEngagementSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ENGAGEMENTS_TABLE} (
      connection_id          TEXT NOT NULL,
      target_id              TEXT NOT NULL,
      vendor                 TEXT NOT NULL,
      entity                 TEXT NOT NULL,
      meta                   TEXT NOT NULL,
      mirror_blob_hash       TEXT,
      authorship             TEXT NOT NULL,
      direction              TEXT NOT NULL,
      dedupe_confidence      TEXT NOT NULL,
      lifecycle_state        TEXT NOT NULL,
      attachments            TEXT,
      event_at               INTEGER,
      event_at_tz_hint       TEXT,
      event_at_tz_inferred   INTEGER,
      vendor_raw_timestamp   TEXT,
      due_at                 INTEGER,
      due_at_is_date_only    INTEGER,
      completed_at           INTEGER,
      scheduled_start_at     INTEGER,
      vendor_created_at      INTEGER NOT NULL,
      vendor_modified_at     INTEGER NOT NULL,
      vendor_modstamp        TEXT,
      ingested_at            INTEGER NOT NULL,
      body_state             TEXT NOT NULL,
      body_inline            TEXT,
      body_truncation_offset INTEGER,
      deleted_at             INTEGER,
      deletion_provenance    TEXT,
      PRIMARY KEY (connection_id, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_engagements_event_at_desc
      ON ${ENGAGEMENTS_TABLE} (event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engagements_vendor_modified
      ON ${ENGAGEMENTS_TABLE} (vendor, vendor_modified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engagements_lifecycle
      ON ${ENGAGEMENTS_TABLE} (lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_engagements_connection
      ON ${ENGAGEMENTS_TABLE} (connection_id);

    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_EDGES_TABLE} (
      connection_id          TEXT NOT NULL,
      engagement_target_id   TEXT NOT NULL,
      edge_type              TEXT NOT NULL,
      target_kind            TEXT NOT NULL,
      target_id              TEXT NOT NULL,
      vendor                 TEXT,
      created_at             INTEGER NOT NULL,
      deleted_at             INTEGER,
      PRIMARY KEY (connection_id, engagement_target_id, edge_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_edges_by_target
      ON ${ENGAGEMENT_EDGES_TABLE} (target_kind, target_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_engagement_edges_by_engagement
      ON ${ENGAGEMENT_EDGES_TABLE} (connection_id, engagement_target_id);
    CREATE INDEX IF NOT EXISTS idx_engagement_edges_by_connection
      ON ${ENGAGEMENT_EDGES_TABLE} (connection_id);

    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE} (
      connection_id    TEXT NOT NULL,
      vendor           TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL,
      vendor_modstamp  TEXT,
      delivery_path    TEXT NOT NULL,
      observed_at      INTEGER NOT NULL,
      PRIMARY KEY (connection_id, vendor, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_inbound_ledger_observed_at
      ON ${ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE} (observed_at);

    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_DEDUPE_CANDIDATES_TABLE} (
      source_connection_id     TEXT NOT NULL,
      source_target_id         TEXT NOT NULL,
      candidate_connection_id  TEXT NOT NULL,
      candidate_target_id      TEXT NOT NULL,
      match_key                TEXT NOT NULL,
      confidence               TEXT NOT NULL,
      resolution_state         TEXT NOT NULL,
      detected_at              INTEGER NOT NULL,
      resolved_at              INTEGER,
      resolved_by              TEXT,
      PRIMARY KEY (source_connection_id, source_target_id, candidate_connection_id, candidate_target_id, match_key)
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_dedupe_candidates_by_source
      ON ${ENGAGEMENT_DEDUPE_CANDIDATES_TABLE}
      (source_connection_id, source_target_id, resolution_state);
    CREATE INDEX IF NOT EXISTS idx_engagement_dedupe_candidates_by_pending
      ON ${ENGAGEMENT_DEDUPE_CANDIDATES_TABLE} (resolution_state)
      WHERE resolution_state = 'pending';
  `);
};

// ────────────────────────────────────────────────────────────────
// Row → DB serialization
// ────────────────────────────────────────────────────────────────

interface EngagementDbRow {
  connection_id: string;
  target_id: string;
  vendor: string;
  entity: string;
  meta: string;
  mirror_blob_hash: string | null;
  authorship: string;
  direction: string;
  dedupe_confidence: string;
  lifecycle_state: string;
  attachments: string | null;
  event_at: number | null;
  event_at_tz_hint: string | null;
  event_at_tz_inferred: number | null;
  vendor_raw_timestamp: string | null;
  due_at: number | null;
  due_at_is_date_only: number | null;
  completed_at: number | null;
  scheduled_start_at: number | null;
  vendor_created_at: number;
  vendor_modified_at: number;
  vendor_modstamp: string | null;
  ingested_at: number;
  body_state: string;
  body_inline: string | null;
  body_truncation_offset: number | null;
  deleted_at: number | null;
  deletion_provenance: string | null;
}

const validateRow = (row: EngagementRow): void => {
  // D-192 — vendor is opaque provenance on the row (the reconciler write-path
  // only runs for registry-declared engagement vendors); reject only corrupt.
  if (row.vendor.length === 0) {
    throw new EngagementInvalidError('vendor must be non-empty');
  }
  if (!isAuthorship(row.authorship)) {
    throw new EngagementInvalidError(`invalid authorship '${row.authorship}'`);
  }
  if (!isDirection(row.direction)) {
    throw new EngagementInvalidError(`invalid direction '${row.direction}'`);
  }
  if (!isDedupeConfidence(row.dedupe_confidence)) {
    throw new EngagementInvalidError(
      `invalid dedupe_confidence '${row.dedupe_confidence}'`,
    );
  }
  if (!isEngagementLifecycleState(row.lifecycle_state)) {
    throw new EngagementInvalidError(
      `invalid lifecycle_state '${row.lifecycle_state}'`,
    );
  }
  if (!isBodyState(row.body_state)) {
    throw new EngagementInvalidError(`invalid body_state '${row.body_state}'`);
  }
  if (row.connection_id === '' || row.target_id === '') {
    throw new EngagementInvalidError(
      'connection_id + target_id must both be non-empty',
    );
  }
};

const toDbRow = (row: EngagementRow): EngagementDbRow => ({
  connection_id: row.connection_id,
  target_id: row.target_id,
  vendor: row.vendor,
  entity: row.entity,
  meta: JSON.stringify(row.meta ?? {}),
  mirror_blob_hash: row.mirror_blob_hash,
  authorship: row.authorship,
  direction: row.direction,
  dedupe_confidence: row.dedupe_confidence,
  lifecycle_state: row.lifecycle_state,
  attachments: row.attachments ? JSON.stringify(row.attachments) : null,
  event_at: row.event_at,
  event_at_tz_hint: row.event_at_tz_hint ?? null,
  event_at_tz_inferred:
    row.event_at_tz_inferred === undefined
      ? null
      : row.event_at_tz_inferred
        ? 1
        : 0,
  vendor_raw_timestamp: row.vendor_raw_timestamp ?? null,
  due_at: row.due_at ?? null,
  due_at_is_date_only:
    row.due_at_is_date_only === undefined
      ? null
      : row.due_at_is_date_only
        ? 1
        : 0,
  completed_at: row.completed_at ?? null,
  scheduled_start_at: row.scheduled_start_at ?? null,
  vendor_created_at: row.vendor_created_at,
  vendor_modified_at: row.vendor_modified_at,
  vendor_modstamp: row.vendor_modstamp ?? null,
  ingested_at: row.ingested_at,
  body_state: row.body_state,
  body_inline: row.body_inline ?? null,
  body_truncation_offset: row.body_truncation_offset ?? null,
  deleted_at: row.deleted_at ?? null,
  deletion_provenance: row.deletion_provenance
    ? JSON.stringify(row.deletion_provenance)
    : null,
});

const fromDbRow = (db: EngagementDbRow): EngagementRow => {
  const row: EngagementRow = {
    connection_id: db.connection_id,
    target_id: db.target_id,
    vendor: db.vendor as EngagementVendor,
    entity: db.entity,
    meta: safeParseJson<Record<string, unknown>>(db.meta) ?? {},
    mirror_blob_hash: db.mirror_blob_hash,
    authorship: db.authorship as Authorship,
    direction: db.direction as Direction,
    dedupe_confidence: db.dedupe_confidence as DedupeConfidence,
    lifecycle_state: db.lifecycle_state as EngagementLifecycleState,
    event_at: db.event_at,
    vendor_created_at: db.vendor_created_at,
    vendor_modified_at: db.vendor_modified_at,
    ingested_at: db.ingested_at,
    body_state: db.body_state as BodyState,
  };
  const attachments = safeParseJson<AttachmentMeta[]>(db.attachments);
  if (attachments) row.attachments = attachments;
  if (db.event_at_tz_hint !== null) row.event_at_tz_hint = db.event_at_tz_hint;
  if (db.event_at_tz_inferred !== null)
    row.event_at_tz_inferred = db.event_at_tz_inferred === 1;
  if (db.vendor_raw_timestamp !== null)
    row.vendor_raw_timestamp = db.vendor_raw_timestamp;
  if (db.due_at !== null) row.due_at = db.due_at;
  if (db.due_at_is_date_only !== null)
    row.due_at_is_date_only = db.due_at_is_date_only === 1;
  if (db.completed_at !== null) row.completed_at = db.completed_at;
  if (db.scheduled_start_at !== null)
    row.scheduled_start_at = db.scheduled_start_at;
  if (db.vendor_modstamp !== null) row.vendor_modstamp = db.vendor_modstamp;
  if (db.body_inline !== null) row.body_inline = db.body_inline;
  if (db.body_truncation_offset !== null)
    row.body_truncation_offset = db.body_truncation_offset;
  if (db.deleted_at !== null) row.deleted_at = db.deleted_at;
  const provenance = safeParseJson<EngagementRow['deletion_provenance']>(
    db.deletion_provenance,
  );
  if (provenance) row.deletion_provenance = provenance;
  return row;
};

const safeParseJson = <T>(raw: string | null): T | null => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

// ────────────────────────────────────────────────────────────────
// Store API
// ────────────────────────────────────────────────────────────────

/** D-138 P1 contact-store callback used by edge writes. Surfaces the
 *  `merged_into` field for the `resolveContactIdentity` walk; the boot
 *  wire wraps the contact-store's `get` to project the row into this
 *  shape (mapping a stored `null` `merged_into` to `undefined` to match
 *  the resolver's type). */
export type ContactRedirectLookup = (
  canonical_email: string,
) => { merged_into?: string } | null;

/** D-138 P1 contact-store callback used by read-side identity-
 *  expansion. Returns every email whose `merged_into` chain terminates at
 *  `survivor_email` — the addresses merged AWAY into it.
 *
 *  ⚠ **The survivor's own email is NOT included, and the caller must add it.**
 *  (`resolveEngagementsForContact` does — `members.add(survivor)`.) The
 *  production binding is `ContactStore.listMergedSourceEmails`, whose CTE seeds
 *  on `WHERE merged_into = ?`; a live row's `merged_into` is NULL, so it can
 *  never match the survivor itself. This doc-comment used to claim the survivor
 *  "is always included" — it never was, and a caller that believed it would
 *  read a contact's whole history while omitting the contact. Prefer
 *  `contactAddressSet` (`contact-merge-graph.ts`), which returns the COMPLETE
 *  set and cannot be misread this way. */
export type ContactIdentityExpansion = (
  survivor_email: string,
) => ReadonlyArray<string>;

/** D-184 Decision 2 — live exact-twin resolver hook. Given the raw
 *  RFC822 Message-IDs (as stored in each email engagement's
 *  `meta.message_id`) of the email rows on the current resolver page,
 *  returns a map from each input id to the matched local `data.mail`
 *  record_id. An input absent from the map has no local mail twin.
 *  Resolution is LIVE — the resolver calls this each read, so adding or
 *  removing a mailbox is reflected without any re-ingest. When the dep
 *  is not supplied (no mail adapter wired, or a caller that doesn't want
 *  the join) exact-twin resolution is skipped and rows keep their
 *  as-ingested `body_state`. Implemented over `data.mail`'s normalized
 *  `rfc_message_id` hot field — see `createMailTwinResolver`. */
export type MailTwinResolver = (
  messageIds: ReadonlyArray<string>,
) => ReadonlyMap<string, string>;

export interface UpsertEngagementInput {
  row: EngagementRow;
  /** When provided, every contact-edge write routes through
   *  `resolveContactIdentity` first. Default identity (passthrough)
   *  is the test-only path; the boot wire always passes the contact
   *  store's lookup. */
  resolveContactRedirect?: ContactRedirectLookup;
}

export interface UpsertEdgeInput extends EngagementEdge {
  /** D-138 redirect lookup. **Required** for `edge_type === 'contact'`
   *  writes — every contact edge passes through `resolveContactIdentity`
   *  per § A.5 ("D-138 identity resolution at link emission —
   *  load-bearing"). Tests that don't exercise the redirect chain pass
   *  the identity callback `() => null`. Non-contact edges may omit. */
  resolveContactRedirect?: ContactRedirectLookup;
}

/** D-139 P1a.1 fold-back — atomic ingest API. The reconciler (and
 *  webhook processor) call this single method to write the engagement
 *  row + the full edge set + dedupe-candidate rows in one SQLite
 *  transaction per spec § A.4: "The reconciler emits edges
 *  transactionally with the engagement row write (one transaction per
 *  (connection_id, engagement, all-its-associations) tuple)". The
 *  helper also diffs the existing active edges against the incoming
 *  set and tombstones edges that disappeared — covers the re-ingest
 *  path where a contact-association is removed. */
export interface IngestEngagementInput {
  row: EngagementRow;
  /** Active edge set for the engagement at write time. The store
   *  diffs this against the persisted active edges; rows missing
   *  from the new set get `deleted_at` stamped. The new set itself
   *  is upserted (re-association + first-time association both work
   *  through the same path). */
  edges: ReadonlyArray<UpsertEdgeInput>;
  /** Dedupe-candidate rows discovered during this ingest pass. Same
   *  composite-key idempotency as the standalone upsert. */
  dedupe_candidates?: ReadonlyArray<EngagementDedupeCandidateRow>;
  /** Wall-clock used for tombstoning removed edges. Defaults to the
   *  store's `now`. */
  now?: number;
}

export interface IngestEngagementResult {
  row: EngagementRow;
  edges_upserted: number;
  edges_tombstoned: number;
  dedupe_candidates_upserted: number;
  /** True when the upsert was dropped due to the `vendor_modstamp`
   *  stale-update guard; the row + edges + candidates were NOT
   *  written. The returned row is the previously-persisted row. */
  stale_modstamp: boolean;
}

export interface InboundEventLedgerCheckResult {
  duplicate: boolean;
  /** Populated when `duplicate = true` — the previous arrival's
   *  `observed_at`. Pass-5 R5.8: callers (HubSpot retrying webhook
   *  delivery) get "already processed at <observed_at>" + 200 OK; no
   *  outcome cache is stored, no side-effects re-fire. */
  previous_observed_at?: number;
}

export interface EngagementStore {
  // ── Engagement-row CRUD ──────────────────────────────────────
  /** Upsert an engagement row. Pass-4 evidence-quality contracts are
   *  validated. Returns the persisted row (post-write).
   *
   *  `vendor_modstamp` stale-update drop is enforced here: when the
   *  existing row's modstamp is non-NULL AND the incoming modstamp is
   *  lex-`<=` the existing modstamp, the upsert is a no-op + returns
   *  the existing row unchanged. */
  upsert(input: UpsertEngagementInput): EngagementRow;
  get(connection_id: string, target_id: string): EngagementRow | null;
  /** Tombstone — sets `deleted_at` + provenance, does NOT hard-delete.
   *  Returns true when a row was tombstoned, false when the row didn't
   *  exist or was already tombstoned. */
  tombstone(input: {
    connection_id: string;
    target_id: string;
    deleted_at: number;
    actor: string;
    vendor_event_id: string;
  }): boolean;

  // ── Atomic ingest (row + edges + dedupe candidates) ─────────
  /** D-139 § A.4 transactional contract — write the engagement row
   *  + the full edge set + dedupe-candidate rows in one transaction.
   *  Diffs existing active edges against `input.edges` and tombstones
   *  any edge that disappeared (re-ingest with shrunken
   *  contact-association set). Honors the `vendor_modstamp` stale-
   *  update guard atomically: when the row is stale, NO writes land
   *  (row + edges + candidates all skipped). */
  ingestEngagementWithEdges(input: IngestEngagementInput): IngestEngagementResult;

  // ── Engagement-edge CRUD ─────────────────────────────────────
  /** Upsert an edge. When `edge_type === 'contact'`,
   *  `resolveContactRedirect` is REQUIRED — every contact edge passes
   *  through `resolveContactIdentity` per § A.5. Tests that don't
   *  exercise the redirect chain pass the identity callback
   *  `() => null`. Returns the persisted edge. */
  upsertEdge(input: UpsertEdgeInput): EngagementEdge;
  /** Tombstone an edge by composite key. */
  tombstoneEdge(input: {
    connection_id: string;
    engagement_target_id: string;
    edge_type: EngagementEdgeType;
    target_id: string;
    deleted_at: number;
  }): boolean;
  listEdges(filter: {
    connection_id?: string;
    engagement_target_id?: string;
    edge_type?: EngagementEdgeType;
    target_kind?: EngagementEdgeTargetKind;
    target_id?: string;
    include_deleted?: boolean;
  }): ReadonlyArray<EngagementEdge>;
  /** Cascade tombstone every edge for a given connection_id — used
   *  by the connection-delete hook. Returns count of rows
   *  tombstoned. */
  tombstoneEdgesForConnection(connection_id: string, now: number): number;
  /** D-139 P1a.1.2 — cascade tombstone every engagement row for a
   *  given connection_id. Sets `deleted_at` + `deletion_provenance`
   *  on every row whose `connection_id` matches AND that hasn't
   *  already been tombstoned. Returns count of rows tombstoned.
   *  The provenance row carries `actor: 'connection_delete:<connection_id>'`
   *  per § A.10 so downstream cascade can attribute the tombstone
   *  source. Pairs with `tombstoneEdgesForConnection` — both run
   *  together in the connection-delete cascade. */
  tombstoneEngagementRowsForConnection(
    connection_id: string,
    now: number,
  ): number;

  // ── Inbound-event ledger ─────────────────────────────────────
  /** Check + insert in one transaction. When the
   *  `(connection_id, vendor, idempotency_key)` triple already exists,
   *  returns `{ duplicate: true, previous_observed_at }` WITHOUT
   *  inserting; caller short-circuits the side-effects. When the
   *  triple is novel, inserts the ledger row + returns
   *  `{ duplicate: false }`. */
  checkAndInsertInboundEvent(
    row: EngagementInboundEventLedgerRow,
  ): InboundEventLedgerCheckResult;
  /** D-139 P1a.1.1 — read-only existence check on the ledger. Used by
   *  the edge-only write path for `*.associationChange` webhook events
   *  where the substrate needs to apply the edge writes BEFORE
   *  recording the ledger entry (per the carry-forward learning that
   *  the ledger is a "we processed this and the side-effects landed"
   *  marker, not a "we saw this" marker). The flow is:
   *    1. `lookupInboundEvent` — duplicate? short-circuit return.
   *    2. Apply the edge writes via the reconciler-shared helpers.
   *    3. On success, `checkAndInsertInboundEvent` — idempotent on
   *       conflict, so concurrent-delivery races don't corrupt state.
   *  Returns `{ exists: false }` when the triple is novel,
   *  `{ exists: true, observed_at }` when previously processed. */
  lookupInboundEvent(input: {
    connection_id: string;
    vendor: EngagementVendor;
    idempotency_key: string;
  }): { exists: false } | { exists: true; observed_at: number };
  /** Compact ledger entries older than the replay window. Returns
   *  the count of rows deleted. D-123 housekeeping calls this at the
   *  configured cadence. */
  compactInboundEventLedger(now: number): number;

  // ── Dedupe candidates ────────────────────────────────────────
  /** Idempotent insert. Re-inserting the same composite primary key
   *  is a no-op (the candidate is already pending). The candidate-
   *  detection writer is responsible for inserting both directional
   *  rows when symmetry is wanted. */
  upsertDedupeCandidate(row: EngagementDedupeCandidateRow): void;
  listDedupeCandidatesForRow(
    connection_id: string,
    target_id: string,
    cap?: number,
  ): ReadonlyArray<EngagementDedupeCandidateProjection>;

  // ── Contact-rooted resolver (§ A.5.1) ────────────────────────
  /** Resolver for `data.contact.<email>.engagements`. Implements the
   *  full Pass-4 evidence-quality filter surface + identity-expansion
   *  via `resolveContactRedirect` + `expandContactIdentity` callbacks.
   *
   *  Coverage metadata is composed by the resolver here from the
   *  current row-state of the queried sources; producers populating
   *  `coverage` on enrichment outputs build their own coverage
   *  separately (this is the resolver's coverage, not the producer's). */
  resolveEngagementsForContact(
    args: EngagementsResolverArgs,
    deps: {
      resolveContactRedirect: ContactRedirectLookup;
      expandContactIdentity: ContactIdentityExpansion;
      now: () => number;
      coverage: CoverageMetadata;
      /** D-184 Decision 2 — optional live mail-twin join. Omit to skip
       *  exact-twin resolution (rows keep their as-ingested body_state). */
      resolveMailTwins?: MailTwinResolver;
    },
  ): EngagementsResolverResult;

  // ── Rescan eligibility enumerator (§ A.6.3) ──────────────────
  /** D-139 P1a.2 — enumerate engagement target_ids eligible for the
   *  per-cycle association-rescan sweep. Filters by:
   *    - `connection_id` + `vendor` + `entity` exact match
   *    - `vendor_modified_at >= cutoff` (window-based eligibility)
   *    - `lifecycle_state IN eligible_states`
   *    - `deleted_at IS NULL` (skip tombstoned rows)
   *  Returns ascending-target_id order for stable iteration; the
   *  rescan substrate caps the page count per invocation per
   *  `RECONCILER_PAGE_CAP_PER_INVOCATION`. */
  listRescanEligible(input: {
    connection_id: string;
    vendor: EngagementVendor;
    entity: string;
    cutoff: number;
    eligible_states: ReadonlyArray<EngagementLifecycleState>;
  }): ReadonlyArray<string>;

  // ── Deal counterparty resolution (D-192 F1) ──────────────────
  /** D-192 F1 — the `record_contact_edges` counterparty seam. Given a
   *  deal's platform-reference `full_target_id` (the same
   *  `<vendor>_<entity>_<conn>_<id>` shape a deal cascade event's
   *  `record_id` carries — deal reconciler `record_id` and the
   *  engagement `edge_type='deal'` target_id are both
   *  `composePlatformRecordTargetId(...)`), return the DISTINCT
   *  canonical-email contact edges (`target_kind='data.contact'`)
   *  reachable through the deal's engagements: the contacts who
   *  co-appear on any engagement the deal is associated with.
   *
   *  Only the D-138-resolvable EMAIL surface is returned —
   *  `edge_type='contact'` edges keyed on `target_kind='connection.api'`
   *  (Salesforce platform-id contacts awaiting the deferred
   *  platform-id → email lookup, per the `upsertEdge` note) are excluded
   *  so no un-resolvable vendor id leaks into a `counterparty_contact_id`
   *  (which downstream producers query as a `data.contact` email).
   *
   *  `limit` caps the RESULT set (the caller passes `cap + 1` so it can
   *  detect truncation and fail closed). The join's row work is bounded
   *  by this one deal's engagement footprint — a next_step capture is
   *  not a hot path, so the scan is left un-subqueried. Emails are
   *  raw-stored (already D-138-canonical at edge-write time); the caller
   *  forward-resolves each through the `merged_into` chain + dedups to
   *  absorb any merge that landed after the edge was written. */
  listDealCounterpartyContactEmails(
    deal_full_target_id: string,
    limit: number,
  ): string[];
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

export interface CreateEngagementStoreOptions {
  now?: () => number;
  /** D-139 P3 § A.10 — fired AFTER a row + edge ingest commits.
   *  Production wires this to
   *  `cascadeForEngagementEvent(engagement_scope, target_id,
   *  connection_id, { extra_edge_targets })` so aggregate
   *  enrichments depending on the engagement's per-type source scope
   *  invalidate per-deal / per-contact / per-account rows.
   *
   *  Codex P1 #1 + P1 #2 fold:
   *    - `kind: 'edge_change'` fires for `upsertEdge` / `tombstoneEdge`
   *      paths (associationChange-only updates per § A.10) where the
   *      engagement row meta is unchanged but the edge set drifted.
   *    - `removed_edge_targets` carries just-tombstoned edges' targets
   *      so the cascade can invalidate aggregate rows scoped to the
   *      DROPPED deal/contact/account in addition to the live edges
   *      (the cascade lookup uses `include_deleted: false` so it
   *      misses removed targets without this passthrough).
   *
   *  Stale-modstamp drops + already-tombstoned writes do NOT fire
   *  the callback (no semantic change to the engagement set).
   *  Callback exceptions are swallowed — cascade failures must
   *  never abort the engagement write. Optional — tests + offline
   *  tooling skip the callback. */
  onEngagementChange?: (event: {
    connection_id: string;
    target_id: string;
    // D-192 — open vendor id (was `'hubspot' | 'salesforce'`); the event carries
    // the writing reconciler's vendor as opaque provenance.
    vendor: string;
    entity: string;
    /** Discriminates the source path so the callback can attribute
     *  cascade fan-out accordingly:
     *    - `'updated'`     row-update path (full ingest)
     *    - `'deleted'`     row-tombstone path
     *    - `'edge_change'` edge-only write path (associationChange) */
    kind: 'updated' | 'deleted' | 'edge_change';
    /** Targets of edges tombstoned in the same write transaction.
     *  The cascade folds these into its edge-walk fan-out so the
     *  removed deal/account/contact's aggregate rows invalidate
     *  alongside the surviving edges. Empty array (or undefined)
     *  when no edges were tombstoned. */
    removed_edge_targets?: ReadonlyArray<{
      edge_type: EngagementEdgeType;
      target_kind: EngagementEdgeTargetKind;
      target_id: string;
    }>;
  }) => void;
}

export const createEngagementStore = (
  db: Database.Database,
  opts: CreateEngagementStoreOptions = {},
): EngagementStore => {
  ensureEngagementSchema(db);
  const nowFn = opts.now ?? ((): number => Date.now());
  const onEngagementChange = opts.onEngagementChange;
  const fireEngagementChange = (event: {
    connection_id: string;
    target_id: string;
    vendor: string;
    entity: string;
    kind: 'updated' | 'deleted' | 'edge_change';
    removed_edge_targets?: ReadonlyArray<{
      edge_type: EngagementEdgeType;
      target_kind: EngagementEdgeTargetKind;
      target_id: string;
    }>;
  }): void => {
    if (!onEngagementChange) return;
    try {
      onEngagementChange(event);
    } catch {
      // Best-effort. Engagement writes must not abort because of a
      // downstream cascade fault.
    }
  };

  const upsertStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENTS_TABLE}
      (connection_id, target_id, vendor, entity, meta, mirror_blob_hash,
       authorship, direction, dedupe_confidence, lifecycle_state,
       attachments, event_at, event_at_tz_hint, event_at_tz_inferred,
       vendor_raw_timestamp,
       due_at, due_at_is_date_only, completed_at, scheduled_start_at,
       vendor_created_at, vendor_modified_at, vendor_modstamp,
       ingested_at, body_state, body_inline, body_truncation_offset,
       deleted_at, deletion_provenance)
     VALUES
      (@connection_id, @target_id, @vendor, @entity, @meta, @mirror_blob_hash,
       @authorship, @direction, @dedupe_confidence, @lifecycle_state,
       @attachments, @event_at, @event_at_tz_hint, @event_at_tz_inferred,
       @vendor_raw_timestamp,
       @due_at, @due_at_is_date_only, @completed_at, @scheduled_start_at,
       @vendor_created_at, @vendor_modified_at, @vendor_modstamp,
       @ingested_at, @body_state, @body_inline, @body_truncation_offset,
       @deleted_at, @deletion_provenance)
     ON CONFLICT(connection_id, target_id) DO UPDATE SET
       vendor                  = excluded.vendor,
       entity                  = excluded.entity,
       meta                    = excluded.meta,
       mirror_blob_hash        = excluded.mirror_blob_hash,
       authorship              = excluded.authorship,
       direction               = excluded.direction,
       dedupe_confidence       = excluded.dedupe_confidence,
       lifecycle_state         = excluded.lifecycle_state,
       attachments             = excluded.attachments,
       event_at                = excluded.event_at,
       event_at_tz_hint        = excluded.event_at_tz_hint,
       event_at_tz_inferred    = excluded.event_at_tz_inferred,
       vendor_raw_timestamp    = excluded.vendor_raw_timestamp,
       due_at                  = excluded.due_at,
       due_at_is_date_only     = excluded.due_at_is_date_only,
       completed_at            = excluded.completed_at,
       scheduled_start_at      = excluded.scheduled_start_at,
       vendor_created_at       = excluded.vendor_created_at,
       vendor_modified_at      = excluded.vendor_modified_at,
       vendor_modstamp         = excluded.vendor_modstamp,
       ingested_at             = excluded.ingested_at,
       body_state              = excluded.body_state,
       body_inline             = excluded.body_inline,
       body_truncation_offset  = excluded.body_truncation_offset,
       deleted_at              = excluded.deleted_at,
       deletion_provenance     = excluded.deletion_provenance
     WHERE
       -- Pass-4 R4.7 vendor_modstamp stale-update drop, atomically:
       -- skip the update when stored modstamp is non-NULL AND the
       -- incoming modstamp is lex-<= the stored value. NULL modstamps
       -- never block (forward-progress on first write before vendor
       -- supplies a modstamp).
       ${ENGAGEMENTS_TABLE}.vendor_modstamp IS NULL
       OR excluded.vendor_modstamp IS NULL
       OR excluded.vendor_modstamp > ${ENGAGEMENTS_TABLE}.vendor_modstamp`,
  );
  const getStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENTS_TABLE}
       WHERE connection_id = ? AND target_id = ?`,
  );
  const tombstoneStmt = db.prepare(
    `UPDATE ${ENGAGEMENTS_TABLE}
        SET deleted_at = ?, deletion_provenance = ?
      WHERE connection_id = ?
        AND target_id = ?
        AND deleted_at IS NULL`,
  );

  const upsertEdgeStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_EDGES_TABLE}
       (connection_id, engagement_target_id, edge_type, target_kind,
        target_id, vendor, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, engagement_target_id, edge_type, target_id)
       DO UPDATE SET
         target_kind = excluded.target_kind,
         vendor      = excluded.vendor,
         deleted_at  = NULL`,
  );
  const tombstoneEdgeStmt = db.prepare(
    `UPDATE ${ENGAGEMENT_EDGES_TABLE}
        SET deleted_at = ?
      WHERE connection_id = ?
        AND engagement_target_id = ?
        AND edge_type = ?
        AND target_id = ?
        AND deleted_at IS NULL`,
  );
  const tombstoneEdgesForConnectionStmt = db.prepare(
    `UPDATE ${ENGAGEMENT_EDGES_TABLE}
        SET deleted_at = ?
      WHERE connection_id = ?
        AND deleted_at IS NULL`,
  );
  // D-192 F1 — deal → (its engagements) → contact-email edges. The
  // self-join keys the second hop on (connection_id, engagement_target_id)
  // — served by idx_engagement_edges_by_engagement — after the first hop
  // narrows on (target_kind, target_id, edge_type) via
  // idx_engagement_edges_by_target. DISTINCT collapses a contact edged to
  // the deal through many engagements to one row.
  const dealCounterpartyContactsStmt = db.prepare(
    `SELECT DISTINCT c.target_id AS email
       FROM ${ENGAGEMENT_EDGES_TABLE} d
       JOIN ${ENGAGEMENT_EDGES_TABLE} c
         ON c.connection_id = d.connection_id
        AND c.engagement_target_id = d.engagement_target_id
        AND c.edge_type = 'contact'
        AND c.target_kind = 'data.contact'
        AND c.deleted_at IS NULL
      WHERE d.edge_type = 'deal'
        AND d.target_kind = 'connection.api'
        AND d.target_id = ?
        AND d.deleted_at IS NULL
      ORDER BY c.target_id ASC
      LIMIT ?`,
  );
  const tombstoneRowsForConnectionStmt = db.prepare(
    `UPDATE ${ENGAGEMENTS_TABLE}
        SET deleted_at = ?, deletion_provenance = ?
      WHERE connection_id = ?
        AND deleted_at IS NULL`,
  );

  const insertLedgerStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE}
       (connection_id, vendor, idempotency_key, vendor_modstamp,
        delivery_path, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, vendor, idempotency_key) DO NOTHING`,
  );
  const lookupLedgerStmt = db.prepare(
    `SELECT observed_at FROM ${ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE}
       WHERE connection_id = ? AND vendor = ? AND idempotency_key = ?`,
  );
  const compactLedgerStmt = db.prepare(
    `DELETE FROM ${ENGAGEMENT_INBOUND_EVENT_LEDGER_TABLE}
       WHERE observed_at < ?`,
  );

  const upsertCandidateStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_DEDUPE_CANDIDATES_TABLE}
       (source_connection_id, source_target_id,
        candidate_connection_id, candidate_target_id,
        match_key, confidence, resolution_state,
        detected_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_connection_id, source_target_id,
                 candidate_connection_id, candidate_target_id, match_key)
       DO NOTHING`,
  );
  const listCandidatesForRowStmt = db.prepare(
    `SELECT candidate_connection_id, candidate_target_id, match_key, confidence
       FROM ${ENGAGEMENT_DEDUPE_CANDIDATES_TABLE}
       WHERE source_connection_id = ?
         AND source_target_id = ?
         AND resolution_state = 'pending'
       ORDER BY detected_at ASC
       LIMIT ?`,
  );

  // ── public API ───────────────────────────────────────────────

  /** Internal: run the SQL upsert + read back the persisted row.
   *  vendor_modstamp guard lives in the SQL (Codex review fold #4 —
   *  atomic via `ON CONFLICT DO UPDATE ... WHERE`). The boolean result
   *  signals whether the SQL update fired or was suppressed by the
   *  modstamp guard. */
  const runUpsert = (
    row: EngagementRow,
  ): { row: EngagementRow; stale: boolean } => {
    validateRow(row);
    const result = upsertStmt.run(toDbRow(row));
    const persisted = getStmt.get(row.connection_id, row.target_id) as
      | EngagementDbRow
      | undefined;
    if (persisted === undefined) {
      throw new EngagementInvalidError(
        `engagement row vanished after upsert: ${row.connection_id}/${row.target_id}`,
      );
    }
    // `result.changes` is 1 when the row was inserted OR the conflict
    // path's WHERE allowed the update; 0 when the WHERE blocked the
    // update (modstamp guard). Distinguishing insert-vs-update vs
    // suppressed-update isn't possible from changes alone — the
    // `stale` flag is true only when an existing row's stored
    // modstamp is non-NULL AND the incoming modstamp is lex-≤ stored
    // (the WHERE-blocked case).
    let stale = false;
    if (
      result.changes === 0 &&
      persisted.vendor_modstamp !== null &&
      row.vendor_modstamp !== undefined &&
      row.vendor_modstamp.length > 0 &&
      row.vendor_modstamp <= persisted.vendor_modstamp
    ) {
      stale = true;
    }
    return { row: fromDbRow(persisted), stale };
  };

  const upsert = (input: UpsertEngagementInput): EngagementRow => {
    const result = runUpsert(input.row);
    if (!result.stale) {
      fireEngagementChange({
        connection_id: result.row.connection_id,
        target_id: result.row.target_id,
        vendor: result.row.vendor,
        entity: result.row.entity,
        kind: 'updated',
      });
    }
    return result.row;
  };

  const get = (
    connection_id: string,
    target_id: string,
  ): EngagementRow | null => {
    const raw = getStmt.get(connection_id, target_id) as
      | EngagementDbRow
      | undefined;
    if (raw === undefined) return null;
    return fromDbRow(raw);
  };

  const tombstone: EngagementStore['tombstone'] = (input) => {
    const provenance = JSON.stringify({
      actor: input.actor,
      vendor_event_id: input.vendor_event_id,
    });
    // Pre-fetch the row's vendor + entity for the cascade callback —
    // SQLite doesn't return the columns from an UPDATE, so we look
    // them up before the tombstone fires. Skipped when the row is
    // already absent / tombstoned (changes === 0 path).
    const existing = get(input.connection_id, input.target_id);
    const result = tombstoneStmt.run(
      input.deleted_at,
      provenance,
      input.connection_id,
      input.target_id,
    );
    if (result.changes > 0 && existing !== null) {
      fireEngagementChange({
        connection_id: existing.connection_id,
        target_id: existing.target_id,
        vendor: existing.vendor,
        entity: existing.entity,
        kind: 'deleted',
      });
    }
    return result.changes > 0;
  };

  const upsertEdge: EngagementStore['upsertEdge'] = (input) => {
    if (!isEngagementEdgeType(input.edge_type)) {
      throw new EngagementInvalidError(
        `invalid edge_type '${input.edge_type}'`,
      );
    }
    if (!isEngagementEdgeTargetKind(input.target_kind)) {
      throw new EngagementInvalidError(
        `invalid target_kind '${input.target_kind}'`,
      );
    }
    // Codex review fold #11 — D-138 redirect lookup is REQUIRED for
    // contact edges keyed on canonical email (target_kind ===
    // 'data.contact'). Tests that don't exercise the redirect chain
    // pass the identity callback `() => null`.
    //
    // D-139 P1b widening — Salesforce Contact / Lead Ids (003 / 00Q
    // prefixes) ride `edge_type: 'contact'` with `target_kind:
    // 'connection.api'`; the target_id is a Salesforce-Id-shaped
    // platform reference (e.g. `salesforce_who_003abc`), not an
    // email. D-138 identity resolution gates only on the canonical-
    // email surface (`target_kind === 'data.contact'`); platform-
    // reference contact edges store their Salesforce id verbatim.
    // Future identity resolution for Salesforce-Id-keyed contacts
    // routes through a separate platform-id → email lookup at
    // resolver time, not at edge-write time.
    const isCanonicalEmailContact =
      input.edge_type === 'contact' && input.target_kind === 'data.contact';
    if (isCanonicalEmailContact && input.resolveContactRedirect === undefined) {
      throw new EngagementInvalidError(
        "edge_type 'contact' with target_kind 'data.contact' requires resolveContactRedirect (§ A.5 — D-138 identity resolution at link emission)",
      );
    }
    let resolvedTargetId = input.target_id;
    if (isCanonicalEmailContact && input.resolveContactRedirect !== undefined) {
      const { canonical_email } = resolveContactIdentity(
        input.target_id,
        input.resolveContactRedirect,
      );
      resolvedTargetId = canonical_email;
    }
    upsertEdgeStmt.run(
      input.connection_id,
      input.engagement_target_id,
      input.edge_type,
      input.target_kind,
      resolvedTargetId,
      input.vendor ?? null,
      input.created_at,
      input.deleted_at ?? null,
    );
    const edge: EngagementEdge = {
      connection_id: input.connection_id,
      engagement_target_id: input.engagement_target_id,
      edge_type: input.edge_type,
      target_kind: input.target_kind,
      target_id: resolvedTargetId,
      created_at: input.created_at,
    };
    if (input.vendor !== undefined) edge.vendor = input.vendor;
    if (input.deleted_at !== undefined) edge.deleted_at = input.deleted_at;
    // Codex P1 #1 fold — fire engagement-change callback for
    // associationChange-only writes (engagement-row meta unchanged
    // but edge set drifted). § A.10 requires associationChange
    // events to cascade because edge changes alter
    // deal/contact/account aggregate inputs.
    const engagement = get(input.connection_id, input.engagement_target_id);
    if (engagement !== null) {
      fireEngagementChange({
        connection_id: engagement.connection_id,
        target_id: engagement.target_id,
        vendor: engagement.vendor,
        entity: engagement.entity,
        kind: 'edge_change',
      });
    }
    return edge;
  };

  // ── Atomic ingest API (Codex review fold #2 + #3) ────────────
  const ingestEngagementWithEdges: EngagementStore['ingestEngagementWithEdges'] = (
    input,
  ) => {
    const writeTime = input.now ?? nowFn();
    // SQLite transactions in better-sqlite3 are synchronous;
    // db.transaction wraps a function in BEGIN…COMMIT so we get an
    // all-or-nothing write of row + new/changed edges + tombstones +
    // dedupe candidates per § A.4.
    const tx = db.transaction(() => {
      // 1. Upsert engagement row (modstamp guard atomic in SQL).
      const upsertResult = runUpsert(input.row);
      if (upsertResult.stale) {
        // Stale modstamp → drop everything per § A.3.8 contract; return
        // the previously-persisted row unchanged.
        return {
          row: upsertResult.row,
          edges_upserted: 0,
          edges_tombstoned: 0,
          dedupe_candidates_upserted: 0,
          stale_modstamp: true,
        } as IngestEngagementResult;
      }

      // 2. Validate every incoming edge BEFORE any writes — fail-fast
      //    on a bad edge means nothing partial lands.
      for (const edge of input.edges) {
        if (!isEngagementEdgeType(edge.edge_type)) {
          throw new EngagementInvalidError(
            `invalid edge_type '${edge.edge_type}'`,
          );
        }
        if (!isEngagementEdgeTargetKind(edge.target_kind)) {
          throw new EngagementInvalidError(
            `invalid target_kind '${edge.target_kind}'`,
          );
        }
        // D-139 P1b — only canonical-email contact edges (target_kind
        // 'data.contact') require the D-138 redirect lookup. Salesforce
        // Contact / Lead Ids ride `target_kind: 'connection.api'` and
        // store the platform-id verbatim. See `upsertEdge` for the
        // mirror gate.
        const isCanonicalEmailContact =
          edge.edge_type === 'contact' &&
          edge.target_kind === 'data.contact';
        if (
          isCanonicalEmailContact &&
          edge.resolveContactRedirect === undefined
        ) {
          throw new EngagementInvalidError(
            "edge_type 'contact' with target_kind 'data.contact' requires resolveContactRedirect (§ A.5)",
          );
        }
      }

      // 3. Pre-resolve canonical-email contact target ids through
      //    D-138 redirect so the diff-against-existing-edges logic
      //    below uses the survivor canonical (matching what's
      //    persisted). Platform-reference contact edges
      //    (target_kind 'connection.api') store the Salesforce id
      //    verbatim.
      const resolvedEdges = input.edges.map((edge) => {
        let target_id = edge.target_id;
        const isCanonicalEmailContact =
          edge.edge_type === 'contact' &&
          edge.target_kind === 'data.contact';
        if (
          isCanonicalEmailContact &&
          edge.resolveContactRedirect !== undefined
        ) {
          const { canonical_email } = resolveContactIdentity(
            edge.target_id,
            edge.resolveContactRedirect,
          );
          target_id = canonical_email;
        }
        return { edge, target_id };
      });

      // 4. Diff existing active edges against the new set; tombstone
      //    edges that disappeared (Codex review fold #2 — re-ingest
      //    with shrunken contact-association set drops the missing).
      const existing = listEdges({
        connection_id: input.row.connection_id,
        engagement_target_id: input.row.target_id,
      });
      const incomingKeys = new Set(
        resolvedEdges.map(
          ({ edge, target_id }) =>
            `${edge.edge_type}|${target_id}`,
        ),
      );
      let edges_tombstoned = 0;
      // Codex P1 #2 fold — collect targets of edges JUST tombstoned
      // in this commit so the cascade callback can invalidate
      // aggregates scoped to the dropped deal/account/contact (the
      // cascade lookup uses `include_deleted: false` so it misses
      // removed targets without this passthrough).
      const removed_edge_targets: Array<{
        edge_type: EngagementEdgeType;
        target_kind: EngagementEdgeTargetKind;
        target_id: string;
      }> = [];
      for (const e of existing) {
        const key = `${e.edge_type}|${e.target_id}`;
        if (!incomingKeys.has(key)) {
          const result = tombstoneEdgeStmt.run(
            writeTime,
            e.connection_id,
            e.engagement_target_id,
            e.edge_type,
            e.target_id,
          );
          if (result.changes > 0) {
            edges_tombstoned += 1;
            removed_edge_targets.push({
              edge_type: e.edge_type,
              target_kind: e.target_kind,
              target_id: e.target_id,
            });
          }
        }
      }

      // 5. Upsert every new edge (resurrects tombstones at the
      //    SQL ON CONFLICT path — `deleted_at = NULL`).
      let edges_upserted = 0;
      for (const { edge, target_id } of resolvedEdges) {
        upsertEdgeStmt.run(
          edge.connection_id,
          edge.engagement_target_id,
          edge.edge_type,
          edge.target_kind,
          target_id,
          edge.vendor ?? null,
          edge.created_at,
          edge.deleted_at ?? null,
        );
        edges_upserted += 1;
      }

      // 6. Dedupe-candidate writes.
      let dedupe_candidates_upserted = 0;
      for (const cand of input.dedupe_candidates ?? []) {
        if (!isDedupeConfidence(cand.confidence)) {
          throw new EngagementInvalidError(
            `invalid confidence '${cand.confidence}'`,
          );
        }
        if (
          !DEDUPE_RESOLUTION_STATE_VALUES.includes(
            cand.resolution_state as DedupeResolutionState,
          )
        ) {
          throw new EngagementInvalidError(
            `invalid resolution_state '${cand.resolution_state}'`,
          );
        }
        if (cand.match_key.length === 0) {
          throw new EngagementInvalidError('match_key must be non-empty');
        }
        upsertCandidateStmt.run(
          cand.source_connection_id,
          cand.source_target_id,
          cand.candidate_connection_id,
          cand.candidate_target_id,
          cand.match_key,
          cand.confidence,
          cand.resolution_state,
          cand.detected_at,
          cand.resolved_at ?? null,
          cand.resolved_by ?? null,
        );
        dedupe_candidates_upserted += 1;
      }

      return {
        row: upsertResult.row,
        edges_upserted,
        edges_tombstoned,
        dedupe_candidates_upserted,
        stale_modstamp: false,
        // Internal carrier — stripped from the public result before
        // return; surfaces just-tombstoned edge targets to the
        // cascade callback per Codex P1 #2 fold.
        _removed_edge_targets: removed_edge_targets,
      } as IngestEngagementResult & {
        _removed_edge_targets: ReadonlyArray<{
          edge_type: EngagementEdgeType;
          target_kind: EngagementEdgeTargetKind;
          target_id: string;
        }>;
      };
    });
    const txResult = tx() as IngestEngagementResult & {
      _removed_edge_targets?: ReadonlyArray<{
        edge_type: EngagementEdgeType;
        target_kind: EngagementEdgeTargetKind;
        target_id: string;
      }>;
    };
    const removedTargets = txResult._removed_edge_targets ?? [];
    // Strip the internal carrier from the public result.
    const out: IngestEngagementResult = {
      row: txResult.row,
      edges_upserted: txResult.edges_upserted,
      edges_tombstoned: txResult.edges_tombstoned,
      dedupe_candidates_upserted: txResult.dedupe_candidates_upserted,
      stale_modstamp: txResult.stale_modstamp,
    };
    // Fire the engagement-change callback AFTER the transaction
    // commits — D-139 P3 § A.10 cascade for engagement-event
    // delivery. Stale-modstamp drops do NOT fire (no semantic
    // change). Edge-only changes (no row-meta change but
    // edges_upserted / edges_tombstoned > 0) DO fire because
    // associationChange is a cascade-relevant event per § A.10.
    // Codex P1 #2 fold — passes removed_edge_targets so cascade
    // invalidates aggregates scoped to dropped deal/account/contact
    // targets alongside surviving edges.
    if (!out.stale_modstamp) {
      fireEngagementChange({
        connection_id: out.row.connection_id,
        target_id: out.row.target_id,
        vendor: out.row.vendor,
        entity: out.row.entity,
        kind: 'updated',
        removed_edge_targets: removedTargets,
      });
    }
    return out;
  };

  const tombstoneEdge: EngagementStore['tombstoneEdge'] = (input) => {
    // Codex P1 #1 + P1 #2 fold — capture target_kind BEFORE the
    // tombstone so the cascade callback can pass the removed target
    // through to the cascade engine (it needs target_kind to
    // discriminate `connection.api` vs `data.contact` etc.).
    const existingEdges = listEdges({
      connection_id: input.connection_id,
      engagement_target_id: input.engagement_target_id,
      edge_type: input.edge_type,
      target_id: input.target_id,
      include_deleted: false,
    });
    const existingEdge = existingEdges[0] ?? null;
    const result = tombstoneEdgeStmt.run(
      input.deleted_at,
      input.connection_id,
      input.engagement_target_id,
      input.edge_type,
      input.target_id,
    );
    if (result.changes > 0) {
      // Fire cascade with the just-tombstoned edge as a removed
      // target so aggregates scoped to the dropped deal/contact
      // invalidate per § A.10.
      const engagement = get(input.connection_id, input.engagement_target_id);
      if (engagement !== null) {
        fireEngagementChange({
          connection_id: engagement.connection_id,
          target_id: engagement.target_id,
          vendor: engagement.vendor,
          entity: engagement.entity,
          kind: 'edge_change',
          removed_edge_targets:
            existingEdge !== null
              ? [
                  {
                    edge_type: existingEdge.edge_type,
                    target_kind: existingEdge.target_kind,
                    target_id: existingEdge.target_id,
                  },
                ]
              : [],
        });
      }
    }
    return result.changes > 0;
  };

  const listEdges: EngagementStore['listEdges'] = (filter) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.connection_id !== undefined) {
      conditions.push('connection_id = ?');
      params.push(filter.connection_id);
    }
    if (filter.engagement_target_id !== undefined) {
      conditions.push('engagement_target_id = ?');
      params.push(filter.engagement_target_id);
    }
    if (filter.edge_type !== undefined) {
      conditions.push('edge_type = ?');
      params.push(filter.edge_type);
    }
    if (filter.target_kind !== undefined) {
      conditions.push('target_kind = ?');
      params.push(filter.target_kind);
    }
    if (filter.target_id !== undefined) {
      conditions.push('target_id = ?');
      params.push(filter.target_id);
    }
    if (filter.include_deleted !== true) {
      conditions.push('deleted_at IS NULL');
    }
    const sql = `SELECT * FROM ${ENGAGEMENT_EDGES_TABLE}${
      conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
    } ORDER BY created_at ASC`;
    const rows = db.prepare(sql).all(...params) as Array<{
      connection_id: string;
      engagement_target_id: string;
      edge_type: string;
      target_kind: string;
      target_id: string;
      vendor: string | null;
      created_at: number;
      deleted_at: number | null;
    }>;
    return rows.map((r) => {
      const out: EngagementEdge = {
        connection_id: r.connection_id,
        engagement_target_id: r.engagement_target_id,
        edge_type: r.edge_type as EngagementEdgeType,
        target_kind: r.target_kind as EngagementEdgeTargetKind,
        target_id: r.target_id,
        created_at: r.created_at,
      };
      if (r.vendor !== null) out.vendor = r.vendor as EngagementVendor;
      if (r.deleted_at !== null) out.deleted_at = r.deleted_at;
      return out;
    });
  };

  const tombstoneEdgesForConnection: EngagementStore['tombstoneEdgesForConnection'] = (
    connection_id,
    now,
  ) => {
    const result = tombstoneEdgesForConnectionStmt.run(now, connection_id);
    return result.changes;
  };

  const tombstoneEngagementRowsForConnection: EngagementStore['tombstoneEngagementRowsForConnection'] = (
    connection_id,
    now,
  ) => {
    const provenance = JSON.stringify({
      actor: `connection_delete:${connection_id}`,
      vendor_event_id: '',
    });
    const result = tombstoneRowsForConnectionStmt.run(
      now,
      provenance,
      connection_id,
    );
    return result.changes;
  };

  const checkAndInsertInboundEvent: EngagementStore['checkAndInsertInboundEvent'] = (
    row,
  ) => {
    if (!isEngagementInboundDeliveryPath(row.delivery_path)) {
      throw new EngagementInvalidError(
        `invalid delivery_path '${row.delivery_path}'`,
      );
    }
    if (row.idempotency_key.length === 0) {
      throw new EngagementInvalidError('idempotency_key must be non-empty');
    }
    // Codex review fold #8 — atomic INSERT … ON CONFLICT DO NOTHING
    // (no read-then-write race). When the conflict path fires
    // (`changes === 0`), look up the existing row's observed_at to
    // honor the Pass-5 R5.8 contract: duplicate returns the previous
    // arrival's observed_at without re-firing side-effects.
    const result = insertLedgerStmt.run(
      row.connection_id,
      row.vendor,
      row.idempotency_key,
      row.vendor_modstamp ?? null,
      row.delivery_path,
      row.observed_at,
    );
    if (result.changes > 0) {
      return { duplicate: false as const };
    }
    const existing = lookupLedgerStmt.get(
      row.connection_id,
      row.vendor,
      row.idempotency_key,
    ) as { observed_at: number } | undefined;
    return {
      duplicate: true as const,
      previous_observed_at: existing?.observed_at ?? row.observed_at,
    };
  };

  const lookupInboundEvent: EngagementStore['lookupInboundEvent'] = (input) => {
    if (input.idempotency_key.length === 0) {
      throw new EngagementInvalidError('idempotency_key must be non-empty');
    }
    const existing = lookupLedgerStmt.get(
      input.connection_id,
      input.vendor,
      input.idempotency_key,
    ) as { observed_at: number } | undefined;
    if (existing === undefined) return { exists: false };
    return { exists: true, observed_at: existing.observed_at };
  };

  const compactInboundEventLedger: EngagementStore['compactInboundEventLedger'] = (
    now,
  ) => {
    const cutoff = now - ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS;
    const result = compactLedgerStmt.run(cutoff);
    return result.changes;
  };

  const upsertDedupeCandidate: EngagementStore['upsertDedupeCandidate'] = (
    row,
  ) => {
    if (!isDedupeConfidence(row.confidence)) {
      throw new EngagementInvalidError(
        `invalid confidence '${row.confidence}'`,
      );
    }
    if (
      !DEDUPE_RESOLUTION_STATE_VALUES.includes(
        row.resolution_state as DedupeResolutionState,
      )
    ) {
      throw new EngagementInvalidError(
        `invalid resolution_state '${row.resolution_state}'`,
      );
    }
    if (row.match_key.length === 0) {
      throw new EngagementInvalidError('match_key must be non-empty');
    }
    upsertCandidateStmt.run(
      row.source_connection_id,
      row.source_target_id,
      row.candidate_connection_id,
      row.candidate_target_id,
      row.match_key,
      row.confidence,
      row.resolution_state,
      row.detected_at,
      row.resolved_at ?? null,
      row.resolved_by ?? null,
    );
  };

  const listDedupeCandidatesForRow: EngagementStore['listDedupeCandidatesForRow'] = (
    connection_id,
    target_id,
    cap = ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP,
  ) => {
    const rows = listCandidatesForRowStmt.all(
      connection_id,
      target_id,
      cap,
    ) as Array<{
      candidate_connection_id: string;
      candidate_target_id: string;
      match_key: string;
      confidence: string;
    }>;
    return rows.map((r) => ({
      candidate_connection_id: r.candidate_connection_id,
      candidate_target_id: r.candidate_target_id,
      match_key: r.match_key,
      confidence: r.confidence as DedupeConfidence,
    }));
  };

  // ── Resolver implementation (§ A.5.1) ────────────────────────

  const resolveEngagementsForContact: EngagementStore['resolveEngagementsForContact'] = (
    args,
    deps,
  ) => {
    // 1. Identity-routing: walk the survivor chain.
    const { canonical_email: survivor } = resolveContactIdentity(
      args.email,
      deps.resolveContactRedirect,
    );

    // 2. Identity-expansion: build the full member set per § A.5.0.
    const members = new Set<string>(deps.expandContactIdentity(survivor));
    members.add(survivor);
    if (members.size === 0) {
      // Degenerate case — survivor lookup found nothing. Return empty
      // page; coverage is honest.
      return {
        engagements: [],
        coverage: deps.coverage,
      };
    }

    // 3. Build the WHERE clause.
    const since = args.since ?? deps.now() - ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS;
    const until = args.until ?? deps.now();
    const pageSize = Math.min(
      Math.max(1, args.page_size ?? ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE),
      ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE,
    );
    const lifecycleStates: ReadonlyArray<EngagementLifecycleState> =
      args.lifecycle_state ?? (['point_in_time', 'completed'] as const);
    const dedupeAcceptance: DedupeAcceptance =
      args.dedupe_acceptance ?? 'exact_only';

    const memberPlaceholders = Array.from(members)
      .map(() => '?')
      .join(', ');
    const lifecyclePlaceholders = lifecycleStates.map(() => '?').join(', ');

    // Codex review fold #10 — apply the `event_at IS NOT NULL` gate
    // ONLY when the resolver is in default-evidence mode. When the
    // caller passes an explicit lifecycle whitelist that includes a
    // non-evidence state (`'pending'` / `'scheduled'` / etc.), the
    // gate would unconditionally exclude the rows the caller asked
    // for — drop the event_at gate + apply the time-window filter to
    // vendor_created_at instead so upcoming-meeting briefs ("set to
    // ['scheduled']" per § A.5.1) work.
    const explicitLifecycle = args.lifecycle_state !== undefined;
    const includesNonEvidence = lifecycleStates.some(
      (s) => s !== 'point_in_time' && s !== 'completed',
    );
    const restrictedToEvidence = !(explicitLifecycle && includesNonEvidence);

    const conditions: string[] = [];
    if (restrictedToEvidence) {
      conditions.push('event_at IS NOT NULL');
      conditions.push('event_at >= ?');
      conditions.push('event_at <= ?');
    } else {
      conditions.push('vendor_created_at >= ?');
      conditions.push('vendor_created_at <= ?');
    }
    conditions.push(`lifecycle_state IN (${lifecyclePlaceholders})`);
    conditions.push(
      'EXISTS (SELECT 1 FROM ' +
        ENGAGEMENT_EDGES_TABLE +
        ' e WHERE e.connection_id = ' +
        ENGAGEMENTS_TABLE +
        '.connection_id AND e.engagement_target_id = ' +
        ENGAGEMENTS_TABLE +
        '.target_id AND e.edge_type = \'contact\' AND e.deleted_at IS NULL AND e.target_id IN (' +
        memberPlaceholders +
        '))',
    );
    const params: unknown[] = [since, until, ...lifecycleStates, ...members];

    if (args.include_deleted !== true) {
      conditions.push('deleted_at IS NULL');
    }
    if (args.vendor !== undefined) {
      conditions.push('vendor = ?');
      params.push(args.vendor);
    }
    if (args.connection_id !== undefined) {
      conditions.push('connection_id = ?');
      params.push(args.connection_id);
    }
    if (args.authorship !== undefined && args.authorship.length > 0) {
      conditions.push(
        `authorship IN (${args.authorship.map(() => '?').join(', ')})`,
      );
      for (const a of args.authorship) params.push(a);
    }
    if (args.direction !== undefined && args.direction.length > 0) {
      conditions.push(
        `direction IN (${args.direction.map(() => '?').join(', ')})`,
      );
      for (const d of args.direction) params.push(d);
    }

    // Codex review fold #10 — when explicit lifecycle whitelist
    // includes non-evidence states, sort by vendor_created_at DESC
    // (NULL event_at rows sort by their creation time). Default
    // evidence path still sorts by event_at DESC. Cursor encoding
    // stores the chosen sort-key value so re-pagination round-trips.
    const sortKeyExpr = restrictedToEvidence
      ? 'event_at'
      : 'vendor_created_at';

    if (args.cursor !== undefined) {
      let cursor: EngagementsResolverCursor;
      try {
        cursor = decodeEngagementsCursor(args.cursor);
      } catch (err) {
        throw new EngagementCursorInvalidError(
          err instanceof Error ? err.message : 'cursor_invalid',
        );
      }
      // Sort key is sortKeyExpr DESC, (target_id ASC, connection_id ASC)
      // as tiebreakers — paginate strictly less than the cursor row.
      conditions.push(
        `(${sortKeyExpr} < ? OR (${sortKeyExpr} = ? AND (target_id > ? OR (target_id = ? AND connection_id > ?))))`,
      );
      params.push(
        cursor.event_at ?? Number.MIN_SAFE_INTEGER,
        cursor.event_at ?? Number.MIN_SAFE_INTEGER,
        cursor.engagement_id,
        cursor.engagement_id,
        cursor.connection_id,
      );
    }
    const sql = `SELECT * FROM ${ENGAGEMENTS_TABLE}
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${sortKeyExpr} DESC, target_id ASC, connection_id ASC
       LIMIT ?`;
    params.push(pageSize + 1);
    const rows = db.prepare(sql).all(...params) as EngagementDbRow[];

    let nextCursor: string | undefined;
    let pageRows = rows;
    if (rows.length > pageSize) {
      const last = rows[pageSize - 1]!;
      nextCursor = encodeEngagementsCursor({
        event_at: restrictedToEvidence ? last.event_at : last.vendor_created_at,
        engagement_id: last.target_id,
        connection_id: last.connection_id,
      });
      pageRows = rows.slice(0, pageSize);
    }

    // 4. Project rows + apply dedupe collapse.
    const projected: EngagementsResolverRow[] = [];
    const collapsedKeys = new Set<string>();
    const parsedRows = pageRows.map(fromDbRow);

    // D-184 Decision 2 — live exact mail-twin join. Collect this page's
    // email-row RFC822 Message-IDs and resolve them against data.mail in
    // ONE batched lookup; matches flip body_state → 'mail_link' below.
    // Skipped entirely when no resolver is wired (Case 2 — CRM-only / no
    // mail adapter), so rows keep their as-ingested body_state. Resolving
    // here (not at ingest) makes add/remove-mailbox-later correct by
    // construction — the join reflects whatever mail exists at read time.
    let mailTwins: ReadonlyMap<string, string> | undefined;
    if (deps.resolveMailTwins !== undefined) {
      const messageIds: string[] = [];
      for (const row of parsedRows) {
        if (row.entity !== 'email' && row.entity !== 'email_message') continue;
        const mid = (row.meta as { message_id?: unknown }).message_id;
        if (typeof mid === 'string' && mid.length > 0) messageIds.push(mid);
      }
      if (messageIds.length > 0) {
        mailTwins = deps.resolveMailTwins(messageIds);
      }
    }

    for (const row of parsedRows) {
      const collapseKey = `${row.connection_id}|${row.target_id}`;
      if (collapsedKeys.has(collapseKey)) continue;
      const candidates = listDedupeCandidatesForRow(
        row.connection_id,
        row.target_id,
      );
      const projection: EngagementsResolverRow = { ...row };

      if (candidates.length > 0) {
        // Surface candidate metadata regardless of acceptance — the
        // caller may choose to reason about them at the application
        // layer. Capping is enforced at storage layer.
        projection.dedupe_candidates = candidates;
        if (candidates.length === ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP) {
          projection.dedupe_candidates_truncated = true;
        }
      }

      // Collapse rule per § A.5.1 + § A.3.5:
      //  - 'exact'-confidence collapses always (provably-correct).
      //  - 'probable'-confidence collapses ONLY when caller passes
      //    `dedupe_acceptance: 'probable' | 'all'`.
      const exactCandidates = candidates.filter((c) => c.confidence === 'exact');
      if (exactCandidates.length > 0 && row.dedupe_confidence === 'exact') {
        projection.vendor_twins = exactCandidates.map(
          (c) => c.candidate_target_id,
        );
        for (const c of exactCandidates) {
          collapsedKeys.add(
            `${c.candidate_connection_id}|${c.candidate_target_id}`,
          );
        }
      } else if (
        candidates.length > 0 &&
        row.dedupe_confidence === 'probable' &&
        (dedupeAcceptance === 'probable' || dedupeAcceptance === 'all')
      ) {
        projection.vendor_twins = candidates.map((c) => c.candidate_target_id);
        for (const c of candidates) {
          collapsedKeys.add(
            `${c.candidate_connection_id}|${c.candidate_target_id}`,
          );
        }
      }

      // D-184 Decision 2 — Case 1: a live RFC822 Message-ID twin exists in
      // data.mail. Flip body_state → 'mail_link', point at the mail row,
      // and drop the CRM-side inline body (the local mail row holds the
      // authoritative copy — spec § 528 "No body duplication"). When no
      // twin exists (Case 2), the row keeps its as-ingested body_state.
      if (
        mailTwins !== undefined &&
        (row.entity === 'email' || row.entity === 'email_message')
      ) {
        const mid = (row.meta as { message_id?: unknown }).message_id;
        const mailId =
          typeof mid === 'string' ? mailTwins.get(mid) : undefined;
        if (mailId !== undefined) {
          projection.body_state = 'mail_link';
          projection.mail_twin_id = mailId;
          delete projection.body_inline;
          delete projection.body_truncation_offset;
        }
      }

      projected.push(projection);
    }

    return {
      engagements: projected,
      next_cursor: nextCursor,
      coverage: deps.coverage,
    };
  };

  // D-139 P1a.2 § A.6.3 — rescan eligibility enumerator. Walks
  // engagements that match the (connection_id, vendor, entity) tuple
  // AND are inside the time window AND in the eligible lifecycle
  // states AND not tombstoned. Sort ascending target_id for stable
  // page iteration.
  const listRescanEligible: EngagementStore['listRescanEligible'] = (input) => {
    const placeholders = input.eligible_states
      .map(() => '?')
      .join(', ');
    if (placeholders.length === 0) return [];
    const sql = `
      SELECT target_id FROM ${ENGAGEMENTS_TABLE}
       WHERE connection_id = ?
         AND vendor = ?
         AND entity = ?
         AND deleted_at IS NULL
         AND vendor_modified_at >= ?
         AND lifecycle_state IN (${placeholders})
       ORDER BY target_id ASC
    `;
    const params: unknown[] = [
      input.connection_id,
      input.vendor,
      input.entity,
      input.cutoff,
      ...input.eligible_states,
    ];
    const rows = db.prepare(sql).all(...params) as Array<{ target_id: string }>;
    return rows.map((r) => r.target_id);
  };

  const listDealCounterpartyContactEmails: EngagementStore['listDealCounterpartyContactEmails'] = (
    deal_full_target_id,
    limit,
  ) => {
    const rows = dealCounterpartyContactsStmt.all(
      deal_full_target_id,
      limit,
    ) as Array<{ email: string }>;
    return rows.map((r) => r.email);
  };

  return {
    upsert,
    get,
    tombstone,
    ingestEngagementWithEdges,
    upsertEdge,
    tombstoneEdge,
    listEdges,
    tombstoneEdgesForConnection,
    tombstoneEngagementRowsForConnection,
    checkAndInsertInboundEvent,
    lookupInboundEvent,
    compactInboundEventLedger,
    upsertDedupeCandidate,
    listDedupeCandidatesForRow,
    resolveEngagementsForContact,
    listRescanEligible,
    listDealCounterpartyContactEmails,
  };
};
