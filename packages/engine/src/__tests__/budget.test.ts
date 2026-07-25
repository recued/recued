import { describe, it, expect } from 'vitest';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { RecipeDefinition } from '@recued/contracts';

const mkRecipe = (overrides: Partial<RecipeDefinition['metadata']> = {}, steps: RecipeDefinition['steps'] = []): RecipeDefinition => ({
  recipe_id: 'budget-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Budget Test',
    description: 'tests',
    author: 'test',
    supported_platforms: ['test'],
    ...overrides,
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const mkCtx = (recipe: RecipeDefinition, executor: IngredientExecutor): ExecutionContext => ({
  recipe,
  stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
  ingredientExecutor: executor,
});

const fastExecutor: IngredientExecutor = async () => ({ ok: true });

const makeSlowExecutor = (ms: number): IngredientExecutor => async () =>
  new Promise((resolve) => setTimeout(() => resolve({ ok: true }), ms));

describe('RECIPE_BUDGET_EXCEEDED', () => {
  it('runs successfully when elapsed time stays under budget_ms', async () => {
    const recipe = mkRecipe(
      { budget_ms: 2_000 },
      [
        { id: 'fetch', ingredient: 'any', input: {} },
      ],
    );
    const result = await executeRecipe(mkCtx(recipe, fastExecutor));
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('aborts with RECIPE_BUDGET_EXCEEDED when elapsed time crosses budget_ms', async () => {
    const recipe = mkRecipe(
      { budget_ms: 50 },
      [
        { id: 'slow', ingredient: 'any', input: {} },
      ],
    );
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(500)));
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('RECIPE_BUDGET_EXCEEDED');
    expect(result.errors[0].severity).toBe('error');
  });

  it('omits enforcement when budget_ms is absent', async () => {
    const recipe = mkRecipe({}, [
      { id: 'slow', ingredient: 'any', input: {} },
    ]);
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(120)));
    expect(result.success).toBe(true);
  });

  it('a recipe with no metadata fails STRICT validation cleanly instead of crashing on budget_ms', async () => {
    // Regression (D-179 live-verification finding): the budget read at the top
    // of `executeRecipe` (`ctx.recipe.metadata?.budget_ms`) runs BEFORE
    // `executeRecipeInner`'s strict validation. Without the optional chain a
    // malformed recipe with no `metadata` threw "Cannot read properties of
    // undefined (reading 'budget_ms')" before validation could emit
    // `metadata_required`. The server execute path is strict — this is its path.
    const recipe = mkRecipe({}, [{ id: 's', ingredient: 'any', input: {} }]);
    delete (recipe as { metadata?: unknown }).metadata;
    const result = await executeRecipe({ ...mkCtx(recipe, fastExecutor), strict: true });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('RECIPE_VALIDATION_FAILED');
    const issues = (result.errors[0].details as { issues?: Array<{ code: string }> }).issues ?? [];
    expect(issues.map((i) => i.code)).toContain('metadata_required');
  });

  it('a recipe with no metadata never crashes the engine even with validation off', async () => {
    // Defense-in-depth: a non-strict caller (no validation) must still not crash
    // on `undefined` metadata — the budget read + the meta-namespace copy both
    // tolerate it (the run proceeds with an empty meta namespace).
    const recipe = mkRecipe({}, [{ id: 's', ingredient: 'any', input: {} }]);
    delete (recipe as { metadata?: unknown }).metadata;
    const result = await executeRecipe(mkCtx(recipe, fastExecutor));
    expect(result.success).toBe(true);
  });

  it('omits enforcement when budget_ms is zero or negative', async () => {
    const recipe = mkRecipe({ budget_ms: 0 }, [
      { id: 'slow', ingredient: 'any', input: {} },
    ]);
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(100)));
    expect(result.success).toBe(true);
  });

  it('surfaces budget_ms + elapsed_ms in error details for UI / audit', async () => {
    const recipe = mkRecipe(
      { budget_ms: 50 },
      [{ id: 'slow', ingredient: 'any', input: {} }],
    );
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(400)));
    expect(result.errors[0].details).toMatchObject({
      budget_ms: 50,
      elapsed_ms: expect.any(Number),
    });
    const elapsed = (result.errors[0].details as { elapsed_ms: number }).elapsed_ms;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('reports the budget_ms via error message for human-readable traces', async () => {
    const recipe = mkRecipe(
      { budget_ms: 75 },
      [{ id: 'slow', ingredient: 'any', input: {} }],
    );
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(500)));
    expect(result.errors[0].message).toContain('75ms budget');
  });

  it('still races even when a recipe has zero steps — empty recipe is instant', async () => {
    const recipe = mkRecipe({ budget_ms: 500 }, []);
    const result = await executeRecipe(mkCtx(recipe, fastExecutor));
    expect(result.success).toBe(true);
  });
});
