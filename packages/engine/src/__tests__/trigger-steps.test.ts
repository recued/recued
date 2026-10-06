/** D-115 Phase 5 — executor integration for `trigger_steps` +
 *  `{{trigger.*}}` refs + dynamic `next_run_at` capture. */

import { describe, it, expect } from 'vitest';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { RecipeDefinition, NamespaceStores } from '@recued/contracts';

const makeRecipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'trg',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'trg',
    description: 'test',
    author: 'test',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
});

const makeCtx = (
  recipe: RecipeDefinition,
  executor: IngredientExecutor,
  overrides?: Partial<NamespaceStores>,
): ExecutionContext => ({
  recipe,
  stores: {
    vault: {},
    config: {},
    context: {},
    meta: {},
    step: {},
    ...overrides,
  },
  ingredientExecutor: executor,
});

describe('executeRecipe — trigger_steps phase', () => {
  it('runs trigger phase BEFORE prefetch when all gates pass', async () => {
    const order: string[] = [];
    const executor: IngredientExecutor = async (slug) => {
      order.push(slug);
      if (slug === 'gate') return { should_run: true, x: 1 };
      if (slug === 'data') return { foo: 'bar' };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [
        { id: 't1', ingredient: 'gate' },
      ],
      prefetch_steps: [
        { id: 'p1', ingredient: 'data' },
      ],
    });
    const ctx = makeCtx(recipe, executor);
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    expect(result.trigger_skipped).toBeUndefined();
    expect(order).toEqual(['gate', 'data']); // gate before data
  });

  it('does not write prototype-sensitive trigger ids into trigger store', async () => {
    const executor: IngredientExecutor = async () => ({ should_run: true, polluted: true });
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [
        { id: '__proto__', ingredient: 'gate' },
        { id: 'safe_gate', ingredient: 'gate' },
      ],
      steps: [],
    });
    const ctx = makeCtx(recipe, executor);
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    expect((ctx.stores.trigger as Record<string, unknown>).safe_gate).toEqual({ polluted: true });
    expect((ctx.stores.trigger as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(ctx.stores.trigger, '__proto__')).toBe(false);
  });

  it('short-circuits silently when any trigger returns should_run: false', async () => {
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'gate') return { should_run: false };
      throw new Error(`unexpected ${slug}`);
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'gate' }],
      prefetch_steps: [{ id: 'p1', ingredient: 'data' }],
      steps: [{ id: 'never_runs', transform: 'concat', strings: ['a', 'b'] }],
    });
    const ctx = makeCtx(recipe, executor);
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    expect(result.trigger_skipped).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(ctx.stores.step.never_runs).toBeUndefined();
    expect(result.output.sidebar).toEqual([]);
  });

  it('silent-skip emits no sidebar even when output.sidebar is configured', async () => {
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'gate') return { should_run: false };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'gate' }],
      steps: [{ id: 's1', transform: 'concat', strings: ['x'] }],
      output: { sidebar: [{ type: 'text', source: 'step.s1' }] },
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.trigger_skipped).toBe(true);
    expect(result.output.sidebar).toEqual([]);
  });

  it('AND-gates multiple trigger steps — all must be true', async () => {
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'g1') return { should_run: true };
      if (slug === 'g2') return { should_run: true };
      if (slug === 'g3') return { should_run: false };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [
        { id: 't1', ingredient: 'g1' },
        { id: 't2', ingredient: 'g2' },
        { id: 't3', ingredient: 'g3' },
      ],
      steps: [{ id: 'never', transform: 'concat', strings: ['x'] }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.trigger_skipped).toBe(true);
  });

  it('short-circuits at first false — later trigger steps do not run', async () => {
    const called: string[] = [];
    const executor: IngredientExecutor = async (slug) => {
      called.push(slug);
      if (slug === 'g1') return { should_run: false };
      if (slug === 'g2') return { should_run: true };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [
        { id: 't1', ingredient: 'g1' },
        { id: 't2', ingredient: 'g2' },
      ],
    });
    await executeRecipe(makeCtx(recipe, executor));
    expect(called).toEqual(['g1']); // g2 never invoked
  });

  it('defaults should_run to false when missing from output', async () => {
    const executor: IngredientExecutor = async () => ({ items: [] });
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'missing-flag' }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.trigger_skipped).toBe(true);
  });

  it('defaults should_run to false when output is null', async () => {
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'null-out' }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.trigger_skipped).toBe(true);
  });

  it('defaults should_run to false on strict-false (not truthy) values', async () => {
    const executor: IngredientExecutor = async () => ({ should_run: 1 }); // 1 !== true
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'maybe' }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.trigger_skipped).toBe(true);
  });

  it('populates stores.trigger.<id>.* without should_run leaking through', async () => {
    const executor: IngredientExecutor = async () =>
      ({ should_run: true, items: [{ subject: 'hi' }], last_seen_at: 1234 });
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'mail', ingredient: 'http-watcher' }],
      steps: [{ id: 'passthrough', transform: 'concat', strings: ['done'] }],
    });
    const ctx = makeCtx(recipe, executor);
    await executeRecipe(ctx);
    expect(ctx.stores.trigger).toBeDefined();
    const triggerStore = ctx.stores.trigger as Record<string, unknown>;
    expect(triggerStore.mail).toEqual({ items: [{ subject: 'hi' }], last_seen_at: 1234 });
    // should_run is stripped — never leaks
    expect((triggerStore.mail as Record<string, unknown>).should_run).toBeUndefined();
  });

  it('exposes {{trigger.*}} to downstream sequential steps (transform)', async () => {
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'http-watcher') return { should_run: true, last_seen_at: 9999 };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'mail', ingredient: 'http-watcher' }],
      steps: [
        // Transform steps get params deep-resolved by step-runner before
        // dispatch — verifies the trigger namespace is readable via the
        // same sync resolver pipeline as step / config / etc.
        {
          id: 'cursor_plus_one',
          transform: 'math',
          left: '{{trigger.mail.last_seen_at}}',
          operator: 'add',
          right: 1,
        },
      ],
    });
    const ctx = makeCtx(recipe, executor);
    await executeRecipe(ctx);
    expect(ctx.stores.step.cursor_plus_one).toBe(10_000);
  });

  it('trigger step also lands on stores.step so later trigger steps can ref it', async () => {
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'producer') return { should_run: true, cursor: 42 };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [
        { id: 'a', ingredient: 'producer' },
        // Second trigger step reads first via step namespace
        {
          id: 'b',
          transform: 'compare',
          left: '{{step.a.cursor}}',
          operator: 'greater',
          value: 0,
        },
      ],
    });
    const ctx = makeCtx(recipe, executor);
    const result = await executeRecipe(ctx);
    // Transform `compare` returns a boolean — without should_run field,
    // it defaults to false → silent-skip. This documents the behaviour:
    // transform-style triggers need the should_run field too.
    expect(result.trigger_skipped).toBe(true);
    expect(ctx.stores.step.a).toEqual({ should_run: true, cursor: 42 });
  });

  it('halts on trigger-step error (counts toward circuit breaker)', async () => {
    const executor: IngredientExecutor = async () => {
      throw new Error('ingredient boom');
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'boom' }],
      steps: [{ id: 'never', transform: 'concat', strings: ['x'] }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.success).toBe(false);
    expect(result.trigger_skipped).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('empty trigger_steps array is a no-op (phase is absent)', async () => {
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'data') return { foo: 1 };
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [],
      prefetch_steps: [{ id: 'p1', ingredient: 'data' }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.success).toBe(true);
    expect(result.trigger_skipped).toBeUndefined();
  });

  it('skip_when on a trigger step is treated as should_run=false', async () => {
    const executor: IngredientExecutor = async () => ({ should_run: true });
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      variables: { off: true },
      trigger_steps: [
        {
          id: 'gated',
          ingredient: 'never-called',
          skip_when: '{{config.off}} equal true',
        },
      ],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.trigger_skipped).toBe(true);
  });

  it('trigger_steps phase is skipped entirely on non-reactive recipes', async () => {
    let triggerCalled = false;
    const executor: IngredientExecutor = async (slug) => {
      if (slug === 'gate') triggerCalled = true;
      return null;
    };
    // Recipe with NO trigger_steps field — normal manual run.
    const recipe = makeRecipe({
      prefetch_steps: [{ id: 'p1', ingredient: 'data' }],
    });
    await executeRecipe(makeCtx(recipe, executor));
    expect(triggerCalled).toBe(false);
  });

  it('prefetch runs only after all trigger gates pass', async () => {
    const order: string[] = [];
    const executor: IngredientExecutor = async (slug) => {
      order.push(slug);
      if (slug === 'gate') return { should_run: true };
      if (slug === 'prefetcher') return {};
      return null;
    };
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'gate' }],
      prefetch_steps: [{ id: 'p1', ingredient: 'prefetcher' }],
    });
    await executeRecipe(makeCtx(recipe, executor));
    expect(order).toEqual(['gate', 'prefetcher']);
  });

  it('stores.trigger is absent when recipe has no trigger_steps', async () => {
    const executor: IngredientExecutor = async () => ({});
    const recipe = makeRecipe({
      prefetch_steps: [{ id: 'p', ingredient: 'x' }],
    });
    const ctx = makeCtx(recipe, executor);
    await executeRecipe(ctx);
    expect(ctx.stores.trigger).toBeUndefined();
  });

  it('silent-skip writes no error log entries for skipped trigger', async () => {
    const executor: IngredientExecutor = async () => ({ should_run: false });
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 't1', ingredient: 'gate' }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.errors).toHaveLength(0);
    // The trigger step log is present (so audit layer can inspect it
    // if it wants), but the overall run is marked trigger_skipped.
    const triggerLog = result.steps.find((s) => s.id === 't1');
    expect(triggerLog).toBeDefined();
    expect(triggerLog?.error).toBeNull();
  });
});

