/** D-201 Slice 10AW (10AS finding 30) — a recipe may leave its `variables` out,
 *  as the validator has always taken it (`variables_shape` checks the field only
 *  when present). The type said it was required, so the engine read it bare:
 *  a recipe saved in Kitchen without it validated, saved, and threw "Cannot
 *  convert undefined or null to object" on every run. Each place the engine
 *  reads it is driven here, with the field absent: the run's start, a filter
 *  section, and an editable and a selectable table. */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { executeRecipe } from '../execute.js';
import { simulateRecipe } from '../recipe-simulation.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const withoutVariables = (render: Array<Record<string, unknown>>): RecipeDefinition => {
  const recipe = {
    recipe_id: 'no-variables', version: 1, ttl: 0,
    metadata: { name: 'No variables', description: 'x', author: 'test', supported_platforms: [] },
    prefetch_steps: [],
    steps: [
      { id: 'greeting', transform: 'template', template: 'hello {{config.name}}' },
      { id: 'rows', ingredient: 'seed', input: {} },
    ],
    output: { render },
  } as unknown as RecipeDefinition;
  expect(Object.hasOwn(recipe, 'variables')).toBe(false);
  return recipe;
};

const run = async (recipe: RecipeDefinition) => {
  const ingredientExecutor: IngredientExecutor = async () => ({ records: [{ id: 'a', label: 'A' }], next_cursor: 'n' });
  const ctx = {
    recipe,
    stores: { vault: {}, config: { name: 'owner' }, context: {}, meta: {}, step: {} },
    ingredientExecutor,
    entityFields: () => [
      { key: 'id', type: 'id', required: true },
      { key: 'label', type: 'string', required: true },
    ],
  } as never as ExecutionContext;
  const result = await executeRecipe(ctx);
  return { result, ctx };
};

const section = (result: Awaited<ReturnType<typeof executeRecipe>>, type: string) =>
  (result.output?.render ?? []).find((s: Record<string, unknown>) => s.type === type) as Record<string, any>;

describe('D-201 Slice 10AW — a recipe without variables runs', () => {
  it('starts, and its config holds only what it was given', async () => {
    const { result, ctx } = await run(withoutVariables([]));
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(ctx.stores.step.greeting).toBe('hello owner');
    expect(ctx.stores.config).toEqual({ name: 'owner' });
  });

  it('renders a filter section, and an editable and a selectable table', async () => {
    const { result } = await run(withoutVariables([
      { type: 'filter', source: 'step.rows', label: 'Filter', fields: [], hidden: ['cursor'], submit: 'Search' },
      { type: 'table', source: 'step.rows', entity: 'required_doc',
        edit: { into: 'rows_in', submit: 'Save', hidden: ['name'] } },
      { type: 'table', source: 'step.rows', entity: 'required_doc',
        select: { into: 'picked', submit: 'Accept', hidden: ['name'] } },
    ]));
    expect(result.success).toBe(true);
    const tables = (result.output?.render ?? []).filter((s: Record<string, unknown>) => s.type === 'table') as Array<Record<string, any>>;
    // Nothing is declared, so nothing hidden is handed on, though config has it.
    expect(tables[0]!.table_edit.hidden).toEqual({});
    expect(tables[1]!.table_select.hidden).toEqual({});
    expect(section(result, 'filter').filter).toMatchObject({ values: {} });
  });

  it('simulates in Kitchen', async () => {
    const simulated = await simulateRecipe(withoutVariables([]), {
      config: { name: 'owner' }, mocks: { rows: { result: [] } },
    });
    expect({ status: simulated.status, steps: simulated.steps.map((step) => [step.id, step.status]) })
      .toEqual({ status: 'passed', steps: [['greeting', 'passed'], ['rows', 'passed']] });
    expect(simulated.steps[0]!.output).toBe('hello owner');
  });
});
