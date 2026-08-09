/** Three scans the horizon SQL audit could only see once its schema dump
 *  stopped losing the WAL.
 *
 *  ⛔ WHAT WAS SCANNING, measured at 100k rows:
 *
 *    reception_form_submission.listForOwner   18.3ms -> 0.0ms   (+ sort gone)
 *    chat_messages.reconcileAbandonedPending   2.8ms -> 0.0ms
 *    execution_case_observations by case_key   2.6ms -> 0.0ms
 *    execution_case_observations keyless count 1.7ms -> 0.0ms
 *
 *  🔑 `(@x IS NULL OR col = @x)` IS UNINDEXABLE BY CONSTRUCTION and both the
 *  reception and chat queries use it. A plan cannot depend on whether a bound
 *  value is null, so no index will ever narrow that predicate. It is not a
 *  defect — one prepared shape across every filter combination is worth more
 *  than a per-combination plan — but it does mean the fix has to come from
 *  somewhere else: the ORDER BY for reception, and a partial index on the OTHER
 *  conjunct for chat.
 *
 *  ⚠ WHAT WAS NOT FIXED, deliberately. `form_response`'s boot backfills
 *  (`WHERE updated_at = 0`, `WHERE source_content_hash = ''`) also scan, on
 *  every boot. A partial index removes the scan — measured 2.0ms -> 0.0ms — and
 *  is still the wrong trade: it would be maintained on every write forever to
 *  save two milliseconds once per start, on statements that match nothing after
 *  their first run. Recorded here so the next sweep does not re-litigate it.
 *
 *  ⚠ AND WHAT WAS NEVER A DEFECT. `form_response.list`, `listSummaries` and
 *  `reception_inbox_subview.list` are reported as scans by the audit because
 *  their plans contain the word SCAN — but `SCAN … USING INDEX` under a LIMIT
 *  reads LIMIT entries off the top of an index and stops. That is the optimal
 *  plan for a first page, and `form_response`'s cursored page already SEEKs. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureChatSchema } from '../storage/chat-store.js';
import { ensureExecutionCaseSchema } from '../storage/execution-case-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

/** `EXPLAIN QUERY PLAN` for `sql`, against a schema built by the store's own
 *  `ensure…` function — never a CREATE TABLE written here, which would prove
 *  only that the TEST's schema has an index. */
const planFor = (
  ensure: (db: Database.Database) => void,
  sql: string,
  args: unknown,
  drop?: string,
): string => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  ensure(db);
  if (drop !== undefined) db.exec(`DROP INDEX ${drop}`);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(args as never) as Array<{ detail: string }>;
  db.close();
  return rows.map((r) => r.detail).join(' ; ');
};

/** The three statements, copied from their stores. Kept verbatim so a divergence
 *  between this file and the product shows up as a plan that stops matching. */
const OWNER_LIST = `SELECT * FROM reception_form_submission
   WHERE (@endpoint_id IS NULL OR endpoint_id = @endpoint_id)
     AND (@outcome IS NULL OR processing_outcome = @outcome)
     AND (
       @want_booking IS NULL
       OR (@want_booking = 1 AND slot_start_at IS NOT NULL)
       OR (@want_booking = 0 AND slot_start_at IS NULL)
     )
   ORDER BY submitted_at DESC, submission_id DESC
   LIMIT @limit`;

const PENDING_SOURCES = `SELECT session_id, message_id
    FROM chat_messages
   WHERE source_lifecycle = 'pending'
     AND (@session_id IS NULL OR session_id = @session_id)`;

const OBS_BY_KEY = `SELECT observation_id, report_id, payload_encrypted
    FROM execution_case_observations
   WHERE case_key IN (?, ?)
   ORDER BY observed_at ASC, observation_id ASC`;

const KEYLESS_COUNT =
  `SELECT COUNT(*) AS n FROM execution_case_observations WHERE case_key IS NULL`;

