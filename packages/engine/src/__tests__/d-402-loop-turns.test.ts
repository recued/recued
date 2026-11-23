/** D-402 slice D5b — the engine tells each step run inside a `foreach` which turn it is
 *  (`StepMeta.iteration_indices`), on every run, not only a reviewed one: the Browser Bridge keys each
 *  turn's commands apart by it (`dom-adapter.ts`), so a later turn's same read is never the first turn's
 *  answer replayed (task M, 2026-11-17). */
import { describe, expect, it } from 'vitest';
import { executeRecipe, type IngredientExecutor } from '@recued/engine';
import type { RecipeDefinition, RecipeStep } from '@recued/contracts';

const recipeOf = (steps: Array<Record<string, unknown>>): RecipeDefinition => ({
  recipe_id: 'd-402-loop-turns', version: 1, ttl: 0,
  metadata: { name: 'Loop turns', description: 'Turns.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], steps: steps as unknown as RecipeStep[], output: { sidebar: [] },
} as RecipeDefinition);

describe('D-402 slice D5b — each turn of a loop is told to the step it runs', () => {
  it('a step in a loop learns its turn; one outside learns none, and none lingers after the loop', async () => {
    const seen: Array<{ step: string; turn?: readonly number[] }> = [];
    const probe: IngredientExecutor = async (_slug, _input, _output, _options, meta) => {
      seen.push({ step: meta!.step_id, ...(meta!.iteration_indices !== undefined ? { turn: meta!.iteration_indices } : {}) });
      return { done: true };
    };
    const result = await executeRecipe({ recipe: recipeOf([
      { id: 'pages', transform: 'flatten', array: [[{ n: '2' }, { n: '3' }, { n: '4' }]] },
      { id: 'before', ingredient: 'probe', input: {} },
      { id: 'each', ingredient: 'probe', foreach: '{{step.pages}}', input: { n: '{{item.n}}' } },
      { id: 'after', ingredient: 'probe', input: {} },
    ]), stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor: probe });
    expect(result.errors ?? []).toEqual([]);
    expect(seen).toEqual([{ step: 'before' }, { step: 'each', turn: [0] }, { step: 'each', turn: [1] }, { step: 'each', turn: [2] },
      { step: 'after' }]);
  });
});
