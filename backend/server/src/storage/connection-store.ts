/** D-125 Phase 1.2 — connection substrate SQLite storage (server).
 *
 *  Single SQLite table (`connections`) with composite PRIMARY KEY
 *  `(kind, name)` plus two indexes (`updated_at` for sync delta
 *  queries and `kind` for facet listing). Mirrors the spec § 1.4
 *  schema verbatim.
 *
 *  `auth_json` is AEAD ciphertext, base64-encoded; `config_json` and
 *  `health_json` are plaintext JSON. The store stays opaque to the
 *  ciphertext — the D-125 P3 adapter is the only code path that
 *  decrypts at call time.
 *
 *  Read paths surface `ConnectionRow` directly. The contracts-side
 *  `connectionViewFromRow` helper projects rows to the resolver's
 *  read-only `ConnectionView` (auth excluded by construction).
 *
 *  No rpc, no enrollment UX, no probe — those land in P2.x. P1.2
 *  ships the schema + a thin store interface that future phases
 *  layer on top of. */

import type Database from 'better-sqlite3';
import {
  type ConnectionKind,
  type ConnectionRow,
  connectionRowKey,
} from '@recued/contracts';

const CONNECTION_TABLE = 'connections';

/** Install the connections table + indexes. Idempotent — every
 *  statement uses `IF NOT EXISTS`. Safe to call on every boot. */
