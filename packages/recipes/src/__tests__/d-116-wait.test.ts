/** D-116 — validator nudges for the `wait` transform.
 *
 *  Locks:
 *    - max bound (WAIT_TRANSFORM_MAX_MS)
 *    - placement-in-trigger_steps rejection
 *    - non-reactive misuse warning
 */

import { describe, it, expect } from 'vitest';
import { validateRecipe } from '../validate.js';
import { WAIT_TRANSFORM_MAX_MS } from '@recued/contracts';

const base = () => ({
  recipe_id: 'wait-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Wait Test',
    description: 'Non-reactive recipe exercising the wait transform.',
    author: 'recued',
    supported_platforms: ['test'],
    tags: ['test', 'wait', 'timing'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [] as Array<Record<string, unknown>>,
  output: { sidebar: [] },
});

const codes = (r: ReturnType<typeof validateRecipe>): string[] => r.issues.map((i) => i.code);

describe('validateWait — max bound', () => {
  it('errors when wait.ms exceeds WAIT_TRANSFORM_MAX_MS', () => {
    const recipe = base();
    recipe.steps.push({ id: 'pause', transform: 'wait', ms: WAIT_TRANSFORM_MAX_MS + 1 });
    const result = validateRecipe(recipe);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('wait_max_exceeded');
  });

  it('accepts wait.ms at or below the max', () => {
    const recipe = base();
    recipe.steps.push({ id: 'p1', transform: 'wait', ms: WAIT_TRANSFORM_MAX_MS });
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('wait_max_exceeded');
  });
});

describe('validateWait — placement', () => {
  it('errors when wait sits inside trigger_steps', () => {
    const recipe = base();
    (recipe as Record<string, unknown>).auto_run = { interval_ms: 60_000 };
    (recipe as Record<string, unknown>).trigger_steps = [
      { id: 'pause', transform: 'wait', ms: 200 },
    ];
    recipe.steps.push({ id: 'done', transform: 'to_list', input: 'ok' });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('wait_inside_trigger_steps');
  });
});

describe('validateWait — non-reactive misuse', () => {
  it('warns when a non-reactive recipe has a long single wait', () => {
    const recipe = base();
    recipe.steps.push({ id: 'pause', transform: 'wait', ms: 6_000 });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('wait_in_non_reactive');
  });

  it('warns when wait is the only step (blocks the sidebar)', () => {
    const recipe = base();
    recipe.steps.push({ id: 'pause', transform: 'wait', ms: 500 });
    const result = validateRecipe(recipe);
    expect(codes(result)).toContain('wait_in_non_reactive');
  });

  it('does not warn for reactive recipes with a short wait', () => {
    const recipe = base();
    (recipe as Record<string, unknown>).auto_run = { interval_ms: 60_000 };
    (recipe as Record<string, unknown>).trigger_steps = [
      { id: 'tick', transform: 'time_elapsed_since', now: 0, window_ms: 60_000 },
    ];
    recipe.steps.push({ id: 'fetch', transform: 'to_list', input: 'data' });
    recipe.steps.push({ id: 'pause', transform: 'wait', ms: 500 });
    const result = validateRecipe(recipe);
    expect(codes(result)).not.toContain('wait_in_non_reactive');
  });
});
