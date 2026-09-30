/** D-119 Phase 13 — Annotation + Link warehouse storage.
 *
 *  Two SQLite tables (`annotation`, `link`) with the indexes the spec
 *  mandates: per-record (`(target_collection, target_id)` for
 *  annotations; `(from_collection, from_id)` + `(to_collection, to_id)`
 *  for links) and bulk-by-key for annotations. Values share the same
 *  inline/CAS split as `data.shared` and the L2 cache so a 1 MB AI
 *  summary lands as one CAS blob and dedupes if a sibling annotation
 *  carries the same payload.
 *
 *  Cascade-on-parent-delete: `cascadeDelete(collection, id)` removes
 *  every annotation pointing at the record AND every link with the
 *  record as either endpoint, in a single transaction. Adapters call
 *  this immediately before / inside their own record-delete path so
 *  the warehouse never carries dangling references.
 *
 *  ⛔ THIS COMMENT USED TO ASSERT A CALL SITE THAT DID NOT EXIST — that
 *  "the engine's prefetch resolver consults the recipe metadata" for
 *  `annotation_policy`. It never did: `grep annotation_policy
 *  packages/engine/src` was 0 from the day it was written. The policy is
 *  RETIRED; see the `annotation.ts` module doc for why it was also the wrong
 *  shape rather than merely unbuilt.
 *
 *  This store never auto-deletes on a read. The two real removal paths are
 *  `cascadeDelete` (the parent record went) and an explicit
 *  `deleteAnnotations` filter. */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  ANNOTATION_FILTER_FIELDS,
  ANNOTATION_INLINE_CUTOFF_BYTES,
  LINK_FILTER_FIELDS,
  MAX_ANNOTATION_VALUE_BYTES,
  deleteFilterProblem,
  isActor,
  isOriginSurface,
  type Actor,
  type Annotation,
  type AnnotationFilter,
  type AnnotationSearchMatch,
  type AnnotationSearchQuery,
  type Link,
  type LinkFilter,
  type OriginSurface,
  type StoredRowProvenance,
  truncateUtf8WithMarker,
} from '@recued/contracts';
import {
  FTS_REINDEX_PAGE,
  createFtsTable,
  indexRecord,
  deleteRecord as ftsDeleteRecord,
  search as ftsSearch,
} from '@recued/fts';
import type { BlobStore } from './blob-store.js';

const ANNOTATION_TABLE = 'annotation';
/** Exported for a one-off repair whose deletes must share its ledger's
 *  transaction (`mail-attachment-link-repair.ts`); the store's own delete is async. */
export const LINK_TABLE = 'link';
const ANNOTATION_FTS_TABLE = 'annotation_fts';

/** Hard cap on rows returned by list / search — protects callers from
 *  fetching the entire warehouse in one round-trip. The Warehouse
 *  explorer paginates above this cap. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export class AnnotationValueTooLargeError extends Error {
  constructor(size: number) {
    super(
      `annotation_value_too_large: serialized ${size} bytes exceeds ${MAX_ANNOTATION_VALUE_BYTES}`,
    );
    this.name = 'AnnotationValueTooLargeError';
  }
}

export class AnnotationKeyInvalidError extends Error {
  constructor(reason: string) {
    super(`annotation_key_invalid: ${reason}`);
    this.name = 'AnnotationKeyInvalidError';
  }
}

/** Input shape for `annotate()`. The store stamps `_id`, `_collection`
 *  and `authored_at` itself; callers supply the user-meaningful fields
 *  + the stamps the engine pre-computes (source / recipe / model
 *  hashes). */
export interface AnnotateInput {
  target_collection: string;
  target_id: string;
  key: string;
  value: unknown;
  authored_by_recipe_id: string;
  source_record_hash: string;
  model_used?: string;
  /** D-120 Phase 7.5 — bistemporal stamp. Backfill recipes summarising
   *  historical mail / calendar pass through the source record's date
   *  here so `data.timeline()` event-axis ordering surfaces the
   *  annotation on the underlying record's actual date rather than
   *  the moment the recipe ran. Null/undefined = no underlying event;
   *  consumers fall back to `authored_at`. */
  event_at?: number;
  /** D-161 P2 — origin provenance facet (the write-actor). SERVER-INJECTED
   *  by the handler from `deps.origin_actor` (the recipe upsert path lifts
   *  the engine's `stepMeta.actor`; a direct paired-client `annotation.write`
   *  is stamped `'user_self'`); never read from the recipe / rpc payload
   *  (I-6 / A.5). Omitted → store stamps `'system'` via the column default. */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution, paired with
   *  `origin_actor`; present iff contracted (N.4). */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — write surface, SERVER-INJECTED at the same
   *  boundary as `origin_actor` (`'client_rpc'` from the direct rpc
   *  handler, `'engine'` from the recipe-path deps lift). Omitted →
   *  store stamps `'system'` via the column default. */
  origin_surface?: OriginSurface;
}

/** Input shape for `link()`. */
export interface LinkInput {
  from_collection: string;
  from_id: string;
  to_collection: string;
  to_id: string;
  role: string;
  authored_by_recipe_id: string;
  /** D-120 Phase 7.5 — bistemporal stamp (same semantics as
   *  `AnnotateInput.event_at`). Carries the underlying real-world
   *  event date when the link captures a relationship dated earlier
   *  than Recued's discovery. */
  event_at?: number;
  /** D-122 Phase 2 — recipe-emitted confidence in [0, 1] for
   *  probabilistic links. Engine-emitted writes leave this undefined. */
  confidence?: number;
  /** D-122 Phase 2 — short rationale surfaced in the Memory tab
   *  provenance block; capped at 1 KB before insert. */
  evidence?: string;
  /** D-161 P2 — origin provenance facet (same semantics as
   *  `AnnotateInput.origin_actor`). SERVER-INJECTED; omitted → `'system'`. */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution. */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — write surface (same boundary as
   *  `AnnotateInput.origin_surface`). Stamped for substrate coherence;
   *  link rows are NOT consulted by the stored-cleanliness gate. */
  origin_surface?: OriginSurface;
}

/** Hard cap on `LinkInput.evidence` so a bad recipe can't bloat the
 *  link table with megabyte-sized rationales. Truncates with an ellipsis
 *  marker rather than throwing — the rationale is best-effort metadata. */
export const MAX_LINK_EVIDENCE_BYTES = 1024;

/** Aggregate result of a cascade sweep. Useful for audit + tests. */
export interface CascadeResult {
  annotations_deleted: number;
  links_deleted: number;
}

export interface AnnotationStore {
  annotate(input: AnnotateInput): Promise<Annotation>;
  link(input: LinkInput): Promise<Link>;
  /** Atomic recipe-link upsert on the semantic endpoint tuple. Optional so
   * lightweight test doubles and older adapters can fall back to link(). */
  upsertLink?(input: LinkInput): Promise<Link>;

