import { describe, expect, it } from 'vitest';
import {
  CanonicalOpResolutionError,
  resolveConnectionAgnosticRecipe,
} from '@recued/recipes';
import type {
  CanonicalOpStep,
  ConnectionVendorEntity,
  EntityFieldRow,
  OperationRow,
  PackResolutionContext,
  RecipeDefinition,
  RecipeStep,
} from '@recued/contracts';

const operationRow = (
  operation: string,
  httpVerb: 'get' | 'post' = 'post',
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
  row: Pick<EntityFieldRow, 'field_path' | 'maps_to'> & Partial<EntityFieldRow>,
): EntityFieldRow => ({
  entity: 'Deal',
  type: 'string',
  reviewed: true,
  ...row,
});

const hubspotDealFields = (): EntityFieldRow[] => [
  entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
  entityField({ entity: 'Deal', field_path: 'properties.dealstage', maps_to: 'stage' }),
  entityField({
    entity: 'Deal',
    field_path: 'properties.amount',
    maps_to: 'amount',
    type: 'number',
  }),
  entityField({ entity: 'Deal', field_path: 'properties.hubspot_owner_id', maps_to: 'owner' }),
  entityField({ entity: 'Deal', field_path: 'properties.hs_is_closed', maps_to: 'is_closed', type: 'boolean' }),
];

const hubspotCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/hubspot',
  vendor: 'hubspot',
  connection: 'hubspot1',
  catalog_slug: 'hubspot-full',
  result_path: 'results',
  search_style: 'hubspot_search',
  operation_families: [operationRow('deal.search', 'post')],
  entity_fields: hubspotDealFields(),
  ...overrides,
});

const salesforceCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/salesforce',
  vendor: 'salesforce',
  connection: 'salesforce1',
  catalog_slug: 'salesforce-full',
  result_path: 'records',
  search_style: 'soql',
  operation_families: [operationRow('opportunity.search', 'get')],
  entity_fields: [
    entityField({ entity: 'Opportunity', field_path: 'Name', maps_to: 'name' }),
    entityField({ entity: 'Opportunity', field_path: 'StageName', maps_to: 'stage' }),
    entityField({ entity: 'Opportunity', field_path: 'Amount', maps_to: 'amount', type: 'number' }),
    entityField({ entity: 'Opportunity', field_path: 'OwnerId', maps_to: 'owner' }),
    entityField({ entity: 'Opportunity', field_path: 'IsClosed', maps_to: 'is_closed', type: 'boolean' }),
  ],
  ...overrides,
});

const testRecipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'connection-agnostic-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Connection agnostic test',
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
  id: 'deals',
  op: 'deal.search',
  args: { limit: 200 },
  ...overrides,
});

// A deliberately FICTIONAL third-party CRM vendor (never a real, shippable name).
// The test below proves the DEFAULT registry does NOT model this vendor, so without
// the injected registry resolution fails closed. Using a real vendor here is a trap:
// when it later ships into CONNECTION_VENDOR_ENTITIES (as `pipedrive` did in
// 602f9738) the default starts modeling it and the fail-closed assertion silently
// breaks. Keep this vendor fictional.
const thirdPartyDealRegistry: ConnectionVendorEntity = {
  vendor: 'examplecrm',
  entity: 'deal',
  scope: 'connection.api.examplecrm.deal',
  display_name: 'ExampleCRM deal',
  crm_alias: 'deal',
  meta_fields: [
    { key: 'id', type: 'string', source_path: 'id', description: 'id' },
    { key: 'name', type: 'string', source_path: 'data.title', description: 'title' },
    { key: 'stage', type: 'string', source_path: 'data.stage_name', description: 'stage' },
    { key: 'amount', type: 'number', source_path: 'data.value', description: 'amount' },
  ],
};

