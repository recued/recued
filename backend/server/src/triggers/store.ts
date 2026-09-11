/** Phase G (D-109) — event trigger SQLite store.
 *
 *  Persists rows of the `event_triggers` table. One row per installed
 *  trigger. The table lives in the server's main SQLite database
 *  alongside `server_config` / `server_state` / `paired_instances`.
 *
 *  Schema_version bumped 1 → 2 when this table lands. The archive
 *  format version is unchanged — archive export/import captures this
 *  table implicitly via the `SELECT * FROM event_triggers` table sweep. */

import type Database from 'better-sqlite3';
import type { EventTrigger, EventTriggerOrigin } from '@recued/contracts';
import {
  assertPreapprovalLegacyEnable, initializePreapprovalLifecycle, mutatePreapprovalResource,
  notePreapprovalOwnerMutation, preapprovalLogicalEnabled,
} from '../storage/preapproval-lifecycle.js';

export const triggerPreapprovalMaterial = (row: EventTrigger): Record<string, unknown> => ({
  recipe_id: row.recipe_id, publisher_id: row.publisher_id, pattern: row.pattern,
  enabled: row.enabled, dish_id: row.dish_id ?? null, watch_interval_ms: row.watch_interval_ms ?? null,
  filter: row.filter ?? null, fields: row.fields ?? null, origin: row.origin ?? 'user',
});

const TABLE = 'event_triggers';

export interface EventTriggersStore {
  /** Create a trigger row. Returns the persisted row (including the
   *  server-assigned ULID + created_at). `origin` defaults to
   *  `'user'`; the declarative reconciler passes `'recipe'` for rows
   *  it materializes from installed recipes' `event_triggers`. */
  create(row: {
    trigger_id: string;
    recipe_id: string;
    publisher_id: string;
    pattern: string;
    enabled: boolean;
    /** D-179 P2 — standing dish binding (replaces the retired
     *  `config_patch` per-row override) + the poll-interval infra knob
     *  lifted out of it. */
    dish_id?: string | null;
    watch_interval_ms?: number | null;
    created_at: number;
    origin?: EventTriggerOrigin;
    /** Authoring-sugar compile-down — dispatch-filter halves. Set by
     *  the declarative reconciler (a raw entry's `filter` / a sugar
     *  entry's compiled `where` + `fields`); the `triggers.create`
     *  rpc has no surface for them yet. */
    filter?: Record<string, unknown> | null;
    fields?: string[] | null;
  }): EventTrigger;
  /** Update an existing trigger by id. Returns the updated row, or
   *  null when no matching row exists. */
  update(
    trigger_id: string,
    patch: {
      enabled?: boolean;
      pattern?: string;
      /** Null clears the binding / preference; undefined leaves it. */
      dish_id?: string | null;
      watch_interval_ms?: number | null;
      last_fired_at?: number;
      last_error?: string | null;
    },
  ): EventTrigger | null;
  /** Hard-delete by id. Returns true when a row was removed. */
  remove(trigger_id: string): boolean;
  /** Fetch one row by id. */
  get(trigger_id: string): EventTrigger | null;
  /** List every row, ordered by `created_at` ascending (stable UI
   *  display — triggers added later render below older ones). */
  list(): EventTrigger[];
  /** List enabled rows only. Used by the dispatcher on boot. */
  listEnabled(): EventTrigger[];
  /** Count rows. Exposed for admin / test visibility. */
  count(): number;
}

const parseJsonObject = (raw: string | null): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** Serialize / parse the dispatch-filter halves. Defensive posture:
 *  empty objects/arrays normalize to NULL, malformed stored JSON reads
 *  back as absent (the filter then passes everything — the documented
 *  missing-filter behavior, never a throw on dispatch). */
const serializeFilter = (filter: Record<string, unknown> | null | undefined): string | null => {
  if (!filter || Object.keys(filter).length === 0) return null;
  return JSON.stringify(filter);
};

const parseFilter = (raw: string | null): Record<string, unknown> | undefined =>
  parseJsonObject(raw);

