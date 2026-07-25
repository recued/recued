/** D-198 Slice 2 — the `user_memory` store.
 *
 *  The owner-authored half of the D-198 memory pool: entries the user writes
 *  themselves (`origin_actor: 'user_self'`, full CRUD). A PURPOSE-BUILT store,
 *  deliberately NOT an extension of `AuditEntry` (which is run-shaped —
 *  `trigger_url` / `instance_id` / `commit_status` / durations; injecting
 *  hand-authored rows would corrupt the audit authority). `memory.list` UNIONS
 *  these rows with the D-120 audit rows at read; this store owns only the
 *  owner-authored side ("one pool" = the read union, §2).
 *
 *  Body storage = the canonical 64 KB split (§5): a body ≤ 64 KB UTF-8 lands
 *  inline on the row; a larger body goes to a content-addressed CAS blob. A
 *  denormalized `body_preview` (+ `size_bytes`) rides every row so the feed
 *  never resolves inline/blob bytes (the large-text visual guard); the full
 *  body loads on demand via `get`.
 *
 *  ⚠ Dedicated blob store (`memory_blobs`), NOT the shared `<data>/blobs`.
 *  The eviction-cascade orphan sweep (`sweepOrphans`) keeps only cache- +
 *  shared-store refs (`listReferencedBlobHashes` / `listSharedReferencedBlobHashes`),
 *  so a memory blob living in the shared store would be reaped as an orphan the
 *  first time storage pressure fires a cache-surface sweep. An isolated store
 *  the sweep never walks is safe by construction; this store frees its own
 *  blobs on delete/replace (refcounted over the remaining rows, since two rows
 *  can content-address to one blob). The common case — an owner note ≤ 64 KB —
 *  is inline in SQLite and never touches a blob at all. (Archive/backup of the
 *  rare > 64 KB memory blob is a follow-on; inline bodies ride the DB backup.)
 *
 *  Spec: docs/d-198-spec.md §5 + docs/d-198-build-plan.md §B Slice 2. */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Actor } from '@recued/contracts';
import type { Collection } from '@recued/storage';
import {
  createFtsTable,
  indexRecord,
  deleteRecord as ftsDeleteRecord,
  search as ftsSearch,
  toFtsMatch,
} from '@recued/fts';
import type { BlobStore } from './storage/blob-store.js';

/** The `memory_id` domain prefix. Distinct from the audit `run_id` domain so a
 *  union feed / `memory.get` can route an id to the right store by inspection. */
export const USER_MEMORY_ID_PREFIX = 'umem_';

/** Canonical 64 KB inline/CAS split (mirrors `ANNOTATION_INLINE_CUTOFF_BYTES`). */
export const USER_MEMORY_INLINE_CUTOFF_BYTES = 64 * 1024;

/** Denormalized preview length (chars) stored on the row so `list` never
 *  resolves the inline/blob body. */
export const USER_MEMORY_PREVIEW_CHARS = 280;

/** A single authored memory row. `origin_actor` is the immutable D-161 identity
 *  of the writer (§3 origin-honesty): `user_self` for owner-direct `memory.create`
 *  (the union projects it as "You"), `contracted_user` for the AI / customer write
 *  path (`writeAuthored` via the store-backed `MemoryWriteAdapter`, D-198 Slice 4).
 *  Exactly one of `body_inline` / `blob_hash` is present when a body exists —
 *  neither when the entry is body-less (summary-only). */
