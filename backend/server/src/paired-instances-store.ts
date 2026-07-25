/** Durable roster of extensions ever paired with this server.
 *
 *  Separate from the in-memory `clients` map on `WsServerHandle` — that
 *  only knows about currently-connected WebSockets. For the "replace
 *  device" UX (old device is dead / offline / stolen, user picks it
 *  from a list to revoke + replace), we need a durable list that
 *  survives disconnects and restarts.
 *
 *  Schema (all rows scoped by user_id — one server can serve multiple
 *  user accounts only in the Cloud-hosted variant; self-hosted has
 *  exactly one user):
 *
 *    paired_instances (
 *      instance_id  TEXT PRIMARY KEY,
 *      user_id      TEXT NOT NULL,
 *      display_name TEXT NOT NULL,
 *      added_at     INTEGER NOT NULL,   -- unix seconds
 *      revoked_at   INTEGER,             -- null = currently paired
 *      preferences  TEXT                 -- JSON-encoded Partial<InstancePrefs>
 *                                        -- mirrored from the paired ext's
 *                                        -- chrome.storage via prefs.set rpc
 *                                        -- (pair-scoped, pair-rpc/storage path).
 *                                        -- Missing keys fall back to
 *                                        -- DEFAULT_INSTANCE_PREFS per
 *                                        -- applyPrefsPatch.
 *    )
 *
 *  Semantics:
 *    - First successful `register` for an instance_id inserts the row.
 *    - `pair.revoke(instance_id)` stamps `revoked_at = now`; the row
 *      isn't deleted so "list paired + revoked" can still show history
 *      in the UI. Subsequent register attempts from a revoked
 *      instance_id are rejected (caller must explicitly re-pair as a
 *      new instance).
 *    - `pair.replace(old, new)` revokes `old` and inserts/upserts
 *      `new` in the same transaction.
 *
 *  The Go heartbeat aggregator remains authoritative for "currently
 *  online" — this store is authoritative for "ever paired, not yet
 *  revoked." Union of the two is what the extension's device-picker
 *  UI consumes.
 */

import type Database from 'better-sqlite3';
import {
  applyPrefsPatch,
  type InstancePrefs,
} from '@recued/contracts';
import { isClientKind, type ClientKind } from './pairing/client-tokens.js';

/** Legacy rows (paired before the `kind` column landed) carry NULL —
 *  default them to the historical hard-coded surface so the roster
 *  renders unchanged. */
const DEFAULT_PAIRED_KIND: ClientKind = 'webclient';

export interface PairedInstance {
  instance_id: string;
  user_id: string;
  display_name: string;
  /** Client surface this device paired as (D-156 P10). NULL legacy rows
   *  resolve to `DEFAULT_PAIRED_KIND`. */
  kind: ClientKind;
  added_at: number;    // unix seconds
  revoked_at: number | null;
}

export interface PairedInstancesStore {
  /** All paired rows for a user, including revoked (ordered by added_at). */
  listAll(user_id: string): PairedInstance[];
  /** Only currently-paired (revoked_at IS NULL). */
  listActive(user_id: string): PairedInstance[];
  /** Every currently-paired row across ALL users (revoked_at IS NULL),
   *  ordered by added_at. Cross-user-scoped like `revokeAllActive` — the
   *  realm is bound by the recovery key, not user_id — for surfaces that
   *  describe the whole-server roster without a per-user context (e.g. the
   *  server passport's clients block, whose composer holds no canonical
   *  user_id). */
  listAllActive(): PairedInstance[];
  get(instance_id: string): PairedInstance | null;
  /** Upsert on first register; caller has already validated the
   *  instance_id isn't a revoked one. `kind` is optional — a kind-less
   *  refresh (legacy / db-less register) preserves any kind already
   *  recorded (COALESCE) rather than clobbering it to the default. */
  addOrRefresh(row: { instance_id: string; user_id: string; display_name: string; kind?: ClientKind; now?: number }): PairedInstance;
  /** Mark revoked. Returns the row before mutation (null if unknown).
   *  Does NOT delete — history is preserved for audit + UI. */
  revoke(instance_id: string, now?: number): PairedInstance | null;
  /** Shortcut for the replace flow: revoke old + add/refresh new, atomic. */
  replace(args: {
    old_instance_id: string;
    new_instance_id: string;
    user_id: string;
    new_display_name: string;
    new_kind?: ClientKind;
    now?: number;
  }): { revoked: PairedInstance | null; added: PairedInstance };
  /** True if this instance_id exists AND revoked_at IS NOT NULL. Used to
   *  reject register attempts from a retired device. */
  isRevoked(instance_id: string): boolean;
  /** Mark every active row revoked. Returns the instance_ids of the
   *  rows that were mutated (empty array when no row was active).
   *  Callers: the free-tier recover-pair flow (with maxInstances=1 the
   *  caller is taking over the slot from whoever held it, so the whole
   *  roster gets cleared in one shot) AND the D-148 § A.6.5 engine-
   *  driven `server_identity_key` rotation path (every paired client
   *  needs to re-pair against the rotated identity; the engine wraps
   *  the ids into `revoked_client_ids` for the audit row + bus replay).
   *  Cross-user-scoped — the realm itself is bound by the recovery
   *  key (or the rotation surface), not by user_id. */
  revokeAllActive(now?: number): string[];
  /** Merged view of this instance's preferences — stored patch applied
   *  over `DEFAULT_INSTANCE_PREFS`. Returns defaults when the row is
   *  missing or its `preferences` column is null (default-on behavior
   *  so a pairing with no handshake yet still syncs L2 cache normally). */
  getPrefs(instance_id: string): InstancePrefs;
  /** Merge a partial patch into the stored preferences (keys absent
   *  from `patch` keep their current value). Unknown keys and wrong-
   *  typed values are discarded at the contracts layer. Returns the
   *  merged result. Creating-side call: when no row exists yet the
   *  patch is dropped and defaults are returned — pairing must insert
   *  the row first. */
  setPrefs(instance_id: string, patch: Partial<InstancePrefs>): InstancePrefs;
  /** D-137 P2 § A.4 Codex P1 fold — most-recently-added active
   *  instance's effective prefs, or `undefined` when no pair exists.
   *  Used to surface user-level INSTANCE_PREFS toggles (like
   *  `chat.scope_sources.*`) to server-side handlers that don't have
   *  a per-dispatch `instance_id` to key on. Single-user warehouse
   *  invariant (one human identity per server) makes "any active
   *  pair's prefs" semantically correct — every pair belongs to the
   *  same Mary, so toggle values converge after one Settings-rpc
   *  write per device. */
  firstActivePrefs(): InstancePrefs | undefined;
}

