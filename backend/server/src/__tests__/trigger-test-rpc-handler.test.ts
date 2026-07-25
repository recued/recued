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
        { step_id: 's', ingredient: 'mail-watcher', dry_run: true, resolved_input: {} },
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
        { recipe_id: 'r', step_id: 's', ingredient: 'mail-watcher', dry_run: false, resolved_input: {} },
      ),
    ).rejects.toMatchObject({ name: 'RpcError', code: 'bad_request' });
  });

  it('rejects non-object resolved_input', async () => {
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        { recipe_id: 'r', step_id: 's', ingredient: 'mail-watcher', dry_run: true, resolved_input: null },
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
        recipe_id: 'mail-reactive',
        step_id: 'gate',
        ingredient: 'mail-watcher',
        dry_run: true,
        resolved_input: { slug: 'inbox', since: 1000 },
      },
    );
    expect(res.recipe_id).toBe('mail-reactive');
    expect(res.step_id).toBe('gate');
    expect(res.ingredient).toBe('mail-watcher');
    expect(res.should_run).toBe(true);
    expect(res.output).toEqual({ should_run: true, items: [{ id: 1 }] });
    expect(res.cached).toBe(false);
    expect(res.at).toBe(1_500_000_000_000);
    expect(dispatcher).toHaveBeenCalledWith({
      slug: 'mail-watcher',
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
        ingredient: 'http-watcher',
        dry_run: true,
        resolved_input: {
          target_url: 'https://example.com',
          api_key: { redacted: true, length: 32 },
        },
      },
    );
    expect(res.inputs_received).toEqual({
      target_url: 'https://example.com',
      api_key: { redacted: true, length: 32 },
    });
  });

  it('maps SERVER_NOT_REACHABLE IngredientError to service_unavailable rpc error', async () => {
    const dispatcher = mkDispatcher(async () => {
      throw new IngredientError(
        'SERVER_NOT_REACHABLE',
        'calendar not configured',
        { slug: 'calendar-watcher' },
      );
    });
    await expect(
      handleTestTrigger(
        { watcherDispatcher: dispatcher },
        {
          recipe_id: 'r',
          step_id: 's',
          ingredient: 'calendar-watcher',
          dry_run: true,
          resolved_input: { slug: 'primary' },
        },
      ),
    ).rejects.toMatchObject({
      name: 'RpcError',
      code: 'service_unavailable',
      message: expect.stringContaining('runtime.testTrigger[calendar-watcher]'),
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
