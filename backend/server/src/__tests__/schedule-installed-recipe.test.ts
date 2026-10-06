/** D-193 amendment (2026-10-05) — the scheduler behind chat's `recipe.schedule`.
 *
 *  The first three moved here from the round-5 composition test, where they
 *  pinned the retired `schedule-recipe` kernel step. Found live 2026-09-25: that
 *  step armed a cron for the month-end reminder on a server without Ledger book,
 *  which the webclient's `schedules.create` refuses. The chat tool composes the
 *  same handler, so it must make the same refusal.
 *
 *  The rest pin what this path adds over the webclient's route: the recipe must
 *  exist (a model can name one that is not installed), and the publisher, timing,
 *  dish and switch reach the row as given. Real handler, real stores; only the
 *  installed-pack inventory is fed. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createScheduleStore, type ScheduleStore } from '../schedule-store.js';
import { createInstalledRecipeScheduler } from '../schedule-installed-recipe.js';

const recipe = (recipe_id: string, extra: Record<string, unknown> = {}): RecipeDefinition => ({
  recipe_id,
  version: 1,
  metadata: { name: recipe_id, description: 'fixture', author: 'recued-core', tags: [] },
  steps: [],
  ...extra,
}) as unknown as RecipeDefinition;

/** Needs a pack this server does not have. */
const NUDGE = recipe('month-end-closer-nudge', { depends_on: ['recued-core.ledger-book'] });
/** Needs no pack. */
const TODAY = recipe('today');

let dir: string;
let db: Database.Database;
let recipes: RecipeStore;
let store: ScheduleStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schedule-installed-recipe-'));
  db = new Database(':memory:');
  // An explicit (empty) community dir: only the recipes saved below exist.
  recipes = createRecipeStore(dir, db);
  recipes.save(NUDGE, 'recued-core', 'bundled');
  recipes.save(TODAY, 'recued-core', 'bundled');
  store = createScheduleStore(new Database(':memory:'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** No pack installed; the manifest registry is empty. */
const NO_PACKS = { scanInstalledPacks: () => [], getManifest: () => null };

describe("chat's scheduler refuses what the Run dialog's route refuses", () => {
  it('⛔ refuses a recipe whose pack is not installed, and arms nothing', () => {
    const schedule = createInstalledRecipeScheduler({
      scheduleDeps: { store, instanceId: 'i-1' } as never,
      recipeStore: recipes,
      packs: NO_PACKS,
    });
    expect(() => schedule({
      recipe_id: NUDGE.recipe_id, publisher_id: 'recued-core', mode: 'recurring', cron_expression: '0 9 1 * *',
    })).toThrow(expect.objectContaining({
      code: 'pack_not_installed',
      details: { missing_packs: ['recued-core.ledger-book'] },
    }));
    expect(store.list()).toEqual([]);
  });

  it('schedules a recipe that declares no pack', () => {
    const schedule = createInstalledRecipeScheduler({
      scheduleDeps: { store, instanceId: 'i-1' } as never,
      recipeStore: recipes,
      packs: NO_PACKS,
    });
    schedule({ recipe_id: TODAY.recipe_id, publisher_id: 'recued-core', mode: 'recurring', cron_expression: '0 9 * * *' });
    expect(store.list().map((row) => row.recipe_id)).toEqual(['today']);
  });

  it('with no pack inventory it refuses nothing, as that route does', () => {
    const schedule = createInstalledRecipeScheduler({
      scheduleDeps: { store, instanceId: 'i-1' } as never,
      recipeStore: recipes,
    });
    schedule({ recipe_id: NUDGE.recipe_id, publisher_id: 'recued-core', mode: 'recurring', cron_expression: '0 9 1 * *' });
    expect(store.list()).toHaveLength(1);
  });
});

describe('what the chat path adds', () => {
  const scheduler = () => createInstalledRecipeScheduler({
    scheduleDeps: { store, instanceId: 'i-1' } as never,
    recipeStore: recipes,
    packs: NO_PACKS,
  });

  it('⛔ refuses a recipe that is not installed, and arms nothing', () => {
    // The webclient's route leaves this check dormant (its picker lists only
    // installed recipes); a model can name anything.
    expect(() => scheduler()({
      recipe_id: 'a-recipe-this-server-has-never-heard-of', publisher_id: 'acme', mode: 'recurring', cron_expression: '0 9 * * *',
    })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(store.list()).toEqual([]);
  });

  it('writes the publisher, mode, timing and switch it was given', () => {
    const runAt = Date.parse('2030-07-04T15:00:00-07:00');
    const { schedule } = scheduler()({
      recipe_id: TODAY.recipe_id, publisher_id: 'recued-core', mode: 'one_shot', run_at: runAt, enabled: false,
    });
    expect(schedule).toMatchObject({
      recipe_id: 'today', publisher_id: 'recued-core', mode: 'one_shot', run_at: runAt, next_run_at: runAt, enabled: false,
    });
    expect(store.list()).toEqual([expect.objectContaining({ schedule_id: schedule.schedule_id, publisher_id: 'recued-core' })]);
  });

  it('refuses a recurring cron below the floor', () => {
    expect(() => scheduler()({
      recipe_id: TODAY.recipe_id, publisher_id: 'recued-core', mode: 'recurring', cron_expression: '* * * * *',
    })).toThrow(expect.objectContaining({ code: 'invalid_cron' }));
    expect(store.list()).toEqual([]);
  });
});
