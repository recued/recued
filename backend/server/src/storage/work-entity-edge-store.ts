/** D-192 P5 — the `work_entity_edge` store.
 *
 *  The fresh thin edge table the spec settled as the work-graph
 *  substrate (i-vs-ii fork resolved at P5 — see the contract module's
 *  header for why overloading the D-119 `link` store was rejected).
 *  Mirrors `engagement_edges`' proven sync shape: source-scoped
 *  identity, tombstone-on-disassociate, bidirectional (by-owner +
 *  by-target) indexes. `engagement_edges` itself is untouched — it
 *  stays the D-139 CRM raw-association evidence layer.
 *
 *  Lifecycle:
 *  - **Reconcile-per-row** — the sync fold recomputes a folded row's
 *    desired edge set from its declared relationships and reconciles:
 *    upsert (reviving tombstones under their ORIGINAL `created_at`),
 *    tombstone edges the vendor no longer asserts. Sound because the
 *    relationship hints ride the extension blob, which participates in
 *    `source_record_hash` — any association change re-folds the row.
 *  - **Row tombstone → edge tombstone** (vendor delete / delete-diff).
 *  - **Source unregister → hard delete** — edges are derived,
 *    rebuildable projections (the north star's "relationship graph =
 *    projections, not storage"), so they follow the sync-STATE
 *    lifecycle, not the row lifecycle (rows orphan and are preserved;
 *    a re-enrolled connection rebuilds its edges on the first cycle).
 *  - **Late resolution** — a `work:`-scoped edge written before its
 *    target synced resolves later via `listUnresolved` +
 *    `markResolved`; identity is the scoped key, so resolution never
 *    re-keys the row.
 *
 *  Spec: D-192 § Identity and relationships + § P5. */

import type Database from 'better-sqlite3';
import type {
  WorkEntityEdge,
  WorkEntityEdgeWrite,
  WorkEntityRelationshipTarget,
  WorkEntitySourceDeclarableKind,
} from '@recued/contracts';

export const WORK_ENTITY_EDGE_TABLE = 'work_entity_edge';

/** Idempotent schema bootstrap (pre-launch zero-migration discipline:
 *  `CREATE TABLE IF NOT EXISTS`, no ALTER paths — a fresh substrate). */
export const ensureWorkEntityEdgeSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${WORK_ENTITY_EDGE_TABLE} (
      source_id             TEXT NOT NULL,
      source_record_id      TEXT NOT NULL,
      owner_kind            TEXT NOT NULL,
      owner_local_id        TEXT NOT NULL,
      local_field           TEXT NOT NULL,
      target_kind           TEXT NOT NULL,
      target_scoped_key     TEXT NOT NULL,
      target_source_id      TEXT,
      target_remote_entity  TEXT,
      target_remote_id      TEXT,
      target_local_id       TEXT,
      created_at            INTEGER NOT NULL,
      resolved_at           INTEGER,
      deleted_at            INTEGER,
      PRIMARY KEY (source_id, source_record_id, local_field, target_scoped_key)
    );
    CREATE INDEX IF NOT EXISTS idx_work_entity_edge_by_owner
      ON ${WORK_ENTITY_EDGE_TABLE} (owner_kind, owner_local_id);
    CREATE INDEX IF NOT EXISTS idx_work_entity_edge_by_target
      ON ${WORK_ENTITY_EDGE_TABLE} (target_kind, target_local_id)
      WHERE target_local_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_work_entity_edge_unresolved
      ON ${WORK_ENTITY_EDGE_TABLE} (source_id)
      WHERE target_local_id IS NULL AND deleted_at IS NULL;
  `);
};

/** The row-scoped reconcile input — one folded owner row's full
 *  desired edge set (across ALL its declared relationships). */
export interface WorkEntityEdgeReconcileInput {
  source_id: string;
  source_record_id: string;
  owner_kind: WorkEntitySourceDeclarableKind;
  owner_local_id: string;
  desired: readonly WorkEntityEdgeWrite[];
}

export interface WorkEntityEdgeStore {
  /** Reconcile one owner row's edges against its freshly-projected
   *  desired set, in one transaction: upsert every desired edge
   *  (reviving a tombstoned identity under its original `created_at`,
   *  refreshing owner/resolution fields), then tombstone the row's
   *  live edges the desired set no longer contains. */
  reconcileRecordEdges(input: WorkEntityEdgeReconcileInput, now?: number): {
    upserted: number;
    tombstoned: number;
  };
  /** Live edges for one owner row (display order: local_field, then
   *  scoped key — deterministic for the read surface). */
  listByOwner(
    owner_kind: WorkEntitySourceDeclarableKind,
    owner_local_id: string,
  ): WorkEntityEdge[];
  /** Live RESOLVED edges pointing at one local target — the reverse
   *  index in-row JSON arrays could never provide (cascade-safety). */
  listByTarget(
    target_kind: WorkEntityRelationshipTarget,
    target_local_id: string,
  ): WorkEntityEdge[];
  /** Live unresolved-but-RETRYABLE edges for one Source (the late
   *  re-resolution pass's input), capped. Retryable = carries a
   *  `target_source_id` + `target_remote_id` to look up again — i.e.
   *  work-entity targets awaiting their sibling Source. Scoped-only
   *  references (calendar.event / mail_message, which have NO local
   *  resolver) are excluded IN SQL so they can never starve the batch
   *  (codex MEDIUM: 200 never-resolvable refs would otherwise fill
   *  every cycle's window). */
  listUnresolved(source_id: string, limit: number): WorkEntityEdge[];
  /** Fill a resolved local id on one edge identity. False when the
   *  edge is gone or already resolved. */
  markResolved(
    key: Pick<WorkEntityEdge, 'source_id' | 'source_record_id' | 'local_field' | 'target_scoped_key'>,
    target_local_id: string,
    now?: number,
  ): boolean;
  /** Tombstone every live edge of one owner row (vendor-side delete).
   *  Returns the count tombstoned. */
  tombstoneForRecord(source_id: string, source_record_id: string, now?: number): number;
  /** Hard-delete every edge of one Source (Source unregistered —
   *  derived state, rebuilt by the next sync of a re-registered
   *  Source). Returns the count deleted. */
  deleteForSource(source_id: string): number;
}

interface EdgeDbRow {
  source_id: string;
  source_record_id: string;
  owner_kind: string;
  owner_local_id: string;
  local_field: string;
  target_kind: string;
  target_scoped_key: string;
  target_source_id: string | null;
  target_remote_entity: string | null;
  target_remote_id: string | null;
  target_local_id: string | null;
  created_at: number;
  resolved_at: number | null;
  deleted_at: number | null;
}

const rowToEdge = (row: EdgeDbRow): WorkEntityEdge => ({
  source_id: row.source_id,
  source_record_id: row.source_record_id,
  owner_kind: row.owner_kind as WorkEntitySourceDeclarableKind,
  owner_local_id: row.owner_local_id,
  local_field: row.local_field,
  target_kind: row.target_kind as WorkEntityRelationshipTarget,
  target_scoped_key: row.target_scoped_key,
  ...(row.target_source_id !== null ? { target_source_id: row.target_source_id } : {}),
  ...(row.target_remote_entity !== null ? { target_remote_entity: row.target_remote_entity } : {}),
  ...(row.target_remote_id !== null ? { target_remote_id: row.target_remote_id } : {}),
  ...(row.target_local_id !== null ? { target_local_id: row.target_local_id } : {}),
  created_at: row.created_at,
  ...(row.resolved_at !== null ? { resolved_at: row.resolved_at } : {}),
  ...(row.deleted_at !== null ? { deleted_at: row.deleted_at } : {}),
});

export const createWorkEntityEdgeStore = (
  db: Database.Database,
): WorkEntityEdgeStore => {
  // Upsert one desired edge. ON CONFLICT keeps the original
  // `created_at` (revive ≠ recreate), clears any tombstone, refreshes
  // the owner pointer (a mirrored row can be resurrected under its
  // original local id — the pointer is re-asserted either way), and
  // adopts the incoming resolution WITHOUT ever un-resolving: a
  // desired edge that arrives unresolved (target Source lagging) must
  // not blank a previously-resolved local id for the same stable
  // scoped identity.
  const upsertStmt = db.prepare(`
    INSERT INTO ${WORK_ENTITY_EDGE_TABLE}
      (source_id, source_record_id, owner_kind, owner_local_id, local_field,
       target_kind, target_scoped_key, target_source_id, target_remote_entity,
       target_remote_id, target_local_id, created_at, resolved_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (source_id, source_record_id, local_field, target_scoped_key) DO UPDATE SET
      owner_kind = excluded.owner_kind,
      owner_local_id = excluded.owner_local_id,
      target_kind = excluded.target_kind,
      target_source_id = excluded.target_source_id,
      target_remote_entity = excluded.target_remote_entity,
      target_remote_id = excluded.target_remote_id,
      target_local_id = COALESCE(excluded.target_local_id, ${WORK_ENTITY_EDGE_TABLE}.target_local_id),
      resolved_at = COALESCE(${WORK_ENTITY_EDGE_TABLE}.resolved_at, excluded.resolved_at),
      deleted_at = NULL
  `);
  const listRecordKeysStmt = db.prepare(`
    SELECT local_field, target_scoped_key FROM ${WORK_ENTITY_EDGE_TABLE}
     WHERE source_id = ? AND source_record_id = ? AND deleted_at IS NULL
  `);
  const tombstoneOneStmt = db.prepare(`
    UPDATE ${WORK_ENTITY_EDGE_TABLE} SET deleted_at = ?
     WHERE source_id = ? AND source_record_id = ? AND local_field = ?
       AND target_scoped_key = ? AND deleted_at IS NULL
  `);
  const byOwnerStmt = db.prepare(`
    SELECT * FROM ${WORK_ENTITY_EDGE_TABLE}
     WHERE owner_kind = ? AND owner_local_id = ? AND deleted_at IS NULL
     ORDER BY local_field ASC, target_scoped_key ASC
  `);
  const byTargetStmt = db.prepare(`
    SELECT * FROM ${WORK_ENTITY_EDGE_TABLE}
     WHERE target_kind = ? AND target_local_id = ? AND deleted_at IS NULL
     ORDER BY source_id ASC, source_record_id ASC, local_field ASC
  `);
  const unresolvedStmt = db.prepare(`
    SELECT * FROM ${WORK_ENTITY_EDGE_TABLE}
     WHERE source_id = ? AND target_local_id IS NULL AND deleted_at IS NULL
       AND target_source_id IS NOT NULL AND target_remote_id IS NOT NULL
     ORDER BY created_at ASC
     LIMIT ?
  `);
  const markResolvedStmt = db.prepare(`
    UPDATE ${WORK_ENTITY_EDGE_TABLE}
       SET target_local_id = ?, resolved_at = ?
     WHERE source_id = ? AND source_record_id = ? AND local_field = ?
       AND target_scoped_key = ? AND target_local_id IS NULL AND deleted_at IS NULL
  `);
  const tombstoneRecordStmt = db.prepare(`
    UPDATE ${WORK_ENTITY_EDGE_TABLE} SET deleted_at = ?
     WHERE source_id = ? AND source_record_id = ? AND deleted_at IS NULL
  `);
  const deleteForSourceStmt = db.prepare(
    `DELETE FROM ${WORK_ENTITY_EDGE_TABLE} WHERE source_id = ?`,
  );

  const reconcileTx = db.transaction(
    (input: WorkEntityEdgeReconcileInput, now: number): { upserted: number; tombstoned: number } => {
      const { source_id, source_record_id, owner_kind, owner_local_id, desired } = input;
      const desiredKeys = new Set(
        desired.map((d) => [d.local_field, d.target_scoped_key].join(" ")),
      );
      let tombstoned = 0;
      for (const row of listRecordKeysStmt.all(source_id, source_record_id) as Array<{
        local_field: string;
        target_scoped_key: string;
      }>) {
        if (desiredKeys.has([row.local_field, row.target_scoped_key].join(" "))) continue;
        tombstoned += tombstoneOneStmt.run(
          now, source_id, source_record_id, row.local_field, row.target_scoped_key,
        ).changes;
      }
      for (const d of desired) {
        upsertStmt.run(
          source_id, source_record_id, owner_kind, owner_local_id, d.local_field,
          d.target_kind, d.target_scoped_key, d.target_source_id ?? null,
          d.target_remote_entity ?? null, d.target_remote_id ?? null,
          d.target_local_id ?? null, now,
          d.target_local_id !== undefined ? now : null,
        );
      }
      return { upserted: desired.length, tombstoned };
    },
  );

  return {
    reconcileRecordEdges(input, now = Date.now()) {
      return reconcileTx(input, now);
    },
    listByOwner(owner_kind, owner_local_id) {
      return (byOwnerStmt.all(owner_kind, owner_local_id) as EdgeDbRow[]).map(rowToEdge);
    },
    listByTarget(target_kind, target_local_id) {
      return (byTargetStmt.all(target_kind, target_local_id) as EdgeDbRow[]).map(rowToEdge);
    },
    listUnresolved(source_id, limit) {
      return (unresolvedStmt.all(source_id, limit) as EdgeDbRow[]).map(rowToEdge);
    },
    markResolved(key, target_local_id, now = Date.now()) {
      return markResolvedStmt.run(
        target_local_id, now,
        key.source_id, key.source_record_id, key.local_field, key.target_scoped_key,
      ).changes > 0;
    },
    tombstoneForRecord(source_id, source_record_id, now = Date.now()) {
      return tombstoneRecordStmt.run(now, source_id, source_record_id).changes;
    },
    deleteForSource(source_id) {
      return deleteForSourceStmt.run(source_id).changes;
    },
  };
};
