/** Static audit of EVERY SQL statement in the tree.
 *
 *  The optimization pass in `optimization.ts` only sees what an idle tick
 *  happens to run — roughly a dozen statements. This one extracts all ~2900
 *  from source and asks SQLite itself how each would execute, against the real
 *  198-table / 412-index schema.
 *
 *  ⛔ THE RULE THIS INSTRUMENT MUST NOT BREAK, and the easiest one to break
 *  here: a statement that could not be extracted, could not be resolved, or
 *  could not be EXPLAINed is NOT a clean statement. Every drop is counted and
 *  categorised, and the run reports its own coverage before it reports a single
 *  finding. A sweep that quietly analysed 400 of 2900 queries and found nothing
 *  would read exactly like a clean bill of health.
 *
 *  ⚠ Interpolated table names (`${table}`, `${this.table}`) are the norm here —
 *  the collection primitive is generic over its table. Those are resolved by
 *  substituting each REAL table from the schema that the surrounding file
 *  plausibly targets; when nothing resolves, the statement is reported
 *  unresolved rather than skipped. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createRequire } from 'node:module';

import Database from 'better-sqlite3';

const require_ = createRequire(import.meta.url);

export interface ExtractedQuery {
  readonly file: string;
  readonly line: number;
  readonly sql: string;
  /** Raw text before interpolation substitution. */
  readonly raw: string;
}

export interface PlanRow {
  readonly detail: string;
}

export type QueryVerdict =
  | 'analysed'
  /** Parsed and EXPLAINed, but a predicate / column list was a `${}` hole that
   *  had to be stubbed — the plan is real SQL, just not THIS query's plan. In
   *  the coverage denominator; excluded from scan findings. */
  | 'analysed-partial'
  | 'unresolved-interpolation'
  | 'explain-failed'
  | 'not-explainable'
  /** Not SQLite against THIS database, so it was never analysable here.
   *
   *  ⛔ SEPARATE FROM `not-explainable` ON PURPOSE. That bucket means "the audit
   *  should be able to read this and could not" — a coverage hole worth closing.
   *  This one means "there is nothing here for a SQLite EXPLAIN to say", and
   *  mixing them makes the coverage number unreadable in both directions: it
   *  overstates the hole, and it hides real holes among permanent ones.
   *
   *  Two sources, both structural:
   *    - `backend/api/` is the CLOUD, which runs on a different database
   *      entirely (its `hostnames` table does not exist in a server realm) —
   *      15 statements;
   *    - `data/salesforce/` issues SOQL, whose `Account` / `Contact` /
   *      `Opportunity` / `PushTopic` are Salesforce objects, not tables — ~9. */
  | 'out-of-scope';

export interface AnalysedQuery extends ExtractedQuery {
  /** The statement with `${}` holes resolved — what actually EXPLAINed.
   *
   *  ⛔ CONSUMERS MUST USE THIS, NOT `sql`. Re-substituting from the raw text
   *  downstream puts ONE table into EVERY hole, which silently turns a join
   *  into a self-join and changes the plan being reasoned about. The index
   *  advisor did exactly that and mis-filed real findings because of it. */
  readonly resolvedSql?: string;
  readonly verdict: QueryVerdict;
  readonly plan: readonly string[];
  /** Tables read by a TRUE full scan — every row of the table b-tree.
   *
   *  ⛔ THIS USED TO INCLUDE INDEX WALKS, and that made the audit unable to
   *  measure its own progress. The regex was `^SCAN (?:TABLE )?(\w+)`, which
   *  matches `SCAN t USING INDEX ix` just as happily as `SCAN t` — so four
   *  fixes that turned real table scans into ordered index walks moved the
   *  headline total by 2. Worse, plans that were ALREADY OPTIMAL were being
   *  reported as findings: `SCAN t USING INDEX ix` under a LIMIT reads LIMIT
   *  entries off the top of an index and stops, which is exactly what a
   *  first page should do. */
  readonly scans: readonly string[];
  /** Tables read by walking an index rather than the table — `SCAN t USING
   *  [COVERING] INDEX ix` — each with the index that was walked.
   *
   *  ⚠ NOT automatically fine, and not automatically a defect. Under a LIMIT it
   *  is the optimal shape. UNBOUNDED it is still O(rows), just with narrower
   *  rows than a table scan — so those are reported separately rather than
   *  folded into either bucket.
   *
   *  ⚠ …UNLESS THE INDEX IS PARTIAL, which is why the name is carried. A walk
   *  over `… WHERE source_lifecycle = 'pending'` reads the handful of rows
   *  matching that predicate, not the table — the bucket flagged a query the
   *  previous commit had just FIXED until it could tell the difference. */
  readonly indexWalks: ReadonlyArray<{ table: string; index: string }>;
  readonly reason?: string;
}

