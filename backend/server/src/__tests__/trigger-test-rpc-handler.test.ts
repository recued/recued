/** D-116 Phase 3 — `runtime.testTrigger` server rpc handler tests. */

import { describe, expect, it, vi } from 'vitest';
import { IngredientError, type KernelDispatchers } from '@recued/ingredients';
import { RpcError } from '@recued/contracts';

import {
  handleTestTrigger,
  makeTriggerTestRpcHandlers,
} from '../trigger-test-rpc-handler.js';

type WatcherDispatcher = NonNullable<KernelDispatchers['watcher']>;

const mkDispatcher = (
  fn: (input: { slug: string; args: Record<string, unknown> }) => Promise<unknown>,
): WatcherDispatcher => fn as WatcherDispatcher;

describe('handleTestTrigger — request validation', () => {
  const dispatcher = mkDispatcher(async () => ({ should_run: false }));

  it('rejects non-object payload', async () => {
    await expect(
      handleTestTrigger({ watcherDispatcher: dispatcher }, null),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing recipe_id', async () => {
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        { step_id: 's', ingredient: 'time-watcher', dry_run: true, resolved_input: {} },
      ),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });

  it('rejects missing ingredient', async () => {
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        { recipe_id: 'r', step_id: 's', dry_run: true, resolved_input: {} },
      ),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });

  it('rejects dry_run !== true', async () => {
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        { recipe_id: 'r', step_id: 's', ingredient: 'time-watcher', dry_run: false, resolved_input: {} },
      ),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });

  it('rejects non-object resolved_input', async () => {
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        { recipe_id: 'r', step_id: 's', ingredient: 'time-watcher', dry_run: true, resolved_input: null },
      ),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });
});

describe('handleTestTrigger — dispatch', () => {
  it('dispatches slug + args and wraps the output in a TriggerTestResult', async () => {
    const dispatcher = vi.fn(async () => ({
      should_run: true,
      items: [{ id: 1 }],
    }));
    const res = await handleTestTrigger(
      {
        watcherDispatcher: mkDispatcher(dispatcher),
        now: () => 1_500_000_000_000,
      },
      {
        recipe_id: 'hours-reactive',
        step_id: 'gate',
        ingredient: 'time-watcher',
        dry_run: true,
        resolved_input: { slug: 'inbox', since: 1000 },
      },
    );
    expect(res.recipe_id).toBe('hours-reactive');
    expect(res.step_id).toBe('gate');
    expect(res.ingredient).toBe('time-watcher');
    expect(res.should_run).toBe(true);
    expect(res.output).toEqual({ should_run: true, items: [{ id: 1 }] });
    expect(res.cached).toBe(false);
    expect(res.at).toBe(1_500_000_000_000);
    expect(dispatcher).toHaveBeenCalledWith({
      slug: 'time-watcher',
      args: { slug: 'inbox', since: 1000 },
    });
  });

  it('echoes resolved_input into inputs_received (no double-redaction on the server)', async () => {
    const dispatcher = mkDispatcher(async () => ({ should_run: false }));
    const res = await handleTestTrigger(
      { watcherDispatcher: dispatcher, now: () => 0 },
      {
        recipe_id: 'r',
        step_id: 's',
        ingredient: 'time-watcher',
        dry_run: true,
        resolved_input: {
          slug: 'inbox',
          api_key: { redacted: true, length: 32 },
        },
      },
    );
    expect(res.inputs_received).toEqual({
      slug: 'inbox',
      api_key: { redacted: true, length: 32 },
    });
  });

  it('maps SERVER_NOT_REACHABLE IngredientError to service_unavailable rpc error', async () => {
    const dispatcher = mkDispatcher(async () => {
      throw new IngredientError(
        'SERVER_NOT_REACHABLE',
        'mail not configured',
        { slug: 'time-watcher' },
      );
    });
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        {
          recipe_id: 'r',
          step_id: 's',
          ingredient: 'time-watcher',
          dry_run: true,
          resolved_input: { slug: 'primary' },
        },
      ),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'service_unavailable',
      message: expect.stringContaining('runtime.testTrigger[time-watcher]'),
    });
  });

  it('maps non-SERVER_NOT_REACHABLE IngredientError to bad_request', async () => {
    const dispatcher = mkDispatcher(async () => {
      throw new IngredientError('TRANSFORM_INVALID_INPUT', 'bad', {});
    });
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        {
          recipe_id: 'r',
          step_id: 's',
          ingredient: 'time-watcher',
          dry_run: true,
          resolved_input: { weekdays: [9] },
        },
      ),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });
});

describe('makeTriggerTestRpcHandlers', () => {
  it('returns undefined when deps are absent', () => {
    expect(makeTriggerTestRpcHandlers(undefined)).toBeUndefined();
  });

  it('exposes runtime.testTrigger in its method list', () => {
    const slice = makeTriggerTestRpcHandlers({
      watcherDispatcher: mkDispatcher(async () => ({ should_run: true })),
    });
    expect(slice?.methods).toEqual(['runtime.testTrigger']);
  });

  it('handler slice wires through handleTestTrigger', async () => {
    const slice = makeTriggerTestRpcHandlers({
      watcherDispatcher: mkDispatcher(async () => ({ should_run: true })),
      now: () => 42,
    });
    const res = await slice!.handlers['runtime.testTrigger'](
      {
        recipe_id: 'r',
        step_id: 's',
        ingredient: 'time-watcher',
        dry_run: true,
        resolved_input: {},
      },
      {} as never,
    );
    expect(res.recipe_id).toBe('r');
    expect(res.at).toBe(42);
  });
});

/** ⛔ A TEST FIRE IS NOT DRY FOR A WATCHER THAT KEYS PER-RECIPE STATE
 *  (2026-10-05). `runtime.testTrigger` dispatched whatever watcher and args the
 *  client sent. Naming another recipe's id drained THAT recipe's webhook queue
 *  (the watcher, since retired): the read-and-destroy D-228 fenced on
 *  `runtime.runWatcher`, open here. A test of a time-relative step also
 *  advanced the real firing ledger, despite `dry_run: true`. The same set is
 *  refused, before dispatch. */
describe('recipe-keyed watchers are refused, before dispatch', () => {
  const testFire = (dispatcher: WatcherDispatcher, ingredient: string, resolved_input: Record<string, unknown>) =>
    handleTestTrigger({ watcherDispatcher: dispatcher }, {
      recipe_id: 'kitchen-recipe', step_id: 's', ingredient, dry_run: true, resolved_input,
    });

  it.each(['time-relative-watcher', 'http-watcher'])('⛔ refuses %s — it keys state by recipe', async (slug) => {
    const dispatcher = vi.fn(async () => ({ should_run: false }));
    await expect(testFire(mkDispatcher(dispatcher), slug, { recipe_id: 'victim-recipe' }))
      .rejects.toThrow(/engine-owned recipe identity/);
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('…while a stateless watcher still test-fires', async () => {
    const dispatcher = vi.fn(async () => ({ should_run: true }));
    const res = await testFire(mkDispatcher(dispatcher), 'time-watcher', { start_hour: 8, end_hour: 9 });
    expect(res.should_run).toBe(true);
    expect(dispatcher).toHaveBeenCalled();
  });
});