  /** D-119 Phase 13.7 — evict stale annotations.
   *
   *  Deletes every row matching `filter` whose stamps don't match
   *  `current`. A row is stale when any of:
   *    - `source_record_hash` differs (the source record changed)
   *    - `model_used` differs (the AI model rotated, when both row
   *      and current carry a stamp)
   *  ⚠ NO CALLER TODAY, deliberately. This is the primitive a HOUSEKEEPING
   *  task would use — idle-driven, deterministic, server-side, which is where
   *  "the source moved under a derived fact" belongs. It is NOT reachable from
   *  a recipe, an owner surface, or chat, and re-exposing it on a read path is
   *  the shape that was just retired. Returns the number of rows deleted. */
  evictStaleAnnotations(
    filter: AnnotationFilter,
    current: { source_record_hash: string; model_used?: string },
  ): Promise<number>;

  /** Bulk read with filter. Used by `annotation-list`. */
  listAnnotations(filter: AnnotationFilter): Promise<Annotation[]>;
  /** FTS5 search across annotation values. CAS-stored values (>64 KB)
   *  are not indexed — same documented limit as the shared store. */
  searchAnnotations(query: AnnotationSearchQuery): Promise<AnnotationSearchMatch[]>;
  deleteAnnotations(filter: AnnotationFilter): Promise<number>;
  deleteAnnotation(id: string): Promise<boolean>;

  listLinks(filter: LinkFilter): Promise<Link[]>;
  deleteLinks(filter: LinkFilter): Promise<number>;
  deleteLink(id: string): Promise<boolean>;

  /** Per-record convenience read. Returns the latest row per
   *  `(target_collection, target_id, key)` triple — last write wins. */
  annotationsForRecord(collection: string, id: string): Promise<Annotation[]>;
  /** D-177 N.11 rule 1 — SYNCHRONOUS provenance read of the latest
   *  annotation row for one `(collection, id, key)` triple: the facets
   *  of the same row the prefetch's latest-per-key fold resolves, with
   *  the value (and its possible blob I/O) deliberately not loaded —
   *  the open-projection walk is sync and needs only the writer facets.
   *  Rows TIED at the max `authored_at` must AGREE on all three facets;
   *  a disagreeing tie returns `undefined` (fail closed — whichever row
   *  the fold picks, the gate never reads cleaner than the row served).
   *  `undefined` also for no-such-row. */
  latestAnnotationProvenance(
    collection: string,
    id: string,
    key: string,
  ): StoredRowProvenance | undefined;
  /** Per-record convenience read. Returns every link with the record
   *  as the `from` side. */
  outboundLinks(collection: string, id: string): Promise<Link[]>;
  /** Same metadata read, usable inside evidence/version checks that must not yield. */
  outboundLinksSync?(collection: string, id: string): Link[];
  /** Per-record convenience read. Returns every link with the record
   *  as the `to` side. */
  inboundLinks(collection: string, id: string): Promise<Link[]>;

  /** Synchronous transactional sweep — deletes every annotation
   *  pointing at the record AND every link with the record as either
   *  endpoint. Caller passes a `Database.Transaction` if it wants the
   *  cascade joined to its own record-delete; otherwise the store
   *  opens its own transaction. */
  cascadeDelete(collection: string, id: string): CascadeResult;

  /** D-138 P1 — rewrite every annotation + link reference from
   *  `(collection, fromId)` to `(collection, toId)`. Used by the
   *  contact-merge transaction (A.8) to migrate the loser row's
   *  annotations + links onto the survivor. Same-key collisions resolve
   *  survivor-side: the survivor's canonical value wins and the loser's
   *  value is preserved in the survivor annotation's `extras` (keyed by
   *  the loser `target_id`; multi-way merges accumulate one key each) per
   *  spec § A.8. Link rewrites have no key collision — links are typed
   *  relationships, not key-unique-on-target. Idempotent: re-running with
   *  no remaining loser-side references is a no-op. `async` because a
   *  blob-stored loser value is resolved (CAS fetch) before the sync
   *  transaction stashes it into `extras`. Returns counts for audit. */
  rewriteRecordId(
    collection: string,
    fromId: string,
    toId: string,
  ): Promise<{ annotations_rewritten: number; annotations_collided: number; links_rewritten: number }>;

  close(): void;
}

