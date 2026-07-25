/** D-192 Slice 6b — the engine preserves a `container_pick` carrier across the
 *  step seam (mirrors the `cli_failure` carrier path): a work-entity create that
 *  rejects with an ambiguous-container carrier is coded `CONTAINER_PICK_REQUIRED`
 *  (NOT the catch-all NETWORK_ERROR) and its choice set survives onto
 *  `RecipeError.details.container_pick` for `handleExecute` to read. */

import { describe, expect, it } from 'vitest';

import { runStep } from '../step-runner.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { ContainerPickDetail, NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

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
 *  `container_pick` (the shape the work-entity dispatcher attaches). */
const throwingCtx = (container_pick: unknown, message = 'container ambiguous'): ExecutionContext => {
  const executor: IngredientExecutor = async () => {
    throw Object.assign(new Error(message), { container_pick });
  };
  return { recipe: minimalRecipe, stores: makeStores(), ingredientExecutor: executor };
};

const detail: ContainerPickDetail = {
  source_id: 'connection:linear:conn-1',
  kind: 'task',
  dependency_ref: 'team',
  options: [
    { entity_pk: 'team-eng', label: 'Engineering' },
    { entity_pk: 'team-design', label: 'Design' },
  ],
  can_create: false,
};

const createStep = { id: 'task_create', ingredient: 'task-create', input: {} } as unknown as RecipeStep;

describe('runStep — container_pick classification', () => {
  it('a well-formed container_pick carrier → CONTAINER_PICK_REQUIRED + preserved detail', async () => {
    const log = await runStep(createStep, throwingCtx(detail));
    expect(log.error!.code).toBe('CONTAINER_PICK_REQUIRED');
    expect(log.error!.details.container_pick).toEqual(detail);
    expect(log.result).toBeNull();
  });

  it('a malformed carrier (options not an array) is ignored → NETWORK_ERROR, no detail', async () => {
    const log = await runStep(createStep, throwingCtx({ ...detail, options: 'team-eng' }));
    expect(log.error!.code).toBe('NETWORK_ERROR');
    expect(log.error!.details.container_pick).toBeUndefined();
  });

  it('an ordinary throw (no carrier) stays NETWORK_ERROR with no container_pick detail', async () => {
    const log = await runStep(createStep, throwingCtx(undefined, 'plain boom'));
    expect(log.error!.code).toBe('NETWORK_ERROR');
    expect(log.error!.details.container_pick).toBeUndefined();
    expect(log.error!.message).toBe('plain boom');
  });
});