export interface UserMemoryRow {
  /** `umem_<uuid>` — a distinct domain from the audit `run_id`. */
  memory_id: string;
  /** The immutable writer identity. Never patched by `update` (§3 rule 1). */
  origin_actor: Actor;
  kind: string;
  summary?: string;
  /** The body when ≤ 64 KB UTF-8 (XOR `blob_hash`). */
  body_inline?: string;
  /** CAS blob hash when the body is > 64 KB (XOR `body_inline`). */
  blob_hash?: string;
  /** Clamped preview for the feed row; the full body loads via `get`. */
  body_preview?: string;
  /** Total UTF-8 byte length of the body (0 when body-less). */
  size_bytes: number;
  reason_code?: string;
  /** Ingestion time — when Recued recorded the entry. */
  ts: number;
  /** Real-world event time when distinct from ingestion (bistemporal). */
  event_at?: number;
  /** Provenance edges (entity ids the memory is about). */
  provenance_entity_ids?: string[];
  /** D-198 Slice 3 — the content-dedup key for IMPORTED "other" rows only
   *  (Slice 3 `memory.import`; the D-136 `source_record_hash` precedent).
   *  Absent on owner-authored (`memory.create`) rows — dedup is import-vs-import,
   *  so it is never computed on the hot create/update path. */
  content_hash?: string;
  /** D-198 Slice 4 — the D-161 session provenance of a `writeAuthored` row (the
   *  chat session that authored it). Absent on owner-direct (`user_self`) rows. */
  channel_session_id?: string;
  /** D-198 Slice 4 — the governing contract of a `writeAuthored` row (the door /
   *  owner contract under which the AI wrote). Absent on owner-direct rows. */
  contract_id?: string;
}

export interface UserMemoryCreateInput {
  kind: string;
  summary?: string;
  /** The memory content — already coerced to a string by the caller. */
  body?: string;
  reason_code?: string;
  event_at?: number;
  provenance_entity_ids?: string[];
}

/** D-161 session provenance for a `writeAuthored` row. */
export interface UserMemorySession {
  channel_session_id?: string;
  contract_id?: string;
}

/** D-198 Slice 4 — the AI / customer write input. Extends the create shape with
 *  the (server-stamped, caller-supplied) writer origin + session provenance. The
 *  store-backed `MemoryWriteAdapter` calls this with `origin_actor:
 *  'contracted_user'`; owner-direct writes go through `create` (`user_self`). */
export interface UserMemoryAuthoredInput extends UserMemoryCreateInput {
  origin_actor: Actor;
  session?: UserMemorySession;
}

export interface UserMemoryUpdateInput {
  kind?: string;
  summary?: string;
  /** Present = replace the body (an empty string clears it); absent = leave
   *  the body unchanged. */
  body?: string;
  event_at?: number;
}

/** One entry accepted by `import` (the handler coerces the wire body to a
 *  string first). `origin_actor` drives the dedup key (§5): `'user_self'`
 *  merges by `memory_id`; any other origin content-dedups. */
export interface UserMemoryImportEntry {
  /** Drives merge-by-id for `user_self` entries; ignored for "other". */
  memory_id?: string;
  origin_actor: string;
  kind: string;
  summary?: string;
  body?: string;
  reason_code?: string;
  ts?: number;
  event_at?: number;
  provenance_entity_ids?: string[];
}

/** Per-outcome tally from `import`. */
export interface UserMemoryImportResult {
  /** `user_self` entries upserted onto an existing `memory_id`. */
  merged: number;
  /** Entries inserted as a new row. */
  inserted: number;
  /** "Other" entries skipped because their content already exists. */
  deduped: number;
  /** Entries rejected (malformed — e.g. a blank `kind`). */
  skipped: number;
}

/** A resolved entry — the row plus its full body (inline or CAS). `body` is
 *  absent when the entry is body-less or its blob has gone missing. */
export interface UserMemoryResolved {
  row: UserMemoryRow;
  body?: string;
}

