/** D-139 Phase 1a.2 — engagement capability store.
 *
 *  Persists per-(connection, vendor, entity) `EngagementCapabilityFlags`
 *  rows. Populated at connection enrollment, re-probed on edit /
 *  "Re-probe capabilities" / detected probe failure. Read by:
 *
 *    - Webhook funnel — `association_rescan_required` flag drives
 *      whether `*.associationChange` events route through the edge-
 *      only write path.
 *    - Per-cycle association-rescan substrate (§ A.6.3) — eligible
 *      tuples (`association_rescan_required = true` OR webhook
 *      delivery degraded) run the secondary sweep on each cycle.
 *    - Settings → Connections — surfaces capability flags + last
 *      probe error.
 *
 *  Server-internal table; no cross-cloud sync (D-097 / D-168).
 *
 *  Spec: `docs/d-139-spec.md` § A.2, § A.2.1, § A.6, § A.6.3. */

import type Database from 'better-sqlite3';

import {
  type EngagementCapabilityFlags,
  type EngagementVendor,
} from '@recued/contracts';

export const ENGAGEMENT_CAPABILITY_TABLE = 'engagement_capability';

export class EngagementCapabilityInvalidError extends Error {
  readonly code = 'ENGAGEMENT_CAPABILITY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'EngagementCapabilityInvalidError';
  }
}

