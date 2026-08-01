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

  /** ⚠ D-228 — sample slug moved from `webhook-watcher` to `mail-watcher`. This
   *  test's subject is the HANDLER WIRING (slice → dispatcher), and
   *  `webhook-watcher` is now refused at the fence before dispatch, so keeping it
   *  would have tested the fence instead — and, once the fence existed, tested
   *  nothing at all about the wiring. A forwardable slug preserves the subject. */
  it('dispatches through handleRunWatcher when invoked', async () => {
    const dispatcher = vi.fn(async () => ({ should_run: false }));
    const slice = makeWatcherRpcHandlers({
      watcherDispatcher: mkDispatcher(dispatcher),
    });
    const handler = slice!.handlers['runtime.runWatcher'];
    const r = await handler({ slug: 'mail-watcher', args: { since: 0 } }, {
      instance_id: 'inst-1',
    } as never);
    expect(r).toEqual({ should_run: false });
    expect(dispatcher).toHaveBeenCalledWith({
      slug: 'mail-watcher',
      args: { since: 0 },
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// D-228 — the recipe-keyed watchers cannot cross this transport
// ════════════════════════════════════════════════════════════════════

/** ⛔⛔ THE RESIDUAL THIS CLOSES. `webhook-watcher` drains (and DELETES) a
 *  per-`(recipe_id, slug)` queue and `time-relative-watcher` writes a durable
 *  firing ledger; both key that state on `recipe_id`. The kernel adapter
 *  supplies it from ENGINE-owned `stepMeta` precisely so a caller cannot choose
 *  it — but this rpc is a thin pass-through with no engine context, so a caller
 *  here could name ANOTHER recipe's queue and both read its contents and destroy
 *  them. It cannot supply the identity, so it refuses. */
describe('recipe-keyed watchers are refused', () => {
  const slice = () => makeWatcherRpcHandlers({
    watcherDispatcher: mkDispatcher(vi.fn(async () => ({ should_run: false }))),
  })!.handlers['runtime.runWatcher'];

  it('⛔ refuses webhook-watcher BEFORE dispatch', async () => {
    const dispatcher = vi.fn(async () => ({ should_run: false }));
    const handler = makeWatcherRpcHandlers({ watcherDispatcher: mkDispatcher(dispatcher) })!
      .handlers['runtime.runWatcher'];
    await expect(
      handler({ slug: 'webhook-watcher', args: { recipe_id: 'victim', slug: 'hook' } },
        { instance_id: 'i' } as never),
    ).rejects.toThrow(/engine-owned recipe identity/);
    // ⛔ THE ASSERTION THAT MATTERS — the queue is never touched, so the refusal
    // costs the victim nothing. A refusal AFTER drain would still have eaten it.
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('⛔ refuses time-relative-watcher too — same reason, same set', async () => {
    await expect(
      slice()({ slug: 'time-relative-watcher', args: { recipe_id: 'victim' } },
        { instance_id: 'i' } as never),
    ).rejects.toThrow(/engine-owned recipe identity/);
  });

  /** ⚠ THE PERMITTING WITNESS — a NARROW fence, not a retirement of the rpc.
   *  The other six take explicit args and mutate nothing, so they still forward;
   *  without this the refusal is indistinguishable from breaking the transport. */
  it('…while the stateless watchers still forward', async () => {
    for (const slug of ['mail-watcher', 'file-watcher', 'calendar-watcher', 'http-watcher']) {
      const dispatcher = vi.fn(async () => ({ should_run: false }));
      const handler = makeWatcherRpcHandlers({ watcherDispatcher: mkDispatcher(dispatcher) })!
        .handlers['runtime.runWatcher'];
      await handler({ slug, args: {} }, { instance_id: 'i' } as never);
      expect(dispatcher, `${slug} must still forward`).toHaveBeenCalled();
    }
  });
});
