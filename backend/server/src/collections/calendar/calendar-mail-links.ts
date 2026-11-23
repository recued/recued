import type Database from 'better-sqlite3';
import { savedWorkLinks, type SavedWorkAddress } from '@recued/contracts';

/** A derived index of explicit links, never subjects, guests or thread guesses.
 * It is updated inside the calendar row's existing write transaction. */
export const createCalendarMailLinkIndex = (db: Database.Database, table: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(table)) throw new Error('Invalid calendar table.');
  const name = table + '_mail_links';
  const insert = () => db.prepare(`INSERT OR IGNORE INTO ${name}
    (record_id, client, mail_slug, mail_record_id) VALUES (?, ?, ?, ?)`);
  const fill = (recordId: string, description: string) => {
    const statement = insert();
    for (const link of savedWorkLinks(description)) if (link.kind === 'mail') {
      statement.run(recordId, link.client, link.collection_slug!, link.id);
    }
  };
  db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (
      record_id TEXT NOT NULL, client TEXT NOT NULL, mail_slug TEXT NOT NULL, mail_record_id TEXT NOT NULL,
      PRIMARY KEY (record_id, client, mail_slug, mail_record_id));
      CREATE INDEX IF NOT EXISTS ${name}_target ON ${name} (mail_slug, mail_record_id, client, record_id);
      CREATE TRIGGER IF NOT EXISTS ${name}_delete AFTER DELETE ON ${table}
        BEGIN DELETE FROM ${name} WHERE record_id = OLD.record_id; END;`);
    if (!exists) {
      const page = db.prepare(`SELECT record_id, record_payload FROM ${table} WHERE record_id > ? ORDER BY record_id LIMIT 500`);
      let after = '';
      for (;;) {
        const rows = page.all(after) as Array<{ record_id: string; record_payload: string }>;
        if (!rows.length) break;
        for (const row of rows) {
          const event = JSON.parse(row.record_payload) as { description?: string };
          fill(row.record_id, event.description ?? '');
        }
        after = rows[rows.length - 1]!.record_id;
      }
    }
  }).immediate();
  const remove = db.prepare(`DELETE FROM ${name} WHERE record_id = ?`);
  const query = db.prepare(`SELECT c.* FROM ${table} c WHERE c.record_id IN
    (SELECT record_id FROM ${name} WHERE mail_slug = ? AND mail_record_id = ? AND client IN ('', ?))
    ORDER BY c.modified_at DESC, c.record_id ASC LIMIT ?`);
  return {
    replace(recordId: string, description: string) { remove.run(recordId); fill(recordId, description); },
    list(target: SavedWorkAddress, limit: number): unknown[] {
      if (target.kind !== 'mail' || !target.collection_slug || !Number.isSafeInteger(limit) || limit < 1) return [];
      return query.all(target.collection_slug, target.id, target.client, limit);
    },
    drop() { db.exec(`DROP TRIGGER IF EXISTS ${name}_delete; DROP TABLE IF EXISTS ${name}`); },
  };
};
