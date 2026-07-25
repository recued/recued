/** Connection-agnostic op dispatch (slice 3) — engine safety net.
 *
 *  Canonical op-steps are rewritten to a concrete catalog fetch + projection at
 *  install (R1, `resolveConnectionAgnosticRecipe`). The engine has no
 *  op→ingredient dispatch (`stepType` reports an op-step as `'unknown'`, which
 *  would otherwise be silently stored as `null`), so one reaching the engine is a
 *  bug. The step-runner throws loudly rather than swallowing it. Under R1 +
 *  the install-time guards (validator + marketplace safety net) this is
 *  unreachable; the guard is the defensive backstop.
 */
import { describe, it, expect } from 'vitest';
import {
  executeRecipe,
  type ExecutionContext,
  type IngredientExecutor,
} from '../index.js';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

const opStepRecipe = (): RecipeDefinition =>
  ({
    recipe_id: 'unresolved-op-step',
    version: 1,
    ttl: 60,
    metadata: { name: 'r', description: 'x', author: 'test', supported_platforms: [] },
    variables: {},
    prefetch_steps: [],
    // An UNRESOLVED op-step — never expanded by the R1 install rewrite.
    steps: [{ id: 'deals', op: 'deal.search', args: { limit: 10 } } as unknown as RecipeStep],
    output: { sidebar: [] },
  }) as unknown as RecipeDefinition;

const mkCtx = (recipe: RecipeDefinition): ExecutionContext => {
  const stores: NamespaceStores = { vault: {}, config: {}, context: {}, meta: {}, step: {} };
  const ingredientExecutor: IngredientExecutor = async () => {
    throw new Error('ingredientExecutor must not be called for an unresolved op-step');
  };
  return { recipe, stores, ingredientExecutor };
};

describe('engine safety — unresolved canonical op-step (slice 3)', () => {
  it('throws a clear error rather than silently storing null', async () => {
    await expect(executeRecipe(mkCtx(opStepRecipe()))).rejects.toThrow(
      /canonical op-step 'deals'.*reached the engine unresolved/,
    );
  });

  it('names the op in the error so the bug is diagnosable', async () => {
    await expect(executeRecipe(mkCtx(opStepRecipe()))).rejects.toThrow(/op 'deal\.search'/);
  });
});
