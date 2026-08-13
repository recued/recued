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
 *  Spec: D-198 §5 + D-198 §B Slice 2. */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Actor } from '@recued/contracts';
import { isFieldQueryable, isOrderedWindowQueryable, type Collection } from '@recued/storage';
import {
  createFtsTable,
  indexRecord,
  deleteRecord as ftsDeleteRecord,
  search as ftsSearch,
  toFtsMatchLadder,
  tokenizeFtsQuery,
  type FtsMatchRung,
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
  /** ⛔ A BOUNDED PAGE OF THE FEED, newest-effective-time first.
   *
   *  `list()` returns the WHOLE store, and `memory.list` unions it with the
   *  whole audit log to render one 50-row page. That was defensible while this
   *  store was small; D-230 then left it with NO QUOTA (owner knowledge is never
   *  pruned) and D-231 made it recipe-writable — so "small" is now an assumption
   *  with nothing holding it up.
   *
   *  Ordered `COALESCE(event_at, ts) DESC, memory_id DESC` — the same total
   *  order the feed sorts by, so a keyset cursor is exact. */
  listWindow(query: {
    limit: number;
    before?: { ts: number; id: string };
  }): Promise<UserMemoryRow[]>;
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
   *  ⚠ RELAXES a query that matches nothing exactly, via `toFtsMatchLadder`:
   *  all-words AND → content-words AND → content-words OR, answering with the
   *  FIRST rung that returns rows. Stopping there is what preserves precision —
   *  an exact match is never diluted by the looser rungs beneath it, so every
   *  query that matched before the ladder existed still returns exactly its old
   *  result set. Only a previously-EMPTY answer can change. Without this a whole
   *  natural-language question ("What is your refund policy?") matches nothing,
   *  because FTS5 joins terms with an implicit AND and the entry does not
   *  contain "what" / "is" / "your" — see the ladder's own note.
   *
   *  Reports WHICH rung answered (`match`) and each hit's bm25 `rank`, so the
   *  caller can tell an exact hit from the best of a weak field. Both were
   *  computed and discarded before — the ladder always knew, and `Promise<
   *  string[]>` threw it away, leaving a rung-3 top-1 and a rung-1 top-1
   *  indistinguishable to the model reading the result.
   *
   *  NEVER throws on a junk / unparseable query — it returns no hits. An
   *  `ok:false` here would re-open the retry-to-timeout loop the 2026-06-09
   *  `enrichment.search` fix closed (see internal design notes);
   *  an empty result is a usable answer, an error is not. */
  search(query: string, limit: number): Promise<MemorySearchResult>;

  /** RUNG 4 — nearest neighbours by MEANING, for the case the lexical ladder
   *  cannot reach: a query sharing NO token with its answer ("How do I turn on
   *  2FA?" against "How do I enable two-factor authentication?"), which matches
   *  at no rung and returns `match: undefined`.
   *
   *  Cohort-enforced: only rows embedded with `model` are scanned, because
   *  vectors from different models are not comparable and mixing them returns
   *  confident nonsense rather than an error. Brute-force cosine, no ANN — the
   *  owner pool is small, and `mcp/vector-similarity.ts` already scans this way.
   *
   *  Hits carry `rank = -similarity` so they share the bm25 convention (a COST,
   *  more negative is better) and flow through the same ordering + `top_margin`
   *  maths as every other rung. No db / no vectors ⇒ no hits. */
  semanticSearch(
    query: { vector: number[]; model: string },
    limit: number,
    threshold?: number,
  ): MemorySearchHit[];

  /** Store one entry's vector. Overwrites; no-op without a db. */
  putVector(memory_id: string, embedding: { vector: number[]; model: string }): void;

  /** How much of the pool is actually embedded, and under which cohort.
   *
   *  ⛔ RUNG 4 MUST CONSULT THIS BEFORE REPORTING AN EMPTY. An unembedded pool
   *  and a pool with no semantic neighbour produce the same zero rows, and
   *  telling the agent "nothing matches" when the truth is "nothing was ever
   *  embedded" is the absence-reads-as-an-answer failure this codebase keeps
   *  paying for. `model` is the dominant cohort — the one to embed queries with.
   *
   *  ⚠ Deliberately does NOT report pool size. The only question it answers is
   *  "is semantic recall possible at all", and counting the pool would mean
   *  either an async signature or a `list()` that loads every inline body — a
   *  real cost for a field nothing needs. */
  vectorCoverage(): { embedded: number; model?: string };

  /** Embed every entry that has no current vector, oldest first, up to `limit`.
   *  RESUMABLE by construction (it re-reads what is missing each call) so a
   *  quota stop or a crash loses only the in-flight entry. Per-entry failures
   *  are counted, never thrown — one bad row must not abandon the backlog. */
  embedBacklog(
    embed: MemoryEmbedder,
    opts?: { limit?: number },
  ): Promise<{ embedded: number; failed: number; remaining: number }>;
}

