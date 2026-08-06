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
  | 'not-explainable';

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
  readonly scans: readonly string[];
  readonly reason?: string;
}

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

/** Pull every template-literal / quoted string that looks like SQL, with its
 *  1-based line number. Deliberately dumb and deliberately over-inclusive:
 *  a false candidate fails to EXPLAIN and is COUNTED as such, whereas a missed
 *  one is invisible. Over-inclusion is the safe direction. */
export const extractQueries = (file: string, text: string): ExtractedQuery[] => {
  const out: ExtractedQuery[] = [];
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
  | 'unknown';

const CLAUSE_NAME_RE = /(where|order|group|having|limit|clause|filter|sort|predicate)/i;

export const holeKind = (sql: string, index: number): HoleKind => {
  const before = sql.slice(Math.max(0, index - 60), index);
  const after = sql.slice(index);
  const nameM = /^\$\{([^}]*)\}/.exec(after);
  const ident = nameM ? nameM[1] : '';
  if (/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+"?$/i.test(before)) return 'table';
  if (/\bIN\s*\($/i.test(before)) return 'in-list';
  if (/\b(WHERE|AND|OR)\s+$/i.test(before)) return 'predicate';
  if (/\bSELECT\s+$/i.test(before)) return 'column-list';
  if (/\bORDER\s+BY\s+$/i.test(before)) return 'order-by';
  // Name-based, checked AFTER every positional rule so a hole in a real
  // keyword slot is never mistaken for a clause.
  if (CLAUSE_NAME_RE.test(ident)) return 'clause';
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

  // Fill every hole whose kind is NOT a table with a syntactically valid stand-in.
  let working = sql;
  let partial = false;
  for (;;) {
    const m = /\$\{[^}]*\}/.exec(working);
    if (!m) break;
    const kind = holeKind(working, m.index);
    const fill = fillForKind(kind);
    if (fill === undefined) break; // a table (or unknown) hole — handled below
    if (kind === 'predicate' || kind === 'column-list' || kind === 'clause') partial = true;
    working = working.slice(0, m.index) + fill + working.slice(m.index + m[0].length);
  }

  const holes = [...working.matchAll(/\$\{[^}]*\}/g)].map((x) => x[0]);
  const uniqueHoles = [...new Set(holes)];
  if (uniqueHoles.length === 0) return { candidates: [working], partial };
  if (uniqueHoles.length > 3) return { candidates: [], partial };

  const exact = uniqueHoles.map((hole) => {
    const ident = hole.slice(2, -1).trim().replace(/^this\./, '');
    return constants.get(ident);
  });
  if (exact.every((t) => t !== undefined)) {
    let filled = working;
    uniqueHoles.forEach((hole, i) => { filled = filled.split(hole).join(exact[i]!); });
    return { candidates: [filled], partial };
  }

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
        ...q, verdict: 'unresolved-interpolation', plan: [], scans: [],
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
      const normalised = candidate.replace(/[:@$][a-zA-Z_][a-zA-Z0-9_]*/g, '?');
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
        const scans = plan
          .map((d) => /^SCAN (?:TABLE )?([A-Za-z0-9_]+)/.exec(d)?.[1])
          .filter((t): t is string => t !== undefined);
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
        });
        analysed = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    if (!analysed) {
      out.push({
        ...q,
        verdict: /no such table|no such column/i.test(lastErr)
          ? 'not-explainable'
          : 'explain-failed',
        plan: [], scans: [], reason: lastErr.slice(0, 160),
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
