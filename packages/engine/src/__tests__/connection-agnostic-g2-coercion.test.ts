import { describe, expect, it } from 'vitest';
import type {
  ConnectionOperationProfile,
  EntityFieldRow,
  IngredientManifest,
  NamespaceStores,
  OperationRow,
  PackResolutionContext,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';
import { resolveConnectionAgnosticRecipe } from '@recued/recipes';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const operationRow = (
  operation: string,
  httpVerb: 'get' | 'post',
): OperationRow => {
  const family = operation.slice(0, operation.indexOf('.'));
  return {
    family,
    operation,
    verb: httpVerb,
    surface: 'api',
    binding: {
      kind: 'rest',
      method: httpVerb === 'get' ? 'GET' : 'POST',
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
  operation_families: [operationRow('deal.search', 'post')],
  entity_fields: [
    entityField({ entity: 'Deal', maps_to: 'name', field_path: 'properties.dealname', type: 'string' }),
    entityField({ entity: 'Deal', maps_to: 'amount', field_path: 'properties.amount', type: 'number' }),
  ],
};

const RAW_HUBSPOT_RESULT = {
  results: [
    { id: 'low', properties: { dealname: 'Low', amount: '8000' } },
    { id: 'high', properties: { dealname: 'High', amount: '100000' } },
    { id: 'empty', properties: { dealname: 'Empty', amount: '' } },
    { id: 'missing', properties: { dealname: 'Missing' } },
  ],
};

const CATALOG_MANIFEST = {
  slug: 'hubspot-full',
  name: 'HubSpot Full',
  description: 'G2 coercion catalog fixture',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: {
    'deal.search': {
      operation_id: 'recued-core/hubspot-full.deal.search',
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
        'deal.search': { kind: 'rest', method: 'POST', path_template: '/crm/v3/objects/deals/search' },
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

const run = async (recipe: RecipeDefinition) => {
  const gatewayCalls: Array<Record<string, unknown>> = [];
  const ingredientExecutor: IngredientExecutor = async (slug) => {
    // The connection-api dispatch wraps the vendor body as
    // `{ status, headers, result }` and the catalog output keeps it under
    // `.result`, so a catalog op stores `{ result: <vendor body> }` — the
    // resolver reads the records array at `<raw>.result.<result_path>`.
    if (slug === 'hubspot-full') return { result: RAW_HUBSPOT_RESULT };
    throw new Error(`G2 coercion test: unexpected ingredient '${slug}'`);
  };
  const ctx: ExecutionContext = {
    recipe,
    stores: baseStores(),
    ingredientExecutor,
    manifestGetter: (slug: string) => (slug === 'hubspot-full' ? CATALOG_MANIFEST : null),
    connectionProfileResolver: (): ConnectionOperationProfile => ({
      allowed_operations: ['deal.search'],
      catalog_slug: 'hubspot-full',
    }),
    onGatewayCall: (e) => gatewayCalls.push(e as unknown as Record<string, unknown>),
  };
  const result = await executeRecipe(ctx);
  return { result, gatewayCalls };
};

const stepResult = (result: { steps: Array<{ id: string; result: unknown }> }, id: string): unknown =>
  result.steps.find((s) => s.id === id)?.result;

const canonicalRecipe = (): RecipeDefinition => ({
  recipe_id: 'connection-agnostic-g2-coercion',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'connection-agnostic-g2-coercion',
    description: 'G2 numeric coercion integration test',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'deals',
      op: 'deal.search',
      args: { limit: 200 },
    },
    {
      id: 'with_amount',
      transform: 'filter',
      array: '{{step.deals}}',
      field: 'amount',
      operator: 'is_not_null',
    } as unknown as RecipeStep,
  ],
  output: { sidebar: [] },
});

describe('connection-agnostic G2 numeric coercion', () => {
  it('projects string vendor amounts to numbers/nulls; is_not_null excludes the empty-amount record', async () => {
    const { recipe } = resolveConnectionAgnosticRecipe(canonicalRecipe(), HUBSPOT_PACK);

    const { result, gatewayCalls } = await run(recipe);

    expect(result.success).toBe(true);
    expect(gatewayCalls.length).toBeGreaterThanOrEqual(1);

    const projected = stepResult(result, 'deals') as Array<Record<string, unknown>>;
    expect(projected).toEqual([
      { name: 'Low', amount: 8000 },
      { name: 'High', amount: 100000 },
      { name: 'Empty', amount: null },
      { name: 'Missing', amount: null },
    ]);
    expect(typeof projected[0].amount).toBe('number');
    expect(typeof projected[1].amount).toBe('number');
    expect(projected[2].amount).toBeNull();
    expect(projected[3].amount).toBeNull();

    const withAmount = stepResult(result, 'with_amount') as Array<Record<string, unknown>>;
    // The real G2 discriminator: the empty-amount record projects to amount=null,
    // so `is_not_null` EXCLUDES it. WITHOUT coercion the empty vendor value would
    // stay the non-null string "" and wrongly pass is_not_null — a deal with no
    // amount counted as having one. (A `greater`/`less`/`equal` filter would NOT
    // discriminate here: evaluateOp Number()-coerces those, so a string amount
    // already compares numerically.)
    expect(withAmount).toEqual([
      { name: 'Low', amount: 8000 },
      { name: 'High', amount: 100000 },
    ]);
  });
});