/** Turn text into a vector. Provider-agnostic by design: the composition root
 *  binds it to the `ai-embed` kernel ingredient, tests bind a deterministic
 *  fake, and an absent binding simply turns rung 4 off. */
export type MemoryEmbedder = (
  text: string,
) => Promise<{ vector: number[]; model: string }>;

/** One ranked recall hit. */
export interface MemorySearchHit {
  memory_id: string;
  /** FTS5 bm25 `rank`. ⚠ A COST, NOT A SCORE — more negative is better, and
   *  the list is ordered ascending. `null` on the no-db harness, which matches
   *  by substring and cannot rank. */
  rank: number | null;
}

/** How the hits were found. The three lexical rungs come from the FTS ladder;
 *  `'semantic'` is rung 4 and is deliberately NOT an `FtsMatchRung` — it shares
 *  no machinery with the ladder and lives at the memory layer, where the
 *  vectors do. Widening `FtsMatchRung` instead would put an embedding concept
 *  inside a package that only knows about SQLite full-text. */
export type MemoryMatchKind = FtsMatchRung | 'semantic';

export interface MemorySearchResult {
  /** Relevance order (most relevant first). */
  hits: MemorySearchHit[];
  /** How the hits were found. Absent when nothing matched at any rung — there
   *  is no match quality to report about an empty result. */
  match?: MemoryMatchKind;
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
   *  linear substring scan over the same relaxation rungs (correct, unranked —
   *  the harness pool is tiny). */
  db?: Database.Database;
}

/** The FTS5 index over the pool. Rebuilt lazily (see `ensureIndexed`) so a pool
 *  written before the index existed becomes searchable without a boot cost. */
const USER_MEMORY_FTS_TABLE = 'user_memory_fts';

/** ⚠ PORTER-STEMMED, unlike every other index in this codebase.
 *
 *  The pool holds owner-curated PROSE — product Q&A, policies, notes — queried
 *  in the words a person happens to use, so `cancel` must find "cancelled" and
 *  `billing` must find "bill". FTS5's default `unicode61` does no stemming at
 *  all, which made those three separate, non-matching terms. Measured on a
 *  3-entry Q&A pool, this declaration newly matches `cancel`, `cancelling`,
 *  `cancellation`, `bill`, `issue` and `running` and LOSES nothing: stemming
 *  merges terms, so `stem(t) === stem(q)` holds wherever `t === q` did.
 *
 *  `remove_diacritics 2` follows `contact-store.ts` — the other index over text
 *  a human typed — rather than FTS5's default of 1.
 *
 *  ⛔ CHANGING THIS STRING RE-INDEXES EVERY POOL ON EVERY SERVER. `createFtsTable`
 *  compares it against the recorded declaration and drops a mismatched index;
 *  the reindex below then walks the whole pool, resolving every CAS body. That
 *  is correct and one-time, but it is not free — do not tune it casually. */
export const USER_MEMORY_FTS_TOKENIZER = 'porter unicode61 remove_diacritics 2';

/** RUNG 4's sidecar — one embedding per entry, beside the FTS index rather than
 *  in `data_enrichment`'s vector index.
 *
 *  ⚠ WHY LOCAL AND NOT AN ENRICHMENT TOPIC. `EnrichmentScope` has no `memory`
 *  arm, and adding one means the arm across its three hand-copies, a source
 *  walker, a registry topic and a producer — a multi-commit arc through a
 *  closed vocabulary 46 files reference. This store already owns a sidecar of
 *  exactly this shape (`user_memory_fts`) with create / migrate / index /
 *  unindex / backfill machinery to be symmetric with. The Float32 packing below
 *  is byte-identical to `data_enrichment_vector_index`'s, so promoting this to
 *  a real enrichment topic later is a data move, not a re-encode.
 *
 *  `model` is stored per row and enforced at query time: cross-model vectors
 *  are not comparable, and mixing cohorts silently returns nonsense neighbours
 *  rather than an error. */
const USER_MEMORY_VEC_TABLE = 'user_memory_vec';

