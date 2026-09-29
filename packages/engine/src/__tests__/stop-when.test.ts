/** `stop_when` — end the run here, as a SUCCESS, when the condition holds after the
 *  step ran. The counterpart of `fail_on`, which ends it as an error.
 *
 *  It replaces a workaround with a measured cost: 80 shipped recipes repeated one
 *  identical `skip_when` on three or more later steps (485 extra copies, one
 *  recipe 20 times) to stop without failing, and every step added after them had
 *  to remember the guard. */
import { describe, it, expect } from 'vitest';
import { deriveRunYield, type NamespaceStores, type RecipeDefinition, type RecipeStep } from '@recued/contracts';
import { createInMemoryStore } from '@recued/cache';
import { executeRecipe } from '../execute.js';
import { snapshotContextRecipe } from '../context-recipe.js';
import { simulateRecipe } from '../recipe-simulation.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const stores = (over: Partial<NamespaceStores> = {}): NamespaceStores => ({
  vault: {}, config: {}, context: {}, meta: {}, step: {}, ...over,
});

const recipe = (steps: unknown[], over: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'probe',
  version: 1,
  ttl: 3600,
  metadata: { name: 'p', description: 'd', author: 'a', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: steps as RecipeStep[],
  output: { render: [] },
  ...over,
});

const noIngredients: IngredientExecutor = async (slug) => {
  throw new Error(`unexpected ingredient ${slug}`);
};

const ctxFor = (r: RecipeDefinition, s: NamespaceStores = stores()): ExecutionContext =>
  ({ recipe: r, stores: s, ingredientExecutor: noIngredients }) as ExecutionContext;

/** Nothing new: count an empty list and stop on zero. `after` must never run. */
const nothingNew = [
  { id: 'items', transform: 'default', value: [] },
  { id: 'n', transform: 'count', input: '{{step.items}}', stop_when: '{{step.n}} equal 0' },
  { id: 'after', transform: 'default', value: 'ran' },
];

describe('stop_when', () => {
  it('ends the run as a success where it holds; the steps after it do not run', async () => {
    const s = stores();
    const res = await executeRecipe(ctxFor(
      recipe(nothingNew, { output: { render: [{ type: 'text', source: 'step.n' }] } }), s,
    ));
    expect(res.success).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.stopped).toEqual({ step_id: 'n', condition: '{{step.n}} equal 0' });
    expect(res.steps.map((l) => l.id)).toEqual(['items', 'n']);
    expect(res.steps[1]?.stopped).toBe(true);
    expect(Object.hasOwn(s.step as object, 'after')).toBe(false);
    // The output still renders from the steps that ran.
    expect(res.output.render[0]?.data).toBe(0);
  });

  it('lets the run go on when it does not hold', async () => {
    const res = await executeRecipe(ctxFor(recipe([
      { id: 'items', transform: 'default', value: ['a'] },
      { id: 'n', transform: 'count', input: '{{step.items}}', stop_when: '{{step.n}} equal 0' },
      { id: 'after', transform: 'default', value: 'ran' },
    ])));
    expect(res.stopped).toBeUndefined();
    expect(res.steps.map((l) => l.id)).toEqual(['items', 'n', 'after']);
    expect(res.steps.some((l) => l.stopped)).toBe(false);
  });

  it('accepts the object form of a condition', async () => {
    const res = await executeRecipe(ctxFor(recipe([
      { id: 'n', transform: 'count', input: [], stop_when: { field: '{{step.n}}', operator: 'equal', value: 0 } },
      { id: 'after', transform: 'default', value: 'ran' },
    ])));
    expect(res.stopped?.step_id).toBe('n');
  });

  it('loses to fail_on on the same step — a failure wins', async () => {
    const res = await executeRecipe(ctxFor(recipe([
      { id: 'n', transform: 'count', input: [], fail_on: '{{step.n}} equal 0', stop_when: '{{step.n}} equal 0' },
      { id: 'after', transform: 'default', value: 'ran' },
    ])));
    expect(res.success).toBe(false);
    expect(res.errors[0]?.code).toBe('RECIPE_FAIL_ON_TRIGGERED');
    expect(res.stopped).toBeUndefined();
  });

  it('is never checked on a skipped step', async () => {
    // A skipped step stores null, so `is_null` WOULD hold if it were read.
    const res = await executeRecipe(ctxFor(recipe([
      { id: 'n', transform: 'count', input: [], skip_when: '{{config.skip}} equal true', stop_when: '{{step.n}} is_null' },
      { id: 'after', transform: 'default', value: 'ran' },
    ]), stores({ config: { skip: true } })));
    expect(res.stopped).toBeUndefined();
    expect(res.steps.map((l) => l.id)).toEqual(['n', 'after']);
  });

  it('on a foreach step, decides once — after every item ran — from the whole result', async () => {
    const res = await executeRecipe(ctxFor(recipe([
      { id: 'list', transform: 'default', value: [1, 2, 3] },
      { id: 'each', transform: 'default', value: '{{item}}', foreach: '{{step.list}}', stop_when: '{{step.each}} is_not_empty' },
      { id: 'after', transform: 'default', value: 'ran' },
    ])));
    expect(res.stopped?.step_id).toBe('each');
    expect(res.steps.find((l) => l.id === 'each')?.foreach).toEqual({ items: 3, failed: 0 });
    expect(res.steps.map((l) => l.id)).toEqual(['list', 'each']);
  });

  it('still ends the run when the step replays from the L2 cache, which bypasses runStep', async () => {
    const store = createInMemoryStore();
    const statuses: string[] = [];
    const cached = (): ExecutionContext => ({
      ...ctxFor(recipe(nothingNew)),
      stepCache: {
        store,
        ingredientPolicy: () => null,
        onStatus: (status: string, c: { step_id: string }) => statuses.push(`${status}:${c.step_id}`),
      },
    }) as ExecutionContext;
    const first = await executeRecipe(cached());
    expect(first.stopped?.step_id).toBe('n');
    statuses.length = 0;
    const second = await executeRecipe(cached());
    // `n` itself replayed — `runStep` never ran for it, so only the replay path
    // can have ended this run.
    expect(statuses).toContain('hit:n');
    expect(second.stopped?.step_id).toBe('n');
    expect(second.steps.map((l) => l.id)).toEqual(['items', 'n']);
  });

  it('is recorded in the run yield: where the run stopped, and null when it went to the end', async () => {
    const stoppedRun = await executeRecipe(ctxFor(recipe(nothingNew)));
    expect(deriveRunYield(stoppedRun.steps)).toMatchObject({ steps_run: 2, stopped_at: 'n' });
    const fullRun = await executeRecipe(ctxFor(recipe([{ id: 'x', transform: 'default', value: 1 }])));
    expect(deriveRunYield(fullRun.steps).stopped_at).toBeNull();
  });
});

