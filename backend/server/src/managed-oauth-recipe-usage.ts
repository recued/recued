/** D-322 §25 — explicit API references and configured users from D-320's slot reader. */
import type { Dish, ManagedOAuthConnectionUse, RecipeDefinition, RpcResponse, ServerRpcRegistry } from '@recued/contracts';
import { recipeRequiredConnections } from '@recued/contracts';
import type { Schedule } from '@recued/scheduler';
type RecipeConnectionSlot = RpcResponse<ServerRpcRegistry, 'packs.connections.recipe'>['slots'][number];

const explicit = (name: string, recipe: RecipeDefinition): 'yes' | 'possible' | undefined => {
  let possible = false;
  for (const need of recipeRequiredConnections(recipe)) {
    if (need.name !== name) continue;
    if (need.kind === 'api') return 'yes';
    if (need.kind === null) possible = true;
  }
  return possible ? 'possible' : undefined;
};
const chosen = (name: string, slots: readonly RecipeConnectionSlot[], dish?: Dish,
  required?: ReturnType<typeof explicit>): 'yes' | 'possible' | undefined => {
  if (required === 'yes') return 'yes';
  let possible = required === 'possible';
  for (const slot of slots) {
    if (!slot.connections.some(c => c.connection_name === name)) continue;
    const selected = dish?.connections?.[slot.slot];
    if (selected !== undefined) { if (selected === name) return 'yes'; continue; }
    const defaultConnection = slot.connections.find(c => c.is_default)?.connection_name;
    if (defaultConnection === name) return 'yes';
    possible = true;
  }
  return possible ? 'possible' : undefined;
};
export const managedOAuthRecipeUses = (name: string, input: {
  recipes: readonly RecipeDefinition[];
  readSlots(recipe: RecipeDefinition): readonly RecipeConnectionSlot[];
  dishes: readonly Dish[];
  schedules: readonly Pick<Schedule, 'schedule_id' | 'recipe_id' | 'dish_id' | 'enabled'>[];
}): ManagedOAuthConnectionUse[] => {
  const uses: ManagedOAuthConnectionUse[] = [];
  const byId = new Map(input.recipes.map(r => [r.recipe_id, r]));
  const slots = new Map(input.recipes.map(r => [r.recipe_id, input.readSlots(r)]));
  const required = new Map(input.recipes.map(r => [r.recipe_id, explicit(name, r)]));
  const add = (kind: ManagedOAuthConnectionUse['kind'], id: string, label: string,
    how: ReturnType<typeof chosen>, paused = false): void => {
    if (how) uses.push({ kind, id, label, ...(how === 'possible' ? { may_use: true as const } : {}), ...(paused ? { paused: true as const } : {}) });
  };
  for (const recipe of input.recipes) add('recipe', recipe.recipe_id, recipe.metadata.name,
    chosen(name, slots.get(recipe.recipe_id) ?? [], undefined, required.get(recipe.recipe_id)));
  for (const dish of input.dishes) add('dish', dish.dish_id, dish.name || byId.get(dish.recipe_id)?.metadata.name || dish.dish_id,
    chosen(name, slots.get(dish.recipe_id) ?? [], dish, required.get(dish.recipe_id)), !dish.enabled);
  for (const schedule of input.schedules) {
    const dish = schedule.dish_id ? input.dishes.find(d => d.dish_id === schedule.dish_id)
      : input.dishes.find(d => d.recipe_id === schedule.recipe_id && d.is_default);
    if (schedule.dish_id && !dish) continue;
    add('schedule', schedule.schedule_id, byId.get(schedule.recipe_id)?.metadata.name || schedule.recipe_id,
      chosen(name, slots.get(schedule.recipe_id) ?? [], dish, required.get(schedule.recipe_id)), !schedule.enabled || dish?.enabled === false);
  }
  return uses;
};