/** Split an `EXPLAIN QUERY PLAN` into TRUE full scans and index walks.
 *
 *  ⛔ THE `USING INDEX` SUFFIX IS THE WHOLE DISTINCTION, and missing it made
 *  this audit unable to measure its own progress. The original regex was
 *  `^SCAN (?:TABLE )?(\w+)`, which matches `SCAN t USING INDEX ix` exactly as
 *  happily as `SCAN t`. Two consequences, both bad:
 *
 *    - plans that were ALREADY OPTIMAL were reported as findings. `SCAN t USING
 *      INDEX ix` under a LIMIT reads LIMIT entries off the top of an index and
 *      stops — precisely what a first page should do;
 *    - fixing a real table scan into an ordered index walk moved the headline
 *      total by ~nothing, so the number could not be used to tell whether the
 *      sweep was working. Measured on the real tree: 258 reported scans, of
 *      which 91 (35%) were index walks.
 *
 *  ⚠ AN INDEX WALK IS NOT AUTOMATICALLY FINE — unbounded it is still O(rows),
 *  just over narrower ones. It gets its own bucket rather than being folded
 *  into either pile; `query-audit-run.ts` reports the ones with no LIMIT.
 *
 *  ⚠ `SEARCH` rows are neither: they seek, and are what the fixes aim for. */
export const classifyPlan = (
  plan: readonly string[],
): { scans: string[]; indexWalks: Array<{ table: string; index: string }> } => {
  const scans: string[] = [];
  const indexWalks: Array<{ table: string; index: string }> = [];
  for (const detail of plan) {
    const m = /^SCAN (?:TABLE )?([A-Za-z0-9_]+)(.*)$/.exec(detail);
    if (m === null) continue;             // SEARCH / USE TEMP B-TREE / …
    // ⛔ AN *AUTOMATIC* INDEX IS A SCAN, and deliberately so. SQLite reports
    // `SCAN t USING AUTOMATIC COVERING INDEX` when NO PERSISTENT INDEX EXISTED
    // and it built a transient one for this statement — which means it read the
    // whole table to do it, and will do so again on every execution. That is a
    // missing index, i.e. exactly the finding, so it belongs in `scans` even
    // though the text says `USING … INDEX`.
    //
    // ⚠ The pattern excludes it EXPLICITLY. It already landed in the right
    // bucket by accident, because `AUTOMATIC` sits between `USING` and
    // `COVERING` and broke the match — an accident is not a decision, and the
    // next person to loosen this pattern would silently reclassify every
    // automatic index as a healthy walk.
    const suffix = m[2]!;
    const walked = /\bUSING\s+(COVERING\s+)?INDEX\b/.test(suffix)
      && !/\bAUTOMATIC\b/.test(suffix);
    if (walked) {
      // ⚠ THE INDEX NAME IS LOAD-BEARING, not decoration: a walk over a PARTIAL
      // index is bounded by that index's WHERE, not by the table, and the
      // caller uses the name to look that up.
      const named = /\bUSING\s+(?:COVERING\s+)?INDEX\s+([A-Za-z0-9_]+)/.exec(suffix);
      indexWalks.push({ table: m[1]!, index: named?.[1] ?? '' });
    } else scans.push(m[1]!);
  }
  return { scans, indexWalks };
};

/** A predicate for "is this scanned name a REAL user table?", built from the
 *  schema the audit EXPLAINed against.
 *
 *  ⛔ THE NOISE THIS REMOVES. `EXPLAIN QUERY PLAN` names whatever the query
 *  called the thing it scanned, so a CTE (`absorbed`, `merged_sources`), a join
 *  alias (`a`, `s`, `dispatch`, `attempt`), a table-valued function
 *  (`json_each`, `pragma_table_info`) and the literal `CONSTANT` all arrived as
 *  "tables that were scanned". Measured on the real tree: 13 of the reported
 *  names were not tables, and filtering them dropped the headline from 161 full
 *  scans to 101.
 *
 *  🔑 Checking the SCHEMA is the principled version of the hardcoded
 *  `CONSTANT || json_each` list this replaced — anything absent from the schema
 *  cannot be a table scan, whatever it is called, and the list needed a new
 *  entry every time a query introduced a new alias.
 *
 *  ⚠ `sqlite_master` is excluded BY NAME because it is a real table: reading the
 *  schema is never the finding, and it alone accounted for 34 scans.
 *
 *  ⚠ SCANNING A CTE IS NOT FREE, it is just not a MISSING INDEX. The contact
 *  merge walk's `SCAN absorbed` reads the recursive result it just built, while
 *  its contacts half already seeks. Reporting it sends a reader hunting an index
 *  that would change nothing. */
export const makeRealTableFilter = (
  tables: readonly string[],
): ((name: string) => boolean) => {
  const known = new Set(tables);
  return (name: string): boolean => known.has(name) && !name.startsWith('sqlite_');
};

