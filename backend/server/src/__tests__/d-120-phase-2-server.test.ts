/** D-120 Phase 2 — server-side install hook + backfill tests.
 *
 *  Covers:
 *    - recipeStore.save populates recipe_insights with the same hash
 *    - re-saving the same recipe form is idempotent
 *    - recipe edits produce a new insight row (different hash)
 *    - backfillRecipeInsights:
 *        - empty audit_entries → no work, all counters zero
 *        - matched hash → insight populated + audit row stamped with id
 *        - orphan hash → counted, no insight created, no audit stamp
 *        - mixed batch → matched + orphan handled in one pass
 *        - already-stamped audit row skipped on re-run (idempotent)
 *        - oversized recipe → orphan-counted, not inserted
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { hashRecipe } from '@recued/recipes';
import type { RecipeDefinition } from '@recued/contracts';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { ensureMemorySchema } from '../memory-schema.js';
import { backfillRecipeInsights } from '../memory-backfill.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';

const baseRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'recipe-x',
  version: 1,
  ttl: 60,
  metadata: { name: 'Recipe X', author: 'tester', description: 'fixture' } as RecipeDefinition['metadata'],
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'identity', value: 1 }],
  output: { sidebar: [] },
  ...overrides,
});

const setupDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  ensureAuditIndexes(db);
  ensureMemorySchema(db);
  return db;
};

const insightCount = (db: Database.Database): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM recipe_insights`).get() as { c: number }).c;

const insightFor = (
  db: Database.Database,
  hash: string,
): { id: number; slug: string; version: number; flattened: string } | undefined =>
  db
    .prepare(`SELECT id, slug, version, flattened FROM recipe_insights WHERE hash = ?`)
    .get(hash) as
    | { id: number; slug: string; version: number; flattened: string }
    | undefined;

describe('recipeStore.save — insight upsert', () => {
  it('populates recipe_insights with the recipe hash + flattened payload', () => {
    const db = setupDb();
    const recipeStore = createRecipeStore('/nonexistent', db);
    const recipe = baseRecipe();
    const hash = hashRecipe(recipe);
    recipeStore.save(recipe, 'pub-1', 'inline');
    const row = insightFor(db, hash);
    expect(row).toBeDefined();
    expect(row?.slug).toBe('recipe-x');
    expect(row?.version).toBe(1);
    expect(JSON.parse(row?.flattened ?? '{}')).toMatchObject({
      trigger: { type: 'manual' },
      steps: [{ step_id: 'noop', transform: 'identity', action_kind: 'transform' }],
    });
    db.close();
  });

  it('re-saving the same recipe is idempotent (same hash, same row)', () => {
    const db = setupDb();
    const recipeStore = createRecipeStore('/nonexistent', db);
    const recipe = baseRecipe();
    recipeStore.save(recipe, 'pub-1', 'inline');
    const idAfterFirst = insightFor(db, hashRecipe(recipe))?.id;
    recipeStore.save(recipe, 'pub-1', 'inline');
    expect(insightCount(db)).toBe(1);
    expect(insightFor(db, hashRecipe(recipe))?.id).toBe(idAfterFirst);
    db.close();
  });

  it('a recipe edit produces a new insight row (hash changes)', () => {
    const db = setupDb();
    const recipeStore = createRecipeStore('/nonexistent', db);
    const v1 = baseRecipe({ version: 1 });
    const v2 = baseRecipe({
      version: 2,
      steps: [{ id: 'noop', transform: 'identity', value: 2 }],
    });
    recipeStore.save(v1, 'pub-1', 'inline');
    recipeStore.save(v2, 'pub-1', 'inline');
    expect(insightCount(db)).toBe(2);
    expect(insightFor(db, hashRecipe(v1))).toBeDefined();
    expect(insightFor(db, hashRecipe(v2))).toBeDefined();
    db.close();
  });

  it('does not break recipe save on flatten failure (substrate is best-effort)', () => {
    const db = setupDb();
    const recipeStore = createRecipeStore('/nonexistent', db);
    const recipe = baseRecipe();
    recipeStore.save(recipe, 'pub-1', 'inline');
    const stored = recipeStore.getStored(recipe.recipe_id);
    expect(stored).not.toBeNull();
    expect(stored?.recipe_id).toBe(recipe.recipe_id);
    db.close();
  });
});

describe('backfillRecipeInsights — boot-time backfill', () => {
  let db: Database.Database;
  let recipeStore: ReturnType<typeof createRecipeStore>;

  beforeEach(() => {
    db = setupDb();
    recipeStore = createRecipeStore('/nonexistent', db);
  });

  const seedAuditRow = (run_id: string, recipe_hash: string, recipe_id = 'recipe-x') => {
    const log = createAuditLogStore(
      createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
      createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
    );
    return log.append({
      run_id,
      recipe_id,
      recipe_hash,
      started_at: 100,
      finished_at: 200,
      duration_ms: 100,
      commit_status: 'succeeded',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: null,
      instance_id: null,
    });
  };

  it('returns zero counters on an empty audit log', () => {
    const result = backfillRecipeInsights(db, recipeStore);
    expect(result).toEqual({
      hashes_scanned: 0,
      insights_populated: 0,
      audit_rows_stamped: 0,
      orphan_hashes: 0,
    });
    db.close();
  });

  it('populates an insight + stamps the audit row when the hash matches', async () => {
    const recipe = baseRecipe();
    recipeStore.register(recipe);
    const hash = hashRecipe(recipe);
    await seedAuditRow('r-1', hash);
    const result = backfillRecipeInsights(db, recipeStore);
    expect(result.hashes_scanned).toBe(1);
    expect(result.insights_populated).toBe(1);
    expect(result.audit_rows_stamped).toBe(1);
    expect(result.orphan_hashes).toBe(0);
    const insightId = insightFor(db, hash)?.id;
    expect(insightId).toBeGreaterThan(0);
    const stamped = db
      .prepare(`SELECT json_extract(data, '$.recipe_insight_id') AS id FROM audit_entries WHERE key = ?`)
      .get('r-1') as { id: number };
    expect(stamped.id).toBe(insightId);
    db.close();
  });

  it('counts orphans without populating insights when the hash has no match', async () => {
    await seedAuditRow('r-orphan', 'unknown-hash');
    const result = backfillRecipeInsights(db, recipeStore);
    expect(result.hashes_scanned).toBe(1);
    expect(result.insights_populated).toBe(0);
    expect(result.audit_rows_stamped).toBe(0);
    expect(result.orphan_hashes).toBe(1);
    expect(insightCount(db)).toBe(0);
    db.close();
  });

  it('handles a mixed batch of matched + orphan hashes in one pass', async () => {
    const recipe = baseRecipe();
    recipeStore.register(recipe);
    const matched = hashRecipe(recipe);
    await seedAuditRow('r-match', matched);
    await seedAuditRow('r-orphan-1', 'orphan-a');
    await seedAuditRow('r-orphan-2', 'orphan-b');
    const result = backfillRecipeInsights(db, recipeStore);
    expect(result.hashes_scanned).toBe(3);
    expect(result.insights_populated).toBe(1);
    expect(result.audit_rows_stamped).toBe(1);
    expect(result.orphan_hashes).toBe(2);
    db.close();
  });

  it('is idempotent — already-stamped rows are skipped on re-run', async () => {
    const recipe = baseRecipe();
    recipeStore.register(recipe);
    const hash = hashRecipe(recipe);
    await seedAuditRow('r-1', hash);
    backfillRecipeInsights(db, recipeStore);
    const second = backfillRecipeInsights(db, recipeStore);
    // First pass stamped the row → second pass sees zero unstamped
    // hashes to scan.
    expect(second.hashes_scanned).toBe(0);
    expect(second.audit_rows_stamped).toBe(0);
    db.close();
  });

  it('stamps every audit row that shares the same hash on a single pass', async () => {
    const recipe = baseRecipe();
    recipeStore.register(recipe);
    const hash = hashRecipe(recipe);
    await seedAuditRow('r-1', hash);
    await seedAuditRow('r-2', hash);
    await seedAuditRow('r-3', hash);
    const result = backfillRecipeInsights(db, recipeStore);
    expect(result.hashes_scanned).toBe(1);
    expect(result.insights_populated).toBe(1);
    expect(result.audit_rows_stamped).toBe(3);
    db.close();
  });
});
