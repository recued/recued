/** SQLite-backed Dish store — D-179 P1.
 *
 *  Standing execution instances (dishes) live on the instance that
 *  owns them, exactly like schedules: no mirroring, no cloud sync.
 *  Ephemeral (manual-run) dish ids never touch this table — they are
 *  minted per run for audit attribution only (`ephemeralDishId`).
 *
 *  Persistence mirrors the `@recued/contracts` `Dish` shape so clients
 *  round-trip values without translation. The default-dish invariant
 *  (≤ 1 `is_default` row per recipe) is enforced by a partial unique
 *  index, not application code, so concurrent creates can't race a
 *  second default in.
 */

import type Database from 'better-sqlite3';
import type { Dish } from '@recued/contracts';
import { initializePreapprovalLifecycle, mutatePreapprovalResource } from './storage/preapproval-lifecycle.js';

/** The slice of a dish a pre-approval COMMITS TO. Pinned as a dependency at
 *  prepare time (`preapproval-recipe-sources.ts`); every dish write re-hashes
 *  it, and a changed hash bumps the revision and invalidates every execution
 *  pinned to this dish.
 *
 *  ⚠ `enabled` IS AN ENFORCEMENT POINT, NOT MERELY A CHANGE SIGNAL — do not
 *  "simplify" it out. `preapproval-driver.ts` dispatches a reviewed run with
 *  NO `dish_id`, so the fire-time dish gate in `scheduler.ts` never applies to
 *  one; invalidation-on-pause is the only thing stopping a reviewed run from
 *  firing against a paused dish. Removing the field needs a dispatch-time
 *  `dish.enabled` re-check in the driver FIRST.
 *
 *  Scope: on a schedule/trigger-managed dish the owner's pause already clears
 *  the pre-approval through the rule's own row (`notePreapprovalOwnerMutation`
 *  in `schedule-store.ts` / `triggers/store.ts`), and `dishes.update` freezes
 *  `enabled` on those rows regardless. This field carries the rule alone only
 *  for an unmanaged or default dish. */
export const dishPreapprovalMaterial = (dish: Dish): Record<string, unknown> => ({
  recipe_id: dish.recipe_id, publisher_id: dish.publisher_id, enabled: dish.enabled, config_overlay: dish.config_overlay,
  group_id: dish.group_id ?? null,
});

export interface DishStore {
  list(): Dish[];
  listByRecipe(recipe_id: string): Dish[];
  /** D-179 P3 — member dishes of a group. */
  listByGroup(group_id: string): Dish[];
  get(dish_id: string): Dish | null;
  /** The recipe's default dish, when one has been minted. */
  getDefault(recipe_id: string): Dish | null;
  /** Upsert keyed on `dish_id`. Throws (SQLITE_CONSTRAINT) when the
   *  write would create a second `is_default` row for the same recipe —
   *  deliberately NOT `INSERT OR REPLACE`, which would silently DELETE
   *  the existing default dish on collision instead of surfacing the
   *  constraint (the handler maps the throw to a `conflict` rpc error). */
  set(dish: Dish): void;
  delete(dish_id: string): boolean;
  /** D-179 P3 — clear `group_id` on every member of a group (group
   *  delete detaches, never cascades). Returns the detached dish ids. */
  detachGroup(group_id: string): string[];
}

export interface CreateDishStoreOptions {
  /** Phase B gate hook — same contract as the schedule store: every
   *  `set` / `delete` reports the signed byte delta of the serialized
   *  row. Sink exceptions are swallowed. */
  onBytesChanged?: (delta: number) => void;
}

