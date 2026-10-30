import type Database from 'better-sqlite3';

/** A claimed owner request is never sent twice, including after a restart or
 * lost provider response. Pending receipts deliberately have no retry expiry. */
export const createCalendarEventCreationStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_event_creations (
    creation_id TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    source_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  const read = db.prepare('SELECT input_hash, source_id FROM calendar_event_creations WHERE creation_id = ?');
  const claim = db.prepare('INSERT OR IGNORE INTO calendar_event_creations (creation_id, input_hash, created_at) VALUES (?, ?, ?)');
  const complete = db.prepare('UPDATE calendar_event_creations SET source_id = ? WHERE creation_id = ? AND input_hash = ?');
  return {
    get: (id: string) => read.get(id) as { input_hash: string; source_id: string | null } | undefined,
    claim: (id: string, hash: string, now: number) => claim.run(id, hash, now).changes === 1,
    complete: (id: string, hash: string, source: string) => { complete.run(source, id, hash); },
  };
};
export type CalendarEventCreationStore = ReturnType<typeof createCalendarEventCreationStore>;
