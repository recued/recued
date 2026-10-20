/** Build a fixture draft from the actual engine result, with no dispatcher. */
import { NS, regressionBytes, regressionJson, type NamespaceStores, type RecipeDefinition,
  type RecipeSimulationInput, type RecipeRegressionAssertion, type RecipeRunCaptureDraft,
  RECIPE_REGRESSION_LIMITS, RECIPE_RUN_CAPTURE_LIMITS } from '@recued/contracts';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';
import type { ExecutionResult } from './types.js';
import { simulateRecipe, recipeSimulationNeedsMock } from './recipe-simulation.js';

export interface RecipeRunCaptureInput { recipe: RecipeDefinition; sample: RecipeSimulationInput }
export const capturedRecipeDigest = (value: unknown): string => 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(value));
/** Copy before the engine can mutate stores; abort boundedly on non-JSON data.
 * Undefined object members are absent, as on the existing JSON wire. */
export const copyRecipeCaptureJson = <T>(input: T): T => {
  let remaining = RECIPE_RUN_CAPTURE_LIMITS.bytes, nodes = 0;
  const charge = (value: string): void => {
    if (value.length > remaining) throw new Error('Capture exceeds 2 MB.');
    remaining -= new TextEncoder().encode(value).byteLength;
    if (remaining < 0) throw new Error('Capture exceeds 2 MB.');
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 50_000 || depth > 32) throw new Error('Capture is too deeply nested or contains too many values.');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { charge(String(value)); return value; }
    if (typeof value === 'string') { charge(JSON.stringify(value)); return value; }
    if (Array.isArray(value)) { if (value.length > 50_000 || value.length > remaining) throw new Error('Capture contains too many values.'); charge('[]' + ','.repeat(value.length)); return value.map(item => item === undefined ? null : visit(item,depth + 1)); }
    if (value && typeof value === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(value))) {
      const entries = Object.entries(value).filter(([,item]) => item !== undefined); charge('{}');
      return Object.fromEntries(entries.map(([key,item]) => { charge(JSON.stringify(key) + ':,'); return [key,visit(item,depth + 1)]; }));
    }
    throw new Error('Capture contains data that cannot be represented as JSON.');
  };
  return visit(input,0) as T;
};
const resultDigest = (value: unknown): string => capturedRecipeDigest(copyRecipeCaptureJson(value ?? null));
const credential = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|private[-_]?key)$/i;
export const redactRecipeCapture = <T>(value: T): { value: T; redactions: string[] } => {
  const redactions: string[] = [];
  const visit = (item: unknown,path: string): unknown => {
    if (Array.isArray(item)) return item.map((next,index) => visit(next,`${path}/${index}`));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key,next]) => {
      const pointer = path + '/' + key.replace(/~/g,'~0').replace(/\//g,'~1');
      if (credential.test(key)) { if (redactions.length < 200) redactions.push(pointer); return [key,'[redacted]']; }
      return [key,visit(next,pointer)];
    }));
    return item;
  };
  return { value: visit(copyRecipeCaptureJson(value),'') as T,redactions };
};
export const buildRecipeRunCaptureDraft = async (captureId: string,input: RecipeRunCaptureInput,
  result: ExecutionResult,signal?: AbortSignal): Promise<RecipeRunCaptureDraft> => {
  if (result.awaiting_approval || result.awaiting_peer || result.trigger_skipped || result.validation_issues.length) {
    throw new Error('Held, skipped and preflight-refused runs do not contain a complete replay.');
  }
  const recipe = input.recipe, sample = input.sample;
  const phases = [['trigger',recipe.trigger_steps ?? []],['prefetch',recipe.prefetch_steps ?? []],['sequential',recipe.steps]] as const;
  // A result matching once does not freeze the wall clock for future tests.
  // Keep V1 honest until simulation has an explicit recorded-clock contract.
  const dynamicDate = (value: unknown): boolean => typeof value === 'string' ? value === 'now' || value.includes('{{')
    : Array.isArray(value) ? value.some(dynamicDate) : !!value && typeof value === 'object' && Object.values(value).some(dynamicDate);
  if (phases.some(([,steps]) => steps.some(step => {
    const raw = step as unknown as Record<string,unknown>, name = raw.transform;
    return name === 'is_past' || name === 'is_future' || name === 'date_from_text'
      || name === 'date_period' && (raw.date === undefined || dynamicDate(raw.date))
      || name === 'date_diff' && dynamicDate([raw.from,raw.to])
      || name === 'date_add' && dynamicDate(raw.date)
      || name === 'map' && (typeof raw.apply === 'string' && raw.apply.includes('{{')
        || ['is_past','is_future','date_from_text','date_period','date_diff','date_add'].includes(String(raw.apply)));
  }))) throw new Error('Clock-dependent date steps need hand-authored cases with fixed dates; this capture cannot promise repeatable replay.');
  const ids = phases.flatMap(([,steps]) => steps.map(step => step.id));
  if (new Set(ids).size !== ids.length || ids.length > 1000) throw new Error('Capture needs unique step IDs across phases and at most 1,000 steps.');
  const stores = Object.fromEntries([...NS].map(key => [key,Object.create(null)])) as NamespaceStores;
  stores.config = sample.config ?? {}; stores.context = sample.context ?? {}; stores.data = sample.data ?? {};
  const mocks: NonNullable<RecipeSimulationInput['mocks']> = Object.create(null);
  for (const [phase,steps] of phases) for (const step of steps) {
    const raw = step as unknown as Record<string,unknown>, log = result.steps.find(item => item.id === step.id);
    if (!log || log.skipped || phase !== 'prefetch' && !recipeSimulationNeedsMock(raw,stores)) continue;
    if (raw.foreach !== undefined) {
      if (!Array.isArray(log.result) || log.result.some(item => !item || typeof item !== 'object' || item.ok !== true)) {
        throw new Error('A partially failed loop needs hand-authored test cases; its real run continues after item errors.');
      }
      mocks[step.id] = { iterations: log.result.filter(item => !item.skipped).map(item => item.result) };
    } else {
      // fail_on runs after a successful service result. Preserve that result so
      // changing the guard can change replay, rather than freezing its rejection
      // into a pretend provider error.
      mocks[step.id] = log.error && log.error.code !== 'RECIPE_FAIL_ON_TRIGGERED'
        ? { error: log.error.message } : { result: log.result ?? null };
    }
  }
  const sourceSample = { ...sample,mocks };
  const replay = await simulateRecipe(recipe,sourceSample,signal);
  const expectedStatus = result.success ? 'passed' : 'failed';
  const observedIds = new Set(result.steps.map(log => log.id));
  if (replay.status !== expectedStatus
    || replay.steps.some(step => step.status !== 'blocked' && !observedIds.has(step.id))
    || result.steps.some(log => {
    const step = replay.steps.find(item => item.id === log.id);
    return !step || step.status !== (log.error ? 'failed' : log.skipped ? 'skipped' : 'passed')
      || !log.skipped && resultDigest(step.output) !== resultDigest(log.result);
  })) throw new Error('The recorded run cannot be reproduced with the available fixtures. Its external state needs a hand-authored case.');
  const assertions: RecipeRegressionAssertion[] = [{ kind: 'run_status',expected: expectedStatus }]; let omitted = 0;
  for (const step of replay.steps) {
    const checks: RecipeRegressionAssertion[] = [{ kind: 'step_status',phase: step.phase,step_id: step.id,expected: step.status }];
    if (step.mocked && (step.status === 'passed' || step.status === 'failed')) checks.push({ kind: 'value',phase: step.phase,step_id: step.id,field: 'input',path: [],expected: regressionJson(copyRecipeCaptureJson(step.input)) });
    if ((step.status === 'passed' || step.status === 'failed') && step.output !== undefined) checks.push({ kind: 'value',phase: step.phase,step_id: step.id,field: 'output',path: [],expected: regressionJson(copyRecipeCaptureJson(step.output)) });
    for (const check of checks) if (assertions.length < RECIPE_REGRESSION_LIMITS.assertions) assertions.push(check); else omitted++;
  }
  const sanitized = redactRecipeCapture({ recipe,case: { id: captureId,name: 'Captured recipe run',sample: sourceSample,assertions } });
  if (regressionBytes(sanitized.value) > RECIPE_RUN_CAPTURE_LIMITS.bytes) throw new Error('The captured test draft exceeds 2 MB.');
  const cleanReplay = await simulateRecipe(sanitized.value.recipe,sanitized.value.case.sample,signal);
  // Redaction can change a real transform result. Report that difference;
  // an imported regression is an owner's expectation, never a passing receipt.
  const matches = cleanReplay.status === replay.status && replay.steps.every(step => {
    const clean = cleanReplay.steps.find(item => item.id === step.id);
    return !!clean && clean.status === step.status && resultDigest(clean.output)
      === resultDigest(redactRecipeCapture(step.output ?? null).value);
  });
  return { recipe: sanitized.value.recipe,recipe_digest: capturedRecipeDigest(sanitized.value.recipe),source_recipe_digest: capturedRecipeDigest(recipe),case: sanitized.value.case,
    redactions: sanitized.redactions,checks_omitted: omitted,replay_matches: matches };
};
