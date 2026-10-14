/** D-322 §25 — chosen dishes, defaults, possible reads and paused schedules. */
import { describe, expect, it } from 'vitest';
import type { Dish, RecipeDefinition } from '@recued/contracts';
import { managedOAuthRecipeUses } from '../managed-oauth-recipe-usage.js';
const recipe = { recipe_id: 'read-sheet', metadata: { name: 'Read sheet' } } as RecipeDefinition;
const dish = (id: string, connection: string, main = false, enabled = true): Dish => ({ dish_id: id, recipe_id: recipe.recipe_id,
  publisher_id: 'recued-core', name: id, is_default: main, enabled, config_overlay: {}, connections: { google: connection }, created_at: 1 });
const input = () => ({ recipes: [recipe], readSlots: () => [{ slot: 'google', variables: [], connections: [
  { connection_name: 'work', display_name: 'Work', is_default: true }, { connection_name: 'personal', display_name: 'Personal', is_default: false },
]}], dishes: [dish('main', 'personal', true), dish('work-dish', 'work', false, false)], schedules: [
  { schedule_id: 'main-schedule', recipe_id: recipe.recipe_id, enabled: true },
  { schedule_id: 'work-schedule', recipe_id: recipe.recipe_id, dish_id: 'work-dish', enabled: true },
  { schedule_id: 'missing-dish', recipe_id: recipe.recipe_id, dish_id: 'gone', enabled: true },
] });
describe('D-322 recipe impact users', () => {
  it.each(['typed reference', 'declared permission'])('includes explicit %s outside a pack-choice slot', async form => {
    const explicit = { ...recipe, requires: form === 'declared permission' ? ['read_connection_work'] : [],
      steps: [{ id: 'read', ingredient: 'transform', input: { value: form === 'typed reference' ? '{{connection.api.work.base_url}}' : 'plain value' } }] } as RecipeDefinition;
    const data = input(); data.recipes = [explicit]; data.readSlots = () => [];
    const refs = managedOAuthRecipeUses('work', data);
    expect(refs.map(ref => [ref.kind, ref.id])).toEqual([['recipe', 'read-sheet'], ['dish', 'main'], ['dish', 'work-dish'],
      ['schedule', 'main-schedule'], ['schedule', 'work-schedule']]);
    expect(refs.every(ref => ref.may_use === (form === 'declared permission' ? true : undefined))).toBe(true);
    expect(refs.find(ref => ref.id === 'work-dish')?.paused).toBe(true);
    expect(refs.find(ref => ref.id === 'work-schedule')?.paused).toBe(true);
  });
  it('excludes a same-named MCP dependency even when its coarse permission is also declared', () => {
    const data = input(); data.readSlots = () => [];
    data.recipes = [{ ...recipe, requires: ['read_connection_work'], steps: [{ id: 'mcp', ingredient: 'transform',
      input: { value: '{{connection.mcp.work.base_url}}' } }] } as RecipeDefinition];
    expect(managedOAuthRecipeUses('work', data)).toEqual([]);
  });
  it('uses dish choices before pack defaults and excludes missing named dishes', () => {
    const refs = managedOAuthRecipeUses('work', input());
    expect(refs).toEqual([{ kind: 'recipe', id: 'read-sheet', label: 'Read sheet' },
      { kind: 'dish', id: 'work-dish', label: 'work-dish', paused: true },
      { kind: 'schedule', id: 'work-schedule', label: 'Read sheet', paused: true }]);
    expect(refs.some(ref => ref.id === 'main-schedule' || ref.id === 'missing-dish')).toBe(false);
  });
  it('distinguishes possible recipe choices from scheduled main-dish use', () => {
    expect(managedOAuthRecipeUses('personal', input())).toEqual([
      { kind: 'recipe', id: 'read-sheet', label: 'Read sheet', may_use: true },
      { kind: 'dish', id: 'main', label: 'main' }, { kind: 'schedule', id: 'main-schedule', label: 'Read sheet' },
    ]);
  });
  it('does not claim a connection from a matching label or unrelated recipe text', () => {
    expect(managedOAuthRecipeUses('Read sheet', input())).toEqual([]);
  });
});