export const ensureAnnotationSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ANNOTATION_TABLE} (
      id                    TEXT PRIMARY KEY,
      target_collection     TEXT NOT NULL,
      target_id             TEXT NOT NULL,
      key                   TEXT NOT NULL,
      value_inline          TEXT,
      blob_hash             TEXT,
      size_bytes            INTEGER NOT NULL,
      authored_by_recipe_id TEXT NOT NULL,
      source_record_hash    TEXT NOT NULL,
      model_used            TEXT,
      authored_at           INTEGER NOT NULL,
      -- D-120 Phase 7.5 — bistemporal stamp; null when no underlying
      -- world event date is known. Existing deployments pick this up
      -- via ensureBistemporalSchema's ALTER TABLE branch in
      -- memory-schema.ts; fresh installs get the column here.
      event_at              INTEGER,
      -- D-161 P2 — origin provenance facet. origin_actor is NOT NULL
      -- DEFAULT 'system' so every annotation row carries a non-null
      -- write-actor (I-5) even on the unwired append-kernel path; the
      -- recipe upsert path + direct rpc thread the real actor.
      -- origin_contract_id is nullable — present iff the writing source
      -- carried a contract_id (N.4). Existing dev DBs pick the columns
      -- up via the idempotent ALTER block below.
      origin_actor          TEXT NOT NULL DEFAULT 'system',
      origin_contract_id    TEXT,
      -- D-177 N.11 rule 1 — write SURFACE facet ('client_rpc' direct
      -- paired-client rpc / 'engine' recipe-run kernel write / 'system'
      -- default). With origin_actor it decides the stored-cleanliness
      -- gate (isUserCleanStoredRow). Annotation writes are
      -- delete-then-insert at the upsert layer, so the latest row per
      -- key carries the LAST writer's facets by construction.
      origin_surface        TEXT NOT NULL DEFAULT 'system',
      -- D-138 § A.8 — absorbed-loser values from contact-merge key
      -- collisions: a JSON object keyed by loser id, mapping to the loser's
      -- preserved value. NULL (the common case) = no merge has absorbed
      -- anything into this row. Annotation-only: links never collide on key.
      -- Existing dev DBs pick the column up via the idempotent ALTER below.
      extras                TEXT
    );
    -- THE BLOB-GC KEEPSET INDEX. The cascade's blob sweep and archive export
    --   both build a keepset with
    --     SELECT DISTINCT blob_hash ... WHERE blob_hash IS NOT NULL
    --   which planned as a full SCAN plus a TEMP B-TREE for the DISTINCT --
    --   reading every row of the table to find the few that carry a CAS blob.
    --   Measured at 200k rows with 2%% blob-bearing: 3.34ms -> 0.01ms (334x),
    --   identical answer.
    --
    -- PARTIAL, so it holds only the blob-bearing rows -- 4,000 of 200,000 in
    --   that measurement. Only ~2%% of writes touch it, which is what makes a
    --   recurring O(all rows) GC pass into an O(blob rows) one for almost no
    --   write cost. It is also COVERING for this query, so the DISTINCT dedups
    --   over already-sorted index values instead of building a b-tree.
    --
    -- One shape, six call sites (collections, calendar, annotation,
    --   shared_store, cache_entries, and the collection_* walk in
    --   collection-blob-refs.ts). Fixing one would have left the rest scanning.
    CREATE INDEX IF NOT EXISTS annotation_blob_hash_idx
      ON ${ANNOTATION_TABLE} (blob_hash) WHERE blob_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS annotation_target_idx
      ON ${ANNOTATION_TABLE} (target_collection, target_id);
    CREATE INDEX IF NOT EXISTS annotation_key_idx
      ON ${ANNOTATION_TABLE} (key);
    CREATE INDEX IF NOT EXISTS annotation_recipe_idx
      ON ${ANNOTATION_TABLE} (authored_by_recipe_id);

    CREATE TABLE IF NOT EXISTS ${LINK_TABLE} (
      id                    TEXT PRIMARY KEY,
      from_collection       TEXT NOT NULL,
      from_id               TEXT NOT NULL,
      to_collection         TEXT NOT NULL,
      to_id                 TEXT NOT NULL,
      role                  TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      authored_by_recipe_id TEXT NOT NULL,
      -- D-120 Phase 7.5 — same semantics as annotation.event_at.
      event_at              INTEGER,
      -- D-122 Phase 2 — recipe-emitted probabilistic metadata for the
      -- link-create graph-builder ingredient. Engine-emitted writes
      -- leave both null. Existing deployments pick the columns up via
      -- ensureLinkConfidenceSchema's ALTER branch in memory-schema.ts;
      -- fresh installs get them here.
      confidence            REAL,
      evidence              TEXT,
      -- D-161 P2 — origin provenance facet (same semantics as
      -- annotation.origin_actor). Existing dev DBs pick the columns up
      -- via the idempotent ALTER block below.
      origin_actor          TEXT NOT NULL DEFAULT 'system',
      origin_contract_id    TEXT,
      -- D-177 N.11 rule 1 — schema symmetry with the annotation table.
      -- Link rows are NOT consulted by the stored-cleanliness gate (the
      -- plural .links.<role> grammar stays tainted-pinned); writes stamp
      -- the facet for coherence only.
      origin_surface        TEXT NOT NULL DEFAULT 'system'
    );
    CREATE INDEX IF NOT EXISTS link_from_idx
      ON ${LINK_TABLE} (from_collection, from_id);
    CREATE INDEX IF NOT EXISTS link_to_idx
      ON ${LINK_TABLE} (to_collection, to_id);
    CREATE INDEX IF NOT EXISTS link_role_idx
      ON ${LINK_TABLE} (role);
  `);
  // D-161 P2 — additive origin-column upgrade for dev DBs that predate
  // the columns (pre-launch zero installs — no backfill beyond the
  // 'system' default). `CREATE TABLE IF NOT EXISTS` above skips existing
  // tables, so guard each ALTER with a PRAGMA table_info check. Mirrors
  // the P1 collections/table.ts + enrichment-store.ts upgrade blocks.
  for (const table of [ANNOTATION_TABLE, LINK_TABLE]) {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!existing.has('origin_actor')) {
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN origin_actor TEXT NOT NULL DEFAULT 'system'`,
      );
    }
    if (!existing.has('origin_contract_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN origin_contract_id TEXT`);
    }
    // D-177 N.11 rule 1 — write-surface facet (same additive pattern).
    if (!existing.has('origin_surface')) {
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN origin_surface TEXT NOT NULL DEFAULT 'system'`,
      );
    }
  }
  // D-138 § A.8 — annotation-only `extras` column (absorbed loser values on
  // merge collision). Separate from the loop above because links have no key
  // collision and never carry it. Same additive dev-DB upgrade pattern
  // (pre-launch zero installs — no backfill; NULL = nothing absorbed).
  {
    const annCols = new Set(
      (db.prepare(`PRAGMA table_info(${ANNOTATION_TABLE})`).all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!annCols.has('extras')) {
      db.exec(`ALTER TABLE ${ANNOTATION_TABLE} ADD COLUMN extras TEXT`);
    }
    // D-120 — RETIRE `recipe_hash`. Dropped rather than left in place because
    // every value it ever held was WRONG BY CONSTRUCTION: `hashRecipe` covers
    // the writing step's own args, so a recipe embedding its hash changes the
    // hash, and no author could produce a correct one. Keeping the column would
    // preserve nothing but a fabrication, and the run's audit row already
    // carries the real recipe hash.
    //
    // The four SERVER-side writers (gateway saga / in-doubt reconciliation,
    // link-discovery, deterministic-risk-patterns) used it as a constant writer
    // TAG, never a hash — and each already carries a distinct synthetic
    // `authored_by_recipe_id`, so none of them loses identity here.
    //
    // ⚠ Mid-run recipe change is NOT what this column was protecting: a
    // checkpoint freezes `recipe_snapshot` across pause/resume and a
    // `version_bump` issues a new process, so the snapshot boundary already
    // answers "the recipe changed". Comparing hashes per row at read time was a
    // weaker parallel mechanism at the wrong layer.
    if (annCols.has('recipe_hash')) {
      db.exec(`ALTER TABLE ${ANNOTATION_TABLE} DROP COLUMN recipe_hash`);
    }
  }
  // One-time rebuild when the stored FTS text's format changes — see
  // `FTS_CONTENT_FORMAT`. Format 2 space-separates unspaced scripts so a
  // 2-character CJK / Thai term matches as an adjacent phrase.
  //
  // ⛔ THIS STORE NEEDED IT TO AVOID A REGRESSION, not just to gain the fix.
  // Writes now go in segmented; leaving old rows verbatim would strand them
  // where even the run-INITIAL matches they used to serve stop working, because
  // the query side is segmented too. Indexing only inline values mirrors the
  // write path exactly — a CAS-spilled value is not in the index there either.
  createFtsTable(db, ANNOTATION_FTS_TABLE, {
    reindex: () => {
      // ⛔ PAGED, NOT `.iterate()` — better-sqlite3 refuses a write while a read
      // statement is iterating, and this loop writes per row. See the note in
      // `collections/table.ts`; the failure is silent and empties the index.
      const page = db.prepare(
        `SELECT id, value_inline FROM ${ANNOTATION_TABLE} `
        + `WHERE value_inline IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
      );
      let after = '';
      for (;;) {
        const rows = page.all(after, FTS_REINDEX_PAGE) as
          Array<{ id: string; value_inline: string }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          indexRecord(db, ANNOTATION_FTS_TABLE, row.id, row.value_inline);
        }
        after = rows[rows.length - 1].id;
      }
    },
  });
};

const assertValidAnnotationInput = (input: AnnotateInput): void => {
  if (!input.target_collection || typeof input.target_collection !== 'string') {
    throw new AnnotationKeyInvalidError('target_collection must be a non-empty string');
  }
  if (!input.target_id || typeof input.target_id !== 'string') {
    throw new AnnotationKeyInvalidError('target_id must be a non-empty string');
  }
  if (!input.key || typeof input.key !== 'string') {
    throw new AnnotationKeyInvalidError('key must be a non-empty string');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(input.key)) {
    throw new AnnotationKeyInvalidError('key contains invalid characters (allowed: [A-Za-z0-9._-])');
  }
};

const assertValidLinkInput = (input: LinkInput): void => {
  for (const field of [
    'from_collection',
    'from_id',
    'to_collection',
    'to_id',
    'role',
  ] as const) {
    if (!input[field] || typeof input[field] !== 'string') {
      throw new AnnotationKeyInvalidError(`${field} must be a non-empty string`);
    }
  }
};

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
};

