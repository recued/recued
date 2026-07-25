/** Phase 7 (D-110 + D-111) — DB-backed instance configuration store.
 *
 *  Every `data.{platform}.{slug}` pairing on this server lives as one
 *  row in `collection_instances`. TOML is the operator-concern surface
 *  (`db_path`, ports, bootstrap pairing); per-instance config + cached
 *  caps + auth_state all live here — so user-facing Add / Edit /
 *  Remove actions flow through the extension UI + the enroll rpc
 *  family, never by hand-editing TOML.
 *
 *  `config_json` carries adapter-specific knobs (path for fs, bucket
 *  + credentials for s3, polling cadence, etc.). Secrets inside this
 *  JSON are expected to be encrypted at-rest via the existing
 *  @recued/crypto sub-DEK wrapper (same pattern mail/oauth tokens
 *  use — see collections/mail/oauth.ts). The store itself treats the
 *  column as opaque bytes; callers opt into encryption by wrapping
 *  sensitive fields before `upsert`.
 *
 *  `caps_json` is the serialized `FileCollectionCaps` produced at
 *  enroll time by the adapter's `probeCaps()`. Cached so parseRecipe
 *  doesn't need to touch the adapter on every install — re-probe is
 *  a background task (`collection.file.resync`).
 *
 *  `auth_state` is separated from `caps_json` so runtime token
 *  expiry flips one column without rewriting the cached caps. The
 *  effective caps at dispatch time are `caps AND auth_state ===
 *  'healthy'` (enforced in the engine's gating layer, not the store).
 */

import type Database from 'better-sqlite3';
import type {
  CollectionAuthState,
  CollectionCaps,
  CollectionPlatform,
} from '@recued/contracts';

const TABLE = 'collection_instances';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    platform           TEXT NOT NULL,
    slug               TEXT NOT NULL,
    adapter_type       TEXT NOT NULL,
    config_json        TEXT NOT NULL,
    caps_json          TEXT NOT NULL,
    auth_state         TEXT NOT NULL,
    last_synced_at     INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    backfill_complete  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (platform, slug)
  );

  CREATE INDEX IF NOT EXISTS idx_${TABLE}_platform
    ON ${TABLE} (platform);

  CREATE INDEX IF NOT EXISTS idx_${TABLE}_auth_state
    ON ${TABLE} (auth_state);
