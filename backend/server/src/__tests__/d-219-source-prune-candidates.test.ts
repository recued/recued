/** The retention sweep's candidate set: same answer, without opening the corpus.
 *
 *  ⛔ THE DEFECT. `pruneSourcesOlderThan` built its candidate set by calling
 *  `reportStore.listAll()` — which opens FOUR AEAD-sealed fields per report —
 *  plus `caseStore.listAll()` and a `sourceReportIds()` call per case, then
 *  filtered in JS. It runs on a DAILY interval and on a healthy server finds
 *  nothing, so the cost was O(corpus) per tick, forever, in exchange for no
 *  work. Surfaced by the horizon audit's optimization pass: "an IDLE tick
 *  full-scans execution_reports".
 *
 *  ⚠ EQUIVALENCE IS THE POINT, NOT SPEED. A faster candidate query that
 *  selects a DIFFERENT set either strands rows forever (harmless-looking) or
 *  deletes a report a materialized case rests on (data loss, and the pruner's
 *  own comment calls that out: "retention that eats what it is retaining is
 *  amnesia"). So the first test re-implements the OLD JS filter and asserts the
 *  two agree over a corpus built to contain every interesting case.
 *
 *  ⚠ The stores are built through their REAL factories with a REAL key
 *  provider. With no provider `sealD214Json` merely base64-encodes, so a
 *  provider-less fixture would exercise a decrypt path that never runs in
 *  production — and the cost this change removes is precisely the decryption. */

import { randomBytes } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createExecutionCaseStore } from '../storage/execution-case-store.js';
import {
  createExecutionReportStore,
  type ExecutionReportStore,
  type StoredExecutionReport,
} from '../storage/execution-report-store.js';
import { sealD214Json, type D214KeyProvider } from '../storage/d214-sealed-json.js';

const KEY = randomBytes(32);
// ⚠ `D214KeyProvider` is a plain `() => Uint8Array | null`, not an object
// with a `getKey`. A `{ getKey }` shape typechecks through a cast and then
// throws `provider is not a function` at runtime — the cast doing exactly
// the hiding it is warned about elsewhere in this repo.
const keyProvider: D214KeyProvider = () => KEY;

interface Fixture {
  db: Database.Database;
  reports: ExecutionReportStore;
  caseStore: ReturnType<typeof createExecutionCaseStore>;
}

const mk = (): Fixture => {
  const db = new Database(':memory:');
  // ⚠ CASE STORE FIRST. The candidate query names the case tables, so building
  // the report store first is exactly the construction-order hazard the lazy
  // prepare exists for — and this fixture would be the thing that caught it.
  const caseStore = createExecutionCaseStore(db, keyProvider);
  const reports = createExecutionReportStore(db, keyProvider);
  return { db, reports, caseStore };
};

const putReport = async (
  f: Fixture,
  report_id: string,
  reported_at: number,
  closed_at?: number,
): Promise<void> => {
  await f.reports.putImmutable({
    report_id,
    execution_span_id: `span-${report_id}`,
    root_request_id: `root-${report_id}`,
    session_id: 'sess',
    governing_contract_id: 'contract',
    policy_fingerprint: 'fp',
    root_request: `request text for ${report_id}`,
    first_event_id: 'e1',
    last_event_id: 'e2',
    model_claim: 'fulfilled',
    open_items: [],
    consulted_case_keys: [],
    reported_at,
    ...(closed_at !== undefined ? { closed_at } : {}),
  });
};

/** A materialized case that rests on `report_id`: a case row plus its source
 *  join.
 *
 *  ⚠ `payload_encrypted` is SEALED FOR REAL. A literal placeholder passes the
 *  INSERT and then makes `caseStore.listAll()` throw
 *  `InvalidCharacterError` — inside the oracle, so the equivalence test failed
 *  for a fixture reason that looked like a product one. */
const supportWith = async (
  f: Fixture, case_id: string, report_id: string,
): Promise<void> => {
  const payload = await sealD214Json({ case_id }, 'case-payload', case_id, keyProvider);
  f.db.prepare(`
    INSERT INTO execution_cases (
      case_id, case_key, governing_contract_id, principal_key,
      request_shape_hash, policy_fingerprint, compiler_version,
      superseded_by, first_seen_at, last_seen_at, payload_encrypted)
    VALUES (?, ?, 'contract', 'user_self', 'hash', 'fp', 1, NULL, 0, 0, ?)
  `).run(case_id, `key-${case_id}`, payload);
  f.db.prepare(
    `INSERT INTO execution_case_sources (case_id, report_id) VALUES (?, ?)`,
  ).run(case_id, report_id);
};

/** The OLD filter, verbatim in shape — listAll + a JS predicate over the
 *  supporting set. Kept here as the oracle the SQL must match. */
