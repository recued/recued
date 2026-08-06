/** For every filtered scan, ASK SQLITE whether an index would fix it.
 *
 *  ⛔ WHY NOT JUDGE BY EYE. The previous pass sorted scan sites into "missing
 *  index" / "inherent" / "deliberate pre-narrow" by reading them. That is a
 *  hundred-odd judgement calls, each cheap to get wrong and none of them
 *  re-checked. The question is decidable: build the candidate index on a scratch
 *  copy, re-EXPLAIN, and see whether the plan changes from SCAN to SEARCH.
 *  SQLite answers; nobody has to be persuasive.
 *
 *  A proposal only appears here if it CHANGED THE PLAN. That makes the output a
 *  list of verified wins rather than a list of suspicions — and, just as
 *  usefully, everything absent from it has been checked and found to be a scan
 *  no index can help.
 *
 *  ⚠ THIS SAYS NOTHING ABOUT WHETHER THE INDEX IS WORTH IT. A plan improving on
 *  an empty bench table is not evidence the table ever grows, and every index
 *  costs write throughput and disk. The output is the shortlist to measure, not
 *  a patch to apply. */

import Database from 'better-sqlite3';

export interface IndexProposal {
  readonly table: string;
  readonly columns: readonly string[];
  /** `CREATE INDEX` statement that flipped the plan. */
  readonly ddl: string;
  readonly before: string;
  readonly after: string;
}

/** Candidate predicate expressions from a WHERE clause: bare columns and
 *  `json_extract(col, '$.path')` expressions, which need an expression index.
 *
 *  ⚠ Deliberately syntactic. A parser would be better and is not worth it —
 *  a wrong candidate simply fails to change the plan and is dropped, so the
 *  cost of a bad guess is zero and the cost of a missed one is a proposal not
 *  made. Over-generating is the safe direction. */
export const candidateExpressions = (sql: string): string[] => {
  const where = /\bWHERE\b([\s\S]*?)(?:\bGROUP\b|\bORDER\b|\bLIMIT\b|$)/i.exec(sql);
  if (!where) return [];
  const body = where[1];
  const out = new Set<string>();

  // json_extract(col, '$.path') = ? / < ? / IN (…)
  for (const m of body.matchAll(
    /json_extract\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'([^']+)'\s*\)/g,
  )) {
    out.add(`json_extract(${m[1]}, '${m[2]}')`);
  }
  // bare column compared to a bind or literal
  for (const m of body.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<=|>=|<|>|\bIN\b|\bIS\b)/gi,
  )) {
    const name = m[1];
    if (/^(and|or|not|null|in|is|where|select|from|case|when|then|else|end|coalesce|lower|upper|trim|json_extract|count|sum|distinct)$/i.test(name)) {
      continue;
    }
    out.add(name);
  }
  return [...out];
};

/** ⛔ NAMED BINDS MADE QUERIES INVISIBLE TO THIS ADVISOR. `planOf` counted `?`
 *  to size the bind array, so a statement written with `@scope` / `:id` had
 *  arity 0, `.all()` threw "Too few parameter values", `planOf` returned
 *  undefined, and `proposeIndex` bailed at its first guard — silently, and
 *  indistinguishably from "this query does not scan".
 *
 *  That is how `correction_events` kept a scope-filtered list
 *  (`WHERE scope = @scope ORDER BY event_at DESC`) with no index on `scope`
 *  and no proposal ever raised. Named binds are normalised to `?` here, the
 *  same way `query-audit.ts` already does before EXPLAIN. */
const normaliseBinds = (sql: string): string =>
  sql.replace(/[:@$][a-zA-Z_][a-zA-Z0-9_]*/g, '?');

const planOf = (
  db: Database.Database,
  sql: string,
): string | undefined => {
  const normalised = normaliseBinds(sql);
  const arity = (normalised.match(/\?/g) ?? []).length;
  try {
    return (db
      .prepare(`EXPLAIN QUERY PLAN ${normalised}`)
      .all(...new Array<null>(arity).fill(null)) as Array<{ detail: string }>)
      .map((r) => r.detail).join(' ; ');
  } catch {
    return undefined;
  }
};

const scansTable = (plan: string, table: string): boolean =>
  new RegExp(`SCAN (?:TABLE )?${table}\\b`).test(plan);

/** ⛔ `EXPLAIN QUERY PLAN` NAMES THE ALIAS, NOT THE TABLE. A query written
 *  `FROM webhook_recipe_dispatches dispatch` plans as `SCAN dispatch`, so the
 *  scan detector reported `dispatch` as the table, `CREATE INDEX … ON dispatch`
 *  threw, and the site was filed as "no index can help".
 *
 *  That mis-filing is silent and one-directional: every aliased query — joins,
 *  CTEs, correlated subqueries, which is most of the interesting SQL here —
 *  landed in the bucket that says "nothing to do". Resolving the alias back to
 *  its declaring table is what lets those be analysed at all. */
