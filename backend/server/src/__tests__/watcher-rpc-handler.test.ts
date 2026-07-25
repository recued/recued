/** D-115 Phase 6D — `runtime.runWatcher` rpc handler tests. */

import { describe, expect, it, vi } from 'vitest';
import { IngredientError, type KernelDispatchers } from '@recued/ingredients';
import { RpcError } from '@recued/contracts';

import {
  handleRunWatcher,
  makeWatcherRpcHandlers,
} from '../watcher-rpc-handler.js';

type WatcherDispatcher = NonNullable<KernelDispatchers['watcher']>;

const mkDispatcher = (
  fn: (input: { slug: string; args: Record<string, unknown> }) => Promise<unknown>,
): WatcherDispatcher => fn as WatcherDispatcher;

describe('handleRunWatcher', () => {
  it('forwards slug + args to the dispatcher and returns its envelope', async () => {
    const dispatcher = vi.fn(async () => ({ should_run: true, items: [] }));
    const r = await handleRunWatcher(
      { watcherDispatcher: mkDispatcher(dispatcher) },
      { slug: 'mail-watcher', args: { slug: 'inbox', since: 1000 } },
    );
    expect(r).toEqual({ should_run: true, items: [] });
    expect(dispatcher).toHaveBeenCalledWith({
      slug: 'mail-watcher',
      args: { slug: 'inbox', since: 1000 },
    });
  });

  it('rejects empty slug with bad_request', async () => {
    await expect(
      handleRunWatcher(
        { watcherDispatcher: mkDispatcher(async () => ({ should_run: true })) },
        { slug: '', args: {} },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects non-object args with bad_request', async () => {
    await expect(
      handleRunWatcher(
        { watcherDispatcher: mkDispatcher(async () => ({ should_run: true })) },
        { slug: 'mail-watcher', args: null as unknown as Record<string, unknown> },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('maps SERVER_NOT_REACHABLE IngredientError to service_unavailable rpc error', async () => {
    const dispatcher = mkDispatcher(async () => {
      throw new IngredientError('SERVER_NOT_REACHABLE', 'no warehouse', { slug: 'mail-watcher' });
    });
    await expect(
      handleRunWatcher({ watcherDispatcher: dispatcher }, {
        slug: 'mail-watcher',
        args: { slug: 'inbox' },
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'service_unavailable',
      message: expect.stringContaining('runtime.runWatcher[mail-watcher]'),
    });
  });

  it('maps non-SERVER_NOT_REACHABLE IngredientError to bad_request', async () => {
    const dispatcher = mkDispatcher(async () => {
      throw new IngredientError('TRANSFORM_INVALID_INPUT', 'bad arg', {});
    });
    await expect(
      handleRunWatcher({ watcherDispatcher: dispatcher }, {
        slug: 'time-watcher',
        args: { weekdays: [9] },
      }),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'bad_request',
    });
  });

  it('passes through unknown errors unchanged', async () => {
    const dispatcher = mkDispatcher(async () => {
      throw new Error('unexpected');
    });
    await expect(
      handleRunWatcher({ watcherDispatcher: dispatcher }, {
        slug: 'mail-watcher',
        args: {},
      }),
    ).rejects.toThrow(/unexpected/);
  });
});

describe('makeWatcherRpcHandlers', () => {
  it('returns undefined when deps are absent', () => {
    expect(makeWatcherRpcHandlers(undefined)).toBeUndefined();
  });

  it('exposes runtime.runWatcher in its method list', () => {
    const slice = makeWatcherRpcHandlers({
      watcherDispatcher: mkDispatcher(async () => ({ should_run: true })),
    });
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual(['runtime.runWatcher']);
  });

  it('dispatches through handleRunWatcher when invoked', async () => {
    const dispatcher = vi.fn(async () => ({ should_run: false }));
    const slice = makeWatcherRpcHandlers({
      watcherDispatcher: mkDispatcher(dispatcher),
    });
    const handler = slice!.handlers['runtime.runWatcher'];
    const r = await handler({ slug: 'webhook-watcher', args: { recipe_id: 'r1' } }, {
      instance_id: 'inst-1',
    } as never);
    expect(r).toEqual({ should_run: false });
    expect(dispatcher).toHaveBeenCalledWith({
      slug: 'webhook-watcher',
      args: { recipe_id: 'r1' },
    });
  });
});