export const createPairedInstancesStore = (db: Database.Database): PairedInstancesStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paired_instances (
      instance_id  TEXT NOT NULL PRIMARY KEY,
      user_id      TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind         TEXT,
      added_at     INTEGER NOT NULL,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS paired_instances_user_idx
      ON paired_instances (user_id);
  `);

  // Additive migrations. SQLite rejects `ADD COLUMN IF NOT EXISTS`, so we
  // introspect first and add only when absent. Safe on upgrade: existing
  // rows get NULL and behave as the documented default —
  //   `preferences` → DEFAULT_INSTANCE_PREFS apply (pair-scoped JSON blob);
  //   `kind`        → DEFAULT_PAIRED_KIND (the historical hard-coded
  //                   'webclient' surface, so the roster renders unchanged).
  const existingColumns = (
    db.prepare(`PRAGMA table_info(paired_instances)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!existingColumns.includes('preferences')) {
    db.exec(`ALTER TABLE paired_instances ADD COLUMN preferences TEXT`);
  }
  if (!existingColumns.includes('kind')) {
    db.exec(`ALTER TABLE paired_instances ADD COLUMN kind TEXT`);
  }

  const selectAllByUser = db.prepare(`
    SELECT * FROM paired_instances WHERE user_id = ? ORDER BY added_at ASC
  `);
  const selectActiveByUser = db.prepare(`
    SELECT * FROM paired_instances
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY added_at ASC
  `);
  const selectAllActive = db.prepare(`
    SELECT * FROM paired_instances
    WHERE revoked_at IS NULL
    ORDER BY added_at ASC
  `);
  const selectOne = db.prepare(`
    SELECT * FROM paired_instances WHERE instance_id = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO paired_instances (instance_id, user_id, display_name, kind, added_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(instance_id) DO UPDATE SET
      display_name = excluded.display_name,
      user_id      = excluded.user_id,
      -- A kind-less refresh (excluded.kind IS NULL) keeps the recorded
      -- kind rather than wiping it back to NULL/default.
      kind         = COALESCE(excluded.kind, paired_instances.kind),
      revoked_at   = NULL
  `);
  const markRevoked = db.prepare(`
    UPDATE paired_instances SET revoked_at = ? WHERE instance_id = ?
  `);
  const selectPrefs = db.prepare(`
    SELECT preferences FROM paired_instances WHERE instance_id = ?
  `);
  // D-137 P2 § A.4 Codex P1 fold — newest non-revoked row across
  // every user. Single-user-server invariant makes the user
  // discriminator redundant; ORDER BY added_at DESC returns the
  // most-recently-paired device, whose prefs reflect the freshest
  // Settings-rpc write.
  const selectFirstActivePrefs = db.prepare(`
    SELECT preferences FROM paired_instances
    WHERE revoked_at IS NULL
    ORDER BY added_at DESC
    LIMIT 1
  `);
  const updatePrefs = db.prepare(`
    UPDATE paired_instances SET preferences = ? WHERE instance_id = ?
  `);
  const replaceTxn = db.transaction((args: {
    old_instance_id: string;
    new_instance_id: string;
    user_id: string;
    new_display_name: string;
    new_kind: ClientKind | null;
    now: number;
  }) => {
    markRevoked.run(args.now, args.old_instance_id);
    upsert.run(args.new_instance_id, args.user_id, args.new_display_name, args.new_kind, args.now);
  });

  const rowToRecord = (row: unknown): PairedInstance => {
    const r = row as {
      instance_id: string;
      user_id: string;
      display_name: string;
      kind: string | null;
      added_at: number;
      revoked_at: number | null;
    };
    return {
      instance_id: r.instance_id,
      user_id: r.user_id,
      display_name: r.display_name,
      kind: isClientKind(r.kind) ? r.kind : DEFAULT_PAIRED_KIND,
      added_at: r.added_at,
      revoked_at: r.revoked_at,
    };
  };

  return {
    listAll(user_id) {
      return (selectAllByUser.all(user_id) as unknown[]).map(rowToRecord);
    },
    listActive(user_id) {
      return (selectActiveByUser.all(user_id) as unknown[]).map(rowToRecord);
    },
    listAllActive() {
      return (selectAllActive.all() as unknown[]).map(rowToRecord);
    },
    get(instance_id) {
      const row = selectOne.get(instance_id);
      return row ? rowToRecord(row) : null;
    },
    addOrRefresh({ instance_id, user_id, display_name, kind, now }) {
      const ts = now ?? Math.floor(Date.now() / 1000);
      upsert.run(instance_id, user_id, display_name, kind ?? null, ts);
      return rowToRecord(selectOne.get(instance_id));
    },
    revoke(instance_id, now) {
      const before = selectOne.get(instance_id);
      if (!before) return null;
      const ts = now ?? Math.floor(Date.now() / 1000);
      markRevoked.run(ts, instance_id);
      return rowToRecord(before);
    },
    replace({ old_instance_id, new_instance_id, user_id, new_display_name, new_kind, now }) {
      const ts = now ?? Math.floor(Date.now() / 1000);
      const oldBefore = selectOne.get(old_instance_id);
      replaceTxn({ old_instance_id, new_instance_id, user_id, new_display_name, new_kind: new_kind ?? null, now: ts });
      return {
        revoked: oldBefore ? rowToRecord(oldBefore) : null,
        added: rowToRecord(selectOne.get(new_instance_id)),
      };
    },
    revokeAllActive(now) {
      const ts = now ?? Math.floor(Date.now() / 1000);
      // Capture-then-update inside a single transaction so the returned
      // id list matches the rows actually mutated even under concurrent
      // pair / unpair activity. SQLite's better-sqlite3 binding is
      // synchronous so the transaction wrapper is enough — no row that
      // appears in the SELECT can transition to revoked between the
      // SELECT and the UPDATE without the transaction also seeing it.
      const txn = db.transaction((cutoff: number) => {
        const ids = (db
          .prepare(`SELECT instance_id FROM paired_instances WHERE revoked_at IS NULL`)
          .all() as Array<{ instance_id: string }>).map((r) => r.instance_id);
        if (ids.length === 0) return [] as string[];
        db.prepare(`UPDATE paired_instances SET revoked_at = ? WHERE revoked_at IS NULL`).run(cutoff);
        return ids;
      });
      return txn(ts);
    },

    isRevoked(instance_id) {
      const row = selectOne.get(instance_id) as { revoked_at: number | null } | undefined;
      return !!row && row.revoked_at !== null;
    },

    getPrefs(instance_id) {
      const row = selectPrefs.get(instance_id) as { preferences: string | null } | undefined;
      const stored = parsePrefsBlob(row?.preferences);
      return applyPrefsPatch(stored, {});
    },

    setPrefs(instance_id, patch) {
      const row = selectPrefs.get(instance_id) as { preferences: string | null } | undefined;
      if (!row) {
        // No paired row yet. Drop the patch to avoid orphan preference
        // blobs — the register path is the only place that inserts.
        return applyPrefsPatch({}, {});
      }
      const current = parsePrefsBlob(row.preferences);
      const merged = applyPrefsPatch(current, patch as Record<string, unknown>);
      updatePrefs.run(JSON.stringify(merged), instance_id);
      return merged;
    },

    firstActivePrefs() {
      const row = selectFirstActivePrefs.get() as
        | { preferences: string | null }
        | undefined;
      if (!row) return undefined;
      return applyPrefsPatch(parsePrefsBlob(row.preferences), {});
    },
  };
};

/** Parse a persisted prefs blob. Corrupt or non-object JSON → empty
 *  (= defaults apply via applyPrefsPatch). */
const parsePrefsBlob = (raw: string | null | undefined): Partial<InstancePrefs> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Partial<InstancePrefs>;
    }
  } catch {
    // fall through
  }
  return {};
};
