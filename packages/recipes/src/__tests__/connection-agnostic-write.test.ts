import { describe, expect, it } from 'vitest';
import {
  CanonicalOpResolutionError,
  WRITE_SELECTOR_KEY,
  deriveRecordSelectorArgs,
  deriveVendorWriteArgs,
  resolveConnectionAgnosticRecipe,
  type WriteArgsResult,
} from '@recued/recipes';
import {
  entityFieldsFromRegistry,
  type CanonicalOpStep,
  type ConnectionVendorEntity,
  type EntityFieldRow,
  type OperationRow,
  type PackResolutionContext,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';

type RestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const operationRow = (
  operation: string,
  method: RestMethod = 'POST',
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

const entityField = (
  row: Pick<EntityFieldRow, 'entity' | 'field_path' | 'maps_to'> & Partial<EntityFieldRow>,
): EntityFieldRow => ({
  type: 'string',
  reviewed: true,
  ...row,
});

const rowsFor = (vendor: string, entity: string): EntityFieldRow[] =>
  entityFieldsFromRegistry(vendor).filter((row) => row.entity.toLowerCase() === entity.toLowerCase());

const hubspotDealRows = (): EntityFieldRow[] => rowsFor('hubspot', 'deal');
const hubspotContactRows = (): EntityFieldRow[] => rowsFor('hubspot', 'contact');
const salesforceOpportunityRows = (): EntityFieldRow[] => rowsFor('salesforce', 'opportunity');
const pipedriveDealRows = (): EntityFieldRow[] => rowsFor('pipedrive', 'deal');

const expectOk = (result: WriteArgsResult): Record<string, unknown> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.args;
};

const expectFailure = (result: WriteArgsResult, reasonSubstring: string): void => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected failure, received ${JSON.stringify(result.args)}`);
  expect(result.reason).not.toBe('');
  expect(result.reason).toContain(reasonSubstring);
};

const testRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'connection-agnostic-write-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Connection agnostic write test',
    description: 'Test recipe',
    author: 'recued-core',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const opStep = (overrides: Partial<CanonicalOpStep> = {}): CanonicalOpStep => ({
  id: 'deal',
  op: 'deal.create',
  args: { name: 'Acme' },
  ...overrides,
});

const hubspotCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
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
    operationRow('deal.delete', 'DELETE'),
    operationRow('contact.update', 'PATCH'),
  ],
  entity_fields: entityFieldsFromRegistry('hubspot'),
  ...overrides,
});

const salesforceCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/salesforce',
  vendor: 'salesforce',
  connection: 'salesforce1',
  catalog_slug: 'salesforce-full',
  result_path: 'records',
  search_style: 'soql',
  write_style: 'salesforce_sobject',
  operation_families: [
    operationRow('opportunity.read', 'GET'),
    operationRow('opportunity.search', 'GET'),
    operationRow('opportunity.create', 'POST'),
  ],
  entity_fields: entityFieldsFromRegistry('salesforce'),
  ...overrides,
});

const pipedriveCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/pipedrive',
  vendor: 'pipedrive',
  connection: 'pipedrive1',
  catalog_slug: 'pipedrive-catalog',
  result_path: 'data',
  search_style: 'pipedrive_filter',
  write_style: 'pipedrive_json',
  operation_families: [
    operationRow('deal.read', 'GET'),
    operationRow('deal.search', 'GET'),
    operationRow('deal.create', 'POST'),
  ],
  entity_fields: entityFieldsFromRegistry('pipedrive'),
  ...overrides,
});

const resolveOne = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext = hubspotCtx(),
): ReturnType<typeof resolveConnectionAgnosticRecipe> =>
  resolveConnectionAgnosticRecipe(testRecipe([step as unknown as RecipeStep]), ctx);

const expectResolutionFailure = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext,
  messageSubstring: string,
): void => {
  const run = (): void => {
    resolveOne(step, ctx);
  };

  expect(run).toThrow(CanonicalOpResolutionError);
  expect(run).toThrow(messageSubstring);
};

const pipedriveDealRegistry: ConnectionVendorEntity = {
  vendor: 'pipedrive',
  entity: 'deal',
  scope: 'connection.api.pipedrive.deal',
  display_name: 'Pipedrive deal',
  crm_alias: 'deal',
  meta_fields: [
    { key: 'id', type: 'string', source_path: 'id', description: 'id' },
    { key: 'name', type: 'string', source_path: 'data.title', description: 'title' },
    { key: 'stage', type: 'string', source_path: 'data.stage_name', description: 'stage' },
    { key: 'amount', type: 'number', source_path: 'data.value', description: 'amount' },
  ],
};

describe('deriveVendorWriteArgs - HubSpot properties body', () => {
  it('derives a create body from canonical deal fields and stringifies scalar values', () => {
    const args = expectOk(
      deriveVendorWriteArgs(
        'hubspot_properties',
        'deal',
        'create',
        hubspotDealRows(),
        { name: 'Acme', stage: 'appointmentscheduled', amount: 30000 },
      ),
    );

    expect(args).toEqual({
      'body.properties': {
        dealname: 'Acme',
        dealstage: 'appointmentscheduled',
        amount: '30000',
      },
    });
  });

  it('derives an update body and maps the canonical id selector to the path param', () => {
    const args = expectOk(
      deriveVendorWriteArgs(
        'hubspot_properties',
        'contact',
        'update',
        hubspotContactRows(),
        { [WRITE_SELECTOR_KEY]: '{{config.cid}}', email: 'a@b.com' },
      ),
    );

    expect(args).toEqual({
      'body.properties': { email: 'a@b.com' },
      contact_id: '{{config.cid}}',
    });
  });

  it('derives a selector-only delete without a write style or entity fields', () => {
    const args = expectOk(
      deriveVendorWriteArgs(undefined, 'deal', 'delete', [], { [WRITE_SELECTOR_KEY]: '5' }),
    );

    expect(args).toEqual({ deal_id: '5' });
  });
});

describe('deriveRecordSelectorArgs - selector-only verbs', () => {
  it('exports the canonical id selector key', () => {
    expect(WRITE_SELECTOR_KEY).toBe('id');
  });

  it('maps canonical read id to the vendor path-param selector', () => {
    const args = expectOk(
      deriveRecordSelectorArgs('deal', 'read', { [WRITE_SELECTOR_KEY]: '5' }),
    );

    expect(args).toEqual({ deal_id: '5' });
  });

  it('maps canonical delete id to the vendor path-param selector', () => {
    const args = expectOk(
      deriveRecordSelectorArgs('opportunity', 'delete', { [WRITE_SELECTOR_KEY]: '5' }),
    );

    expect(args).toEqual({ opportunity_id: '5' });
  });

  it.each([
    ['missing', {}],
    ['empty', { [WRITE_SELECTOR_KEY]: '' }],
  ] as const)('fails closed when the canonical id selector is %s', (_label, rawArgs) => {
    expectFailure(
      deriveRecordSelectorArgs('deal', 'read', rawArgs),
      "requires an 'id'",
    );
  });

  it('fails closed when a selector-only verb carries extra keys', () => {
    expectFailure(
      deriveRecordSelectorArgs('deal', 'read', { [WRITE_SELECTOR_KEY]: '5', foo: 'x' }),
      'takes only',
    );
  });

  it('fails closed when the vendor entity cannot form a safe selector key', () => {
    expectFailure(
      deriveRecordSelectorArgs('deal}}{{x', 'read', { [WRITE_SELECTOR_KEY]: '5' }),
      'safe identifier',
    );
  });
});

describe('deriveVendorWriteArgs - Salesforce sObject body', () => {
  it('derives flat body fields and preserves value types', () => {
    const args = expectOk(
      deriveVendorWriteArgs(
        'salesforce_sobject',
        'opportunity',
        'create',
        salesforceOpportunityRows(),
        { name: 'Acme', amount: 30000 },
      ),
    );

    expect(args).toEqual({
      'body.Name': 'Acme',
      'body.Amount': 30000,
    });
  });
});

describe('deriveVendorWriteArgs - Pipedrive JSON body', () => {
  it('derives flat body fields and preserves value types', () => {
    const args = expectOk(
      deriveVendorWriteArgs(
        'pipedrive_json',
        'deal',
        'create',
        pipedriveDealRows(),
        { name: 'Acme', amount: 30000, close_state: 'open' },
      ),
    );

    expect(args).toEqual({
      'body.title': 'Acme',
      'body.value': 30000,
      'body.status': 'open',
    });
  });

  it('resolves canonical deal.create to Pipedrive deal.create with title/value args', () => {
    const { recipe } = resolveOne(
      opStep({ id: 'created', op: 'deal.create', args: { name: 'Acme', amount: 30000 } }),
      pipedriveCtx(),
    );

    expect(recipe.steps[0]).toMatchObject({
      id: 'created__raw',
      ingredient: 'pipedrive-catalog',
      connection: 'pipedrive1',
      input: {
        operation: 'deal.create',
        args: {
          'body.title': 'Acme',
          'body.value': 30000,
        },
      },
    });
  });
});

describe('deriveVendorWriteArgs - fail closed validation', () => {
  it('fails closed when create or update has no declared write style', () => {
    expectFailure(
      deriveVendorWriteArgs(undefined, 'deal', 'create', hubspotDealRows(), { name: 'Acme' }),
      'write_style',
    );
    expectFailure(
      deriveVendorWriteArgs(undefined, 'deal', 'update', hubspotDealRows(), { id: '5', name: 'Acme' }),
      'write_style',
    );
  });

  it('fails closed for an unknown write style', () => {
    expectFailure(
      deriveVendorWriteArgs(
        'bogus' as Parameters<typeof deriveVendorWriteArgs>[0],
        'deal',
        'create',
        hubspotDealRows(),
        { name: 'Acme' },
      ),
      'write style',
    );
  });

  it('fails closed when the selector key would be built from an unsafe vendor entity', () => {
    expectFailure(
      deriveVendorWriteArgs(
        'hubspot_properties',
        'deal}}{{config.secret}}{{',
        'delete',
        [],
        { id: '5' },
      ),
      'safe identifier',
    );
  });

  it('fails closed when a HubSpot field path strips to a prototype-sensitive bare name', () => {
    expectFailure(
      deriveVendorWriteArgs(
        'hubspot_properties',
        'deal',
        'create',
        [
          entityField({
            entity: 'deal',
            field_path: 'properties.__proto__',
            maps_to: 'name',
          }),
        ],
        { name: 'Acme' },
      ),
      'safe write identifier',
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('fails closed when a HubSpot field path contains template metacharacters', () => {
    expectFailure(
      deriveVendorWriteArgs(
        'hubspot_properties',
        'deal',
        'create',
        [
          entityField({
            entity: 'deal',
            field_path: 'properties.}}{{data.contact.x}}{{',
            maps_to: 'name',
          }),
        ],
        { name: 'Acme' },
      ),
      'safe write identifier',
    );
  });
});

describe('resolveConnectionAgnosticRecipe - write reverse projection', () => {
  it('rewrites HubSpot deal.create to a raw catalog step plus project response step', () => {
    const { recipe } = resolveOne(
      opStep({
        id: 'deal',
        op: 'deal.create',
        args: { name: 'Acme', stage: 'appointmentscheduled', amount: 30000 },
      }),
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toEqual({
      id: 'deal__raw',
      ingredient: 'hubspot-full',
      connection: 'hubspot1',
      input: {
        operation: 'deal.create',
        args: {
          'body.properties': {
            dealname: 'Acme',
            dealstage: 'appointmentscheduled',
            amount: '30000',
          },
        },
      },
    });
    expect(recipe.steps[1]).toEqual({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: {
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
        // COMPUTED canonical field (closed_state derivation) — read-only, so it
        // is NOT in the write body above but IS in the RESPONSE projection.
        close_state: {
          $ternary: {
            if: '{{item.properties.hs_is_closed}}',
            then: { $ternary: { if: '{{item.properties.hs_is_closed_won}}', then: 'won', else: 'lost' } },
            else: 'open',
          },
        },
      },
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });

  it('rewrites HubSpot contact.update with the canonical id selector as contact_id', () => {
    const { recipe } = resolveOne(
      opStep({
        id: 'c',
        op: 'contact.update',
        args: { id: '{{config.cid}}', email: 'a@b.com' },
      }),
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toEqual({
      id: 'c__raw',
      ingredient: 'hubspot-full',
      connection: 'hubspot1',
      input: {
        operation: 'contact.update',
        args: {
          'body.properties': { email: 'a@b.com' },
          contact_id: '{{config.cid}}',
        },
      },
    });
    expect(recipe.steps[1]).toEqual({
      id: 'c',
      transform: 'project',
      object: '{{step.c__raw.result}}',
      expression: {
        email: '{{item.properties.email}}',
        // R2 step 6 — response-side canonical record id (find-then-act).
        id: '{{item.properties.hs_object_id}}',
        // D-190 — derived canonical `name` (concat of first/last, email local-part
        // fallback); read-only, so it projects from the response but is never a writable arg.
        name: {
          $concat: {
            parts: ['{{item.properties.firstname}}', '{{item.properties.lastname}}'],
            separator: ' ',
            fallback: '{{item.properties.email | local_part}}',
          },
        },
        // PROJECTABLE name parts (also projected directly alongside the derived name).
        first_name: '{{item.properties.firstname}}',
        last_name: '{{item.properties.lastname}}',
        lifecycle_stage: '{{item.properties.lifecyclestage}}',
        owner: '{{item.properties.hubspot_owner_id}}',
        account_id: '{{item.properties.associatedcompanyid}}',
        recent_activity_at: '{{item.properties.notes_last_contacted | date_ms}}',
        phone: '{{item.properties.phone}}',
        company: '{{item.properties.company}}',
      },
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });

  it('rewrites HubSpot deal.delete without requiring write_style', () => {
    const { recipe } = resolveOne(
      opStep({
        id: 'd',
        op: 'deal.delete',
        args: { id: '5' },
      }),
      hubspotCtx({ write_style: undefined }),
    );

    expect(recipe.steps).toHaveLength(1);
    expect(recipe.steps[0]).toEqual({
      id: 'd',
      ingredient: 'hubspot-full',
      connection: 'hubspot1',
      input: {
        operation: 'deal.delete',
        args: { deal_id: '5' },
      },
    });
  });

  it('rewrites Salesforce deal.create through opportunity.create with typed sObject fields', () => {
    const { recipe } = resolveOne(
      opStep({
        id: 'o',
        op: 'deal.create',
        args: { name: 'Acme', amount: 30000 },
      }),
      salesforceCtx(),
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toEqual({
      id: 'o__raw',
      ingredient: 'salesforce-full',
      connection: 'salesforce1',
      input: {
        operation: 'opportunity.create',
        args: {
          'body.Name': 'Acme',
          'body.Amount': 30000,
        },
      },
    });
    expect(recipe.steps[1]).toEqual({
      id: 'o',
      transform: 'project',
      object: '{{step.o__raw.result}}',
      expression: {
        // R2 step 6 — response-side canonical record id (find-then-act).
        id: '{{item.Id}}',
        name: '{{item.Name}}',
        stage: '{{item.StageName}}',
        amount: '{{item.Amount | number}}',
        owner: '{{item.OwnerId}}',
        key_dates: {
          close_date: '{{item.CloseDate | date_ms}}',
          created_at: '{{item.CreatedDate | date_ms}}',
        },
        forecast_amount: '{{item.ForecastAmount | number}}',
        // COMPUTED closed_state derivation — read-only, RESPONSE projection only.
        close_state: {
          $ternary: {
            if: '{{item.IsClosed}}',
            then: { $ternary: { if: '{{item.IsWon}}', then: 'won', else: 'lost' } },
            else: 'open',
          },
        },
        probability: '{{item.Probability | number}}',
        next_step: '{{item.NextStep}}', // D-192 F1 — SF opportunity next_step parity
      },
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });
});

describe('resolveConnectionAgnosticRecipe - write fail closed cases', () => {
  it('fails closed for create and update when write_style is undefined', () => {
    const ctx = hubspotCtx({ write_style: undefined });

    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.create', args: { name: 'Acme' } }),
      ctx,
      'write_style',
    );
    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.update', args: { id: '5', name: 'Acme' } }),
      {
        ...ctx,
        operation_families: [
          ...ctx.operation_families,
          operationRow('deal.update', 'PATCH'),
        ],
      },
      'write_style',
    );
  });

  it.each([
    ['derived field', { close_state: 'open' }],
    ['unknown field', { made_up_field: 'x' }],
  ] as const)('fails closed for an unwritable %s', (_label, args) => {
    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.create', args }),
      hubspotCtx(),
      'writable',
    );
  });

  it('fails closed when create carries the reserved id selector', () => {
    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.create', args: { id: '5', name: 'Acme' } }),
      hubspotCtx(),
      'must not carry',
    );
  });

  it('fails closed when update is missing the id selector', () => {
    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.update', args: { name: 'Acme' } }),
      hubspotCtx({
        operation_families: [
          ...hubspotCtx().operation_families,
          operationRow('deal.update', 'PATCH'),
        ],
      }),
      "requires an 'id'",
    );
  });

  it('fails closed when delete is missing the id selector', () => {
    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.delete', args: {} }),
      hubspotCtx(),
      "requires an 'id'",
    );
  });

  it('fails closed when delete carries body fields', () => {
    expectResolutionFailure(
      opStep({ id: 'deal', op: 'deal.delete', args: { id: '5', name: 'Acme' } }),
      hubspotCtx(),
      'takes only',
    );
  });

  it.each([
    ['create', opStep({ id: 'deal', op: 'deal.create', args: {} })],
    [
      'update',
      opStep({ id: 'deal', op: 'deal.update', args: { id: '5' } }),
    ],
  ] as const)('fails closed when %s has no body fields', (_label, step) => {
    expectResolutionFailure(
      step,
      hubspotCtx({
        operation_families: [
          ...hubspotCtx().operation_families,
          operationRow('deal.update', 'PATCH'),
        ],
      }),
      'at least one',
    );
  });
});

describe('resolveConnectionAgnosticRecipe - write edge cases', () => {
  it('treats a canonical id field mapping as the update selector, not a writable body field', () => {
    const ctx: PackResolutionContext = {
      pack_slug: 'pack/acme/pipedrive-crm',
      vendor: 'pipedrive',
      connection: 'pipedrive1',
      catalog_slug: 'pipedrive-crm',
      result_path: 'items',
      search_style: 'hubspot_search',
      write_style: 'hubspot_properties',
      operation_families: [operationRow('deal.update', 'PATCH')],
      entity_fields: entityFieldsFromRegistry('pipedrive', [pipedriveDealRegistry]),
      registry: [pipedriveDealRegistry],
    };

    const { recipe } = resolveOne(
      opStep({
        id: 'deal',
        op: 'deal.update',
        args: { id: '5', name: 'Acme' },
      }),
      ctx,
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toEqual({
      id: 'deal__raw',
      ingredient: 'pipedrive-crm',
      connection: 'pipedrive1',
      input: {
        operation: 'deal.update',
        args: {
          'body.properties': { 'data.title': 'Acme' },
          deal_id: '5',
        },
      },
    });
    const args = (recipe.steps[0] as unknown as { input: { args: Record<string, unknown> } }).input.args;
    expect(args['body.properties']).not.toHaveProperty('id');
    expect(recipe.steps[1]).toEqual({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: {
        id: '{{item.id}}',
        name: '{{item.data.title}}',
        stage: '{{item.data.stage_name}}',
        amount: '{{item.data.value | number}}',
      },
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });

  it('resolves delete for an entity with no source-backed entity fields', () => {
    const registry: ConnectionVendorEntity[] = [
      {
        vendor: 'fieldless',
        entity: 'deal',
        scope: 'connection.api.fieldless.deal',
        display_name: 'Fieldless deal',
        crm_alias: 'deal',
        meta_fields: [],
      },
    ];
    const ctx: PackResolutionContext = {
      pack_slug: 'pack/acme/fieldless-crm',
      vendor: 'fieldless',
      connection: 'fieldless1',
      catalog_slug: 'fieldless-crm',
      result_path: 'items',
      operation_families: [operationRow('deal.delete', 'DELETE')],
      entity_fields: [],
      registry,
    };

    const { recipe } = resolveOne(
      opStep({ id: 'd', op: 'deal.delete', args: { id: '5' } }),
      ctx,
    );

    expect(recipe.steps).toHaveLength(1);
    expect(recipe.steps[0]).toEqual({
      id: 'd',
      ingredient: 'fieldless-crm',
      connection: 'fieldless1',
      input: {
        operation: 'deal.delete',
        args: { deal_id: '5' },
      },
    });
  });

  it.each([
    ['create', 'deal.create', { name: 'Acme' }, 'POST'],
    ['update', 'deal.update', { id: '5', name: 'Acme' }, 'PATCH'],
  ] as const)('still rejects %s for an entity with no source-backed entity fields', (_label, op, args, method) => {
    const registry: ConnectionVendorEntity[] = [
      {
        vendor: 'fieldless',
        entity: 'deal',
        scope: 'connection.api.fieldless.deal',
        display_name: 'Fieldless deal',
        crm_alias: 'deal',
        meta_fields: [],
      },
    ];
    const ctx: PackResolutionContext = {
      pack_slug: 'pack/acme/fieldless-crm',
      vendor: 'fieldless',
      connection: 'fieldless1',
      catalog_slug: 'fieldless-crm',
      result_path: 'items',
      write_style: 'hubspot_properties',
      operation_families: [operationRow(op, method)],
      entity_fields: [],
      registry,
    };

    expectResolutionFailure(
      opStep({ id: 'deal', op, args }),
      ctx,
      'no projectable entity_fields',
    );
  });
});

describe('resolveConnectionAgnosticRecipe - write security gates', () => {
  it('validates every response row field_path before the write branch derives args', () => {
    expectResolutionFailure(
      opStep({
        id: 'deal',
        op: 'deal.create',
        args: { name: 'Acme' },
      }),
      hubspotCtx({
        entity_fields: [
          entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
          entityField({
            entity: 'Deal',
            field_path: 'properties.}}{{data.contact.x}}{{',
            maps_to: 'stage',
          }),
        ],
      }),
      'unprojectable vendor field_path',
    );
  });
});

describe('resolveConnectionAgnosticRecipe - read/search regression coverage', () => {
  const narrowRows = (): EntityFieldRow[] => [
    entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
    entityField({ entity: 'Deal', field_path: 'properties.amount', maps_to: 'amount', type: 'number' }),
  ];

  it('keeps deal.search on the two-step raw fetch plus map projection shape', () => {
    const { recipe } = resolveOne(
      opStep({ id: 'deals', op: 'deal.search', args: { limit: 50 } }),
      hubspotCtx({ entity_fields: narrowRows() }),
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toEqual({
      id: 'deals__raw',
      ingredient: 'hubspot-full',
      connection: 'hubspot1',
      input: {
        operation: 'deal.search',
        args: {
          'body.properties': ['dealname', 'amount'],
          'body.limit': 50,
        },
      },
    });
    expect(recipe.steps[1]).toEqual({
      id: 'deals',
      transform: 'map',
      array: '{{step.deals__raw.result.results}}',
      expression: {
        name: '{{item.properties.dealname}}',
        amount: '{{item.properties.amount | number}}',
      },
    });
  });

  it('keeps deal.read on the two-step raw fetch plus project projection shape', () => {
    const { recipe } = resolveOne(
      opStep({ id: 'deal', op: 'deal.read', args: { id: '5' } }),
      hubspotCtx({ entity_fields: narrowRows() }),
    );

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toEqual({
      id: 'deal__raw',
      ingredient: 'hubspot-full',
      connection: 'hubspot1',
      input: {
        operation: 'deal.read',
        args: { deal_id: '5' },
      },
    });
    expect(recipe.steps[1]).toEqual({
      id: 'deal',
      transform: 'project',
      object: '{{step.deal__raw.result}}',
      expression: {
        name: '{{item.properties.dealname}}',
        amount: '{{item.properties.amount | number}}',
      },
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');
  });
});
