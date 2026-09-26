/** `pages: "all"` — read a Records search page by page (`StepPages` in contracts).
 *
 *  ⛔ AN IGNORED `pages` IS WORSE THAN NONE. Only the sequential runner carries
 *  it to the gateway, so on a prefetch or trigger step, or a step that runs no
 *  operation, it would read one page while the recipe believed it read all:
 *  the month-end closer's silent 200-row cut again, with a flag on it that says
 *  otherwise. So the validator refuses it wherever it would do nothing.
 */
import { describe, expect, it } from 'vitest';

import { validateRecipe } from '../validate.js';

const SEARCH = 'recued-core.statement-import.line.search';

const base = () => ({
  recipe_id: 'pages-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Pages Test',
    description: 'Reads every page of a Records search.',
    author: 'recued',
    supported_platforms: ['test'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [] as Array<Record<string, unknown>>,
  steps: [] as Array<Record<string, unknown>>,
  output: { sidebar: [] },
});

const pagesIssues = (recipe: ReturnType<typeof base>): string[] =>
  validateRecipe(recipe).issues.filter((i) => i.code.startsWith('step_pages_')).map((i) => i.code);

describe('validateStepPages', () => {
  it('accepts "all" on the step that runs the search, as an op step or a lowered one', () => {
    const recipe = base();
    recipe.steps.push({ id: 'lines', op: SEARCH, args: { limit: 200 }, pages: 'all' });
    recipe.steps.push({ id: 'lowered', ingredient: 'statement-import', input: { operation: 'line.search' }, pages: 'all' });
    expect(pagesIssues(recipe)).toEqual([]);
  });

  it('refuses any other value', () => {
    for (const pages of ['every', true, 5, null]) {
      const recipe = base();
      recipe.steps.push({ id: 'lines', op: SEARCH, args: { limit: 200 }, pages });
      expect(pagesIssues(recipe), JSON.stringify(pages)).toEqual(['step_pages_invalid']);
    }
  });

  it('⛔ refuses it on a step that runs no operation, where it would read nothing', () => {
    const recipe = base();
    recipe.steps.push({ id: 'shape', transform: 'default', value: '{{config.x}}', fallback: null, pages: 'all' });
    recipe.steps.push({ id: 'check', guard: '{{step.shape}} is_null', pages: 'all' });
    expect(pagesIssues(recipe)).toEqual(['step_pages_without_operation', 'step_pages_without_operation']);
  });

  it('⛔ refuses it on a prefetch or trigger step, where it would read one page', () => {
    const prefetching = base();
    prefetching.prefetch_steps.push({ id: 'lines', op: SEARCH, args: { limit: 200 }, pages: 'all' });
    expect(pagesIssues(prefetching)).toEqual(['step_pages_not_sequential']);

    const reactive = { ...base(), trigger_steps: [{ id: 'watch', op: 'core.watch.time', args: {}, pages: 'all' }] };
    expect(pagesIssues(reactive)).toEqual(['step_pages_not_sequential']);
  });
});
