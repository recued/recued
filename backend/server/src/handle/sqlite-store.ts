/** D-148 § A.5.6 — SQLite-backed `HandleStateStore` implementation.
 *
 *  Production wiring for the substrate `HandleStateStore` interface
 *  (`./index.ts`). Persists the singleton `HandleState` JSON blob under
 *  the `handle_state` key in the existing `server_config` (key/value)
 *  table — same pattern as `realm_token`. One row per server; pair-only
 *  scope (no cross-cloud sync — D-097 / D-168).
 *
 *  Storage shape:
 *    - `key = 'handle_state'`
 *    - `value = JSON.stringify(HandleState)`
 *
 *  Why JSON-in-server_config instead of a dedicated table.
 *
 *    - The shape is small (handle + history + lifecycle stamp). A
 *      lifetime's worth of handle changes is on the order of dozens of
 *      history rows; the full blob stays well under SQLite's
 *      `SQLITE_MAX_LENGTH` (default 1 GB).
 *    - The store is singleton: there is one `current_handle` per server.
 *      A dedicated table would carry one row indefinitely.
 *    - Reusing `server_config` mirrors the existing `realm_token`
 *      discipline + skips a new `CREATE TABLE` migration.
 *
 *  Schema discipline. The `server_config` table is created by
 *  `bin.ts` at boot; this module's factory accepts an already-open
 *  `Database` handle and assumes the table exists (the production
 *  composition runs after the `CREATE TABLE IF NOT EXISTS server_config`
 *  call). Tests that inject a fresh database must run the same DDL.
 *
 *  Concurrency. Better-sqlite3 is synchronous + serialised by SQLite;
 *  the state machine's `persist()` is the only writer, so there is no
 *  read/write race. `save()` does an `INSERT OR REPLACE` so the write
 *  is atomic at the SQLite layer. */

import type Database from 'better-sqlite3';
import {
  HANDLE_SUBSCRIPTION_STATES,
  type HandleSubscriptionState,
} from '@recued/contracts';
import type { HandleStateStore, HandleState } from './index.js';

/** The single `server_config` key the handle blob lives under. Same
 *  per-pair (never-syncs) scope as `realm_token`. */
export const HANDLE_STATE_CONFIG_KEY = 'handle_state' as const;

export interface CreateSqliteHandleStateStoreOptions {
  db: Database.Database;
}

const HANDLE_SUBSCRIPTION_STATE_SET = new Set<HandleSubscriptionState>(
  HANDLE_SUBSCRIPTION_STATES,
);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Codex P2 fold #2 — runtime shape check on the persisted blob. Loud-
 *  fail on a partially-decoded row would block boot for a recoverable
 *  condition (the next `reserveInitial` overwrites cleanly); silent
 *  acceptance of a junk shape would crash downstream readers like
 *  `bin.ts` reading `state.publisher_id.length`. Returning `null` for
 *  any structurally invalid blob is the conservative middle ground —
 *  the store presents "no prior state" so the state machine starts
 *  from a clean slate, and the corrupted row gets overwritten on the
 *  next `save()`. */
const isValidHandleState = (value: unknown): value is HandleState => {
  if (!isPlainObject(value)) return false;
  if (typeof value.publisher_id !== 'string') return false;
  if (typeof value.current_handle !== 'string') return false;
  if (!Array.isArray(value.handle_history)) return false;
  if (typeof value.last_synced_at !== 'number') return false;
  const sub = value.subscription_state;
  if (typeof sub !== 'string') return false;
  if (!HANDLE_SUBSCRIPTION_STATE_SET.has(sub as HandleSubscriptionState)) {
    return false;
  }
  if (value.grace_until !== undefined && typeof value.grace_until !== 'number') {
    return false;
  }
  if (value.ddns_zone !== undefined && typeof value.ddns_zone !== 'string') {
    return false;
  }
  for (const entry of value.handle_history) {
    if (!isPlainObject(entry)) return false;
    if (typeof entry.handle !== 'string') return false;
    if (typeof entry.reserved_at !== 'number') return false;
    if (typeof entry.reason !== 'string') return false;
  }
  return true;
};

/** Build a SQLite-backed `HandleStateStore`. Caller must ensure the
 *  `server_config` table exists (bin.ts creates it during boot before
 *  this factory runs). */
export const createSqliteHandleStateStore = (
  options: CreateSqliteHandleStateStoreOptions,
): HandleStateStore => {
  const select = options.db.prepare(
    `SELECT value FROM server_config WHERE key = ?`,
  );
  const upsert = options.db.prepare(
    `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
  );

  return {
    async load(): Promise<HandleState | null> {
      const row = select.get(HANDLE_STATE_CONFIG_KEY) as
        | { value: string }
        | undefined;
      if (!row) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        // Corrupted JSON — treat as "no state". The next mutation
        // overwrites cleanly.
        return null;
      }
      if (!isValidHandleState(parsed)) {
        // Structurally invalid blob (missing fields / wrong types /
        // unknown subscription_state). Same recovery posture as
        // unparsable JSON above — the next mutation overwrites.
        return null;
      }
      return parsed;
    },
    async save(state: HandleState): Promise<void> {
      upsert.run(HANDLE_STATE_CONFIG_KEY, JSON.stringify(state));
    },
  };
};
