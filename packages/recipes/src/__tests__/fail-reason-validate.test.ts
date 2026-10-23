import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../index.js';
import { FAIL_REASON_MAX_LENGTH } from '../validate/structural.js';

/** `fail_reason` is the sentence the person who ran the recipe reads when a
 *  `guard` or a `fail_on` stops it. The validator refuses one that would never
 *  be read as written. */

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

/** Every finding about a `fail_reason` field, as `severity code path`. */
const reasonIssues = (r: Record<string, unknown>): string[] =>
  (validateRecipe(r).issues as Issue[])
    .filter((i) => i.path.endsWith('.fail_reason'))
    .map((i) => `${i.severity} ${i.code} ${i.path}`);

describe('fail_reason — validation', () => {
  it('accepts plain words on a guard step and on a step with fail_on', () => {
    expect(reasonIssues(recipe({
      steps: [
        { id: 'rows', transform: 'default', value: [], fail_on: '{{step.rows}} is_null', fail_reason: 'Nothing was read.' },
        { id: 'rows_guard', guard: '{{step.rows}} is_empty', fail_reason: 'There are no rows to work on.' },
      ],
    }))).toEqual([]);
  });

  it('refuses a {{ref}}: it is shown as written', () => {
    expect(reasonIssues(recipe({
      steps: [{ id: 'g', guard: '{{config.x}} is_empty', fail_reason: 'Missing {{config.x}}.' }],
    }))).toEqual(['error fail_reason_ref steps[0].fail_reason']);
  });

  it('refuses one on a step that cannot stop the run', () => {
    expect(reasonIssues(recipe({
      steps: [{ id: 'n', transform: 'count', input: [], stop_when: '{{step.n}} equal 0', fail_reason: 'Nothing new.' }],
    }))).toEqual(['error fail_reason_without_stop steps[0].fail_reason']);
  });

  it('refuses blank or non-text', () => {
    expect(reasonIssues(recipe({
      steps: [
        { id: 'a', guard: '{{config.x}} is_empty', fail_reason: '  ' },
        { id: 'b', guard: '{{config.x}} is_empty', fail_reason: 7 },
      ],
    }))).toEqual([
      'error fail_reason_invalid steps[0].fail_reason',
      'error fail_reason_invalid steps[1].fail_reason',
    ]);
  });

  it(`refuses more than ${FAIL_REASON_MAX_LENGTH} characters`, () => {
    expect(reasonIssues(recipe({
      steps: [{ id: 'g', guard: '{{config.x}} is_empty', fail_reason: 'a'.repeat(FAIL_REASON_MAX_LENGTH + 1) }],
    }))).toEqual(['error fail_reason_too_long steps[0].fail_reason']);
    expect(reasonIssues(recipe({
      steps: [{ id: 'g', guard: '{{config.x}} is_empty', fail_reason: 'a'.repeat(FAIL_REASON_MAX_LENGTH) }],
    }))).toEqual([]);
  });

  it('checks a trigger step too', () => {
    expect(reasonIssues(recipe({
      auto_run: { interval: '5m' },
      trigger_steps: [
        { id: 't', transform: 'default', value: { should_run: true }, fail_reason: 'Not set up.' },
      ],
    }))).toEqual(['error fail_reason_without_stop trigger_steps[0].fail_reason']);
  });
});
