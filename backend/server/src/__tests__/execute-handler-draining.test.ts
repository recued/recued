/** A fresh run is refused once the server begins stopping.
 *
 *  ⛔ Every run started during a restart was one more thing a drain step waited
 *  on, and the drain stops what is still running after a short grace anyway, so
 *  a run admitted then would only be killed with it (2026-10-26). The refusal
 *  comes before anything is registered, so a caller can keep its item for the
 *  next boot; `draining` is the code RPC and MCP already answer with. */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const RECIPE: RecipeDefinition = {
  recipe_id: 'drain-test-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Drain test',
    description: 'Says hello',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: { greeting: 'hello' },
  prefetch_steps: [],
  steps: [{ id: 'msg', transform: 'template', template: '{{config.greeting}} world' }],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
};

const deps = (isDraining?: () => boolean): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    ...(isDraining !== undefined ? { isDraining } : {}),
  };
};

describe('handleExecute while the server is draining', () => {
  it('refuses a fresh run with the draining code', async () => {
    await expect(handleExecute(deps(() => true), { recipe_id: RECIPE.recipe_id }))
      .rejects.toMatchObject({ code: 'draining' });
  });

  it('runs as before when the server is not draining, or nothing says', async () => {
    expect((await handleExecute(deps(() => false), { recipe_id: RECIPE.recipe_id })).success).toBe(true);
    expect((await handleExecute(deps(), { recipe_id: RECIPE.recipe_id })).success).toBe(true);
  });

  it('does not refuse a resume', async () => {
    // A resume continues an approval already answered; whatever it then finds
    // (here: no checkpoint to continue), it is not turned away as draining.
    const outcome = await handleExecute(
      deps(() => true),
      { recipe_id: RECIPE.recipe_id },
      { resume_from: { gated_step_id: 'msg', step_state: {} } } as never,
    ).then(() => null, (err: unknown) => err as { code?: string });
    expect(outcome?.code).not.toBe('draining');
  });
});
