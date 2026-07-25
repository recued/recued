/** D-192 file SOURCE family — the `file_meta_ref` meta-store.
 *
 *  An own-table `SourceMirrorStore` over remote file metadata. Sync writes no
 *  bodies; explicit reads resolve remote bytes through a separate bounded
 *  path and do not persist them here. Cloned from `crm-record-mirror-store.ts`
 *  (the only own-table mirror) and following its conventions verbatim:
 *   - PK `(scope, target_id)`; the file fields live INSIDE a `meta` JSON
 *     blob (not columns) — filtered via `json_extract`;
 *   - the snapshot hash lives at `meta.$.snapshot_hash`, so
 *     `listSnapshotHashes` is a `json_extract`-only read (no deserialize);
 *   - `upsert` preserves first-seen `created_at` on conflict, touching only
 *     `meta` + `updated_at`, and is dumb — the hash is stamped upstream by
 *     {@link buildFileMetaSnapshot}, never computed here.
 *
 *  `scope` = the file Source id (e.g. `dropbox.<conn>.file`, a
 *  `CONNECTION_SOURCE_ID`); `target_id` = the vendor's remote file id
 *  (== `meta.remote_id`). Design: D-192. */

import type Database from 'better-sqlite3';

import { type FileMetaProjection, validateFileMetaProjection } from '@recued/contracts';

import { hashCanonical } from '../source-mirror/hash.js';
import type { SourceMirrorStore } from '../source-mirror/store.js';

export const FILE_META_TABLE = 'file_meta_ref';

const FILE_META_DEFAULT_LIMIT = 50;
const FILE_META_MAX_LIMIT = 200;
/** Defensive cap on the serialized `meta` blob (matches the CRM mirror's
 *  8 KB convention). Unreachable via a valid projection — every field is
 *  individually capped in `validateFileMetaProjection` — so this is a
 *  corruption backstop, not a functional limit. */
const FILE_META_SNAPSHOT_MAX_BYTES = 8192;

/** The stored `meta` blob — the canonical projection plus the snapshot
 *  stamp. `snapshot_hash` is the incremental-skip key `listSnapshotHashes`
 *  reads; `snapshot_at` is ingestion time (NOT hashed — a re-poll that
 *  changes nothing must not churn the mirror). */
export interface FileMetaSnapshot extends FileMetaProjection {
  snapshot_hash: string;
  snapshot_at: number;
}

export interface FileMetaRow {
  scope: string;
  target_id: string;
  meta: FileMetaSnapshot;
}

export interface FileMetaListOptions {
  limit?: number;
  name_contains?: string;
  path_prefix?: string;
  mime_exact?: string;
  owner_exact?: string;
}

export type FileMetaStore = SourceMirrorStore<
  string,
  FileMetaSnapshot,
  FileMetaRow,
  FileMetaListOptions
> & {
  /** `target_id` → stored canonical `path` for every mirror row in a scope
   *  (a `json_extract('$.path')`-only read, like {@link FileMetaStore.listSnapshotHashes}).
   *  The D-192 slice-6 reconciler uses it to bound an `import_scope`d delete
   *  diff to rows whose STORED path is under the walked prefix — the ONLY way
   *  to fail-close deletes for an OPAQUE-key vendor (Dropbox `id`), where the
   *  key can't be prefix-tested. A row with no stored path is omitted (never a
   *  delete candidate under a scope). */
  listSourcePaths(scope: string): Map<string, string>;
  /** Fetch ONE mirror row by its `(scope, target_id)` primary key, or `null`.
   *  The by-id read the D-192 Fork B `data.file.*` resolver uses to hydrate a
   *  single remote-file view (from a `file:remote:<scope>:<target>` record id). */
  get(scope: string, target_id: string): FileMetaRow | null;
  /** CROSS-SCOPE needle search over the whole table (every enrolled file
   *  Source) — the Fork B read resolver's global picker feed. Matches the
   *  needle as a substring of `filename` OR `path` (the mirror-search picker
   *  semantics), newest-first, capped. A blank needle returns `[]` (the picker
   *  fires per-keystroke; an empty query has nothing to match). (`list` stays
   *  per-scope + AND-filtered; a global picker needs to span Sources + OR.) */
  searchAll(needle: string, limit: number): FileMetaRow[];
};

export class FileMetaSnapshotTooLargeError extends Error {
  constructor(bytes: number) {
    super(`file meta snapshot ${bytes} bytes exceeds the ${FILE_META_SNAPSHOT_MAX_BYTES} byte cap`);
    this.name = 'FileMetaSnapshotTooLargeError';
  }
}

