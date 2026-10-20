import { expect,it,vi } from 'vitest';
import { createRecipeReleaseCaller } from '../recipe-release-caller.js';
it('cancels the enrolled release run through the same connection and removes its listener after completion',async () => {
  const transport = vi.fn();
  transport.mockImplementation((method: string,_args: unknown,options?: { signal?: AbortSignal }) => {
    if (method === 'recipe.regression.cancel') return Promise.resolve({ cancelled: true });
    return new Promise((_resolve,reject) => options!.signal!.addEventListener('abort',() => reject(options!.signal!.reason),{ once: true }));
  });
  const caller = createRecipeReleaseCaller(transport), abort = new AbortController();
  const pending = caller.test({ recipe_id: 'recipe',expected_revision: 1,draft_revision: 1 },abort.signal);
  const rejection = expect(pending).rejects.toThrow(); abort.abort(); await rejection;
  expect(transport.mock.calls.map(call => call[0])).toEqual(['recipe.release.test','recipe.regression.cancel']);
  expect(transport.mock.calls[1]![1]).toEqual({ run_id: transport.mock.calls[0]![1].run_id });
  transport.mockClear(); transport.mockResolvedValue({});
  const completed = new AbortController(); await caller.test({ recipe_id: 'recipe',expected_revision: 1,draft_revision: 1 },completed.signal); completed.abort();
  expect(transport).toHaveBeenCalledTimes(1);
  const cancelled = new AbortController(); cancelled.abort(); await expect(caller.test({ recipe_id: 'recipe',expected_revision: 1,draft_revision: 1 },cancelled.signal)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
});
