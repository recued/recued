/** D-319 — the guided import's "remember these columns" keeps them as the
 *  recipe's MAIN dish's settings, over `dishes.*` (`recipe_config.*` retired). */

import { describe, expect, it, vi } from 'vitest';

import type { Dish } from '@recued/contracts';

import { mainDishSettings } from '../recipes/main-dish-settings.js';

const dish = (over: Partial<Dish> = {}): Dish => ({
  dish_id: 'dsh_main',
  recipe_id: 'import-rows',
  publisher_id: 'recued-core',
  name: '',
  is_default: true,
  config_overlay: { column_date: 'B' },
  enabled: true,
  created_at: 1,
  ...over,
});

const callers = (dishes: Dish[]) => ({
  list: vi.fn(async () => ({ dishes })),
  update: vi.fn(async () => ({})),
  create: vi.fn(async () => ({})),
});

describe('mainDishSettings', () => {
  it('reads the main dish’s settings — not another dish’s, not another recipe’s', async () => {
    const c = callers([
      dish({ dish_id: 'dsh_other', is_default: false, config_overlay: { column_date: 'Z' } }),
      dish(),
      dish({ dish_id: 'dsh_elsewhere', recipe_id: 'other', config_overlay: { column_date: 'Q' } }),
    ]);
    expect(await mainDishSettings(c).get({ recipe_id: 'import-rows' })).toEqual({ config_overlay: { column_date: 'B' } });
    expect(await mainDishSettings(callers([])).get({ recipe_id: 'import-rows' })).toEqual({ config_overlay: {} });
  });

  it('remembers on the main dish, in place', async () => {
    const c = callers([dish()]);
    await mainDishSettings(c).set({ recipe_id: 'import-rows', publisher_id: 'recued-core', config_overlay: { column_date: 'C' } });
    expect(c.update).toHaveBeenCalledWith({ dish_id: 'dsh_main', config_overlay: { column_date: 'C' } });
    expect(c.create).not.toHaveBeenCalled();
  });

  it('with no dish, remembering makes one OFF — saved, not switched on', async () => {
    const c = callers([]);
    await mainDishSettings(c).set({ recipe_id: 'import-rows', publisher_id: 'recued-core', config_overlay: { column_date: 'C' } });
    expect(c.create).toHaveBeenCalledWith({
      recipe_id: 'import-rows', publisher_id: 'recued-core', config_overlay: { column_date: 'C' }, enabled: false,
    });
  });

  it('with nothing to remember and no dish, nothing is made', async () => {
    const c = callers([]);
    expect(await mainDishSettings(c).set({ recipe_id: 'import-rows', publisher_id: 'recued-core', config_overlay: {} }))
      .toEqual({ config_overlay: {} });
    expect(c.create).not.toHaveBeenCalled();
    expect(c.update).not.toHaveBeenCalled();
  });
});
