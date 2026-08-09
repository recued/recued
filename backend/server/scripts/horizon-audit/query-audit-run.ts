/** Entry point for the whole-tree SQL audit.
 *
 *     npx tsx backend/server/scripts/horizon-audit/query-audit-run.ts <schema.db>
 *
 *  Reports COVERAGE FIRST. A sweep that analysed a fraction of the corpus and
 *  found nothing reads identically to a clean one, so the denominator is
 *  printed before any finding and every dropped statement is bucketed by why. */

import { relative, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { classifyNoIndex, proposeIndex } from './index-advisor.js';
import { makeRealTableFilter, runQueryAudit, type AnalysedQuery } from './query-audit.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: query-audit-run.ts <schema.db>');
  process.exit(2);
}

const REPO = resolve(import.meta.dirname, '../../../..');
process.chdir(REPO);

const { analysed, tables, sizes } = runQueryAudit(resolve(dbPath), [
  resolve(REPO, 'backend'),
  resolve(REPO, 'packages'),
]);

const by = (v: AnalysedQuery['verdict']): AnalysedQuery[] =>
  analysed.filter((q) => q.verdict === v);

const ok = by('analysed');
const partial = by('analysed-partial');
console.log('══ COVERAGE ══');
console.log(`  statements extracted        : ${analysed.length}`);
console.log(`  EXPLAINed (full)            : ${ok.length}`);
console.log(`  EXPLAINed (partial — a predicate/column hole was stubbed,`);
console.log(`             so NOT scan-checked)  : ${partial.length}`);
console.log(`  unresolved interpolation    : ${by('unresolved-interpolation').length}`);
console.log(`  not explainable (no table)  : ${by('not-explainable').length}`);
console.log(`  explain failed (other)      : ${by('explain-failed').length}`);
// ⚠ Reported, never silently dropped. These are statements no SQLite EXPLAIN
// against a server realm could read — cloud SQL (a different database) and SOQL
// — so counting them as coverage HOLES overstates the gap and buries the real
// holes among permanent ones. Counting them as covered would be worse.
console.log(`  out of scope (cloud / SOQL) : ${by('out-of-scope').length}`);
console.log(`  schema: ${tables.length} tables`);
console.log('');

// The schema-backed alias filter — see `makeRealTableFilter` in query-audit.ts.
const isRealTable = makeRealTableFilter(tables);

// A SCAN only matters on a table that grows. Rank by the seed's row counts
// where they are meaningful, but keep every scan visible — the bench seed is
// small, so a zero-row table today can be the hot one in production.
const scanned = new Map<string, AnalysedQuery[]>();
for (const q of ok) {
  for (const t of new Set(q.scans)) {
    if (!isRealTable(t)) continue;
    if (!scanned.has(t)) scanned.set(t, []);
    scanned.get(t)!.push(q);
  }
}

console.log('══ FULL SCANS, by table ══');
const rows = [...scanned.entries()]
  .map(([t, qs]) => ({ t, n: qs.length, size: sizes.get(t) ?? -1, qs }))
  .sort((a, b) => b.n - a.n);
for (const r of rows) {
  console.log(`  ${r.t.padEnd(38)} scans=${String(r.n).padStart(3)}  seedRows=${r.size}`);
}
console.log('');

