/** D-116 Phase 2 — `on_failure` field.
 *
 *  Covers:
 *    - structural validator (shape, self-loop, config)
 *    - install-time check (handler installed + reactive + has
 *      recipe-watcher)
 *    - failureSourcesFor helper (runtime filter augmentation input)
 */

import { describe, it, expect } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '../validate.js';
import { checkOnFailureInstallable, failureSourcesFor } from '../validate-on-failure.js';

const baseRecipe = (overrides: Partial<RecipeDefinition>): RecipeDefinition => ({
  recipe_id: 'source',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Source Recipe',
    description: 'Exercises the D-116 on_failure binding flow.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'on-failure', 'recipe'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'a', transform: 'to_list', input: 'x' } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
  ...overrides,
});

const mkHandler = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'handler',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Handler',
    description: 'Error handler recipe with a recipe-watcher trigger.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['handler', 'reactive', 'recipe-watcher'],
  },
  variables: {},
  auto_run: { interval_ms: 60_000 },
  trigger_steps: [
    {
      id: 'watch',
      ingredient: 'recipe-watcher',
      input: { kind: 'failed_since', recipe_id: null, since_ms: 0 },
    } as unknown as NonNullable<RecipeDefinition['trigger_steps']>[number],
  ],
  prefetch_steps: [],
  steps: [
    { id: 'done', transform: 'to_list', input: 'ok' } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
  ...overrides,
});

const codes = (r: ReturnType<typeof validateRecipe>): string[] => r.issues.map((i) => i.code);

describe('validateOnFailure — structural', () => {
  it('accepts a well-formed on_failure binding', () => {
    const recipe = baseRecipe({ on_failure: { recipe_id: 'handler' } });
    const result = validateRecipe(recipe);
    expect(codes(result).filter((c) => c.startsWith('on_failure_'))).toEqual([]);
  });

  it('errors when on_failure is not an object', () => {
    const recipe = baseRecipe({ on_failure: 'handler' as unknown as RecipeDefinition['on_failure'] });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('on_failure_shape');
  });

  it('errors when on_failure.recipe_id is missing', () => {
    const recipe = baseRecipe({ on_failure: {} as unknown as RecipeDefinition['on_failure'] });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('on_failure_recipe_id_required');
  });

  it('errors when on_failure.recipe_id points at the recipe itself (self-loop)', () => {
    const recipe = baseRecipe({ on_failure: { recipe_id: 'source' } });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('on_failure_self_loop');
  });

  it('errors when on_failure.config is not an object', () => {
    const recipe = baseRecipe({
      on_failure: {
        recipe_id: 'handler',
        config: 'not-an-object' as unknown as Record<string, unknown>,
      },
    });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('on_failure_config_shape');
  });
});

describe('checkOnFailureInstallable — install-time', () => {
  it('returns null when the recipe has no on_failure binding', () => {
    expect(checkOnFailureInstallable(baseRecipe({}), () => null)).toBeNull();
  });

  it('returns ON_FAILURE_HANDLER_UNKNOWN when the handler is not installed', () => {
    const recipe = baseRecipe({ on_failure: { recipe_id: 'handler' } });
    const issue = checkOnFailureInstallable(recipe, () => null);
    expect(issue?.code).toBe('ON_FAILURE_HANDLER_UNKNOWN');
    expect(issue?.handler_recipe_id).toBe('handler');
  });

  it('returns ON_FAILURE_HANDLER_NOT_REACTIVE when the handler has no trigger_steps', () => {
    const handler = mkHandler({ trigger_steps: undefined, auto_run: undefined });
    const recipe = baseRecipe({ on_failure: { recipe_id: 'handler' } });
    const issue = checkOnFailureInstallable(recipe, (id) => (id === 'handler' ? handler : null));
    expect(issue?.code).toBe('ON_FAILURE_HANDLER_NOT_REACTIVE');
  });

  it('returns ON_FAILURE_HANDLER_MISSING_WATCHER when trigger_steps omits recipe-watcher', () => {
    const handler = mkHandler({
      trigger_steps: [
        {
          id: 'tick',
          transform: 'time_elapsed_since',
          now: 0,
          window_ms: 60_000,
        } as unknown as NonNullable<RecipeDefinition['trigger_steps']>[number],
      ],
    });
    const recipe = baseRecipe({ on_failure: { recipe_id: 'handler' } });
    const issue = checkOnFailureInstallable(recipe, (id) => (id === 'handler' ? handler : null));
    expect(issue?.code).toBe('ON_FAILURE_HANDLER_MISSING_WATCHER');
  });

  it('returns null (installable) for a fully valid handler', () => {
    const handler = mkHandler();
    const recipe = baseRecipe({ on_failure: { recipe_id: 'handler' } });
    const issue = checkOnFailureInstallable(recipe, (id) => (id === 'handler' ? handler : null));
    expect(issue).toBeNull();
  });
});

describe('failureSourcesFor — runtime filter augmentation input', () => {
  it('collects every installed recipe bound to the given handler', () => {
    const installed = [
      baseRecipe({ recipe_id: 'a', on_failure: { recipe_id: 'h' } }),
      baseRecipe({ recipe_id: 'b', on_failure: { recipe_id: 'h' } }),
      baseRecipe({ recipe_id: 'c', on_failure: { recipe_id: 'other' } }),
      baseRecipe({ recipe_id: 'd' }), // no on_failure
    ];
    expect(failureSourcesFor('h', installed).sort()).toEqual(['a', 'b']);
    expect(failureSourcesFor('other', installed)).toEqual(['c']);
    expect(failureSourcesFor('missing', installed)).toEqual([]);
  });
});
