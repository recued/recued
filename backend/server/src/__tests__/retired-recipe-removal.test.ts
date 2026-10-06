/** D-193 amendment (2026-10-05) — the boot removal of `recued-core/schedule-recipe`.
 *
 *  Owner: "yes remove the dead schedule-recipe at boot". The recipe left the
 *  organizer pack when no step could schedule another recipe; a pack update
 *  never drops what its new manifest no longer ships, so older installs keep a
 *  row that is refused at every run while chat still finds it.
 *
 *  Driven over a real recipe store with the hooks the server registers on it:
 *  the D-304 owned-state cleanup (`removeRecipeOwnedState` on `addOnDeleted`)
 *  and the D-247 grant seed/purge (`installRecipeGrantSeed`). So "removed"
 *  means what an uninstall means: its schedules, dishes and grant go with it.
 *  The composition's call is pinned in `serve-compose-listeners.test.ts`. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_CONTRACT_ID, recipeGrantEntry, type RecipeDefinition } from '@recued/contracts';

import { createDishStore, type DishStore } from '../dish-store.js';
import { removeRecipeOwnedState } from '../recipe-owned-state.js';
import { installRecipeGrantSeed } from '../recipe-grant-seed.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { RETIRED_SHIPPED_RECIPES, removeRetiredShippedRecipes } from '../retired-recipe-removal.js';
import { createScheduleStore, type ScheduleStore } from '../schedule-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_790_000_000_000;

const recipe = (recipe_id: string, extra: Record<string, unknown> = {}): RecipeDefinition => ({
  recipe_id,
  version: 1,
  metadata: { name: recipe_id, description: 'fixture', author: 'recued-core', tags: [] },
  steps: [],
  chat_exposed: true,
  ...extra,
}) as unknown as RecipeDefinition;

/** The shipped body, as older installs hold it: one step on the retired op. */
const SHIPPED_SCHEDULE_RECIPE = recipe('schedule-recipe', {
  steps: [{ id: 'schedule', op: 'core.schedule.recipe', args: { recipe_id: '{{config.recipe_id}}' } }],
});

let dir: string;
let db: Database.Database;
let recipes: RecipeStore;
let dishes: DishStore;
let schedules: ScheduleStore;
let grants: ReturnType<typeof createContractGrantEntryStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retired-recipe-removal-'));
  db = new Database(':memory:');
  recipes = createRecipeStore(dir, db);
  dishes = createDishStore(db);
  schedules = createScheduleStore(db);
  grants = createContractGrantEntryStore(createContractStore(db, { now: () => NOW }));
  // The hooks the server registers on the store (compose-app-context,
  // compose-listeners), so a delete does what an uninstall does.
  installRecipeGrantSeed({ store: recipes, grants, now: () => NOW });
  recipes.addOnDeleted?.((recipe_id) => {
    removeRecipeOwnedState(recipe_id, { recipes, dishes, schedules });
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An older install: the pack's recipe, a dish of it and a schedule it owned. */
const installOldOrganizer = (): void => {
  recipes.save(SHIPPED_SCHEDULE_RECIPE, 'recued-core', 'bundled', NOW, 'personal-organizer-foundation');
  recipes.save(recipe('today'), 'recued-core', 'bundled', NOW, 'personal-organizer-foundation');
  dishes.set({
    dish_id: 'dsh_sched', recipe_id: 'schedule-recipe', publisher_id: 'recued-core', name: '',
    is_default: true, config_overlay: {}, enabled: true, created_at: NOW, updated_at: NOW,
  } as never);
  schedules.set({
    schedule_id: 'sch_old', recipe_id: 'schedule-recipe', publisher_id: 'recued-core', cron_expression: '0 9 * * *',
    enabled: true, created_at: NOW, last_run_at: null, next_run_at: NOW + 1, last_status: null, last_error: null,
    instance_id: 'i-1', dish_id: 'dsh_sched',
  } as never);
};

describe('the retired schedule-recipe goes at boot, with everything it owned', () => {
  it('lists the recipe the D-193 amendment retired', () => {
    expect(RETIRED_SHIPPED_RECIPES).toEqual([{ recipe_id: 'schedule-recipe', publisher_id: 'recued-core' }]);
  });

  it('removes the shipped row, its dish, its schedule and its grant, and leaves the rest of the pack', () => {
    installOldOrganizer();
    const grantKey = recipeGrantEntry('recued-core', 'schedule-recipe');
    // The cause, proven first: all of it is there before.
    expect(recipes.getStored('schedule-recipe')).not.toBeNull();
    expect(grants.get(OWNER_CONTRACT_ID, grantKey)).toBeDefined();
    expect(dishes.listByRecipe('schedule-recipe')).toHaveLength(1);
    expect(schedules.listByRecipe('schedule-recipe')).toHaveLength(1);

    expect(removeRetiredShippedRecipes(recipes)).toEqual({ removed: ['recued-core/schedule-recipe'] });

    expect(recipes.getStored('schedule-recipe')).toBeNull();
    expect(recipes.get('schedule-recipe')).toBeNull();
    expect(grants.get(OWNER_CONTRACT_ID, grantKey)).toBeUndefined();
    expect(dishes.listByRecipe('schedule-recipe')).toEqual([]);
    expect(schedules.listByRecipe('schedule-recipe')).toEqual([]);
    // The rest of the pack stays installed.
    expect(recipes.getStored('today')).toMatchObject({ pack_slug: 'personal-organizer-foundation' });
  });

  it('is a no-op on the next boot, and on a server that never had it', () => {
    installOldOrganizer();
    removeRetiredShippedRecipes(recipes);
    expect(removeRetiredShippedRecipes(recipes)).toEqual({ removed: [] });
    expect(recipes.getStored('today')).not.toBeNull();
  });

  it('leaves a recipe the owner saved under the same id: only the shipped copy goes', () => {
    recipes.save(recipe('schedule-recipe'), 'local', 'inline', NOW);
    expect(removeRetiredShippedRecipes(recipes)).toEqual({ removed: [] });
    expect(recipes.getStored('schedule-recipe')).toMatchObject({ publisher_id: 'local' });
  });

  it('does nothing with a store that cannot say what is installed', () => {
    expect(removeRetiredShippedRecipes({} as never)).toEqual({ removed: [] });
  });
});
