/** Per-dish `context.recipe.*` continuity store — D-179 P1.
 *
 *  The engine's `ContextRecipeStore` contract (D-120 Phase 4.5,
 *  `packages/engine/src/context-recipe.ts`) was host-implementation-
 *  pending until now; D-179 lands the server host keyed on `dish_id`
 *  rather than `recipe_id` — the re-keying that stops ten dishes of
 *  one recipe cross-contaminating each other's
 *  `{{context.recipe.<step_id>}}` reads (spec § 2.2).
 *
 *  Storage is the `prefs.<dish_id>.context_recipe` slot conceptually;
 *  physically a dedicated table so the snapshot (≤ 16 KB, JSON) never
 *  bloats the prefs row. Per-pair, never cloud-synced (D-102).
 *  Ephemeral dishes never get entries — only standing `dish_id`s are
 *  written (the execute path skips the store when no dish was bound).
 */

import type Database from 'better-sqlite3';
import type { ContextRecipe } from '@recued/contracts';

export interface DishContextStore {
  get(dish_id: string): ContextRecipe | null;
  set(dish_id: string, snapshot: ContextRecipe): void;
  /** Drop a dish's snapshot — called on dish delete. */
  clear(dish_id: string): void;
}

/** Create the SQLite-backed per-dish continuity store. */
export const createDishContextStore = (
  db: Database.Database,
): DishContextStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dish_context_recipe (
      dish_id TEXT NOT NULL PRIMARY KEY,
      data    TEXT NOT NULL
    );
  `);

  return {
    get(dish_id) {
      const row = db
        .prepare(`SELECT data FROM dish_context_recipe WHERE dish_id = ?`)
        .get(dish_id) as { data: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.data) as ContextRecipe;
      } catch {
        // A corrupt snapshot degrades to first-run semantics — recipes
        // wrap context.recipe reads in `coalesce` by convention.
        return null;
      }
    },

    set(dish_id, snapshot) {
      db.prepare(`INSERT OR REPLACE INTO dish_context_recipe (dish_id, data) VALUES (?, ?)`)
        .run(dish_id, JSON.stringify(snapshot));
    },

    clear(dish_id) {
      db.prepare(`DELETE FROM dish_context_recipe WHERE dish_id = ?`).run(dish_id);
    },
  };
};