// ⛔ CLASSIFY THE SCANS INSTEAD OF TRIAGING THEM BY HAND. The first pass of
// this audit sorted ~30 tables into "bounded" or "unavoidable aggregate" by
// reading them, which is exactly the judgement most likely to be wrong and
// least likely to be re-checked. The distinction is mechanical:
//
//   • no WHERE at all  → the query IS the whole table (SUM / COUNT / DISTINCT
//     for a quota or a blob-reference sweep). A scan is the only possible plan;
//     nothing to index.
//   • has a WHERE and STILL scans → SQLite had a predicate to narrow on and
//     could not use one. That is a missing index, and it is the finding.
//
// Reported separately so the second list is not buried in the first.
const isAggregateOverAll = (sql: string): boolean => !/\bWHERE\b/i.test(sql);
const filteredScans = ok.filter(
  (q) => q.scans.length > 0
    && q.scans.some(isRealTable)
    && !isAggregateOverAll(q.sql),
);
// ⛔ AN UNBOUNDED INDEX WALK IS ITS OWN BUCKET, neither clean nor a full scan.
//
// `SCAN t USING INDEX ix` reads the index in order rather than the table. Under
// a LIMIT that is the OPTIMAL plan for a first page — it reads LIMIT entries and
// stops — so folding it into FULL SCANS reported already-correct queries as
// findings AND made the headline total unable to move when a real scan was
// fixed into a walk. Without a LIMIT it is still O(rows), just over narrower
// rows, so it does not belong in the clean pile either.
//
// ⛔ THREE THINGS ARE EXCLUDED, each because it made the bucket unactionable
// rather than because it is uninteresting. The first cut reported 81 walks, of
// which the overwhelming majority could not be acted on at all:
//
//   1. A walk over a PARTIAL index is bounded by that index's WHERE, not by the
//      table. The very first run flagged a query the PREVIOUS COMMIT had just
//      fixed with a partial index — the instrument manufacturing a finding out
//      of its own fix, for the third time in one session.
//   2. A whole-table COUNT/SUM is inherently O(rows). NO index makes a full
//      aggregate cheaper, so reporting it is an observation about arithmetic,
//      not a finding.
//   3. The harness's own probe queries are not product code paths. They are
//      still worth knowing about — the probes run on every audit — so they are
//      counted separately rather than dropped.
const isPartialIndex = (() => {
  const db2 = new Database(resolve(dbPath), { readonly: true });
  const cache = new Map<string, boolean>();
  return (name: string): boolean => {
    if (name === '') return false;
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const row = db2.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`,
    ).get(name) as { sql: string | null } | undefined;
    const partial = /\bWHERE\b/i.test(row?.sql ?? '');
    cache.set(name, partial);
    return partial;
  };
})();
/** A COUNT/SUM over the whole table — arithmetic, not a missing index. */
const isWholeTableAggregate = (sql: string): boolean =>
  /\b(COUNT\s*\(|SUM\s*\()/i.test(sql) && !/\bWHERE\b/i.test(sql);
const isHarness = (file: string): boolean =>
  relative(REPO, file).includes('scripts/horizon-audit/');

const walkers = new Map<string, AnalysedQuery[]>();
let harnessWalks = 0;
let partialWalks = 0;
let aggregateWalks = 0;
for (const q of ok) {
  const sql = q.resolvedSql ?? q.sql;
  if (/\bLIMIT\b/i.test(sql)) continue;                       // bounded: fine
  const walked = q.indexWalks.filter((w) => isRealTable(w.table));
  if (walked.length === 0) continue;
  if (walked.every((w) => isPartialIndex(w.index))) { partialWalks += 1; continue; }
  if (isWholeTableAggregate(sql)) { aggregateWalks += 1; continue; }
  if (isHarness(q.file)) { harnessWalks += 1; continue; }
  for (const t of new Set(walked.map((w) => w.table))) {
    if (!walkers.has(t)) walkers.set(t, []);
    walkers.get(t)!.push(q);
  }
}
const walkerRows = [...walkers.entries()]
  .map(([t, qs]) => ({ t, n: qs.length, size: sizes.get(t) ?? -1, qs }))
  .sort((a, b) => b.n - a.n);
console.log(`══ UNBOUNDED INDEX WALKS — ordered read of a whole index, no LIMIT (${walkerRows.reduce((a, r) => a + r.n, 0)}) ══`);
// ⚠ EXCLUSIONS PRINTED, NEVER SILENT. A bucket that quietly drops most of what
// it looked at reads exactly like a bucket that found little.
console.log(`   (excluded: ${partialWalks} bounded by a PARTIAL index, `
  + `${aggregateWalks} whole-table COUNT/SUM, ${harnessWalks} in the audit harness itself)`);
for (const r of walkerRows) {
  console.log(`  ${r.t.padEnd(38)} walks=${String(r.n).padStart(3)}  seedRows=${r.size}`);
}
console.log('');
console.log('══ UNBOUNDED INDEX WALKS — statements ══');
for (const r of walkerRows) {
  console.log(`── ${r.t} (${r.n}) ──`);
  for (const q of r.qs) {
    console.log(
      `   ${relative(REPO, q.file)}:${q.line}  ${q.sql.replace(/\s+/g, ' ').slice(0, 130)}`,
    );
  }
}
console.log('');

console.log(`══ FILTERED SCANS — a WHERE that could not use an index (${filteredScans.length}) ══`);
for (const q of filteredScans) {
  console.log(
    `   ${relative(REPO, q.file)}:${q.line}\n      ${q.sql.replace(/\s+/g, ' ').slice(0, 150)}`,
  );
}
console.log('');

// ⛔ ASK SQLITE which of these an index would actually fix.
if (process.env.QA_ADVISE) {
  console.log('══ INDEX PROPOSALS — verified by re-EXPLAIN, not by opinion ══');
  const advDb = new Database(resolve(dbPath));
  const proposals = new Map<string, { p: NonNullable<ReturnType<typeof proposeIndex>>; sites: string[] }>();
  const noHelp: string[] = [];
  for (const q of filteredScans) {
    for (const table of new Set(q.scans)) {
      if (!isRealTable(table)) continue;
      // ⛔ THE RESOLVED SQL, not a fresh crude substitution. Replacing every
      // `${}` with the scanned table turns a join into a self-join and the
      // advisor then reasons about a query that does not exist — which is how
      // `connection-store`'s rotation-attempt join sat in the "no index can
      // help" bucket while a one-column index flips its plan.
      const analysedSql = q.resolvedSql ?? q.sql.replace(/\$\{[^}]*\}/g, table);
      const p = proposeIndex(advDb, analysedSql, table);
      const site = `${relative(REPO, q.file)}:${q.line}`;
      if (p) {
        const key = p.ddl;
        if (!proposals.has(key)) proposals.set(key, { p, sites: [] });
        proposals.get(key)!.sites.push(site);
      } else {
        // ⚠ The DDL/multi-statement check needs the RAW text: `resolvedSql` is
        // the first statement only (the split happens before EXPLAIN), so a
        // migration's trailing `CREATE INDEX` is already gone by here.
        const reason = /;\s*(CREATE|ALTER|DROP)\b/i.test(q.sql)
          ? 'ddl-or-migration'
          : classifyNoIndex(analysedSql, table);
        noHelp.push(`${reason.padEnd(22)} ${site}  [${table}]  ${q.sql.replace(/\s+/g,' ').slice(0,90)}`);
      }
    }
  }
  advDb.close();
  console.log(`  proposals: ${proposals.size} · scans no index can help: ${noHelp.length}`);
  if (process.env.QA_NOHELP) {
    console.log('\n══ NO-INDEX-HELPS — classified ══');
    const byReason = new Map<string, number>();
    for (const n of noHelp) {
      const r = n.split(/\s+/)[0];
      byReason.set(r, (byReason.get(r) ?? 0) + 1);
    }
    for (const [r, c] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(c).padStart(3)}  ${r}`);
    }
    console.log('');
    for (const n of noHelp.filter((x) => x.startsWith('unexplained'))) console.log(`   ${n}`);
  }
  for (const [, { p, sites }] of [...proposals.entries()].sort((a, b) => b[1].sites.length - a[1].sites.length)) {
    console.log(`\n  ${p.ddl};`);
    console.log(`     before: ${p.before.slice(0, 110)}`);
    console.log(`     after : ${p.after.slice(0, 110)}`);
    for (const st of sites.slice(0, 6)) console.log(`     · ${st}`);
    if (sites.length > 6) console.log(`     · … ${sites.length - 6} more sites`);
  }
  console.log('');
}

