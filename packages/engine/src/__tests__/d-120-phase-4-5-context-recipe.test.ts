/** D-120 Phase 4.5 — `context.recipe.*` durability tests.
 *
 *  Covers:
 *    - `injectContextRecipe` populates stores.context.recipe (idempotent)
 *    - `snapshotContextRecipe` extracts manifest + picks step outputs
 *    - first-run empty snapshot
 *    - missing step outputs (skip_when / errored) drop silently
 *    - size-cap truncation (largest-first)
 *    - end-to-end via executeRecipe: snapshot fires post-run, inject at start
 *    - executeRecipe respects pre-set context.recipe (mirrors context.server)
 *    - failed runs do not snapshot
 *    - regression: digest-pipeline-daily-hubspot recipe carries forward
 *      `pipeline_total` etc. across runs
 */

import { describe, expect, it } from 'vitest';
import type {
  ContextRecipe,
  IngredientManifest,
  NamespaceStores,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import { CONTEXT_RECIPE_MAX_BYTES } from '@recued/contracts';
import {
  injectContextRecipe,
  snapshotContextRecipe,
  type ContextRecipeSnapshotResult,
} from '../context-recipe.js';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const recipe = (
  overrides: Partial<RecipeDefinition> = {},
): RecipeDefinition => ({
  recipe_id: 'phase-4-5',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'phase 4.5',
    description: 'context.recipe.* durability fixture',
    author: 'tester',
    supported_platforms: [],
  } as RecipeDefinition['metadata'],
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...overrides,
});

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

