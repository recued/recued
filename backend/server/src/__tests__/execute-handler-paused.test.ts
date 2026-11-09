/** D-188 — no run starts while the server is paused, whatever starts it.
 *
 *  The owner's rulings of 2026-11-08: the pause is a lockdown ("schedule/arm/trigger/manual
 *  all stopped"), then the emergency stop (nothing leaves the server until Resume). Every
 *  fresh run is refused here, at the entry every run passes, before anything is registered or
 *  audited: a run by hand in the owner's words, any other in the halt words, which a schedule,
 *  a trigger or a queue reads as "not run" and keeps its work (`isRunRefusedForNow`). */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { isRunRefusedForNow } from '../pause-approval.js';

const RECIPE: RecipeDefinition = {
  recipe_id: 'pause-test-recipe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Pause test',
    description: 'Says hello',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: { greeting: 'hello' },
  prefetch_steps: [],
  steps: [{ id: 'msg', transform: 'template', template: '{{config.greeting}} world' }],
  output: { sidebar: [{ type: 'text', source: 'step.msg' }] },
};

const deps = (isServerPaused?: () => boolean): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    ...(isServerPaused !== undefined ? { isServerPaused } : {}),
  };
};

describe('handleExecute while the server is paused', () => {
  it('refuses a run by hand, in the owner\'s words', async () => {
    await expect(handleExecute(deps(() => true), { recipe_id: RECIPE.recipe_id, trigger_source: 'manual' }))
      .rejects.toMatchObject({ code: 'server_paused', message: 'The server is paused. Resume it, then run this again.' });
  });

  it('runs it as before when the server is not paused, or nothing says', async () => {
    const byHand = { recipe_id: RECIPE.recipe_id, trigger_source: 'manual' } as const;
    expect((await handleExecute(deps(() => false), byHand)).success).toBe(true);
    expect((await handleExecute(deps(), byHand)).success).toBe(true);
  });

  it('refuses every other run too, in words that say not to retry, and runs it once resumed', async () => {
    for (const trigger_source of ['mcp', 'chat', 'schedule', undefined] as const) {
      const request = { recipe_id: RECIPE.recipe_id, ...(trigger_source ? { trigger_source } : {}) };
      await expect(handleExecute(deps(() => true), request)).rejects.toMatchObject({
        code: 'server_paused',
        message: 'server is paused — every operation is halted until the owner resumes; do not retry until then',
      });
      expect((await handleExecute(deps(() => false), request)).success).toBe(true);
    }
  });

  it('is read as "not run" by every caller that keeps its work through a restart', async () => {
    const refused = await handleExecute(deps(() => true), { recipe_id: RECIPE.recipe_id })
      .then(() => null, (err: unknown) => err);
    expect(isRunRefusedForNow(refused)).toBe(true);
  });

  it('does not refuse a resume', async () => {
    // A resume follows an approval, and approving waits for Resume; whatever it then finds
    // (here: no checkpoint to continue), it is not turned away as paused.
    const outcome = await handleExecute(
      deps(() => true),
      { recipe_id: RECIPE.recipe_id, trigger_source: 'manual' },
      { resume_from: { gated_step_id: 'msg', step_state: {} } } as never,
    ).then(() => null, (err: unknown) => err as { code?: string });
    expect(outcome?.code).not.toBe('server_paused');
  });
});
