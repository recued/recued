/** D-120 Phase 2 — `recipe_insights` storage shim.
 *
 *  Content-addressed snapshots of recipe shape at execution time.
 *  Same content (hash) → same row, regardless of who installs the
 *  recipe or how many devices it lands on. Memory entries reference
 *  insights by hash so historical audit / provenance queries stay
 *  interpretable across recipe-version drift.
 *
 *  Two storage backings exist in the codebase:
 *
 *    - **Server SQLite** — uses an integer surrogate `id` so the
 *      `links` table can FK against a 4-byte int instead of the
 *      32-byte hex hash. Server-only path; lives in
 *      `backend/server/src/memory-schema.ts` (`getOrCreateRecipeInsight`).
 *
 *    - **Extension IDB** — keyed by the hash itself. No FK joins on
 *      the extension side (provenance link emission is server-only
 *      per the D-120 channel-invariant: `data.timeline()` is an
 *      MCP-channel surface). This file is that wrapper.
 *
 *  Both produce byte-identical `flattened` content so any consumer
 *  that joins on hash gets the same answer regardless of origin.
 *
 *  Spec: D-120.
 */

import type { Collection } from './types.js';

/** One row in the recipe_insights store. Mirrors the SQL columns
 *  defined in `backend/server/src/memory-schema.ts` minus the
 *  surrogate `id` (extension addresses by hash directly). The
 *  `flattened` field carries the JSON-serialized
 *  `FlattenedInsight` shape from `@recued/recipes/flatten`. */
export interface RecipeInsightRecord {
  hash: string;
  slug: string;
  version: number;
  flattened: string;
  created_at: number;
}

/** Storage interface — same get-or-create contract as the SQL-side
 *  `getOrCreateRecipeInsight`, returning the stored row instead of
 *  the surrogate `id`. */
export interface RecipeInsightsStore {
  /** Idempotent upsert keyed by `hash`. Returns the stored row;
   *  re-calling with the same hash always returns the same content
   *  (later writes with mismatched slug/version are no-ops — the
   *  earliest write wins, matching the server SQL `ON CONFLICT … DO
   *  NOTHING` semantics). */
  getOrCreate(record: RecipeInsightRecord): Promise<RecipeInsightRecord>;
  /** Look up an insight by hash. Returns null when missing — recipes
   *  installed before D-120 Phase 2 surface as null until the next
   *  install / upgrade re-populates the row. */
  get(hash: string): Promise<RecipeInsightRecord | null>;
  /** Total stored insight count. Bounded by
   *  `installed_recipes × versions`. */
  size(): Promise<number>;
  /** Delete every insight whose hash is not present in `keepHashes`.
   *  Used by the Phase 7 cascade-aware retention vacuum once an
   *  audit-row prune leaves an insight orphaned. Returns the
   *  number of rows removed. */
  prune(keepHashes: ReadonlySet<string>): Promise<number>;
}

/** Build a `RecipeInsightsStore` over an arbitrary `Collection`.
 *  Use with `createIDBCollection<RecipeInsightRecord>({ dbName:
 *  'recued-recipe-insights' })` in production; with
 *  `createInMemoryCollection<RecipeInsightRecord>()` in tests. */
export const createRecipeInsightsStore = (
  backing: Collection<RecipeInsightRecord>,
): RecipeInsightsStore => {
  return {
    async getOrCreate(record) {
      const existing = await backing.get(record.hash);
      if (existing) return existing;
      await backing.set(record.hash, record);
      // Re-read so we hand back exactly what's persisted (in case a
      // concurrent writer landed first — collection.set is
      // last-write-wins, but we want the durable row in either
      // case so callers see the actual insight content).
      const stored = await backing.get(record.hash);
      return stored ?? record;
    },

    async get(hash) {
      return backing.get(hash);
    },

    async size() {
      return backing.size();
    },

    async prune(keepHashes) {
      const all = await backing.list();
      let removed = 0;
      for (const row of all) {
        if (!keepHashes.has(row.hash)) {
          await backing.delete(row.hash);
          removed++;
        }
      }
      return removed;
    },
  };
};
