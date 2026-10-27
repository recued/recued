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
import type { WarehouseEvent } from '@recued/warehouse-events';
import { applyDatabaseMigrationStatements, DATABASE_MIGRATIONS } from '../database-schema.js';
import type { EventTrigger, EventTriggerOrigin } from '@recued/contracts';
import {
  assertPreapprovalLegacyEnable, initializePreapprovalLifecycle, mutatePreapprovalResource,
  notePreapprovalOwnerMutation, preapprovalLogicalEnabled,
} from '../storage/preapproval-lifecycle.js';

export const triggerPreapprovalMaterial = (row: EventTrigger): Record<string, unknown> => ({
  recipe_id: row.recipe_id, publisher_id: row.publisher_id, pattern: row.pattern,
  enabled: row.enabled, dish_id: row.dish_id ?? null, watch_interval_ms: row.watch_interval_ms ?? null,
  filter: row.filter ?? null, fields: row.fields ?? null, origin: row.origin ?? 'user',
  read_contract_id: row.read_contract_id ?? null,
});

const TABLE = 'event_triggers';
const PARKED_TABLE = 'event_trigger_parked_events';

/** An event a trigger was owed when the dispatcher stopped, kept for the next
 *  start. `seq` is its place in line; a replayed event that is set aside again
 *  goes back to the same place. */
export interface ParkedTriggerEvent {
  readonly seq: number;
  readonly trigger_id: string;
  readonly event: WarehouseEvent;
  readonly parked_at: number;
}

export interface ParkTriggerEventInput {
  readonly trigger_id: string;
  readonly event: WarehouseEvent;
  /** Set when the event came out of this table by a replay: it is put back
   *  where it was, ahead of anything parked after it. */
  readonly parked_seq?: number;
}

export interface EventTriggersStore {
  readonly realmDatabase?: Database.Database;
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
     *  entry's compiled `where` + `fields`), and by `triggers.create`
     *  from the same sugar (D-315 §5.1). */
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
      read_contract_id?: string | null;
      /** D-315 §5.1 — the dispatch-filter halves, recompiled with a new
       *  `pattern` by `triggers.update`. Null clears. */
      filter?: Record<string, unknown> | null;
      fields?: string[] | null;
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
  /** D-296 — whether the OWNER has this trigger on. The row's `enabled` reads
   *  false while a reviewed execution (D-261) parks it for its next fire; this
   *  is the owner's state behind the park, the one the row goes back to. False
   *  for an unknown id. */
  ownerEnabled(trigger_id: string): boolean;
  /** Count rows. Exposed for admin / test visibility. */
  count(): number;
  /** D-315 — keep events the dispatcher stopped before starting, for the next
   *  start to replay (`EventTriggerDispatcher.replayParked`). A mail fact's
   *  event announces its fact once — read again, the fact never fires again —
   *  so a restart must not drop the ones still queued. In the order given.
   *  Optional for test doubles; without it they are dropped as they always
   *  were. */
  parkTriggerEvents?(entries: ReadonlyArray<ParkTriggerEventInput>, at: number): void;
  /** Parked events after `after_seq`, oldest first. */
  listParkedTriggerEvents?(after_seq: number, limit: number): ParkedTriggerEvent[];
  /** Forget one parked event: it was handed back to its trigger. */
  unparkTriggerEvent?(seq: number): void;
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
  read_contract_id?: string | null;
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
    ...(row.read_contract_id ? { read_contract_id: row.read_contract_id } : {}),
    ...(row.watch_interval_ms != null ? { watch_interval_ms: row.watch_interval_ms } : {}),
    origin: row.origin === 'recipe' ? 'recipe' : 'user',
    ...(filter !== undefined ? { filter } : {}),
    ...(fields !== undefined ? { fields } : {}),
  };
};