/** Rewrite named binds (`:name`, `@name`, `$name`) to `?`, OUTSIDE string
 *  literals only.
 *
 *  ⛔ THE BUG THIS REPLACES. The one-line `replace(/[:@$][a-zA-Z_]\w*\/g, '?')`
 *  rewrote inside quoted strings too, so
 *      WHERE bucket_key LIKE 'per_ip_global:hz-expired-%'
 *  became `'per_ip_global?-expired-%'`. The arity count then saw a placeholder
 *  the statement does not have, bound a null for it, and EXPLAIN answered
 *  "Too many parameter values were provided" — a statement with NO binds at all
 *  reported as unanalysable because the instrument invented one. Five
 *  statements, including `'kernel:mcp-recipe-callback'`.
 *
 *  ⚠ Handles the SQL `''` escape: inside a literal, a doubled quote is a quote,
 *  not the end of the string. Getting that wrong flips the in/out state for the
 *  rest of the statement and corrupts everything after it. */
export const normaliseNamedBinds = (sql: string): string => {
  let out = '';
  let i = 0;
  let inLiteral = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (inLiteral) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 2; continue; }  // escaped quote
        inLiteral = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") { inLiteral = true; out += ch; i += 1; continue; }
    const m = /^[:@$][a-zA-Z_][a-zA-Z0-9_]*/.exec(sql.slice(i));
    if (m) { out += '?'; i += m[0].length; continue; }
    out += ch;
    i += 1;
  }
  return out;
};

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'coverage', '__tests__', 'test-results',
  '.horizon-audit-scratch', 'generated', 'archive',
]);

export const sourceFiles = (roots: readonly string[]): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
};

/** ⛔ STRUCTURE, not just a leading keyword. The first version matched a bare
 *  `UPDATE\b`, so the string literal `'update'` — a status value used all over
 *  this codebase — was extracted as a SQL statement. 297 of them, every one
 *  landing in the "incomplete input" bucket and inflating the denominator, so
 *  coverage read far worse than it was. An instrument that miscounts what it
 *  FAILED to analyse misleads in the same way as one that miscounts findings. */
const SQL_SHAPES: readonly RegExp[] = [
  /^\s*SELECT\s+[\s\S]+?\bFROM\b/i,
  /^\s*SELECT\s+(?:\d|COUNT|EXISTS|json|last_insert)/i,
  /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\S/i,
  /^\s*REPLACE\s+INTO\s+\S/i,
  /^\s*UPDATE\s+[\w"`$among{}.]+\s+SET\b/i,
  /^\s*DELETE\s+FROM\s+\S/i,
  /^\s*WITH\s+[\s\S]+?\bAS\s*\(/i,
];
const looksLikeSql = (s: string): boolean => SQL_SHAPES.some((re) => re.test(s));

/** Blank out comment BODIES, preserving every offset and newline.
 *
 *  ⛔ THE AUDIT WAS EXTRACTING PROSE AS SQL. The scan walks template literals
 *  and quoted strings over raw text with no comment awareness, so a backticked
 *  snippet inside a JSDoc block came through with its leading asterisks —
 *      DELETE FROM
 *       *  audit_entries
 *  — and sat in the closable bucket as a parse failure that can never be
 *  closed, because it was never a statement. Same for a `//`-commented fragment
 *  inside a template.
 *
 *  🔑 SPACES, NOT DELETION. Line numbers are computed from offsets in this same
 *  text, so removing characters would silently misreport every location after
 *  the first comment. Newlines are kept for the same reason.
 *
 *  ⚠ Deliberately simple: `[^:]` before `//` keeps `https://` intact, which is
 *  enough for this repo's own source, and it can only ever make the extractor
 *  look at LESS prose — never at less code. The D-212 chokepoint ratchet uses
 *  the same shape for the same reason. */
export const blankComments = (text: string): string => {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
};

/** Pull every template-literal / quoted string that looks like SQL, with its
 *  1-based line number. Deliberately dumb and deliberately over-inclusive:
 *  a false candidate fails to EXPLAIN and is COUNTED as such, whereas a missed
 *  one is invisible. Over-inclusion is the safe direction. */
/** ⚠ Over-inclusion is why a handful of PROSE strings ("Delete from shared
 *  store", a manifest description) sit permanently in the failed bucket. That is
 *  the stated trade and it is the right one: tightening the matcher to reject
 *  them risks dropping real SQL, which would be invisible. Left alone
 *  deliberately. */
export const extractQueries = (file: string, rawText: string): ExtractedQuery[] => {
  const out: ExtractedQuery[] = [];
  // ⚠ Offsets stay valid because `blankComments` substitutes spaces in place.
  const text = blankComments(rawText);
  const lineOf = (idx: number): number => text.slice(0, idx).split('\n').length;

  // Template literals. Nested `${ ... }` may contain backticks; step over them.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let j = i + 1;
    let depth = 0;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '$' && text[j + 1] === '{') { depth++; j += 2; continue; }
      if (c === '}' && depth > 0) { depth--; j++; continue; }
      if (c === '`' && depth === 0) break;
      j++;
    }
    const body = text.slice(i + 1, j);
    if (looksLikeSql(body)) {
      out.push({ file, line: lineOf(i), sql: body, raw: body });
    }
    i = j;
  }

  // Plain quoted strings — rarer, but `sqlite-collection` style code uses them.
  const quoted = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(text)) !== null) {
    if (looksLikeSql(m[2])) {
      out.push({ file, line: lineOf(m.index), sql: m[2], raw: m[2] });
    }
  }
  return out;
};

