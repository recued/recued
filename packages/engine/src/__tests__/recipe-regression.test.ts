import { expect, it } from 'vitest';
import type { RecipeDefinition, RecipeRegressionSuite, RecipeRegressionAssertion } from '@recued/contracts';
import { runRecipeRegression } from '../recipe-regression.js';
const recipe = (steps: RecipeDefinition['steps']): RecipeDefinition => ({ recipe_id: 'regression',version: 1,ttl: 0,
  metadata: { name: 'Regression',description: 'Fixture comparisons.',author: 'owner',supported_platforms: [] },variables: { rows: null },prefetch_steps: [],steps,output: { render: [] } });
const count = recipe([{ id: 'count',transform: 'count',input: '{{config.rows}}' }]);
const suite = (assertions: RecipeRegressionAssertion[] = []): RecipeRegressionSuite => ({ title: 'Tests',baseline: count,cases: [
  { id: 'empty',name: 'Empty',sample: { config: { rows: [] } },assertions: [{ kind: 'run_status',expected: 'passed' },...assertions] },
  { id: 'two',name: 'Two',sample: { config: { rows: ['a','b'] } },assertions: [{ kind: 'run_status',expected: 'passed' }] },
] });
it('compares actual inputs and outputs using the same saved sample for both versions',async () => {
  const result = await runRecipeRegression(suite([{ kind: 'value',phase: 'sequential',step_id: 'count',field: 'output',path: [],expected: 0 }]),
    recipe([{ id: 'count',transform: 'count',input: [1] }]));
  expect(result).toMatchObject({ passed: 1,failed: 1,changed: 2 });
  expect(result.cases[0]!.baseline.passed).toBe(true);
  expect(result.cases[0]!.candidate.assertions[1]).toMatchObject({ passed: false,present: true,actual: 1 });
  expect(result.cases[0]!.changes).toEqual([{ phase: 'sequential',step_id: 'count',kind: 'changed',fields: ['input','output'] }]);
});
it('reports added and removed steps and never passes an existence assertion on a removed step',async () => {
  const tests = suite([{ kind: 'exists',phase: 'sequential',step_id: 'count',field: 'output',path: ['not_here'],expected: false }]);
  const result = await runRecipeRegression(tests,recipe([{ id: 'replacement',transform: 'count',input: [] }]));
  expect(result.cases[0]!.candidate.passed).toBe(false);
  expect(result.cases[0]!.candidate.assertions[1]).toMatchObject({ passed: false,present: false });
  expect(result.cases[0]!.changes.map(item => item.kind)).toEqual(['removed','added']);
});
it('shows branch changes and checks explicit expected negative outcomes',async () => {
  const baseline = recipe([{ id: 'read',op: 'core.records.list',args: {},skip_when: '{{config.rows}} is_empty' }]);
  const tests: RecipeRegressionSuite = { title: 'Branch',baseline,cases: [{ id: 'skip',name: 'No call',sample: {},assertions: [
    { kind: 'run_status',expected: 'passed' },{ kind: 'step_status',phase: 'sequential',step_id: 'read',expected: 'skipped' },
  ] }] };
  const current = recipe([{ id: 'read',op: 'core.records.list',args: {} }]);
  const result = await runRecipeRegression(tests,current);
  expect(result.cases[0]).toMatchObject({ baseline: { passed: true },candidate: { passed: false } });
  expect(result.cases[0]!.changes[0]!.fields).toContain('status');
  tests.cases[0]!.assertions = [{ kind: 'run_status',expected: 'failed' }];
  expect((await runRecipeRegression(tests,current)).cases[0]!.candidate.passed).toBe(true);
});
it('distinguishes null from missing and compares objects without key-order noise',async () => {
  const baseline = recipe([{ id: 'remote',ingredient: 'catalog-fetch',input: { operation: 'write' } }]);
  const tests: RecipeRegressionSuite = { title: 'Values',baseline,cases: [{ id: 'values',name: 'Values',sample: { mocks: { remote: { result: { b: 2,a: null } } } },assertions: [
    { kind: 'run_status',expected: 'passed' },
    { kind: 'value',phase: 'sequential',step_id: 'remote',field: 'output',path: [],expected: { a: null,b: 2 } },
    { kind: 'value',phase: 'sequential',step_id: 'remote',field: 'output',path: ['a'],expected: null },
    { kind: 'exists',phase: 'sequential',step_id: 'remote',field: 'output',path: ['missing'],expected: false },
  ] }] };
  expect(await runRecipeRegression(tests,baseline)).toMatchObject({ passed: 1,failed: 0,changed: 0 });
  tests.cases[0]!.assertions.push({ kind: 'value',phase: 'sequential',step_id: 'remote',field: 'output',path: ['missing'],expected: null });
  expect((await runRecipeRegression(tests,baseline)).cases[0]!.candidate.assertions.at(-1)).toMatchObject({ passed: false,present: false });
});
it('snapshots cases and recipes before yielding, and cancels without a passing receipt',async () => {
  const tests = suite(), current = structuredClone(count), pending = runRecipeRegression(tests,current);
  tests.cases[0]!.sample.config = { rows: ['later'] }; current.steps[0] = { id: 'count',transform: 'count',input: ['later'] };
  expect((await pending).cases[0]!.candidate.simulation.steps[0]!.output).toBe(0);
  const abort = new AbortController(), cancelled = runRecipeRegression(suite(),count,abort.signal); abort.abort(new Error('Cancelled intentionally'));
  await expect(cancelled).rejects.toThrow('Cancelled intentionally');
});
it('reports reordered steps even when every individual value stays the same',async () => {
  const baseline = recipe(['first','second'].map(id => ({ id,transform: 'count',input: [] })));
  const tests = suite(); tests.baseline = baseline;
  const result = await runRecipeRegression(tests,{ ...baseline,steps: [...baseline.steps].reverse() });
  expect(result.changed).toBe(2);
  expect(result.cases[0]!.changes).toEqual(['first','second'].map(step_id => ({ phase: 'sequential',step_id,kind: 'changed',fields: ['position'] })));
});
it('bounds the total comparison across cases and refuses another recipe identity',async () => {
  const baseline = recipe(['copy','copy_again'].map(id => ({ id,transform: 'coalesce',values: ['{{config.payload}}'] }))); baseline.variables = { payload: '' };
  const tests: RecipeRegressionSuite = { title: 'Bounded',baseline,cases: Array.from({ length: 4 },(_,index) => ({ id: String(index),name: String(index),
    sample: { config: { payload: 'x'.repeat(200_000) } },assertions: [{ kind: 'run_status',expected: 'passed' }] })) };
  await expect(runRecipeRegression(tests,baseline)).rejects.toThrow('4 MB');
  await expect(runRecipeRegression(suite(),{ ...count,recipe_id: 'different' })).rejects.toThrow('same recipe');
});
it('bounds repeated whole-output assertion values while building the result',async () => {
  const baseline = recipe([{ id: 'read',op: 'core.records.list',args: {} }]);
  const tests: RecipeRegressionSuite = { title: 'Repeated values',baseline,cases: [{ id: 'large',name: 'Large',
    sample: { mocks: { read: { result: 'x'.repeat(500_000) } } },assertions: [{ kind: 'run_status',expected: 'passed' },
      ...Array.from({ length: 63 },(): RecipeRegressionAssertion => ({ kind: 'value',phase: 'sequential',step_id: 'read',field: 'output',path: [],expected: null })),
    ] }] };
  await expect(runRecipeRegression(tests,baseline)).rejects.toThrow('4 MB');
});
