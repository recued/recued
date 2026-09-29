import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../index.js';

/** `stop_when` ends the run, as a success, after a sequential step. The validator
 *  checks its condition like `fail_on`'s and refuses it wherever it would silently
 *  do nothing. */

const recipe = (over: Record<string, unknown>) => ({
  recipe_id: 'probe',
  version: 1,
  metadata: { name: 'p', description: 'd', author: 'a', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
  ...over,
});

type Issue = { severity: string; code: string; path: string };

/** Every finding about a `stop_when` field, as `severity code path`. */
const stopIssues = (r: Record<string, unknown>): string[] =>
  (validateRecipe(r).issues as Issue[])
    .filter((i) => i.path.endsWith('.stop_when'))
    .map((i) => `${i.severity} ${i.code} ${i.path}`);

describe('stop_when — validation', () => {
  it('accepts it on a sequential step, in string or object form', () => {
    expect(stopIssues(recipe({
      steps: [
        { id: 'n', transform: 'count', input: [], stop_when: '{{step.n}} equal 0' },
        { id: 'm', transform: 'count', input: [], stop_when: { field: '{{step.m}}', operator: 'equal', value: 0 } },
      ],
    }))).toEqual([]);
  });

  it('checks the condition the way it checks fail_on', () => {
    expect(stopIssues(recipe({
      steps: [{ id: 'n', transform: 'count', input: [], stop_when: '{{step.n}} roughly 0' }],
    }))).toEqual(['error condition_operator_invalid steps[0].stop_when']);
  });

  it('refuses it on a prefetch step and on a trigger step, where it would do nothing', () => {
    expect(stopIssues(recipe({
      prefetch_steps: [{ id: 'p', ingredient: 'deal-reader', input: {}, stop_when: '{{step.p}} is_empty' }],
    }))).toEqual(['error stop_when_not_sequential prefetch_steps[0].stop_when']);
    expect(stopIssues(recipe({
      auto_run: { interval: '5m' },
      trigger_steps: [
        { id: 't', transform: 'default', value: { should_run: true }, stop_when: '{{trigger.t}} is_null' },
      ],
    }))).toEqual(['error stop_when_not_sequential trigger_steps[0].stop_when']);
  });

  it('refuses an {{item.*}} ref: it is decided once, after a foreach, with no item bound', () => {
    expect(stopIssues(recipe({
      steps: [
        { id: 'rows', transform: 'default', value: [] },
        { id: 'each', transform: 'default', value: '{{item}}', foreach: '{{step.rows}}', stop_when: '{{item.done}} equal true' },
      ],
    }))).toEqual(['error stop_when_item_ref steps[1].stop_when']);
  });
});