export const createEventTriggersStore = (db: Database.Database): EventTriggersStore => {
  initializePreapprovalLifecycle(db);
  // The immutable version-3 initializer also supports isolated store fixtures
  // and legacy/lazy construction. Managed boot applies it transactionally first.
  db.transaction(() => applyDatabaseMigrationStatements(db, DATABASE_MIGRATIONS[0]!.statements))();
  // Store-local, like every table outside the version-3 baseline. AUTOINCREMENT
  // so a seq is never reused: an event replayed out of here and set aside again
  // goes back under its own seq, which a later event can then never have taken.
  // Plain JSON: a mail fact's own rows are stored the same way (whole-file
  // encryption at rest, D-212), and parking runs while the vault may be sealed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PARKED_TABLE} (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      parked_at  INTEGER NOT NULL
    );
  `);
  const parkNew = db.prepare<[string, string, number]>(
    `INSERT INTO ${PARKED_TABLE} (trigger_id, event_json, parked_at) VALUES (?, ?, ?)`,
  );
  const parkAgain = db.prepare<[number, string, string, number]>(
    `INSERT OR IGNORE INTO ${PARKED_TABLE} (seq, trigger_id, event_json, parked_at) VALUES (?, ?, ?, ?)`,
  );
  const listParked = db.prepare<[number, number]>(
    `SELECT seq, trigger_id, event_json, parked_at FROM ${PARKED_TABLE} WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
  );
  const unpark = db.prepare<[number]>(`DELETE FROM ${PARKED_TABLE} WHERE seq = ?`);
  const parkAll = db.transaction((entries: ReadonlyArray<ParkTriggerEventInput>, at: number) => {
    for (const entry of entries) {
      const json = JSON.stringify(entry.event);
      if (entry.parked_seq !== undefined) parkAgain.run(entry.parked_seq, entry.trigger_id, json, at);
      else parkNew.run(entry.trigger_id, json, at);
    }
  });

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
    realmDatabase: db,
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
        if (patch.enabled !== undefined || patch.pattern !== undefined || patch.dish_id !== undefined
          || patch.watch_interval_ms !== undefined || patch.filter !== undefined || patch.fields !== undefined || patch.read_contract_id !== undefined) {
          notePreapprovalOwnerMutation(db, 'next_trigger', trigger_id);
        }
        const existing = selectOne.get(trigger_id) as Row | undefined;
        if (!existing) return null;
        const next: Row = { ...existing };
        if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
        if (patch.pattern !== undefined) next.pattern = patch.pattern;
        if (patch.dish_id !== undefined) next.dish_id = patch.dish_id;
        if (patch.read_contract_id !== undefined) next.read_contract_id = patch.read_contract_id;
        if (patch.watch_interval_ms !== undefined) {
          next.watch_interval_ms = patch.watch_interval_ms;
        }
        if (patch.last_fired_at !== undefined) next.last_fired_at = patch.last_fired_at;
        if (patch.last_error !== undefined) next.last_error = patch.last_error;
        if (patch.filter !== undefined) next.filter = serializeFilter(patch.filter);
        if (patch.fields !== undefined) next.fields = serializeFields(patch.fields);

        db.prepare(
          `UPDATE ${TABLE} SET
             pattern = ?,
             enabled = ?,
             dish_id = ?,
             watch_interval_ms = ?,
             last_fired_at = ?,
             last_error = ?,
             filter = ?,
             fields = ?,
             read_contract_id = ?
           WHERE trigger_id = ?`,
        ).run(
          next.pattern,
          next.enabled,
          next.dish_id,
          next.watch_interval_ms,
          next.last_fired_at,
          next.last_error,
          next.filter,
          next.fields,
          next.read_contract_id ?? null,
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

    ownerEnabled(trigger_id) {
      const row = selectOne.get(trigger_id) as Row | undefined;
      return row ? preapprovalLogicalEnabled(db, 'next_trigger', trigger_id, row.enabled === 1) : false;
    },

    listEnabled() {
      const rows = selectEnabled.all() as Row[];
      return rows.map(rowToTrigger);
    },

    count() {
      const row = countStmt.get();
      return row?.n ?? 0;
    },

    parkTriggerEvents(entries, at) {
      if (entries.length > 0) parkAll(entries, at);
    },

    listParkedTriggerEvents(after_seq, limit) {
      const out: ParkedTriggerEvent[] = [];
      let cursor = after_seq;
      while (out.length < limit) {
        const rows = listParked.all(cursor, limit - out.length) as Array<{
          seq: number; trigger_id: string; event_json: string; parked_at: number;
        }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = row.seq;
          let event: WarehouseEvent;
          try {
            event = JSON.parse(row.event_json) as WarehouseEvent;
          } catch {
            // Unreadable, it can never be delivered: let it go rather than
            // stop every event behind it on each start.
            unpark.run(row.seq);
            continue;
          }
          out.push({ seq: row.seq, trigger_id: row.trigger_id, event, parked_at: row.parked_at });
        }
      }
      return out;
    },

    unparkTriggerEvent(seq) {
      unpark.run(seq);
    },
  };
};
