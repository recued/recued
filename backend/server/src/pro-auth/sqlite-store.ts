/** D-148 § A.5.3 / § A.6.5 — SQLite-backed `ProAuthStore` implementation.
 *
 *  Production wiring for the substrate `ProAuthStore` interface
 *  (`./index.ts`). Persists the singleton `ProAuthState` JSON blob
 *  under the `pro_auth_state` key in the existing `server_config`
 *  (key/value) table — same pattern as `realm_token` (~bin.ts 476) and
 *  `handle_state` (101st). One row per server; pair-only scope (no
 *  cross-cloud sync — D-097 / D-168).
 *
 *  Storage shape:
 *    - `key = 'pro_auth_state'`
 *    - `value = JSON.stringify(ProAuthState)`
 *    - Absent row ↔ signed-out / never-authenticated.
 *
 *  Why plaintext in `server_config` instead of `server_vault`.
 *
 *    - The bearer is one of many secrets the server's local SQLite
 *      DB holds (`realm_token`, vault rows, sub-DEK-encrypted blobs).
 *      The DB itself is the trust boundary — root-of-trust for the
 *      server identity + the per-pair tokens that pin clients. A
 *      separate encryption layer for *this one bearer* doesn't move
 *      the threat model: an attacker with read access to the DB
 *      already has every token of consequence (per-pair bearers,
 *      cleartext realm_token).
 *    - Pair-only scope means the bearer never leaves the server —
 *      the rpc surface returns only a 4-char display fragment, and
 *      `pro_auth_state` is not part of any cross-cloud sync substrate
 *      (D-097 / D-168).
 *    - The realm_token + handle_state precedents established this
 *      pattern for the same reason (single-row, pair-only, never
 *      serialized to wire).
 *
 *  Schema discipline. The `server_config` table is created by
 *  `bin.ts` at boot; this module's factory assumes the table exists
 *  (the production composition runs after the `CREATE TABLE IF NOT
 *  EXISTS server_config` call). Tests that inject a fresh database
 *  must run the same DDL.
 *
 *  Concurrency. Better-sqlite3 is synchronous + serialised by SQLite;
 *  the state machine's `authenticate` / `signOut` is the only writer,
 *  so there is no read/write race. `save()` uses INSERT OR REPLACE so
 *  the write is atomic at the SQLite layer; `delete()` is an
 *  unconditional DELETE for the row. */

import type Database from 'better-sqlite3';
import type { ProAuthStore, ProAuthState } from './index.js';

/** The single `server_config` key the Pro auth blob lives under.
 *  Same per-pair (never-syncs) scope as `realm_token` + `handle_state`. */
export const PRO_AUTH_STATE_CONFIG_KEY = 'pro_auth_state' as const;

export interface CreateSqliteProAuthStoreOptions {
  db: Database.Database;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Runtime shape check on the persisted blob — same posture as the
 *  101st `isValidHandleState`. Loud-fail on a partially-decoded row
 *  would block boot for a recoverable condition (the next
 *  `authenticate` overwrites cleanly); silent acceptance of a junk
 *  shape would crash downstream readers like the resolver-binding
 *  closure in bin.ts that reads `state.pro_subscription_token.length`.
 *  Returning `null` for any structurally invalid blob presents "no
 *  prior state" so the state machine starts from a clean slate, and
 *  the corrupted row gets overwritten on the next `save()`. */
const isValidProAuthState = (value: unknown): value is ProAuthState => {
  if (!isPlainObject(value)) return false;
  if (typeof value.pro_subscription_token !== 'string') return false;
  if (value.pro_subscription_token.length === 0) return false;
  if (typeof value.authenticated_at !== 'number') return false;
  if (!Number.isFinite(value.authenticated_at)) return false;
  return true;
};

/** Build a SQLite-backed `ProAuthStore`. Caller must ensure the
 *  `server_config` table exists (bin.ts creates it during boot before
 *  this factory runs). */
export const createSqliteProAuthStore = (
  options: CreateSqliteProAuthStoreOptions,
): ProAuthStore => {
  const select = options.db.prepare(
    `SELECT value FROM server_config WHERE key = ?`,
  );
  const upsert = options.db.prepare(
    `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
  );
  const remove = options.db.prepare(
    `DELETE FROM server_config WHERE key = ?`,
  );

  return {
    async load(): Promise<ProAuthState | null> {
      const row = select.get(PRO_AUTH_STATE_CONFIG_KEY) as
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
      if (!isValidProAuthState(parsed)) {
        // Structurally invalid blob (missing fields / wrong types /
        // empty token). Same recovery posture as unparsable JSON
        // above — the next mutation overwrites.
        return null;
      }
      return parsed;
    },
    async save(state: ProAuthState): Promise<void> {
      upsert.run(PRO_AUTH_STATE_CONFIG_KEY, JSON.stringify(state));
    },
    async delete(): Promise<void> {
      remove.run(PRO_AUTH_STATE_CONFIG_KEY);
    },
  };
};
