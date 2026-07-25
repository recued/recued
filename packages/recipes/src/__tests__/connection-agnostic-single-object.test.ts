import { describe, expect, it } from 'vitest';
import { CanonicalOpResolutionError, resolveConnectionAgnosticRecipe } from '@recued/recipes';
import {
  entityFieldsFromRegistry,
  type CanonicalOpStep,
  type OperationRow,
  type PackResolutionContext,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';

type RestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const operationRow = (
  operation: string,
  method: RestMethod,
): OperationRow => {
  const family = operation.slice(0, operation.indexOf('.'));
  const canonicalVerb = operation.slice(operation.indexOf('.') + 1);
  const riskTier: OperationRow['risk_tier'] =
    canonicalVerb === 'read' || canonicalVerb === 'search'
      ? 'read'
      : canonicalVerb === 'delete'
        ? 'destructive'
        : 'write';
  const approval: OperationRow['approval'] =
    riskTier === 'read' ? 'never' : riskTier === 'destructive' ? 'always' : 'ask';

  return {
    family,
    operation,
    verb: method.toLowerCase(),
    surface: 'api',
    binding: {
      kind: 'rest',
      method,
      path_template: `/mock/${operation}`,
    },
    risk_tier: riskTier,
    approval,
    groups: [`${family}.${canonicalVerb}`],
    reviewed: true,
  };
};

const hubspotCtx = (): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/hubspot',
  vendor: 'hubspot',
  connection: 'hubspot1',
  catalog_slug: 'hubspot-full',
  result_path: 'results',
  search_style: 'hubspot_search',
  write_style: 'hubspot_properties',
  operation_families: [
    operationRow('deal.read', 'GET'),
    operationRow('deal.search', 'POST'),
    operationRow('deal.create', 'POST'),
    operationRow('deal.update', 'PATCH'),
    operationRow('deal.delete', 'DELETE'),
  ],
  entity_fields: entityFieldsFromRegistry('hubspot'),
});

const salesforceCtx = (): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/salesforce',
  vendor: 'salesforce',
  connection: 'salesforce1',
  catalog_slug: 'salesforce-full',
  result_path: 'records',
  search_style: 'soql',
  write_style: 'salesforce_sobject',
  operation_families: [
    operationRow('opportunity.read', 'GET'),
  ],
  entity_fields: entityFieldsFromRegistry('salesforce'),
});

const testRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'connection-agnostic-single-object-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Connection agnostic single object test',
    description: 'Test recipe',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const opStep = (step: CanonicalOpStep): CanonicalOpStep => step;

const resolveOne = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext = hubspotCtx(),
): ReturnType<typeof resolveConnectionAgnosticRecipe> =>
  resolveConnectionAgnosticRecipe(testRecipe([step as unknown as RecipeStep]), ctx);

const expectReadResolutionFailure = (
  args: Record<string, unknown>,
  messageSubstring: string,
): void => {
  const run = (): void => {
    resolveOne(opStep({
      id: 'deal',
      op: 'deal.read',
      args,
    }));
  };

  expect(run).toThrow(CanonicalOpResolutionError);
  expect(run).toThrow(messageSubstring);
};

const hubspotDealProjection = {
  // R2 step 6 — response-side canonical record id (find-then-act).
  id: '{{item.properties.hs_object_id}}',
  name: '{{item.properties.dealname}}',
  stage: '{{item.properties.dealstage}}',
  amount: '{{item.properties.amount | number}}',
  owner: '{{item.properties.hubspot_owner_id}}',
  pipeline: '{{item.properties.pipeline}}',
  key_dates: {
    close_date: '{{item.properties.closedate | date_ms}}',
    created_at: '{{item.properties.createdate | date_ms}}',
    next_activity_at: '{{item.properties.notes_next_activity_date | date_ms}}',
    last_activity_at: '{{item.properties.notes_last_contacted | date_ms}}',
  },
  forecast_amount: '{{item.properties.hs_forecast_amount | number}}',
  description: '{{item.properties.description}}',
  next_step: '{{item.properties.hs_next_step}}',
  priority: '{{item.properties.hs_priority}}',
  // COMPUTED closed_state derivation (the G3 lift) → nested $ternary over the flags.
  close_state: {
    $ternary: {
      if: '{{item.properties.hs_is_closed}}',
      then: { $ternary: { if: '{{item.properties.hs_is_closed_won}}', then: 'won', else: 'lost' } },
      else: 'open',
    },
  },
};