/** Substitute `${...}` holes with a real table name from the schema.
 *
 *  ⚠ A hole is almost always a TABLE name here (the collection primitive is
 *  generic over its table). Candidates are drawn from the live schema, so a
 *  substitution that EXPLAINs is a statement that really could run. */
/** What SYNTACTIC POSITION a `${}` hole sits in.
 *
 *  ⛔ THE RESOLVER TREATED EVERY HOLE AS A TABLE NAME, which is why 187
 *  statements came back "no such column: work_entity_source_sync_state" — a
 *  TABLE name substituted into `WHERE memory_id IN (${placeholders})` produces
 *  exactly that error. Holes here are more often an `IN` list, a WHERE
 *  fragment, or a column list than a table.
 *
 *  ⚠ A hole filled with `1=1` yields a statement that PARSES and EXPLAINs but
 *  whose plan does NOT reflect the real predicate — it will look like a full
 *  scan because there is no predicate left. Those are marked `partial` and
 *  deliberately excluded from scan findings; counting them as clean scans would
 *  manufacture findings out of the instrument's own substitution. */
export type HoleKind =
  | 'table' | 'in-list' | 'predicate' | 'column-list' | 'order-by'
  /** The hole is a WHOLE CLAUSE including its keyword — `${whereClause}`,
   *  `${orderClause}`, `${where.sql}`. Position cannot see these: they follow a
   *  table reference or another clause hole, not a SQL keyword. Detected by
   *  NAME, which is honest for this codebase's conventions and costs nothing
   *  when wrong (a mis-filled hole simply fails to EXPLAIN, exactly as it did
   *  before). */
  | 'clause'
  /** A clause fragment that SUPPLIED THE `WHERE`, detected because the text
   *  after it continues with `AND` / `OR`. Filling it with '' — the ordinary
   *  clause stub — leaves a dangling `AND` and the statement stops parsing:
   *      FROM ${TASK_TABLE} ${relationshipVisible.sql}
   *        AND assigned_contact_id IN (SELECT value FROM json_each(?))
   *  Stubbed `WHERE 1=1` so the residual conjunction has something to attach
   *  to. */
  | 'where-fragment'
  /** A predicate fragment spliced INTO an existing WHERE, with a live
   *  conjunction on BOTH sides — `WHERE a=? ${aheadWhere} AND b<>?`. Filling
   *  `1=1` (the plain predicate stub) yields `a=? 1=1 AND b<>?`, which does not
   *  parse; the fragment must supply its own leading conjunction. */
  | 'conjunct-fragment'
  /** An UPDATE's `SET` list. Stubbed with a self-assignment-shaped fragment so
   *  the statement parses; the plan is real SQL but not THIS query's. */
  | 'assignments'
  | 'unknown';

const CLAUSE_NAME_RE = /(where|order|group|having|limit|clause|filter|sort|predicate)/i;

/** Which fragment shape a clause-ish hole is, given what surrounds it.
 *
 *  ⛔ THE THREE CASES DIFFER ONLY BY CONTEXT, and getting one wrong produces SQL
 *  that parses WORSE than the unfixed version:
 *    - a live conjunction FOLLOWS and no WHERE precedes → the fragment supplied
 *      the WHERE          ⇒ `WHERE 1=1`
 *    - a live conjunction FOLLOWS and a WHERE already precedes → it is spliced
 *      between two predicates and must bring its own AND
 *                         ⇒ `AND 1=1`   (`WHERE 1=1` here makes a second WHERE)
 *    - nothing conjoins after it → an ordinary clause ⇒ ''
 *
 *  Written once because I first patched two of the three call sites separately
 *  and they disagreed: `${aheadWhere}` matched the name rule, got `WHERE 1=1`,
 *  and produced `pack_slug=? WHERE 1=1 AND version<>?`. */
const clauseShape = (before: string, after: string): HoleKind => {
  const conjoinsAfter = /^\$\{[^}]*\}\s*(AND|OR)\b/i.test(after);
  if (!conjoinsAfter) return 'clause';
  return /\bWHERE\b/i.test(before) ? 'conjunct-fragment' : 'where-fragment';
};

