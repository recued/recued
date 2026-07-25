/** Thin wrapper over SQLite FTS5. Used by the durable `data.shared.*`
 *  store (Phase A) and the mail / file / webhook warehouse collections
 *  (Phase D). The wrapper never enforces schema rules on the caller —
 *  FTS5 itself is the authority for what goes into the index.
 *
 *  The index is a contentless FTS5 virtual table with two columns
 *  (`key`, `blob_text`). Queries combine an optional dotted-prefix
 *  filter (applied as a `LIKE 'prefix.%'` clause on the key BEFORE the
 *  FTS5 match, so result sets stay bounded) with a standard FTS5 match
 *  query on `blob_text`. */

import type Database from 'better-sqlite3';

export interface SearchOptions {
  /** Glob prefix applied to the key column before FTS match. Supports
   *  the two common shapes Phase A recipes use:
   *    `deal.*`   — any key under the `deal.` namespace.
   *    `deal.123` — exact-key match (equivalent to `LIKE` without %).
   *  `*` alone means no key filter. */
  scope?: string;
  /** FTS5 match query string. Uses standard FTS5 syntax (AND, OR,
   *  NEAR, phrase). */
  query: string;
  /** Maximum rows returned. Defaults to 50. */
  limit?: number;
}

export interface SearchResult {
  key: string;
  rank: number;
}

export const createFtsTable = (db: Database.Database, name: string): void => {
  // FTS5 with default (non-contentless) storage so `key` round-trips
  // back from queries. The blob_text column is the whole JSON blob,
  // untokenized-shaped — FTS5 handles tokenization + inverted index.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${escapeIdent(name)}
    USING fts5(key UNINDEXED, blob_text)
  `);
};

export const dropFtsTable = (db: Database.Database, name: string): void => {
  db.exec(`DROP TABLE IF EXISTS ${escapeIdent(name)}`);
};

export const indexRecord = (
  db: Database.Database,
  name: string,
  key: string,
  blobText: string,
): void => {
  // Contentless FTS5 requires delete-then-insert to update a row.
  db.prepare(`DELETE FROM ${escapeIdent(name)} WHERE key = ?`).run(key);
  db.prepare(
    `INSERT INTO ${escapeIdent(name)} (key, blob_text) VALUES (?, ?)`,
  ).run(key, blobText);
};

export const deleteRecord = (
  db: Database.Database,
  name: string,
  key: string,
): void => {
  db.prepare(`DELETE FROM ${escapeIdent(name)} WHERE key = ?`).run(key);
};

/** Delete the exact-key row AND its dotted descendants —
 *  `key = prefix OR key LIKE 'prefix.%'` — matching the dotted-keyspace
 *  semantics of the durable shared store's main-table delete. A bare
 *  `LIKE 'prefix%'` would wrongly purge index rows for unrelated siblings
 *  that merely share a string prefix (`deal` → `dealer`, `deals`), leaving
 *  those records in the main table but invisible to search. LIKE wildcards
 *  in the prefix are escaped (a key may legitimately contain `_`) so the
 *  pattern matches verbatim. */
export const deleteByPrefix = (
  db: Database.Database,
  name: string,
  prefix: string,
): number => {
  const res = db
    .prepare(`DELETE FROM ${escapeIdent(name)} WHERE key = ? OR key LIKE ? ESCAPE '\\'`)
    .run(prefix, `${escapeLike(prefix)}.%`);
  return res.changes;
};

export const search = (
  db: Database.Database,
  name: string,
  opts: SearchOptions,
): SearchResult[] => {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
  const scope = opts.scope ?? '*';
  const where: string[] = [];
  const scopeParams: unknown[] = [];

  if (scope !== '*') {
    if (scope.endsWith('.*')) {
      // Escape LIKE wildcards in the scope prefix so a `_` in a key can't
      // widen the candidate set to unrelated siblings.
      where.push(`key LIKE ? ESCAPE '\\'`);
      scopeParams.push(`${escapeLike(scope.slice(0, -1))}%`);
    } else {
      where.push('key = ?');
      scopeParams.push(scope);
    }
  }

  // FTS MATCH must be last in the WHERE clause for the planner to use
  // the FTS index.
  where.push(`${escapeIdent(name)} MATCH ?`);

  const sql = `
    SELECT key, rank FROM ${escapeIdent(name)}
    WHERE ${where.join(' AND ')}
    ORDER BY rank LIMIT ?
  `;
  const stmt = db.prepare(sql);
  // Try the query as a raw FTS5 expression first — preserves AND / OR /
  // NEAR / phrase / prefix (`fox*`) for callers that use them. An email /
  // path query (`pat.lee@x.com`, `foo-bar`) raises `fts5: syntax error`,
  // so fall back to the query reduced to safe quoted word-tokens
  // (bag-of-words AND, prefix preserved). No word tokens → no matches.
  try {
    return stmt.all(...scopeParams, opts.query, limit) as SearchResult[];
  } catch (err) {
    // ONLY an FTS5 query-parse error is recoverable by reducing the query to
    // safe tokens. Surface anything else (IO / corruption / schema) rather
    // than masking it as an empty result set.
    if (!isFtsQueryError(err)) throw err;
    const safe = toFtsMatch(opts.query);
    if (safe === null) return [];
    return stmt.all(...scopeParams, safe, limit) as SearchResult[];
  }
};

/** An FTS5 MATCH parse failure (vs. an IO / corruption / schema error).
 *  FTS5 prefixes its query errors with `fts5:` (e.g. `fts5: syntax error
 *  near "."`); no IO/corruption message carries that token. */
const isFtsQueryError = (err: unknown): boolean =>
  err instanceof Error && /fts5:/i.test(err.message);

/** Admin-only: drop the index and rebuild from a caller-supplied
 *  reindexer. Used during schema evolution. */
export const rebuildIndex = (
  db: Database.Database,
  name: string,
  reindex: () => void,
): void => {
  dropFtsTable(db, name);
  createFtsTable(db, name);
  reindex();
};

const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const escapeIdent = (name: string): string => {
  if (!IDENT_PATTERN.test(name)) {
    throw new Error(`@recued/fts: invalid table name '${name}'`);
  }
  return name;
};

/** Escape SQL `LIKE` wildcards (`%`, `_`) and the escape char (`\`) in a
 *  literal so it matches verbatim under `LIKE ? ESCAPE '\'`. Without this a
 *  key containing `_` (a single-char wildcard) would silently match its
 *  siblings in prefix list / delete / scoped-search clauses. */
export const escapeLike = (literal: string): string =>
  literal.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Reduce an arbitrary user string to a safe FTS5 MATCH expression: the
 *  Unicode word tokens (each optionally carrying a trailing `*` prefix
 *  operator) quoted as phrase literals and AND-joined. Neutralizes
 *  `. : @ - ( ) ,` and bare AND/OR/NOT/NEAR that would otherwise raise
 *  `fts5: syntax error`. The stem stays quoted even for a prefix token
 *  (`"OR"*`) so a reserved-word stem can't be reinterpreted as an operator.
 *  Returns null when the string has no word tokens (all punctuation) — the
 *  caller then yields no matches rather than an invalid empty MATCH. */
export const toFtsMatch = (raw: string): string | null => {
  const tokens = raw.match(/[\p{L}\p{N}]+\*?/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .map((t) => (t.endsWith('*') ? `"${t.slice(0, -1)}"*` : `"${t}"`))
    .join(' ');
};
