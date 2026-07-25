import { describe, expect, it } from 'vitest';
import type {
  CompositionIngredient,
  IngredientEntityField,
  PackOperationRow,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';

import { resolveBundledPackRecipes } from '../install-composition.js';

const readBinding = (path = '/v1/deals/{id}') => ({
  kind: 'rest' as const,
  method: 'GET' as const,
  path_template: path,
});

const writeBinding = (path = '/v1/deals/search') => ({
  kind: 'rest' as const,
  method: 'POST' as const,
  path_template: path,
});

const operation = (
  op: 'deal.read' | 'deal.search' | 'deal.create',
  bind: PackOperationRow['bind'],
): PackOperationRow => ({
  op,
  ingredient: 'pipedrive-crm',
  risk: op === 'deal.create' ? 'write' : 'read',
  approval: op === 'deal.create' ? 'ask' : 'never',
  bind,
});

const dealField = (
  field: Pick<IngredientEntityField, 'field_path' | 'maps_to' | 'type'>,
): IngredientEntityField => ({ ...field });

const thirdPartyComposition = (connection = 'pipedrive1'): CompositionIngredient => ({
  schema_version: 1,
  slug: 'pipedrive-crm',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'pipedrive-crm',
      kind: 'http',
      http: {
        base: 'https://api.pipedrive.com',
        connection,
        result_path: 'items',
      },
      entities: {
        Deal: {
          crm_alias: 'deal',
          fields: [
            dealField({ field_path: 'id', maps_to: 'id', type: 'string' }),
            dealField({ field_path: 'data.title', maps_to: 'name', type: 'string' }),
            dealField({ field_path: 'data.stage_name', maps_to: 'stage', type: 'string' }),
            dealField({ field_path: 'data.value', maps_to: 'amount', type: 'number' }),
          ],
        },
      },
    },
  ],
  operations: [
    operation('deal.read', readBinding()),
    operation('deal.search', writeBinding()),
    operation('deal.create', writeBinding('/v1/deals')),
  ],
});

const bundledOpStepRecipe = (
  recipe_id: string,
  op: 'deal.read' | 'deal.search' | 'deal.create',
  args: Record<string, unknown> = {},
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: recipe_id,
    description: 'third-party registry merge test fixture',
    author: 'test',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'deal', op, args } as unknown as RecipeStep,
  ],
  output: { sidebar: [] },
});

const stepById = (recipe: RecipeDefinition, id: string): Record<string, unknown> =>
  recipe.steps.find((step) => step.id === id) as unknown as Record<string, unknown>;

