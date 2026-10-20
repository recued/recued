import { expect,it } from 'vitest';
import { NS,resolveDeep,regressionObject,type NamespaceStores,type RecipeDefinition } from '@recued/contracts';
import { executeRecipe } from '../execute.js';
import { simulateRecipe } from '../recipe-simulation.js';
import { buildRecipeRunCaptureDraft,copyRecipeCaptureJson,redactRecipeCapture,type RecipeRunCaptureInput } from '../recipe-run-capture.js';
import type { IngredientExecutor } from '../types.js';
const recipe = (): RecipeDefinition => ({ recipe_id: 'captured-run',version: 1,ttl: 0,
  metadata: { name: 'Capture',description: 'Fixture capture.',author: 'owner',supported_platforms: [] },variables: { rows: null,flag: true },
  prefetch_steps: [],steps: [{ id: 'read',ingredient: 'capture-reader',input: { rows: '{{config.rows}}' } },
    { id: 'count',transform: 'count',input: '{{step.read}}' }],output: { render: [] } });
const run = async (definition = recipe(),executor: IngredientExecutor = async (_slug,input) => input.rows) => {
  const stores = Object.fromEntries([...NS].map(key => [key,Object.create(null)])) as NamespaceStores;
  stores.config = { rows: [1,2] };
  stores.vault = { api_key: 'vault-never-copied' }; stores.connection = { secret: 'connection-never-copied' };
  let input: RecipeRunCaptureInput | undefined;
  const result = await executeRecipe({ recipe: definition,stores,ingredientExecutor: (slug,args,...rest) => executor(slug,regressionObject(resolveDeep(args,stores)),...rest),
    onTestCaptureInput: value => { input = copyRecipeCaptureJson(value); } });
  if (!input) throw new Error('Capture hook was not reached'); return { input,result,stores };
};
it('captures effective defaults and creates closed fixtures without a vault or connection namespace',async () => {
  const observed = await run(), draft = await buildRecipeRunCaptureDraft('case-1',observed.input,observed.result);
  expect(draft.case.sample.config).toEqual({ rows: [1,2],flag: true }); expect(JSON.stringify(draft)).not.toContain('never-copied');
  expect(draft.case.sample.mocks).toEqual({ read: { result: [1,2] } }); expect(draft.replay_matches).toBe(true);
  expect((await simulateRecipe(draft.recipe,draft.case.sample)).steps.map(step => step.output)).toEqual([[1,2],2]);
  expect(draft.case.assertions).toContainEqual(expect.objectContaining({ kind: 'value',step_id: 'read',field: 'input' }));
});
it('records a real ingredient failure as an editable failing expectation without calling it again',async () => {
  let calls = 0; const observed = await run(recipe(),async () => { calls++; throw new Error('Provider is offline'); });
  const draft = await buildRecipeRunCaptureDraft('case-2',observed.input,observed.result);
  expect(calls).toBe(1); expect(draft.case.sample.mocks).toEqual({ read: { error: expect.stringContaining('Provider is offline') } });
  expect(draft.case.assertions[0]).toEqual({ kind: 'run_status',expected: 'failed' }); expect(draft.replay_matches).toBe(true);
});
it('refuses a replay that executes steps the live run stopped before',async () => {
  const definition = recipe(); definition.steps[0]!.stop_when = '{{vault.api_key}} equal vault-never-copied';
  const observed = await run(definition);
  expect(observed.result.steps.map(step => step.id)).toEqual(['read']);
  expect(observed.result.stopped?.step_id).toBe('read');
  await expect(buildRecipeRunCaptureDraft('different-path',observed.input,observed.result)).rejects.toThrow('cannot be reproduced');
});
it('captures an early stop when the fixture reproduces the same execution path',async () => {
  const definition = recipe(); definition.steps[0]!.stop_when = '{{config.flag}} equal true';
  const observed = await run(definition), draft = await buildRecipeRunCaptureDraft('same-path',observed.input,observed.result);
  expect(draft.replay_matches).toBe(true);
  expect(draft.case.assertions).toContainEqual({ kind: 'step_status',phase: 'sequential',step_id: 'count',expected: 'blocked' });
});
it('keeps a successful service result when the recipe fail_on guard rejects it',async () => {
  const definition = recipe(); definition.steps[0]!.fail_on = '{{step.read}} equal bad';
  const observed = await run(definition,async () => 'bad');
  expect(observed.result.steps[0]!.error?.code).toBe('RECIPE_FAIL_ON_TRIGGERED');
  const draft = await buildRecipeRunCaptureDraft('guard-failure',observed.input,observed.result);
  expect(draft.case.sample.mocks?.read).toEqual({ result: 'bad' });
  expect(draft.case.assertions).toContainEqual(expect.objectContaining({ kind: 'value',step_id: 'read',field: 'output',expected: 'bad' }));
  const repaired = structuredClone(draft.recipe); delete repaired.steps[0]!.fail_on;
  expect((await simulateRecipe(repaired,draft.case.sample)).status).toBe('passed');
});
it('records prefetches and complete loop results at the final projected step boundary',async () => {
  const definition = recipe(); definition.prefetch_steps = [{ id: 'prefetch',ingredient: 'reader',input: {} }];
  definition.steps = [{ id: 'loop',ingredient: 'reader',input: { value: '{{item}}' },foreach: '{{config.rows}}' }];
  const observed = await run(definition,async (_slug,input) => input.value ?? [9]);
  const draft = await buildRecipeRunCaptureDraft('case-3',observed.input,observed.result);
  expect(draft.case.sample.mocks?.prefetch).toEqual({ result: [9] });
  expect(draft.case.sample.mocks?.loop).toEqual({ iterations: [1,2] }); expect(draft.replay_matches).toBe(true);
});
it('refuses partial loops and missing external state instead of claiming a complete replay',async () => {
  const definition = recipe(); definition.steps = [{ id: 'loop',ingredient: 'reader',input: {},foreach: '{{config.rows}}' }];
  const partial = await run(definition,async () => { throw new Error('Item failed'); });
  await expect(buildRecipeRunCaptureDraft('partial',partial.input,partial.result)).rejects.toThrow('partially failed loop');
  const observed = await run(); observed.result.steps[1]!.result = 99;
  await expect(buildRecipeRunCaptureDraft('missing',observed.input,observed.result)).rejects.toThrow('cannot be reproduced');
});
it('redacts common credential fields and reports a changed replay after redaction',async () => {
  const definition = recipe(); definition.variables = { password: 'credential-value' };
  definition.steps = [{ id: 'copy',transform: 'coalesce',values: ['{{config.password}}'] }];
  const observed = await run(definition), draft = await buildRecipeRunCaptureDraft('redacted',observed.input,observed.result);
  expect(draft.case.sample.config?.password).toBe('[redacted]'); expect(draft.source_recipe_digest).not.toBe(draft.recipe_digest);
  expect(draft.replay_matches).toBe(false); expect(draft.redactions.length).toBeGreaterThan(0);
  expect(redactRecipeCapture(JSON.parse('{"__proto__":{"api_key":"secret"},"Authorization":"Bearer secret"}')).value)
    .toEqual(JSON.parse('{"__proto__":{"api_key":"[redacted]"},"Authorization":"[redacted]"}'));
  expect({}).not.toHaveProperty('api_key');
});
it('bounds retention, rejects non-JSON data and isolates the snapshot from later mutation',async () => {
  expect(() => copyRecipeCaptureJson({ payload: 'x'.repeat(2_000_001) })).toThrow('2 MB');
  expect(() => copyRecipeCaptureJson({ invalid: Number.NaN })).toThrow('JSON');
  const original = { settings: [1] }, copy = copyRecipeCaptureJson(original); original.settings.push(2); expect(copy.settings).toEqual([1]);
  const observed = await run(); observed.result.awaiting_approval = { gated_step_id: 'read',step_state: {} };
  await expect(buildRecipeRunCaptureDraft('held',observed.input,observed.result)).rejects.toThrow('complete replay');
});
it('does not let a failed observer change a live run',async () => {
  const observed = await run(); const result = await executeRecipe({ recipe: recipe(),stores: observed.stores,
    ingredientExecutor: async (_slug,input) => input.rows,onTestCaptureInput: () => { throw new Error('Capture failed'); } });
  expect(result.success).toBe(true);
});

it('does not qualify a coincidentally matching wall-clock result as a repeatable capture',async () => {
  const definition = recipe(); definition.steps = [{ id: 'past',transform: 'is_past',date: '2020-01-01T00:00:00Z' }];
  const observed = await run(definition);
  await expect(buildRecipeRunCaptureDraft('clock',observed.input,observed.result)).rejects.toThrow('Clock-dependent');
});