/** Idempotent schema bootstrap. */
export const ensureEngagementCapabilitySchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_CAPABILITY_TABLE} (
      connection_id               TEXT NOT NULL,
      vendor                      TEXT NOT NULL,
      entity                      TEXT NOT NULL,
      available                   INTEGER NOT NULL,
      cdc_supported               INTEGER,
      push_topic_supported        INTEGER,
      reconciler_only             INTEGER,
      association_rescan_required INTEGER NOT NULL,
      last_probed_at              INTEGER NOT NULL,
      last_probe_error            TEXT,
      PRIMARY KEY (connection_id, vendor, entity)
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_capability_by_rescan
      ON ${ENGAGEMENT_CAPABILITY_TABLE} (association_rescan_required);
  `);
};

interface DbRow {
  connection_id: string;
  vendor: string;
  entity: string;
  available: number;
  cdc_supported: number | null;
  push_topic_supported: number | null;
  reconciler_only: number | null;
  association_rescan_required: number;
  last_probed_at: number;
  last_probe_error: string | null;
}

const fromDbRow = (row: DbRow): EngagementCapabilityFlags => {
  // D-192 — vendor is opaque provenance (capability rows are only written for
  // registry-declared engagement vendors); reject only empty/corrupt.
  if (row.vendor.length === 0) {
    throw new EngagementCapabilityInvalidError('vendor must be non-empty');
  }
  const out: EngagementCapabilityFlags = {
    connection_id: row.connection_id,
    vendor: row.vendor,
    entity: row.entity,
    available: row.available === 1,
    association_rescan_required: row.association_rescan_required === 1,
    last_probed_at: row.last_probed_at,
  };
  if (row.cdc_supported !== null) out.cdc_supported = row.cdc_supported === 1;
  if (row.push_topic_supported !== null)
    out.push_topic_supported = row.push_topic_supported === 1;
  if (row.reconciler_only !== null)
    out.reconciler_only = row.reconciler_only === 1;
  if (row.last_probe_error !== null) out.last_probe_error = row.last_probe_error;
  return out;
};

const toBool = (raw: boolean | undefined): number | null =>
  raw === undefined ? null : raw ? 1 : 0;

export interface EngagementCapabilityStore {
  upsert(flags: EngagementCapabilityFlags): void;
  get(
    connection_id: string,
    vendor: EngagementVendor,
    entity: string,
  ): EngagementCapabilityFlags | null;
  /** All rows for a connection — used by Settings → Connections to
   *  render per-entity capability surfaces. */
  listByConnection(
    connection_id: string,
  ): ReadonlyArray<EngagementCapabilityFlags>;
  /** Filter by `association_rescan_required = true` — drives the
   *  per-cycle sweep eligibility (§ A.6.3). */
  listRescanRequired(
    vendor?: EngagementVendor,
  ): ReadonlyArray<EngagementCapabilityFlags>;
  /** Drop a row — called on connection.delete cascade. */
  remove(
    connection_id: string,
    vendor: EngagementVendor,
    entity: string,
  ): void;
  /** Cascade drop every row under a connection_id. */
  removeForConnection(connection_id: string): number;
}

export const createEngagementCapabilityStore = (
  db: Database.Database,
): EngagementCapabilityStore => {
  ensureEngagementCapabilitySchema(db);

  const upsertStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_CAPABILITY_TABLE}
       (connection_id, vendor, entity, available,
        cdc_supported, push_topic_supported, reconciler_only,
        association_rescan_required, last_probed_at, last_probe_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, vendor, entity) DO UPDATE SET
       available                   = excluded.available,
       cdc_supported               = excluded.cdc_supported,
       push_topic_supported        = excluded.push_topic_supported,
       reconciler_only             = excluded.reconciler_only,
       association_rescan_required = excluded.association_rescan_required,
       last_probed_at              = excluded.last_probed_at,
       last_probe_error            = excluded.last_probe_error`,
  );
  const getStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_CAPABILITY_TABLE}
       WHERE connection_id = ? AND vendor = ? AND entity = ?`,
  );
  const listByConnectionStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_CAPABILITY_TABLE}
       WHERE connection_id = ?
       ORDER BY vendor ASC, entity ASC`,
  );
  const listRescanRequiredAllStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_CAPABILITY_TABLE}
       WHERE association_rescan_required = 1
       ORDER BY connection_id ASC, vendor ASC, entity ASC`,
  );
  const listRescanRequiredVendorStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_CAPABILITY_TABLE}
       WHERE association_rescan_required = 1 AND vendor = ?
       ORDER BY connection_id ASC, entity ASC`,
  );
  const removeStmt = db.prepare(
    `DELETE FROM ${ENGAGEMENT_CAPABILITY_TABLE}
       WHERE connection_id = ? AND vendor = ? AND entity = ?`,
  );
  const removeForConnectionStmt = db.prepare(
    `DELETE FROM ${ENGAGEMENT_CAPABILITY_TABLE}
       WHERE connection_id = ?`,
  );

  return {
    upsert(flags) {
      if (flags.vendor.length === 0) {
        throw new EngagementCapabilityInvalidError('vendor must be non-empty');
      }
      if (flags.entity.length === 0) {
        throw new EngagementCapabilityInvalidError('entity must be non-empty');
      }
      upsertStmt.run(
        flags.connection_id,
        flags.vendor,
        flags.entity,
        flags.available ? 1 : 0,
        toBool(flags.cdc_supported),
        toBool(flags.push_topic_supported),
        toBool(flags.reconciler_only),
        flags.association_rescan_required ? 1 : 0,
        flags.last_probed_at,
        flags.last_probe_error ?? null,
      );
    },
    get(connection_id, vendor, entity) {
      const raw = getStmt.get(connection_id, vendor, entity) as
        | DbRow
        | undefined;
      return raw === undefined ? null : fromDbRow(raw);
    },
    listByConnection(connection_id) {
      const rows = listByConnectionStmt.all(connection_id) as DbRow[];
      return rows.map(fromDbRow);
    },
    listRescanRequired(vendor) {
      const rows =
        vendor === undefined
          ? (listRescanRequiredAllStmt.all() as DbRow[])
          : (listRescanRequiredVendorStmt.all(vendor) as DbRow[]);
      return rows.map(fromDbRow);
    },
    remove(connection_id, vendor, entity) {
      removeStmt.run(connection_id, vendor, entity);
    },
    removeForConnection(connection_id) {
      const result = removeForConnectionStmt.run(connection_id);
      return result.changes;
    },
  };
};
