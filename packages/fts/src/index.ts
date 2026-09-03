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

export interface CreateFtsTableOptions {
  /** FTS5 `tokenize=` argument list, e.g. `porter unicode61 remove_diacritics 2`.
   *  Omit for FTS5's default (`unicode61`, non-stemming) — the shape every index
   *  in this codebase was built with, so omitting it changes nothing.
   *  ⛔ Interpolated into DDL. Validated to a conservative alphabet; never pass
   *  user input. */
  tokenizer?: string;
  /** Repopulate the index from the source rows. Supply this wherever the caller
   *  CAN rebuild — it is what turns a content-format change from a silent
   *  regression into a one-time upgrade.
   *
   *  ⛔⛔ WITHOUT IT A STALE INDEX IS LEFT ALONE RATHER THAN EMPTIED. That is
   *  deliberate: four of the five call sites in this codebase ignored the
   *  `migrated` flag entirely (harmlessly, since none passed a tokenizer), and
   *  a design where forgetting this callback empties a live index would have
   *  turned that latent habit into data loss. Forgetting it costs the CJK
   *  improvement on old rows, never the index. */
  reindex?: () => void;
}

/** The shape of the text `indexRecord` stores. Bump when that changes, so every
 *  existing index is rebuilt once rather than silently half-matching.
 *
 *   1 — verbatim blob text.
 *   2 — unspaced scripts space-separated per grapheme (`segmentUnspacedForFts`),
 *       so a 2-character CJK/Thai word matches as an adjacent phrase instead of
 *       only where it begins a run.
 *   3 — mail composes SUBJECT + BODY before the addresses. `snippet()` returns a
 *       token window centred on the match, and a leading from/to/cc line ate
 *       more than half of it — measured, the window closed four tokens short of
 *       the sentence that answered the question. Matching and ranking are
 *       unaffected (FTS5 is position-independent; BM25 scores frequency and
 *       length), so this is a READABILITY format change that still requires a
 *       rebuild: the stored text differs.
 *
 *  ⛔ THE TOKENIZER-BASED MIGRATION CANNOT SEE THIS. It compares
 *  `sqlite_master.sql`, and the content format leaves no trace in the DDL — the
 *  declaration is identical before and after. Hence the sidecar table. */
export const FTS_CONTENT_FORMAT = 3;

/** Rows per page of a one-time rebuild. ⛔ A rebuild MUST page rather than
 *  `.iterate()`: better-sqlite3 refuses a write while a read statement is
 *  iterating, and every rebuild writes per row it reads. Bounded so a 2 GB
 *  mailbox does not materialise, large enough that the walk is not
 *  statement-bound. Lives here so all five call sites share one number. */
export const FTS_REINDEX_PAGE = 500;

const FORMAT_TABLE = 'fts_content_format';

