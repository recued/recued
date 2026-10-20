import { expect,it,vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { createRecipeRegressionCaller } from '../recipe-regression-caller.js';
const candidate: RecipeDefinition = { recipe_id: 'recipe',version: 1,ttl: 0,metadata: { name: 'Recipe',description: 'Fixture',author: 'owner',supported_platforms: [] },
  variables: {},prefetch_steps: [],steps: [],output: { render: [] } };
it('cancels the same run id when the browser waiter is aborted',async () => {
  const transport = vi.fn();
  transport.mockImplementation((method: string,_args: unknown,options?: { signal?: AbortSignal }) => {
    if (method === 'recipe.regression.cancel') return Promise.resolve({ cancelled: true });
    return new Promise((_resolve,reject) => options!.signal!.addEventListener('abort',() => reject(options!.signal!.reason),{ once: true }));
  });
  const caller = createRecipeRegressionCaller(transport), abort = new AbortController();
  const pending = caller.run({ recipe_id: 'recipe',revision: 1,candidate },abort.signal), rejection = expect(pending).rejects.toThrow(); abort.abort(); await rejection;
  expect(transport.mock.calls.map(call => call[0])).toEqual(['recipe.regression.run','recipe.regression.cancel']);
  expect(transport.mock.calls[1]![1]).toEqual({ run_id: transport.mock.calls[0]![1].run_id });
});
it('does not dispatch an already-cancelled suite or send a cancel after successful completion',async () => {
  const transport = vi.fn().mockResolvedValue({ cases: [],passed: 0,failed: 0,changed: 0 }), caller = createRecipeRegressionCaller(transport);
  const aborted = new AbortController(); aborted.abort();
  await expect(caller.run({ recipe_id: 'recipe',revision: 1,candidate },aborted.signal)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  const completed = new AbortController(); await caller.run({ recipe_id: 'recipe',revision: 1,candidate },completed.signal); completed.abort();
  expect(transport).toHaveBeenCalledTimes(1);
});