describe('executeRecipe — dynamic next_run_at capture', () => {
  it('surfaces stores.step.next_run_at as result.next_run_at when numeric', async () => {
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000, dynamic: true },
      steps: [
        {
          id: 'next_run_at',
          transform: 'coalesce',
          values: [1_800_000, 0],
        },
      ],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.success).toBe(true);
    expect(result.next_run_at).toBe(1_800_000);
  });

  it('ignores non-finite next_run_at (Infinity)', async () => {
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000, dynamic: true },
      steps: [
        {
          id: 'next_run_at',
          transform: 'coalesce',
          values: [{ not_a_number: true }],
        },
      ],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.next_run_at).toBeUndefined();
  });

  it('ignores non-numeric next_run_at (string)', async () => {
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000, dynamic: true },
      steps: [
        {
          id: 'next_run_at',
          transform: 'coalesce',
          values: ['not a number'],
        },
      ],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.next_run_at).toBeUndefined();
  });

  it('ignores zero / negative values (would wedge scheduler)', async () => {
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000, dynamic: true },
      steps: [
        { id: 'next_run_at', transform: 'coalesce', values: [0, 42] },
      ],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.next_run_at).toBeUndefined();
  });

  it('leaves next_run_at undefined when no step has that id', async () => {
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000 },
      steps: [{ id: 's1', transform: 'concat', strings: ['x'] }],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.next_run_at).toBeUndefined();
  });

  it('engine surfaces next_run_at even when auto_run.dynamic is false', async () => {
    // The scheduler gates on `dynamic` — the engine just surfaces the
    // hint. This keeps the contract clean: engine computes, scheduler
    // decides whether to honour.
    const executor: IngredientExecutor = async () => null;
    const recipe = makeRecipe({
      auto_run: { interval_ms: 60_000, dynamic: false },
      steps: [
        { id: 'next_run_at', transform: 'coalesce', values: [2_000_000] },
      ],
    });
    const result = await executeRecipe(makeCtx(recipe, executor));
    expect(result.next_run_at).toBe(2_000_000);
  });
});
