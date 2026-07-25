/** D-116 — wait transform's exclusion from `metadata.budget_ms`.
 *
 *  Same treatment as D-094 approval waits: wall-clock recipe duration
 *  includes the wait, but the engine's budget-exceeded timer is
 *  extended by each wait so a deliberate pause doesn't trip the gate.
 */

import { describe, it, expect } from 'vitest';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { RecipeDefinition } from '@recued/contracts';

const mkRecipe = (budget_ms: number, steps: RecipeDefinition['steps']): RecipeDefinition => ({
  recipe_id: 'wait-budget-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Wait Budget Test',
    description: 'exercises wait + budget_ms interaction',
    author: 'recued',
    supported_platforms: ['test'],
    budget_ms,
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const mkCtx = (recipe: RecipeDefinition): ExecutionContext => ({
  recipe,
  stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
  ingredientExecutor: (async () => ({})) as IngredientExecutor,
});

describe('wait exclusion from budget_ms', () => {
  it('does not trip RECIPE_BUDGET_EXCEEDED when a wait sleeps longer than the budget', async () => {
    // Budget 50ms, wait 200ms — the recipe would normally trip, but
    // `wait` extends the budget timer so it doesn't.
    const recipe = mkRecipe(50, [
      { id: 'pause', transform: 'wait', ms: 200 },
    ]);
    const result = await executeRecipe(mkCtx(recipe));
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.steps[0].result).toEqual({ waited_ms: 200 });
  });

  it('still trips the budget for non-wait work that overruns', async () => {
    // A wait that doesn't cover the whole slow executor: budget 60ms,
    // wait 20ms (extends to 80ms), but executor sleeps 400ms. Should
    // trip because real work overran the *extended* budget.
    const recipe = mkRecipe(60, [
      { id: 'pause', transform: 'wait', ms: 20 },
      { id: 'slow', ingredient: 'any', input: {} },
    ]);
    const slowCtx: ExecutionContext = {
      ...mkCtx(recipe),
      ingredientExecutor: (async () =>
        new Promise((r) => setTimeout(() => r({}), 400))) as IngredientExecutor,
    };
    const result = await executeRecipe(slowCtx);
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('RECIPE_BUDGET_EXCEEDED');
  });

  it('handles recipes with no budget_ms (wait still runs, no extension needed)', async () => {
    const recipe = mkRecipe(0, [
      { id: 'pause', transform: 'wait', ms: 30 },
    ]);
    const result = await executeRecipe(mkCtx(recipe));
    expect(result.success).toBe(true);
    expect(result.steps[0].result).toEqual({ waited_ms: 30 });
  });
});