const createVectorTable = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${USER_MEMORY_VEC_TABLE} (
      memory_id TEXT PRIMARY KEY,
      model     TEXT NOT NULL,
      dims      INTEGER NOT NULL,
      vec       BLOB NOT NULL
    )
  `);
};

/** Pack a `number[]` as Float32 — the same encoding the enrichment vector index
 *  uses, so the two are interchangeable. `Float32Array.from` surfaces a
 *  non-finite value as NaN rather than silently truncating it. */
const packVector = (vector: number[]): Buffer => {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

/** Unpack, refusing anything that is not a whole number of Float32s (corrupt,
 *  or written by something that is not this encoder). */
const unpackVector = (buf: Buffer): Float32Array | null => {
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
};

/** Cosine similarity. ⚠ Computed in full rather than assuming unit vectors —
 *  most providers normalize, `text-embedding-3-*` with a custom `dimensions`
 *  does not, and an un-normalized pair silently ranks by magnitude instead of
 *  direction. Dimension mismatch returns null (the cohort filter should prevent
 *  it; this is the defensive second gate). */
const cosine = (a: Float32Array, b: Float32Array): number | null => {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(sim) ? sim : null;
};

/** The searchable projection of a row: its recall line + its full body. */
const searchableText = (summary: string | undefined, body: string | undefined): string =>
  [summary ?? '', body ?? ''].join('\n');

const clampPreview = (body: string): string =>
  body.length > USER_MEMORY_PREVIEW_CHARS ? body.slice(0, USER_MEMORY_PREVIEW_CHARS) : body;

/** The substring analogue of `toFtsMatchLadder`'s rungs — same relaxation, same
 *  order, `includes` instead of FTS5. The no-db harness walks these so a test
 *  written against it describes the store that actually ships; a harness that
 *  relaxed differently would certify nothing about the real search path. */
const substringLadder = (
  query: string,
): Array<{ kind: FtsMatchRung; matches: (text: string) => boolean }> => {
  const { all, content } = tokenizeFtsQuery(query);
  if (all.length === 0) return [];
  const rungs: Array<{ kind: FtsMatchRung; matches: (text: string) => boolean }> = [
    { kind: 'exact', matches: (text) => all.every((t) => text.includes(t)) },
  ];
  if (content.length > 0 && content.length < all.length) {
    rungs.push({ kind: 'relaxed', matches: (text) => content.every((t) => text.includes(t)) });
  }
  if (content.length > 1) {
    rungs.push({ kind: 'loose', matches: (text) => content.some((t) => text.includes(t)) });
  }
  return rungs;
};

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
  // `migrated` = an index existed under a DIFFERENT tokenizer and was dropped.
  // It is load-bearing, not informational — see `ensureIndexed`.
  const migrated =
    db !== undefined
    && createFtsTable(db, USER_MEMORY_FTS_TABLE, {
      tokenizer: USER_MEMORY_FTS_TOKENIZER,
    }).migrated;
  if (db) createVectorTable(db);

  /** D-230 + D-231 made the orphan check O(total memories) matter.
   *
   *  ⛔ WHY THIS INDEX EXISTS NOW AND DID NOT BEFORE. `freeBlobIfOrphan` runs
   *  on every delete/update that frees a blob, and it used to answer "is this
   *  hash still referenced?" by `list()`-ing the WHOLE table and filtering in
   *  JS. That was defensible while this store was small and unreachable from
   *  recipes. Two changes on 2026-08-04 removed both premises: D-230 left
   *  `user_memory` with NO quota (owner-authored knowledge is never pruned), and
   *  D-231 made it recipe-reachable through `data.memory.*`. Measured on a
   *  file-backed WAL db, one orphan check:
   *      5k memories  3.41ms -> 0.006ms | 50k 40.6ms -> 0.008ms
   *    500k memories  559.85ms -> 0.007ms  (76,000x, and FLAT)
   *
   *  ⚠ Feature-detected, so the in-memory collection that backs tests keeps
   *  working through the `list()` fallback below. */
  const queryable = isFieldQueryable(collection) ? collection : undefined;
  queryable?.ensureFieldIndexes(['blob_hash']);

  /** The feed's ordering index. Same feature-detect, same reason: the in-memory
   *  collection keeps working through the sort-in-JS fallback in `listWindow`. */
  const windowQueryable = isOrderedWindowQueryable(collection) ? collection : undefined;
  windowQueryable?.ensureWindowIndex({
    tsPath: 'event_at', tsFallbackPath: 'ts', idPath: 'memory_id',
  });

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
    dropVector(memory_id);
  };

  const unindexRow = (memory_id: string): void => {
    if (!db) return;
    ftsDeleteRecord(db, USER_MEMORY_FTS_TABLE, memory_id);
    dropVector(memory_id);
  };

  /** ⛔ ANY WRITE DROPS THE VECTOR. A summary-only patch still changes the
   *  embedded text, and there is no cheap way to know whether the meaning
   *  moved — so the row leaves the embedded set until the backlog re-embeds it.
   *  ABSENT BEATS STALE: a missing vector costs one recall miss that
   *  `vectorCoverage` can explain, while a stale one silently answers the
   *  question the entry used to answer. */
  const dropVector = (memory_id: string): void => {
    if (!db) return;
    db.prepare(`DELETE FROM ${USER_MEMORY_VEC_TABLE} WHERE memory_id = ?`).run(memory_id);
  };

  /** The no-db fallback's corpus: every row's searchable text, lowercased. Only
   *  the harness path pays this walk — the real server has the FTS5 index. */
  const scanCorpus = async (): Promise<Array<{ id: string; text: string }>> => {
    const out: Array<{ id: string; text: string }> = [];
    for (const row of await collection.list()) {
      out.push({
        id: row.memory_id,
        text: searchableText(row.summary, await resolveBody(row)).toLowerCase(),
      });
    }
    return out;
  };

  /** Lazy self-healing backfill: rows written BEFORE this index existed (every
   *  row in a pool that predates the FTS slice) are invisible to `search` until
   *  they are indexed. Rather than pay a boot-time walk, detect the empty-index-
   *  but-non-empty-pool case on the first search and backfill once. Idempotent
   *  (`indexRow` deletes-then-inserts), so re-indexing a live row is safe.
   *
   *  ⛔ A TOKENIZER MIGRATION SKIPS THE EMPTY-INDEX HEURISTIC. The `indexed > 0`
   *  guard asks "has anything been indexed yet", which answers the pre-FTS case
   *  but is WRONG after a migration dropped a populated index: any write landing
   *  between construction and the first search re-populates the index with ONE
   *  row, the guard then reads a non-empty index and returns early, and the rest
   *  of the pool stays permanently unsearchable. A dropped index owes a FULL
   *  rebuild regardless of what has been written since. */
  let backfilled = false;
  const ensureIndexed = async (): Promise<void> => {
    if (!db || backfilled) return;
    backfilled = true;
    if (!migrated) {
      const indexed = (
        db.prepare(`SELECT count(*) AS n FROM ${USER_MEMORY_FTS_TABLE}`).get() as { n: number }
      ).n;
      if (indexed > 0) return;
    }
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
    // Bounded by rows SHARING the hash (normally 0 or 1), not by the store.
    // The `excludeId` filter is kept on both paths: callers invoke this both
    // before and after the owning row goes, so "any OTHER row references it"
    // is the semantic, not "any row".
    const rows = queryable
      ? await queryable.queryByField({ equals: { blob_hash: hash } })
      : await collection.list();
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

    async listWindow({ limit, before }) {
      if (limit <= 0) return [];
      if (windowQueryable !== undefined) {
        return windowQueryable.listWindowDesc({
          tsPath: 'event_at',
          tsFallbackPath: 'ts',
          idPath: 'memory_id',
          limit,
          ...(before ? { before } : {}),
        });
      }
      // In-memory harness: same order, same cursor, no SQL.
      const eff = (r: UserMemoryRow): number => r.event_at ?? r.ts;
      const ordered = (await collection.list()).sort((a, b) =>
        (eff(b) - eff(a))
        || (a.memory_id < b.memory_id ? 1 : a.memory_id > b.memory_id ? -1 : 0));
      const after = before === undefined
        ? ordered
        : ordered.filter((r) => (eff(r) !== before.ts
          ? eff(r) < before.ts
          : r.memory_id < before.id));
      return after.slice(0, limit);
    },

    async search(query, limit) {
      const trimmed = query.trim();
      if (trimmed.length === 0 || limit <= 0) return { hits: [] };
      await ensureIndexed();
      if (db) {
        // Answer with the FIRST rung that matches — exact before relaxed, so a
        // precise hit is never diluted by the looser rungs below it — and
        // report WHICH one answered.
        //
        // A junk query (only punctuation / unbalanced quotes) yields NO rungs →
        // no hits, never a throw; and a rung FTS5 still refuses is skipped
        // rather than thrown. See the interface note: an error here re-opens
        // the agent retry loop.
        for (const rung of toFtsMatchLadder(trimmed)) {
          try {
            const found = ftsSearch(db, USER_MEMORY_FTS_TABLE, { query: rung.match, limit });
            if (found.length > 0) {
              return {
                hits: found.map((hit) => ({ memory_id: hit.key, rank: hit.rank })),
                match: rung.kind,
              };
            }
          } catch {
            /* malformed FTS5 expression that slipped the builder — next rung */
          }
        }
        return { hits: [] };
      }
      // No-db harness: the SAME rungs, matched by substring over the resolved
      // bodies. Correct but UNRANKED (`rank: null`, insertion order) — the
      // in-memory pool is tiny by construction, and the real server always
      // passes `db`.
      const corpus = await scanCorpus();
      for (const rung of substringLadder(trimmed)) {
        const found = corpus.filter((r) => rung.matches(r.text)).slice(0, limit);
        if (found.length > 0) {
          return {
            hits: found.map((r) => ({ memory_id: r.id, rank: null })),
            match: rung.kind,
          };
        }
      }
      return { hits: [] };
    },

    putVector(memory_id, embedding) {
      if (!db || embedding.vector.length === 0) return;
      db.prepare(
        `INSERT INTO ${USER_MEMORY_VEC_TABLE} (memory_id, model, dims, vec)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model,
                                              dims  = excluded.dims,
                                              vec   = excluded.vec`,
      ).run(memory_id, embedding.model, embedding.vector.length, packVector(embedding.vector));
    },

    vectorCoverage() {
      if (!db) return { embedded: 0 };
      // The dominant cohort — queries must be embedded with the SAME model, so
      // a pool split across models reports the one worth comparing against.
      const top = db
        .prepare(
          `SELECT model, count(*) AS n FROM ${USER_MEMORY_VEC_TABLE}
            GROUP BY model ORDER BY n DESC LIMIT 1`,
        )
        .get() as { model: string; n: number } | undefined;
      return top === undefined ? { embedded: 0 } : { embedded: top.n, model: top.model };
    },

    semanticSearch(query, limit, threshold = 0.5) {
      if (!db || limit <= 0 || query.vector.length === 0) return [];
      const probe = Float32Array.from(query.vector);
      const rows = db
        .prepare(
          `SELECT memory_id, vec FROM ${USER_MEMORY_VEC_TABLE}
            WHERE model = ? AND dims = ?`,
        )
        .all(query.model, query.vector.length) as Array<{ memory_id: string; vec: Buffer }>;

      const scored: MemorySearchHit[] = [];
      for (const row of rows) {
        const vec = unpackVector(row.vec);
        if (vec === null) continue; // corrupt row — skip, never throw
        const sim = cosine(probe, vec);
        if (sim === null || sim < threshold) continue;
        // Negated so `rank` keeps its bm25 meaning (a cost) and `top_margin`
        // needs no per-rung special case.
        scored.push({ memory_id: row.memory_id, rank: -sim });
      }
      scored.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      return scored.slice(0, limit);
    },

    async embedBacklog(embed, opts = {}) {
      if (!db) return { embedded: 0, failed: 0, remaining: 0 };
      const limit = Math.max(1, opts.limit ?? 100);
      const all = await collection.list();
      const has = new Set(
        (
          db.prepare(`SELECT memory_id FROM ${USER_MEMORY_VEC_TABLE}`).all() as Array<{
            memory_id: string;
          }>
        ).map((r) => r.memory_id),
      );
      // Oldest first so a repeatedly-interrupted backlog still converges
      // instead of re-attempting the same head every run.
      const missing = all
        .filter((r) => !has.has(r.memory_id))
        .sort((a, b) => a.ts - b.ts);

      let embedded = 0;
      let failed = 0;
      for (const row of missing.slice(0, limit)) {
        const text = searchableText(row.summary, await resolveBody(row)).trim();
        if (text.length === 0) continue; // nothing to embed; not a failure
        try {
          const result = await embed(text);
          if (result.vector.length === 0) { failed += 1; continue; }
          this.putVector(row.memory_id, result);
          embedded += 1;
        } catch {
          // Per-entry failure — quota, timeout, a body that upsets the
          // provider. Counted and stepped over: one bad row must not abandon
          // the backlog, and the next call retries it.
          failed += 1;
        }
      }
      return { embedded, failed, remaining: Math.max(0, missing.length - embedded) };
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
