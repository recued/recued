/** D-192 Slice 6c — the engine preserves a `create_plan` carrier across the step
 *  seam (mirrors the `container_pick` carrier path): a work-entity create that
 *  DECIDED to create a named container rejects with a `create_plan` carrier, is
 *  coded `CREATE_PLAN_REQUIRED` (NOT the catch-all NETWORK_ERROR), and its plan
 *  survives onto `RecipeError.details.create_plan` for `handleExecute` to read. */

import { describe, expect, it } from 'vitest';

import { runStep } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { CreatePlanDetail, NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

const minimalRecipe: RecipeDefinition = {
  recipe_id: 'run-ingredient',
  version: 1,
  ttl: 300,
  metadata: { name: 'run', description: 'test', author: 'recued', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};

const makeStores = (): NamespaceStores => ({
  vault: {}, config: {}, context: {}, meta: {}, step: {},
});

/** A ctx whose ingredient executor rejects with `error` carrying the given
 *  `create_plan` (the shape the work-entity dispatcher attaches). */
const throwingCtx = (create_plan: unknown, message = 'create plan required'): ExecutionContext => {
  const executor: IngredientExecutor = async () => {
    throw Object.assign(new Error(message), { create_plan });
  };
  return { recipe: minimalRecipe, stores: makeStores(), ingredientExecutor: executor };
};

const detail: CreatePlanDetail = {
  source_id: 'asana.conn-1.task',
  kind: 'task',
  plans: [
    {
      ref: 'project', create_op: 'project.create', name: 'Roadmap',
      args: { 'body.data': { name: 'Roadmap' } }, result_path: 'data', id_field: 'gid',
    },
  ],
  target_summary: "task 'Ship it'",
};

const createStep = { id: 'task_create', ingredient: 'task-create', input: {} } as unknown as RecipeStep;

describe('runStep — create_plan classification', () => {
  it('a well-formed create_plan carrier → CREATE_PLAN_REQUIRED + preserved detail', async () => {
    const log = await runStep(createStep, throwingCtx(detail));
    expect(log.error!.code).toBe('CREATE_PLAN_REQUIRED');
    expect(log.error!.details.create_plan).toEqual(detail);
    expect(log.result).toBeNull();
  });

  it('a malformed carrier (empty plans) is ignored → NETWORK_ERROR, no detail', async () => {
    const log = await runStep(createStep, throwingCtx({ ...detail, plans: [] }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
    expect(log.error!.details.create_plan).toBeUndefined();
  });

  it('an ordinary throw (no carrier) stays NETWORK_ERROR with no create_plan detail', async () => {
    const log = await runStep(createStep, throwingCtx(undefined, 'plain boom'));
    expect(log.error!.code).toBe('NETWORK_ERROR');
    expect(log.error!.details.create_plan).toBeUndefined();
    expect(log.error!.message).toBe('plain boom');
  });
});
