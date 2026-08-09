/** Index coverage for the D-219 execution-case substrate.
 *
 *  ⛔ WHY THIS FILE EXISTS. Four store modules declare these tables and, before
 *  this, **not one of them declared a single index**. Every lookup and every
 *  cascade delete is by `root_request_id` or `report_id`, so each was a full
 *  scan — and a retention pass removing N reports did N scans, the same
 *  quadratic shape already fixed in `audit-retention`. These tables grow with
 *  chat usage, so it is invisible on a fresh install and compounds forever.
 *
 *  ⚠ Asserted as PLANS, not results. The queries always returned the right
 *  rows; only the plan was wrong. A result assertion cannot see this class of
 *  defect, which is exactly why nothing caught it.
 *
 *  ⚠ Each store is constructed through its REAL factory, not by pasting DDL
 *  here. A hand-copied schema drifts from the one production builds and the
 *  suite keeps passing against the wrong table — the F2 defect. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createCaseInterventionStore } from '../storage/case-intervention-store.js';
import { createExecutionCaseFeedbackStore } from '../storage/execution-case-feedback-store.js';
import { createExecutionCaseStore } from '../storage/execution-case-store.js';
import { createExecutionReportStore } from '../storage/execution-report-store.js';

/** Build every D-219 table through the real factories. */
const mkDb = (): Database.Database => {
  const db = new Database(':memory:');
  createExecutionReportStore(db);
  createExecutionCaseStore(db);
  createExecutionCaseFeedbackStore(db);
  createCaseInterventionStore(db);
  return db;
};

const plan = (db: Database.Database, sql: string, ...binds: unknown[]): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(' ; ');

/** table → the predicate its hot lookups and cascade deletes use. */
const BY_ROOT: ReadonlyArray<readonly [string, string]> = [
  ['execution_reports', 'root_request_id'],
  ['execution_case_observations', 'root_request_id'],
  ['execution_case_feedback', 'root_request_id'],
  ['case_interventions', 'root_request_id'],
  ['case_experiment_assignments', 'root_request_id'],
  ['case_experiment_invalid_roots', 'root_request_id'],
  ['case_experiment_turn_metrics', 'root_request_id'],
  ['execution_case_observations', 'report_id'],
  ['execution_case_sources', 'report_id'],
];

describe('D-219 execution-case index coverage', () => {
  it('every by-root / by-report lookup SEARCHes rather than scans', () => {
    const db = mkDb();
    const scanning: string[] = [];
    for (const [table, column] of BY_ROOT) {
      const p = plan(db, `SELECT * FROM ${table} WHERE ${column} = ?`, 'x');
      if (!/SEARCH/.test(p)) scanning.push(`${table}.${column} → ${p}`);
    }
    expect(scanning).toEqual([]);
    db.close();
  });

  it('every by-root / by-report DELETE SEARCHes too — that is the cascade path', () => {
    // The prune paths delete one root/report at a time. A scan here is what
    // makes removing N of them cost N full table reads.
    const db = mkDb();
    const scanning: string[] = [];
    for (const [table, column] of BY_ROOT) {
      const p = plan(db, `DELETE FROM ${table} WHERE ${column} = ?`, 'x');
      if (!/SEARCH/.test(p)) scanning.push(`${table}.${column} → ${p}`);
    }
    expect(scanning).toEqual([]);
    db.close();
  });

  it('⛔ a case lookup by governing contract SEARCHes', () => {
    // Surfaced only after the index advisor learned to normalise NAMED binds:
    // this query uses `@governing_contract_id`, so it failed to EXPLAIN and was
    // silently filed as "no index can help" for the whole sweep. 200k cases:
    // 3.55ms -> 0.38ms.
    const db = mkDb();
    expect(plan(db, `SELECT * FROM execution_cases
       WHERE governing_contract_id = ? AND principal_key = ?`, 'c', 'p'))
      .toMatch(/SEARCH execution_cases USING INDEX/);
    db.close();
  });

  it('⛔ the compiler\'s hot-path currency check reads from a COVERING index', () => {
    // `closedReportIds()` runs inside `canCompileIncrementally`, which
    // `compileReport()` calls on the CHAT TURN path. It is O(closed reports) by
    // design, but without a partial covering index it walked the primary key
    // and touched every row's sealed payload to test `closed_at`. 200k reports
    // / 115 MB: 50.5ms -> 19.9ms.
    const db = mkDb();
    const p = plan(db, `SELECT report_id FROM execution_reports
       WHERE closed_at IS NOT NULL ORDER BY report_id ASC`);
    expect(p).toMatch(/USING INDEX idx_execution_reports_closed/);
    // Covering: the table itself is never touched, and the index order means
    // no sort.
    expect(p).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it('⛔ that index is PARTIAL — an unclosed report does not enter it', () => {
    // Reports accumulate with chat usage and only some are closed. A full index
    // would make every write maintain an entry the query never reads.
    const db = mkDb();
    const ddl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE name = 'idx_execution_reports_closed'`,
    ).get() as { sql: string }).sql;
    expect(ddl).toMatch(/WHERE closed_at IS NOT NULL/);
    db.close();
  });

  it('the tables really exist — a typo would make both assertions vacuous', () => {
    // Without this, a renamed table makes EXPLAIN throw, the helper is never
    // reached, and "no scanning tables" passes for the wrong reason.
    const db = mkDb();
    const present = new Set(
      (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      ).all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const [table] of BY_ROOT) expect(present.has(table), table).toBe(true);
    db.close();
  });
});
