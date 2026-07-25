/** D-210 A.8 slice 4a — `reception_form_submission` gains the CLEAR slot.
 *
 *  The additive precondition for the slice-4 merge of
 *  `reception_booking_request` (table_a) into this table. Nothing writes the
 *  new columns yet — 4b switches the scheduling path over — so this file
 *  pins the SHAPE the switch depends on, and the two decisions inside it
 *  that are easy to get wrong later:
 *
 *    - the slot is CLEAR, not sealed into `submission_blob_encrypted`,
 *      because the follow-on capacity cap has to COUNT over it in SQL;
 *    - `form_definition_id` is NULLABLE rather than sentinel-filled,
 *      because a booking has no form definition and two live equality
 *      checks compare that column.
 *
 *  ⚠ The ALTER-then-index ordering is load-bearing and has bitten before
 *  (slice 3a): `CREATE TABLE IF NOT EXISTS` no-ops on an existing table, so
 *  an index naming a freshly-added column fails with `no such column` on any
 *  DB that already had the table. The upgrade test below drives exactly that
 *  path. */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureReceptionSchema } from '../storage/reception-store.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
}

const columns = (db: Database.Database, table: string): Map<string, ColumnInfo> =>
  new Map(
    (db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((c) => [c.name, c]),
  );

const indexes = (db: Database.Database): Set<string> =>
  new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

describe('D-210 A.8 slice 4a — the merged submission table shape', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureReceptionSchema(db);
  });

  it('carries the slot as three NULLABLE, CLEAR columns', () => {
    const cols = columns(db, 'reception_form_submission');
    for (const name of ['slot_start_at', 'slot_end_at', 'duration_minutes']) {
      const col = cols.get(name);
      expect(col, `${name} must exist`).toBeDefined();
      // NULL on every intake row — a form submission has no slot.
      expect(col!.notnull, `${name} must be nullable`).toBe(0);
      expect(col!.type).toBe('INTEGER');
    }
  });

  it('keeps the slot OUT of the sealed blob, so SQL can count over it', () => {
    // 🔑 The reason is NOT the one A.3 gives (it argues the per-day cap
    // re-checks the slot inside the insert — that query filters `received_at`
    // and no SQL predicate touches a slot column today). It is the owner's
    // follow-on capacity cap: "if a cap is reached for that timeframe/date,
    // block the submission and tell the visitor instantly." That is a COUNT
    // over the slot, impossible if the slot is sealed.
    const cols = columns(db, 'reception_form_submission');
    expect(cols.get('submission_blob_encrypted')?.notnull).toBe(1);
    // A real capacity query must PREPARE — the proof the slot is reachable
    // from SQL at all.
    expect(() =>
      db.prepare(`
        SELECT COUNT(*) AS n FROM reception_form_submission
         WHERE endpoint_id = @endpoint_id
           AND slot_start_at >= @from_at
           AND slot_start_at < @to_at
           AND processing_outcome IN ('pending', 'processed')
      `),
    ).not.toThrow();
  });

  it('indexes the slot for that cap, distinctly from the rate-limit index', () => {
    // `idx_form_submission_endpoint` is keyed on `submitted_at` and serves the
    // rolling rate limit — a different question from per-date capacity.
    const idx = indexes(db);
    expect(idx.has('idx_form_submission_slot')).toBe(true);
    expect(idx.has('idx_form_submission_endpoint')).toBe(true);
  });

  it('makes form_definition_id NULLABLE — a booking has no form definition', () => {
    // ⛔ Not a sentinel ('0' / ''). `definitionSnapshotFor` and the promotion
    // re-check both compare this column for equality, so a shared sentinel is
    // a value rows can collide on; NULL cannot collide with anything.
    expect(columns(db, 'reception_form_submission').get('form_definition_id')?.notnull).toBe(0);
  });

  it('accepts a booking-shaped row: slot set, no form definition', () => {
    // The shape 4b will write. Proves the constraints actually admit it —
    // a PRAGMA read alone would pass against a table that still refuses it.
    expect(() =>
      db
        .prepare(
          `INSERT INTO reception_form_submission
             (submission_id, endpoint_id, form_definition_id, submitted_at,
              submission_blob_encrypted, schema_version, processing_outcome,
              slot_start_at, slot_end_at, duration_minutes)
           VALUES (@id, @ep, NULL, @at, @blob, 1, 'pending', @start, @end, 60)`,
        )
        .run({
          id: 'req-1',
          ep: 'ep-1',
          at: 1_700_000_000_000,
          blob: Buffer.from('sealed'),
          start: 1_700_000_100_000,
          end: 1_700_000_100_000 + 3_600_000,
        }),
    ).not.toThrow();
  });

  it('still accepts an intake-shaped row: form definition set, no slot', () => {
    // The merge must not break the table's original tenant.
    expect(() =>
      db
        .prepare(
          `INSERT INTO reception_form_submission
             (submission_id, endpoint_id, form_definition_id, submitted_at,
              submission_blob_encrypted, schema_version, processing_outcome)
           VALUES (@id, @ep, 'form-1', @at, @blob, 1, 'pending')`,
        )
        .run({ id: 'sub-1', ep: 'ep-1', at: 1_700_000_000_000, blob: Buffer.from('sealed') }),
    ).not.toThrow();
  });

  it('⚠ UPGRADES a DB that already has the table — ALTER first, index after', () => {
    // The slice-3a trap: `CREATE TABLE IF NOT EXISTS` no-ops on an existing
    // table, so the columns must arrive by guarded ALTER and any index naming
    // one must be created AFTER. A fresh-DB test cannot see this — it has to
    // run against a table created WITHOUT the new columns.
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE reception_form_submission (
        submission_id              TEXT PRIMARY KEY,
        endpoint_id                TEXT NOT NULL,
        form_definition_id         TEXT,
        submitted_at               INTEGER NOT NULL,
        source_ip_hash             TEXT,
        visitor_email_encrypted    BLOB,
        submission_blob_encrypted  BLOB NOT NULL,
        schema_version             INTEGER NOT NULL,
        resolved_target_kind       TEXT,
        resolved_target_id         TEXT,
        processing_outcome         TEXT NOT NULL,
        metadata_blob              TEXT
      );
    `);
    expect(columns(old, 'reception_form_submission').has('slot_start_at')).toBe(false);

    expect(() => ensureReceptionSchema(old)).not.toThrow();

    const cols = columns(old, 'reception_form_submission');
    expect(cols.has('slot_start_at')).toBe(true);
    expect(cols.has('slot_end_at')).toBe(true);
    expect(cols.has('duration_minutes')).toBe(true);
    expect(indexes(old).has('idx_form_submission_slot')).toBe(true);
    old.close();
  });

  it('is idempotent — the guarded ALTER does not re-run', () => {
    expect(() => {
      ensureReceptionSchema(db);
      ensureReceptionSchema(db);
    }).not.toThrow();
    const cols = columns(db, 'reception_form_submission');
    expect([...cols.keys()].filter((n) => n === 'slot_start_at')).toHaveLength(1);
  });
});
