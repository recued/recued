import { describe, expect, it } from 'vitest';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';
import { runStep } from '../step-runner.js';
import type { ExecutionContext } from '../types.js';

const recipe: RecipeDefinition = {
  recipe_id: 'map-defer-item-regression',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Map defer item regression',
    description: 'Regression tests for map expression item deferral',
    author: 'test',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
};

const stores = (overrides: Partial<NamespaceStores> = {}): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
  ...overrides,
});

const ctx = (initialStores: NamespaceStores): ExecutionContext => ({
  recipe,
  stores: initialStores,
  ingredientExecutor: async () => ({}),
});

const runTransform = async (
  context: ExecutionContext,
  step: Record<string, unknown>,
): Promise<unknown> => {
  const log = await runStep(step as unknown as RecipeStep, context);
  expect(log.error).toBeNull();
  return log.result;
};

describe('map expression item deferral integration', () => {
  it('maps object-template expressions with item refs per element', async () => {
    const context = ctx(stores({
      step: {
        deals: [
          { company: 'Acme', amount: 100 },
          { company: 'Beta', amount: 250 },
        ],
      },
    }));

    const result = await runTransform(context, {
      id: 'projected',
      transform: 'map',
      array: '{{step.deals}}',
      expression: {
        company: '{{item.company}}',
        amount: '{{item.amount}}',
      },
    });

    expect(result).toEqual([
      { company: 'Acme', amount: 100 },
      { company: 'Beta', amount: 250 },
    ]);
    expect(context.stores.step.projected).toEqual(result);
  });

  it('fills interpolated item strings after resolving config refs', async () => {
    const context = ctx(stores({
      config: { suffix: 'news last 7 days' },
      step: {
        companies: [
          { company: 'Acme' },
          { company: 'Beta' },
        ],
      },
    }));

    const result = await runTransform(context, {
      id: 'queries',
      transform: 'map',
      array: '{{step.companies}}',
      expression: '{{item.company}} {{config.suffix}}',
    });

    expect(result).toEqual([
      'Acme news last 7 days',
      'Beta news last 7 days',
    ]);
  });

  it('evaluates math expressions that mix item and config refs per element', async () => {
    const context = ctx(stores({
      config: { weight: 4 },
      step: { rows: [{ x: 2 }, { x: 5 }] },
    }));

    const result = await runTransform(context, {
      id: 'weighted',
      transform: 'map',
      array: '{{step.rows}}',
      expression: '{{item.x}} * {{config.weight}}',
    });

    expect(result).toEqual([8, 20]);
  });

  it('narrows nested foreach array refs to the foreach item and rebinds expression refs to map items', async () => {
    const context = ctx(stores({
      step: {
        parents: [
          { id: 'p1', kids: [{ field: 'a' }, { field: 'b' }] },
          { id: 'p2', kids: [{ field: 'c' }] },
        ],
      },
    }));

    const log = await runStep({
      id: 'kid_fields',
      transform: 'map',
      foreach: '{{step.parents}}',
      array: '{{item.kids}}',
      expression: '{{item.field}}',
    } as unknown as RecipeStep, context);

    expect(log.error).toBeNull();
    expect(log.result).toEqual([
      { ok: true, result: ['a', 'b'], item: { id: 'p1', kids: [{ field: 'a' }, { field: 'b' }] } },
      { ok: true, result: ['c'], item: { id: 'p2', kids: [{ field: 'c' }] } },
    ]);
    expect(context.stores.step.kid_fields).toEqual(log.result);
  });

  it('maps item refs outside foreach instead of clobbering the expression', async () => {
    const context = ctx(stores({
      step: { rows: [{ name: 'A' }, { name: 'B' }] },
    }));

    const result = await runTransform(context, {
      id: 'names',
      transform: 'map',
      array: '{{step.rows}}',
      expression: '{{item.name}}',
    });

    expect(result).toEqual(['A', 'B']);
  });

  it('leaves non-map transforms resolving refs normally', async () => {
    const context = ctx(stores({
      config: { stage: 'won' },
      step: {
        deals: [
          { stage: 'won', amount: 100 },
          { stage: 'lost', amount: 50 },
          { stage: 'won', amount: 25 },
        ],
      },
    }));

    const filtered = await runTransform(context, {
      id: 'won_deals',
      transform: 'filter',
      array: '{{step.deals}}',
      field: 'stage',
      operator: 'equal',
      value: '{{config.stage}}',
    });
    expect(filtered).toEqual([
      { stage: 'won', amount: 100 },
      { stage: 'won', amount: 25 },
    ]);

    const grouped = await runTransform(context, {
      id: 'stage_totals',
      transform: 'group_by',
      array: '{{step.deals}}',
      field: 'stage',
      aggregate: {
        count: { operator: 'count' },
        total: { field: 'amount', operator: 'sum' },
      },
    });
    expect(grouped).toEqual([
      { stage: 'won', count: 2, total: 125 },
      { stage: 'lost', count: 1, total: 50 },
    ]);
  });

  it('leaves apply-mode map params unaffected when expression is absent', async () => {
    const context = ctx(stores({
      step: {
        deals: [
          { id: 'a', opened_at: '2026-06-01T00:00:00.000Z' },
          { id: 'b', opened_at: '2026-06-05T00:00:00.000Z' },
        ],
      },
    }));

    const result = await runTransform(context, {
      id: 'aged',
      transform: 'map',
      array: '{{step.deals}}',
      apply: 'date_diff',
      field: 'opened_at',
      to: '2026-06-10T00:00:00.000Z',
      unit: 'days',
      output_field: 'age_days',
    });

    expect(result).toEqual([
      { id: 'a', opened_at: '2026-06-01T00:00:00.000Z', age_days: 9 },
      { id: 'b', opened_at: '2026-06-05T00:00:00.000Z', age_days: 5 },
    ]);
  });

  it('resolves map array and output_field params while deferring only expression item refs', async () => {
    const context = ctx(stores({
      config: { outputField: 'weighted_score', multiplier: 10 },
      step: { rows: [{ score: 2 }, { score: 7 }] },
    }));

    const result = await runTransform(context, {
      id: 'with_weight',
      transform: 'map',
      array: '{{step.rows}}',
      output_field: '{{config.outputField}}',
      expression: '{{item.score}} * {{config.multiplier}}',
    });

    expect(result).toEqual([
      { score: 2, weighted_score: 20 },
      { score: 7, weighted_score: 70 },
    ]);
  });
});
