/** D-303 — an update that drops a variable retires it: the recipe store records the
 *  name, and the update dialog names the saved settings that stop applying.
 *
 *  D-222 refuses every config key a recipe does not declare, saved ones included, and
 *  nothing prunes saved settings. So a version that dropped a variable answered every
 *  run of an owner who had saved it with a refusal. The store now records what each
 *  write dropped (`retiredVariables`), the run drops those values (proved in
 *  `d-303-settings-an-update-drops-run.test.ts`), and the preview says so first.
 *
 *  Real stores throughout: the recipe store on SQLite, the dish and group stores the
 *  install config and automations save into, and the `packs.install_preview` handler. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type RecipeDefinition,
  type VariableDefault,
} from '@recued/contracts';

import { createDishGroupStore } from '../dish-group-store.js';
import { createDishStore } from '../dish-store.js';
import { installBulkPackOnServer } from '../install-bulk-pack-handler.js';
import { settingsNoLongerUsed } from '../pack-settings-preview.js';
import { makePackInstallHandlers } from '../pack-install-handler.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import { forgetUnusedRetirements } from '../retired-settings.js';
import { removeRecipeOwnedState } from '../recipe-owned-state.js';

const RECIPE_ID = 'd-303-importer';

const recipe = (version: number, variables: Record<string, VariableDefault>, name = 'Import things'): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version,
  ttl: 0,
  metadata: { name, description: 'Fixture for D-303.', author: 'recued-core', supported_platforms: [] },
  variables,
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['a', 'b'] } as never],
  output: { render: [] },
}) as RecipeDefinition;

const SEP: VariableDefault = { label: 'Thousands separator', type: 'text', default: ',' };
const CUR: VariableDefault = { label: 'Currency', type: 'text', default: 'GBP' };

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const open = (bundle: RecipeDefinition[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'd-303-'));
  for (const r of bundle) writeFileSync(join(dir, `${r.recipe_id}.json`), JSON.stringify(r));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, recipes: createRecipeStore(dir, db), dishes: createDishStore(db), groups: createDishGroupStore(db) };
};

describe('the recipe store records what each write dropped', () => {
  it('⛔ a version that drops a variable retires it; the same version again changes nothing', () => {
    const { recipes } = open();
    recipes.save(recipe(1, { currency: CUR, thousands_separator: SEP }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual([]);
    recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
    recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
  });

  it('it accumulates across versions, and a version that brings a name back takes it off the list', () => {
    const { recipes } = open();
    recipes.save(recipe(1, { currency: CUR, thousands_separator: SEP }), 'recued-core', 'pair-sync');
    recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync');
    recipes.save(recipe(3, {}), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['currency', 'thousands_separator']);
    recipes.save(recipe(4, { thousands_separator: SEP }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['currency']);
  });

  it('a fresh install drops nothing', () => {
    const { recipes } = open();
    recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual([]);
  });

  it('⛔ the owner\'s own edit records what it dropped too (compareAndSaveLocalRecipe)', () => {
    const { recipes } = open();
    const before = recipe(1, { currency: CUR, thousands_separator: SEP });
    recipes.save(before, 'local', 'inline');
    const result = recipes.compareAndSaveLocalRecipe!({
      recipe: recipe(2, { currency: CUR }),
      expected_recipe_json: recipes.getStored(RECIPE_ID)!.recipe_json,
    });
    expect(result.kind).toBe('updated');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
  });

  it('the store\'s own delete keeps the list (whether it goes is the uninstall\'s call, below)', () => {
    const { recipes } = open();
    recipes.save(recipe(1, { currency: CUR, thousands_separator: SEP }), 'recued-core', 'pair-sync');
    recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync');
    recipes.delete(RECIPE_ID);
    recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
    // …and one that declares it again brings the saved value back.
    recipes.delete(RECIPE_ID);
    recipes.save(recipe(1, { currency: CUR, thousands_separator: SEP }), 'recued-core', 'pair-sync');
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual([]);
  });

  it('a store without a database has nothing retired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd-303-nodb-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(createRecipeStore(dir).retiredVariables!(RECIPE_ID)).toEqual([]);
  });
});

describe('settingsNoLongerUsed — only what the owner SAVED, in the owner\'s words', () => {
  const before = recipe(1, { currency: CUR, thousands_separator: SEP, note: 'plain default' }, 'Import things');
  const after = recipe(2, { currency: CUR }, 'Import things');

  it('⛔ a saved setting the new version drops is named, with the label it was saved under', () => {
    const { dishes } = open();
    dishes.set({
      dish_id: 'dsh_install', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: '', is_default: true,
      config_overlay: { thousands_separator: '.', currency: 'EUR' }, enabled: true, created_at: 1,
    });
    expect(settingsNoLongerUsed([{ recipe_id: RECIPE_ID, before, after }], { dishes })).toEqual([
      { recipe_id: RECIPE_ID, recipe: 'Import things', setting: 'Thousands separator' },
    ]);
  });

  it('a setting saved only in a group one of the recipe\'s dishes shares counts; one never saved does not', () => {
    const { dishes, groups } = open();
    groups.set({ group_id: 'dgrp_shared', name: 'Shared', config_overlay: { note: 'x' }, created_at: 1 });
    dishes.set({
      dish_id: 'dsh_weekly', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: 'Weekly', is_default: false,
      config_overlay: {}, enabled: true, created_at: 1, group_id: 'dgrp_shared',
    });
    // `note` has no label: named by its key. `thousands_separator` was never saved.
    expect(settingsNoLongerUsed([{ recipe_id: RECIPE_ID, before, after }], { dishes, groups })).toEqual([
      { recipe_id: RECIPE_ID, recipe: 'Import things', setting: 'note' },
    ]);
  });

  it('nothing when the setting is still declared, or on a fresh install', () => {
    const { dishes } = open();
    dishes.set({
      dish_id: 'dsh_install', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: '', is_default: true,
      config_overlay: { currency: 'EUR', thousands_separator: '.' }, enabled: true, created_at: 1,
    });
    expect(settingsNoLongerUsed([{ recipe_id: RECIPE_ID, before, after: before }], { dishes })).toEqual([]);
    expect(settingsNoLongerUsed([{ recipe_id: RECIPE_ID, before: null, after }], { dishes })).toEqual([]);
  });
});

describe('packs.install_preview names them before anything is installed', () => {
  it('⛔ an update that drops a saved setting says so, and the preview writes nothing', async () => {
    const update = recipe(2, { currency: CUR }, 'Import things');
    const { recipes, dishes, groups } = open([update]);
    const perms = new Set([BULK_PACK_INSTALL_PERMISSION]);
    await installBulkPackOnServer({
      manifest_version: BULK_INSTALL_PACK_VERSION,
      pack_slug: 'things-pack',
      publisher: 'recued-core',
      requires: [BULK_PACK_INSTALL_PERMISSION],
      recipes: [{
        slug: RECIPE_ID,
        pinned_version: 1,
        recipe: {
          recipe_id: RECIPE_ID, publisher_id: 'recued-core', version: 1, recipe_hash: 'h1',
          recipe: recipe(1, { currency: CUR, thousands_separator: SEP }),
        },
      }],
      ready: true,
    } as never, perms, { recipeStore: recipes });
    dishes.set({
      dish_id: 'dsh_install', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: '', is_default: true,
      config_overlay: { thousands_separator: '.' }, enabled: true, created_at: 1,
    });
    const handlers = makePackInstallHandlers({ recipeStore: recipes, getSavedSettings: () => ({ dishes, groups }) })!
      .handlers;
    const result = await handlers['packs.install_preview']!({
      manifest: {
        manifest_version: 1,
        slug: 'things-pack',
        publisher: 'recued-core',
        name: 'Things',
        description: 'x',
        version: 2,
        recipes: [{ slug: RECIPE_ID, version: 2 }],
        requires: [BULK_PACK_INSTALL_PERMISSION],
        tags: [],
      },
    } as never, undefined as never) as { settings_no_longer_used?: unknown };
    expect(result.settings_no_longer_used).toEqual([
      { recipe_id: RECIPE_ID, recipe: 'Import things', setting: 'Thousands separator' },
    ]);
    expect(recipes.get(RECIPE_ID)?.version).toBe(1);
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual([]);
  });

  it('without the saved-settings reader, the preview says nothing about settings', async () => {
    const update = recipe(2, { currency: CUR });
    const { recipes } = open([update]);
    const handlers = makePackInstallHandlers({ recipeStore: recipes })!.handlers;
    const result = await handlers['packs.install_preview']!({
      manifest: {
        manifest_version: 1, slug: 'things-pack', publisher: 'recued-core', name: 'Things', description: 'x',
        version: 2, recipes: [{ slug: RECIPE_ID, version: 2 }], requires: [BULK_PACK_INSTALL_PERMISSION], tags: [],
      },
    } as never, undefined as never) as Record<string, unknown>;
    expect(result).not.toHaveProperty('settings_no_longer_used');
  });
});

describe('the composition hands the preview the stores the owner saves into', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8');

  it('the rpc context builds the reader from the executor\'s own dish and group stores', () => {
    const source = read('serve/compose-rpc-context.ts');
    // The SAME stores the run merges from: a preview reading other stores would name
    // settings the run never sees, or miss ones it does.
    expect(source).toMatch(/const getSavedSettings = \(\) => \(execution\.executeDeps\.dishStore/);
    expect(source).toMatch(/groups: execution\.executeDeps\.dishGroupStore/);
    expect(source).toMatch(/composePackInstallRpcDeps\(\{[^}]*getSavedSettings,/s);
  });

  it('the pack-install composer passes it to the handlers', () => {
    expect(read('composition/bin/wire-pack-install-rpc-deps.ts'))
      .toMatch(/\.\.\.\(getSavedSettings \? \{ getSavedSettings \} : \{\}\)/);
  });
});

describe('the retired list lives exactly as long as something it describes', () => {
  /** A pack whose update dropped `thousands_separator`: v1 then v2, saved the way a
   *  pack install saves them. The recipe is NOT in the bundle directory, so an
   *  uninstall really removes it. `cascade` registers D-304's deletion hook, as the
   *  listener stage does in production. */
  const updated = (cascade = true) => {
    const opened = open();
    const packDir = mkdtempSync(join(tmpdir(), 'd-303-packs-'));
    cleanups.push(() => rmSync(packDir, { recursive: true, force: true }));
    writeFileSync(join(packDir, 'things-pack.json'), JSON.stringify({
      manifest_version: BULK_INSTALL_PACK_VERSION, slug: 'things-pack', publisher: 'recued-core', name: 'Things',
      description: 'x', version: 2, recipes: [{ slug: RECIPE_ID, version: 2 }],
      requires: [BULK_PACK_INSTALL_PERMISSION], tags: [],
    }));
    if (cascade) {
      opened.recipes.addOnDeleted!((id) => removeRecipeOwnedState(id, { recipes: opened.recipes, dishes: opened.dishes }));
    }
    opened.recipes.save(recipe(1, { currency: CUR, thousands_separator: SEP }), 'recued-core', 'pair-sync', 1, 'things-pack');
    opened.recipes.save(recipe(2, { currency: CUR }), 'recued-core', 'pair-sync', 2, 'things-pack');
    expect(opened.recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
    const uninstall = () => handlePacksUninstall({ recipeStore: opened.recipes, packDir }, { pack_slug: 'things-pack' });
    return { ...opened, uninstall };
  };
  const saveInstallConfig = (dishes: ReturnType<typeof open>['dishes']) => dishes.set({
    dish_id: 'dsh_install', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: '', is_default: true,
    config_overlay: { thousands_separator: '.' }, enabled: true, created_at: 1,
  });

  it('⛔ deleting the pack takes the list with the recipe, and with the settings saved for it (D-304)', async () => {
    const { recipes, dishes, uninstall } = updated();
    saveInstallConfig(dishes);
    const { result } = await uninstall();
    expect(result.ok).toBe(true);
    expect(recipes.get(RECIPE_ID)).toBeNull();
    expect(dishes.listByRecipe(RECIPE_ID)).toEqual([]);
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual([]);
    expect(recipes.retiredRecipeIds!()).toEqual([]);
  });

  it('the boot sweep forgets a list left from before D-304 once its last setting is deleted', async () => {
    // An uninstall with no deletion hook: the settings and the list stayed behind.
    const { recipes, dishes, uninstall } = updated(false);
    saveInstallConfig(dishes);
    await uninstall();
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
    expect(forgetUnusedRetirements({ recipeStore: recipes, dishes })).toEqual([]);
    dishes.delete('dsh_install');
    expect(forgetUnusedRetirements({ recipeStore: recipes, dishes })).toEqual([RECIPE_ID]);
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual([]);
  });

  it('the sweep keeps a list whose recipe is still installed, even with nothing saved', () => {
    const { recipes, dishes } = updated();
    expect(forgetUnusedRetirements({ recipeStore: recipes, dishes })).toEqual([]);
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
  });

  it('a recipe that still runs from the bundle after its stored row is gone keeps its list', () => {
    const bundled = recipe(2, { currency: CUR });
    const { recipes, dishes } = open([bundled]);
    recipes.save(recipe(1, { currency: CUR, thousands_separator: SEP }), 'recued-core', 'pair-sync');
    recipes.save(bundled, 'recued-core', 'pair-sync');
    recipes.delete(RECIPE_ID);
    expect(recipes.get(RECIPE_ID)).not.toBeNull();
    expect(forgetUnusedRetirements({ recipeStore: recipes, dishes })).toEqual([]);
    expect(recipes.retiredVariables!(RECIPE_ID)).toEqual(['thousands_separator']);
  });

  it('the rpc context sweeps at boot', () => {
    const context = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'serve/compose-rpc-context.ts'), 'utf-8');
    expect(context).toMatch(/forgetUnusedRetirements\(\{ recipeStore: storage\.recipeStore, dishes: execution\.executeDeps\.dishStore \}\)/);
  });
});
