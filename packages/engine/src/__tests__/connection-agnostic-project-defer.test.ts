import { describe, expect, it } from 'vitest';
import type {
  ConnectionOperationProfile,
  EntityFieldRow,
  IngredientManifest,
  NamespaceStores,
  OperationRow,
  PackResolutionContext,
  RecipeDefinition,
} from '@recued/contracts';
import { resolveConnectionAgnosticRecipe } from '@recued/recipes';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const operationRow = (
  operation: string,
  httpVerb: 'get',
): OperationRow => {
  const family = operation.slice(0, operation.indexOf('.'));
  return {
    family,
    operation,
    verb: httpVerb,
    surface: 'api',
    binding: {
      kind: 'rest',
      method: 'GET',
      path_template: `/mock/${operation}`,
    },
    risk_tier: 'read',
    approval: 'never',
    groups: [`${family}.read`],
    reviewed: true,
  };
};

const entityField = (
  row: Pick<EntityFieldRow, 'entity' | 'field_path' | 'maps_to' | 'type'> & Partial<EntityFieldRow>,
): EntityFieldRow => ({
  reviewed: true,
  ...row,
});

const HUBSPOT_PACK: PackResolutionContext = {
  pack_slug: 'pack/recued-core/hubspot',
  vendor: 'hubspot',
  connection: 'hubspot1',
  catalog_slug: 'hubspot-full',
  result_path: 'results',
  search_style: 'hubspot_search',
  operation_families: [operationRow('deal.read', 'get')],
  entity_fields: [
    entityField({ entity: 'Deal', maps_to: 'name', field_path: 'properties.dealname', type: 'string' }),
    entityField({ entity: 'Deal', maps_to: 'amount', field_path: 'properties.amount', type: 'number' }),
    entityField({
      entity: 'Deal',
      maps_to: 'key_dates.close_date',
      field_path: 'properties.closedate',
      type: 'datetime',
    }),
  ],
};

const RAW_HUBSPOT_RECORD = {
  id: '5',
  properties: {
    dealname: 'Acme',
    amount: '30000',
    closedate: '1700000000000',
  },
};

const CATALOG_MANIFEST = {
  slug: 'hubspot-full',
  name: 'HubSpot Full',
  description: 'project defer catalog fixture',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'deal.read': {
      operation_id: 'recued-core/hubspot-full.deal.read',
      risk_tier: 'read',
      groups: ['hubspot.deals.read'],
      approval: 'never',
      required_scopes: ['crm.objects.deals.read'],
    },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.hubapi.com',
      auth: { kind: 'none' },
      executes: {
        'deal.read': { kind: 'rest', method: 'GET', path_template: '/crm/v3/objects/deals/{deal_id}' },
      },
    },
  },
} as unknown as IngredientManifest;

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

const canonicalReadRecipe = (): RecipeDefinition => ({
  recipe_id: 'connection-agnostic-project-defer',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'connection-agnostic-project-defer',
    description: 'Project transform item-defer integration test',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'deal',
      op: 'deal.read',
      args: { id: '5' },
    },
  ],
  output: { sidebar: [] },
});

const run = async (recipe: RecipeDefinition) => {
  const gatewayCalls: Array<Record<string, unknown>> = [];
  const ingredientExecutor: IngredientExecutor = async (slug) => {
    if (slug === 'hubspot-full') return { result: RAW_HUBSPOT_RECORD };
    throw new Error(`project defer test: unexpected ingredient '${slug}'`);
  };
  const ctx: ExecutionContext = {
    recipe,
    stores: baseStores(),
    ingredientExecutor,
    manifestGetter: (slug: string) => (slug === 'hubspot-full' ? CATALOG_MANIFEST : null),
    connectionProfileResolver: (): ConnectionOperationProfile => ({
      allowed_operations: ['deal.read'],
      catalog_slug: 'hubspot-full',
    }),
    onGatewayCall: (e) => gatewayCalls.push(e as unknown as Record<string, unknown>),
  };
  const result = await executeRecipe(ctx);
  return { result, gatewayCalls };
};

const stepResult = (result: { steps: Array<{ id: string; result: unknown }> }, id: string): unknown =>
  result.steps.find((s) => s.id === id)?.result;

describe('connection-agnostic project expression defer', () => {
  it('projects a single catalog response record through the real engine without clobbering item refs', async () => {
    const { recipe } = resolveConnectionAgnosticRecipe(canonicalReadRecipe(), HUBSPOT_PACK);

    expect(recipe.steps[1]).toMatchObject({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: {
        name: '{{item.properties.dealname}}',
        amount: '{{item.properties.amount | number}}',
        key_dates: {
          close_date: '{{item.properties.closedate | date_ms}}',
        },
      },
    });

    const { result, gatewayCalls } = await run(recipe);

    expect(result.success).toBe(true);
    expect(gatewayCalls.length).toBeGreaterThanOrEqual(1);
    const projected = stepResult(result, 'deal') as Record<string, unknown>;
    // G2 unify, end-to-end through the real engine: the HubSpot epoch-ms STRING
    // closedate normalizes to a unix-ms NUMBER (the declared `date_ms` type).
    expect(projected).toEqual({
      name: 'Acme',
      amount: 30000,
      key_dates: { close_date: 1700000000000 },
    });
    expect(typeof projected.amount).toBe('number');
    expect(typeof (projected.key_dates as Record<string, unknown>).close_date).toBe('number');
  });
});