interface AnnotationRow {
  id: string;
  target_collection: string;
  target_id: string;
  key: string;
  value_inline: string | null;
  blob_hash: string | null;
  size_bytes: number;
  authored_by_recipe_id: string;
  source_record_hash: string;
  model_used: string | null;
  authored_at: number;
  /** D-120 Phase 7.5 — bistemporal stamp; NULL = no underlying event date. */
  event_at: number | null;
  /** D-161 P2 — origin provenance facet; NOT NULL DEFAULT 'system'. */
  origin_actor: string;
  origin_contract_id: string | null;
  /** D-177 N.11 rule 1 — write surface; NOT NULL DEFAULT 'system'. */
  origin_surface: string;
  /** D-138 § A.8 — JSON `{ <loser_id>: <value> }` of merge-absorbed loser
   *  values, or NULL when nothing has been absorbed. */
  extras: string | null;
}

interface LinkRow {
  id: string;
  from_collection: string;
  from_id: string;
  to_collection: string;
  to_id: string;
  role: string;
  created_at: number;
  authored_by_recipe_id: string;
  /** D-120 Phase 7.5 — bistemporal stamp. */
  event_at: number | null;
  /** D-122 Phase 2 — null pre-D-122 or for engine-emitted writes. */
  confidence: number | null;
  /** D-122 Phase 2 — null pre-D-122 or for engine-emitted writes. */
  evidence: string | null;
  /** D-161 P2 — origin provenance facet; NOT NULL DEFAULT 'system'. */
  origin_actor: string;
  origin_contract_id: string | null;
}

const linkFromRow = (row: LinkRow): Link => {
  const out: Link = {
    _id: row.id,
    _collection: 'link',
    from_collection: row.from_collection,
    from_id: row.from_id,
    to_collection: row.to_collection,
    to_id: row.to_id,
    role: row.role,
    created_at: row.created_at,
    authored_by_recipe_id: row.authored_by_recipe_id,
  };
  // D-120 Phase 7.5 — surface the bistemporal stamp when present.
  if (row.event_at !== null) out.event_at = row.event_at;
  // D-122 Phase 2 — recipe-emitted probabilistic metadata.
  if (row.confidence !== null) out.confidence = row.confidence;
  if (row.evidence !== null) out.evidence = row.evidence;
  // D-161 P2 — surface the origin facet (I-5). `?? 'system'` guards a
  // pre-migration dev row that read back NULL.
  out.origin_actor = isActor(row.origin_actor) ? row.origin_actor : 'system';
  if (row.origin_contract_id !== null) out.origin_contract_id = row.origin_contract_id;
  return out;
};

export interface CreateAnnotationStoreOptions {
  db: Database.Database;
  blobs: BlobStore;
  /** Time source for `authored_at` / `created_at`. */
  now?: () => number;
  /** ID factory — defaults to `randomUUID`. Tests override for
   *  deterministic ids. */
  newId?: () => string;
  /** Phase B gate hook. Every write reports the signed byte delta so
   *  the surrounding gate (`annotation_store`) stays aligned with the
   *  live `SUM(size_bytes)` total. Exceptions thrown by the sink are
   *  swallowed so a misbehaving gate never breaks a write. */
  onBytesChanged?: (delta: number) => void;
}