describe('the continuity snapshot of a run that did not reach every step', () => {
  // Every step the snapshot keeps is read through `{{context.recipe.<id>}}`.
  const continuity = (steps: unknown[]) => recipe([
    { id: 'prior', transform: 'default', value: '{{context.recipe.a}} {{context.recipe.skipped}} {{context.recipe.later}}' },
    ...steps,
  ]);

  it('keeps the saved value of a step the run never reached; a skipped step saves null', () => {
    const r = continuity([
      { id: 'a', transform: 'default', value: 'new' },
      { id: 'skipped', transform: 'default', value: 'x' },
      { id: 'later', transform: 'default', value: 'x' },
    ]);
    const { snapshot } = snapshotContextRecipe(r, stores({
      step: { a: 'new', skipped: null },
      context: { recipe: { a: 'old', skipped: 'old', later: 'old' } },
    }));
    // The host replaces the stored snapshot whole, so an omitted `later` would
    // have been erased — and a cursor read through `coalesce` restarts.
    expect(snapshot).toEqual({ a: 'new', skipped: null, later: 'old' });
  });

  it('end to end: a stopped run hands the next run the value it did not reach', async () => {
    let saved: unknown;
    const r = continuity([
      { id: 'a', transform: 'count', input: [], stop_when: '{{step.a}} equal 0' },
      { id: 'later', transform: 'default', value: 'new cursor' },
    ]);
    const res = await executeRecipe({
      ...ctxFor(r),
      contextRecipeSnapshot: { a: 5, later: 'cursor from the last run' },
      onContextRecipeSnapshot: (s) => { saved = s.snapshot; },
    } as ExecutionContext);
    expect(res.stopped?.step_id).toBe('a');
    expect(saved).toEqual({ a: 0, later: 'cursor from the last run' });
  });
});

describe('stop_when in a Kitchen test run', () => {
  it('passes the stopping step, blocks the rest with the reason, and passes the run', async () => {
    const result = await simulateRecipe(recipe(nothingNew), {});
    expect(result.status).toBe('passed');
    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s]));
    expect(byId.n?.status).toBe('passed');
    expect(byId.n?.message).toMatch(/stop_when held/u);
    expect(byId.after?.status).toBe('blocked');
    expect(byId.after?.message).toBe("Step 'n' ended the run (its stop_when held), so this step does not run.");
  });
});