console.log('══ SCAN SITES ══');
for (const r of rows) {
  console.log(`\n── ${r.t} (${r.n}) ──`);
  for (const q of r.qs.slice(0, 40)) {
    console.log(
      `   ${relative(REPO, q.file)}:${q.line}  ${q.sql.replace(/\s+/g, ' ').slice(0, 110)}`,
    );
  }
  if (r.qs.length > 40) console.log(`   … ${r.qs.length - 40} more`);
}

/** The verdicts that represent a CLOSABLE hole — the audit should be able to
 *  read these and cannot. Excludes `analysed-partial` (analysed, just not
 *  scan-checked) and `out-of-scope` (permanently unreadable here). */
const OPAQUE = new Set(['unresolved-interpolation', 'explain-failed', 'not-explainable']);

if (process.env.QA_SAMPLE) {
  const want = process.env.QA_SAMPLE;
  const sample = analysed
    // ⚠ OPAQUE ONLY, same as the WHY block. Filtering on `!== 'analysed'`
    // showed out-of-scope statements too, so a sample of "near X" led with two
    // SOQL templates that were already classified — sending me to look at
    // something already handled.
    .filter((x) => OPAQUE.has(x.verdict) && (x.reason ?? '').includes(want))
    .slice(0, 6);
  console.log(`══ SAMPLE: ${want} ══`);
  for (const q of sample) {
    console.log(`\n── ${q.file}:${q.line}`);
    console.log(q.sql.slice(0, 300));
  }
  console.log('');
}

if (process.env.QA_WHY) {
  // ⛔ ONLY THE REAL HOLES. This filtered on `verdict !== 'analysed'`, which
  // swept in `analysed-partial` (which IS analysed — it is in the denominator,
  // just not scan-checked) and `out-of-scope` (permanently unreadable here). So
  // the top of the list was 70 partials under the reason `?` and 15
  // `no such table: hostnames` from the cloud — burying the handful of holes
  // that can actually be closed, which is the whole purpose of this block.
  const reasons = new Map<string, number>();
  for (const q of analysed.filter((x) => OPAQUE.has(x.verdict))) {
    const key = (q.reason ?? '?').replace(/"[^"]*"/g, '"X"').replace(/near ".*/, 'near X').slice(0, 90);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  console.log('══ WHY NOT ANALYSED ══');
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(4)}  ${r}`);
  }
  console.log('');
}

console.log('\n══ NOT ANALYSED (never read as clean) ══');
for (const v of ['unresolved-interpolation', 'not-explainable', 'explain-failed'] as const) {
  const list = by(v);
  if (list.length === 0) continue;
  console.log(`\n── ${v} (${list.length}) ──`);
  const byFile = new Map<string, number>();
  for (const q of list) byFile.set(q.file, (byFile.get(q.file) ?? 0) + 1);
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`   ${String(n).padStart(3)}  ${f}`);
  }
}