const ensureFormatTable = (db: Database.Database): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${FORMAT_TABLE} `
    + `(name TEXT PRIMARY KEY, format INTEGER NOT NULL)`,
  );
};

const recordedFormat = (db: Database.Database, name: string): number | null => {
  ensureFormatTable(db);
  const row = db
    .prepare(`SELECT format FROM ${FORMAT_TABLE} WHERE name = ?`)
    .get(name) as { format: number } | undefined;
  return row?.format ?? null;
};

const setFormat = (db: Database.Database, name: string, format: number): void => {
  ensureFormatTable(db);
  db.prepare(
    `INSERT INTO ${FORMAT_TABLE} (name, format) VALUES (?, ?) `
    + `ON CONFLICT(name) DO UPDATE SET format = excluded.format`,
  ).run(name, format);
};

export interface CreateFtsTableResult {
  /** True when an index existed with a DIFFERENT declared tokenizer and was
   *  therefore dropped and recreated empty. **The caller owes a full reindex.**
   *  A caller that ignores this silently serves an empty index. */
  migrated: boolean;
}

/** Create the index — MIGRATING it when its declared tokenizer has changed.
 *
 *  ⛔⛔ THE MIGRATION IS NOT OPTIONAL, and this was verified rather than assumed:
 *  `CREATE VIRTUAL TABLE IF NOT EXISTS` is a NO-OP against an existing table, so
 *  re-running it with a new `tokenize=` leaves `sqlite_master.sql` still saying
 *  the old one. Without the drop below, changing a tokenizer would take effect
 *  on FRESH installs only and be inert on every server that already has the
 *  index — built, typed, tested and unreachable. */
export const createFtsTable = (
  db: Database.Database,
  name: string,
  options: CreateFtsTableOptions = {},
): CreateFtsTableResult => {
  // Validate BEFORE any DDL, so a bad tokenizer can never drop a live index.
  const clause = tokenizeClause(options.tokenizer);
  const declared = declaredTableSql(db, name);
  const tokenizerChanged = declared !== null && !declaresTokenizer(declared, clause);
  // A pre-existing index with no recorded format is format 1 by definition —
  // it was written before the sidecar existed.
  const stored = declared === null ? null : (recordedFormat(db, name) ?? 1);
  const formatStale = stored !== null && stored !== FTS_CONTENT_FORMAT;
  const migrated = tokenizerChanged || formatStale;
  // ⛔⛔ A TOKENIZER CHANGE MUST DROP (the schema itself differs). A FORMAT
  // CHANGE MUST NOT, AND THAT DISTINCTION WAS LEARNED THE HARD WAY.
  //
  // The first cut dropped for both and refilled via `reindex`. `indexRecord`
  // DELETEs-then-INSERTs per key, so re-indexing every live row already
  // overwrites in place — the drop bought only the removal of orphans, and it
  // cost a window in which the index is EMPTY. Any throw inside the callback
  // lands in that window: measured, a real reindex threw and left
  // `search(sandhurst)` at 0 where it had returned 3, with nothing red.
  //
  // Re-indexing in place has no such window. An orphaned key keeps its old
  // format, which is harmless — it is already unreachable from the source rows.
  if (tokenizerChanged) dropFtsTable(db, name);
  // FTS5 with default (non-contentless) storage so `key` round-trips
  // back from queries. The blob_text column is the whole JSON blob,
  // untokenized-shaped — FTS5 handles tokenization + inverted index.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${escapeIdent(name)}
    USING fts5(key UNINDEXED, blob_text${clause})
  `);
  if (migrated && options.reindex !== undefined) {
    // Repopulate BEFORE recording the format, so a throw leaves the format stale
    // and the next boot retries rather than recording a lie. With the drop gone,
    // a throw now leaves the OLD index intact rather than an empty one.
    options.reindex();
    setFormat(db, name, FTS_CONTENT_FORMAT);
  } else if (declared === null) {
    // Fresh table: nothing to migrate, and it is written in the current format.
    setFormat(db, name, FTS_CONTENT_FORMAT);
  }
  return { migrated };
};

/** The `CREATE` statement SQLite recorded for `name`, verbatim — null when the
 *  table does not exist. */
const declaredTableSql = (db: Database.Database, name: string): string | null => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
    .get(name) as { sql: string | null } | undefined;
  return row?.sql ?? null;
};

/** Does an existing declaration already carry exactly the tokenizer we would
 *  emit? Both arms fail SAFE — an unrecognised declaration reads as a mismatch
 *  and costs one rebuild, never a silently-stale tokenizer. The clause is
 *  compared against the SAME string `createFtsTable` emits, so the two cannot
 *  drift into a rebuild-on-every-boot loop. */
const declaresTokenizer = (declaredSql: string, clause: string): boolean =>
  clause === '' ? !/\btokenize\b/i.test(declaredSql) : declaredSql.includes(clause);

/** FTS5 tokenizer arg lists are space-separated bare words (`porter unicode61
 *  remove_diacritics 2`). Anything else — quotes above all — is rejected rather
 *  than escaped: this string is interpolated into DDL. */
const TOKENIZER_PATTERN = /^[A-Za-z0-9_]+( [A-Za-z0-9_]+)*$/;