describe('newly-visible scan fixes', () => {
  it('⛔ the owner submission list walks an index instead of sorting the table', () => {
    const plan = planFor(ensureReceptionSchema, OWNER_LIST,
      { endpoint_id: null, outcome: null, want_booking: null, limit: 50 });
    expect(plan).not.toMatch(/TEMP B-TREE/);
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_form_submission_submitted/);
  });

  it('⛔ KNOWN NEGATIVE: without idx_form_submission_submitted it sorts again', () => {
    const plan = planFor(ensureReceptionSchema, OWNER_LIST,
      { endpoint_id: null, outcome: null, want_booking: null, limit: 50 },
      'idx_form_submission_submitted');
    expect(plan).toMatch(/TEMP B-TREE/);
  });

  it('⛔ the pending-source reconcile SEEKS the partial index', () => {
    // This runs once per call on the recall path and again on every session
    // delete, and used to read every row in the message table.
    const plan = planFor(ensureChatSchema, PENDING_SOURCES, { session_id: null });
    expect(plan).toMatch(/idx_chat_messages_pending_source/);
  });

  it('⛔ KNOWN NEGATIVE: without the partial index it scans every message', () => {
    const plan = planFor(ensureChatSchema, PENDING_SOURCES, { session_id: null },
      'idx_chat_messages_pending_source');
    expect(plan).toMatch(/SCAN chat_messages/);
    expect(plan).not.toMatch(/USING INDEX/);
  });

  it('⛔ the partial index still serves the call that DOES pass a session', () => {
    // `deleteSession` binds a real id. The `(@x IS NULL OR …)` conjunct stays a
    // residual either way, so the index has to earn its keep on the OTHER
    // conjunct — which is exactly what makes it partial rather than composite.
    const plan = planFor(ensureChatSchema, PENDING_SOURCES, { session_id: 'sess-1' });
    expect(plan).toMatch(/idx_chat_messages_pending_source/);
  });

  it('⛔ observations by case_key SEEK', () => {
    const plan = planFor(ensureExecutionCaseSchema, OBS_BY_KEY, ['a', 'b']);
    expect(plan).toMatch(/SEARCH .*USING (COVERING )?INDEX idx_exec_case_obs_case_key/);
  });

  it('⛔ KNOWN NEGATIVE: without it, a keyed read scans the observation table', () => {
    const plan = planFor(ensureExecutionCaseSchema, OBS_BY_KEY, ['a', 'b'],
      'idx_exec_case_obs_case_key');
    expect(plan).toMatch(/SCAN execution_case_observations/);
  });

  it('⛔ the SAME index covers the keyless count — NULLs are indexed', () => {
    // Worth pinning: the count reads `WHERE case_key IS NULL`, and it is easy to
    // assume a separate partial index is needed for it. SQLite indexes NULLs, so
    // the keyless rows are the leading edge of the same b-tree.
    const plan = planFor(ensureExecutionCaseSchema, KEYLESS_COUNT, []);
    expect(plan).toMatch(/USING COVERING INDEX idx_exec_case_obs_case_key/);
  });

  it('⛔ KNOWN NEGATIVE: without it the keyless count scans', () => {
    const plan = planFor(ensureExecutionCaseSchema, KEYLESS_COUNT, [],
      'idx_exec_case_obs_case_key');
    expect(plan).toMatch(/SCAN execution_case_observations/);
  });

  it('⛔ the case_key index survives BOTH schema ages — fresh and migrated', () => {
    // ⛔ THE TRAP THIS EXISTS FOR, hit while writing this file. `case_key`
    // arrives on `execution_case_observations` by ALTER, and I first declared
    // its index beside the CREATE TABLE. `CREATE INDEX IF NOT EXISTS` still
    // resolves its column list, so on a FRESH database that throws `no such
    // column: case_key` — and it is inside the boot's schema-ensure, so the
    // server does not start. A database that had already been migrated would
    // have booted fine, which is why the only schema that shows it is one that
    // has never run.
    //
    // Both ages asserted, because fixing it in one direction can break the
    // other: created too late and an existing database never gets the index.
    const fresh = new Database(':memory:');
    expect(() => ensureExecutionCaseSchema(fresh)).not.toThrow();
    const hasIndex = (db: Database.Database): boolean => db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?`,
    ).get('idx_exec_case_obs_case_key') !== undefined;
    expect(hasIndex(fresh), 'fresh database').toBe(true);
    fresh.close();

    // ...and running it twice is a no-op, not a second failure.
    const twice = new Database(':memory:');
    ensureExecutionCaseSchema(twice);
    expect(() => ensureExecutionCaseSchema(twice)).not.toThrow();
    expect(hasIndex(twice), 'second ensure').toBe(true);
    twice.close();
  });

  it('the pending index is PARTIAL, not a plain composite', () => {
    // The shape is the point: `pending` is transient, so the index holds the few
    // in-flight rows rather than one entry per message ever written, and a row
    // leaves it when it settles. A "simplification" to a plain
    // (source_lifecycle, session_id) index would quietly make it grow forever.
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const sql = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`,
    ).get('idx_chat_messages_pending_source') as { sql: string }).sql;
    expect(sql).toMatch(/WHERE\s+source_lifecycle\s*=\s*'pending'/);
    db.close();
  });
});
