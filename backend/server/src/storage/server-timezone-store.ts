/** D-269 step 1 — persistence for the server's own timezone setting.
 *
 *  One row, fixed primary key — the same shape as `housekeeping_config`, and for
 *  the same reason: Recued is solo-owner by design, so "per server" and "per
 *  owner" are the same row and there is never a second one to disagree with.
 *
 *  ⛔ THE ROW IS ABSENT UNTIL THE OWNER SAYS SOMETHING, AND THAT IS MEANINGFUL.
 *  `read()` returns `null` rather than a seeded default, because "unset" is a
 *  state callers must be able to see: a wall-clock feature refuses to arm on it
 *  (`isServerTimeZoneConfigured`), while the chat clock degrades past it to the
 *  host zone. Seeding a default here would collapse those two into one and hand
 *  quiet hours a zone nobody chose.
 *
 *  ⚠ `zone` SURVIVES A SWITCH TO `follows_host`. Storing it as NULL on the way
 *  through would silently discard what the owner typed, so a laptop owner who
 *  tries `follows_host` and changes their mind gets their zone back. */

import type Database from 'better-sqlite3';
import type { ServerTimeZoneMode, ServerTimeZoneSetting } from '@recued/contracts';

/** Single-row table; the key is a constant so the row cannot multiply. */
const PRIMARY_KEY = 'server';

interface Row {
  id: string;
  mode: string;
  zone: string | null;
  updated_at: number;
}

export interface ServerTimeZoneStore {
  /** The stored setting, or `null` when the owner has never set one. */
  read(): ServerTimeZoneSetting | null;
  /** Upsert. Returns what was written, so a handler answers without re-reading. */
  write(mode: ServerTimeZoneMode, zone: string | null, now: number): ServerTimeZoneSetting;
}

export const ensureServerTimeZoneSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_timezone (
      id         TEXT PRIMARY KEY,
      mode       TEXT NOT NULL,
      zone       TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
};

export const createServerTimeZoneStore = (db: Database.Database): ServerTimeZoneStore => {
  ensureServerTimeZoneSchema(db);

  const readStmt = db.prepare(`SELECT * FROM server_timezone WHERE id = ?`);
  const writeStmt = db.prepare(`
    INSERT INTO server_timezone (id, mode, zone, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      zone = excluded.zone,
      updated_at = excluded.updated_at
  `);

  return {
    read(): ServerTimeZoneSetting | null {
      const row = readStmt.get(PRIMARY_KEY) as Row | undefined;
      if (!row) return null;
      // ⚠ `mode` is read back as a bare string. A row written by a NEWER server
      // with a mode this build does not know must not become an unhandled value
      // that silently resolves as `fixed` with a zone nobody meant — so an
      // unrecognised mode is treated as the deployment-neutral one and the
      // caller's `isValidIanaZone` guard decides from there.
      const mode: ServerTimeZoneMode = row.mode === 'follows_host' ? 'follows_host' : 'fixed';
      return { mode, zone: row.zone, updated_at: row.updated_at };
    },

    write(mode: ServerTimeZoneMode, zone: string | null, now: number): ServerTimeZoneSetting {
      writeStmt.run(PRIMARY_KEY, mode, zone, now);
      return { mode, zone, updated_at: now };
    },
  };
};