const tokenizeClause = (tokenizer: string | undefined): string => {
  if (tokenizer === undefined) return '';
  if (!TOKENIZER_PATTERN.test(tokenizer)) {
    throw new Error(`@recued/fts: invalid tokenizer '${tokenizer}'`);
  }
  return `, tokenize='${tokenizer}'`;
};

export const dropFtsTable = (db: Database.Database, name: string): void => {
  db.exec(`DROP TABLE IF EXISTS ${escapeIdent(name)}`);
};

/** Scripts that do NOT delimit words with spaces, so FTS5's `unicode61` sees a
 *  whole clause as ONE token and can match a word only where it happens to
 *  BEGIN a run. Measured against a real index, mid-run exact match:
 *
 *    Han / Hiragana / Katakana / Thai / Lao  -> 0   (broken)
 *    Hangul / Cyrillic / Devanagari / Arabic -> 1   (fine, space-separated)
 *
 *  ⚠ Hangul is deliberately ABSENT — Korean is space-separated and already
 *  works; splitting it would inflate the index for nothing. Myanmar is absent
 *  for the same reason: it probes as fine, and the tokenizer's behaviour is the
 *  test, not the shape of the script. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}]/u;

/** Does this text contain a script FTS5 cannot word-segment? Exported so a
 *  caller can BRANCH on it rather than re-deriving the script set — the set was
 *  wrong in both directions the first time it was written by hand. */
export const hasUnspacedScript = (text: string): boolean => UNSPACED_SCRIPT.test(text);

let graphemes: Intl.Segmenter | null | undefined;

/** Space-separate every grapheme of an unspaced script, so each becomes its own
 *  FTS5 token and a 2-character word matches as an ADJACENT PHRASE.
 *
 *  ⛔⛔ THIS IS ONE FUNCTION BECAUSE IT IS ONE RULE AT TWO ENDS. It is applied
 *  by `indexRecord` on the way in and by `toFtsMatch` on the way out, and the
 *  two MUST agree exactly — a stored side segmented differently from the query
 *  side matches nothing, and does so silently, returning a clean empty page.
 *  Do not reimplement either half; call this.
 *
 *  ⛔ GRAPHEMES, NOT CODE POINTS. Thai and Lao carry combining tone marks and
 *  vowel signs: splitting per code point would strand a mark away from its base
 *  and change the text. `Intl.Segmenter` is native ICU — no dependency.
 *
 *  ⛔ AND NOT THE `trigram` TOKENIZER, which is the textbook answer and is
 *  wrong here: it has a THREE-character floor (measured, `续约` and `通知`
 *  return 0 while `通知期` returns 1) and two characters is the most common
 *  Chinese word length, so it misses precisely the words a corpus is made of.
 *
 *  Latin, Cyrillic, Hangul and every other spaced script pass through
 *  untouched, including where they sit in the same string as CJK.
 *
 *  ⚠ COST, measured rather than guessed: ~0.1 µs on the no-op path (the early
 *  return, so an all-Latin corpus pays nothing) and ~400 µs on a 1 KB CJK body.
 *  That lands on the one-time reindex — roughly 20 s for a 50k-message Chinese
 *  mailbox — and on each subsequent write, where it is noise. A code-point fast
 *  path for mark-free scripts was tried and REJECTED: it bought 15%, not the
 *  order of magnitude that would justify a second code path through the one
 *  function both ends depend on agreeing about. */
export const segmentUnspacedForFts = (text: string): string => {
  if (!UNSPACED_SCRIPT.test(text)) return text;
  if (graphemes === undefined) {
    try {
      graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      graphemes = null;
    }
  }
  if (graphemes === null) return text;
  let out = '';
  for (const { segment } of graphemes.segment(text)) {
    // Pad BOTH sides: a Latin/Han boundary needs a break too, or `Sandhurst续约`
    // tokenises as `Sandhurst续` + `约`.
    out += UNSPACED_SCRIPT.test(segment) ? ` ${segment} ` : segment;
  }
  return out;
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
  ).run(key, segmentUnspacedForFts(blobText));
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
 *  reindexer. Used during schema evolution.
 *  ⚠ Pass the SAME `options` the index was created with — omitting them on a
 *  stemmed index silently downgrades it back to the default tokenizer, and the
 *  rebuild makes that look like a deliberate refresh. */
