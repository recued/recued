/** `metadata.readme` is documentation, not a resolved field.
 *
 *  The reference validator serializes the WHOLE recipe and regexes for
 *  `{{refs}}`, so prose that quotes the language's own syntax was validated as
 *  runtime. `plan-service-day`'s readme explains why the recipe can only plan
 *  today by naming the very expression the language forbids —
 *  `{{step.x.daily.weather_code.{{step.offset}}}}` — and the scanner read that
 *  sentence as a nested template plus an undeclared step ref. The recipe's
 *  logic was correct and its documentation was right; only the gate was wrong.
 *
 *  ⚠ The exclusion is worth exactly as much as the cases it still REJECTS. A
 *  test that only proved readme is ignored would pass just as happily if the
 *  whole check were deleted, so every case below pairs a readme that must be
 *  ignored with the same construct in a real field that must still fail.
 */
import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../index.js';

const recipe = (overrides: Record<string, unknown> = {}) => ({
  recipe_id: 'r',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'R',
    description: 'x',
    author: 'test',
    supported_platforms: [],
    ...(overrides.metadata as Record<string, unknown> ?? {}),
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'a', transform: 'trim', input: 'hello' }],
  output: { render: [{ type: 'json', source: 'step.a' }] },
  ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'metadata')),
});

const errorCodes = (body: Record<string, unknown>): string[] =>
  (parseRecipe(body).issues ?? [])
    .filter((i) => i.severity === 'error')
    .map((i) => i.code);

describe('metadata.readme is prose', () => {
  it('a nested template in the readme is documentation, not an error', () => {
    expect(errorCodes(recipe({
      metadata: {
        readme: 'The language cannot index by a computed value — '
          + '`{{step.x.daily.weather_code.{{step.offset}}}}` is a nested template, '
          + 'which is an error, not a lookup.',
      },
    }))).toEqual([]);
  });

  it('…but the same nested template in a STEP is still rejected', () => {
    // The case the exclusion must still catch. Without this, deleting the whole
    // nested-template check would leave the test above green.
    expect(errorCodes(recipe({
      steps: [
        { id: 'offset', transform: 'trim', input: '0' },
        { id: 'a', transform: 'trim', input: '{{step.x.daily.weather_code.{{step.offset}}}}' },
      ],
    }))).toContain('nested_template');
  });

  it('an undeclared step ref in the readme is an example, not an error', () => {
    expect(errorCodes(recipe({
      metadata: { readme: 'Compute it first: `{{step.no_such_step}}` will not resolve.' },
    }))).toEqual([]);
  });

  it('…but an undeclared step ref in a STEP is still rejected', () => {
    expect(errorCodes(recipe({
      steps: [{ id: 'a', transform: 'trim', input: '{{step.no_such_step}}' }],
    }))).toContain('undeclared_step_ref');
  });

  it('a vault ref in the readme is prose; in a step it is still refused', () => {
    expect(errorCodes(recipe({
      metadata: { readme: 'Recipes may never write `{{vault.api_key}}` — only ingredients may.' },
    }))).toEqual([]);
    expect(errorCodes(recipe({
      steps: [{ id: 'a', transform: 'trim', input: '{{vault.api_key}}' }],
    }))).toContain('vault_ref_in_recipe');
  });

  it('metadata.description stays scanned — a one-liner is a mistake, not an example', () => {
    // The exclusion is `readme` alone, on purpose: readme is the long-form
    // explainer where quoting the language is expected; a description is a
    // summary where a live-looking ref is far more likely to be an error.
    //
    // ⚠ The readme here is load-bearing. Without it the exclusion branch never
    // runs, so this case would pass even if the code dropped the WHOLE metadata
    // block — proven by mutation: `scannable.metadata = {}` left this green
    // until the readme was added. A guard reached through only one branch is
    // untested on the other.
    expect(errorCodes(recipe({
      metadata: {
        readme: 'Prose quoting `{{step.also_no_such_step}}` as an example.',
        description: 'Reads {{step.no_such_step}} and reports it.',
      },
    }))).toContain('undeclared_step_ref');
  });

  it('a readme absent, empty, or non-string changes nothing', () => {
    expect(errorCodes(recipe())).toEqual([]);
    expect(errorCodes(recipe({ metadata: { readme: '' } }))).toEqual([]);
    expect(errorCodes(recipe({ metadata: { readme: 42 } }))).toEqual([]);
  });
});
