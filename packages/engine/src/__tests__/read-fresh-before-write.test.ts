/** Read fresh before a write (`step-seed.ts`).
 *
 *  Both cache tiers answer a read by its inputs, and a write clears nothing, so
 *  a recipe that checks the owner's records and then writes was answered with
 *  an EARLIER run's view: recorded twice within a minute, it wrote a second
 *  note; moved to Done and straight back, a task stayed done (live drive,
 *  2026-09-28). Each case runs a recipe twice on ONE cache, as the server does
 *  across runs. */

import { describe, expect, it, vi } from 'vitest';
import { createInMemoryStore } from '@recued/cache';
import type { RecipeDefinition, RecipeStep, StepOptions } from '@recued/contracts';

import { executeRecipe } from '../execute.js';
import { readFreshStepIds, type StepEffect } from '../step-seed.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const EFFECT: Record<string, StepEffect> = {
  'mark-read': 'own_read',
  'mark-write': 'write',
  'ai-summarize': 'other',
};

const recipeOf = (over: Partial<RecipeDefinition>): RecipeDefinition => ({
  recipe_id: 'read-fresh',
  version: 1,
  ttl: 0,
  metadata: { name: 'Read fresh', description: 'x', author: 'local', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...over,
});

const read = (over: Record<string, unknown> = {}) =>
  ({ id: 'seen', ingredient: 'mark-read', input: { key: 'marks.meeting-1' }, ...over }) as unknown as RecipeStep;
const write = { id: 'mark', ingredient: 'mark-write', input: { key: 'marks.meeting-1', value: true } } as unknown as RecipeStep;

/** Run `recipe` twice on one cache; report each ingredient's calls and options. */
const runTwice = async (recipe: RecipeDefinition, classify = true) => {
  const store = createInMemoryStore();
  const calls: Array<{ slug: string; options: StepOptions | undefined }> = [];
  const executor: IngredientExecutor = vi.fn(async (slug, _input, _output, options) => {
    calls.push({ slug, options });
    return slug === 'mark-read' ? { found: false } : { ok: true };
  });
  const ctx = (): ExecutionContext => ({
    recipe,
    stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
    ingredientExecutor: executor,
    stepCache: {
      store,
      ingredientPolicy: (slug) => slug === 'mark-write'
        ? { cacheable: false, ttl_seconds: 0 }
        : { cacheable: true, ttl_seconds: 60, category: slug === 'ai-summarize' ? 'ai' : 'data' },
    },
    ...(classify ? { stepEffect: (step: RecipeStep) => EFFECT[String((step as { ingredient?: unknown }).ingredient)] ?? 'other' } : {}),
  });
  const first = await executeRecipe(ctx());
  const second = await executeRecipe(ctx());
  expect(first.success && second.success).toBe(true);
  return { calls: (slug: string) => calls.filter((c) => c.slug === slug) };
};

describe('read fresh before a write', () => {
  it('⛔ a recipe that writes reads the owner’s records fresh — every run, through both tiers', async () => {
    const { calls } = await runTwice(recipeOf({ steps: [read(), write] }));
    // L2: not replayed on the second run.
    expect(calls('mark-read')).toHaveLength(2);
    // L1: the host's ingredient cache is told to skip too.
    expect(calls('mark-read').every((c) => c.options?.cache === 'fresh')).toBe(true);
  });

  it('the same read in a recipe that only reads keeps its cache', async () => {
    const { calls } = await runTwice(recipeOf({ steps: [read()] }));
    expect(calls('mark-read')).toHaveLength(1);
    expect(calls('mark-read')[0]!.options?.cache).toBeUndefined();
  });

  it('an AI step in a recipe that writes keeps its cache — an apply re-uses its preview’s answer', async () => {
    const ai = { id: 'brief', ingredient: 'ai-summarize', input: { data: 'minutes' } } as unknown as RecipeStep;
    const { calls } = await runTwice(recipeOf({ steps: [ai, write] }));
    expect(calls('ai-summarize')).toHaveLength(1);
  });

  it('a read that names its own cache keeps the author’s call', async () => {
    const { calls } = await runTwice(recipeOf({ steps: [read({ cache: 'acceptable' }), write] }));
    expect(calls('mark-read')).toHaveLength(1);
  });

  it('a prefetch read before a write skips the host’s cache too', async () => {
    const pre = { id: 'pre_seen', ingredient: 'mark-read', input: { key: 'marks.meeting-1' } };
    const { calls } = await runTwice(recipeOf({ prefetch_steps: [pre as never], steps: [write] }));
    expect(calls('mark-read').every((c) => c.options?.cache === 'fresh')).toBe(true);
  });

  it('without a host classifier nothing changes', async () => {
    const { calls } = await runTwice(recipeOf({ steps: [read(), write] }), false);
    expect(calls('mark-read')).toHaveLength(1);
  });

  it('readFreshStepIds: every own read of a writing recipe, across its step lists', () => {
    const classify = (step: RecipeStep) => EFFECT[String((step as { ingredient?: unknown }).ingredient)] ?? 'other';
    const ids = readFreshStepIds({
      trigger_steps: [read({ id: 'trigger_seen' })],
      prefetch_steps: [read({ id: 'pre_seen' }) as never],
      steps: [read(), read({ id: 'pinned', cache: 'any' }), write],
    }, classify);
    expect([...ids].sort()).toEqual(['pre_seen', 'seen', 'trigger_seen']);
    expect(readFreshStepIds({ prefetch_steps: [], steps: [read()] }, classify).size).toBe(0);
  });
});