/** Record that `name` now holds `FTS_CONTENT_FORMAT`-shaped text.
 *
 *  ⛔ FOR ASYNC REBUILDERS ONLY. `createFtsTable`'s `reindex` callback is
 *  synchronous, and a store whose rebuild must await (resolving CAS bodies, say)
 *  cannot use it — it rebuilds lazily on first read instead. Without this it
 *  would see `migrated: true` on EVERY boot and rebuild the whole pool every
 *  time, which is worse than the problem being fixed.
 *
 *  ⚠ Call it only AFTER the rebuild has actually completed. Calling it early
 *  records a format the index does not hold, and nothing will ever correct
 *  that — the flag is the only thing that would have. */
export const markFtsContentFormat = (
  db: Database.Database,
  name: string,
): void => setFormat(db, name, FTS_CONTENT_FORMAT);

export const rebuildIndex = (
  db: Database.Database,
  name: string,
  reindex: () => void,
  options: CreateFtsTableOptions = {},
): void => {
  dropFtsTable(db, name);
  createFtsTable(db, name, options);
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

/** The Unicode word tokens of a raw query, each optionally carrying a trailing
 *  `*` prefix operator. */
/** ⛔ `\p{M}` IS PART OF THE WORD. A combining mark is neither a letter nor a
 *  number, so without it every Thai tone mark, Indic matra, Arabic harakat and
 *  Hebrew niqqud SPLITS the token around it — measured, `แจ้ง` tokenised as
 *  `แจ` + `ง` and queried as two unrelated phrases. Same defect as the
 *  ASCII-only classes elsewhere, one layer down. */
const wordTokens = (raw: string): string[] =>
  raw.match(/[\p{L}\p{N}\p{M}]+\*?/gu) ?? [];

/** Quote one token as an FTS5 phrase literal. The stem stays quoted even for a
 *  prefix token (`"OR"*`) so a reserved-word stem can't be reinterpreted as an
 *  operator. */
const quoteToken = (t: string): string => {
  // An unspaced-script token becomes an ADJACENT PHRASE over its graphemes,
  // matching the per-grapheme form `indexRecord` stored. `"续 约"` matches
  // `… 续 约 的 …`; `"续约"` would match nothing, which is what it used to do.
  const seg = (raw: string): string => segmentUnspacedForFts(raw).trim().replace(/\s+/gu, ' ');
  return t.endsWith('*') ? `"${seg(t.slice(0, -1))}"*` : `"${seg(t)}"`;
};

/** Reduce an arbitrary user string to a safe FTS5 MATCH expression: the
 *  Unicode word tokens (each optionally carrying a trailing `*` prefix
 *  operator) quoted as phrase literals and AND-joined. Neutralizes
 *  `. : @ - ( ) ,` and bare AND/OR/NOT/NEAR that would otherwise raise
 *  `fts5: syntax error`.
 *  Returns null when the string has no word tokens (all punctuation) — the
 *  caller then yields no matches rather than an invalid empty MATCH. */
export const toFtsMatch = (raw: string): string | null => {
  const tokens = wordTokens(raw);
  if (tokens.length === 0) return null;
  return tokens.map(quoteToken).join(' ');
};

/** English function words that carry no retrieval signal in a natural-language
 *  question. Consulted ONLY by the relaxation rungs below — never by
 *  `toFtsMatch`, so the exact rung still demands every word the caller typed.
 *
 *  ⛔ NEGATIONS ARE DELIBERATELY ABSENT (`not` / `no` / `never` / `without` /
 *  `nothing`). They look like function words and are on most published stopword
 *  lists, but they invert the sentence around them: drop `not` from "how to not
 *  delete a record" and the query relaxes into its own opposite. A word belongs
 *  here only if removing it cannot change WHICH document is the right answer. */
export const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been',
  'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'hers', 'him', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'may', 'me', 'might', 'must', 'my', 'of',
  'on', 'or', 'our', 'ours', 'please', 'shall', 'she', 'should', 'so', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'to', 'us', 'was', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'whose', 'will', 'with', 'would', 'you', 'your',
  'yours',
]);

