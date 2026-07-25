/** D-120 Phase 2 — recipe-insight backfill for existing audit entries.
 *
 *  At boot, walks the unique `recipe_hash` values present in
 *  `audit_entries` and, for every hash that matches a currently
 *  installed recipe (i.e. `hashRecipe(stored_recipe) === audit.recipe_hash`),
 *  populates `recipe_insights` and stamps `recipe_insight_id` onto the
 *  matching audit rows via `json_set`.
 *
 *  Hashes with no matching installed recipe (very old runs whose
 *  recipes have since been uninstalled or re-edited past their old
 *  shape) are skipped — those audit rows keep `recipe_insight_id`
 *  absent and surface as `NULL` in provenance-aware queries.
 *
 *  Idempotent: safe to re-run on every boot. `getOrCreateRecipeInsight`
 *  is content-addressed (re-insert is a no-op); `json_set` always
 *  produces the same output for the same input.
 *
 *  Spec: D-120 (Phase 2 → "Backfill existing audit entries").
 */

import type Database from 'better-sqlite3';
import { hashRecipe, flattenRecipe, serializeFlattenedInsight } from '@recued/recipes';
import { getOrCreateRecipeInsight } from './memory-schema.js';
import type { RecipeStore } from './recipe-store.js';

/** Tuple result returned by `backfillRecipeInsights`. Useful for
 *  startup logging + tests asserting the backfill outcome. */
export interface BackfillResult {
  /** Distinct `recipe_hash` values found in audit_entries. */
  hashes_scanned: number;
  /** Hashes that matched a currently installed recipe and produced
   *  (or reused) a recipe_insights row. */
  insights_populated: number;
  /** Audit rows updated with a fresh `recipe_insight_id` pointer. */
  audit_rows_stamped: number;
  /** Hashes that didn't match any installed recipe — those audit
   *  rows stay with `recipe_insight_id` absent. */
  orphan_hashes: number;
}

/** Run the backfill. Caller passes the open SQLite handle (must
 *  already have run `ensureMemorySchema`) + the live recipe store
 *  (to look up currently installed recipes by id). Returns counters
 *  for telemetry / tests; throws only if the underlying SQLite
 *  connection itself fails (per-row failures are swallowed so a
 *  single bad audit row never aborts a boot-time backfill).
 *
 *  This intentionally walks audit_entries via raw SQL rather than
 *  through the AuditLogStore so we can avoid pulling every row's
 *  full JSON envelope into memory just to read two fields. */
export const backfillRecipeInsights = (
  db: Database.Database,
  recipeStore: RecipeStore,
): BackfillResult => {
  const result: BackfillResult = {
    hashes_scanned: 0,
    insights_populated: 0,
    audit_rows_stamped: 0,
    orphan_hashes: 0,
  };

  // 1. Snapshot every unique recipe_hash referenced by an audit row
  //    that doesn't already carry a recipe_insight_id pointer. The
  //    json_extract index installed in Phase 1
  //    (audit_entries_recipe_insight_id_idx) makes the predicate cheap.
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(data, '$.recipe_hash') AS h
         FROM audit_entries
        WHERE json_extract(data, '$.recipe_hash') IS NOT NULL
          AND json_extract(data, '$.recipe_insight_id') IS NULL`,
    )
    .all() as Array<{ h: string | null }>;
  const hashes = rows.map((r) => r.h).filter((h): h is string => typeof h === 'string');
  result.hashes_scanned = hashes.length;
  if (hashes.length === 0) return result;

  // 2. Build a one-shot lookup: for every currently installed recipe,
  //    map its current hash → recipe_id. The store can hold many
  //    recipes; we materialise the map up front so per-hash lookups
  //    stay O(1).
  const installedHashToRecipe = new Map<string, ReturnType<RecipeStore['get']>>();
  for (const id of recipeStore.ids()) {
    const recipe = recipeStore.get(id);
    if (!recipe) continue;
    installedHashToRecipe.set(hashRecipe(recipe), recipe);
  }

  // 3. For every audit-side hash that matches an installed recipe,
  //    flatten + upsert the insight, then stamp every audit row that
  //    carries the same hash. Hashes with no install match are
  //    counted as orphans and skipped.
  const stampStmt = db.prepare(
    `UPDATE audit_entries
        SET data = json_set(data, '$.recipe_insight_id', ?)
      WHERE json_extract(data, '$.recipe_hash') = ?
        AND json_extract(data, '$.recipe_insight_id') IS NULL`,
  );

  for (const hash of hashes) {
    const recipe = installedHashToRecipe.get(hash);
    if (!recipe) {
      result.orphan_hashes++;
      continue;
    }
    try {
      const flattened = flattenRecipe(recipe);
      const { json, over_cap } = serializeFlattenedInsight(flattened);
      if (over_cap) {
        // Pathological recipe — same skip semantics as the live
        // install hook in recipe-store.save.
        result.orphan_hashes++;
        continue;
      }
      const insightId = getOrCreateRecipeInsight(db, {
        hash,
        slug: recipe.recipe_id,
        version: recipe.version,
        flattened: json,
      });
      result.insights_populated++;
      const update = stampStmt.run(insightId, hash);
      result.audit_rows_stamped += update.changes;
    } catch {
      // Per-hash failures don't abort the rest of the backfill.
      result.orphan_hashes++;
    }
  }

  return result;
};