const expectResolutionError = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext,
  message: string,
  extraSteps: RecipeStep[] = [],
): void => {
  let thrown: unknown;
  try {
    resolveConnectionAgnosticRecipe(testRecipe([step, ...extraSteps]), ctx);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(CanonicalOpResolutionError);
  expect((thrown as Error).message).toBe(message);
};

const expectResolutionErrorContaining = (
  step: CanonicalOpStep,
  ctx: PackResolutionContext,
  messageSubstring: string,
  extraSteps: RecipeStep[] = [],
): void => {
  let thrown: unknown;
  try {
    resolveConnectionAgnosticRecipe(testRecipe([step, ...extraSteps]), ctx);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(CanonicalOpResolutionError);
  expect((thrown as Error).message).toContain(messageSubstring);
};

const projectionSafetyRows = (
  row: Pick<EntityFieldRow, 'field_path' | 'maps_to'> & Partial<EntityFieldRow>,
): EntityFieldRow[] => [
  entityField({ entity: 'Deal', field_path: 'id', maps_to: 'id' }),
  entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
  entityField({ entity: 'Deal', ...row }),
];

describe('resolveConnectionAgnosticRecipe', () => {
  it('dispatches canonical deal.search to HubSpot deal.search and Salesforce opportunity.search', () => {
    const hubspot = resolveConnectionAgnosticRecipe(testRecipe([opStep()]), hubspotCtx());
    const salesforce = resolveConnectionAgnosticRecipe(testRecipe([opStep()]), salesforceCtx());

    expect(hubspot.bindings).toEqual([
      {
        canonical_op: 'deal.search',
        crm_alias: 'deal',
        verb: 'search',
        vendor_entity: 'deal',
        operation: 'deal.search',
        catalog_slug: 'hubspot-full',
        connection: 'hubspot1',
        vendor: 'hubspot',
        step_id: 'deals',
        result_path: 'results',
      },
    ]);
    expect(salesforce.bindings).toEqual([
      {
        canonical_op: 'deal.search',
        crm_alias: 'deal',
        verb: 'search',
        vendor_entity: 'opportunity',
        operation: 'opportunity.search',
        catalog_slug: 'salesforce-full',
        connection: 'salesforce1',
        vendor: 'salesforce',
        step_id: 'deals',
        result_path: 'records',
      },
    ]);
  });

  it('honors an injected third-party registry for crm_alias resolution', () => {
    const ctx: PackResolutionContext = {
      pack_slug: 'pack/acme/examplecrm-crm',
      vendor: 'examplecrm',
      connection: 'examplecrm1',
      catalog_slug: 'examplecrm-crm',
      result_path: 'items',
      operation_families: [operationRow('deal.read', 'get')],
      entity_fields: [
        entityField({ entity: 'deal', field_path: 'id', maps_to: 'id' }),
        entityField({ entity: 'deal', field_path: 'data.title', maps_to: 'name' }),
        entityField({ entity: 'deal', field_path: 'data.value', maps_to: 'amount', type: 'number' }),
      ],
      registry: [thirdPartyDealRegistry],
    };

    const { recipe, bindings } = resolveConnectionAgnosticRecipe(
      testRecipe([opStep({ id: 'deal', op: 'deal.read', args: { id: '5' } })]),
      ctx,
    );

    expect(bindings).toEqual([
      {
        canonical_op: 'deal.read',
        crm_alias: 'deal',
        verb: 'read',
        vendor_entity: 'deal',
        operation: 'deal.read',
        catalog_slug: 'examplecrm-crm',
        connection: 'examplecrm1',
        vendor: 'examplecrm',
        step_id: 'deal',
        result_path: 'items',
      },
    ]);
    expect(recipe.steps[0]).toEqual({
      id: 'deal__raw',
      ingredient: 'examplecrm-crm',
      connection: 'examplecrm1',
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
        id: '{{item.id}}',
        name: '{{item.data.title}}',
        amount: '{{item.data.value | number}}',
      },
    });
    expect(recipe.steps[1]).not.toHaveProperty('array');

    let thrown: unknown;
    try {
      resolveConnectionAgnosticRecipe(
        testRecipe([opStep({ id: 'deal', op: 'deal.read', args: { id: '5' } })]),
        { ...ctx, registry: undefined },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CanonicalOpResolutionError);
    expect((thrown as Error).message).toContain("does not model crm_alias 'deal'");
  });

  it('rewrites one op-step to a raw catalog fetch (derived search body) plus a canonical map projection', () => {
    const { recipe } = resolveConnectionAgnosticRecipe(
      testRecipe([opStep({ args: { limit: 50 } })]),
      hubspotCtx(),
    );

    expect(recipe.steps).toHaveLength(2);
    // NEXT-1: the canonical `{ limit }` is derived into the HubSpot search POST
    // body — `body.properties` (the SELECT, from entity_fields) + `body.limit`.
    expect(recipe.steps[0]).toEqual({
      id: 'deals__raw',
      ingredient: 'hubspot-full',
      connection: 'hubspot1',
      input: {
        operation: 'deal.search',
        args: {
          'body.properties': ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'hs_is_closed'],
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
        stage: '{{item.properties.dealstage}}',
        amount: '{{item.properties.amount | number}}',
        owner: '{{item.properties.hubspot_owner_id}}',
        is_closed: '{{item.properties.hs_is_closed}}',
      },
    });
  });

  it('coerces number (| number) and datetime (| date_ms) projection fields and keeps string + boolean refs pure', () => {
    const { recipe } = resolveConnectionAgnosticRecipe(
      testRecipe([opStep()]),
      hubspotCtx({
        entity_fields: [
          entityField({ field_path: 'properties.dealname', maps_to: 'name', type: 'string' }),
          entityField({ field_path: 'properties.amount', maps_to: 'amount', type: 'number' }),
          entityField({ field_path: 'properties.hs_is_closed', maps_to: 'is_closed', type: 'boolean' }),
          entityField({
            field_path: 'properties.closedate',
            maps_to: 'key_dates.close_date',
            type: 'datetime',
          }),
        ],
      }),
    );

    // G2 datetime unify: a `datetime` field projects through `| date_ms` (not a
    // pure ref) so HubSpot's epoch-ms string and Salesforce's ISO string normalize
    // to the same canonical unix-ms number. `string` / `boolean` stay pure refs.
    expect(recipe.steps[1]).toEqual({
      id: 'deals',
      transform: 'map',
      array: '{{step.deals__raw.result.results}}',
      expression: {
        name: '{{item.properties.dealname}}',
        amount: '{{item.properties.amount | number}}',
        is_closed: '{{item.properties.hs_is_closed}}',
        key_dates: {
          close_date: '{{item.properties.closedate | date_ms}}',
        },
      },
    });
  });

  it('passes non-op steps through unchanged and in order', () => {
    const before = { id: 'before', transform: 'coalesce', values: ['x'] } as RecipeStep;
    const after = { id: 'after', transform: 'count', array: '{{step.deals}}' } as RecipeStep;

    const { recipe } = resolveConnectionAgnosticRecipe(
      testRecipe([before, opStep(), after]),
      hubspotCtx(),
    );

    expect(recipe.steps).toHaveLength(4);
    expect(recipe.steps[0]).toBe(before);
    expect(recipe.steps[1]).toMatchObject({ id: 'deals__raw' });
    expect(recipe.steps[2]).toMatchObject({ id: 'deals', transform: 'map' });
    expect(recipe.steps[3]).toBe(after);
  });

  it('builds the projection from response fields with case-insensitive entity matching', () => {
    const ctx = hubspotCtx({
      entity_fields: [
        entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
        entityField({ entity: 'deal', field_path: 'properties.amount', maps_to: 'amount', type: 'number' }),
        entityField({
          entity: 'Deal',
          field_path: 'properties.create_only',
          maps_to: 'create_only',
          applies: 'request',
        }),
        entityField({
          entity: 'Deal',
          field_path: 'properties.req_only',
          maps_to: 'req_only',
          applies: 'req',
        }),
        entityField({ entity: 'Opportunity', field_path: 'Name', maps_to: 'sf_name' }),
      ],
    });

    const { recipe } = resolveConnectionAgnosticRecipe(testRecipe([opStep()]), ctx);

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

  describe('resolveConnectionAgnosticRecipe - projection path safety (SECURITY)', () => {
    it.each([
      {
        name: 'exfiltration',
        field_path: 'amount}} {{data.contact.ceo@corp.com.annotations}} {{item.x',
        type: undefined,
      },
      {
        name: 'config leak',
        field_path: 'amount}} {{config.secret}} {{item.x',
        type: undefined,
      },
      {
        name: 'step leak',
        field_path: 'x}}{{step.other}}{{item.y',
        type: undefined,
      },
      {
        name: 'number-coercion sink',
        field_path: 'amount | number}} {{config.secret',
        type: 'number' as const,
      },
      {
        name: 'bare space',
        field_path: 'first last',
        type: undefined,
      },
      {
        name: 'empty leading-dot',
        field_path: '.amount',
        type: undefined,
      },
      {
        name: 'empty trailing-dot',
        field_path: 'amount.',
        type: undefined,
      },
      {
        name: 'empty path',
        field_path: '',
        type: undefined,
      },
    ])('fails closed for unsafe field_path: $name', ({ field_path, type }) => {
      expectResolutionErrorContaining(
        opStep(),
        hubspotCtx({
          entity_fields: projectionSafetyRows({
            field_path,
            maps_to: 'unsafe_field',
            ...(type !== undefined ? { type } : {}),
          }),
        }),
        'unprojectable vendor field_path',
      );
    });

    it.each([
      '__proto__',
      '__proto__.polluted',
      'constructor',
      'prototype.x',
      '1name',
      'a.{{x}}',
    ])('fails closed for unsafe maps_to: %s', (maps_to) => {
      expectResolutionErrorContaining(
        opStep(),
        hubspotCtx({
          entity_fields: projectionSafetyRows({
            field_path: 'properties.bad',
            maps_to,
          }),
        }),
        'unsafe canonical field name',
      );
    });

    it('does not pollute Object.prototype while rejecting prototype maps_to paths', () => {
      expectResolutionErrorContaining(
        opStep(),
        hubspotCtx({
          entity_fields: projectionSafetyRows({
            field_path: 'properties.bad',
            maps_to: '__proto__.polluted',
          }),
        }),
        'unsafe canonical field name',
      );

      expect(({} as any).polluted).toBeUndefined();
    });

    it('allows benign vendor field paths and nested canonical paths', () => {
      const { recipe } = resolveConnectionAgnosticRecipe(
        testRecipe([opStep()]),
        hubspotCtx({
          entity_fields: [
            entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
            entityField({
              entity: 'Deal',
              field_path: 'properties.amount',
              maps_to: 'amount',
              type: 'number',
            }),
            entityField({ entity: 'Deal', field_path: 'data.0.value', maps_to: 'first_value' }),
            entityField({
              entity: 'Deal',
              field_path: 'properties.closedate',
              maps_to: 'key_dates.close_date',
            }),
          ],
        }),
      );

      const expression = (recipe.steps[1] as unknown as { expression: Record<string, unknown> }).expression;
      expect(expression).toMatchObject({
        name: '{{item.properties.dealname}}',
        amount: '{{item.properties.amount | number}}',
        first_value: '{{item.data.0.value}}',
      });
      expect((expression.key_dates as Record<string, unknown>).close_date).toBe(
        '{{item.properties.closedate}}',
      );
    });

    it('leaves first-party HubSpot deal.search resolution unaffected', () => {
      expect(() => {
        resolveConnectionAgnosticRecipe(testRecipe([opStep()]), hubspotCtx());
      }).not.toThrow();
    });
  });

  it('rewrites multiple op-steps independently and returns one binding per op-step', () => {
    const { recipe, bindings } = resolveConnectionAgnosticRecipe(
      testRecipe([
        opStep({ id: 'deals', args: { limit: 10 } }),
        opStep({ id: 'renewals', args: { limit: 20 } }),
      ]),
      hubspotCtx(),
    );

    expect(recipe.steps.map((step) => step.id)).toEqual([
      'deals__raw',
      'deals',
      'renewals__raw',
      'renewals',
    ]);
    expect(recipe.steps[0]).toMatchObject({
      input: { operation: 'deal.search', args: { 'body.limit': 10 } },
    });
    expect(recipe.steps[2]).toMatchObject({
      input: { operation: 'deal.search', args: { 'body.limit': 20 } },
    });
    expect(bindings.map((binding) => binding.step_id)).toEqual(['deals', 'renewals']);
    expect(bindings.map((binding) => binding.operation)).toEqual(['deal.search', 'deal.search']);
  });

  it('carries skip_when and cache to both generated steps, and fail_on / stop_when only to the projection', () => {
    const { recipe } = resolveConnectionAgnosticRecipe(
      testRecipe([
        opStep({
          skip_when: '{{config.enabled}} equal false',
          fail_on: '{{step.deals}} empty',
          stop_when: '{{step.deals}} is_empty',
          cache: 'any',
        }),
      ]),
      hubspotCtx(),
    );

    expect(recipe.steps[0]).toMatchObject({
      id: 'deals__raw',
      skip_when: '{{config.enabled}} equal false',
      cache: 'any',
    });
    expect('fail_on' in recipe.steps[0]).toBe(false);
    // Stopping on the raw fetch would decide before the canonical records exist.
    expect('stop_when' in recipe.steps[0]).toBe(false);
    expect(recipe.steps[1]).toMatchObject({
      id: 'deals',
      skip_when: '{{config.enabled}} equal false',
      fail_on: '{{step.deals}} empty',
      stop_when: '{{step.deals}} is_empty',
      cache: 'any',
    });
  });

  it('returns a recipe with no op-steps structurally unchanged and no bindings', () => {
    const passthrough = testRecipe([
      { id: 'normalize', transform: 'coalesce', values: ['{{config.value}}'] } as RecipeStep,
      { id: 'fetch', ingredient: 'some-ingredient', input: { id: '123' } } as RecipeStep,
    ]);

    const result = resolveConnectionAgnosticRecipe(passthrough, hubspotCtx());

    expect(result.recipe).toEqual(passthrough);
    expect(result.bindings).toEqual([]);
  });

  it.each([
    [
      'dealsearch',
      "malformed canonical op 'dealsearch' — expected '<entity>.<verb>'",
    ],
    [
      'deal.',
      "malformed canonical op 'deal.' — expected '<entity>.<verb>'",
    ],
    [
      'deal.search.extra',
      "malformed canonical op 'deal.search.extra' — expected '<entity>.<verb>'",
    ],
  ])('throws CanonicalOpResolutionError for malformed op %s', (op, message) => {
    expectResolutionError(opStep({ op }), hubspotCtx(), message);
  });

  it('throws when a tool op-step names an operation the pack does not declare', () => {
    // §5 — `widget.search`'s family is not a crm_alias, so it routes to the tool-op
    // path; the default ctx declares only `deal.search`, so the bind fails closed
    // with the tool-op "no operation" error (NOT the retired "not a crm_alias").
    expectResolutionError(
      opStep({ op: 'widget.search' }),
      hubspotCtx(),
      "pack 'pack/recued-core/hubspot' has no operation 'widget.search' for tool op-step 'deals'",
    );
  });

  it('§5 throws on a malformed tool op (multi-dot) even if the catalog declares that exact id', () => {
    // Defense in depth: the validator blocks multi-dot at authoring, but the resolver
    // must also reject a `<family>.<verb>` shape violation so a catalog can't expose
    // an op under a malformed id to a caller that skipped the validator.
    expectResolutionError(
      opStep({ id: 'x', op: 'web.search.extra' }),
      hubspotCtx({ operation_families: [operationRow('web.search.extra', 'post')] }),
      "malformed tool op 'web.search.extra' (step 'x') — expected '<family>.<verb>'",
    );
  });

  it('§5 resolves a tool op-step to a single pass-through catalog fetch + tool binding', () => {
    // A tool op (`web.search`) the pack declares resolves to ONE catalog fetch that
    // KEEPS the op-step id (no __raw split, no projection step) and dispatches the
    // op's args verbatim through the catalog/gateway. The raw response is the op's
    // observable output. The binding is tagged `op_kind: 'tool'` with no crm_alias /
    // vendor_entity (no entity translation) and an empty result_path (pass-through).
    const ctx = hubspotCtx({
      catalog_slug: 'exa-catalog',
      vendor: 'exa',
      operation_families: [operationRow('web.search', 'post')],
    });
    const step = opStep({ id: 'news', op: 'web.search', args: { 'body.query': 'acme news' } });
    const resolved = resolveConnectionAgnosticRecipe(testRecipe([step]), ctx);

    expect(resolved.recipe.steps).toEqual([
      {
        id: 'news',
        ingredient: 'exa-catalog',
        connection: 'hubspot1',
        input: { operation: 'web.search', args: { 'body.query': 'acme news' } },
      },
    ]);
    expect(resolved.bindings).toEqual([
      {
        op_kind: 'tool',
        canonical_op: 'web.search',
        verb: 'search',
        operation: 'web.search',
        catalog_slug: 'exa-catalog',
        connection: 'hubspot1',
        vendor: 'exa',
        step_id: 'news',
        result_path: '',
      },
    ]);
  });

  it('§5 a tool op-step carries skip_when / fail_on / stop_when / cache onto its single fetch', () => {
    const ctx = hubspotCtx({
      catalog_slug: 'exa-catalog',
      operation_families: [operationRow('web.search', 'post')],
    });
    const step = opStep({
      id: 'news',
      op: 'web.search',
      args: {},
      skip_when: '{{config.skip}} equal true',
      fail_on: '{{step.news}} is_null',
      stop_when: '{{step.news}} is_empty',
      cache: 'fresh',
    });
    const resolved = resolveConnectionAgnosticRecipe(testRecipe([step]), ctx);
    expect(resolved.recipe.steps).toEqual([
      {
        id: 'news',
        ingredient: 'exa-catalog',
        connection: 'hubspot1',
        input: { operation: 'web.search', args: {} },
        skip_when: '{{config.skip}} equal true',
        fail_on: '{{step.news}} is_null',
        stop_when: '{{step.news}} is_empty',
        cache: 'fresh',
      },
    ]);
  });

  it('§5 a tool op-step carries foreach onto its single fetch (per-iteration tool dispatch)', () => {
    // Brick 3 — the empirical seam: a tool op resolves to ONE pass-through fetch, so
    // the engine's `foreach` (per-iteration) knob rides it verbatim. `{{item.*}}` in
    // args binds per iteration at execute; the resolver is a pure copy. This is what
    // lets a multi-search recipe (find-company-news) iterate web.search over a company
    // list, each call yielding an `{ ok, result, item }` envelope — a failing call is
    // isolated by the foreach loop itself, not by an `optional` flag.
    const ctx = hubspotCtx({
      catalog_slug: 'exa-catalog',
      vendor: 'exa',
      operation_families: [operationRow('web.search', 'post')],
    });
    const step = opStep({
      id: 'searches',
      op: 'web.search',
      foreach: '{{step.limited}}',
      args: { 'body.query': '{{item.company}} company news' },
    });
    const resolved = resolveConnectionAgnosticRecipe(testRecipe([step]), ctx);
    expect(resolved.recipe.steps).toEqual([
      {
        id: 'searches',
        ingredient: 'exa-catalog',
        connection: 'hubspot1',
        input: { operation: 'web.search', args: { 'body.query': '{{item.company}} company news' } },
        foreach: '{{step.limited}}',
      },
    ]);
    expect(resolved.bindings[0]).toMatchObject({ op_kind: 'tool', step_id: 'searches' });
  });

  it('throws when the verb is not canonical even if the pack has that operation id', () => {
    expectResolutionError(
      opStep({ op: 'deal.get' }),
      hubspotCtx({ operation_families: [operationRow('deal.get', 'get')] }),
      "canonical op 'deal.get' verb 'get' is not a canonical CRM verb (read | search | create | update | delete) — vendor-specific ops are not reachable through a canonical op",
    );
  });

  it('throws when the vendor does not model the crm_alias', () => {
    expectResolutionError(
      opStep(),
      hubspotCtx({ vendor: 'linear' }),
      "vendor 'linear' does not model crm_alias 'deal' (canonical op 'deal.search')",
    );
  });

  it('throws when the pack lacks the resolved operation', () => {
    expectResolutionError(
      opStep(),
      hubspotCtx({ operation_families: [operationRow('deal.read', 'get')] }),
      "pack 'pack/recued-core/hubspot' has no operation 'deal.search' for canonical op 'deal.search'",
    );
  });

  it('throws when a search op-step has no catalog-declared search style', () => {
    let thrown: unknown;
    try {
      resolveConnectionAgnosticRecipe(
        testRecipe([opStep()]),
        hubspotCtx({ search_style: undefined }),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CanonicalOpResolutionError);
    expect((thrown as Error).message).toContain('no canonical search-query builder');
  });

  it('throws when there are no projectable entity_fields for the vendor entity', () => {
    expectResolutionError(
      opStep(),
      hubspotCtx({
        entity_fields: [
          entityField({ entity: 'Contact', field_path: 'properties.email', maps_to: 'email' }),
          entityField({
            entity: 'Deal',
            field_path: 'properties.dealname',
            maps_to: 'name',
            applies: 'request',
          }),
        ],
      }),
      "pack 'pack/recued-core/hubspot' declares no projectable entity_fields for 'deal' (canonical op 'deal.search')",
    );
  });

  it('throws when two entity_fields map the same canonical field (duplicate maps_to)', () => {
    // The read projection is last-wins while the search reverse map is first-wins,
    // so a duplicate `maps_to` pointing at DIFFERENT vendor fields would read one
    // field and filter/sort another — fail closed instead.
    expectResolutionError(
      opStep(),
      hubspotCtx({
        entity_fields: [
          entityField({ entity: 'Deal', field_path: 'properties.dealname', maps_to: 'name' }),
          entityField({ entity: 'Deal', field_path: 'properties.dealstage', maps_to: 'stage' }),
          // second row collides on `stage` with a different vendor field.
          entityField({ entity: 'Deal', field_path: 'properties.pipeline', maps_to: 'stage' }),
        ],
      }),
      "pack 'pack/recued-core/hubspot' declares duplicate canonical field 'stage' for 'deal' (canonical op 'deal.search')",
    );
  });

  it('throws when a generated raw step id collides with an existing step id', () => {
    expectResolutionError(
      opStep({ id: 'deals' }),
      hubspotCtx(),
      "generated raw step id 'deals__raw' (from canonical op 'deal.search') collides with an existing step id",
      [{ id: 'deals__raw', transform: 'coalesce', values: [] } as RecipeStep],
    );
  });
});

// ────────────────────────────────────────────────────────────────
// SMB-finance slice 5b — accounting canonical op-steps (acct_alias).
// The same recipe (`invoice.search`) dispatches to either by-value
// accounting pack (quickbooks-accounting / xero-accounting), picked by
// the bound connection's vendor, and each vendor's raw record projects
// to the SAME canonical field names. READ-ONLY (search / read).
// ────────────────────────────────────────────────────────────────

const acctRegistryEntry = (
  vendor: string,
  entity: string,
): ConnectionVendorEntity => ({
  vendor,
  entity,
  scope: `connection.api.${vendor}.${entity}`,
  display_name: `${vendor} ${entity}`,
  acct_alias: entity as ConnectionVendorEntity['acct_alias'],
  meta_fields: [{ key: 'id', type: 'string', source_path: 'Id', description: 'id' }],
});

// QuickBooks: raw PascalCase QBO fields; AR list under QueryResponse.Invoice.
const quickbooksAcctCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/accounting-quickbooks',
  vendor: 'quickbooks',
  connection: 'acct1',
  catalog_slug: 'quickbooks-accounting',
  result_path: 'QueryResponse.Invoice',
  operation_families: [operationRow('invoice.search', 'get'), operationRow('invoice.read', 'get')],
  entity_fields: [
    entityField({ entity: 'invoice', field_path: 'Id', maps_to: 'id' }),
    entityField({ entity: 'invoice', field_path: 'Balance', maps_to: 'balance', type: 'number' }),
    entityField({ entity: 'invoice', field_path: 'DueDate', maps_to: 'due_date' }),
    entityField({ entity: 'invoice', field_path: 'CustomerRef.value', maps_to: 'customer_id' }),
  ],
  registry: [acctRegistryEntry('quickbooks', 'invoice')],
  ...overrides,
});

// Xero: different raw field names; AR list under Invoices.
const xeroAcctCtx = (overrides: Partial<PackResolutionContext> = {}): PackResolutionContext => ({
  pack_slug: 'pack/recued-core/accounting-xero',
  vendor: 'xero',
  connection: 'acct1',
  catalog_slug: 'xero-accounting',
  result_path: 'Invoices',
  operation_families: [operationRow('invoice.search', 'get'), operationRow('invoice.read', 'get')],
  entity_fields: [
    entityField({ entity: 'invoice', field_path: 'InvoiceID', maps_to: 'id' }),
    entityField({ entity: 'invoice', field_path: 'AmountDue', maps_to: 'balance', type: 'number' }),
    entityField({ entity: 'invoice', field_path: 'DueDate', maps_to: 'due_date' }),
    entityField({ entity: 'invoice', field_path: 'Contact.ContactID', maps_to: 'customer_id' }),
  ],
  registry: [acctRegistryEntry('xero', 'invoice')],
  ...overrides,
});

const invoiceSearchStep = (overrides: Partial<CanonicalOpStep> = {}): CanonicalOpStep => ({
  id: 'invoices',
  op: 'invoice.search',
  ...overrides,
});

describe('resolveConnectionAgnosticRecipe — accounting (acct_alias)', () => {
  it('dispatches one invoice.search recipe to BOTH QuickBooks and Xero, each projecting its own raw fields', () => {
    const qbo = resolveConnectionAgnosticRecipe(testRecipe([invoiceSearchStep()]), quickbooksAcctCtx());
    const xero = resolveConnectionAgnosticRecipe(testRecipe([invoiceSearchStep()]), xeroAcctCtx());

    // binding: op_kind 'acct', identity vendor_entity, NO crm_alias.
    expect(qbo.bindings[0]).toMatchObject({
      op_kind: 'acct',
      canonical_op: 'invoice.search',
      verb: 'search',
      vendor_entity: 'invoice',
      operation: 'invoice.search',
      catalog_slug: 'quickbooks-accounting',
      vendor: 'quickbooks',
      result_path: 'QueryResponse.Invoice',
    });
    expect(qbo.bindings[0].crm_alias).toBeUndefined();
    expect(qbo.bindings[0].acct_alias).toBe('invoice');
    expect(xero.bindings[0]).toMatchObject({
      op_kind: 'acct',
      vendor_entity: 'invoice',
      catalog_slug: 'xero-accounting',
      vendor: 'xero',
      result_path: 'Invoices',
    });

    // two steps: a raw catalog fetch + a projection KEEPING the op-step id.
    const qboFetch = qbo.recipe.steps[0] as { id: string; ingredient: string; input: { operation: string; args: unknown } };
    expect(qboFetch.id).toBe('invoices__raw');
    expect(qboFetch.ingredient).toBe('quickbooks-accounting');
    expect(qboFetch.input.operation).toBe('invoice.search');
    // accounting search passes args through (the binding's static_query filters).
    expect(qboFetch.input.args).toEqual({});

    // The projection maps the SAME canonical names off DIFFERENT vendor field_paths.
    const qboProj = qbo.recipe.steps[1] as { id: string; transform: string; array: string; expression: Record<string, unknown> };
    expect(qboProj.id).toBe('invoices');
    expect(qboProj.transform).toBe('map');
    expect(qboProj.array).toBe('{{step.invoices__raw.result.QueryResponse.Invoice}}');
    expect(qboProj.expression).toMatchObject({
      balance: '{{item.Balance | number}}',
      due_date: '{{item.DueDate}}',
      customer_id: '{{item.CustomerRef.value}}',
    });

    const xeroProj = xero.recipe.steps[1] as unknown as { array: string; expression: Record<string, unknown> };
    expect(xeroProj.array).toBe('{{step.invoices__raw.result.Invoices}}');
    expect(xeroProj.expression).toMatchObject({
      balance: '{{item.AmountDue | number}}',
      due_date: '{{item.DueDate}}',
      customer_id: '{{item.Contact.ContactID}}',
    });
  });

  it('resolves invoice.read to a single-object projection (selector-only args)', () => {
    const { recipe, bindings } = resolveConnectionAgnosticRecipe(
      testRecipe([{ id: 'inv', op: 'invoice.read', args: { id: '42' } }]),
      quickbooksAcctCtx(),
    );
    expect(bindings[0]).toMatchObject({ op_kind: 'acct', verb: 'read', vendor_entity: 'invoice' });
    const fetch = recipe.steps[0] as unknown as { id: string; input: { operation: string; args: Record<string, unknown> } };
    expect(fetch.id).toBe('inv__raw');
    expect(fetch.input.operation).toBe('invoice.read');
    // the canonical `id` selector neutralizes to the vendor path-param token.
    expect(fetch.input.args).toEqual({ invoice_id: '42' });
    const proj = recipe.steps[1] as { id: string; transform: string };
    expect(proj.id).toBe('inv');
    expect(proj.transform).toBe('project');
  });

  it('rejects a money WRITE verb on a canonical accounting op-step (read-only)', () => {
    expectResolutionErrorContaining(
      { id: 'x', op: 'invoice.create' } as CanonicalOpStep,
      quickbooksAcctCtx(),
      'is not a read verb',
    );
  });

  it('throws when the bound vendor does not model the acct_alias', () => {
    // a Xero connection cannot serve an op whose alias the registry maps only for QBO.
    expectResolutionError(
      invoiceSearchStep(),
      xeroAcctCtx({ registry: [acctRegistryEntry('quickbooks', 'invoice')] }),
      "vendor 'xero' does not model acct_alias 'invoice' (canonical op 'invoice.search')",
    );
  });
});
