import { RpcError, parseRecipeRegressionSuite, regressionBytes, regressionJson, RECIPE_REGRESSION_LIMITS,
  type RecipeDefinition, type RecipeRegressionAssertion, type RecipeRegressionAssertionResult, type RecipeRegressionComparison,
  type RecipeRegressionSide, type RecipeRegressionStepChange, type RecipeRegressionSuite,
  type RecipeSimulationResult, type SimulatedStep } from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';
import { simulateRecipe } from './recipe-simulation.js';

export const normalizeRegressionRecipe = (raw: unknown): RecipeDefinition => {
  const parsed = parseRecipe(structuredClone(raw));
  if (!parsed.ok) throw new RpcError('bad_request',parsed.issues.map(issue => issue.message).join('\n'),400);
  return parsed.recipe;
};
export const normalizeRecipeRegressionSuite = (raw: unknown): RecipeRegressionSuite =>
  parseRecipeRegressionSuite(raw,normalizeRegressionRecipe);
const canonical = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
const check = (assertion: RecipeRegressionAssertion, simulation: RecipeSimulationResult, index: number,
  retain: (value: unknown) => void): RecipeRegressionAssertionResult => {
  let actual: unknown, present = true;
  if (assertion.kind === 'run_status') actual = simulation.status;
  else {
    const step = simulation.steps.find(item => item.id === assertion.step_id && item.phase === assertion.phase);
    present = step !== undefined;
    if (assertion.kind === 'step_status') actual = step?.status;
    else {
      actual = step?.[assertion.field]; present = present && step !== undefined && Object.hasOwn(step,assertion.field) && actual !== undefined;
      for (const key of assertion.path) {
        if (!present || actual === null || typeof actual !== 'object' || !Object.hasOwn(actual,key)) { present = false; actual = undefined; break; }
        actual = Reflect.get(actual,key); present = actual !== undefined;
      }
      if (assertion.kind === 'exists') { actual = present; present = step !== undefined; }
    }
  }
  const passed = present && canonical(actual) === canonical(assertion.expected);
  const message = passed ? 'Check passed.' : present ? 'The value differs from the expected value.' : 'The expected step or value is missing.';
  retain({ index,passed,present,actual: present ? actual : null,message });
  return { index,passed,present,actual: present ? regressionJson(actual) : null,message };
};
const side = (simulation: RecipeSimulationResult, assertions: RecipeRegressionAssertion[],retain: (value: unknown) => void): RecipeRegressionSide => {
  const results = assertions.map((assertion,index) => check(assertion,simulation,index,retain));
  return { simulation, assertions: results, passed: results.every(result => result.passed) };
};
const changes = (baseline: RecipeSimulationResult, candidate: RecipeSimulationResult): RecipeRegressionStepChange[] => {
  const key = (step: SimulatedStep): string => JSON.stringify([step.phase,step.id]);
  const indexed = (steps: SimulatedStep[]) => {
    const positions = { trigger: 0,prefetch: 0,sequential: 0 };
    return new Map(steps.map(step => [key(step),{ step,position: positions[step.phase]++ }]));
  };
  const old = indexed(baseline.steps), current = indexed(candidate.steps);
  const result: RecipeRegressionStepChange[] = [];
  for (const id of new Set([...old.keys(),...current.keys()])) {
    const before = old.get(id)?.step, after = current.get(id)?.step, step = after ?? before!;
    const fields: RecipeRegressionStepChange['fields'] = [];
    for (const field of ['operation','status','input','output','message','mocked'] as const) if (canonical(before?.[field]) !== canonical(after?.[field])) fields.push(field);
    if (before && after && old.get(id)!.position !== current.get(id)!.position) fields.push('position');
    if (!before || !after || fields.length) result.push({ phase: step.phase, step_id: step.id,
      kind: !before ? 'added' : !after ? 'removed' : 'changed', fields });
  }
  return result;
};
/** Closed fixture executor only. No provider, warehouse, gate or writer can be
 * supplied; both recipes are copied and use the exact same saved case inputs. */
export const runRecipeRegression = async (rawSuite: RecipeRegressionSuite, rawCandidate: RecipeDefinition,
  signal?: AbortSignal): Promise<RecipeRegressionComparison> => {
  signal?.throwIfAborted();
  const suite = normalizeRecipeRegressionSuite(rawSuite), candidate = normalizeRegressionRecipe(rawCandidate);
  if (candidate.recipe_id !== suite.baseline.recipe_id) throw new RpcError('bad_request','Compare versions of the same recipe.',400);
  const result: RecipeRegressionComparison = { cases: [], passed: 0, failed: 0, changed: 0 };
  let retained = 128;
  for (const test of suite.cases) {
    signal?.throwIfAborted();
    const before = await simulateRecipe(suite.baseline,test.sample,signal);
    signal?.throwIfAborted();
    const after = await simulateRecipe(candidate,test.sample,signal);
    signal?.throwIfAborted();
    let building = retained;
    const retain = (value: unknown): void => {
      building += regressionBytes(value);
      if (building > RECIPE_REGRESSION_LIMITS.result_bytes) throw new RpcError('bad_request','Suite results exceed 4 MB. Use fewer cases or smaller outputs.',400);
    };
    // Charge traces and each assertion BEFORE copying its actual value. Repeated
    // whole-output checks must not allocate an unbounded temporary result.
    retain(before); retain(after);
    const entry = { case_id: test.id, name: test.name, baseline: side(before,test.assertions,retain), candidate: side(after,test.assertions,retain), changes: changes(before,after) };
    retained += regressionBytes(entry);
    if (retained > RECIPE_REGRESSION_LIMITS.result_bytes) throw new RpcError('bad_request','Suite results exceed 4 MB. Use fewer cases or smaller outputs.',400);
    result.cases.push(entry);
    if (entry.candidate.passed) result.passed++; else result.failed++;
    if (entry.changes.length) result.changed++;
  }
  return result;
};
