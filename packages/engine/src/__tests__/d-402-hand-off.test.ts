/** D-402 slice E4 (§6.6) — a guard marked `hand_off` stops a run with its own code, `RECIPE_HAND_OFF`: the
 *  page showed something the recipe has not met. Unlike a plain guard's `RECIPE_GUARD_TRIGGERED`, which is
 *  the recipe deciding not to act, it is a failure the owner of an unattended run is told of (D-268). */
import { describe, expect, it } from 'vitest';
import { executeRecipe } from '@recued/engine';
import type { RecipeDefinition, RecipeStep } from '@recued/contracts';

const run = (guard: Record<string, unknown>) => executeRecipe({ recipe: {
  recipe_id: 'd-402-hand-off', version: 1, ttl: 0,
  metadata: { name: 'Hand-off', description: 'A guard.', author: 'test', supported_platforms: ['test'] },
  variables: {}, prefetch_steps: [], output: { sidebar: [] },
  steps: [{ id: 'page', transform: 'set', source: {}, field: 'text', value: 'Out of stock' },
    { id: 'decide_1', guard: '{{step.page.text}} not_contains In stock', fail_reason: 'The page showed something this recipe has not met.', ...guard }] as unknown as RecipeStep[],
} as RecipeDefinition, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} }, ingredientExecutor: async () => null });

describe('D-402 slice E4 — a hand-off\'s own code', () => {
  it('a guard marked hand_off stops the run with RECIPE_HAND_OFF and its reason; a plain one keeps its own code', async () => {
    const handed = await run({ hand_off: true });
    expect(handed.errors?.[0]).toMatchObject({ code: 'RECIPE_HAND_OFF', message: 'The page showed something this recipe has not met.' });
    expect((await run({})).errors?.[0]).toMatchObject({ code: 'RECIPE_GUARD_TRIGGERED' });
  });
});
