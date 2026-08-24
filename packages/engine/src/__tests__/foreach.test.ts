import { describe, expect, it } from 'vitest';

import { resolveDeep } from '@recued/contracts';
import type { IngredientExecutor, ExecutionContext } from '../types.js';
import { runStep, MAX_CONTEXT_BYTES } from '../step-runner.js';

const mkCtx = (override: Partial<ExecutionContext> = {}): ExecutionContext => ({
  recipe: { id: 'r', prefetch_steps: [], steps: [], output: { sidebar: [] } } as unknown as ExecutionContext['recipe'],
  stores: {
    vault: {}, config: {}, context: {}, meta: {}, step: {},
  },
  ingredientExecutor: async () => ({}),
  ...override,
});

describe('step-level foreach', () => {
  /** Mock that mimics the production dispatch layer's ref resolution —
   *  real ingredient adapters receive refs already resolved by the
   *  `resolveRefs` option; we mirror that in tests. */
  const resolveInput = (ctx: ExecutionContext, input: Record<string, unknown>): Record<string, unknown> =>
    resolveDeep(input, ctx.stores) as Record<string, unknown>;

  it('iterates an array, injecting {{item.*}} into the input', async () => {
    const captured: unknown[] = [];
    const ctx = mkCtx();
    const executor: IngredientExecutor = async (_slug, input) => {
      const resolved = resolveInput(ctx, input);
      captured.push(resolved);
      return { ok: true };
    };
    ctx.ingredientExecutor = executor;
    (ctx.stores.step as Record<string, unknown>).arr = [
      { id: '1', name: 'A' },
      { id: '2', name: 'B' },
    ];

    const log = await runStep({
      id: 'write_each',
      ingredient: 'shared-write',
      input: { key: 'deal.{{item.id}}', value: '{{item.name}}' },
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(log.error).toBeNull();
    expect(Array.isArray(log.result)).toBe(true);
    const results = log.result as { ok: boolean; result: unknown }[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(captured).toEqual([
      { key: 'deal.1', value: 'A' },
      { key: 'deal.2', value: 'B' },
    ]);
  });

  it('continue-on-error: a failing iteration does not halt the step', async () => {
    const ctx = mkCtx();
    const executor: IngredientExecutor = async (_slug, input) => {
      const resolved = resolveInput(ctx, input);
      const key = (resolved as { key: string }).key;
      if (key === 'fail') throw new Error('boom');
      return { ok: true, key };
    };
    ctx.ingredientExecutor = executor;
    (ctx.stores.step as Record<string, unknown>).arr = [
      { key: 'ok-1' }, { key: 'fail' }, { key: 'ok-2' },
    ];

    const log = await runStep({
      id: 'iter',
      ingredient: 'shared-write',
      input: { key: '{{item.key}}', value: 1 },
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    const results = log.result as { ok: boolean; result?: unknown; error?: unknown }[];
    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
    expect(log.error).toBeNull();
  });

  it('rejects non-array foreach targets with TRANSFORM_ERROR', async () => {
    const ctx = mkCtx();
    (ctx.stores.step as Record<string, unknown>).not_arr = { a: 1 };

    const log = await runStep({
      id: 'iter',
      ingredient: 'noop',
      input: {},
      foreach: '{{step.not_arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(log.error).not.toBeNull();
    expect(log.error?.code).toBe('TRANSFORM_ERROR');
  });

  it('restores any prior {{item}} binding after the loop', async () => {
    const ctx = mkCtx();
    (ctx.stores as Record<string, unknown>).item = { sentinel: 'outer' };
    (ctx.stores.step as Record<string, unknown>).arr = [{ id: 1 }, { id: 2 }];

    await runStep({
      id: 'iter',
      ingredient: 'x',
      input: {},
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect((ctx.stores as Record<string, unknown>).item).toEqual({ sentinel: 'outer' });
  });

  it('empty array yields an empty result and no iteration errors', async () => {
    const ctx = mkCtx();
    (ctx.stores.step as Record<string, unknown>).arr = [];

    const log = await runStep({
      id: 'iter',
      ingredient: 'noop',
      input: {},
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(log.error).toBeNull();
    expect(log.result).toEqual([]);
  });

  it('item passthrough in results: ingredient foreach echoes exact source items in order', async () => {
    const ctx = mkCtx();
    const items = [
      { id: '1', name: 'A' },
      { id: '2', name: 'B' },
    ];
    const executor: IngredientExecutor = async (_slug, input) => {
      const resolved = resolveInput(ctx, input);
      return { seen: resolved.name };
    };
    ctx.ingredientExecutor = executor;
    (ctx.stores.step as Record<string, unknown>).arr = items;

    const log = await runStep({
      id: 'echo_each',
      ingredient: 'shared-write',
      input: { name: '{{item.name}}' },
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(log.error).toBeNull();
    const results = log.result as Array<{ ok: boolean; result?: unknown; item?: unknown }>;
    expect(results).toEqual([
      { ok: true, result: { seen: 'A' }, item: items[0] },
      { ok: true, result: { seen: 'B' }, item: items[1] },
    ]);
    expect(results[0].item).toBe(items[0]);
    expect(results[1].item).toBe(items[1]);
  });

  it('item on error iterations: log.error path echoes the failing source item', async () => {
    const ctx = mkCtx();
    const items = [
      { key: 'ok' },
      { key: 'fail' },
      { key: 'after' },
    ];
    const executor: IngredientExecutor = async (_slug, input) => {
      const resolved = resolveInput(ctx, input);
      const key = (resolved as { key: string }).key;
      if (key === 'fail') throw new Error('boom');
      return { key };
    };
    ctx.ingredientExecutor = executor;
    (ctx.stores.step as Record<string, unknown>).arr = items;

    const log = await runStep({
      id: 'iter',
      ingredient: 'shared-write',
      input: { key: '{{item.key}}' },
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(log.error).toBeNull();
    const results = log.result as Array<{ ok: boolean; result?: unknown; error?: unknown; item?: unknown }>;
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, result: { key: 'ok' }, item: items[0] });
    expect(results[1]).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_ERROR', message: 'boom' },
      item: items[1],
    });
    expect(results[1].item).toBe(items[1]);
    expect(results[2]).toEqual({ ok: true, result: { key: 'after' }, item: items[2] });
  });

  it('item on error iterations: thrown-exception path echoes the failing source item', async () => {
    const items = [{ key: 'fail' }];
    const stepStore = new Proxy<Record<string, unknown>>({ arr: items }, {
      set(target, prop, value) {
        // Force the inner runStep catch block itself to reject, so runForeach's
        // direct catch path records the iteration error from the public surface.
        if (prop === 'iter' && value === null) throw new Error('step store rejected inner null');
        target[prop as string] = value;
        return true;
      },
    });
    const ctx = mkCtx({
      stores: {
        vault: {}, config: {}, context: {}, meta: {}, step: stepStore,
      },
    });
    ctx.ingredientExecutor = async () => {
      throw new Error('boom');
    };

    const log = await runStep({
      id: 'iter',
      ingredient: 'shared-write',
      input: { key: '{{item.key}}' },
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(log.error).toBeNull();
    const results = log.result as Array<{ ok: boolean; error?: unknown; item?: unknown }>;
    expect(results).toEqual([
      { ok: false, error: 'step store rejected inner null', item: items[0] },
    ]);
    expect(results[0].item).toBe(items[0]);
  });

  it('Envelope idiom end-to-end: map pairs foreach source fields with ingredient results', async () => {
    const ctx = mkCtx();
    const items = [
      { key: 'first', query: 'alpha' },
      { key: 'second', query: 'beta' },
    ];
    const executor: IngredientExecutor = async (_slug, input) => {
      const resolved = resolveInput(ctx, input);
      return { value: `${resolved.query}-result` };
    };
    ctx.ingredientExecutor = executor;
    (ctx.stores.step as Record<string, unknown>).items = items;

    const foreachLog = await runStep({
      id: 'lookup_each',
      ingredient: 'search',
      input: { query: '{{item.query}}' },
      foreach: '{{step.items}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);
    expect(foreachLog.error).toBeNull();
    expect(foreachLog.result).toEqual([
      { ok: true, result: { value: 'alpha-result' }, item: items[0] },
      { ok: true, result: { value: 'beta-result' }, item: items[1] },
    ]);

    const mapLog = await runStep({
      id: 'pairs',
      transform: 'map',
      array: '{{step.lookup_each}}',
      expression: {
        key: '{{item.item.key}}',
        value: '{{item.result.value}}',
      },
    } as unknown as Parameters<typeof runStep>[0], ctx);

    expect(mapLog.error).toBeNull();
    expect(mapLog.result).toEqual([
      { key: 'first', value: 'alpha-result' },
      { key: 'second', value: 'beta-result' },
    ]);
  });

  it('trackContextSize accounting: foreach result contributes to the context-size cap', async () => {
    const ctx = mkCtx();
    // Sized from the constant — see the note in step-runner.test.ts.
    const payload = 'a'.repeat(Math.ceil(MAX_CONTEXT_BYTES * 0.3));
    (ctx.stores.step as Record<string, unknown>).arr = [{ id: 'only' }];
    ctx.ingredientExecutor = async () => ({ payload });

    await expect(runStep({
      id: 'large_each',
      ingredient: 'large-read',
      input: {},
      foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx)).rejects.toThrow(/step context is/);
  });
});

describe('a foreach reports how many items it refused', () => {
  /** ⛔⛔ Why this exists. A `foreach` is continue-on-error: a failed item lands
   *  in that item's `{ ok: false }` and the STEP returns `error: null`, so
   *  `errors[]` stays empty and `success` stays true. That is right — a partial
   *  write is not a failed run — but it made "every item refused" and "every
   *  item written" identical at every surface above the step output. Three
   *  defects shipped in one pack that way, each reporting success having written
   *  nothing. */
  const mk = async (outcomes: ReadonlyArray<'ok' | 'fail'>) => {
    const ctx = mkCtx();
    (ctx.stores.step as Record<string, unknown>).arr = outcomes.map((o, i) => ({ id: String(i), o }));
    ctx.ingredientExecutor = async (_slug, input) => {
      const resolved = resolveDeep(input, ctx.stores) as { o?: string };
      if (resolved.o === 'fail') throw new Error('records_invalid');
      return { ok: true };
    };
    return runStep({
      id: 'write_each', ingredient: 'shared-write',
      input: { o: '{{item.o}}' }, foreach: '{{step.arr}}',
    } as unknown as Parameters<typeof runStep>[0], ctx);
  };

  it('counts the failures alongside the total', async () => {
    expect((await mk(['ok', 'fail', 'ok', 'fail', 'fail'])).foreach)
      .toEqual({ items: 5, failed: 3 });
  });

  it('reports the TOTAL wipe-out that used to look like success', async () => {
    const log = await mk(['fail', 'fail']);
    expect(log.foreach).toEqual({ items: 2, failed: 2 });
    // …and the step itself still succeeds, which is the point: the tally is the
    // ONLY thing that distinguishes this run from one that wrote both.
    expect(log.error).toBeNull();
  });

  it('reports zero failures on a clean run, and a clean EMPTY one', async () => {
    // ⚠ Both numbers, not a ratio: 0 of 0 is "there was nothing to do", which is
    // a different thing from 0 of 5 — and a ratio cannot tell them apart.
    expect((await mk(['ok', 'ok'])).foreach).toEqual({ items: 2, failed: 0 });
    expect((await mk([])).foreach).toEqual({ items: 0, failed: 0 });
  });

  it('is ABSENT on a step that is not a foreach', async () => {
    // A surface tests `foreach !== undefined` to decide whether to say anything
    // at all; a `{ items: 0, failed: 0 }` on every ordinary step would make that
    // check meaningless.
    const ctx = mkCtx();
    ctx.ingredientExecutor = async () => ({ ok: true });
    const log = await runStep({
      id: 'once', ingredient: 'shared-write', input: {},
    } as unknown as Parameters<typeof runStep>[0], ctx);
    expect(log.foreach).toBeUndefined();
  });
});