const serializeFields = (fields: string[] | null | undefined): string | null => {
  if (!fields || fields.length === 0) return null;
  return JSON.stringify(fields);
};

const parseFields = (raw: string | null): string[] | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const fields = parsed.filter((f): f is string => typeof f === 'string' && f.length > 0);
    return fields.length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
};

interface Row {
  trigger_id: string;
  recipe_id: string;
  publisher_id: string;
  pattern: string;
  enabled: number;
  created_at: number;
  last_fired_at: number | null;
  last_error: string | null;
  dish_id: string | null;
  watch_interval_ms: number | null;
  origin: string;
  filter: string | null;
  fields: string | null;
}

const rowToTrigger = (row: Row): EventTrigger => {
  const filter = parseFilter(row.filter);
  const fields = parseFields(row.fields);
  return {
    trigger_id: row.trigger_id,
    recipe_id: row.recipe_id,
    publisher_id: row.publisher_id,
    pattern: row.pattern,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    last_fired_at: row.last_fired_at,
    last_error: row.last_error,
    ...(row.dish_id != null && row.dish_id.length > 0 ? { dish_id: row.dish_id } : {}),
    ...(row.watch_interval_ms != null ? { watch_interval_ms: row.watch_interval_ms } : {}),
    origin: row.origin === 'recipe' ? 'recipe' : 'user',
    ...(filter !== undefined ? { filter } : {}),
    ...(fields !== undefined ? { fields } : {}),
  };
};

