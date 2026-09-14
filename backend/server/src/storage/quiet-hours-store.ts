/** D-269 step 3 — persistence for the one quiet-hours window.
 *
 *  One row, fixed key. Recued is solo-owner by design and quiet hours is a fact
 *  about the person, so there is never a second window to disagree with.
 *
 *  ⚠ `read()` FILLS THE DEFAULT IN, like the kind-policy store and unlike the
 *  timezone store. "Unset" is not a state a caller must distinguish here,
 *  because the default IS the answer: disabled, which is exactly today's
 *  behaviour. */

import type Database from 'better-sqlite3';
import {
  defaultQuietHoursPolicy,
  QUIET_HOURS_APPLIES_TO,
  type QuietHoursAppliesTo,
  type QuietHoursPolicy,
} from '@recued/contracts';

const PRIMARY_KEY = 'owner';

interface Row {
  id: string;
  enabled: number;
  from_minute: number;
  to_minute: number;
  applies_to: string;
  updated_at: number;
}

export interface QuietHoursStore {
  read(): QuietHoursPolicy;
  write(patch: Partial<Omit<QuietHoursPolicy, 'updated_at'>>, now: number): QuietHoursPolicy;
  /** D-269 step 4 — the last instant a sweep OBSERVED the window active.
   *
   *  ⛔⛔ THIS IS AN EDGE DETECTOR, NOT A QUEUE, AND THE DIFFERENCE IS THE WHOLE
   *  DESIGN. It stores ONE INTEGER and no notification content: the digest is
   *  recomputed from anchor rows at release. `durable-outbox` states the test —
   *  *"would the receiver be unable to RECONSTRUCT it"* — and a reminder is
   *  fully reconstructable, so holding one would be the queue this design
   *  refuses. Knowing the window CLOSED is the one thing no anchor row records.
   *
   *  ⚠ PERSISTED, not in-process: a restart during the window would otherwise
   *  erase the edge, and the owner would simply never get the card for the
   *  night the server happened to bounce. */
  readLastActiveAt(): number | null;
  writeLastActiveAt(at: number | null): void;
}

export const ensureQuietHoursSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quiet_hours (
      id                 TEXT PRIMARY KEY,
      enabled            INTEGER NOT NULL,
      from_minute INTEGER NOT NULL,
      to_minute   INTEGER NOT NULL,
      applies_to         TEXT NOT NULL,
      updated_at         INTEGER NOT NULL,
      last_active_at     INTEGER
    )
  `);
  // ⛔ `CREATE TABLE IF NOT EXISTS` does not add a column to an existing table,
  // and D-269 step 3 shipped this one without `last_active_at`.
  const columns = db.prepare(`PRAGMA table_info(quiet_hours)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'last_active_at')) {
    db.exec(`ALTER TABLE quiet_hours ADD COLUMN last_active_at INTEGER`);
  }
};

export const createQuietHoursStore = (db: Database.Database): QuietHoursStore => {
  ensureQuietHoursSchema(db);

  const readStmt = db.prepare(`SELECT * FROM quiet_hours WHERE id = ?`);
  const readMarkerStmt = db.prepare(
    `SELECT last_active_at FROM quiet_hours WHERE id = ?`,
  );
  // ⚠ Upserts the row so the marker can be written before the owner has ever
  // touched the policy — the window can be active on a default-off server only
  // if they enabled it, but the marker must not depend on write order.
  const writeMarkerStmt = db.prepare(`
    INSERT INTO quiet_hours (id, enabled, from_minute, to_minute, applies_to, updated_at, last_active_at)
    VALUES (?, 0, 0, 0, '["notification"]', 0, ?)
    ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at
  `);
  const writeStmt = db.prepare(`
    INSERT INTO quiet_hours (id, enabled, from_minute, to_minute, applies_to, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      enabled = excluded.enabled,
      from_minute = excluded.from_minute,
      to_minute = excluded.to_minute,
      applies_to = excluded.applies_to,
      updated_at = excluded.updated_at
  `);

  const read = (): QuietHoursPolicy => {
    const row = readStmt.get(PRIMARY_KEY) as Row | undefined;
    if (!row) return defaultQuietHoursPolicy();
    // ⛔ A ROW WRITTEN BY A NEWER SERVER MAY NAME A TARGET THIS BUILD DOES NOT
    // KNOW. An unknown value is DROPPED rather than carried, because carrying it
    // would let a build that cannot enforce a policy report that it is enforced.
    // Dropping degrades to "we do not delay that", which is the truth.
    // ⚠ `'approval'` became a known value in step 5 and is kept from here on.
    let applies_to: QuietHoursAppliesTo[] = [];
    try {
      const parsed: unknown = JSON.parse(row.applies_to);
      if (Array.isArray(parsed)) {
        applies_to = parsed.filter(
          (v): v is QuietHoursAppliesTo =>
            (QUIET_HOURS_APPLIES_TO as readonly string[]).includes(v as string),
        );
      }
    } catch {
      applies_to = [];
    }
    return {
      enabled: row.enabled === 1,
      from_minute: row.from_minute,
      to_minute: row.to_minute,
      applies_to,
      updated_at: row.updated_at,
    };
  };

  return {
    read,
    readLastActiveAt() {
      const row = readMarkerStmt.get(PRIMARY_KEY) as { last_active_at: number | null } | undefined;
      return row?.last_active_at ?? null;
    },
    writeLastActiveAt(at) {
      writeMarkerStmt.run(PRIMARY_KEY, at);
    },
    write(patch, now) {
      const current = read();
      const next: QuietHoursPolicy = {
        enabled: patch.enabled ?? current.enabled,
        from_minute: patch.from_minute ?? current.from_minute,
        to_minute: patch.to_minute ?? current.to_minute,
        applies_to: patch.applies_to ?? current.applies_to,
        updated_at: now,
      };
      writeStmt.run(
        PRIMARY_KEY, next.enabled ? 1 : 0, next.from_minute, next.to_minute,
        JSON.stringify(next.applies_to), now,
      );
      return next;
    },
  };
};
