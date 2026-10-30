import { describe, expect, it } from 'vitest';
import { CACHE_FRESHNESS_MODES } from '@recued/contracts';
import { validateRecipe } from '../validate.js';

const base = () => ({ recipe_id: 'cache-test', version: 1, ttl: 60,
  metadata: { name: 'Cache test', author: 'local', supported_platforms: [] }, variables: {},
  prefetch_steps: [{ id: 'read', op: 'core.storage.csv.inspect', args: {} }],
  trigger_steps: [{ id: 'watch', op: 'core.watch.time', args: {} }],
  steps: [{ id: 'result', transform: 'template', template: 'ready' }], output: { render: [{ type: 'text', source: 'step.result' }] } });
const issues = (recipe: unknown) => validateRecipe(recipe).issues.filter(issue => issue.code === 'step_cache_invalid');

describe('literal cache freshness admission', () => {
  it('admits omitted cache and every shared mode in each step phase', () => {
    expect(issues(base())).toEqual([]);
    for (const cache of CACHE_FRESHNESS_MODES) {
      const recipe = base();
      for (const group of ['steps', 'prefetch_steps', 'trigger_steps'] as const) Object.assign(recipe[group][0], { cache });
      expect(issues(recipe)).toEqual([]);
    }
  });
  it('rejects misspellings, expressions and non-string values at the authored cache field', () => {
    for (const cache of ['frehs', '{{config.mode}}', '', null, 0, {}, ['fresh']]) {
      const recipe = base();
      for (const group of ['steps', 'prefetch_steps', 'trigger_steps'] as const) Object.assign(recipe[group][0], { cache });
      expect(issues(recipe).map(issue => issue.path)).toEqual(['steps[0].cache', 'prefetch_steps[0].cache', 'trigger_steps[0].cache']);
    }
  });
  it('ignores API payload and metadata lookalikes', () => {
    const recipe = base(); Object.assign(recipe.steps[0], { payload: { cache: 'frehs' } }); Object.assign(recipe.metadata, { cache: 'frehs' });
    expect(issues(recipe)).toEqual([]);
  });
});
