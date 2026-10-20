import { expect,it,vi } from 'vitest';
import { createPackUpdateCaller } from '../settings/pack-update-caller.js';
it('uses one run identity for batch tests and cancellation, and removes the abort listener on completion',async () => {
  const transport = vi.fn();
  transport.mockImplementation((method: string,_args: unknown,options?: { signal?: AbortSignal }) => {
    if (method === 'recipe.regression.cancel') return Promise.resolve({ cancelled: true });
    return new Promise((_resolve,reject) => options!.signal!.addEventListener('abort',() => reject(options!.signal!.reason),{ once: true }));
  });
  const caller = createPackUpdateCaller(transport), controller = new AbortController();
  const pending = caller.test({ pack_slug: 'fixture',expected_revision: 1 },controller.signal);
  const rejected = expect(pending).rejects.toThrow(); controller.abort(); await rejected;
  expect(transport.mock.calls.map(call => call[0])).toEqual(['packs.update.test','recipe.regression.cancel']);
  expect(transport.mock.calls[1]![1]).toEqual({ run_id: transport.mock.calls[0]![1].run_id });
  transport.mockClear(); transport.mockResolvedValue({});
  const completed = new AbortController(); await caller.test({ pack_slug: 'fixture',expected_revision: 1 },completed.signal); completed.abort();
  expect(transport).toHaveBeenCalledTimes(1);
});
it('keeps the reviewed group request intact and never retries a failed apply automatically',async () => {
  const transport = vi.fn().mockRejectedValueOnce(new Error('Reply lost')).mockResolvedValue({});
  const caller = createPackUpdateCaller(transport), request = { pack_slug: 'group',expected_revision: 2,review_id: 'review',request_id: 'stable-request' };
  await expect(caller.apply(request)).rejects.toThrow('Reply lost'); expect(transport).toHaveBeenCalledTimes(1);
  await caller.apply(request);
  expect(transport.mock.calls.map(call => call.slice(0,2))).toEqual([['packs.update.apply',request],['packs.update.apply',request]]);
  expect(transport.mock.calls[0]![2]).toEqual({ timeout: 65_000 });
  await caller.release({ pack_slug: 'group',expected_revision: 2,request_id: 'release' });
  expect(transport.mock.calls[2]![0]).toBe('packs.update.release');
  const restore = { pack_slug: 'group',release_id: 'retained',expected_revision: 2,request_id: 'restore' };
  await caller.restore(restore); expect(transport.mock.calls[3]!.slice(0,2)).toEqual(['packs.update.restore',restore]);
});