describe('resolveConnectionAgnosticRecipe - single-object response projection', () => {
  it('rewrites deal.read to raw fetch plus project over the bare result object', () => {
    const { recipe } = resolveOne(opStep({
      id: 'deal',
      op: 'deal.read',
      args: { id: '5' },
    }));

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toMatchObject({
      id: 'deal__raw',
      input: {
        operation: 'deal.read',
        args: { deal_id: '5' },
      },
    });
    expect(recipe.steps[1]).toEqual({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: hubspotDealProjection,
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });

  it('rewrites Salesforce deal.read through opportunity.read with an opportunity_id selector', () => {
    const { recipe } = resolveOne(
      opStep({
        id: 'deal',
        op: 'deal.read',
        args: { id: '5' },
      }),
      salesforceCtx(),
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toMatchObject({
      id: 'deal__raw',
      input: {
        operation: 'opportunity.read',
        args: { opportunity_id: '5' },
      },
    });
  });

  it('fails closed when read carries the raw vendor selector token instead of canonical id', () => {
    expectReadResolutionFailure({ deal_id: '5' }, "requires an 'id'");
  });

  it('fails closed when read carries extra fields with the canonical id selector', () => {
    expectReadResolutionFailure({ id: '5', foo: 'x' }, 'takes only');
  });

  it('fails closed when read is missing the canonical id selector', () => {
    expectReadResolutionFailure({}, "requires an 'id'");
  });

  it('rewrites deal.create to write-body raw fetch plus project response step', () => {
    const { recipe } = resolveOne(opStep({
      id: 'deal',
      op: 'deal.create',
      args: { name: 'Acme', amount: 30000 },
    }));

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toMatchObject({
      id: 'deal__raw',
      input: {
        operation: 'deal.create',
        args: {
          'body.properties': {
            dealname: 'Acme',
            amount: '30000',
          },
        },
      },
    });
    expect(recipe.steps[1]).toMatchObject({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: hubspotDealProjection,
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });

  it('rewrites deal.update to selector-plus-body raw fetch plus project response step', () => {
    const { recipe } = resolveOne(opStep({
      id: 'deal',
      op: 'deal.update',
      args: { id: '5', amount: 40000 },
    }));

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toMatchObject({
      id: 'deal__raw',
      input: {
        operation: 'deal.update',
        args: {
          'body.properties': {
            amount: '40000',
          },
          deal_id: '5',
        },
      },
    });
    expect(recipe.steps[1]).toMatchObject({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: hubspotDealProjection,
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });

  it('keeps deal.delete as a single selector-only catalog fetch', () => {
    const { recipe } = resolveOne(opStep({
      id: 'deal',
      op: 'deal.delete',
      args: { id: '5' },
    }));

    expect(recipe.steps).toHaveLength(1);
    expect(recipe.steps[0]).toMatchObject({
      id: 'deal',
      input: {
        operation: 'deal.delete',
        args: { deal_id: '5' },
      },
    });
  });

  it('keeps deal.search as raw fetch plus map over the result_path collection', () => {
    const { recipe } = resolveOne(opStep({
      id: 'd',
      op: 'deal.search',
      args: { limit: 10 },
    }));

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[1]).toMatchObject({
      id: 'd',
      transform: 'map',
      array: '{{step.d__raw.result.results}}',
      expression: hubspotDealProjection,
    });
    expect(recipe.steps[1]).not.toHaveProperty('object');
  });
});
