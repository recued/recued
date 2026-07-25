/** D-117 Phase 8 — per-recipe `changed_since` cursor storage.
 *
 *  The `calendar-watcher` handler's `changed_since` mode advances a
 *  per-recipe high-watermark on every successful fire: the latest
 *  `modified_at` observed on the emitted rows (or the tick's `now` when
 *  no rows matched — keeps the cursor moving instead of re-scanning
 *  already-seen events forever).
 *
 *  The spec (D-117 §load-bearing decision 9) calls out
 *  `prefs.calendar.watcher.<recipe_id>` as the storage path. The
 *  `prefs` sync-namespace is pair-scoped and today carries a fixed,
 *  strongly-typed boolean registry (see `packages/contracts/src/prefs.ts`).
 *  A per-recipe cursor keyed by a dynamic `recipe_id` doesn't fit that
 *  registry shape, and server-side watcher ticks don't flow through an
 *  `instance_id` the pair-prefs handler could attribute cursors to.
 *  The constant `CALENDAR_WATCHER_CURSOR_PREFIX` is preserved for
 *  forward compatibility — this table stores its rows under that
 *  prefix as a plain string key, so a future refactor that funnels
 *  watcher cursors through the prefs envelope can re-use the same key
 *  shape.
 *
 *  The semantic requirements from the spec — "per-pair, survives
 *  restart, doesn't sync to cloud" — hold: the table lives in the
 *  per-server SQLite DB, is never included in any cloud sync transport,
 *  and its keys are recipe-scoped so a pair with multiple extensions
 *  still advances the same cursor from every tick.
 */

import type Database from 'better-sqlite3';

import { CALENDAR_WATCHER_CURSOR_PREFIX } from '@recued/contracts';

export interface CalendarWatcherCursorStore {
  /** Read a recipe's persisted `changed_since` cursor. Returns `null`
   *  when the recipe has never fired a successful tick. */
  get(recipe_id: string): number | null;
  /** Write a recipe's new cursor. Overwrites any prior value — the
   *  watcher hands the new high-watermark on every successful tick. */
  set(recipe_id: string, last_seen_at: number): void;
  /** Drop a recipe's cursor. Called on recipe deletion so stale rows
   *  don't accumulate. */
  clear(recipe_id: string): void;
}

const keyFor = (recipe_id: string): string =>
  `${CALENDAR_WATCHER_CURSOR_PREFIX}${recipe_id}`;

export const createCalendarWatcherCursorStore = (
  db: Database.Database,
): CalendarWatcherCursorStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_watcher_cursors (
      key              TEXT PRIMARY KEY,
      last_seen_at     INTEGER NOT NULL
    );
  `);

  const getStmt = db.prepare(
    'SELECT last_seen_at FROM calendar_watcher_cursors WHERE key = ?',
  );
  const setStmt = db.prepare(`
    INSERT INTO calendar_watcher_cursors (key, last_seen_at)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `);
  const deleteStmt = db.prepare(
    'DELETE FROM calendar_watcher_cursors WHERE key = ?',
  );

  return {
    get(recipe_id) {
      const row = getStmt.get(keyFor(recipe_id)) as
        | { last_seen_at: number }
        | undefined;
      return row ? row.last_seen_at : null;
    },
    set(recipe_id, last_seen_at) {
      setStmt.run(keyFor(recipe_id), last_seen_at);
    },
    clear(recipe_id) {
      deleteStmt.run(keyFor(recipe_id));
    },
  };
};
