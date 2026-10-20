import { expect, it } from 'vitest';
import { parseRecipeRegressionCases, parseRecipeRegressionAssertion, parseRecipeRegressionSuite } from '../recipe-regression.js';
import type { RecipeDefinition } from '../recipe.js';
const testCase = () => ({ id: 'empty',name: 'Empty list',sample: { config: { rows: [] } },assertions: [{ kind: 'run_status',expected: 'passed' }] });
it('copies valid case inputs and preserves each closed assertion variant',() => {
  const value = testCase(), cases = parseRecipeRegressionCases([value]); value.sample.config.rows.length = 2;
  expect(cases[0]!.sample).not.toBe(value.sample);
  expect(cases[0]!.sample.config!.rows).toEqual([]);
  for (const check of [
    { kind: 'run_status',expected: 'failed' },
    { kind: 'step_status',phase: 'trigger',step_id: 'gate',expected: 'skipped' },
    { kind: 'value',phase: 'prefetch',step_id: 'read',field: 'output',path: ['0','total'],expected: null },
    { kind: 'exists',phase: 'sequential',step_id: 'write',field: 'input',path: ['missing'],expected: false },
  ]) expect(parseRecipeRegressionAssertion(check)).toEqual(check);
});
it.each([
  [],Array.from({ length: 26 },(_,index) => ({ ...testCase(),id: String(index) })),
  [testCase(),testCase()],
  [{ ...testCase(),sample: { records: {} } }],
  [{ ...testCase(),sample: { mocks: { x: { result: 1,error: 'ambiguous' } } } }],
  [{ ...testCase(),sample: { mocks: { x: { iterations: 'wrong' } } } }],
  [{ ...testCase(),assertions: [] }],
  [{ ...testCase(),assertions: [{ kind: 'run_status',expected: 'passed' },{ kind: 'run_status',expected: 'failed' }] }],
  [{ ...testCase(),assertions: Array.from({ length: 65 },() => ({ kind: 'run_status',expected: 'passed' })) }],
  [{ ...testCase(),name: 'x'.repeat(201) }],
].map(raw => ({ raw })))('refuses invalid or unbounded cases %#',({ raw }) => { expect(() => parseRecipeRegressionCases(raw)).toThrow(); });
it.each([
  { kind: 'javascript',code: 'return true' },
  { kind: 'run_status',expected: 'passed',code: 'extra' },
  { kind: 'step_status',phase: 'later',step_id: 'x',expected: 'passed' },
  { kind: 'value',phase: 'sequential',step_id: 'x',field: 'output',path: ['__proto__'],expected: 1 },
  { kind: 'value',phase: 'sequential',step_id: 'x',field: 'output',path: Array(17).fill('a'),expected: 1 },
  { kind: 'exists',phase: 'sequential',step_id: 'x',field: 'output',path: [],expected: 'true' },
  { kind: 'value',phase: 'sequential',step_id: 'x',field: 'output',path: [],expected: Infinity },
])('refuses open-ended checks and unsafe value paths %#',raw => { expect(() => parseRecipeRegressionAssertion(raw)).toThrow(); });
it('bounds suites before parsing recipes and refuses unknown suite fields',() => {
  const definition: RecipeDefinition = { recipe_id: 'test',version: 1,ttl: 0,metadata: { name: 'Test',description: '',author: '',supported_platforms: [] },variables: {},prefetch_steps: [],steps: [],output: { render: [] } };
  expect(() => parseRecipeRegressionSuite({ title: 'Tests',baseline: definition,cases: [{ ...testCase(),sample: { config: { value: 'x'.repeat(1_000_000) } } }] },() => definition)).toThrow('1 MB');
  expect(() => parseRecipeRegressionSuite({ title: 'Tests',baseline: definition,cases: [testCase()],execute: true },() => definition)).toThrow();
});
