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
import { runQueryAudit, type AnalysedQuery } from './query-audit.js';

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
console.log(`  schema: ${tables.length} tables`);
console.log('');

// A SCAN only matters on a table that grows. Rank by the seed's row counts
// where they are meaningful, but keep every scan visible — the bench seed is
// small, so a zero-row table today can be the hot one in production.
const scanned = new Map<string, AnalysedQuery[]>();
for (const q of ok) {
  for (const t of new Set(q.scans)) {
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
    && !q.scans.every((t) => t === 'sqlite_master' || t === 'CONSTANT' || t === 'json_each')
    && !isAggregateOverAll(q.sql),
);
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
      if (table === 'sqlite_master' || table === 'CONSTANT' || table === 'json_each') continue;
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

if (process.env.QA_SAMPLE) {
  const want = process.env.QA_SAMPLE;
  const sample = analysed
    .filter((x) => x.verdict !== 'analysed' && (x.reason ?? '').includes(want))
    .slice(0, 6);
  console.log(`══ SAMPLE: ${want} ══`);
  for (const q of sample) {
    console.log(`\n── ${q.file}:${q.line}`);
    console.log(q.sql.slice(0, 300));
  }
  console.log('');
}

if (process.env.QA_WHY) {
  const reasons = new Map<string, number>();
  for (const q of analysed.filter((x) => x.verdict !== 'analysed')) {
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