export const createAnnotationStore = (
  opts: CreateAnnotationStoreOptions,
): AnnotationStore => {
  const { db, blobs } = opts;
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? (() => randomUUID());
  const onBytesChanged = opts.onBytesChanged;

  const reportDelta = (delta: number): void => {
    if (onBytesChanged && delta !== 0) {
      try { onBytesChanged(delta); } catch { /* swallow */ }
    }
  };

  ensureAnnotationSchema(db);

  // ── Prepared statements ───────────────────────────────────────
  // D-120 Phase 7.5 — `event_at` columns added by ensureBistemporalSchema
  // (called from bin.ts after this store's table is created); the wider
  // INSERT shape is safe because the migration always runs at boot
  // before any rpc / engine traffic that uses these statements.
  const insertAnnotation = db.prepare(
    `INSERT INTO ${ANNOTATION_TABLE} (
       id, target_collection, target_id, key,
       value_inline, blob_hash, size_bytes,
       authored_by_recipe_id, source_record_hash, model_used,
       authored_at, event_at, origin_actor, origin_contract_id,
       origin_surface
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertLink = db.prepare(
    `INSERT INTO ${LINK_TABLE} (
       id, from_collection, from_id, to_collection, to_id,
       role, created_at, authored_by_recipe_id, event_at,
       confidence, evidence, origin_actor, origin_contract_id,
       origin_surface
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const matchingLinks = db.prepare(
    `SELECT * FROM ${LINK_TABLE}
      WHERE from_collection = ? AND from_id = ?
        AND to_collection = ? AND to_id = ? AND role = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const updateLinkById = db.prepare(
    `UPDATE ${LINK_TABLE}
        SET authored_by_recipe_id = ?, event_at = ?, confidence = ?, evidence = ?,
            origin_actor = ?, origin_contract_id = ?, origin_surface = ?
      WHERE id = ?`,
  );
  const deleteDuplicateLinks = db.prepare(
    `DELETE FROM ${LINK_TABLE}
      WHERE from_collection = ? AND from_id = ?
        AND to_collection = ? AND to_id = ? AND role = ? AND id <> ?`,
  );
  const readLinkById = db.prepare(`SELECT * FROM ${LINK_TABLE} WHERE id = ?`);

  // ── Resolve helpers ───────────────────────────────────────────
  const resolveAnnotationValue = async (
    row: Pick<AnnotationRow, 'value_inline' | 'blob_hash'>,
  ): Promise<unknown> => {
    if (row.value_inline !== null) {
      try { return JSON.parse(row.value_inline); } catch { return row.value_inline; }
    }
    if (row.blob_hash !== null) {
      const buf = await blobs.get(row.blob_hash);
      if (!buf) return null;
      try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8'); }
    }
    return null;
  };

  const annotationFromRow = async (row: AnnotationRow): Promise<Annotation> => {
    const value = await resolveAnnotationValue(row);
    const ann: Annotation = {
      _id: row.id,
      _collection: 'annotation',
      target_collection: row.target_collection,
      target_id: row.target_id,
      key: row.key,
      value,
      authored_by_recipe_id: row.authored_by_recipe_id,
      source_record_hash: row.source_record_hash,
      authored_at: row.authored_at,
    };
    if (row.model_used !== null) ann.model_used = row.model_used;
    // D-120 Phase 7.5 — bistemporal stamp surfaces back to recipes
    // through the same row when present.
    if (row.event_at !== null && row.event_at !== undefined) {
      ann.event_at = row.event_at;
    }
    // D-161 P2 — surface the origin facet (I-5). `?? 'system'` guards a
    // pre-migration dev row that read back NULL.
    ann.origin_actor = isActor(row.origin_actor) ? row.origin_actor : 'system';
    if (row.origin_contract_id !== null && row.origin_contract_id !== undefined) {
      ann.origin_contract_id = row.origin_contract_id;
    }
    // D-177 N.11 rule 1 — write surface; unknown stored values read as
    // 'system' (fail closed at the cleanliness gate).
    ann.origin_surface = isOriginSurface(row.origin_surface)
      ? row.origin_surface
      : 'system';
    // D-138 § A.8 — surface absorbed-loser values for direct inspection. A
    // malformed / non-object blob is dropped rather than surfaced as garbage
    // (audit-only field; absence is the safe default).
    if (row.extras !== null && row.extras !== undefined) {
      try {
        const parsed = JSON.parse(row.extras);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          ann.extras = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed extras — omit */
      }
    }
    return ann;
  };

  // ── annotate / link writes ────────────────────────────────────
  const annotate = async (input: AnnotateInput): Promise<Annotation> => {
    assertValidAnnotationInput(input);
    const serialized = JSON.stringify(input.value ?? null);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_ANNOTATION_VALUE_BYTES) {
      throw new AnnotationValueTooLargeError(bytes);
    }

    let inline: string | null = serialized;
    let blobHash: string | null = null;
    if (bytes > ANNOTATION_INLINE_CUTOFF_BYTES) {
      blobHash = await blobs.put(Buffer.from(serialized, 'utf8'));
      inline = null;
    }

    const id = newId();
    const ts = now();
    // D-161 P2 — origin facet. The handler injects the real write-actor
    // via `input.origin_actor` (server-derived); absent → 'system' to
    // match the column default (I-5). D-177 adds the write-surface
    // facet on the same boundary.
    const originActor = input.origin_actor ?? 'system';
    const originContractId = input.origin_contract_id ?? null;
    const originSurface = input.origin_surface ?? 'system';
    insertAnnotation.run(
      id,
      input.target_collection,
      input.target_id,
      input.key,
      inline,
      blobHash,
      bytes,
      input.authored_by_recipe_id,
      input.source_record_hash,
      input.model_used ?? null,
      ts,
      input.event_at ?? null,
      originActor,
      originContractId,
      originSurface,
    );

    if (inline !== null) {
      indexRecord(db, ANNOTATION_FTS_TABLE, id, serialized);
    }

    reportDelta(bytes);

    const out: Annotation = {
      _id: id,
      _collection: 'annotation',
      target_collection: input.target_collection,
      target_id: input.target_id,
      key: input.key,
      value: input.value,
      authored_by_recipe_id: input.authored_by_recipe_id,
      source_record_hash: input.source_record_hash,
      authored_at: ts,
    };
    if (input.model_used !== undefined) out.model_used = input.model_used;
    // D-120 Phase 7.5 — surface the bistemporal stamp back on the
    // returned shape when the caller supplied one.
    if (input.event_at !== undefined) out.event_at = input.event_at;
    // D-161 P2 — surface the origin facet back on the returned shape
    // (always populated — the store stamps 'system' when the caller omits).
    if (isActor(originActor)) out.origin_actor = originActor;
    if (originContractId !== null) out.origin_contract_id = originContractId;
    return out;
  };

  const link = async (input: LinkInput): Promise<Link> => {
    assertValidLinkInput(input);
    const id = newId();
    const ts = now();
    // D-122 Phase 2 — silent truncation on `evidence` keeps the link
    // table bounded without throwing; recipes pass back the AI's free-
    // form rationale and shouldn't need to length-guard themselves.
    const evidence =
      typeof input.evidence === 'string' && input.evidence.length > 0
        // ⛔ WAS `slice(0, MAX - 1) + '…'`, WHICH BOUNDS NOTHING. `slice` counts
        //   UTF-16 units against a BYTE cap (3x for CJK), and `…` is THREE bytes,
        //   so even pure ASCII landed at 1,026 against a 1,024 cap. The helper
        //   budgets the marker by its encoded size and cuts on a code point.
        ? truncateUtf8WithMarker(input.evidence, MAX_LINK_EVIDENCE_BYTES)
        : null;
    const confidence =
      typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? Math.max(0, Math.min(1, input.confidence))
        : null;
    // D-161 P2 — origin facet (server-derived; absent → 'system').
    // D-177 — write surface stamped for coherence (links stay ungated).
    const originActor = input.origin_actor ?? 'system';
    const originContractId = input.origin_contract_id ?? null;
    const originSurface = input.origin_surface ?? 'system';
    insertLink.run(
      id,
      input.from_collection,
      input.from_id,
      input.to_collection,
      input.to_id,
      input.role,
      ts,
      input.authored_by_recipe_id,
      input.event_at ?? null,
      confidence,
      evidence,
      originActor,
      originContractId,
      originSurface,
    );
    const out: Link = {
      _id: id,
      _collection: 'link',
      from_collection: input.from_collection,
      from_id: input.from_id,
      to_collection: input.to_collection,
      to_id: input.to_id,
      role: input.role,
      created_at: ts,
      authored_by_recipe_id: input.authored_by_recipe_id,
    };
    if (input.event_at !== undefined) out.event_at = input.event_at;
    if (confidence !== null) out.confidence = confidence;
    if (evidence !== null) out.evidence = evidence;
    // D-161 P2 — surface the origin facet (always populated).
    if (isActor(originActor)) out.origin_actor = originActor;
    if (originContractId !== null) out.origin_contract_id = originContractId;
    return out;
  };

  /** D-200 Slice 1 fold — recipe link creation was documented as idempotent,
   * but the handler's delete-then-insert sequence could interleave across two
   * duplicate starts and leave two rows. Hold the SQLite writer lock before
   * selecting the tuple, update one stable row in place, and heal any older
   * duplicates under the same transaction. Engine append-links keep using
   * link(); only the explicit recipe link.create path calls this method. */
  const upsertLink = async (input: LinkInput): Promise<Link> => {
    assertValidLinkInput(input);
    const evidence =
      typeof input.evidence === 'string' && input.evidence.length > 0
        // ⛔ WAS `slice(0, MAX - 1) + '…'`, WHICH BOUNDS NOTHING. `slice` counts
        //   UTF-16 units against a BYTE cap (3x for CJK), and `…` is THREE bytes,
        //   so even pure ASCII landed at 1,026 against a 1,024 cap. The helper
        //   budgets the marker by its encoded size and cuts on a code point.
        ? truncateUtf8WithMarker(input.evidence, MAX_LINK_EVIDENCE_BYTES)
        : null;
    const confidence =
      typeof input.confidence === 'number' && Number.isFinite(input.confidence)
        ? Math.max(0, Math.min(1, input.confidence))
        : null;
    const originActor = input.origin_actor ?? 'system';
    const originContractId = input.origin_contract_id ?? null;
    const originSurface = input.origin_surface ?? 'system';
    const tuple = [
      input.from_collection,
      input.from_id,
      input.to_collection,
      input.to_id,
      input.role,
    ] as const;
    const apply = db.transaction((): LinkRow => {
      const rows = matchingLinks.all(...tuple) as LinkRow[];
      const keep = rows[0];
      if (keep !== undefined) {
        updateLinkById.run(
          input.authored_by_recipe_id,
          input.event_at ?? null,
          confidence,
          evidence,
          originActor,
          originContractId,
          originSurface,
          keep.id,
        );
        deleteDuplicateLinks.run(...tuple, keep.id);
        return readLinkById.get(keep.id) as LinkRow;
      }

      const id = newId();
      insertLink.run(
        id,
        ...tuple.slice(0, 4),
        input.role,
        now(),
        input.authored_by_recipe_id,
        input.event_at ?? null,
        confidence,
        evidence,
        originActor,
        originContractId,
        originSurface,
      );
      return readLinkById.get(id) as LinkRow;
    });
    return linkFromRow(apply.immediate());
  };

  // ── filter compilation (shared between list + delete) ──────────
  const compileAnnotationFilter = (
    filter: AnnotationFilter,
  ): { sql: string; params: unknown[] } => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.target_collection !== undefined) {
      clauses.push('target_collection = ?');
      params.push(filter.target_collection);
    }
    if (filter.target_id !== undefined) {
      clauses.push('target_id = ?');
      params.push(filter.target_id);
    }
    if (filter.key !== undefined) {
      clauses.push('key = ?');
      params.push(filter.key);
    }
    if (filter.authored_by_recipe_id !== undefined) {
      clauses.push('authored_by_recipe_id = ?');
      params.push(filter.authored_by_recipe_id);
    }
    if (filter.since !== undefined) {
      clauses.push('authored_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('authored_at < ?');
      params.push(filter.until);
    }
    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  };

  const compileLinkFilter = (
    filter: LinkFilter,
  ): { sql: string; params: unknown[] } => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.from_collection !== undefined) {
      clauses.push('from_collection = ?');
      params.push(filter.from_collection);
    }
    if (filter.from_id !== undefined) {
      clauses.push('from_id = ?');
      params.push(filter.from_id);
    }
    if (filter.to_collection !== undefined) {
      clauses.push('to_collection = ?');
      params.push(filter.to_collection);
    }
    if (filter.to_id !== undefined) {
      clauses.push('to_id = ?');
      params.push(filter.to_id);
    }
    if (filter.role !== undefined) {
      clauses.push('role = ?');
      params.push(filter.role);
    }
    if (filter.authored_by_recipe_id !== undefined) {
      clauses.push('authored_by_recipe_id = ?');
      params.push(filter.authored_by_recipe_id);
    }
    if (filter.since !== undefined) {
      clauses.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('created_at < ?');
      params.push(filter.until);
    }
    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  };

  // ── list / search / delete ────────────────────────────────────
  const listAnnotations = async (filter: AnnotationFilter): Promise<Annotation[]> => {
    const { sql, params } = compileAnnotationFilter(filter);
    const limit = clampLimit(filter.limit);
    const rows = db
      .prepare(`SELECT * FROM ${ANNOTATION_TABLE} ${sql} ORDER BY authored_at DESC LIMIT ?`)
      .all(...params, limit) as AnnotationRow[];
    return Promise.all(rows.map(annotationFromRow));
  };

  const searchAnnotations = async (
    query: AnnotationSearchQuery,
  ): Promise<AnnotationSearchMatch[]> => {
    const limit = clampLimit(query.limit);
    const matches = ftsSearch(db, ANNOTATION_FTS_TABLE, {
      scope: '*',
      query: query.query,
      limit,
    });
    if (matches.length === 0) return [];
    const ids = matches.map((m) => m.key);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM ${ANNOTATION_TABLE} WHERE id IN (${placeholders})`)
      .all(...ids) as AnnotationRow[];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const out: AnnotationSearchMatch[] = [];
    for (const m of matches) {
      const row = rowById.get(m.key);
      if (!row) continue;
      if (query.key !== undefined && row.key !== query.key) continue;
      if (
        query.target_collection !== undefined
        && row.target_collection !== query.target_collection
      ) continue;
      const value = await resolveAnnotationValue(row);
      out.push({
        annotation_id: row.id,
        target_collection: row.target_collection,
        target_id: row.target_id,
        key: row.key,
        value,
        rank: m.rank,
      });
    }
    return out;
  };

  const deleteAnnotationsByFilter = (filter: AnnotationFilter): number => {
    // Refuse to wipe the whole table — every other ingredient guards against
    // it and we want this surface to behave the same. ⛔ Judged on what the
    // compiler will USE, not on how many keys were passed: an unknown key or a
    // field with no value drops out of the WHERE clause, and a delete that
    // counted keys ran unfiltered (integrity audit, 2026-09-24).
    const problem = deleteFilterProblem(filter, ANNOTATION_FILTER_FIELDS);
    if (problem !== null) {
      throw new AnnotationKeyInvalidError(`deleteAnnotations: ${problem}`);
    }
    const { sql, params } = compileAnnotationFilter(filter);
    const apply = db.transaction(() => {
      const rows = db
        .prepare(`SELECT id, size_bytes FROM ${ANNOTATION_TABLE} ${sql}`)
        .all(...params) as Array<{ id: string; size_bytes: number }>;
      const res = db
        .prepare(`DELETE FROM ${ANNOTATION_TABLE} ${sql}`)
        .run(...params);
      for (const row of rows) {
        ftsDeleteRecord(db, ANNOTATION_FTS_TABLE, row.id);
      }
      return {
        changes: res.changes,
        freed: rows.reduce((total, row) => total + row.size_bytes, 0),
      };
    });
    const result = apply.immediate();
    // Blob bytes live in the same content-addressed root as data.shared and
    // may still be referenced by another row with identical content. Never
    // unlink a hash from a row-delete path; the combined reference-aware
    // orphan sweep reclaims it after the final SQL reference disappears.
    reportDelta(-result.freed);
    return result.changes;
  };

  const deleteLinksByFilter = (filter: LinkFilter): number => {
    // The same rule as `deleteAnnotationsByFilter`, for the same reason.
    const problem = deleteFilterProblem(filter, LINK_FILTER_FIELDS);
    if (problem !== null) {
      throw new AnnotationKeyInvalidError(`deleteLinks: ${problem}`);
    }
    const { sql, params } = compileLinkFilter(filter);
    return db.prepare(`DELETE FROM ${LINK_TABLE} ${sql}`).run(...params).changes;
  };

  // ── per-record reads ──────────────────────────────────────────
  const annotationsForRecord = async (
    collection: string,
    id: string,
  ): Promise<Annotation[]> => {
    // Latest row per `(target_collection, target_id, key)` triple via
    // a window-style subquery: rank rows by authored_at DESC and pick
    // rank=1. SQLite supports ROW_NUMBER() since 3.25; better-sqlite3
    // bundles a recent build.
    const rows = db
      .prepare(`
        SELECT * FROM ${ANNOTATION_TABLE}
        WHERE target_collection = ? AND target_id = ?
          AND id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY key ORDER BY authored_at DESC
              ) AS rn
              FROM ${ANNOTATION_TABLE}
              WHERE target_collection = ? AND target_id = ?
            ) WHERE rn = 1
          )
        ORDER BY key
      `)
      .all(collection, id, collection, id) as AnnotationRow[];
    return Promise.all(rows.map(annotationFromRow));
  };

  // D-177 N.11 rule 1 — sync facet read of the latest row for one key.
  // Matches `annotationsForRecord`'s fold (max authored_at per key);
  // facet-disagreeing ties fail closed to undefined. No value / blob
  // resolution — the open-projection walk needs only writer facets.
  const latestAnnotationProvenance = (
    collection: string,
    id: string,
    key: string,
  ): StoredRowProvenance | undefined => {
    const rows = db
      .prepare(
        `SELECT origin_actor, origin_contract_id, origin_surface
           FROM ${ANNOTATION_TABLE}
          WHERE target_collection = ? AND target_id = ? AND key = ?
            AND authored_at = (
              SELECT MAX(authored_at) FROM ${ANNOTATION_TABLE}
               WHERE target_collection = ? AND target_id = ? AND key = ?
            )`,
      )
      .all(collection, id, key, collection, id, key) as Array<{
        origin_actor: string;
        origin_contract_id: string | null;
        origin_surface: string;
      }>;
    if (rows.length === 0) return undefined;
    const first = rows[0];
    for (const row of rows) {
      if (
        row.origin_actor !== first.origin_actor
        || row.origin_contract_id !== first.origin_contract_id
        || row.origin_surface !== first.origin_surface
      ) {
        return undefined;
      }
    }
    if (!isActor(first.origin_actor)) return undefined;
    const surface: OriginSurface | undefined = isOriginSurface(first.origin_surface)
      ? first.origin_surface
      : undefined;
    return {
      origin_actor: first.origin_actor,
      ...(first.origin_contract_id !== null
        ? { origin_contract_id: first.origin_contract_id }
        : {}),
      ...(surface !== undefined ? { origin_surface: surface } : {}),
    };
  };

  const outboundLinksSync = (
    collection: string,
    id: string,
  ): Link[] => {
    const rows = db
      .prepare(
        `SELECT * FROM ${LINK_TABLE} WHERE from_collection = ? AND from_id = ? ORDER BY role, created_at`,
      )
      .all(collection, id) as LinkRow[];
    return rows.map(linkFromRow);
  };
  const outboundLinks = async (collection: string, id: string): Promise<Link[]> => outboundLinksSync(collection, id);

  const inboundLinks = async (
    collection: string,
    id: string,
  ): Promise<Link[]> => {
    const rows = db
      .prepare(
        `SELECT * FROM ${LINK_TABLE} WHERE to_collection = ? AND to_id = ? ORDER BY role, created_at`,
      )
      .all(collection, id) as LinkRow[];
    return rows.map(linkFromRow);
  };

  // ── cascade ───────────────────────────────────────────────────
  const cascadeDelete = (collection: string, id: string): CascadeResult => {
    const tx = db.transaction((col: string, recId: string): CascadeResult => {
      const annRows = db
        .prepare(
          `SELECT id, size_bytes FROM ${ANNOTATION_TABLE}
            WHERE target_collection = ? AND target_id = ?`,
        )
        .all(col, recId) as Array<{ id: string; size_bytes: number }>;
      let freed = 0;
      for (const r of annRows) {
        ftsDeleteRecord(db, ANNOTATION_FTS_TABLE, r.id);
        freed += r.size_bytes;
      }
      const annResult = db
        .prepare(
          `DELETE FROM ${ANNOTATION_TABLE} WHERE target_collection = ? AND target_id = ?`,
        )
        .run(col, recId);
      const linkResult = db
        .prepare(
          `DELETE FROM ${LINK_TABLE}
            WHERE (from_collection = ? AND from_id = ?)
               OR (to_collection = ? AND to_id = ?)`,
        )
        .run(col, recId, col, recId);
      reportDelta(-freed);
      return {
        annotations_deleted: annResult.changes,
        links_deleted: linkResult.changes,
      };
    });
    return tx(collection, id);
  };

  // ── D-138 P1 — record-id rewrite (merge cascade) ─────────────
  const rewriteRecordId = async (
    collection: string,
    fromId: string,
    toId: string,
  ): Promise<{ annotations_rewritten: number; annotations_collided: number; links_rewritten: number }> => {
    if (fromId === toId) {
      return { annotations_rewritten: 0, annotations_collided: 0, links_rewritten: 0 };
    }
    // Find annotations on the loser side. A2 (D-138 § A.8) — resolve each
    // loser's value up front (inline parse + blob fetch via the shared
    // resolver) so the synchronous transaction below can stash a colliding
    // loser's value into the survivor's `extras` without awaiting CAS I/O
    // inside the txn (better-sqlite3 transactions are synchronous). The
    // resolve set is bounded by one record's annotation count.
    const loserRows = db
      .prepare(
        `SELECT id, key, value_inline, blob_hash, size_bytes FROM ${ANNOTATION_TABLE}
          WHERE target_collection = ? AND target_id = ?`,
      )
      .all(collection, fromId) as Array<{
        id: string;
        key: string;
        value_inline: string | null;
        blob_hash: string | null;
        size_bytes: number;
      }>;
    const resolvedLoserValues = new Map<string, unknown>();
    for (const row of loserRows) {
      resolvedLoserValues.set(row.id, await resolveAnnotationValue(row));
    }

    const tx = db.transaction(() => {
      // For each loser annotation, check if a survivor-side row exists at the
      // same `(collection, key)`. On collision: survivor's canonical value
      // wins, the loser's value is preserved in the survivor's `extras`
      // (keyed by the loser id — its merged-away `target_id`), and the loser
      // row is dropped. On no collision: rewrite target_id. Both mutations
      // re-assert the loser predicate (`target_id = fromId`) so a stale
      // pre-captured `loserRows` (the async value-resolve above yields the
      // event loop) can't double-process a row a concurrent rewrite already
      // moved off the loser side.
      let rewritten = 0;
      let collided = 0;
      let freedBytes = 0;
      let preservedBytes = 0;
      // Hoisted out of the loop: all four are identical SQL every iteration
      // (only the binds change), and `loserRows` is every annotation belonging
      // to the merged-away contact — unbounded in practice. Six prepares per
      // row at ~5.5us each is ~330ms of pure compile overhead on a 10k-row
      // merge, before any work happens.
      const findSurvivorStmt = db.prepare(
        `SELECT id, extras FROM ${ANNOTATION_TABLE}
          WHERE target_collection = ? AND target_id = ? AND key = ?
          ORDER BY authored_at DESC, id DESC LIMIT 1`,
      );
      const deleteLoserStmt = db.prepare(
        `DELETE FROM ${ANNOTATION_TABLE}
          WHERE id = ? AND target_collection = ? AND target_id = ?`,
      );
      const absorbExtrasStmt = db.prepare(
        `UPDATE ${ANNOTATION_TABLE} SET extras = ?, size_bytes = size_bytes + ? WHERE id = ?`,
      );
      const rewriteTargetStmt = db.prepare(
        `UPDATE ${ANNOTATION_TABLE} SET target_id = ?
          WHERE id = ? AND target_collection = ? AND target_id = ?`,
      );
      for (const row of loserRows) {
        // Survivor's CANONICAL row for this key = the latest by authored_at —
        // matches `annotationsForRecord`'s `PARTITION BY key ORDER BY
        // authored_at DESC` dedup, so `extras` lands on the row a per-record
        // read surfaces rather than a superseded duplicate.
        const existing = findSurvivorStmt
          .get(collection, toId, row.key) as
            | { id: string; extras: string | null }
            | undefined;
        if (existing) {
          // Drop the loser row — guarded on the loser predicate (a concurrent
          // rewrite may have already moved it to the survivor side) AND on
          // `.changes` (an already-gone row must not be absorbed or counted).
          const delRes = deleteLoserStmt.run(row.id, collection, fromId);
          if (delRes.changes === 0) continue;
          ftsDeleteRecord(db, ANNOTATION_FTS_TABLE, row.id);
          freedBytes += row.size_bytes;
          collided++;
          // A2 (D-138 § A.8) — preserve the loser value in the survivor's
          // `extras`, accumulating across multi-way merges (read-merge-write,
          // one key per absorbed loser). A malformed existing blob is reset
          // rather than thrown mid-merge.
          let extrasObj: Record<string, unknown> = {};
          if (existing.extras) {
            try {
              const parsed = JSON.parse(existing.extras);
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                extrasObj = parsed as Record<string, unknown>;
              }
            } catch { /* malformed → start fresh */ }
          }
          extrasObj[fromId] = resolvedLoserValues.get(row.id) ?? null;
          const newExtras = JSON.stringify(extrasObj);
          const beforeBytes = existing.extras
            ? Buffer.byteLength(existing.extras, 'utf8')
            : 0;
          const afterBytes = Buffer.byteLength(newExtras, 'utf8');
          // The survivor's stored footprint grows by the extras delta; the
          // loser row's bytes were freed above. Keep the warehouse byte
          // accounting honest — the loser value is re-homed, not freed.
          absorbExtrasStmt.run(newExtras, afterBytes - beforeBytes, existing.id);
          preservedBytes += afterBytes - beforeBytes;
        } else {
          // No collision — rewrite the loser row onto the survivor, guarded on
          // the loser predicate so a row a concurrent rewrite already moved
          // isn't re-counted.
          const updRes = rewriteTargetStmt.run(toId, row.id, collection, fromId);
          if (updRes.changes > 0) rewritten++;
        }
      }
      // Links — typed relationships, no key collision; rewrite
      // both endpoints if they reference the loser.
      const linksRewritten = db
        .prepare(
          `UPDATE ${LINK_TABLE}
              SET from_id = ?
            WHERE from_collection = ? AND from_id = ?`,
        )
        .run(toId, collection, fromId).changes
        + db
          .prepare(
            `UPDATE ${LINK_TABLE}
                SET to_id = ?
              WHERE to_collection = ? AND to_id = ?`,
          )
          .run(toId, collection, fromId).changes;
      reportDelta(preservedBytes - freedBytes);
      return {
        annotations_rewritten: rewritten,
        annotations_collided: collided,
        links_rewritten: linksRewritten,
      };
    });
    return tx();
  };

  // ── staleness-driven eviction ─────────────────────────────────
  const evictStaleAnnotations = async (
    filter: AnnotationFilter,
    current: { source_record_hash: string; model_used?: string },
  ): Promise<number> => {
    if (!current || typeof current.source_record_hash !== 'string') {
      throw new AnnotationKeyInvalidError(
        'evictStaleAnnotations: current.source_record_hash is required',
      );
    }
    const rows = await listAnnotations({ ...filter, limit: 1000 });
    let evicted = 0;
    // ⛔ ONE TRANSACTION. The row delete and its FTS delete were two separate
    // implicit transactions, so a crash between them left an ORPHAN in the FTS
    // index — an entry for a row that no longer exists.
    //
    // ⚠ That orphan is INVISIBLE through the API and therefore accumulates
    // silently: `searchAnnotations` takes the FTS hits and joins them against
    // the annotation table (`WHERE id IN (…)`), so a dangling entry simply
    // yields no row. Nothing is wrong with any answer; the index just grows
    // forever. Worth stating precisely, because "the table and the index
    // diverge" sounds like it should produce a wrong result and does not.
    //
    // The singular `deleteAnnotation` below has always wrapped both writes
    // together; this path simply never did.
    //
    // ⚠ Safe to wrap because the body is fully synchronous: `listAnnotations`
    // is awaited BEFORE the loop, and every call inside is better-sqlite3,
    // which is sync by construction. An `await` in here would silently break
    // atomicity rather than fail.
    //
    // The statement is hoisted for the same reason as `audit-retention`:
    // re-`prepare`ing per row is pure waste. Measured on a file-backed WAL db
    // at the 1000-row pass ceiling: 66.2ms -> 31.4ms (200 rows: 10.2 -> 2.3).
    const deleteStmt = db.prepare(`DELETE FROM ${ANNOTATION_TABLE} WHERE id = ?`);
    db.transaction(() => {
      for (const row of rows) {
        const stale =
          row.source_record_hash !== current.source_record_hash
          || (row.model_used !== undefined
            && current.model_used !== undefined
            && row.model_used !== current.model_used);
        if (!stale) continue;
        // Delete by exact row id rather than re-running compileFilter so
        // we never widen the eviction beyond what the freshness check
        // approved.
        const deleted = deleteStmt.run(row._id).changes;
        if (deleted > 0) {
          ftsDeleteRecord(db, ANNOTATION_FTS_TABLE, row._id);
          evicted++;
        }
      }
    })();
    return evicted;
  };

  return {
    annotate,
    link,
    upsertLink,
    evictStaleAnnotations,
    listAnnotations,
    searchAnnotations,
    deleteAnnotations: async (filter) => deleteAnnotationsByFilter(filter),
    deleteAnnotation: async (id) => {
      const apply = db.transaction(() => {
        const row = db
          .prepare(`SELECT size_bytes FROM ${ANNOTATION_TABLE} WHERE id = ?`)
          .get(id) as { size_bytes: number } | undefined;
        if (!row) return null;
        const res = db.prepare(`DELETE FROM ${ANNOTATION_TABLE} WHERE id = ?`).run(id);
        if (res.changes === 0) return null;
        ftsDeleteRecord(db, ANNOTATION_FTS_TABLE, id);
        return row;
      });
      const row = apply.immediate();
      if (!row) return false;
      reportDelta(-row.size_bytes);
      return true;
    },
    listLinks: async (filter) => {
      const { sql, params } = compileLinkFilter(filter);
      const limit = clampLimit(filter.limit);
      const rows = db
        .prepare(
          `SELECT * FROM ${LINK_TABLE} ${sql} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...params, limit) as LinkRow[];
      return rows.map(linkFromRow);
    },
    deleteLinks: async (filter) => deleteLinksByFilter(filter),
    deleteLink: async (id) => {
      const res = db.prepare(`DELETE FROM ${LINK_TABLE} WHERE id = ?`).run(id);
      return res.changes > 0;
    },
    annotationsForRecord,
    latestAnnotationProvenance,
    outboundLinks,
    outboundLinksSync,
    inboundLinks,
    cascadeDelete,
    rewriteRecordId,
    close() { /* statements finalize on db.close() */ },
  };
};

/** Every distinct `blob_hash` referenced by an annotation row. Used by
 *  the orphan-blob sweep to compute the keep-set across all stores. */
export const listAnnotationReferencedBlobHashes = (
  db: Database.Database,
): Set<string> => {
  const rows = db
    .prepare(
      `SELECT DISTINCT blob_hash FROM ${ANNOTATION_TABLE} WHERE blob_hash IS NOT NULL`,
    )
    .all() as Array<{ blob_hash: string }>;
  return new Set(rows.map((r) => r.blob_hash));
};
