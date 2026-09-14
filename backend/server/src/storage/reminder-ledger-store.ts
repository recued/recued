/** D-269 — which reminders have already been sent.
 *
 *  ⛔⛔ PERSISTED, NOT IN-PROCESS, AND THE REASON IS THE DIFFERENCE BETWEEN AN
 *  EVENT AND A NOTIFICATION. The due-status sweep dedups tasks with an
 *  in-process Map and can afford to: a re-emit after a restart is absorbed by
 *  the warehouse bus's 60s per-(record, kind) dedup window and by recipe-side
 *  reactive dedup. **A notification has no such absorber.** A restart during the
 *  two hours before a booking would simply ping the owner a second time, and a
 *  reminder that repeats itself is the one people switch off.
 *
 *  ⚠ THE KEY CARRIES THE ANCHOR (`kind:id:anchor_at`), so a rescheduled booking
 *  re-arms by construction rather than being swallowed by the mark from its old
 *  slot. Keyed on the id alone, moving a meeting would silently cost its
 *  reminder — see `reminderMarkKey`. */

import type Database from 'better-sqlite3';
import type { ReminderLedger } from '../work-entity-reminder-sweep.js';

export const ensureReminderLedgerSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_ledger (
      mark_key  TEXT PRIMARY KEY,
      anchor_at INTEGER NOT NULL,
      sent_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminder_ledger_anchor_idx
      ON reminder_ledger (anchor_at);
  `);
};

export const createReminderLedgerStore = (db: Database.Database): ReminderLedger => {
  ensureReminderLedgerSchema(db);
  const hasStmt = db.prepare(`SELECT 1 FROM reminder_ledger WHERE mark_key = ?`);
  const setStmt = db.prepare(`
    INSERT INTO reminder_ledger (mark_key, anchor_at, sent_at)
    VALUES (?, ?, ?)
    ON CONFLICT(mark_key) DO NOTHING
  `);
  const pruneStmt = db.prepare(`DELETE FROM reminder_ledger WHERE anchor_at < ?`);

  return {
    has: (key) => hasStmt.get(key) !== undefined,
    // ⚠ `DO NOTHING`, not an upsert: the first send is the one that happened,
    // and re-stamping `sent_at` would erase the evidence of when.
    set: (key, anchor_at) => { setStmt.run(key, anchor_at, Date.now()); },
    // ⛔ Pruned by ANCHOR, not by `sent_at`. A mark is needed exactly as long as
    // its row can still be inside the reminder horizon; deleting on send-age
    // would drop a mark for an event still to come and remind about it twice.
    prune: (before) => { pruneStmt.run(before); },
  };
};
