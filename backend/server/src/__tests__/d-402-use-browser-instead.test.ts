/** D-402 slice H3c (ruling 14) — "Use this browser instead" (`dishes.use_browser`), over the real dish and
 *  group stores: every browser setting of the dish that holds the browser its run could not use, by the
 *  value the run reads (its own, else its group's, else the recipe's), moves to one paired now; nothing
 *  else in its settings changes. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dish } from '@recued/contracts';
import { createDishGroupStore } from '../dish-group-store.js';
import { createDishStore } from '../dish-store.js';
import { useBrowserInstead, type DishHandlerDeps } from '../dish-handler.js';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

/** A recipe of three browser settings: one held by the dish, one by its group, one left to the recipe. */
const RECIPE = { keys: ['browser_1', 'browser_2', 'browser_3'],
  variables: { browser_1: 'inst-recipe', browser_2: 'inst-recipe', browser_3: 'inst-old', query: 'lamps' } };
const stand = (paired = ['inst-work', 'inst-home']) => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const deps: DishHandlerDeps = {
    store: createDishStore(db), groupStore: createDishGroupStore(db), now: () => 5_000,
    browserSettingsOf: (recipe_id) => (recipe_id === 'read-in-two-browsers' ? RECIPE : null),
    pairedBrowsers: () => paired.map((browser_id) => ({ browser_id })),
  };
  deps.groupStore!.set({ group_id: 'grp_1', name: 'Shops', config_overlay: { browser_2: 'inst-old' }, created_at: 1_000 });
  const dish: Dish = { dish_id: 'dsh_1', recipe_id: 'read-in-two-browsers', publisher_id: 'local', name: 'Weekly', is_default: true,
    config_overlay: { browser_1: 'inst-old', query: 'chairs' }, enabled: true, created_at: 1_000, group_id: 'grp_1' };
  deps.store.set(dish);
  return deps;
};

describe('D-402 slice H3c — "Use this browser instead"', () => {
  it('every setting holding the browser moves, whichever layer held it; nothing else changes', () => {
    const deps = stand();
    const moved = useBrowserInstead(deps, { dish_id: 'dsh_1', from: 'inst-old', to: 'inst-work' });
    expect(moved.moved).toEqual(['browser_1', 'browser_2', 'browser_3']);
    expect(deps.store.get('dsh_1')!.config_overlay).toEqual({ browser_1: 'inst-work', browser_2: 'inst-work', browser_3: 'inst-work', query: 'chairs' });
    // The group is the group's: only this dish's own settings change.
    expect(deps.groupStore!.get('grp_1')!.config_overlay).toEqual({ browser_2: 'inst-old' });
  });

  it('a setting holding another browser stays where it is', () => {
    const deps = stand();
    deps.store.set({ ...deps.store.get('dsh_1')!, config_overlay: { browser_1: 'inst-home', query: 'chairs' } });
    expect(useBrowserInstead(deps, { dish_id: 'dsh_1', from: 'inst-old', to: 'inst-work' }).moved).toEqual(['browser_2', 'browser_3']);
    expect(deps.store.get('dsh_1')!.config_overlay).toMatchObject({ browser_1: 'inst-home' });
  });

  it('⛔ reads the settings stored now, never an older copy: a change made meanwhile stays', () => {
    const deps = stand();
    deps.store.set({ ...deps.store.get('dsh_1')!, config_overlay: { browser_1: 'inst-old', query: 'tables' } });
    useBrowserInstead(deps, { dish_id: 'dsh_1', from: 'inst-old', to: 'inst-work' });
    expect(deps.store.get('dsh_1')!.config_overlay).toMatchObject({ query: 'tables' });
  });

  it('refused: a browser not paired now, none holding the browser, no such dish, no way to know', () => {
    const deps = stand();
    expect(() => useBrowserInstead(deps, { dish_id: 'dsh_1', from: 'inst-old', to: 'inst-gone' })).toThrow('Choose one of the browsers paired now.');
    expect(() => useBrowserInstead(deps, { dish_id: 'dsh_1', from: 'inst-never', to: 'inst-work' }))
      .toThrow('No browser setting of this dish holds that browser.');
    expect(() => useBrowserInstead(deps, { dish_id: 'dsh_none', from: 'inst-old', to: 'inst-work' })).toThrow(/not found/);
    expect(() => useBrowserInstead(deps, { dish_id: 'dsh_1', from: '', to: 'inst-work' })).toThrow('from is required');
    expect(() => useBrowserInstead({ ...deps, pairedBrowsers: undefined }, { dish_id: 'dsh_1', from: 'inst-old', to: 'inst-work' }))
      .toThrow('Choosing a browser needs a server that pairs browsers.');
    expect(deps.store.get('dsh_1')!.config_overlay).toEqual({ browser_1: 'inst-old', query: 'chairs' });
  });
});