const oldCandidateSet = async (f: Fixture, before: number): Promise<string[]> => {
  const [stored, cases] = await Promise.all([
    f.reports.listAll(),
    f.caseStore.listAll(),
  ]);
  const supporting = new Set<string>();
  for (const row of cases) {
    for (const id of f.caseStore.sourceReportIds(row.case_id)) supporting.add(id);
  }
  return (stored as StoredExecutionReport[])
    .filter((s) =>
      !supporting.has(s.report.report_id)
      && (s.closed_at ?? s.report.reported_at) < before)
    .map((s) => s.report.report_id)
    .sort();
};

const BEFORE = 1_000_000;

describe('D-219 source-prune candidate set', () => {
  it('⛔ agrees with the JS filter it replaces, case for case', async () => {
    const f = mk();
    // old + unsupported            → doomed
    await putReport(f, 'r-old-free', 10);
    // old + closed old             → doomed (ages from closed_at)
    await putReport(f, 'r-old-closed', 10, 20);
    // old reported, closed RECENTLY → survives: closed_at wins over reported_at
    await putReport(f, 'r-old-but-closed-late', 10, BEFORE + 5);
    // recent + unsupported         → survives on age
    await putReport(f, 'r-recent-free', BEFORE + 100);
    // old + SUPPORTED              → survives on support
    await putReport(f, 'r-old-supported', 10);
    await supportWith(f, 'case-1', 'r-old-supported');
    // old + supported by a case that ALSO backs another report
    await putReport(f, 'r-old-supported-2', 10);
    await supportWith(f, 'case-2', 'r-old-supported-2');

    const fresh = f.reports.unsupportedIdsOlderThan(BEFORE).sort();
    expect(fresh).toEqual(await oldCandidateSet(f, BEFORE));
    // ...and it is not vacuous in either direction.
    expect(fresh).toEqual(['r-old-closed', 'r-old-free']);
    f.db.close();
  });

  it('⛔ never returns a report a materialized case rests on', async () => {
    // The failure that matters. Stated separately from the equivalence test so
    // it survives a future rewrite of the oracle.
    const f = mk();
    for (let i = 0; i < 20; i++) await putReport(f, `r-${i}`, 10);
    for (let i = 0; i < 20; i += 2) await supportWith(f, `case-${i}`, `r-${i}`);

    const doomed = new Set(f.reports.unsupportedIdsOlderThan(BEFORE));
    for (let i = 0; i < 20; i += 2) {
      expect(doomed.has(`r-${i}`), `r-${i} is supported`).toBe(false);
    }
    expect(doomed.size).toBe(10);
    f.db.close();
  });

  it('⛔ ignores a source row whose case is GONE — the join is defence in depth', async () => {
    // ⚠ THE FK IS ACTUALLY ENFORCED. The first version of this test inserted an
    // orphan directly and got `SqliteError: FOREIGN KEY constraint failed`,
    // which corrected the claim on `unsupportedIdsOlderThan`: the join is not
    // fixing a live gap, it is covering the case where enforcement is OFF — a
    // restored, migrated, or externally-written database, where a stale source
    // row would otherwise protect a report forever.
    //
    // So the orphan is created with enforcement off, which is the only way it
    // can exist at all, and the query is then asked to ignore it.
    const f = mk();
    await putReport(f, 'r-orphan-source', 10);
    f.db.pragma('foreign_keys = OFF');
    f.db.prepare(
      `INSERT INTO execution_case_sources (case_id, report_id) VALUES (?, ?)`,
    ).run('case-that-does-not-exist', 'r-orphan-source');
    f.db.pragma('foreign_keys = ON');

    expect(f.reports.unsupportedIdsOlderThan(BEFORE)).toEqual(['r-orphan-source']);
    f.db.close();
  });

  it('opens NO sealed payload — that is the whole saving', async () => {
    // ⚠ Asserted by denying the key. `openD214Json` with a provider always
    // decrypts, so if the candidate path touched a sealed field it would throw
    // here. A timing assertion could not tell "fast" from "cached".
    const f = mk();
    await putReport(f, 'r-1', 10);
    await putReport(f, 'r-2', 10);

    const exploding = createExecutionReportStore(f.db, () => {
      throw new Error('sealed payload was opened');
    });

    expect(exploding.unsupportedIdsOlderThan(BEFORE)).toEqual(['r-1', 'r-2']);
    // Control: the OLD path really does need the key, so the assertion above
    // is discriminating rather than trivially true.
    await expect(exploding.listAll()).rejects.toThrow();
    f.db.close();
  });

  it('an empty corpus returns nothing rather than throwing', async () => {
    const f = mk();
    expect(f.reports.unsupportedIdsOlderThan(BEFORE)).toEqual([]);
    f.db.close();
  });
});