/** A query's word tokens, lowercased with any trailing `*` stripped, split into
 *  every token and the CONTENT tokens (stopwords removed). For callers matching
 *  against raw text rather than building an FTS5 expression — they get the same
 *  relaxation vocabulary `toFtsMatchLadder` uses. */
export interface FtsQueryTokens {
  readonly all: readonly string[];
  readonly content: readonly string[];
}

export const tokenizeFtsQuery = (raw: string): FtsQueryTokens => {
  const all = wordTokens(raw).map((t) => t.replace(/\*$/, '').toLowerCase());
  return { all, content: all.filter((t) => !FTS_STOPWORDS.has(t)) };
};

/** Ordered RELAXATION LADDER for one query — the MATCH expressions to try in
 *  turn, most precise first. The caller runs each until one returns rows.
 *
 *  ⚠ WHY THIS EXISTS. FTS5 joins bare terms with an implicit **AND**, and
 *  `toFtsMatch` emits every word the caller typed — so a whole natural-language
 *  question, which is how an agent actually queries a knowledge base, demands
 *  that one document contain "what", "is" and "your" as well as "refund" and
 *  "policy". Measured against a 3-entry Q&A pool: `refund policy` hit the right
 *  entry, `What is your refund policy?` returned ZERO.
 *
 *  The rungs:
 *    1. AND over every token — today's expression, unchanged and always first,
 *       so any query that already matched keeps its exact result set.
 *    2. AND over the CONTENT tokens — drops function words and nothing else.
 *       Still a conjunction, so it buys recall without buying noise. This is
 *       the rung that answers the question above.
 *    3. OR over the content tokens — bm25 sorts a document matching more (and
 *       rarer) terms first. The last resort before an empty answer.
 *
 *  A rung that would duplicate an earlier one is omitted, and a query of
 *  nothing BUT stopwords gets rung 1 alone: "what is it" carries no retrieval
 *  signal, and OR-ing stopwords would return the whole corpus — worse than
 *  returning nothing. An empty array means no word tokens at all (the
 *  `toFtsMatch`-returns-null case); the caller yields no matches. */
export const toFtsMatchLadder = (raw: string): FtsMatchLadderRung[] => {
  const tokens = wordTokens(raw);
  if (tokens.length === 0) return [];
  const all = tokens.map(quoteToken);
  const content = tokens
    .filter((t) => !FTS_STOPWORDS.has(t.replace(/\*$/, '').toLowerCase()))
    .map(quoteToken);

  const ladder: FtsMatchLadderRung[] = [{ kind: 'exact', match: all.join(' ') }];
  if (content.length > 0 && content.length < all.length) {
    ladder.push({ kind: 'relaxed', match: content.join(' ') });
  }
  if (content.length > 1) ladder.push({ kind: 'loose', match: content.join(' OR ') });
  return ladder;
};

/** How much relaxation a rung applied — the retrieval's own precision signal.
 *
 *    exact    every word the caller typed is present
 *    relaxed  every CONTENT word is present; only function words were dropped
 *    loose    no entry had all the content words; these merely share some
 *
 *  ⛔ EACH RUNG CARRIES ITS OWN KIND rather than the caller inferring one from
 *  the array index, because rungs 2 and 3 are INDEPENDENTLY conditional:
 *  `refund policy` (no function words to drop) yields `[exact, loose]`, so
 *  index 1 is `loose`; `what is the refund` (one content word, no OR rung)
 *  yields `[exact, relaxed]`, so index 1 is `relaxed`. Indexing would report
 *  the opposite of the truth on one of those two shapes. */
export type FtsMatchRung = 'exact' | 'relaxed' | 'loose';

export interface FtsMatchLadderRung {
  readonly kind: FtsMatchRung;
  /** The FTS5 MATCH expression to run for this rung. */
  readonly match: string;
}
