/** D-159 I-8 / A.4 -- engine checkpoint fidelity.
 *
 *  D-157 P1's preflight pause/resume gate depends on the engine carrying
 *  no continuation state outside `ctx.stores`: the checkpoint is the
 *  cloned stores object. This test imports only `@recued/engine` plus
 *  contracts/types, with no middleware in the path, which is itself part
 *  of the I-8 invariant.
 *
 *  Spec: D-159 section A.4 + I-8. */

import { describe, it, expect } from 'vitest';
import {
  executeRecipe,
  type ExecutionContext,
  type ExecutionResult,
  type IngredientExecutor,
} from '@recued/engine';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

const METADATA = {
  name: 'D-159 Checkpoint Fidelity',
  description: 'Pure continuation checkpoint test',
  author: 'test',
  supported_platforms: ['test'],
};

const VARIABLES = {
  seed: 'alpha',
  plan: 'pro',
};

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: { entity_id: 'case-42' },
  meta: {},
  step: {},
});

const noopIngredientExecutor: IngredientExecutor = async () => null;

const makeRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'd-159-checkpoint-fidelity',
  version: 1,
  ttl: 300,
  metadata: METADATA,
  variables: VARIABLES,
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const makeCtx = (
  recipe: RecipeDefinition,
  stores: NamespaceStores = baseStores(),
  ingredientExecutor: IngredientExecutor = noopIngredientExecutor,
): ExecutionContext => ({
  recipe,
  stores,
  ingredientExecutor,
});

const asSteps = (steps: Array<Record<string, unknown>>): RecipeStep[] =>
  steps as unknown as RecipeStep[];

const stableStepResults = (result: ExecutionResult): Array<{ id: string; result: unknown }> =>
  result.steps.map((step) => ({ id: step.id, result: structuredClone(step.result) }));

const stableRun = (
  result: ExecutionResult,
  ctx: ExecutionContext,
): { stepResults: Array<{ id: string; result: unknown }>; stepStore: unknown } => ({
  stepResults: stableStepResults(result),
  stepStore: structuredClone(ctx.stores.step),
});

const pureSteps = asSteps([
  {
    id: 's1_seed',
    transform: 'coalesce',
    values: ['{{config.seed}}', 'fallback'],
  },
  {
    id: 's2_label',
    transform: 'concat',
    values: ['{{step.s1_seed}}', '-', '{{context.entity_id}}'],
  },
  {
    id: 's3_payload',
    transform: 'set',
    source: {
      label: '{{step.s2_label}}',
      tags: ['base', '{{step.s1_seed}}'],
    },
    field: 'status',
    value: 'ready',
  },
  {
    id: 's4_tag_count',
    transform: 'count',
    input: '{{step.s3_payload.tags}}',
  },
  {
    id: 's5_summary',
    transform: 'template',
    template: '{{step.s3_payload.label}} has {{step.s4_tag_count}} tags',
  },
]);

const boundarySteps = asSteps([
  {
    id: 'dispatch_payload',
    transform: 'set',
    source: {
      account: '{{context.entity_id}}',
      plan: '{{config.plan}}',
    },
    field: 'request_id',
    value: '{{config.seed}}-request',
  },
  {
    id: 'ingredient_result',
    ingredient: 'fixed-profile-reader',
    input: '{{step.dispatch_payload}}',
  },
  {
    id: 'boundary_summary',
    transform: 'template',
    template: '{{step.ingredient_result.echo.account}}/{{step.ingredient_result.score}}/{{step.ingredient_result.echo.request_id}}',
  },
]);