describe('D-120 Phase 4.5 — injectContextRecipe', () => {
  it('populates stores.context.recipe with the snapshot', () => {
    const stores = baseStores();
    injectContextRecipe(stores, { pipeline_total: 1234 });
    expect((stores.context as Record<string, unknown>).recipe).toEqual({
      pipeline_total: 1234,
    });
  });

  it('drops prototype-sensitive keys from injected snapshots', () => {
    const stores = baseStores();
    const snapshot = JSON.parse(
      '{"pipeline_total":1234,"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}',
    ) as ContextRecipe;
    injectContextRecipe(stores, snapshot);
    const injected = (stores.context as Record<string, unknown>).recipe as Record<string, unknown>;
    expect(injected).toEqual({ pipeline_total: 1234 });
    expect(Object.getPrototypeOf(injected)).toBe(Object.prototype);
    expect((injected as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(injected, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(injected, 'prototype')).toBe(false);
  });

  it('populates an empty object when snapshot is null', () => {
    const stores = baseStores();
    injectContextRecipe(stores, null);
    expect((stores.context as Record<string, unknown>).recipe).toEqual({});
  });

  it('respects caller-set context.recipe (does not overwrite)', () => {
    const stores = baseStores();
    (stores.context as Record<string, unknown>).recipe = { override: 'preset' };
    injectContextRecipe(stores, { pipeline_total: 999 });
    expect((stores.context as Record<string, unknown>).recipe).toEqual({
      override: 'preset',
    });
  });
});

describe('D-120 Phase 4.5 — snapshotContextRecipe', () => {
  it('returns empty snapshot when recipe references no context.recipe.*', () => {
    const r = recipe({
      steps: [{
        id: 'count',
        transform: 'count',
        input: [1, 2, 3],
      } as unknown as RecipeStep],
    });
    const stores = baseStores();
    (stores.step as Record<string, unknown>).count = 3;
    const result = snapshotContextRecipe(r, stores);
    expect(result.snapshot).toEqual({});
    expect(result.truncated).toEqual([]);
  });

  it('picks referenced step outputs from stores.step', () => {
    const r = recipe({
      steps: [
        {
          id: 'pipeline_total',
          transform: 'sum',
          input: [10, 20],
        } as unknown as RecipeStep,
        {
          id: 'next',
          transform: 'coalesce',
          values: ['{{context.recipe.pipeline_total}}', 0],
        } as unknown as RecipeStep,
      ],
    });
    const stores = baseStores();
    (stores.step as Record<string, unknown>).pipeline_total = 30;
    (stores.step as Record<string, unknown>).next = 30;
    const result = snapshotContextRecipe(r, stores);
    expect(result.snapshot).toEqual({ pipeline_total: 30 });
    expect(result.truncated).toEqual([]);
  });

  it('D-185 Slice 2 — strips a run-scoped temp file_ref from the durable snapshot', () => {
    // A `storage:'temp'` op's output carries `{ file_ref: { backing:'temp', path } }`.
    // The temp file is gone next run, so the cross-run snapshot must NOT keep the
    // ref (D-185 §3.4). Sibling fields survive; `coalesce` handles the gap.
    const r = recipe({
      steps: [
        { id: 'audio', transform: 'set', input: {} } as unknown as RecipeStep,
        {
          id: 'next',
          transform: 'coalesce',
          values: ['{{context.recipe.audio}}', 0],
        } as unknown as RecipeStep,
      ],
    });
    const stores = baseStores();
    (stores.step as Record<string, unknown>).audio = {
      mode: 'foreground',
      exit_code: 0,
      filename: 'audio.mp3',
      mime_type: 'audio/mpeg',
      file_ref: { backing: 'temp', path: '/tmp/recued-run-scratch/r1/op-x/audio.mp3', mime_type: 'audio/mpeg', filename: 'audio.mp3' },
    };
    const result = snapshotContextRecipe(r, stores);
    expect(result.snapshot).toEqual({
      audio: { mode: 'foreground', exit_code: 0, filename: 'audio.mp3', mime_type: 'audio/mpeg' },
    });
    // The temp ref is gone; the live step store is untouched (no mutation).
    expect((result.snapshot as any).audio.file_ref).toBeUndefined();
    expect(((stores.step as any).audio.file_ref as Record<string, unknown>).backing).toBe('temp');
  });

  it('does not snapshot prototype-sensitive step ids', () => {
    const r = recipe({
      steps: [
        {
          id: 'next',
          transform: 'coalesce',
          values: ['{{context.recipe.__proto__}}', 0],
        } as unknown as RecipeStep,
      ],
    });
    const stores = baseStores();
    Object.defineProperty(stores.step, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const result = snapshotContextRecipe(r, stores);
    expect(result.snapshot).toEqual({});
    expect((result.snapshot as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result.snapshot, '__proto__')).toBe(false);
  });

  it('handles missing step outputs silently (skipped / errored)', () => {
    const r = recipe({
      steps: [
        {
          id: 'consumer',
          transform: 'coalesce',
          values: [
            '{{context.recipe.pipeline_total}}',
            '{{context.recipe.deal_count}}',
            0,
          ],
        } as unknown as RecipeStep,
      ],
    });
    const stores = baseStores();
    // Only `pipeline_total` ran to completion; `deal_count` was skipped.
    (stores.step as Record<string, unknown>).pipeline_total = 42;
    const result = snapshotContextRecipe(r, stores);
    expect(result.snapshot).toEqual({ pipeline_total: 42 });
    expect(Object.keys(result.snapshot)).not.toContain('deal_count');
  });

  it('truncates largest entries until snapshot fits within size cap', () => {
    const r = recipe({
      steps: [
        {
          id: 'big',
          transform: 'count',
          input: '{{context.recipe.big}}',
        } as unknown as RecipeStep,
        {
          id: 'small',
          transform: 'count',
          input: '{{context.recipe.small}}',
        } as unknown as RecipeStep,
      ],
    });
    const stores = baseStores();
    // `big` exceeds the cap on its own; `small` fits comfortably.
    (stores.step as Record<string, unknown>).big = 'x'.repeat(
      CONTEXT_RECIPE_MAX_BYTES + 1024,
    );
    (stores.step as Record<string, unknown>).small = 'fits';
    const result = snapshotContextRecipe(r, stores);
    expect(result.truncated).toContain('big');
    expect(result.snapshot.small).toBe('fits');
    expect(result.snapshot.big).toBeUndefined();
  });

  it('honours the size cap exactly (under-budget snapshots survive intact)', () => {
    const r = recipe({
      steps: [
        {
          id: 'a',
          transform: 'count',
          input: '{{context.recipe.a}}',
        } as unknown as RecipeStep,
        {
          id: 'b',
          transform: 'count',
          input: '{{context.recipe.b}}',
        } as unknown as RecipeStep,
      ],
    });
    const stores = baseStores();
    (stores.step as Record<string, unknown>).a = 1;
    (stores.step as Record<string, unknown>).b = 2;
    const result = snapshotContextRecipe(r, stores);
    expect(result.snapshot).toEqual({ a: 1, b: 2 });
    expect(result.truncated).toEqual([]);
  });
});

describe('D-120 Phase 4.5 — executeRecipe wiring', () => {
  const noopExecutor: IngredientExecutor = async () => ({ ok: true });

  const baseCtx = (
    r: RecipeDefinition,
    overrides: Partial<ExecutionContext> = {},
  ): ExecutionContext => ({
    recipe: r,
    stores: baseStores(),
    ingredientExecutor: noopExecutor,
    ...overrides,
  });

  it('injects supplied snapshot before any step executes', async () => {
    let observed: unknown = null;
    const r = recipe({
      steps: [
        {
          id: 'echo',
          transform: 'count',
          // Force the snapshot into a step output we can inspect by
          // routing through the resolver.
          input: '{{context.recipe.prior}}',
        } as unknown as RecipeStep,
      ],
    });
    const ctx = baseCtx(r, {
      contextRecipeSnapshot: { prior: ['a', 'b', 'c'] },
    });
    const result = await executeRecipe(ctx);
    observed = (ctx.stores.context as Record<string, unknown>).recipe;
    expect(result.success).toBe(true);
    expect(observed).toEqual({ prior: ['a', 'b', 'c'] });
  });

  it('starts with empty context.recipe when no snapshot supplied', async () => {
    const r = recipe();
    const ctx = baseCtx(r);
    await executeRecipe(ctx);
    expect((ctx.stores.context as Record<string, unknown>).recipe).toEqual({});
  });

  it('emits snapshot via onContextRecipeSnapshot at end of successful run', async () => {
    const captured: ContextRecipeSnapshotResult[] = [];
    const r = recipe({
      steps: [
        {
          id: 'pipeline_total',
          transform: 'count',
          input: [1, 2, 3, 4, 5],
        } as unknown as RecipeStep,
        // Reference context.recipe.* so extractContextRecipeRefs picks
        // up `pipeline_total` as a manifest entry.
        {
          id: 'consumer',
          transform: 'coalesce',
          values: ['{{context.recipe.pipeline_total}}', 0],
        } as unknown as RecipeStep,
      ],
    });
    const ctx = baseCtx(r, {
      onContextRecipeSnapshot: (snap) => { captured.push(snap); },
    });
    await executeRecipe(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0].snapshot.pipeline_total).toBe(5);
  });

  it('does not emit snapshot when recipe has no context.recipe.* refs', async () => {
    const captured: ContextRecipeSnapshotResult[] = [];
    const r = recipe({
      steps: [{
        id: 'count_only',
        transform: 'count',
        input: [1, 2, 3],
      } as unknown as RecipeStep],
    });
    const ctx = baseCtx(r, {
      onContextRecipeSnapshot: (snap) => { captured.push(snap); },
    });
    await executeRecipe(ctx);
    // Engine still calls the callback once with empty manifest; the
    // host can short-circuit on its side. We verify manifest is empty.
    expect(captured).toHaveLength(1);
    expect(captured[0].snapshot).toEqual({});
  });

  it('does not snapshot when the run failed', async () => {
    const captured: ContextRecipeSnapshotResult[] = [];
    const failingExecutor: IngredientExecutor = async () => {
      throw new Error('synthetic failure');
    };
    const failingManifest: IngredientManifest = {
      slug: 'broken',
      name: 'broken',
      description: '',
      author: 'test',
      kind: 'http',
      category: 'data',
      risk_tier: 'read',
      input: {},
      output: {},
    };
    const r = recipe({
      steps: [
        {
          id: 'fail',
          ingredient: 'broken',
          input: { x: '{{context.recipe.prior}}' },
        } as unknown as RecipeStep,
      ],
    });
    const ctx = baseCtx(r, {
      ingredientExecutor: failingExecutor,
      manifestGetter: () => failingManifest,
      onContextRecipeSnapshot: (snap) => { captured.push(snap); },
    });
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('regression: digest-pipeline shape carries pipeline_total across runs', async () => {
    const r = recipe({
      recipe_id: 'digest-pipeline-mirror',
      variables: { stale_days: 7 },
      steps: [
        {
          id: 'pipeline_total',
          transform: 'count',
          input: [1, 2, 3, 4],
        } as unknown as RecipeStep,
        {
          id: 'deal_count',
          transform: 'count',
          input: [1, 2, 3, 4],
        } as unknown as RecipeStep,
        {
          id: 'prev_total',
          transform: 'coalesce',
          values: ['{{context.recipe.pipeline_total}}', 0],
        } as unknown as RecipeStep,
        {
          id: 'prev_count',
          transform: 'coalesce',
          values: ['{{context.recipe.deal_count}}', 0],
        } as unknown as RecipeStep,
      ],
    });

    // Run 1 — no prior snapshot. coalesce falls through to defaults.
    const captured: ContextRecipe[] = [];
    const ctx1 = {
      recipe: r,
      stores: baseStores(),
      ingredientExecutor: noopExecutor,
      onContextRecipeSnapshot: (snap: ContextRecipeSnapshotResult) => {
        captured.push(snap.snapshot);
      },
    } as ExecutionContext;
    await executeRecipe(ctx1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ pipeline_total: 4, deal_count: 4 });
    // Pre-D-120 the prev_* steps would resolve to null; verify the
    // first run still has the coalesce default behaviour.
    expect((ctx1.stores.step as Record<string, unknown>).prev_total).toBe(0);
    expect((ctx1.stores.step as Record<string, unknown>).prev_count).toBe(0);

    // Run 2 — prior snapshot supplied. coalesce reads carried-forward values.
    const ctx2 = {
      recipe: r,
      stores: baseStores(),
      ingredientExecutor: noopExecutor,
      contextRecipeSnapshot: captured[0],
      onContextRecipeSnapshot: (snap: ContextRecipeSnapshotResult) => {
        captured.push(snap.snapshot);
      },
    } as ExecutionContext;
    await executeRecipe(ctx2);
    expect((ctx2.stores.step as Record<string, unknown>).prev_total).toBe(4);
    expect((ctx2.stores.step as Record<string, unknown>).prev_count).toBe(4);
  });

  it('respects pre-set context.recipe over supplied snapshot', async () => {
    const r = recipe({
      steps: [
        {
          id: 'consumer',
          transform: 'coalesce',
          values: ['{{context.recipe.x}}', 'fallback'],
        } as unknown as RecipeStep,
      ],
    });
    const ctx = baseCtx(r, {
      contextRecipeSnapshot: { x: 'from_snapshot' },
    });
    (ctx.stores.context as Record<string, unknown>).recipe = { x: 'preset' };
    await executeRecipe(ctx);
    expect((ctx.stores.step as Record<string, unknown>).consumer).toBe('preset');
  });
});

describe('D-120 Phase 4.5 — version upgrade behaviour', () => {
  const noopExecutor: IngredientExecutor = async () => ({ ok: true });

  it('preserves snapshot entries whose step ids still exist', async () => {
    const r = recipe({
      steps: [
        {
          id: 'pipeline_total',
          transform: 'count',
          input: [1, 2, 3],
        } as unknown as RecipeStep,
        {
          id: 'consumer',
          transform: 'coalesce',
          values: ['{{context.recipe.pipeline_total}}', 0],
        } as unknown as RecipeStep,
      ],
    });
    const captured: ContextRecipeSnapshotResult[] = [];
    const ctx = {
      recipe: r,
      stores: baseStores(),
      ingredientExecutor: noopExecutor,
      // Synthetic prior snapshot from an older recipe version.
      contextRecipeSnapshot: {
        pipeline_total: 42,
        // Orphaned entry from a removed step in v1.
        old_metric: 'leftover',
      },
      onContextRecipeSnapshot: (snap: ContextRecipeSnapshotResult) => {
        captured.push(snap);
      },
    } as ExecutionContext;
    await executeRecipe(ctx);
    // pipeline_total carries forward (manifest still includes it).
    expect((ctx.stores.step as Record<string, unknown>).consumer).toBe(42);
    // New snapshot drops orphaned `old_metric` (not in manifest).
    expect(captured[0].snapshot.old_metric).toBeUndefined();
    expect(Object.keys(captured[0].snapshot)).toEqual(['pipeline_total']);
  });
});
