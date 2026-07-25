/** D-192 — `source_dependency_entity` store (Slice 2).
 *
 *  Backs the input-dependency graph (D-192):
 *  the vendor CONTAINER entities (Asana workspace, Linear team, a project) a
 *  Source's ops depend on. Each row is one fetched entity, scoped to its owning
 *  Source + dependency ref; the `selected` row is AUTHORITATIVE for dispatch, the
 *  rest are a refreshable cache for the picker / chat.
 *
 *  - **Selection, not list, is the source of truth** — a picked id doesn't go
 *    stale (workspace X stays X until deleted); the cache is refreshed from the
 *    list op on demand and prunes vendor-deleted entities (dropping a selection
 *    only when its entity actually disappears).
 *  - **Local-only** (D-097) — vendor data, never cloud-synced.
 *  - **Tears down with the Source** (`deleteForSource`) — the boot reconcile
 *    calls it on unregister, mirroring the sync-state / edge lifecycle. */

import type Database from 'better-sqlite3';

const TABLE = 'source_dependency_entity';

/** One cached vendor container entity for a Source's dependency. */
export interface SourceDependencyEntity {
  source_id: string;
  dependency_ref: string;
  /** Vendor-native id — the value that flows into the bound op arg. */
  entity_pk: string;
  /** Display label (denormalized so the picker / audit render without a
   *  re-fetch). */
  label: string;
  /** The chosen entity for this (source_id, dependency_ref). Exactly one row
   *  per pair may be selected (the store enforces it in `select`). */
  selected: boolean;
  /** Provenance / teardown grouping. */
  pack_slug: string | null;
  fetched_at: number;
}

export interface SourceDependencyEntityStore {
  /** Refresh the cached entity set for (source_id, dependency_ref): upsert the
   *  new entities (label/pack/fetched_at), PRESERVE the `selected` flag on
   *  survivors, and prune rows whose `entity_pk` is not in `entities` (a
   *  vendor-deleted entity — dropping its selection with it). */
  replaceEntities(
    source_id: string,
    dependency_ref: string,
    entities: ReadonlyArray<{ entity_pk: string; label: string }>,
    opts: { pack_slug?: string | null; now: number },
  ): void;
  /** All cached entities for a (source_id, dependency_ref), selected first. */
  list(source_id: string, dependency_ref: string): SourceDependencyEntity[];
  /** The selected entity, or null (never picked / selection pruned). */
  getSelected(source_id: string, dependency_ref: string): SourceDependencyEntity | null;
  /** Mark `entity_pk` selected + clear the others for this pair. Returns false
   *  when the pk is not cached (nothing selected). */
  select(source_id: string, dependency_ref: string, entity_pk: string): boolean;
  /** Hard-delete every dependency row for a Source (teardown). Returns the count. */
  deleteForSource(source_id: string): number;
}

/** Idempotent (`IF NOT EXISTS`). Pre-launch: an older-shape dev DB is wiped, not
 *  migrated. Soft reference to the Source registry — the boot reconcile calls
 *  `deleteForSource` on unregister (the spec's ON DELETE CASCADE intent without
 *  cross-module table coupling). */
export const ensureSourceDependencyEntitySchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      source_id       TEXT NOT NULL,
      dependency_ref  TEXT NOT NULL,
      entity_pk       TEXT NOT NULL,
      label           TEXT NOT NULL,
      selected        INTEGER NOT NULL DEFAULT 0,
      pack_slug       TEXT,
      fetched_at      INTEGER NOT NULL,
      PRIMARY KEY (source_id, dependency_ref, entity_pk)
    );
  `);
};

export const createSourceDependencyEntityStore = (
  db: Database.Database,
): SourceDependencyEntityStore => {
  const upsertStmt = db.prepare(`
    INSERT INTO ${TABLE} (source_id, dependency_ref, entity_pk, label, selected, pack_slug, fetched_at)
    VALUES (@source_id, @dependency_ref, @entity_pk, @label, 0, @pack_slug, @fetched_at)
    ON CONFLICT (source_id, dependency_ref, entity_pk) DO UPDATE SET
      label = excluded.label,
      pack_slug = excluded.pack_slug,
      fetched_at = excluded.fetched_at
  `);
  // Prune entities no longer in the fetched set — a placeholder list is built
  // per call (SQLite has no array param). Keyed to the pair.
  const listStmt = db.prepare(
    `SELECT * FROM ${TABLE} WHERE source_id = ? AND dependency_ref = ? ORDER BY selected DESC, label ASC`,
  );
  const selectedStmt = db.prepare(
    `SELECT * FROM ${TABLE} WHERE source_id = ? AND dependency_ref = ? AND selected = 1`,
  );
  const hasStmt = db.prepare(
    `SELECT 1 FROM ${TABLE} WHERE source_id = ? AND dependency_ref = ? AND entity_pk = ?`,
  );
  const clearSelStmt = db.prepare(
    `UPDATE ${TABLE} SET selected = 0 WHERE source_id = ? AND dependency_ref = ?`,
  );
  const setSelStmt = db.prepare(
    `UPDATE ${TABLE} SET selected = 1 WHERE source_id = ? AND dependency_ref = ? AND entity_pk = ?`,
  );
  const delSourceStmt = db.prepare(`DELETE FROM ${TABLE} WHERE source_id = ?`);
  const countSourceStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${TABLE} WHERE source_id = ?`,
  );

  const rowTo = (row: Record<string, unknown>): SourceDependencyEntity => ({
    source_id: row.source_id as string,
    dependency_ref: row.dependency_ref as string,
    entity_pk: row.entity_pk as string,
    label: row.label as string,
    selected: row.selected === 1,
    pack_slug: (row.pack_slug as string | null) ?? null,
    fetched_at: row.fetched_at as number,
  });

  const replaceTxn = db.transaction((
    source_id: string,
    dependency_ref: string,
    entities: ReadonlyArray<{ entity_pk: string; label: string }>,
    pack_slug: string | null,
    now: number,
  ) => {
    for (const e of entities) {
      upsertStmt.run({ source_id, dependency_ref, entity_pk: e.entity_pk, label: e.label, pack_slug, fetched_at: now });
    }
    // Prune rows for this pair whose entity_pk is not in the new set. Built with
    // positional placeholders; empty set → prune all cached rows for the pair.
    const keep = entities.map((e) => e.entity_pk);
    const placeholders = keep.map(() => '?').join(', ');
    const prune = keep.length === 0
      ? db.prepare(`DELETE FROM ${TABLE} WHERE source_id = ? AND dependency_ref = ?`)
      : db.prepare(`DELETE FROM ${TABLE} WHERE source_id = ? AND dependency_ref = ? AND entity_pk NOT IN (${placeholders})`);
    prune.run(source_id, dependency_ref, ...keep);
  });

  return {
    replaceEntities(source_id, dependency_ref, entities, opts) {
      replaceTxn(source_id, dependency_ref, entities, opts.pack_slug ?? null, opts.now);
    },
    list(source_id, dependency_ref) {
      return (listStmt.all(source_id, dependency_ref) as Record<string, unknown>[]).map(rowTo);
    },
    getSelected(source_id, dependency_ref) {
      const row = selectedStmt.get(source_id, dependency_ref) as Record<string, unknown> | undefined;
      return row === undefined ? null : rowTo(row);
    },
    select(source_id, dependency_ref, entity_pk) {
      if (hasStmt.get(source_id, dependency_ref, entity_pk) === undefined) return false;
      clearSelStmt.run(source_id, dependency_ref);
      setSelStmt.run(source_id, dependency_ref, entity_pk);
      return true;
    },
    deleteForSource(source_id) {
      const n = (countSourceStmt.get(source_id) as { n: number }).n;
      delSourceStmt.run(source_id);
      return n;
    },
  };
};