describe('D-159 I-8 / A.4 -- checkpoint fidelity', () => {
  it('pure transform runs are deterministic across fresh contexts', async () => {
    const recipe = makeRecipe(pureSteps);
    const firstCtx = makeCtx(recipe);
    const secondCtx = makeCtx(recipe);

    expect(firstCtx).not.toBe(secondCtx);
    expect(firstCtx.stores).not.toBe(secondCtx.stores);

    const first = await executeRecipe(firstCtx);
    const second = await executeRecipe(secondCtx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(stableRun(first, firstCtx)).toEqual(stableRun(second, secondCtx));
  });

  it('resumes a pure tail from a cloned ctx.stores checkpoint', async () => {
    const fullCtx = makeCtx(makeRecipe(pureSteps));
    const full = await executeRecipe(fullCtx);
    expect(full.success).toBe(true);

    const headSteps = pureSteps.slice(0, 3);
    const tailSteps = pureSteps.slice(3);
    const headCtx = makeCtx(makeRecipe(headSteps));
    const head = await executeRecipe(headCtx);
    expect(head.success).toBe(true);

    const checkpoint = structuredClone(headCtx.stores);
    const tailCtx = makeCtx(makeRecipe(tailSteps), structuredClone(checkpoint));

    // Fresh context identity means any engine-side WeakMaps/internal state
    // are fresh; only the cloned stores seed the continuation.
    expect(tailCtx).not.toBe(headCtx);
    expect(tailCtx.stores).not.toBe(headCtx.stores);
    expect(tailCtx.stores).not.toBe(checkpoint);

    const tail = await executeRecipe(tailCtx);
    expect(tail.success).toBe(true);

    expect(stableStepResults(head)).toEqual(stableStepResults(full).slice(0, 3));
    expect(stableStepResults(tail)).toEqual(stableStepResults(full).slice(3));
    expect(tailCtx.stores.step).toEqual(fullCtx.stores.step);
  });

  it('resumes across an ingredient boundary using only the checkpointed step store', async () => {
    const calls: Array<{ slug: string; input: Record<string, unknown> }> = [];
    const ingredientExecutor: IngredientExecutor = async (slug, input) => {
      calls.push({ slug, input: structuredClone(input) });
      if (slug !== 'fixed-profile-reader') return null;
      return {
        slug,
        echo: structuredClone(input),
        score: 17,
        tags: ['stable', 'fixture'],
      };
    };

    const fullCtx = makeCtx(makeRecipe(boundarySteps), baseStores(), ingredientExecutor);
    const full = await executeRecipe(fullCtx);
    expect(full.success).toBe(true);

    const headCtx = makeCtx(makeRecipe(boundarySteps.slice(0, 1)), baseStores(), ingredientExecutor);
    const head = await executeRecipe(headCtx);
    expect(head.success).toBe(true);

    const checkpoint = structuredClone(headCtx.stores);
    const resumeCalls: Array<{ slug: string; input: Record<string, unknown> }> = [];
    const resumeIngredientExecutor: IngredientExecutor = async (slug, input) => {
      resumeCalls.push({ slug, input: structuredClone(input) });
      if (slug !== 'fixed-profile-reader') return null;
      return {
        slug,
        echo: structuredClone(input),
        score: 17,
        tags: ['stable', 'fixture'],
      };
    };
    const resumeCtx = makeCtx(
      makeRecipe(boundarySteps.slice(1)),
      structuredClone(checkpoint),
      resumeIngredientExecutor,
    );

    // Re-instantiation is a fresh ExecutionContext object with fresh
    // internal identity; the cloned stores are the entire checkpoint.
    expect(resumeCtx).not.toBe(headCtx);
    expect(resumeCtx.stores).not.toBe(headCtx.stores);
    expect(resumeCtx.stores).not.toBe(checkpoint);

    const resumed = await executeRecipe(resumeCtx);
    expect(resumed.success).toBe(true);

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toEqual({
      slug: 'fixed-profile-reader',
      input: (checkpoint.step as Record<string, unknown>).dispatch_payload,
    });
    expect(calls).toHaveLength(1);
    expect(stableStepResults(head)).toEqual(stableStepResults(full).slice(0, 1));
    expect(stableStepResults(resumed)).toEqual(stableStepResults(full).slice(1));
    expect(resumeCtx.stores.step).toEqual(fullCtx.stores.step);
  });
});