describe('resolveBundledPackRecipes third-party registry merge', () => {
  it('resolves a 3p deal.read op-step with the composition-owned field paths', () => {
    const res = resolveBundledPackRecipes(
      thirdPartyComposition(),
      'pack/acme/pipedrive-crm',
      [bundledOpStepRecipe('pipedrive-deal-read', 'deal.read', { id: '5' })],
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const recipe = res.recipes[0];
    const raw = stepById(recipe, 'deal__raw');
    expect(raw.ingredient).toBe('pipedrive-crm');
    expect(raw.connection).toBe('pipedrive1');
    expect(raw.input).toEqual({
      operation: 'deal.read',
      args: { deal_id: '5' },
    });

    // read returns a SINGLE record → a single-object `project` step (not the
    // search collection `map`), over the bare record (no records-array envelope).
    const projection = stepById(recipe, 'deal');
    expect(projection.transform).toBe('project');
    expect(projection.object).toBe('{{step.deal__raw.result}}');
    expect(projection.expression).toMatchObject({
      id: '{{item.id}}',
      name: '{{item.data.title}}',
      stage: '{{item.data.stage_name}}',
      amount: '{{item.data.value | number}}',
    });
    expect(JSON.stringify(projection.expression)).not.toContain('properties.');
  });

  it('fails closed for 3p deal.search because no vendor search builder is wired', () => {
    const res = resolveBundledPackRecipes(
      thirdPartyComposition(),
      'pack/acme/pipedrive-crm',
      [bundledOpStepRecipe('pipedrive-deal-search', 'deal.search', { limit: 10 })],
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('search-query builder');
  });

  it('resolves a 3p deal.search op-step when the composition declares a search style', () => {
    const composition = thirdPartyComposition();
    composition.ingredients[0].http = {
      ...composition.ingredients[0].http!,
      search_style: 'hubspot_search',
    };

    const res = resolveBundledPackRecipes(
      composition,
      'pack/acme/pipedrive-crm',
      [bundledOpStepRecipe('pipedrive-deal-search', 'deal.search', { limit: 10 })],
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const recipe = res.recipes[0];
    const raw = stepById(recipe, 'deal__raw');
    expect(raw.ingredient).toBe('pipedrive-crm');
    expect(raw.connection).toBe('pipedrive1');
    expect(raw.input).toEqual({
      operation: 'deal.search',
      args: {
        'body.properties': ['id', 'data.title', 'data.stage_name', 'data.value'],
        'body.limit': 10,
      },
    });

    const projection = stepById(recipe, 'deal');
    expect(projection.transform).toBe('map');
    expect(projection.expression).toMatchObject({
      id: '{{item.id}}',
      name: '{{item.data.title}}',
      stage: '{{item.data.stage_name}}',
      amount: '{{item.data.value | number}}',
    });
  });

  it('resolves a 3p deal.create op-step when the composition declares a write style', () => {
    const composition = thirdPartyComposition();
    composition.ingredients[0].http = {
      ...composition.ingredients[0].http!,
      write_style: 'hubspot_properties',
    };

    const res = resolveBundledPackRecipes(
      composition,
      'pack/acme/pipedrive-crm',
      [bundledOpStepRecipe('pipedrive-deal-create', 'deal.create', { name: 'Acme', amount: 30000 })],
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // create resolves to TWO steps: the write body rides the `__raw` fetch (the
    // REQUEST); the op-step id holds a single-object `project` of the RESPONSE record.
    const recipe = res.recipes[0];
    expect(recipe.steps.map((step) => step.id)).toEqual(['deal__raw', 'deal']);
    const raw = stepById(recipe, 'deal__raw');
    expect(raw.ingredient).toBe('pipedrive-crm');
    expect(raw.connection).toBe('pipedrive1');
    expect(raw.input).toEqual({
      operation: 'deal.create',
      args: {
        'body.properties': {
          'data.title': 'Acme',
          'data.value': '30000',
        },
      },
    });
    const projection = stepById(recipe, 'deal');
    expect(projection.transform).toBe('project');
    expect(projection.object).toBe('{{step.deal__raw.result}}');
  });

  it('fails closed for 3p deal.create when write_style is bogus and narrows to undefined', () => {
    const composition = thirdPartyComposition();
    composition.ingredients[0].http = {
      ...composition.ingredients[0].http!,
      write_style: 'bogus' as never,
    };

    const res = resolveBundledPackRecipes(
      composition,
      'pack/acme/pipedrive-crm',
      [bundledOpStepRecipe('pipedrive-deal-create', 'deal.create', { name: 'Acme' })],
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('write_style');
  });

  it('refuses a 3p composition that claims a built-in CRM vendor id', () => {
    const res = resolveBundledPackRecipes(
      thirdPartyComposition('hubspot'),
      'pack/acme/pipedrive-crm',
      [bundledOpStepRecipe('pipedrive-spoof-hubspot-read', 'deal.read', { id: '5' })],
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      expect(JSON.stringify(res.recipes)).not.toContain('{{item.properties.dealname}}');
      return;
    }
    // The spoof merge is refused, so the op-step hard-blocks downstream: the
    // pack's catalog isn't a known catalog vendor (it never borrows HubSpot's
    // first-party field mapping / search builder).
    expect(res.message).toContain('not a known catalog vendor');
  });
});