export const holeKind = (sql: string, index: number): HoleKind => {
  const before = sql.slice(Math.max(0, index - 60), index);
  const after = sql.slice(index);
  const nameM = /^\$\{([^}]*)\}/.exec(after);
  const ident = nameM ? nameM[1] : '';
  if (/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+"?$/i.test(before)) return 'table';
  if (/\bIN\s*\($/i.test(before)) return 'in-list';
  // A hole inside a VALUES tuple is a BIND list, not a column list. `'*'` here
  // would produce `VALUES (?,?,*)`.
  if (/\bVALUES\s*\([^)]*$/i.test(before)) return 'in-list';
  if (/\b(WHERE|AND|OR)\s+$/i.test(before)) return 'predicate';
  if (/\bSELECT\s+$/i.test(before)) return 'column-list';
  if (/\bORDER\s+BY\s+$/i.test(before)) return 'order-by';
  // ⛔ THESE MUST STAY ABOVE THE NAME-BASED RULE. I first appended them below
  // it and `AND (${filters.join(' OR ')})` matched CLAUSE_NAME_RE on the word
  // "filter", got filled with '', and produced `AND ()` — a statement that
  // parsed WORSE than before. The header two lines down states this ordering;
  // I broke it in the same edit that relied on it.
  //
  // A hole opening a parenthesised predicate group. The keyword rule above
  // wants whitespace before the hole and finds `(`.
  if (/\b(WHERE|AND|OR|HAVING)\s*\($/i.test(before)) return 'predicate';
  // An UPDATE's assignment list — `SET ${assignments},…` and the mid-list
  // `SET kind=?,${assignments},…`.
  if (/\bSET\s+$/i.test(before)) return 'assignments';
  if (/\bSET\b[^;()]*,\s*$/i.test(before)) return 'assignments';
  // ⛔ A HOLE FOLLOWING ANOTHER HOLE IS A MODIFIER OF IT, not a second table.
  // `FROM ${ROW_TABLE}${indexedBy}` (an optional INDEXED BY, no separator) and
  // `DELETE FROM ${T} ${sql}` (a WHERE fragment, one space) both landed on
  // `unknown`, and the candidate loop then put THE SAME TABLE NAME in both —
  // `FROM core_recordswork_entity_source_sync_state`, `annotation annotation`.
  // Whitespace-tolerant because the two forms differ only by a space.
  // ⛔ CHECK WHAT FOLLOWS, not just what precedes. A clause hole whose text
  // continues with `AND` / `OR` must have supplied the WHERE itself; stubbing
  // it '' leaves a dangling conjunction and the statement stops parsing.
  if (/\}\s*$/.test(before)) return clauseShape(before, after);

  // Name-based, checked AFTER every positional rule so a hole in a real
  // keyword slot is never mistaken for a clause.
  if (CLAUSE_NAME_RE.test(ident)) return clauseShape(before, after);
  // A hole immediately followed by the end of a WHERE clause is a predicate
  // fragment appended by a builder (`… ${reserveSql}\`).
  if (/^\$\{[^}]*\}\s*(ORDER|GROUP|LIMIT|\)|$)/i.test(after)
      && /\bWHERE\b/i.test(before)) return 'predicate';
  return 'unknown';
};

/** Fill non-table holes with something syntactically valid. */
const fillForKind = (kind: HoleKind): string | undefined => {
  switch (kind) {
    case 'in-list': return '?';
    case 'predicate': return '1=1';
    case 'column-list': return '*';
    case 'order-by': return '1';
    case 'clause': return '';
    case 'where-fragment': return 'WHERE 1=1';
    case 'conjunct-fragment': return 'AND 1=1';
    case 'assignments': return 'updated_at=updated_at';
    default: return undefined;
  }
};

