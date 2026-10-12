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

const run = async (recipe: RecipeDefinition, manifest: IngredientManifest = CATALOG_MANIFEST) => {
  const gatewayCalls: Array<Record<string, unknown>> = [];
  const providerInputs: Array<Record<string, unknown>> = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    providerInputs.push(input as Record<string, unknown>);
    if (slug === 'hubspot-full') return { result: RAW_HUBSPOT_RECORD };
    throw new Error(`project defer test: unexpected ingredient '${slug}'`);
  };
  const ctx: ExecutionContext = {
    recipe,
    stores: baseStores(),
    ingredientExecutor,
    manifestGetter: (slug: string) => (slug === 'hubspot-full' ? manifest : null),
    connectionProfileResolver: (): ConnectionOperationProfile => ({
      allowed_operations: ['deal.read'],
      catalog_slug: 'hubspot-full',
    }),
    onGatewayCall: (e) => gatewayCalls.push(e as unknown as Record<string, unknown>),
  };
  const result = await executeRecipe(ctx);
  return { result, gatewayCalls, providerInputs };
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
      // D-320 ruling 20 — the connection the call went through.
      connection_name: 'hubspot1',
    });
    expect(typeof projected.amount).toBe('number');
    expect(typeof (projected.key_dates as Record<string, unknown>).close_date).toBe('number');
  });

  it("names the connection its call went through: a read that follows its record names the record's, not its setting's", async () => {
    // D-320 rulings 20 and 20g. The host marks a record step whose connection nobody
    // chose; at the call it takes the connection its record's id names. The setting
    // here is `hubspot1` and the record is `hubspot2`'s, so a projection that named
    // its setting would hand the next step an id routing to the wrong account.
    const followed = {
      ...CATALOG_MANIFEST,
      operations: {
        'deal.read': { ...CATALOG_MANIFEST.operations!['deal.read']!, record_id_arg: 'deal_id' },
      },
    } as IngredientManifest;
    const withId: PackResolutionContext = {
      ...HUBSPOT_PACK,
      entity_fields: [
        ...HUBSPOT_PACK.entity_fields,
        entityField({ entity: 'Deal', maps_to: 'id', field_path: 'id', type: 'string' }),
      ],
    };
    const authored = canonicalReadRecipe();
    authored.steps = [{ id: 'deal', op: 'deal.read', args: { id: 'hubspot_deal_hubspot2_5' } }] as RecipeDefinition['steps'];
    const { recipe } = resolveConnectionAgnosticRecipe(authored, withId);
    expect(recipe.steps[0]).toMatchObject({ id: 'deal__raw', connection: 'hubspot1', result_names_connection: true });
    const marked = {
      ...recipe,
      steps: recipe.steps.map((step) => (step.id === 'deal__raw' ? { ...step, connection_follows_record: true } : step)),
    } as RecipeDefinition;

    const { result, providerInputs } = await run(marked, followed);

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(providerInputs).toHaveLength(1);
    expect(providerInputs[0]).toMatchObject({ connection: 'hubspot2', deal_id: '5' });
    expect(stepResult(result, 'deal')).toMatchObject({
      id: '5',
      connection_name: 'hubspot2',
      target_id: 'hubspot_deal_hubspot2_5',
    });
  });
});
