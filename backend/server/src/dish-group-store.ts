/** SQLite-backed DishGroup store — D-179 P3.
 *
 *  A dish group is the free-floating workflow container (spec § 3):
 *  one shared config overlay member dishes inherit, deliberately
 *  cross-pack. Membership lives on the DISH row (`Dish.group_id`),
 *  not here — this table holds only the group identity + overlay, so
 *  group delete is a detach of members (dish-store concern), never a
 *  cascade.
 *
 *  Same posture as dishes: instance-local, no mirroring, no cloud
 *  sync; rows mirror the `@recued/contracts` `DishGroup` shape.
 */

import type Database from 'better-sqlite3';
import type { DishGroup } from '@recued/contracts';

export interface DishGroupStore {
  list(): DishGroup[];
  get(group_id: string): DishGroup | null;
  /** Upsert keyed on `group_id`. */
  set(group: DishGroup): void;
  delete(group_id: string): boolean;
}

export interface CreateDishGroupStoreOptions {
  /** Phase B gate hook — signed byte delta per write (sink exceptions
   *  swallowed). Same contract as the dish / schedule stores. */
  onBytesChanged?: (delta: number) => void;
}

/** Create a SQLite-backed dish-group store. Auto-creates the table. */
export const createDishGroupStore = (
  db: Database.Database,
  options: CreateDishGroupStoreOptions = {},
): DishGroupStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dish_groups (
      group_id TEXT NOT NULL PRIMARY KEY,
      data     TEXT NOT NULL
    );
  `);

  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };

  const priorBytes = (group_id: string): number => {
    const row = db
      .prepare(`SELECT length(data) AS len FROM dish_groups WHERE group_id = ?`)
      .get(group_id) as { len: number } | undefined;
    return row?.len ?? 0;
  };

  return {
    list() {
      const rows = db.prepare(`SELECT data FROM dish_groups ORDER BY group_id`).all() as { data: string }[];
      return rows.map((row) => JSON.parse(row.data) as DishGroup);
    },

    get(group_id) {
      const row = db.prepare(`SELECT data FROM dish_groups WHERE group_id = ?`).get(group_id) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as DishGroup) : null;
    },

    set(group) {
      const serialized = JSON.stringify(group);
      const prev = priorBytes(group.group_id);
      db.prepare(`
        INSERT INTO dish_groups (group_id, data) VALUES (?, ?)
        ON CONFLICT (group_id) DO UPDATE SET data = excluded.data
      `).run(group.group_id, serialized);
      reportDelta(serialized.length - prev);
    },

    delete(group_id) {
      const prev = priorBytes(group_id);
      const result = db.prepare(`DELETE FROM dish_groups WHERE group_id = ?`).run(group_id);
      if (result.changes > 0 && prev > 0) reportDelta(-prev);
      return result.changes > 0;
    },
  };
};