export const resolveAlias = (sql: string, alias: string): string | undefined => {
  // `FROM t AS a`, `FROM t a`, `JOIN t AS a`, `JOIN t a`
  const re = new RegExp(
    `\\b(?:FROM|JOIN)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+(?:AS\\s+)?${alias}\\b`,
    'i',
  );
  const m = re.exec(sql);
  if (m && m[1].toLowerCase() !== alias.toLowerCase()) return m[1];
  return undefined;
};

/** Try single-column then two-column indexes; return the first that flips the
 *  plan for `table` from SCAN to something else. */
export const proposeIndex = (
  db: Database.Database,
  sql: string,
  table: string,
): IndexProposal | undefined => {
  const before = planOf(db, sql);
  if (before === undefined || !scansTable(before, table)) return undefined;

  // The plan may have named an ALIAS. Index the declaring table.
  const realTable = resolveAlias(sql, table) ?? table;

  const exprs = candidateExpressions(sql);
  if (exprs.length === 0) return undefined;

  const combos: string[][] = [
    ...exprs.map((e) => [e]),
    // Pairs matter for the `status = ? AND ts < ?` shape, which is most of the
    // retention sweeps in this codebase.
    ...exprs.flatMap((a, i) => exprs.slice(i + 1).map((b) => [a, b])),
  ];

  for (const [n, cols] of combos.entries()) {
    const name = `hz_probe_${n}`;
    const ddl = `CREATE INDEX ${name} ON ${realTable} (${cols.join(', ')})`;
    try {
      db.exec(ddl);
    } catch {
      continue; // not indexable (virtual table, bad expression, unknown column)
    }
    const after = planOf(db, sql);
    db.exec(`DROP INDEX IF EXISTS ${name}`);
    if (after !== undefined && !scansTable(after, table)) {
      return {
        table: realTable,
        columns: cols,
        ddl: ddl.replace(name, `idx_${realTable}_auto`),
        before,
        after,
      };
    }
  }
  return undefined;
};

/** Why a scan is inherent. Mechanical, so the "no index can help" bucket is a
 *  classification rather than a shrug — anything that does not match a known
 *  benign shape comes back `unexplained` and is a thing to look at by hand. */
export type NoIndexReason =
  | 'whole-table-aggregate'
  | 'fts-match'
  | 'is-not-null-dominant'
  | 'leading-wildcard-like'
  | 'bound-json-path'
  | 'recursive-cte'
  | 'wrapped-expression'
  | 'or-across-columns'
  | 'unresolved-alias'
  | 'dynamic-where'
  | 'pragma-function'
  | 'ddl-or-migration'
  | 'unexplained';

export const classifyNoIndex = (sql: string, table: string): NoIndexReason => {
  const flat = sql.replace(/\s+/g, ' ');
  // ⛔ THESE THREE ARE INSTRUMENT LIMITS, NOT PROPERTIES OF THE QUERY, and
  // saying so is the point. Lumping them under "no index can help" would claim
  // a verdict the advisor never reached.
  //   - a WHERE built at runtime (`${where.sql}`) hides every predicate, so no
  //     candidate expression can be generated at all;
  //   - `pragma_table_info(?)` is a table-valued function, not a table;
  //   - a multi-statement string (migration DDL) only ever has its FIRST
  //     statement analysed.
  if (/\$\{[^}]*where[^}]*\}/i.test(sql)) return 'dynamic-where';
  if (/\bpragma_[a-z_]+\s*\(/i.test(flat)) return 'pragma-function';
  if (/;\s*(CREATE|ALTER|DROP)\b/i.test(flat)) return 'ddl-or-migration';
  if (/\bMATCH\b/i.test(flat) || /_fts\b/i.test(table)) return 'fts-match';
  if (/\bWITH\s+RECURSIVE\b/i.test(flat)) return 'recursive-cte';
  if (!/\bWHERE\b/i.test(flat)) return 'whole-table-aggregate';
  // `json_extract(col, ?)` — the PATH is a bind, so it differs per call and no
  // single expression index can cover it.
  if (/json_extract\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*[?@:]/.test(flat)) return 'bound-json-path';
  if (/LIKE\s*'%/i.test(flat) || /LIKE\s*\?\s*(?!\|\|)/i.test(flat) === false && /'%'\s*\|\|/.test(flat)) {
    return 'leading-wildcard-like';
  }
  if (/\b(LOWER|UPPER|TRIM|substr|replace)\s*\(/i.test(flat)) return 'wrapped-expression';
  if (/WHERE[^)]*\bIS\s+NOT\s+NULL\b/i.test(flat) && !/\bAND\b/i.test(flat)) {
    return 'is-not-null-dominant';
  }
  if (/\bOR\b/i.test(flat)) return 'or-across-columns';
  if (/\b(?:FROM|JOIN)\s+[A-Za-z_][A-Za-z0-9_]*\s+(?:AS\s+)?[A-Za-z_]/i.test(flat)) {
    return 'unresolved-alias';
  }
  return 'unexplained';
};