/** Create a SQLite-backed dish store. Auto-creates the table. */
export const createDishStore = (
  db: Database.Database,
  options: CreateDishStoreOptions = {},
): DishStore => {
  initializePreapprovalLifecycle(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dishes (
      dish_id    TEXT NOT NULL PRIMARY KEY,
      recipe_id  TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      data       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dishes_recipe_idx ON dishes (recipe_id);
    CREATE UNIQUE INDEX IF NOT EXISTS dishes_default_idx
      ON dishes (recipe_id) WHERE is_default = 1;
  `);
  // D-179 P3 — group-membership column on a table that pre-dates it.
  // Pragma-guarded idempotent ALTER (the trigger-store idiom);
  // pre-existing rows are free dishes (NULL).
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(dishes)`).all() as Array<{ name: string }>)
      .map((c) => c.name),
  );
  if (!columns.has('group_id')) {
    db.exec(`ALTER TABLE dishes ADD COLUMN group_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS dishes_group_idx ON dishes (group_id) WHERE group_id IS NOT NULL`);

  const onBytesChanged = options.onBytesChanged;
  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch (_err) { /* never break writes */ }
  };

  const rowToDish = (row: { data: string }): Dish =>
    JSON.parse(row.data) as Dish;
  const material = (id: string): unknown | null => {
    const row = db.prepare('SELECT data FROM dishes WHERE dish_id=?').get(id) as { data: string } | undefined;
    return row ? dishPreapprovalMaterial(rowToDish(row)) : null;
  };
  const defaultMaterial = (recipeId: string): unknown => {
    const row = db.prepare('SELECT dish_id FROM dishes WHERE recipe_id=? AND is_default=1')
      .get(recipeId) as { dish_id: string } | undefined;
    return { dish_id: row?.dish_id ?? null };
  };
  const mutateDefaults = <T>(recipeIds: string[], write: () => T): T => {
    const [id, ...rest] = [...new Set(recipeIds)];
    return id === undefined ? write() : mutatePreapprovalResource(db, 'recipe_default_dish', id,
      () => defaultMaterial(id), () => mutateDefaults(rest, write));
  };

  const priorBytes = (dish_id: string): number => {
    const row = db
      .prepare(`SELECT length(data) AS len FROM dishes WHERE dish_id = ?`)
      .get(dish_id) as { len: number } | undefined;
    return row?.len ?? 0;
  };

  return {
    list() {
      const rows = db.prepare(`SELECT data FROM dishes ORDER BY dish_id`).all() as { data: string }[];
      return rows.map(rowToDish);
    },

    listByGroup(group_id) {
      const rows = db.prepare(`SELECT data FROM dishes WHERE group_id = ? ORDER BY dish_id`).all(group_id) as { data: string }[];
      return rows.map(rowToDish);
    },

    listByRecipe(recipe_id) {
      const rows = db.prepare(`SELECT data FROM dishes WHERE recipe_id = ? ORDER BY dish_id`).all(recipe_id) as { data: string }[];
      return rows.map(rowToDish);
    },

    get(dish_id) {
      const row = db.prepare(`SELECT data FROM dishes WHERE dish_id = ?`).get(dish_id) as { data: string } | undefined;
      return row ? rowToDish(row) : null;
    },

    getDefault(recipe_id) {
      const row = db
        .prepare(`SELECT data FROM dishes WHERE recipe_id = ? AND is_default = 1`)
        .get(recipe_id) as { data: string } | undefined;
      return row ? rowToDish(row) : null;
    },

    set(dish) {
      db.transaction(() => {
        const prior = db.prepare('SELECT recipe_id FROM dishes WHERE dish_id=?').get(dish.dish_id) as { recipe_id: string } | undefined;
        mutateDefaults([dish.recipe_id, ...(prior ? [prior.recipe_id] : [])], () =>
          mutatePreapprovalResource(db, 'dish', dish.dish_id, () => material(dish.dish_id), () => {
            const serialized = JSON.stringify(dish);
            const prev = priorBytes(dish.dish_id);
            db.prepare(`
              INSERT INTO dishes (dish_id, recipe_id, is_default, group_id, data) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (dish_id) DO UPDATE SET
                recipe_id  = excluded.recipe_id,
                is_default = excluded.is_default,
                group_id   = excluded.group_id,
                data       = excluded.data
            `).run(dish.dish_id, dish.recipe_id, dish.is_default ? 1 : 0, dish.group_id ?? null, serialized);
            reportDelta(serialized.length - prev);
          }));
      }).immediate();
    },

    delete(dish_id) {
      return db.transaction(() => {
        const prior = db.prepare('SELECT recipe_id FROM dishes WHERE dish_id=?').get(dish_id) as { recipe_id: string } | undefined;
        return mutateDefaults(prior ? [prior.recipe_id] : [], () =>
          mutatePreapprovalResource(db, 'dish', dish_id, () => material(dish_id), () => {
            const prev = priorBytes(dish_id);
            const result = db.prepare(`DELETE FROM dishes WHERE dish_id = ?`).run(dish_id);
            if (result.changes > 0 && prev > 0) reportDelta(-prev);
            return result.changes > 0;
          }));
      }).immediate();
    },

    detachGroup(group_id) {
      // Rewrite each member's JSON without group_id, then clear the
      // column — one transaction so a crash can't desync row vs JSON.
      const detach = db.transaction((gid: string): string[] => {
        const rows = db
          .prepare(`SELECT data FROM dishes WHERE group_id = ?`)
          .all(gid) as { data: string }[];
        let delta = 0;
        const ids: string[] = [];
        const update = db.prepare(`UPDATE dishes SET group_id = NULL, data = ? WHERE dish_id = ?`);
        for (const row of rows) {
          const dish = JSON.parse(row.data) as Dish;
          delete dish.group_id;
          const serialized = JSON.stringify(dish);
          mutatePreapprovalResource(db, 'dish', dish.dish_id, () => material(dish.dish_id),
            () => update.run(serialized, dish.dish_id));
          delta += serialized.length - row.data.length;
          ids.push(dish.dish_id);
        }
        if (delta !== 0) reportDelta(delta);
        return ids;
      });
      return detach(group_id);
    },
  };
};
