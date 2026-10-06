/** D-304 — a recipe's own state goes with it when it is uninstalled.
 *
 *  The owner's model: pack → its recipes → each recipe's own settings. Before this,
 *  deleting a pack deleted its recipes and left everything that belonged to them: the
 *  install config, named setups, schedules (which then failed "recipe not found" at
 *  every firing), owner-made triggers, the auto-run row, and D-303's retired list.
 *  Connections, and a settings group other recipes share, are not the recipe's, and
 *  stay.
 *
 *  Real stores on one SQLite database throughout: the recipe store with its deletion
 *  hook registered as the listener stage registers it, dishes, dish continuity,
 *  groups, schedules, auto-run and event triggers. The uninstall runs through
 *  `handlePacksUninstall` and `recipe.delete`. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  SERVER_RPC_METHOD_SET,
  type Dish,
  type RecipeDefinition,
} from '@recued/contracts';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';

import { createAutoRunSettingsStore, createCircuitBreakerStore } from '../auto-run-scheduler.js';
import { createDishContextStore } from '../dish-context-store.js';
import { createDishGroupStore } from '../dish-group-store.js';
import { createDishStore } from '../dish-store.js';
import { handlePacksUninstall, makePackUninstallHandlers, previewPackUninstall } from '../pack-uninstall-handler.js';
import { deleteRecipe } from '../recipe-delete-handler.js';
import { recipeOwnedStateOf, removeRecipeOwnedState, type RecipeOwnedStateDeps } from '../recipe-owned-state.js';
import { createRecipeStore } from '../recipe-store.js';
import { createScheduleStore } from '../schedule-store.js';
import { createEventTriggersStore } from '../triggers/store.js';
import { ensureTimeRelativeWatcherSchema, forgetTimeRelativeWatcherRecipe } from '../watchers/time-relative-watcher.js';
import { ensureHttpWatcherMemorySchema, forgetHttpWatcherRecipe } from '../watchers/http-watcher-memory.js';

const recipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 0,
  metadata: { name: recipe_id, description: 'Fixture for D-304.', author: 'recued-core', supported_platforms: [] },
  variables: { folder: 'Inbox' },
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['a', 'b'] } as never],
  output: { render: [] },
}) as RecipeDefinition;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A server with every store a recipe's own state lives in, and the deletion hook
 *  registered as `compose-listeners.ts` registers it. */