export interface UserMemoryStore {
  create(input: UserMemoryCreateInput): Promise<UserMemoryRow>;
  /** D-198 Slice 4 — the AI / customer write path: mint a row stamped with the
   *  caller-supplied `origin_actor` (`contracted_user`) + session provenance.
   *  `create` is the `user_self` convenience that delegates here. */
  writeAuthored(input: UserMemoryAuthoredInput): Promise<UserMemoryRow>;
  get(memory_id: string): Promise<UserMemoryResolved | null>;
  /** The ROW only — no body resolution. `get` resolves the body (a CAS blob read
   *  for every > 64 KB memory); a caller that only needs the row's metadata
   *  (rank order, `size_bytes`, time filters) must NOT pay that. `memory.search`
   *  uses this to order + filter its hits, then `get`s bodies for the few that
   *  actually fit its byte budget. */
  getRow(memory_id: string): Promise<UserMemoryRow | null>;
  list(): Promise<UserMemoryRow[]>;
  update(memory_id: string, patch: UserMemoryUpdateInput): Promise<UserMemoryRow | null>;
  /** Hard-delete + free the body blob if no remaining row references it.
   *  Returns false when the id is unknown. */
  delete(memory_id: string): Promise<boolean>;
  /** Bulk import (§5): `user_self` entries merge-by-`memory_id` (idempotent
   *  restore of your own); "other" entries content-dedup (owner-vouched,
   *  stamped `reason_code: 'imported'`, stored `user_self`). Returns a tally. */
  import(entries: UserMemoryImportEntry[]): Promise<UserMemoryImportResult>;
  /** Free-text RECALL over the pool — the retrieval half `memory.search` was
   *  missing (it returned the N most RECENT rows and never matched anything).
   *  Matches over `summary` + the FULL body (inline AND the > 64 KB CAS half —
   *  a long product-knowledge doc must be findable by its contents, not just its
   *  title). Returns `memory_id`s in RELEVANCE order (FTS5 bm25 rank).
   *
   *  NEVER throws on a junk / unparseable query — it returns `[]`. An `ok:false`
   *  here would re-open the retry-to-timeout loop the 2026-06-09
   *  `enrichment.search` fix closed (see `docs/chat-prompt-optimization-log.md`);
   *  an empty result is a usable answer, an error is not. */
  search(query: string, limit: number): Promise<string[]>;
}

export interface UserMemoryStoreOptions {
  /** Injected clock (tests pass a fixed value). Default `Date.now`. */
  now?: () => number;
  /** Injected id minter (tests pass a deterministic sequence). Default
   *  `umem_<randomUUID>`. */
  mintId?: () => string;
  /** The raw SQLite handle, when this store is db-backed. Present on the real
   *  server (`compose-app-context`), absent in the in-memory test harnesses.
   *  When present the store maintains an FTS5 index over `summary + body` and
   *  `search` is a real ranked match; when absent `search` degrades to a
   *  linear substring scan (correct, unranked — the harness pool is tiny). */
  db?: Database.Database;
}

/** The FTS5 index over the pool. Rebuilt lazily (see `ensureIndexed`) so a pool
 *  written before the index existed becomes searchable without a boot cost. */
const USER_MEMORY_FTS_TABLE = 'user_memory_fts';

/** The searchable projection of a row: its recall line + its full body. */
const searchableText = (summary: string | undefined, body: string | undefined): string =>
  [summary ?? '', body ?? ''].join('\n');

const clampPreview = (body: string): string =>
  body.length > USER_MEMORY_PREVIEW_CHARS ? body.slice(0, USER_MEMORY_PREVIEW_CHARS) : body;

/** Content-dedup key for imported "other" rows: sha256 over the entry's text
 *  content (summary + body). Two "other" entries with the same content dedup
 *  regardless of ids — the "re-importing the same knowledge never duplicates"
 *  rule (§5, the D-136 `source_record_hash` precedent). */
const contentHash = (summary: string | undefined, body: string | undefined): string =>
  createHash('sha256').update(JSON.stringify([summary ?? '', body ?? ''])).digest('hex');

/** The body-storage columns a create/update/import resolves to. */
type BodyParts = Pick<
  UserMemoryRow,
  'body_inline' | 'blob_hash' | 'body_preview' | 'size_bytes'
>;

/** Copy the materialized body slots onto a row (never sets `undefined` keys). */
const applyBodyParts = (row: UserMemoryRow, parts: BodyParts): void => {
  if (parts.body_inline !== undefined) row.body_inline = parts.body_inline;
  if (parts.blob_hash !== undefined) row.blob_hash = parts.blob_hash;
  if (parts.body_preview !== undefined) row.body_preview = parts.body_preview;
};

