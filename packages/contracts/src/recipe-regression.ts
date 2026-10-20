import type { RecipeDefinition } from './recipe.js';
import type { RecipeSimulationInput, RecipeSimulationResult, SimulatedStep } from './recipe-simulation.js';
import { RpcError } from './rpc/types.js';

export const RECIPE_REGRESSION_LIMITS = /* @__PURE__ */ Object.freeze({ cases: 25, assertions: 64, versions: 20,
  suite_bytes: 1_000_000, result_bytes: 4_000_000, retained_bytes: 32_000_000, suites: 100, run_ms: 60_000 });
export type RegressionJson = null | boolean | number | string | RegressionJson[] | { [key: string]: RegressionJson };
export type RegressionPhase = SimulatedStep['phase'];
interface StepTarget { phase: RegressionPhase; step_id: string }
interface ValueTarget extends StepTarget { field: 'input' | 'output'; path: string[] }
export type RecipeRegressionAssertion =
  | { kind: 'run_status'; expected: RecipeSimulationResult['status'] }
  | (StepTarget & { kind: 'step_status'; expected: SimulatedStep['status'] })
  | (ValueTarget & { kind: 'value'; expected: RegressionJson })
  | (ValueTarget & { kind: 'exists'; expected: boolean });
export interface RecipeRegressionCase { id: string; name: string; sample: RecipeSimulationInput; assertions: RecipeRegressionAssertion[] }
export interface RecipeRegressionSuite { title: string; baseline: RecipeDefinition; cases: RecipeRegressionCase[] }
export interface RecipeRegressionVersion {
  recipe_id: string; revision: number; digest: string; created_at: number; suite: RecipeRegressionSuite;
}
export interface RecipeRegressionHistory {
  head_revision: number; versions: Array<{ revision: number; digest: string; created_at: number }>;
}
export interface RecipeRegressionRead extends RecipeRegressionHistory { version: RecipeRegressionVersion | null }
export interface RecipeRegressionSave { recipe_id: string; expected_revision: number; request_id: string; suite: RecipeRegressionSuite }
export interface RecipeRegressionDelete { recipe_id: string; expected_revision: number; request_id: string }
export interface RecipeRegressionRun { recipe_id: string; revision: number; run_id: string; candidate: RecipeDefinition }
export interface RecipeRegressionAssertionResult { index: number; passed: boolean; present: boolean; actual: RegressionJson; message: string }
export interface RecipeRegressionSide {
  passed: boolean; simulation: RecipeSimulationResult; assertions: RecipeRegressionAssertionResult[];
}
export interface RecipeRegressionStepChange {
  phase: RegressionPhase; step_id: string; kind: 'added' | 'removed' | 'changed';
  fields: Array<'operation' | 'status' | 'input' | 'output' | 'message' | 'mocked' | 'position'>;
}
export interface RecipeRegressionCaseResult {
  case_id: string; name: string; baseline: RecipeRegressionSide; candidate: RecipeRegressionSide; changes: RecipeRegressionStepChange[];
}
export interface RecipeRegressionComparison { cases: RecipeRegressionCaseResult[]; passed: number; failed: number; changed: number }
export interface RecipeRegressionResult extends RecipeRegressionComparison {
  recipe_id: string; revision: number; suite_digest: string; baseline_hash: string; candidate_hash: string;
}
export const regressionObject = (value: unknown, keys?: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (keys && Object.keys(value).some(key => !keys.includes(key)))) throw new RpcError('bad_request','Invalid saved recipe test fields.',400);
  return value as Record<string, unknown>;
};
export const regressionText = (value: unknown, label: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new RpcError('bad_request',`Provide ${label} using at most ${max} characters.`,400);
  }
  return value;
};
export const regressionBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? 'null').byteLength;
export const regressionJson = (value: unknown, depth = 0): RegressionJson => {
  if (depth > 32) throw new RpcError('bad_request','Test values are nested too deeply.',400);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => regressionJson(item,depth + 1));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value)
    .map(([key,item]) => [key,regressionJson(item,depth + 1)]));
  throw new RpcError('bad_request','Test values must be JSON.',400);
};
const phaseOf = (value: unknown): RegressionPhase => {
  if (value === 'trigger' || value === 'prefetch' || value === 'sequential') return value;
  throw new RpcError('bad_request','Choose a trigger, prefetch or sequential step.',400);
};
export const parseRecipeRegressionAssertion = (raw: unknown): RecipeRegressionAssertion => {
  const value = regressionObject(raw,['kind','expected','step_id','phase','field','path']);
  if (value.kind === 'run_status') {
    regressionObject(value,['kind','expected']);
    if (value.expected !== 'passed' && value.expected !== 'failed' && value.expected !== 'gated') throw new RpcError('bad_request','Choose an expected recipe status.',400);
    return { kind: value.kind, expected: value.expected };
  }
  const step_id = regressionText(value.step_id,'a step id'), phase = phaseOf(value.phase);
  if (value.kind === 'step_status') {
    regressionObject(value,['kind','expected','step_id','phase']);
    if (value.expected !== 'passed' && value.expected !== 'failed' && value.expected !== 'skipped' && value.expected !== 'blocked') throw new RpcError('bad_request','Choose an expected step status.',400);
    return { kind: value.kind, phase, step_id, expected: value.expected };
  }
  if ((value.kind !== 'value' && value.kind !== 'exists') || (value.field !== 'input' && value.field !== 'output')
    || !Array.isArray(value.path) || value.path.length > 16
    || value.path.some(part => typeof part !== 'string' || part.length > 200 || ['__proto__','constructor','prototype'].includes(part))) {
    throw new RpcError('bad_request','Choose an input or output value and a path of at most 16 field names.',400);
  }
  const path = value.path.map(part => String(part));
  if (value.kind === 'exists') {
    if (typeof value.expected !== 'boolean') throw new RpcError('bad_request','An existence check expects true or false.',400);
    return { kind: value.kind, phase, step_id, field: value.field, path, expected: value.expected };
  }
  return { kind: value.kind, phase, step_id, field: value.field, path, expected: regressionJson(value.expected) };
};
export const parseRecipeRegressionCases = (raw: unknown): RecipeRegressionCase[] => {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > RECIPE_REGRESSION_LIMITS.cases) throw new RpcError('bad_request','Use between one and 25 test cases.',400);
  const ids = new Set<string>();
  return raw.map(item => {
    const value = regressionObject(item,['id','name','sample','assertions']), id = regressionText(value.id,'a case id',100);
    if (ids.has(id)) throw new RpcError('bad_request','Each test case needs a different id.',400);
    ids.add(id);
    const sample = regressionObject(value.sample,['config','context','data','mocks']);
    for (const field of ['config','context','data','mocks']) if (sample[field] !== undefined) regressionObject(sample[field]);
    if (!Array.isArray(value.assertions) || !value.assertions.length || value.assertions.length > RECIPE_REGRESSION_LIMITS.assertions) throw new RpcError('bad_request','Use between one and 64 checks per case.',400);
    const assertions = value.assertions.map(parseRecipeRegressionAssertion);
    if (assertions.filter(check => check.kind === 'run_status').length !== 1) throw new RpcError('bad_request','Each case needs exactly one expected recipe status.',400);
    const snapshot: RecipeSimulationInput = {};
    for (const field of ['config','context','data'] as const) if (sample[field] !== undefined) {
      snapshot[field] = Object.fromEntries(Object.entries(regressionObject(sample[field])).map(([key,item]) => [key,regressionJson(item)]));
    }
    if (sample.mocks !== undefined) snapshot.mocks = Object.fromEntries(Object.entries(regressionObject(sample.mocks)).map(([key,item]) => {
      const mock = regressionObject(item,['result','iterations','error']);
      if (Object.keys(mock).length !== 1) throw new RpcError('bad_request','Each pretend result needs result, iterations or error.',400);
      if (Object.hasOwn(mock,'result')) return [key,{ result: regressionJson(mock.result) }];
      if (Array.isArray(mock.iterations)) return [key,{ iterations: mock.iterations.map(item => regressionJson(item)) }];
      if (typeof mock.error === 'string' && mock.error.length <= 10_000) return [key,{ error: mock.error }];
      throw new RpcError('bad_request','Invalid pretend result.',400);
    }));
    return { id, name: regressionText(value.name,'a test name'), sample: snapshot, assertions };
  });
};
export const parseRecipeRegressionSuite = (raw: unknown, parseDefinition: (value: unknown) => RecipeDefinition): RecipeRegressionSuite => {
  let size: number;
  try { size = regressionBytes(raw); } catch { throw new RpcError('bad_request','Test suites must be JSON.',400); }
  if (size > RECIPE_REGRESSION_LIMITS.suite_bytes) throw new RpcError('bad_request','Keep a saved test version under 1 MB.',400);
  const value = regressionObject(raw,['title','baseline','cases']);
  return { title: regressionText(value.title,'a suite name'), baseline: parseDefinition(value.baseline), cases: parseRecipeRegressionCases(value.cases) };
};