export const createEventTriggersStore = (db: Database.Database): EventTriggersStore => {
  initializePreapprovalLifecycle(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      trigger_id     TEXT PRIMARY KEY,
      recipe_id      TEXT NOT NULL,
      publisher_id   TEXT NOT NULL,
      pattern        TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      last_fired_at  INTEGER,
      last_error     TEXT,
      dish_id        TEXT,
      watch_interval_ms INTEGER,
      origin         TEXT NOT NULL DEFAULT 'user',
      filter         TEXT,
      fields         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_triggers_recipe
      ON ${TABLE}(recipe_id, publisher_id);
    CREATE INDEX IF NOT EXISTS idx_event_triggers_enabled
      ON ${TABLE}(enabled) WHERE enabled = 1;
  `);
  // Poll-manager / G6 — `origin` provenance column on a table that
  // pre-dates it. Pragma-guarded idempotent ALTER (the
  // `ensureBistemporalSchema` idiom); pre-existing rows default to
  // 'user' (every pre-G6 row was authored via `triggers.create`).
  // Authoring sugar — `filter` + `fields` dispatch-filter columns,
  // same idiom; pre-existing rows have neither (NULL = pass-all).
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>)
      .map((c) => c.name),
  );
  if (!columns.has('origin')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`);
  }
  if (!columns.has('filter')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN filter TEXT`);
  }
  if (!columns.has('fields')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN fields TEXT`);
  }
  // D-179 P2 — dish binding + lifted poll-interval knob. The retired
  // `config_patch` column is dropped from fresh DDL and simply lingers
  // unused (NULL) in pre-P2 dev databases — pre-launch, no migration.
  if (!columns.has('dish_id')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN dish_id TEXT`);
  }
  if (!columns.has('watch_interval_ms')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN watch_interval_ms INTEGER`);
  }

  const insertStmt = db.prepare<[
    string, string, string, string, number, number, string | null, number | null,
    string, string | null, string | null,
  ]>(
    `INSERT INTO ${TABLE}
       (trigger_id, recipe_id, publisher_id, pattern, enabled, created_at, dish_id, watch_interval_ms, origin, filter, fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(`SELECT * FROM ${TABLE} WHERE trigger_id = ?`);
  const selectAll = db.prepare(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`);
  const selectEnabled = db.prepare(`SELECT * FROM ${TABLE} WHERE enabled = 1 ORDER BY created_at ASC`);
  const deleteOne = db.prepare(`DELETE FROM ${TABLE} WHERE trigger_id = ?`);
  const countStmt = db.prepare<[], { n: number }>(`SELECT COUNT(*) as n FROM ${TABLE}`);
  const material = (id: string): Record<string, unknown> | null => {
    const row = selectOne.get(id) as Row | undefined;
    if (!row) return null;
    const trigger = rowToTrigger(row);
    return triggerPreapprovalMaterial({ ...trigger, enabled: preapprovalLogicalEnabled(db, 'next_trigger', id, trigger.enabled) });
  };

  return {
    create(row) {
      return mutatePreapprovalResource(db, 'next_trigger', row.trigger_id, () => material(row.trigger_id), () => {
        assertPreapprovalLegacyEnable(db, 'next_trigger', row.trigger_id, row.enabled);
        const filterJson = serializeFilter(row.filter);
        const fieldsJson = serializeFields(row.fields);
        insertStmt.run(
          row.trigger_id,
          row.recipe_id,
          row.publisher_id,
          row.pattern,
          row.enabled ? 1 : 0,
          row.created_at,
          row.dish_id ?? null,
          row.watch_interval_ms ?? null,
          row.origin ?? 'user',
          filterJson,
          fieldsJson,
        );
        const result: EventTrigger = {
          trigger_id: row.trigger_id,
          recipe_id: row.recipe_id,
          publisher_id: row.publisher_id,
          pattern: row.pattern,
          enabled: row.enabled,
          created_at: row.created_at,
          last_fired_at: null,
          last_error: null,
          ...(row.dish_id != null && row.dish_id.length > 0 ? { dish_id: row.dish_id } : {}),
          ...(row.watch_interval_ms != null ? { watch_interval_ms: row.watch_interval_ms } : {}),
          origin: row.origin ?? 'user',
          ...(filterJson !== null ? { filter: row.filter as Record<string, unknown> } : {}),
          ...(fieldsJson !== null ? { fields: row.fields as string[] } : {}),
        };
        return result;
      });
    },

    update(trigger_id, patch) {
      return mutatePreapprovalResource(db, 'next_trigger', trigger_id, () => material(trigger_id), () => {
        assertPreapprovalLegacyEnable(db, 'next_trigger', trigger_id, patch.enabled === true);
        if (patch.enabled !== undefined || patch.pattern !== undefined || patch.dish_id !== undefined || patch.watch_interval_ms !== undefined) {
          notePreapprovalOwnerMutation(db, 'next_trigger', trigger_id);
        }
        const existing = selectOne.get(trigger_id) as Row | undefined;
        if (!existing) return null;
        const next: Row = { ...existing };
        if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
        if (patch.pattern !== undefined) next.pattern = patch.pattern;
        if (patch.dish_id !== undefined) next.dish_id = patch.dish_id;
        if (patch.watch_interval_ms !== undefined) {
          next.watch_interval_ms = patch.watch_interval_ms;
        }
        if (patch.last_fired_at !== undefined) next.last_fired_at = patch.last_fired_at;
        if (patch.last_error !== undefined) next.last_error = patch.last_error;

        db.prepare(
          `UPDATE ${TABLE} SET
             pattern = ?,
             enabled = ?,
             dish_id = ?,
             watch_interval_ms = ?,
             last_fired_at = ?,
             last_error = ?
           WHERE trigger_id = ?`,
        ).run(
          next.pattern,
          next.enabled,
          next.dish_id,
          next.watch_interval_ms,
          next.last_fired_at,
          next.last_error,
          trigger_id,
        );
        return rowToTrigger(next);
      });
    },

    remove(trigger_id) {
      return mutatePreapprovalResource(db, 'next_trigger', trigger_id, () => material(trigger_id), () => {
        notePreapprovalOwnerMutation(db, 'next_trigger', trigger_id);
        const res = deleteOne.run(trigger_id);
        return res.changes > 0;
      });
    },

    get(trigger_id) {
      const row = selectOne.get(trigger_id) as Row | undefined;
      return row ? rowToTrigger(row) : null;
    },

    list() {
      const rows = selectAll.all() as Row[];
      return rows.map(rowToTrigger);
    },

    listEnabled() {
      const rows = selectEnabled.all() as Row[];
      return rows.map(rowToTrigger);
    },

    count() {
      const row = countStmt.get();
      return row?.n ?? 0;
    },
  };
};
