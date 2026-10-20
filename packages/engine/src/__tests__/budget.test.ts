import { afterEach, describe, it, expect, vi } from 'vitest';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { IngredientManifest, LaneGovernor, RecipeDefinition } from '@recued/contracts';

const mkRecipe = (overrides: Partial<RecipeDefinition['metadata']> = {}, steps: RecipeDefinition['steps'] = []): RecipeDefinition => ({
  recipe_id: 'budget-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Budget Test',
    description: 'tests',
    author: 'test',
    supported_platforms: ['test'],
    ...overrides,
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const mkCtx = (recipe: RecipeDefinition, executor: IngredientExecutor): ExecutionContext => ({
  recipe,
  stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
  ingredientExecutor: executor,
});

const fastExecutor: IngredientExecutor = async () => ({ ok: true });

const makeSlowExecutor = (ms: number): IngredientExecutor => async () =>
  new Promise((resolve) => setTimeout(() => resolve({ ok: true }), ms));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('RECIPE_BUDGET_EXCEEDED', () => {
  it.each([0, 1_000])('keeps the host signal scope through exchange delivery for budget %s', async budget_ms => {
    const recipe = mkRecipe({ budget_ms });
    recipe.output = { exchange: { ref: 'fixture-ref', deliver_to: 'fixture/sink' } };
    let active = false; let activeDuringFire: boolean | undefined;
    const result = await executeRecipe({
      ...mkCtx(recipe, fastExecutor),
      withRunAbortSignal: async (_signal, run) => {
        active = true;
        try { return await run(); } finally { active = false; }
      },
      exchangeFireHandler: () => { activeDuringFire = active; },
    });
    expect(result.success).toBe(true);
    expect(activeDuringFire).toBe(true); expect(active).toBe(false);
  });

  it.each([0, 1_000])('scopes ingredient calls with the effective signal for budget %s', async budget_ms => {
    const controller = new AbortController(); const signals: Array<AbortSignal | undefined> = [];
    let laneSignal: AbortSignal | undefined;
    const ctx: ExecutionContext = {
      ...mkCtx(mkRecipe({ budget_ms }, [{ id: 'read', ingredient: 'any', input: {} }]), async () => {
        expect(signals).toHaveLength(1); expect(signals[0]).toBe(laneSignal);
        expect(laneSignal?.aborted).toBe(false); return { ok: true };
      }),
      runAbortSignal: controller.signal,
      withRunAbortSignal: (signal, run) => { signals.push(signal); return run(); },
      laneGovernor: { acquire: async request => {
        laneSignal = request.signal;
        return { lane: null, reportProgress() {}, release() {} };
      } },
    };
    expect((await executeRecipe(ctx)).success).toBe(true);
    expect(signals).toHaveLength(1);
    if (budget_ms === 0) expect(signals[0]).toBe(controller.signal);
    else expect(signals[0]).not.toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  it('cleans up the budget and owner listener when host scope setup throws', async () => {
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const refused = new Error('Fixture scope refused'); vi.useFakeTimers();
    await expect(executeRecipe({
      ...mkCtx(mkRecipe({ budget_ms: 100 }), fastExecutor),
      runAbortSignal: controller.signal,
      withRunAbortSignal: () => { throw refused; },
    })).rejects.toBe(refused);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('runs successfully when elapsed time stays under budget_ms', async () => {
    const recipe = mkRecipe(
      { budget_ms: 2_000 },
      [
        { id: 'fetch', ingredient: 'any', input: {} },
      ],
    );
    const result = await executeRecipe(mkCtx(recipe, fastExecutor));
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('aborts with RECIPE_BUDGET_EXCEEDED when elapsed time crosses budget_ms', async () => {
    const recipe = mkRecipe(
      { budget_ms: 50 },
      [
        { id: 'slow', ingredient: 'any', input: {} },
      ],
    );
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(500)));
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('RECIPE_BUDGET_EXCEEDED');
    expect(result.errors[0].severity).toBe('error');
  });

  it('propagates the budget abort and waits for cooperative cancellation cleanup', async () => {
    const recipe = mkRecipe(
      { budget_ms: 40 },
      [{ id: 'slow', ingredient: 'local-service', input: {} }],
    );
    let runSignal: AbortSignal | undefined;
    let scopeSignal: AbortSignal | undefined;
    let cleanupFinished = false;
    const released: string[] = [];
    const laneGovernor: LaneGovernor = {
      acquire: async (request) => {
        runSignal = request.signal;
        return {
          lane: 'local-heavy',
          reportProgress() {},
          release(outcome) { released.push(outcome); },
        };
      },
    };
    const executor: IngredientExecutor = async () => {
      await new Promise<void>((resolve) => {
        const cleanUp = () => {
          setTimeout(() => {
            cleanupFinished = true;
            resolve();
          }, 30);
        };
        if (runSignal?.aborted) cleanUp();
        else runSignal?.addEventListener('abort', cleanUp, { once: true });
      });
      return { ok: true };
    };
    const ctx: ExecutionContext = {
      ...mkCtx(recipe, executor),
      withRunAbortSignal: (signal, run) => { scopeSignal = signal; return run(); },
      laneGovernor,
      manifestGetter: () => ({ kind: 'cli' }) as IngredientManifest,
    };

    const result = await executeRecipe(ctx);

    expect(result.errors[0].code).toBe('RECIPE_BUDGET_EXCEEDED');
    expect(runSignal?.aborted).toBe(true);
    expect(scopeSignal).toBe(runSignal);
    expect(cleanupFinished).toBe(true);
    expect(released).toEqual(['failed']);
  });

  it('omits enforcement when budget_ms is absent', async () => {
    const recipe = mkRecipe({}, [
      { id: 'slow', ingredient: 'any', input: {} },
    ]);
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(120)));
    expect(result.success).toBe(true);
  });

  it('a recipe with no metadata fails STRICT validation cleanly instead of crashing on budget_ms', async () => {
    // Regression (D-179 live-verification finding): the budget read at the top
    // of `executeRecipe` (`ctx.recipe.metadata?.budget_ms`) runs BEFORE
    // `executeRecipeInner`'s strict validation. Without the optional chain a
    // malformed recipe with no `metadata` threw "Cannot read properties of
    // undefined (reading 'budget_ms')" before validation could emit
    // `metadata_required`. The server execute path is strict — this is its path.
    const recipe = mkRecipe({}, [{ id: 's', ingredient: 'any', input: {} }]);
    delete (recipe as { metadata?: unknown }).metadata;
    const result = await executeRecipe({ ...mkCtx(recipe, fastExecutor), strict: true });
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('RECIPE_VALIDATION_FAILED');
    const issues = (result.errors[0].details as { issues?: Array<{ code: string }> }).issues ?? [];
    expect(issues.map((i) => i.code)).toContain('metadata_required');
  });

  it('a recipe with no metadata never crashes the engine even with validation off', async () => {
    // Defense-in-depth: a non-strict caller (no validation) must still not crash
    // on `undefined` metadata — the budget read + the meta-namespace copy both
    // tolerate it (the run proceeds with an empty meta namespace).
    const recipe = mkRecipe({}, [{ id: 's', ingredient: 'any', input: {} }]);
    delete (recipe as { metadata?: unknown }).metadata;
    const result = await executeRecipe(mkCtx(recipe, fastExecutor));
    expect(result.success).toBe(true);
  });

  it('omits enforcement when budget_ms is zero or negative', async () => {
    const recipe = mkRecipe({ budget_ms: 0 }, [
      { id: 'slow', ingredient: 'any', input: {} },
    ]);
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(100)));
    expect(result.success).toBe(true);
  });

  it('surfaces budget_ms + elapsed_ms in error details for UI / audit', async () => {
    const recipe = mkRecipe(
      { budget_ms: 50 },
      [{ id: 'slow', ingredient: 'any', input: {} }],
    );
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(400)));
    expect(result.errors[0].details).toMatchObject({
      budget_ms: 50,
      elapsed_ms: expect.any(Number),
    });
    const elapsed = (result.errors[0].details as { elapsed_ms: number }).elapsed_ms;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('reports the budget_ms via error message for human-readable traces', async () => {
    const recipe = mkRecipe(
      { budget_ms: 75 },
      [{ id: 'slow', ingredient: 'any', input: {} }],
    );
    const result = await executeRecipe(mkCtx(recipe, makeSlowExecutor(500)));
    expect(result.errors[0].message).toContain('75ms budget');
  });

  it('still races even when a recipe has zero steps — empty recipe is instant', async () => {
    const recipe = mkRecipe({ budget_ms: 500 }, []);
    const result = await executeRecipe(mkCtx(recipe, fastExecutor));
    expect(result.success).toBe(true);
  });

  it('discards a late provider value after owner abort and never advances to the next step', async () => {
    const recipe = mkRecipe({}, [
      { id: 'slow-provider', ingredient: 'remote-read', input: {} },
      { id: 'must-not-run', ingredient: 'second-effect', input: {} },
    ]);
    const controller = new AbortController();
    let releaseProvider!: (value: { ok: true }) => void;
    const provider = new Promise<{ ok: true }>((resolve) => {
      releaseProvider = resolve;
    });
    const calls: string[] = [];
    const execution = executeRecipe({
      ...mkCtx(recipe, async (slug) => {
        calls.push(slug);
        return slug === 'remote-read' ? provider : { should_not_happen: true };
      }),
      runAbortSignal: controller.signal,
    });

    await expect.poll(() => calls).toEqual(['remote-read']);
    controller.abort();
    releaseProvider({ ok: true });
    const result = await execution;

    expect(result.success).toBe(false);
    expect(calls).toEqual(['remote-read']);
    expect(result.steps[0]?.result).toBeNull();
    expect(result.steps[0]?.error?.message).toContain('run killed by the owner');
  });
});
