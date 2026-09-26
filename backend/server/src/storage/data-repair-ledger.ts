/** D-308 — the ledger of one-off data repairs.
 *
 *  A repair corrects rows that a defect already wrote. It runs once per server,
 *  at the first boot of the release that carries it, and this table is how it
 *  knows it ran. The row is written in the SAME transaction as the repair's own
 *  writes, so a crash leaves both or neither.
 *
 *  `noticed_at` sits apart because telling the owner is not part of that
 *  transaction: the notice goes to the notification history after the commit,
 *  and a boot that finds a repair with no notice delivers it then.
 *
 *  `summary` is the durable record of what the repair did — every row it
 *  changed, and every row it left for the owner. */

import type Database from 'better-sqlite3';

export const DATA_REPAIRS_TABLE = 'data_repairs';

export interface DataRepairRecord {
  readonly repair_id: string;
  readonly applied_at: number;
  readonly summary: unknown;
  readonly noticed_at: number | null;
}

export interface DataRepairLedger {
  get(repair_id: string): DataRepairRecord | null;
  /** ⛔ Throws when the repair is already recorded. A second apply is a bug to
   *  surface, never a no-op to absorb: it would mean the guard above it failed. */
  record(input: { readonly repair_id: string; readonly applied_at: number; readonly summary: unknown }): void;
  markNoticed(repair_id: string, at: number): void;
}

interface DataRepairRow {
  readonly repair_id: string;
  readonly applied_at: number;
  readonly summary: string;
  readonly noticed_at: number | null;
}

export const ensureDataRepairSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DATA_REPAIRS_TABLE} (
      repair_id   TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL,
      summary     TEXT NOT NULL,
      noticed_at  INTEGER
    )`);
};

export const createDataRepairLedger = (db: Database.Database): DataRepairLedger => {
  ensureDataRepairSchema(db);
  const getStmt = db.prepare(`SELECT * FROM ${DATA_REPAIRS_TABLE} WHERE repair_id = ?`);
  const insertStmt = db.prepare(
    `INSERT INTO ${DATA_REPAIRS_TABLE} (repair_id, applied_at, summary, noticed_at)
     VALUES (?, ?, ?, NULL)`,
  );
  const noticedStmt = db.prepare(
    `UPDATE ${DATA_REPAIRS_TABLE} SET noticed_at = ? WHERE repair_id = ? AND noticed_at IS NULL`,
  );
  return {
    get(repair_id) {
      const row = getStmt.get(repair_id) as DataRepairRow | undefined;
      return row === undefined ? null : { ...row, summary: JSON.parse(row.summary) as unknown };
    },
    record({ repair_id, applied_at, summary }) {
      insertStmt.run(repair_id, applied_at, JSON.stringify(summary));
    },
    markNoticed(repair_id, at) {
      noticedStmt.run(at, repair_id);
    },
  };
};