/** Escape the LIKE metacharacters in a user-supplied filter so they match
 *  literally (paired with `ESCAPE '\'` in the query). */
const escapeLikeWildcards = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const serializeFileMeta = (meta: FileMetaSnapshot): string => {
  const s = JSON.stringify(meta);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes > FILE_META_SNAPSHOT_MAX_BYTES) throw new FileMetaSnapshotTooLargeError(bytes);
  return s;
};

const deserializeFileMeta = (s: string): FileMetaSnapshot => JSON.parse(s) as FileMetaSnapshot;

/** The declared projection keys — the ONLY fields that contribute to the
 *  stored snapshot + its hash. Picking them (rather than spreading the whole
 *  input) drops any extra key a caller may carry in — e.g. a round-tripped
 *  `FileMetaSnapshot`'s own `snapshot_at` / `snapshot_hash` — so the hash
 *  stays a pure function of the canonical projection and can never be
 *  perturbed by noise. */
const FILE_META_PROJECTION_KEYS = [
  'filename',
  'path',
  'mime_type',
  'size',
  'mtime',
  'owner',
  'revision',
  'provider',
  'remote_id',
] as const;

const pickCanonicalProjection = (p: FileMetaProjection): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of FILE_META_PROJECTION_KEYS) {
    const v = p[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
};

/** Stamp a validated canonical projection into a stored snapshot. The
 *  `snapshot_hash` is computed over the canonical projection ONLY (the
 *  declared keys — not `snapshot_at`, and not any extra input key), so a
 *  re-poll whose file metadata is unchanged produces an identical hash and
 *  the reconciler skips it. Throws on an invalid projection (fail-closed —
 *  a malformed vendor row never lands a mirror row). */
export const buildFileMetaSnapshot = (
  projection: FileMetaProjection,
  now: number,
): FileMetaSnapshot => {
  const errs = validateFileMetaProjection(projection);
  if (errs.length > 0) {
    throw new Error(`invalid file meta projection: ${errs.join('; ')}`);
  }
  const canonical = pickCanonicalProjection(projection);
  return {
    ...canonical,
    snapshot_at: now,
    snapshot_hash: hashCanonical(canonical),
  } as FileMetaSnapshot;
};

/** Create the `file_meta_ref` table. Idempotent; must run before
 *  {@link createFileMetaStore} (the factory only prepares statements). */
export const ensureFileMetaSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FILE_META_TABLE} (
      scope       TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      meta        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (scope, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_${FILE_META_TABLE}_scope_updated
      ON ${FILE_META_TABLE} (scope, updated_at DESC);
  `);
};

export const createFileMetaStore = (db: Database.Database): FileMetaStore => {
  const upsertStmt = db.prepare(`
    INSERT INTO ${FILE_META_TABLE} (scope, target_id, meta, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (scope, target_id) DO UPDATE SET
      meta = excluded.meta,
      updated_at = excluded.updated_at
  `);
  const hashesStmt = db.prepare(
    `SELECT target_id, json_extract(meta, '$.snapshot_hash') AS h
       FROM ${FILE_META_TABLE} WHERE scope = ?`,
  );
  const pathsStmt = db.prepare(
    `SELECT target_id, json_extract(meta, '$.path') AS p
       FROM ${FILE_META_TABLE} WHERE scope = ?`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM ${FILE_META_TABLE} WHERE scope = ? AND target_id = ?`,
  );
  const deleteAllStmt = db.prepare(`DELETE FROM ${FILE_META_TABLE} WHERE scope = ?`);
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${FILE_META_TABLE} WHERE scope = ?`,
  );
  const getStmt = db.prepare(
    `SELECT scope, target_id, meta FROM ${FILE_META_TABLE} WHERE scope = ? AND target_id = ?`,
  );
  const searchAllStmt = db.prepare(
    // Order by the EVENT key (vendor mtime, falling back to the ingestion
    // stamp) — NOT `updated_at` — so the pre-`LIMIT` cut keeps the newest-by-
    // event rows, matching the Fork B resolver's `event_at` merge sort. Capping
    // by `updated_at` here would let the resolver's later sort drop a newer-by-
    // event match that a stale-updated row displaced.
    `SELECT scope, target_id, meta FROM ${FILE_META_TABLE}
       WHERE json_extract(meta, '$.filename') LIKE ? ESCAPE '\\'
          OR json_extract(meta, '$.path') LIKE ? ESCAPE '\\'
       ORDER BY COALESCE(json_extract(meta, '$.mtime'), json_extract(meta, '$.snapshot_at')) DESC
       LIMIT ?`,
  );

  const upsert: FileMetaStore['upsert'] = ({ scope, target_id, meta, now }) => {
    upsertStmt.run(scope, target_id, serializeFileMeta(meta), now, now);
  };

  const get: FileMetaStore['get'] = (scope, target_id) => {
    const row = getStmt.get(scope, target_id) as
      | { scope: string; target_id: string; meta: string }
      | undefined;
    return row
      ? { scope: row.scope, target_id: row.target_id, meta: deserializeFileMeta(row.meta) }
      : null;
  };

  const searchAll: FileMetaStore['searchAll'] = (needle, limit) => {
    const trimmed = needle.trim();
    if (trimmed.length === 0) return [];
    // Guard a non-finite limit (NaN / ±Infinity survive Math.trunc/max/min) —
    // fall back to the default; clamp to the table cap.
    const capped = Math.min(
      Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : FILE_META_DEFAULT_LIMIT),
      FILE_META_MAX_LIMIT,
    );
    const like = `%${escapeLikeWildcards(trimmed)}%`;
    const rows = searchAllStmt.all(like, like, capped) as Array<{
      scope: string;
      target_id: string;
      meta: string;
    }>;
    return rows.map((r) => ({
      scope: r.scope,
      target_id: r.target_id,
      meta: deserializeFileMeta(r.meta),
    }));
  };

  const list: FileMetaStore['list'] = (scope, opts) => {
    const clauses = ['scope = ?'];
    const params: unknown[] = [scope];
    if (opts?.name_contains) {
      clauses.push(`json_extract(meta, '$.filename') LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLikeWildcards(opts.name_contains)}%`);
    }
    if (opts?.path_prefix) {
      clauses.push(`json_extract(meta, '$.path') LIKE ? ESCAPE '\\'`);
      params.push(`${escapeLikeWildcards(opts.path_prefix)}%`);
    }
    if (opts?.mime_exact) {
      clauses.push(`json_extract(meta, '$.mime_type') = ?`);
      params.push(opts.mime_exact);
    }
    if (opts?.owner_exact) {
      clauses.push(`json_extract(meta, '$.owner') = ?`);
      params.push(opts.owner_exact);
    }
    // Guard a non-finite limit (NaN / ±Infinity survive Math.trunc/max/min
    // and would bind an invalid LIMIT) — fall back to the default.
    const rawLimit = opts?.limit;
    const limit = Math.min(
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit as number) : FILE_META_DEFAULT_LIMIT),
      FILE_META_MAX_LIMIT,
    );
    const rows = db
      .prepare(
        `SELECT scope, target_id, meta FROM ${FILE_META_TABLE}
           WHERE ${clauses.join(' AND ')}
           ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{ scope: string; target_id: string; meta: string }>;
    return rows.map((r) => ({
      scope: r.scope,
      target_id: r.target_id,
      meta: deserializeFileMeta(r.meta),
    }));
  };

  const listSnapshotHashes: FileMetaStore['listSnapshotHashes'] = (scope) => {
    const out = new Map<string, string>();
    for (const row of hashesStmt.all(scope) as Array<{ target_id: unknown; h: unknown }>) {
      if (typeof row.target_id === 'string' && typeof row.h === 'string' && row.h.length > 0) {
        out.set(row.target_id, row.h);
      }
    }
    return out;
  };

  const listSourcePaths: FileMetaStore['listSourcePaths'] = (scope) => {
    const out = new Map<string, string>();
    for (const row of pathsStmt.all(scope) as Array<{ target_id: unknown; p: unknown }>) {
      // Omit rows with no stored path (`json_extract` yields null) — an
      // unlocatable row is never a scoped delete candidate (fail-closed).
      if (typeof row.target_id === 'string' && typeof row.p === 'string' && row.p.length > 0) {
        out.set(row.target_id, row.p);
      }
    }
    return out;
  };

  const deleteForSource: FileMetaStore['deleteForSource'] = (scope, target_id) =>
    deleteStmt.run(scope, target_id).changes > 0;

  const deleteAllForScope: FileMetaStore['deleteAllForScope'] = (scope) =>
    deleteAllStmt.run(scope).changes;

  const countForScope: FileMetaStore['countForScope'] = (scope) =>
    (countStmt.get(scope) as { n: number }).n;

  return {
    upsert,
    get,
    list,
    searchAll,
    listSnapshotHashes,
    listSourcePaths,
    deleteForSource,
    deleteAllForScope,
    countForScope,
  };
};