const server = (hook = true, bundled: readonly RecipeDefinition[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'd-304-'));
  // The server's bundle: recipes it ships, which a pack install can shadow.
  for (const r of bundled) writeFileSync(join(dir, `${r.recipe_id}.json`), JSON.stringify(r));
  const packDir = mkdtempSync(join(tmpdir(), 'd-304-packs-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); rmSync(packDir, { recursive: true, force: true }); });
  const recipes = createRecipeStore(dir, db);
  const dishes = createDishStore(db);
  const dishContext = createDishContextStore(db);
  const groups = createDishGroupStore(db);
  const schedules = createScheduleStore(db);
  const autoRun = createAutoRunSettingsStore(db);
  const triggers = createEventTriggersStore(db);
  const circuit = createCircuitBreakerStore(db);
  ensureTimeRelativeWatcherSchema(db);
  ensureHttpWatcherMemorySchema(db);
  const owned: RecipeOwnedStateDeps = {
    recipes, dishes, dishContext, schedules, autoRun, triggers, autoRunCircuit: circuit,
    // As `compose-listeners.ts` builds it.
    watcherState: {
      clear: (id) => {
        forgetTimeRelativeWatcherRecipe(db, id);
        forgetHttpWatcherRecipe(db, id);
      },
    },
  };
  if (hook) recipes.addOnDeleted!((id) => removeRecipeOwnedState(id, owned));
  return { db, recipes, dishes, dishContext, groups, schedules, autoRun, triggers, circuit, owned, packDir };
};
type Server = ReturnType<typeof server>;

const dish = (dish_id: string, recipe_id: string, over: Partial<Dish> = {}): Dish => ({
  dish_id, recipe_id, publisher_id: 'recued-core', name: over.is_default ? '' : dish_id, is_default: false,
  config_overlay: { folder: 'Receipts' }, enabled: true, created_at: 1, ...over,
});

/** Everything an owner can set up on a recipe: install config, a named setup in a
 *  shared group, a schedule on its own managed dish, an owner-made trigger, the
 *  declared trigger's row, auto-run switched off with a config dish, continuity. */
const setUp = (s: Server, recipe_id: string) => {
  s.dishes.set(dish(`dsh_install_${recipe_id}`, recipe_id, { is_default: true }));
  s.dishes.set(dish(`dsh_weekly_${recipe_id}`, recipe_id, { group_id: 'dgrp_team' }));
  s.dishes.set(dish(`dsh_sched_${recipe_id}`, recipe_id));
  s.dishes.set(dish(`dsh_auto_${recipe_id}`, recipe_id));
  s.dishContext.set(`dsh_weekly_${recipe_id}`, { last: 1 } as never);
  s.schedules.set({
    schedule_id: `sch_${recipe_id}`, recipe_id, publisher_id: 'recued-core', cron_expression: '0 9 * * *',
    enabled: true, created_at: 1, last_run_at: null, next_run_at: null, dish_id: `dsh_sched_${recipe_id}`,
  } as never);
  s.triggers.create({
    trigger_id: `trg_user_${recipe_id}`, recipe_id, publisher_id: 'recued-core', pattern: 'mail.message.created',
    enabled: true, created_at: 1, origin: 'user',
  });
  s.triggers.create({
    trigger_id: `trg_decl_${recipe_id}`, recipe_id, publisher_id: 'recued-core', pattern: 'mail.message.created',
    enabled: false, created_at: 1, origin: 'recipe',
  });
  // D-319 — a dish's auto-run timer, switched off.
  s.autoRun.setEnabled(`dsh_auto_${recipe_id}`, recipe_id, false);
  // Its timer tripped after failing: run health, not an owner's setting.
  s.circuit.set({ dish_id: `dsh_auto_${recipe_id}`, recipe_id, consecutive_failures: 3, auto_disabled: true,
    last_failure_at: 1, last_failure_reason: 'boom' });
  // Its watchers' state: a time-relative firing and start point, the page a
  // page watcher remembers. (The calendar watcher's cursor went with it,
  // 2026-10-05.)
  s.db.prepare('INSERT INTO time_relative_watcher_state (recipe_id, slug, record_id, offset_label, fired_at) VALUES (?, ?, ?, ?, ?)')
    .run(recipe_id, 'w', 'cal:1', '-30m', 1);
  s.db.prepare('INSERT INTO time_relative_watcher_armed (recipe_id, slug, armed_at) VALUES (?, ?, ?)').run(recipe_id, 'w', 1);
  s.db.prepare('INSERT INTO http_watcher_memory (recipe_id, target_url, hash, body) VALUES (?, ?, ?, ?)')
    .run(recipe_id, 'https://example.com/pricing', 'h1', '<p>Plan A $10</p>');
};

const watcherRows = (s: Server, recipe_id: string): number =>
  (s.db.prepare('SELECT COUNT(*) AS n FROM time_relative_watcher_state WHERE recipe_id = ?').get(recipe_id) as { n: number }).n
  + (s.db.prepare('SELECT COUNT(*) AS n FROM time_relative_watcher_armed WHERE recipe_id = ?').get(recipe_id) as { n: number }).n
  + (s.db.prepare('SELECT COUNT(*) AS n FROM http_watcher_memory WHERE recipe_id = ?').get(recipe_id) as { n: number }).n;

const stateOf = (s: Server, recipe_id: string) => ({
  dishes: s.dishes.listByRecipe(recipe_id).map((d) => d.dish_id).sort(),
  schedules: s.schedules.listByRecipe(recipe_id).map((x) => x.schedule_id),
  triggers: s.triggers.list().filter((t) => t.recipe_id === recipe_id).map((t) => t.trigger_id).sort(),
  timers: s.autoRun.list().filter((t) => t.recipe_id === recipe_id).map((t) => t.dish_id),
  continuity: s.dishContext.get(`dsh_weekly_${recipe_id}`),
  tripped: s.circuit.list().some((c) => c.recipe_id === recipe_id),
  watchers: watcherRows(s, recipe_id),
});

describe('removeRecipeOwnedState — what belongs to the recipe, and nothing else', () => {
  it('⛔ removes its settings, schedules, owner-made triggers, auto-run and continuity', () => {
    const s = server(false);
    s.groups.set({ group_id: 'dgrp_team', name: 'Team', config_overlay: { folder: 'Shared' }, created_at: 1 });
    setUp(s, 'mail-digest');
    setUp(s, 'other-recipe');
    expect(recipeOwnedStateOf('mail-digest', s.owned)).toEqual({ schedules: 1, automations: 2, settings: 4 });
    expect(removeRecipeOwnedState('mail-digest', s.owned)).toEqual({ schedules: 1, automations: 2, settings: 4 });
    expect(stateOf(s, 'mail-digest')).toEqual({
      dishes: [], schedules: [],
      // The declared trigger is the reconciler's: it removes it on the same deletion.
      triggers: ['trg_decl_mail-digest'],
      timers: [], continuity: null,
      // ⛔ Found driving a live server: left behind, the trip made the reinstalled
      // recipe start out tripped, before it had ever run.
      tripped: false,
      // Left behind, a reinstall resumed from them: a time-relative watch fired
      // every boundary since the FIRST install (2026-10-05).
      watchers: 0,
    });
    // Another recipe keeps everything, and the shared group stays for it.
    expect(stateOf(s, 'other-recipe').dishes).toHaveLength(4);
    expect(stateOf(s, 'other-recipe').tripped).toBe(true);
    expect(stateOf(s, 'other-recipe').watchers).toBe(3);
    expect(stateOf(s, 'other-recipe').schedules).toEqual(['sch_other-recipe']);
    expect(s.groups.get('dgrp_team')).not.toBeNull();
  });

  it('each dish’s timer counts — one exists only once its dish was switched on — and a failure trip never does', () => {
    const s = server(false);
    s.circuit.set({ dish_id: 'dsh_plain', recipe_id: 'plain', consecutive_failures: 1, auto_disabled: true });
    expect(recipeOwnedStateOf('plain', s.owned)).toEqual({ schedules: 0, automations: 0, settings: 0 });
    s.autoRun.setEnabled('dsh_plain', 'plain', true);
    s.autoRun.setEnabled('dsh_plain_2', 'plain', false);
    expect(recipeOwnedStateOf('plain', s.owned).automations).toBe(2);
  });

  it('a server without a store has nothing of that kind to remove', () => {
    expect(removeRecipeOwnedState('x', {})).toEqual({ schedules: 0, automations: 0, settings: 0 });
  });
});

describe('the recipe store\'s deletion hook', () => {
  it('fires once per removed row, before the mutation hooks — and not for a delete that removed nothing', () => {
    const s = server(false);
    const calls: string[] = [];
    s.recipes.addOnDeleted!((id) => calls.push(`deleted:${id}`));
    s.recipes.addOnMutated((id) => calls.push(`mutated:${id}`));
    s.recipes.save(recipe('r1'), 'recued-core', 'pair-sync');
    calls.length = 0;
    expect(s.recipes.delete('r1')).toBe(true);
    expect(s.recipes.delete('r1')).toBe(false);
    expect(calls).toEqual(['deleted:r1', 'mutated:r1']);
  });

  it('a subscriber that throws does not fail the delete', () => {
    const s = server(false);
    s.recipes.addOnDeleted!(() => { throw new Error('boom'); });
    s.recipes.save(recipe('r1'), 'recued-core', 'pair-sync');
    expect(s.recipes.delete('r1')).toBe(true);
    expect(s.recipes.get('r1')).toBeNull();
  });
});

describe('deleting a pack removes what belongs to its recipes', () => {
  const installPack = (s: Server) => {
    writeFileSync(join(s.packDir, 'mail-pack.json'), JSON.stringify({
      manifest_version: BULK_INSTALL_PACK_VERSION, slug: 'mail-pack', publisher: 'recued-core', name: 'Mail',
      description: 'x', version: 1, recipes: [{ slug: 'mail-digest', version: 1 }, { slug: 'mail-quiet', version: 1 }],
      requires: [BULK_PACK_INSTALL_PERMISSION], tags: [],
    }));
    s.recipes.save(recipe('mail-digest'), 'recued-core', 'pair-sync', 1, 'mail-pack');
    s.recipes.save(recipe('mail-quiet'), 'recued-core', 'pair-sync', 1, 'mail-pack');
    s.recipes.save(recipe('other-recipe'), 'recued-core', 'pair-sync', 1, 'other-pack');
  };

  it('⛔ the preview says what goes, then the uninstall removes exactly that — and nothing of another pack', async () => {
    const s = server();
    s.groups.set({ group_id: 'dgrp_team', name: 'Team', config_overlay: {}, created_at: 1 });
    installPack(s);
    setUp(s, 'mail-digest');
    setUp(s, 'other-recipe');
    const deps = { recipeStore: s.recipes, packDir: s.packDir, getRecipeOwnedState: () => s.owned };
    // `mail-quiet` has nothing saved: it adds no recipe with settings.
    expect(await previewPackUninstall(deps, { pack_slug: 'mail-pack' }))
      .toEqual({ schedules: 1, automations: 2, recipes_with_settings: 1 });
    const { result } = await handlePacksUninstall(deps, { pack_slug: 'mail-pack' });
    expect(result.ok).toBe(true);
    expect([...result.removed.recipes].sort()).toEqual(['mail-digest', 'mail-quiet']);
    expect(stateOf(s, 'mail-digest')).toMatchObject({ dishes: [], schedules: [], timers: [], tripped: false });
    expect(stateOf(s, 'other-recipe')).toMatchObject({ tripped: true });
    expect(stateOf(s, 'other-recipe').dishes).toHaveLength(4);
    expect(stateOf(s, 'other-recipe').schedules).toEqual(['sch_other-recipe']);
    // Nothing left to count.
    expect(await previewPackUninstall(deps, { pack_slug: 'mail-pack' }))
      .toEqual({ schedules: 0, automations: 0, recipes_with_settings: 0 });
  });

  it('⛔ a recipe the server bundles keeps its settings: uninstalling the pack leaves it installed', async () => {
    // Integrity audit, 2026-09-24: uninstalling personal-organizer-foundation took
    // the owner's settings, schedules and triggers for recipes that stayed listed
    // and runnable from the bundle.
    const s = server(true, [recipe('today')]);
    writeFileSync(join(s.packDir, 'organizer-pack.json'), JSON.stringify({
      manifest_version: BULK_INSTALL_PACK_VERSION, slug: 'organizer-pack', publisher: 'recued-core', name: 'Organizer',
      description: 'x', version: 1, recipes: [{ slug: 'today', version: 1 }, { slug: 'mail-digest', version: 1 }],
      requires: [BULK_PACK_INSTALL_PERMISSION], tags: [],
    }));
    s.recipes.save(recipe('today'), 'recued-core', 'pair-sync', 1, 'organizer-pack');
    s.recipes.save(recipe('mail-digest'), 'recued-core', 'pair-sync', 1, 'organizer-pack');
    setUp(s, 'today');
    setUp(s, 'mail-digest');
    const before = stateOf(s, 'today');
    const deps = { recipeStore: s.recipes, packDir: s.packDir, getRecipeOwnedState: () => s.owned };
    // The confirmation counts only what goes: mail-digest's, not today's.
    expect(await previewPackUninstall(deps, { pack_slug: 'organizer-pack' }))
      .toEqual({ schedules: 1, automations: 2, recipes_with_settings: 1 });
    const { result } = await handlePacksUninstall(deps, { pack_slug: 'organizer-pack' });
    expect(result.ok).toBe(true);
    // Still installed, from the bundle, with everything the owner set up on it.
    expect(s.recipes.get('today')).not.toBeNull();
    expect(stateOf(s, 'today')).toEqual(before);
    expect(stateOf(s, 'today').dishes).toHaveLength(4);
    // The one that is really gone takes its own state with it.
    expect(s.recipes.get('mail-digest')).toBeNull();
    expect(stateOf(s, 'mail-digest')).toMatchObject({ dishes: [], schedules: [], tripped: false });
  });

  it('`recipe.delete` removes a recipe\'s own state through the same hook', async () => {
    const s = server();
    s.recipes.save(recipe('mine'), 'local', 'inline');
    setUp(s, 'mine');
    expect(await deleteRecipe({ store: s.recipes }, 'mine')).toEqual({ deleted: true });
    expect(stateOf(s, 'mine')).toMatchObject({ dishes: [], schedules: [], timers: [] });
  });

  it('a Records pack\'s recipes, keyed by its catalog id, are counted too', async () => {
    const s = server();
    const owner = { publisher: 'recued-core', pack_slug: 'statement-import' };
    s.recipes.save(recipe('import-bank-statement'), 'recued-core', 'pair-sync', 1, await recordsCatalogSlug(owner));
    setUp(s, 'import-bank-statement');
    const recordsStore = { listNamespaces: () => [{ owner }] } as never;
    expect(await previewPackUninstall(
      { recipeStore: s.recipes, recordsStore, getRecipeOwnedState: () => s.owned }, { pack_slug: 'statement-import' },
    )).toEqual({ schedules: 1, automations: 2, recipes_with_settings: 1 });
  });

  it('a server that cannot count says nothing, and a missing slug is refused', async () => {
    const s = server();
    installPack(s);
    setUp(s, 'mail-digest');
    expect(await previewPackUninstall({ recipeStore: s.recipes }, { pack_slug: 'mail-pack' }))
      .toEqual({ schedules: 0, automations: 0, recipes_with_settings: 0 });
    await expect(previewPackUninstall({ recipeStore: s.recipes }, { pack_slug: ' ' })).rejects.toThrow(/non-empty/);
  });

  it('the rpc is served and in the runtime method set', async () => {
    const s = server();
    installPack(s);
    setUp(s, 'mail-digest');
    const handlers = makePackUninstallHandlers({ recipeStore: s.recipes, getRecipeOwnedState: () => s.owned })!;
    expect(handlers.methods).toContain('packs.uninstall_preview');
    expect(SERVER_RPC_METHOD_SET.has('packs.uninstall_preview')).toBe(true);
    expect(await handlers.handlers['packs.uninstall_preview']!({ pack_slug: 'mail-pack' }, undefined as never))
      .toEqual({ schedules: 1, automations: 2, recipes_with_settings: 1 });
  });
});

describe('the composition registers it on the one seam every uninstall reaches', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8');

  it('the listener stage registers the deletion hook UNCONDITIONALLY, and publishes the stores', () => {
    const source = read('serve/compose-listeners.ts');
    const at = source.indexOf('execution.executeDeps.recipeStore.addOnDeleted?.((recipe_id) => {');
    expect(at).toBeGreaterThan(0);
    // Not inside a guard: the line starts at the function body's indentation.
    expect(source.slice(source.lastIndexOf('\n', at) + 1, at)).toBe('  ');
    const hook = source.slice(at, source.indexOf('\n  });', at));
    expect(hook).toMatch(/removeRecipeOwnedState\(recipe_id, recipeOwnedState\)/);
    expect(hook).toMatch(/eventTriggersBundle\?\.dispatcher\.rebuild\(\)/);
    expect(source).toMatch(/rpc\.publishRecipeOwnedState\(\(\) => recipeOwnedState\)/);
    // The failure trip goes from the store AND from the live roster, which holds it in
    // memory: a rebuild keeps the trip of every entry it finds. So the hook reads
    // whether the recipe was on the roster BEFORE removing, and rebuilds when it was,
    // even with no owner-made automation (the live drive's case).
    expect(source).toMatch(/autoRunCircuit: rpc\.autoRunDeps\.circuitStore/);
    // Its watchers' state, from the stores the watchers themselves use.
    expect(source).toMatch(/watcherState: \{\s*clear: \(recipe_id: string\) => \{\s*if \(storage\.db\) \{\s*forgetTimeRelativeWatcherRecipe\(storage\.db, recipe_id\);\s*forgetHttpWatcherRecipe\(storage\.db, recipe_id\);/);
    expect(hook).toMatch(/const onRoster = \[\.\.\.\(autoRun\?\.roster\.values\(\) \?\? \[\]\)\]\.some\(\(entry\) => entry\.recipe_id === recipe_id\);[\s\S]*removeRecipeOwnedState\(/);
    expect(hook).toMatch(/if \(removed\.automations > 0 \|\| onRoster\) \{[^}]*autoRun\?\.refreshRoster\(\)/);
  });

  it('the rpc context hands the uninstall the published stores', () => {
    expect(read('serve/compose-rpc-context.ts')).toMatch(/composePackUninstallRpcDeps\(\{[^}]*getRecipeOwnedState,/s);
    expect(read('composition/bin/wire-pack-uninstall-rpc-deps.ts'))
      .toMatch(/\.\.\.\(getRecipeOwnedState \? \{ getRecipeOwnedState \} : \{\}\)/);
  });
});