`;

const hasColumn = (db: Database.Database, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
};

const AUTH_STATES: readonly CollectionAuthState[] = [
  'healthy',
  'expired',
  'unauthorized',
  'degraded',
];

const isAuthState = (v: string): v is CollectionAuthState =>
  (AUTH_STATES as readonly string[]).includes(v);

export interface CollectionInstanceRecord<Caps = CollectionCaps> {
  platform: CollectionPlatform;
  slug: string;
  adapter_type: string;
  /** Adapter-specific config. Callers parse + validate per adapter;
   *  the store treats it as opaque JSON so new adapters don't need
   *  store changes. Secret fields should be encrypted before arrival
   *  — the store never encrypts on callers' behalf. */
  config: Record<string, unknown>;
  caps: Caps;
  auth_state: CollectionAuthState;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
  /** D-124 Phase 2.1 — denormalized "initial backfill drain done" bool.
   *  Source of truth stays the adapter's cursor (gcal `nextSyncToken`,
   *  graph `deltaLink`, gmail `historyId`, etc.); this column is the
   *  fast emit-side lookup the trigger fan-out uses to suppress events
   *  while the source adapter is still draining its initial window.
   *  Adapter flips it via `markBackfillComplete` exactly once when the
   *  cursor first becomes stable. `upsert` preserves the value across
   *  routine config / caps / auth_state updates; only `markBackfillComplete`
   *  writes it. */
  backfill_complete: boolean;
}

export interface CollectionInstanceStore {
  /** Insert-or-replace by `(platform, slug)`. `created_at` preserved
   *  on replace — only `updated_at` moves forward on updates.
   *  `backfill_complete` is NOT a caller input — it's preserved across
   *  updates and defaults to `false` on insert. Adapters write it via
   *  `markBackfillComplete` at their cursor-stable-persist site. */
  upsert(
    record: Omit<
      CollectionInstanceRecord,
      'created_at' | 'updated_at' | 'backfill_complete'
    >,
  ): CollectionInstanceRecord;
  get(
    platform: CollectionPlatform,
    slug: string,
  ): CollectionInstanceRecord | null;
  /** Every row. Callers that care about filtering pass a platform. */
  list(platform?: CollectionPlatform): CollectionInstanceRecord[];
  delete(platform: CollectionPlatform, slug: string): boolean;
  /** Narrow write for the sync loop — updates auth_state +
   *  last_synced_at without touching caps / config. Returns the
   *  updated row or `null` when the `(platform, slug)` pair is
   *  unknown. */
  updateAuthState(
    platform: CollectionPlatform,
    slug: string,
    patch: { auth_state: CollectionAuthState; last_synced_at?: number },
  ): CollectionInstanceRecord | null;
  /** Narrow write for the re-probe background job — replaces caps +
   *  marks the row refreshed. */
  updateCaps(
    platform: CollectionPlatform,
    slug: string,
    caps: CollectionCaps,
  ): CollectionInstanceRecord | null;
  /** D-124 Phase 2.1 — flip `backfill_complete` to true. Idempotent —
   *  adapters call this once at their cursor-stable-persist site, and a
   *  second call after restart (where the cursor is already stable) is
   *  a no-op write. Returns the updated row or `null` when the
   *  `(platform, slug)` pair is unknown. */
  markBackfillComplete(
    platform: CollectionPlatform,
    slug: string,
  ): CollectionInstanceRecord | null;
}

export interface CreateInstanceStoreOptions {
  db: Database.Database;
  /** Test hook. Production leaves at `Date.now`. */
  now?: () => number;
}

const parseRow = (row: {
  platform: string;
  slug: string;
  adapter_type: string;
  config_json: string;
  caps_json: string;
  auth_state: string;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
  backfill_complete: number;
}): CollectionInstanceRecord => {
  const auth_state = isAuthState(row.auth_state) ? row.auth_state : 'healthy';
  return {
    platform: row.platform as CollectionPlatform,
    slug: row.slug,
    adapter_type: row.adapter_type,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    caps: JSON.parse(row.caps_json) as CollectionCaps,
    auth_state,
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    backfill_complete: row.backfill_complete === 1,
  };
};

export const createInstanceStore = (
  opts: CreateInstanceStoreOptions,
): CollectionInstanceStore => {
  const { db, now = () => Date.now() } = opts;
  db.exec(SCHEMA);
  // D-124 Phase 2.1 — idempotent ALTER for DBs that pre-date the
  // backfill_complete column. CREATE TABLE IF NOT EXISTS skips the
  // column on existing tables; this ensures every boot lands a row
  // with the column present. Default 0 (false) preserves the
  // safest-flush semantics for old rows: trigger fan-out stays
  // suppressed until the adapter completes its first drain after
  // upgrade.
  if (!hasColumn(db, 'backfill_complete')) {
    db.exec(
      `ALTER TABLE ${TABLE} ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // upsert preserves backfill_complete on UPDATE — only an explicit
  // markBackfillComplete writes the column. INSERT path takes the
  // column's DEFAULT 0 (FALSE).
  const upsertStmt = db.prepare(`
    INSERT INTO ${TABLE} (
      platform, slug, adapter_type,
      config_json, caps_json,
      auth_state, last_synced_at,
      created_at, updated_at
    )
    VALUES (
      @platform, @slug, @adapter_type,
      @config_json, @caps_json,
      @auth_state, @last_synced_at,
      @created_at, @updated_at
    )
    ON CONFLICT (platform, slug) DO UPDATE SET
      adapter_type   = excluded.adapter_type,
      config_json    = excluded.config_json,
      caps_json      = excluded.caps_json,
      auth_state     = excluded.auth_state,
      last_synced_at = excluded.last_synced_at,
      updated_at     = excluded.updated_at
  `);

  const getStmt = db.prepare(`
    SELECT platform, slug, adapter_type, config_json, caps_json,
           auth_state, last_synced_at, created_at, updated_at,
           backfill_complete
      FROM ${TABLE}
     WHERE platform = ? AND slug = ?
  `);

  const listAllStmt = db.prepare(`
    SELECT platform, slug, adapter_type, config_json, caps_json,
           auth_state, last_synced_at, created_at, updated_at,
           backfill_complete
      FROM ${TABLE}
     ORDER BY created_at ASC
  `);
  const listByPlatformStmt = db.prepare(`
    SELECT platform, slug, adapter_type, config_json, caps_json,
           auth_state, last_synced_at, created_at, updated_at,
           backfill_complete
      FROM ${TABLE}
     WHERE platform = ?
     ORDER BY created_at ASC
  `);

  const deleteStmt = db.prepare(
    `DELETE FROM ${TABLE} WHERE platform = ? AND slug = ?`,
  );

  const updateAuthStmt = db.prepare(`
    UPDATE ${TABLE}
       SET auth_state     = @auth_state,
           last_synced_at = COALESCE(@last_synced_at, last_synced_at),
           updated_at     = @updated_at
     WHERE platform = @platform AND slug = @slug
  `);

  const updateCapsStmt = db.prepare(`
    UPDATE ${TABLE}
       SET caps_json  = @caps_json,
           updated_at = @updated_at
     WHERE platform = @platform AND slug = @slug
  `);

  const markBackfillStmt = db.prepare(`
    UPDATE ${TABLE}
       SET backfill_complete = 1,
           updated_at        = @updated_at
     WHERE platform = @platform AND slug = @slug
  `);

  return {
    upsert(record) {
      const ts = now();
      const existing = getStmt.get(record.platform, record.slug) as
        | { created_at: number }
        | undefined;
      const created_at = existing ? existing.created_at : ts;
      upsertStmt.run({
        platform: record.platform,
        slug: record.slug,
        adapter_type: record.adapter_type,
        config_json: JSON.stringify(record.config ?? {}),
        caps_json: JSON.stringify(record.caps),
        auth_state: record.auth_state,
        last_synced_at: record.last_synced_at,
        created_at,
        updated_at: ts,
      });
      // Re-read so the returned record reflects the persisted
      // backfill_complete (preserved on update, DEFAULT 0 on insert) —
      // the caller's input deliberately omits the column.
      const stored = this.get(record.platform, record.slug);
      if (!stored) {
        // Should be unreachable — we just wrote the row.
        throw new Error(
          `instance-store.upsert: row vanished after write: ${record.platform}/${record.slug}`,
        );
      }
      return stored;
    },
    get(platform, slug) {
      const row = getStmt.get(platform, slug) as Parameters<typeof parseRow>[0] | undefined;
      return row ? parseRow(row) : null;
    },
    list(platform) {
      const rows = (platform
        ? listByPlatformStmt.all(platform)
        : listAllStmt.all()) as Parameters<typeof parseRow>[0][];
      return rows.map(parseRow);
    },
    delete(platform, slug) {
      const res = deleteStmt.run(platform, slug);
      return res.changes > 0;
    },
    updateAuthState(platform, slug, patch) {
      const ts = now();
      const res = updateAuthStmt.run({
        platform,
        slug,
        auth_state: patch.auth_state,
        last_synced_at: patch.last_synced_at ?? null,
        updated_at: ts,
      });
      if (res.changes === 0) return null;
      return this.get(platform, slug);
    },
    updateCaps(platform, slug, caps) {
      const ts = now();
      const res = updateCapsStmt.run({
        platform,
        slug,
        caps_json: JSON.stringify(caps),
        updated_at: ts,
      });
      if (res.changes === 0) return null;
      return this.get(platform, slug);
    },
    markBackfillComplete(platform, slug) {
      const ts = now();
      const res = markBackfillStmt.run({ platform, slug, updated_at: ts });
      if (res.changes === 0) return null;
      return this.get(platform, slug);
    },
  };
};