export const createUserMemoryStore = (
  collection: Collection<UserMemoryRow>,
  blobs: BlobStore,
  options: UserMemoryStoreOptions = {},
): UserMemoryStore => {
  const now = options.now ?? ((): number => Date.now());
  const mintId = options.mintId ?? ((): string => `${USER_MEMORY_ID_PREFIX}${randomUUID()}`);
  const db = options.db;
  if (db) createFtsTable(db, USER_MEMORY_FTS_TABLE);

  /** Resolve a row's full body (inline OR the > 64 KB CAS blob). Shared by
   *  `get`, the FTS indexer, and the no-db fallback search — all three need the
   *  WHOLE body, not the 280-char preview. */
  const resolveBody = async (row: UserMemoryRow): Promise<string | undefined> => {
    if (row.body_inline !== undefined) return row.body_inline;
    if (row.blob_hash !== undefined) {
      const buf = await blobs.get(row.blob_hash);
      return buf === null ? undefined : buf.toString('utf8');
    }
    return undefined;
  };

  /** Index a row's searchable text. Called after EVERY row write (create /
   *  authored / update / import) so the index never drifts from the pool.
   *  No-op without a db (the in-memory harness scans instead). */
  const indexRow = (
    memory_id: string,
    summary: string | undefined,
    body: string | undefined,
  ): void => {
    if (!db) return;
    indexRecord(db, USER_MEMORY_FTS_TABLE, memory_id, searchableText(summary, body));
  };

  const unindexRow = (memory_id: string): void => {
    if (!db) return;
    ftsDeleteRecord(db, USER_MEMORY_FTS_TABLE, memory_id);
  };

  /** Lazy self-healing backfill: rows written BEFORE this index existed (every
   *  row in a pool that predates the FTS slice) are invisible to `search` until
   *  they are indexed. Rather than pay a boot-time walk, detect the empty-index-
   *  but-non-empty-pool case on the first search and backfill once. Idempotent. */
  let backfilled = false;
  const ensureIndexed = async (): Promise<void> => {
    if (!db || backfilled) return;
    backfilled = true;
    const indexed = (
      db.prepare(`SELECT count(*) AS n FROM ${USER_MEMORY_FTS_TABLE}`).get() as { n: number }
    ).n;
    if (indexed > 0) return;
    const rows = await collection.list();
    for (const row of rows) {
      indexRow(row.memory_id, row.summary, await resolveBody(row));
    }
  };

  /** Split a body across inline / CAS + compute the denormalized preview. A
   *  body-less entry (undefined / empty) carries neither inline nor blob. */
  const materializeBody = async (body: string | undefined): Promise<BodyParts> => {
    if (body === undefined || body.length === 0) return { size_bytes: 0 };
    const size_bytes = Buffer.byteLength(body, 'utf8');
    const body_preview = clampPreview(body);
    if (size_bytes > USER_MEMORY_INLINE_CUTOFF_BYTES) {
      const blob_hash = await blobs.put(Buffer.from(body, 'utf8'));
      return { blob_hash, body_preview, size_bytes };
    }
    return { body_inline: body, body_preview, size_bytes };
  };

  /** Free `hash` iff no remaining row references it. Content-addressing means
   *  two rows can share one blob, so a per-row delete must refcount before it
   *  unlinks. Best-effort — a failed unlink leaves a harmless orphan the store
   *  never re-reads (and the dedicated store keeps it off the shared sweep). */
  const freeBlobIfOrphan = async (hash: string, excludeId: string): Promise<void> => {
    const rows = await collection.list();
    const stillReferenced = rows.some(
      (r) => r.memory_id !== excludeId && r.blob_hash === hash,
    );
    if (!stillReferenced) {
      await blobs.delete(hash).catch(() => { /* swallow — the orphan is inert */ });
    }
  };

  /** The shared authored-write path (§3 origin-honesty): mint a row stamped with
   *  the caller-supplied `origin_actor` + optional session provenance. `create`
   *  delegates here with `origin_actor: 'user_self'`; the store-backed
   *  `MemoryWriteAdapter` calls it with `contracted_user`. */
  const writeAuthored = async (
    input: UserMemoryAuthoredInput,
  ): Promise<UserMemoryRow> => {
    const parts = await materializeBody(input.body);
    const row: UserMemoryRow = {
      memory_id: mintId(),
      origin_actor: input.origin_actor,
      kind: input.kind,
      ts: now(),
      size_bytes: parts.size_bytes,
    };
    if (input.summary !== undefined) row.summary = input.summary;
    applyBodyParts(row, parts);
    if (input.reason_code !== undefined) row.reason_code = input.reason_code;
    if (input.event_at !== undefined) row.event_at = input.event_at;
    if (input.provenance_entity_ids !== undefined && input.provenance_entity_ids.length > 0) {
      row.provenance_entity_ids = [...input.provenance_entity_ids];
    }
    if (input.session?.channel_session_id !== undefined) {
      row.channel_session_id = input.session.channel_session_id;
    }
    if (input.session?.contract_id !== undefined) {
      row.contract_id = input.session.contract_id;
    }
    await collection.set(row.memory_id, row);
    indexRow(row.memory_id, row.summary, input.body);
    return row;
  };

  return {
    async create(input) {
      return writeAuthored({ ...input, origin_actor: 'user_self' });
    },

    writeAuthored,

    async get(memory_id) {
      const row = await collection.get(memory_id);
      if (row === null) return null;
      const body = await resolveBody(row);
      return body === undefined ? { row } : { row, body };
    },

    async getRow(memory_id) {
      return collection.get(memory_id);
    },

    async list() {
      return collection.list();
    },

    async search(query, limit) {
      const trimmed = query.trim();
      if (trimmed.length === 0 || limit <= 0) return [];
      await ensureIndexed();
      if (db) {
        // A junk query (only punctuation / unbalanced quotes) yields no usable
        // FTS5 match expression → `[]`, NEVER a throw. See the interface note:
        // an error here re-opens the agent retry loop.
        const match = toFtsMatch(trimmed);
        if (match === null) return [];
        try {
          return ftsSearch(db, USER_MEMORY_FTS_TABLE, { query: match, limit })
            .map((hit) => hit.key);
        } catch {
          return []; // malformed FTS5 expression that slipped the sanitizer
        }
      }
      // No-db harness: linear substring scan over the resolved bodies. Correct
      // but UNRANKED (insertion order) — the in-memory pool is tiny by
      // construction, and the real server always passes `db`.
      const needle = trimmed.toLowerCase();
      const hits: string[] = [];
      for (const row of await collection.list()) {
        const text = searchableText(row.summary, await resolveBody(row));
        if (text.toLowerCase().includes(needle)) hits.push(row.memory_id);
        if (hits.length >= limit) break;
      }
      return hits;
    },

    async update(memory_id, patch) {
      const existing = await collection.get(memory_id);
      if (existing === null) return null;
      const next: UserMemoryRow = { ...existing };
      if (patch.kind !== undefined) next.kind = patch.kind;
      if (patch.summary !== undefined) next.summary = patch.summary;
      if (patch.event_at !== undefined) next.event_at = patch.event_at;

      let priorBlob: string | undefined;
      if (patch.body !== undefined) {
        priorBlob = existing.blob_hash;
        const parts = await materializeBody(patch.body);
        // Reset both body slots, then set whichever the split produced (a
        // shrink from blob → inline / empty must clear the stale `blob_hash`).
        delete next.body_inline;
        delete next.blob_hash;
        delete next.body_preview;
        next.size_bytes = parts.size_bytes;
        if (parts.body_inline !== undefined) next.body_inline = parts.body_inline;
        if (parts.blob_hash !== undefined) next.blob_hash = parts.blob_hash;
        if (parts.body_preview !== undefined) next.body_preview = parts.body_preview;
      }

      await collection.set(memory_id, next);
      // Re-index over the NEXT row. A summary-only patch leaves the body
      // untouched, so resolve it back off the row rather than dropping it from
      // the index (the body is most of the searchable text).
      indexRow(
        memory_id,
        next.summary,
        patch.body !== undefined ? patch.body : await resolveBody(next),
      );
      // Free the prior blob AFTER the new row lands (so the refcount scan sees
      // the row's new hash) and only when the body moved off it.
      if (priorBlob !== undefined && priorBlob !== next.blob_hash) {
        await freeBlobIfOrphan(priorBlob, memory_id);
      }
      return next;
    },

    async delete(memory_id) {
      const existing = await collection.get(memory_id);
      if (existing === null) return false;
      await collection.delete(memory_id);
      unindexRow(memory_id);
      if (existing.blob_hash !== undefined) {
        await freeBlobIfOrphan(existing.blob_hash, memory_id);
      }
      return true;
    },

    async import(entries) {
      const existing = await collection.list();
      const byId = new Map(existing.map((r) => [r.memory_id, r] as const));
      const seenHashes = new Set<string>();
      for (const r of existing) if (r.content_hash !== undefined) seenHashes.add(r.content_hash);

      let merged = 0;
      let inserted = 0;
      let deduped = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (typeof entry.kind !== 'string' || entry.kind.trim().length === 0) {
          skipped += 1;
          continue;
        }

        if (entry.origin_actor === 'user_self') {
          // Merge-by-id: a valid `umem_` id upserts (idempotent restore); a
          // missing / foreign id mints a fresh one (keeps the domain invariant).
          const id =
            typeof entry.memory_id === 'string' && entry.memory_id.startsWith(USER_MEMORY_ID_PREFIX)
              ? entry.memory_id
              : mintId();
          const prior = byId.get(id);
          const parts = await materializeBody(entry.body);
          const row: UserMemoryRow = {
            memory_id: id,
            origin_actor: 'user_self',
            kind: entry.kind,
            ts: entry.ts ?? now(),
            size_bytes: parts.size_bytes,
          };
          if (entry.summary !== undefined) row.summary = entry.summary;
          applyBodyParts(row, parts);
          if (entry.reason_code !== undefined) row.reason_code = entry.reason_code;
          if (entry.event_at !== undefined) row.event_at = entry.event_at;
          if (entry.provenance_entity_ids !== undefined && entry.provenance_entity_ids.length > 0) {
            row.provenance_entity_ids = [...entry.provenance_entity_ids];
          }
          await collection.set(id, row);
          indexRow(id, row.summary, entry.body);
          byId.set(id, row);
          if (prior !== undefined) {
            merged += 1;
            if (prior.blob_hash !== undefined && prior.blob_hash !== row.blob_hash) {
              await freeBlobIfOrphan(prior.blob_hash, id);
            }
          } else {
            inserted += 1;
          }
          continue;
        }

        // "Other" (non-`user_self`): content-dedup, then store owner-VOUCHED
        // (origin `user_self`, `reason_code: 'imported'` so it never masquerades
        // as engine-authored on this server, §5). The `content_hash` rides the
        // row as the dedup key.
        const hash = contentHash(entry.summary, entry.body);
        if (seenHashes.has(hash)) {
          deduped += 1;
          continue;
        }
        const id = mintId();
        const parts = await materializeBody(entry.body);
        const row: UserMemoryRow = {
          memory_id: id,
          origin_actor: 'user_self',
          kind: entry.kind,
          ts: entry.ts ?? now(),
          size_bytes: parts.size_bytes,
          reason_code: 'imported',
          content_hash: hash,
        };
        if (entry.summary !== undefined) row.summary = entry.summary;
        applyBodyParts(row, parts);
        if (entry.event_at !== undefined) row.event_at = entry.event_at;
        if (entry.provenance_entity_ids !== undefined && entry.provenance_entity_ids.length > 0) {
          row.provenance_entity_ids = [...entry.provenance_entity_ids];
        }
        await collection.set(id, row);
        indexRow(id, row.summary, entry.body);
        seenHashes.add(hash);
        byId.set(id, row);
        inserted += 1;
      }

      return { merged, inserted, deduped, skipped };
    },
  };
};

/** Every distinct `blob_hash` referenced by a `user_memory` row's body
 *  (blob-encryption fix Phase 4). Memory > 64 KB bodies live in the ENCRYPTED
 *  `<data>/memory_blobs` root; the archive export bundles exactly these so the
 *  restore never references a memory blob absent from the archive. The generic
 *  collection stores each row as `(key, data)` JSON, so `blob_hash` is read via
 *  `json_extract` (not a scannable column). Mirrors the sibling readers
 *  (cache / shared / annotation); a missing table is caught by the caller. */
export const listMemoryReferencedBlobHashes = (
  db: Database.Database,
): Set<string> => {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(data, '$.blob_hash') AS blob_hash
         FROM user_memory
        WHERE json_extract(data, '$.blob_hash') IS NOT NULL`,
    )
    .all() as Array<{ blob_hash: string }>;
  return new Set(rows.map((r) => r.blob_hash));
};