export const resolveInterpolations = (
  sql: string,
  tables: readonly string[],
  hintTables: readonly string[],
  constants: ReadonlyMap<string, string> = new Map(),
): { candidates: string[]; partial: boolean } => {
  if (!sql.includes('${')) return { candidates: [sql], partial: false };

  // ⛔ A WHOLLY-DYNAMIC INSERT COLUMN LIST HAS TO LOSE ITS PARENS TOO. The
  // table-rebuild migrations build
  //     INSERT INTO ${rebuildTable} (${projection}) SELECT ${projection} FROM ${T}
  // and a hole fill can only replace the HOLE — so any stand-in leaves `()`,
  // which does not parse, while `'*'` gives `(a,b,*)`, which is not a column
  // list. Dropping the group entirely yields `INSERT INTO t SELECT … FROM u`,
  // which is valid AND keeps the half that matters: the SELECT's plan.
  //
  // ⚠ Only when the hole IS the whole list. `records/store.ts` writes
  // `(publisher,…,payload_bytes,${columns})` with a matching `${placeholders}`
  // in VALUES — stubbing one without the other changes the column/value counts,
  // so that shape stays unanalysable and is reported as such rather than
  // guessed at.
  let working0 = sql;
  // ⚠ ONLY WHEN A `SELECT` FOLLOWS. Dropping the list from an
  // `INSERT INTO t (${cols}) VALUES (?)` leaves `INSERT INTO t VALUES (?)`,
  // which must then match the table's FULL arity — `contacts_fts has 2 columns
  // but 1 values were supplied`. I introduced exactly that in the first cut of
  // this rule; a SELECT source has no such count to satisfy.
  const wholeInsertList = /(\bINSERT\b[^(]*?)\(\s*\$\{[^}]*\}\s*\)(\s*SELECT\b)/i;
  let droppedInsertList = false;
  while (wholeInsertList.test(working0)) {
    working0 = working0.replace(
      wholeInsertList,
      (_m, head: string, tail: string) => head + tail,
    );
    droppedInsertList = true;
  }
  if (droppedInsertList) {
    const inner = resolveInterpolations(working0, tables, hintTables, constants);
    return { candidates: inner.candidates, partial: true };
  }

  // Fill every hole whose kind is NOT a table with a syntactically valid stand-in.
  //
  // ⛔ SKIP THE UNFILLABLE ONES, DO NOT STOP AT THEM. This used to `exec` the
  // FIRST hole and `break` when it could not be filled — so in
  //   SELECT * FROM ${tableName} ${whereClause} ${orderClause}
  // it hit the TABLE hole first, broke, and never reached the two clause holes
  // it would have classified perfectly well. All three then fell through to the
  // candidate loop below, which puts THE SAME TABLE NAME in every unresolved
  // hole — producing `… work_entity_source_sync_state work_entity_source_sync_state`
  // where a WHERE and an ORDER BY belonged.
  //
  // Every one of those statements then failed to EXPLAIN and was filed under
  // "not analysed". Measured on the real tree: 27 statements, i.e. 27 queries
  // the audit had never checked because of the order it happened to visit their
  // holes in.
  let working = sql;
  let partial = false;
  for (;;) {
    const matches = [...working.matchAll(/\$\{[^}]*\}/g)];
    const target = matches.find(
      (m) => fillForKind(holeKind(working, m.index ?? 0)) !== undefined,
    );
    if (target === undefined) break;   // only table / unknown holes left
    const at = target.index ?? 0;
    const kind = holeKind(working, at);
    const fill = fillForKind(kind)!;
    if (kind === 'predicate' || kind === 'column-list' || kind === 'clause'
        || kind === 'assignments' || kind === 'where-fragment'
        || kind === 'conjunct-fragment') partial = true;
    working = working.slice(0, at) + fill + working.slice(at + target[0].length);
  }

  const holes = [...working.matchAll(/\$\{[^}]*\}/g)].map((x) => x[0]);
  const uniqueHoles = [...new Set(holes)];
  if (uniqueHoles.length === 0) return { candidates: [working], partial };

  // ⛔ RESOLVE EXACTLY *BEFORE* APPLYING THE CAP. The `> 3` limit exists to
  // bound GUESSING — with N unresolved holes the candidate loop puts one table
  // into all of them, and past a few holes that is noise. But a statement whose
  // every hole is a KNOWN CONSTANT needs no guess at all, and the cap was
  // rejecting those unread: three statements, each naming four table constants
  // the map already held.
  const exact = uniqueHoles.map((hole) => {
    const ident = hole.slice(2, -1).trim().replace(/^this\./, '');
    return constants.get(ident);
  });
  if (exact.every((t) => t !== undefined)) {
    let filled = working;
    uniqueHoles.forEach((hole, i) => { filled = filled.split(hole).join(exact[i]!); });
    return { candidates: [filled], partial };
  }

  // The cap applies HERE — this is the guessing path.
  if (uniqueHoles.length > 3) return { candidates: [], partial };

  const candidates = [...new Set([...hintTables, ...tables])];
  const out: string[] = [];
  for (const table of candidates) {
    let filled = working;
    uniqueHoles.forEach((hole, i) => {
      filled = filled.split(hole).join(exact[i] ?? table);
    });
    out.push(filled);
  }
  return { candidates: out, partial };
};

/** Repo-wide map of `const SOME_TABLE = 'actual_table'` -> `actual_table`.
 *
 *  Table names are almost always referenced through a constant declared in a
 *  DIFFERENT file from the query, so a per-file scan finds nothing and the
 *  resolver falls back to guessing. Building this map repo-wide is what makes
 *  a `${ROW_TABLE}` hole resolvable at all. */
const CONST_RE = /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*['"`]([a-z][a-z0-9_]*)['"`]/g;

export const constantsIn = (text: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const m of text.matchAll(CONST_RE)) map.set(m[1], m[2]);
  return map;
};

/** Repo-wide fallback map. ⛔ A FILE'S OWN CONSTANTS MUST WIN OVER THIS.
 *
 *  An earlier version was this map alone, with a comment claiming last-writer-
 *  wins was safe because "collisions are the same table under two names far
 *  more often than two tables under one name". That is exactly backwards for
 *  the name that matters: `const TABLE = …` appears in a dozen store modules —
 *  `contract_store`, `shared_store`, and more — so `${TABLE}` in
 *  `shared-store.ts` resolved to whichever file happened to be walked last.
 *  The statements then failed with "no such column: value_inline", which reads
 *  like a schema problem and is really the resolver naming the wrong table. */
export const tableConstants = (files: readonly string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [k, v] of constantsIn(text)) map.set(k, v);
  }
  return map;
};

/** Tables a file plausibly targets — from literal table names mentioned in it. */
export const hintTablesFor = (
  text: string,
  tables: readonly string[],
): string[] => {
  const found = new Set<string>();
  for (const t of tables) {
    if (new RegExp(`['"\`]${t}['"\`]`).test(text)) found.add(t);
  }
  return [...found];
};