export const ensureConnectionSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONNECTION_TABLE} (
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('mcp', 'api', 'notification')),
      subtype          TEXT,
      display_name     TEXT NOT NULL,
      publisher_id     TEXT,
      config_json      TEXT NOT NULL,
      auth_json        TEXT NOT NULL,
      enrolled_at      INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      last_used_at     INTEGER,
      health_json      TEXT,
      subresource_path TEXT,
      granted_scopes_json TEXT,
      PRIMARY KEY (kind, name)
    );
    CREATE INDEX IF NOT EXISTS idx_connections_updated_at
      ON ${CONNECTION_TABLE} (updated_at);
    CREATE INDEX IF NOT EXISTS idx_connections_kind
      ON ${CONNECTION_TABLE} (kind);
  `);

  // D-165 P3.path-picker — additive column for tables created before the
  // field existed. `CREATE TABLE IF NOT EXISTS` won't widen an existing
  // table, so guard with PRAGMA table_info (same idiom as the enrichment
  // store's D-128/D-136 column adds). Nullable — legacy rows read back as
  // an absent path, defaulted to `/` by `canonicalizeSubresourcePath`.
  const cols = db
    .prepare(`PRAGMA table_info(${CONNECTION_TABLE})`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === 'subresource_path')) {
    db.exec(`ALTER TABLE ${CONNECTION_TABLE} ADD COLUMN subresource_path TEXT`);
  }
  // granted-scopes — additive nullable column for tables created before the
  // field existed (same PRAGMA-guarded idiom as subresource_path above).
  // Legacy rows read back as an absent set → "unknown coverage".
  if (!cols.some((c) => c.name === 'granted_scopes_json')) {
    db.exec(`ALTER TABLE ${CONNECTION_TABLE} ADD COLUMN granted_scopes_json TEXT`);
  }
};

interface ConnectionDbRow {
  name: string;
  kind: ConnectionKind;
  subtype: string | null;
  display_name: string;
  publisher_id: string | null;
  config_json: string;
  auth_json: string;
  enrolled_at: number;
  updated_at: number;
  last_used_at: number | null;
  health_json: string | null;
  subresource_path: string | null;
  granted_scopes_json: string | null;
}

const dbRowToConnectionRow = (row: ConnectionDbRow): ConnectionRow => {
  const out: ConnectionRow = {
    pk: connectionRowKey(row.kind, row.name),
    kind: row.kind,
    name: row.name,
    display_name: row.display_name,
    config_json: row.config_json,
    auth_ciphertext: row.auth_json,
    enrolled_at: row.enrolled_at,
    updated_at: row.updated_at,
  };
  if (row.subtype !== null) out.subtype = row.subtype;
  if (row.publisher_id !== null) out.publisher_id = row.publisher_id;
  if (row.last_used_at !== null) out.last_used_at = row.last_used_at;
  if (row.health_json !== null) out.health_json = row.health_json;
  if (row.subresource_path !== null) out.subresource_path = row.subresource_path;
  if (row.granted_scopes_json !== null) out.granted_scopes_json = row.granted_scopes_json;
  return out;
};

/** Resolve a connection row's declared VENDOR — the SINGLE source of truth shared
 *  by the catalog grant-write path (`connection-handler.ts` — the grant rpcs +
 *  the D-136 delete cascade) and the operation-profile seed
 *  (`connection-operation-profile-boot.ts`). The two MUST agree: the D-165 P3.grant
 *  migration keys `contract.grant` rows on the vendor's catalog slug, so a row the
 *  WRITE path resolves to a vendor but the SEED path does not (or vice versa) lands
 *  a grant under a slug the reseed never reads — stranding it (fail-closed: the
 *  write→ask path silently reverts to deny after a token-refresh reseed). One
 *  resolver keeps them in lock-step.
 *
 *  `config_json.vendor` first (the canonical field every vendor reconciler reads),
 *  then the `subtype` column as a fallback for api rows that carried the vendor
 *  there. Returns undefined when neither is a non-empty string. Kind-agnostic —
 *  callers gate `kind: 'api'`. */
export const resolveConnectionVendor = (
  row: { config_json: string; subtype?: string | null },
): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const vendor = (parsed as Record<string, unknown>).vendor;
      if (typeof vendor === 'string' && vendor.length > 0) return vendor;
    }
  } catch {
    /* bad JSON → no vendor declared */
  }
  if (typeof row.subtype === 'string' && row.subtype.length > 0) return row.subtype;
  return undefined;
};

/** Per-write input. The store never sees a parsed `ConnectionAuth`
 *  — callers pass the already-encrypted `auth_ciphertext` so the
 *  encryption pipeline stays adapter-internal. */
export interface ConnectionUpsert {
  kind: ConnectionKind;
  name: string;
  subtype?: string;
  display_name: string;
  publisher_id?: string;
  config_json: string;
  auth_ciphertext: string;
  enrolled_at: number;
  updated_at: number;
  last_used_at?: number;
  health_json?: string;
  /** D-165 P3.path-picker — canonicalized sub-resource scope. Absent →
   *  NULL column (legacy/whole-account; consumers default to `/`). The
   *  handler canonicalizes before calling, so the store persists the
   *  value verbatim. */
  subresource_path?: string;
  /** granted-scopes — JSON-array TEXT of the vendor-granted OAuth scopes.
   *  Absent → NULL column ("unknown coverage"). The handler stringifies
   *  before calling; the store persists verbatim. Carry it forward on
   *  every non-enroll restamp (refresh / probe / patch) — dropping it
   *  silently flips a covered connection to "needs re-auth". */
  granted_scopes_json?: string;
}

export interface ConnectionStoreSqlite {
  /** Upsert by composite key. Fully replaces the row when present.
   *  LWW semantics live one layer up at the sync wire (P2.2); this
   *  store always honors the caller's `updated_at`. */
  upsert(input: ConnectionUpsert): ConnectionRow;
  /** Fetch by composite key or null when absent. */
  get(kind: ConnectionKind, name: string): ConnectionRow | null;
  /** List every row, optionally filtered by kind. Newest `updated_at`
   *  first — drives the Settings → Connections list and the sync
   *  delta scan. */
  list(query?: { kind?: ConnectionKind }): ConnectionRow[];
  /** List rows with `updated_at > since` for sync delta scans
   *  (P2.2 cloud sync wire). Newest first. */
  listSince(since: number): ConnectionRow[];
  /** Delete by composite key. Returns true when a row was removed. */
  delete(kind: ConnectionKind, name: string): boolean;
  /** Total row count — Settings page header. */
  count(): number;
  /** D-130 P2 — register a post-mutation hook fired after every
   *  successful `upsert` (enrollment / update / probe / refresh). Each
   *  vendor reconciliation boot wire installs its own handler keyed by
   *  vendor filter, so HubSpot + Salesforce + future-vendor wires
   *  coexist on the same store. Returns an unsubscribe callback —
   *  tests + module reload paths can drop a handler without affecting
   *  others. Handlers fire in registration order; exceptions are
   *  swallowed per-handler so a buggy registration never breaks the
   *  rpc that triggered the mutation. (D-129 P2 shipped a single-
   *  handler `setOnUpsert`; D-130 P2 widened to additive registration
   *  to let multiple vendor wires coexist.) */
  addOnUpsert(handler: (row: ConnectionRow) => void): () => void;
  /** D-130 P2 — register a post-mutation hook fired after every
   *  successful `delete`. Mirrors `addOnUpsert`'s additive shape. */
  addOnDelete(
    handler: (kind: ConnectionKind, name: string) => void,
  ): () => void;
  /** Register a synchronous transaction-critical hook that runs before a
   * present row is deleted. The hook must return `undefined`; the hook and
   * exact one-row connection deletion share one SQLite transaction. Any hook
   * exception, asynchronous return, or premature target-row removal rolls back every
   * hook mutation and preserves the connection. Use this only for fail-close
   * invariants that must be durable before the authority row disappears.
   * Ordinary cleanup belongs in `addOnDelete`. */
  addBeforeDelete(
    handler: (kind: ConnectionKind, name: string) => undefined,
  ): () => void;
}

export const createConnectionStore = (
  db: Database.Database,
): ConnectionStoreSqlite => {
  ensureConnectionSchema(db);

  const upsertStmt = db.prepare(`
    INSERT INTO ${CONNECTION_TABLE}
      (name, kind, subtype, display_name, publisher_id, config_json,
       auth_json, enrolled_at, updated_at, last_used_at, health_json,
       subresource_path, granted_scopes_json)
      VALUES
      (@name, @kind, @subtype, @display_name, @publisher_id, @config_json,
       @auth_json, @enrolled_at, @updated_at, @last_used_at, @health_json,
       @subresource_path, @granted_scopes_json)
    ON CONFLICT (kind, name) DO UPDATE SET
      subtype          = excluded.subtype,
      display_name     = excluded.display_name,
      publisher_id     = excluded.publisher_id,
      config_json      = excluded.config_json,
      auth_json        = excluded.auth_json,
      enrolled_at      = excluded.enrolled_at,
      updated_at       = excluded.updated_at,
      last_used_at     = excluded.last_used_at,
      health_json      = excluded.health_json,
      subresource_path = excluded.subresource_path,
      granted_scopes_json = excluded.granted_scopes_json
  `);

  const getStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE} WHERE kind = ? AND name = ?`,
  );
  const listAllStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE} ORDER BY updated_at DESC, name ASC`,
  );
  const listByKindStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE}
       WHERE kind = ?
       ORDER BY updated_at DESC, name ASC`,
  );
  const listSinceStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE}
       WHERE updated_at > ?
       ORDER BY updated_at DESC, name ASC`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM ${CONNECTION_TABLE} WHERE kind = ? AND name = ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${CONNECTION_TABLE}`);

  // D-130 P2 — ordinary observers fire post-mutation; exceptions in any
  // handler are swallowed so a buggy reconciliation never breaks the rpc.
  // D-201 9BO's separate pre-delete set is transaction-critical: exceptions
  // propagate and roll back the authority deletion. Sets keep observers
  // additive without clobbering peers.
  const onUpsertHandlers = new Set<(row: ConnectionRow) => void>();
  const onDeleteHandlers = new Set<(kind: ConnectionKind, name: string) => void>();
  const beforeDeleteHandlers = new Set<(
    kind: ConnectionKind,
    name: string,
  ) => undefined>();
  const deleteWithCriticalHooks = db.transaction((
    kind: ConnectionKind,
    name: string,
  ): boolean => {
    if (getStmt.get(kind, name) === undefined) return false;
    for (const handler of beforeDeleteHandlers) {
      if (handler(kind, name) !== undefined) {
        throw new Error('critical before-delete handlers must be synchronous');
      }
    }
    if (deleteStmt.run(kind, name).changes !== 1) {
      throw new Error('connection changed during critical deletion');
    }
    return true;
  });

  return {
    upsert(input) {
      upsertStmt.run({
        name: input.name,
        kind: input.kind,
        subtype: input.subtype ?? null,
        display_name: input.display_name,
        publisher_id: input.publisher_id ?? null,
        config_json: input.config_json,
        auth_json: input.auth_ciphertext,
        enrolled_at: input.enrolled_at,
        updated_at: input.updated_at,
        last_used_at: input.last_used_at ?? null,
        health_json: input.health_json ?? null,
        subresource_path: input.subresource_path ?? null,
        granted_scopes_json: input.granted_scopes_json ?? null,
      });
      const row = dbRowToConnectionRow(
        getStmt.get(input.kind, input.name) as ConnectionDbRow,
      );
      for (const handler of onUpsertHandlers) {
        try { handler(row); } catch { /* best-effort */ }
      }
      return row;
    },

    get(kind, name) {
      const row = getStmt.get(kind, name) as ConnectionDbRow | undefined;
      return row ? dbRowToConnectionRow(row) : null;
    },

    list(query = {}) {
      const rows = (
        query.kind
          ? (listByKindStmt.all(query.kind) as ConnectionDbRow[])
          : (listAllStmt.all() as ConnectionDbRow[])
      );
      return rows.map(dbRowToConnectionRow);
    },

    listSince(since) {
      const rows = listSinceStmt.all(since) as ConnectionDbRow[];
      return rows.map(dbRowToConnectionRow);
    },

    delete(kind, name) {
      const removed = deleteWithCriticalHooks(kind, name);
      if (removed) {
        for (const handler of onDeleteHandlers) {
          try { handler(kind, name); } catch { /* best-effort */ }
        }
      }
      return removed;
    },

    count() {
      return (countStmt.get() as { n: number }).n;
    },

    addOnUpsert(handler) {
      onUpsertHandlers.add(handler);
      return () => {
        onUpsertHandlers.delete(handler);
      };
    },

    addOnDelete(handler) {
      onDeleteHandlers.add(handler);
      return () => {
        onDeleteHandlers.delete(handler);
      };
    },

    addBeforeDelete(handler) {
      beforeDeleteHandlers.add(handler);
      return () => {
        beforeDeleteHandlers.delete(handler);
      };
    },
  };
};
