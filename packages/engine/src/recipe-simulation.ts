import { NS, resolveDeep, resolveValue, type RecipeDefinition, type RecipeStep, type PrefetchStep, type NamespaceStores } from '@recued/contracts';
import { createPiiLedgerStore } from '@recued/transforms';
import { runStep } from './step-runner.js';
import { runPrefetch } from './prefetch.js';
import { extractDefault } from './execute.js';
import { assignOwnSafe, setNamespaceValue } from './store-safety.js';
import type { ExecutionContext } from './types.js';
import type { RecipeSimulationInput, RecipeSimulationResult, SimulatedStep } from '@recued/contracts';
export type { RecipeSimulationInput, RecipeSimulationResult, SimulatedStep } from '@recued/contracts';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const MAX_SAMPLE_BYTES = 2_000_000;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? 'null').byteLength;
const resultTooLarge = (): Error => new Error('Sample results exceed 2 MB. Use fewer steps or smaller mock outputs.');

/** Runs real step/condition/transform semantics with a closed fixture executor.
 * No connection, catalog, network, warehouse, or exchange dispatcher is accepted.
 * External calls are replaced BEFORE entering runStep, including catalog-fetch.
 */
export const simulateRecipe = async (
  recipe: RecipeDefinition, input: RecipeSimulationInput, signal?: AbortSignal,
): Promise<RecipeSimulationResult> => {
  if (bytes({ recipe, input }) > MAX_SAMPLE_BYTES) throw new Error('Use a sample smaller than 2 MB.');
  for (const key of ['config', 'context', 'data', 'mocks'] as const) {
    if (input[key] !== undefined && !record(input[key])) throw new Error(`${key} must be a JSON object.`);
  }
  // Freeze the sample at invocation: edits during an async test belong to the
  // next test, including objects stored as variable defaults.
  recipe = copy(recipe);
  input = copy(input);
  const stores = Object.fromEntries([...NS].map(key => [key, Object.create(null)])) as NamespaceStores;
  assignOwnSafe(stores.meta, { ...recipe.metadata });
  if (!Object.hasOwn(stores.meta, 'recipe_id')) setNamespaceValue(stores.meta, 'recipe_id', recipe.recipe_id);
  for (const [key, value] of Object.entries(recipe.variables)) setNamespaceValue(stores.config, key, extractDefault(value));
  assignOwnSafe(stores.config, copy(input.config ?? {}));
  assignOwnSafe(stores.context, copy(input.context ?? {}));
  if (!Object.hasOwn(stores.context, 'recipe')) setNamespaceValue(stores.context, 'recipe', {});
  stores.data = copy(input.data ?? {});
  const steps: SimulatedStep[] = [];
  const result: RecipeSimulationResult = { steps, status: 'passed' };
  // A small fixture can be referenced by hundreds of steps. Bound retained
  // trace data before it becomes an oversized RPC reply or browser render.
  let resultBytes = 64;
  const traceBytes = new Map<SimulatedStep, number>();
  const retainTrace = (trace: SimulatedStep): void => {
    const size = bytes(trace) + 1;
    const total = resultBytes - (traceBytes.get(trace) ?? 0) + size;
    if (total > MAX_SAMPLE_BYTES) throw resultTooLarge();
    resultBytes = total;
    traceBytes.set(trace, size);
  };
  const phases = [
    ['trigger', recipe.trigger_steps ?? []],
    ['prefetch', recipe.prefetch_steps ?? []],
    ['sequential', recipe.steps],
  ] as const;
  if (phases.reduce((count, [, list]) => count + list.length, 0) > 1000) throw new Error('Test up to 1,000 steps at a time.');
  const piiLedgerStore = createPiiLedgerStore();
  const missingFixtures = new Map<string, string>();
  let fixtureBytes = 0;
  const copyFixture = (value: unknown): unknown => {
    // Parallel prefetches and foreach iterations retain their results inside
    // the runner before returning a log. Limit copies at that boundary too.
    if (fixtureBytes > MAX_SAMPLE_BYTES) throw resultTooLarge();
    fixtureBytes += bytes(value);
    if (fixtureBytes > MAX_SAMPLE_BYTES) throw resultTooLarge();
    return copy(value);
  };
  const fixtureOutput = (id: string, index: number): unknown => {
    const fixture = Object.hasOwn(input.mocks ?? {}, id) ? input.mocks?.[id] : undefined;
    let message: string;
    if (!record(fixture)) message = `Supply a mock result for step '${id}'.`;
    else if ('error' in fixture && typeof fixture.error === 'string') throw new Error(fixture.error);
    else if ('iterations' in fixture) {
      if (Array.isArray(fixture.iterations) && index < fixture.iterations.length) return copyFixture(fixture.iterations[index]);
      message = `Missing mock for iteration ${index + 1} of '${id}'.`;
    } else if ('result' in fixture) return copyFixture(fixture.result);
    else message = `Mock '${id}' needs result, iterations, or error.`;
    missingFixtures.set(id, message);
    throw new Error(message);
  };
  let stopped = false;
  try {
    for (const [phase, list] of phases) {
      signal?.throwIfAborted();
      if (phase === 'prefetch' && list.length && !stopped) {
        const traces = new Map(list.map(authored => {
          const raw = authored as unknown as Record<string, unknown>;
          const trace: SimulatedStep = {
            id: authored.id, phase, operation: String(raw.op ?? raw.ingredient),
            mocked: true, status: 'passed', input: resolveDeep(raw.args ?? raw.input ?? {}, stores),
          };
          retainTrace(trace);
          steps.push(trace);
          return [authored.id, trace];
        }));
        const prefetchSteps: PrefetchStep[] = list.map(authored => {
          const raw = authored as unknown as Record<string, unknown>;
          return {
            id: authored.id, ingredient: 'kitchen-simulation-fixture', input: raw.args ?? raw.input ?? {},
            ...(raw.skip_when !== undefined ? { skip_when: raw.skip_when } : {}),
            ...(raw.optional !== undefined ? { optional: raw.optional } : {}),
          } as PrefetchStep;
        });
        const logs = await runPrefetch({
          recipe: { ...recipe, prefetch_steps: prefetchSteps }, stores, executionPhase: phase,
          runAbortSignal: signal, piiLedgerStore,
          ingredientExecutor: async (_slug, args, _output, _options, meta) => {
            signal?.throwIfAborted();
            const id = meta!.step_id;
            const trace = traces.get(id)!;
            trace.input = resolveDeep(args, stores);
            return fixtureOutput(id, 0);
          },
        });
        signal?.throwIfAborted();
        for (const log of logs) {
          const trace = traces.get(log.id)!;
          trace.output = log.result;
          trace.message = missingFixtures.get(log.id) ?? log.error?.message ?? log.skip_reason;
          trace.status = log.error || missingFixtures.has(log.id) ? 'failed' : log.skipped ? 'skipped' : 'passed';
          if (trace.status === 'failed') { result.status = 'failed'; stopped = true; }
          retainTrace(trace);
        }
        await new Promise<void>(done => setTimeout(done, 0));
        continue;
      }
      for (const authored of list) {
        signal?.throwIfAborted();
        const raw = authored as unknown as Record<string, unknown>;
        const transform = typeof raw.transform === 'string' ? raw.transform : undefined;
        // These transforms depend on runtime state or deliberate time delays. Fixtures
        // keep tests bounded and avoid presenting missing runtime state as a success.
        const runtimeTransform = transform === 'wait' || transform === 'enrichment-or-fetch'
          || (transform !== undefined && /^(mail_received|file_changed|calendar_|attendee_diff|recipe_succeeded_since|time_|http_changed)/.test(transform))
          || (transform === 'map' && ['wait', 'enrichment-or-fetch'].includes(String(resolveValue(raw.apply, stores))));
        const mocked = typeof raw.op === 'string' || raw.ingredient !== undefined || runtimeTransform;
        const operation = String(raw.op ?? raw.ingredient ?? raw.transform ?? 'guard');
        const trace: SimulatedStep = {
          id: authored.id, phase, operation, mocked, status: stopped ? 'blocked' : 'passed',
          input: null,
        };
        steps.push(trace);
        if (stopped) { trace.message = 'An earlier step stopped this test.'; retainTrace(trace); continue; }
        const calls: unknown[] = [];
        let callBytes = 0;
        let callIndex = 0;
        const ctx: ExecutionContext = {
          recipe, stores, executionPhase: phase, runAbortSignal: signal,
          piiLedgerStore,
          ingredientExecutor: async (_slug, args) => {
            // Let socket cancellation/deadlines arrive during a long mocked
            // foreach as well as between whole steps.
            if (raw.foreach !== undefined) await new Promise<void>(done => setTimeout(done, 0));
            signal?.throwIfAborted();
            if (callBytes > MAX_SAMPLE_BYTES) throw resultTooLarge();
            const resolved = resolveDeep(args, stores);
            callBytes += bytes(resolved);
            if (callBytes > MAX_SAMPLE_BYTES) throw resultTooLarge();
            calls.push(resolved);
            return fixtureOutput(authored.id, callIndex++);
          },
        };
        const inputValue = raw.args ?? raw.input ?? Object.fromEntries(
          Object.entries(raw).filter(([key]) => !['id', 'transform', 'skip_when', 'fail_on'].includes(key)),
        );
        trace.input = resolveDeep(inputValue, stores, { deferItem: true });
        retainTrace(trace);
        // Forward only execution controls; authored connection/catalog fields cannot
        // steer this synthetic ingredient into a special dispatcher.
        const step: RecipeStep = mocked ? {
          id: authored.id, ingredient: 'kitchen-simulation-fixture', input: inputValue,
          ...(raw.skip_when !== undefined ? { skip_when: raw.skip_when } : {}),
          ...(raw.fail_on !== undefined ? { fail_on: raw.fail_on } : {}),
          ...(raw.foreach !== undefined ? { foreach: raw.foreach } : {}),
        } as RecipeStep : authored as RecipeStep;
        try {
          const items = raw.foreach === undefined ? undefined : resolveValue(raw.foreach, stores);
          if (Array.isArray(items) && items.length > 1000) throw new Error('Use at most 1,000 items in a sample loop.');
          const log = await runStep(step, ctx);
          signal?.throwIfAborted();
          trace.output = log.result;
          if (mocked && calls.length) trace.input = raw.foreach !== undefined ? calls : calls[0];
          trace.status = log.error ? 'failed' : log.skipped ? 'skipped' : 'passed';
          trace.message = log.error?.message ?? log.skip_reason;
          // Foreach intentionally continues after item failures in production. Report
          // those failures here even though the enclosing step has no top-level error.
          if (raw.foreach !== undefined && Array.isArray(log.result)
            && log.result.some(item => record(item) && item.ok === false)) {
            trace.status = 'failed';
            trace.message = 'One or more iterations failed; inspect the output.';
          }
          if (trace.status === 'failed') { result.status = 'failed'; stopped = true; }
          if (phase === 'trigger' && !stopped) {
            const out = record(log.result) ? log.result : {};
            const { should_run, ...rest } = out;
            setNamespaceValue(stores.trigger!, authored.id, rest);
            if (log.skipped || should_run !== true) {
              stopped = true;
              result.status = 'gated';
              trace.message = 'Trigger did not qualify; later steps will not run.';
            }
          }
        } catch (error) {
          signal?.throwIfAborted();
          trace.status = 'failed';
          trace.message = error instanceof Error ? error.message : String(error);
          result.status = 'failed';
          stopped = true;
        }
        retainTrace(trace);
        // Let the host process cancellation between steps.
        await new Promise<void>(done => setTimeout(done, 0));
      }
    }
    signal?.throwIfAborted();
    return result;
  } finally {
    piiLedgerStore.dispose();
  }
};