export const analyse = (
  db: Database.Database,
  queries: readonly ExtractedQuery[],
  tables: readonly string[],
  hintsByFile: ReadonlyMap<string, string[]>,
  constants: ReadonlyMap<string, string> = new Map(),
  constantsByFile: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): AnalysedQuery[] => {
  const out: AnalysedQuery[] = [];
  for (const q of queries) {
    // A file's OWN constants first, repo-wide only as fallback.
    const local = constantsByFile.get(q.file);
    const merged = local
      ? new Map<string, string>([...constants, ...local])
      : constants;
    const { candidates, partial } = resolveInterpolations(
      q.sql, tables, hintsByFile.get(q.file) ?? [], merged,
    );
    if (candidates.length === 0) {
      out.push({
        ...q, verdict: 'unresolved-interpolation', plan: [], scans: [], indexWalks: [],
        reason: 'more than three distinct `${}` holes — not a plain table name',
      });
      continue;
    }
    let analysed = false;
    let lastErr = '';
    for (const candidate of candidates) {
      // ⛔ better-sqlite3 REQUIRES bound values even for EXPLAIN — 620 of the
      // first run's 1164 failures were "Too few parameter values were
      // provided", i.e. the instrument refusing to look, reported as if the
      // statement were unanalysable. Named binds are normalised to `?` and the
      // right number of nulls is supplied.
      const normalised = normaliseNamedBinds(candidate);
      // ⚠ Multi-statement strings (`CREATE TABLE …; CREATE INDEX …`) are
      // "incomplete input" to EXPLAIN. Take the first executable statement;
      // DDL is not what this audit is about.
      const single = normalised.split(';').map((x) => x.trim()).filter((x) => x !== '')[0] ?? normalised;
      const arity = (single.match(/\?/g) ?? []).length;
      const binds = new Array<null>(arity).fill(null);
      try {
        const plan = (
          db.prepare(`EXPLAIN QUERY PLAN ${single}`).all(...binds) as PlanRow[]
        ).map((r) => r.detail);
        const { scans, indexWalks } = classifyPlan(plan);
        // ⛔ A `partial` statement had a PREDICATE or COLUMN LIST replaced with
        // a stand-in, so its plan is real SQL but not THIS query's plan — with
        // the predicate gone it will always look like a scan. Recorded as
        // analysed (it is in the denominator) with NO scans, so the instrument
        // cannot manufacture findings out of its own substitution.
        out.push({
          ...q,
          verdict: partial ? 'analysed-partial' : 'analysed',
          resolvedSql: single,
          plan,
          scans: partial ? [] : scans,
          indexWalks: partial ? [] : indexWalks,
        });
        analysed = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (!analysed) {
      // ⚠ OUT-OF-SCOPE IS CHECKED ONLY ON FAILURE, never up front. A cloud or
      // Salesforce file that happens to hold a statement this schema CAN
      // explain still gets explained — the classification describes why a
      // failure is permanent, and is not a licence to skip the file.
      const outOfScope = isOutOfScopeForServerSchema(q.file);
      out.push({
        ...q,
        verdict: outOfScope
          ? 'out-of-scope'
          : /no such table|no such column/i.test(lastErr)
            ? 'not-explainable'
            : 'explain-failed',
        plan: [], scans: [], indexWalks: [], reason: lastErr.slice(0, 160),
      });
    }
  }
  return out;
};

/** Row counts for every table, so a SCAN can be ranked by what it costs. */
export const tableSizes = (
  db: Database.Database,
  tables: readonly string[],
): Map<string, number> => {
  const sizes = new Map<string, number>();
  for (const t of tables) {
    try {
      sizes.set(
        t,
        (db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c,
      );
    } catch {
      sizes.set(t, -1);
    }
  }
  return sizes;
};

/** ⛔ CREATE THE LAZY TABLES. `chat_plans`, `execution_reports`,
 *  `case_interventions`, `hostnames` and ~10 others are created on FIRST USE,
 *  not at boot — so a schema dumped from a freshly booted server does not have
 *  them, and ~100 queries came back "no such table". Their real `CREATE TABLE`
 *  text is in the source; applying it is how those subsystems enter the
 *  denominator instead of silently leaving it. */
export const applySourceDdl = (
  db: Database.Database,
  files: readonly string[],
  constants: ReadonlyMap<string, string> = new Map(),
): number => {
  let created = 0;
  const ddl = /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIRTUAL\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[\s\S]*?;/gi;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ddl)) {
      let stmt = m[0];
      // ⛔ SUBSTITUTE THE CONSTANTS FIRST. The whole Records substrate declares
      // its DDL as `CREATE TABLE IF NOT EXISTS ${ROW_TABLE} (…)`, so skipping
      // every interpolated statement dropped `core_records`,
      // `core_record_outbox`, `core_record_namespaces` and their siblings —
      // ~100 queries reported as "no such table", i.e. a whole subsystem
      // missing from the denominator.
      for (const [ident, table] of constants) {
        stmt = stmt.split(`\${${ident}}`).join(table);
      }
      // Still interpolated ⇒ a genuinely generated table name (per-collection
      // tables like `collection_mail_<hash>`), not a fixed schema object.
      if (stmt.includes('${')) continue;
      try {
        db.exec(stmt);
        created++;
      } catch {
        // Malformed fragment or a conflicting definition. Counted by absence:
        // its queries stay in the not-explainable bucket and are reported.
      }
    }
  }
  return created;
};

/** Register a stub for every custom SQLite function the source installs.
 *
 *  ⛔ `contact-store.ts` and `work-entity-store.ts` register real functions at
 *  runtime (`db.function('phone_match_forms_json', …)`, `js_lower`). A query
 *  calling one cannot even PARSE without it, so every such statement failed
 *  with "no such function" and left the denominator — silently, and looking
 *  exactly like an un-analysable query rather than a missing test fixture.
 *
 *  ⚠ STUBS, deliberately: the analysis only ever asks for a query PLAN, and a
 *  plan does not depend on what a scalar function returns. Copying the real
 *  implementations here would be a fixture that drifts from production for no
 *  gain. */
const registerSourceFunctions = (
  db: Database.Database,
  files: readonly string[],
): void => {
  const names = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\bdb\.function\(\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)) {
      names.add(m[1]);
    }
  }
  for (const name of names) {
    try {
      db.function(name, { deterministic: true, varargs: true }, () => null);
    } catch {
      /* already registered, or a reserved name */
    }
  }
};

/** Let the REAL code create the tables whose DDL is generated rather than
 *  literal.
 *
 *  ⛔ `core_records` interpolates a PROGRAMMATICALLY BUILT column list — the
 *  slot columns (`s1..s10`, `n1..n10`, `b1..b5`, `r1..r5`, `t1..t2`) come from
 *  `Array.from(...)`, not from a table constant — so text substitution cannot
 *  reconstruct it and 24 queries stayed unanalysable.
 *
 *  ⚠ CALLED, NOT COPIED. Hand-writing the DDL here is exactly the F2 defect in
 *  miniature: a fixture shape that drifts from what production creates, with a
 *  suite that keeps passing against the wrong table. `createRecordsStore` runs
 *  `ensureSchema` internally, so the schema under analysis is by construction
 *  the schema the server builds. */
const ensureGeneratedSchemas = (db: Database.Database): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require_('../../src/records/store.js') as {
      createRecordsStore?: (db: Database.Database) => unknown;
    };
    mod.createRecordsStore?.(db);
  } catch {
    // Reported by absence: its queries stay in the not-explainable bucket with
    // "no such table: core_records", which is visible in the coverage report.
  }
};

/** Statements that no SQLite EXPLAIN against a server realm could ever read.
 *
 *  ⚠ PATH-BASED, and deliberately narrow. The alternative — detecting SOQL by
 *  syntax — would silently reclassify a real SQLite statement the day one
 *  happened to look Salesforce-ish. A directory is a fact about what the file
 *  talks to. */
const OUT_OF_SCOPE = [
  'backend/api/',                       // the cloud: a different database
  'backend/server/src/data/salesforce/', // SOQL against Salesforce objects
  // ⚠ The Pro / DDNS dev harnesses. They live under `backend/server/src/` but
  // read the CLOUD's `hostnames` table, which exists in no server realm — 8
  // statements that sat in the closable bucket permanently.
  //
  // ⚠ NARROW ON PURPOSE: two named prefixes, NOT the whole `dev/` directory.
  // `seed-bench-warehouse.ts`, `headless-client.ts` and `smtp-sink.ts` share
  // that directory and do touch server tables, and a rule that grows to cover a
  // directory because some of its files fail is how a real hole gets filed as
  // permanent.
  'backend/server/src/dev/pro-',
  'backend/server/src/dev/ddns-',
] as const;

export const isOutOfScopeForServerSchema = (file: string): boolean =>
  OUT_OF_SCOPE.some((prefix) => file.replace(/\\/g, '/').includes(prefix));

export const runQueryAudit = (dbPath: string, roots: readonly string[]): {
  analysed: AnalysedQuery[];
  tables: string[];
  sizes: Map<string, number>;
  repoRoot: string;
} => {
  const db = new Database(dbPath);
  const allFiles = sourceFiles(roots);
  const constants = tableConstants(allFiles);
  applySourceDdl(db, allFiles, constants);
  ensureGeneratedSchemas(db);
  registerSourceFunctions(db, allFiles);
  const tables = (db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>).map((r) => r.name);

  const repoRoot = process.cwd();
  const files = allFiles;
  const queries: ExtractedQuery[] = [];
  const hintsByFile = new Map<string, string[]>();
  const constantsByFile = new Map<string, ReadonlyMap<string, string>>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text)) continue;
    const rel = relative(repoRoot, file);
    hintsByFile.set(rel, hintTablesFor(text, tables));
    constantsByFile.set(rel, constantsIn(text));
    for (const q of extractQueries(rel, text)) queries.push(q);
  }
  const analysed = analyse(db, queries, tables, hintsByFile, constants, constantsByFile);
  const sizes = tableSizes(db, tables);
  db.close();
  return { analysed, tables, sizes, repoRoot };
};
