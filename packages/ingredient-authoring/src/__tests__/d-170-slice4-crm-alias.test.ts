import { describe, expect, it } from 'vitest';
import type {
  CompositionIngredient,
  CrmAlias,
  IngredientEntity,
  IngredientEntityField,
} from '@recued/contracts';
import { decomposeComposition, validateComposition } from '../index.js';

const readBind = (path = '/crm/v3/objects/deals/{deal_id}') => ({
  kind: 'rest' as const,
  method: 'GET' as const,
  path_template: path,
});

const writeBind = (path = '/crm/v3/objects/deals') => ({
  kind: 'rest' as const,
  method: 'POST' as const,
  path_template: path,
});

const dealFields = (): IngredientEntityField[] => [
  { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
  { field_path: 'properties.dealname', type: 'string', maps_to: 'name', source_operation: 'deal.read' },
  { field_path: 'properties.amount', type: 'number', maps_to: 'amount', optional: true, source_operation: 'deal.read' },
];

const baseComposition = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'hubspot',
  catalog_kind: 'official',
  ingredients: [
    {
      slug: 'hubspot',
      kind: 'http',
      http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
      entities: {
        Deal: { fields: dealFields() },
      },
    },
  ],
  operations: [
    {
      op: 'deal.read',
      ingredient: 'hubspot',
      risk: 'read',
      approval: 'never',
      bind: readBind(),
      description: 'Read one HubSpot deal.',
      idempotency: 'safe',
      cache_ttl_ms: 60_000,
    },
    {
      op: 'deal.create',
      ingredient: 'hubspot',
      risk: 'write',
      approval: 'ask',
      bind: writeBind(),
      description: 'Create a HubSpot deal.',
      idempotency: 'non_idempotent',
      cache_ttl_ms: 0,
    },
  ],
});

const withDealAlias = (): CompositionIngredient => {
  const composition = baseComposition();
  composition.ingredients[0].entities = {
    Deal: { crm_alias: 'deal', fields: dealFields() },
  };
  return composition;
};

const companyEntity = (crmAlias: CrmAlias): IngredientEntity => ({
  crm_alias: crmAlias,
  fields: [
    { field_path: 'id', type: 'string', maps_to: 'id', source_operation: 'deal.read' },
  ],
});

const invalidAlias = 'lead' as unknown as CrmAlias;

// crm_alias VALIDITY + field-canonicality/type issues. The D-190 Slice 3
// required-field COMPLETENESS warn (`composition_entity_crm_alias_missing_required`)
// is an orthogonal dimension asserted in its own tests, so it is excluded here —
// these minimal fixtures intentionally omit most canonical fields.
const crmAliasIssueSummaries = (result: ReturnType<typeof validateComposition>) =>
  result.issues
    .filter(
      (issue) =>
        issue.code.includes('crm_alias') &&
        issue.code !== 'composition_entity_crm_alias_missing_required',
    )
    .map(({ code, severity, path }) => ({ code, severity, path }));

describe('D-170 slice 4 crm_alias composition validation', () => {
  it('accepts one crm_alias entity when its maps_to values are canonical', () => {
    const result = validateComposition(withDealAlias());

    expect(result.valid).toBe(true);
    expect(crmAliasIssueSummaries(result)).toEqual([]);
  });

  it('rejects a crm_alias outside the closed deal/contact/account list', () => {
    const composition = withDealAlias();
    composition.ingredients[0].entities = {
      Deal: { crm_alias: invalidAlias, fields: dealFields() },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(crmAliasIssueSummaries(result)).toEqual([
      {
        code: 'composition_entity_crm_alias_invalid',
        severity: 'error',
        path: 'ingredients[0].entities.Deal.crm_alias',
      },
    ]);
  });

  it('rejects two distinct normalized entities claiming the same crm_alias', () => {
    const composition = withDealAlias();
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields: dealFields() },
      Company: companyEntity('deal'),
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(crmAliasIssueSummaries(result)).toEqual([
      {
        code: 'composition_entity_crm_alias_duplicate',
        severity: 'error',
        path: 'ingredients[0].entities.Company',
      },
    ]);
  });

  it('warns without blocking when a crm_alias entity maps to a non-canonical field', () => {
    const composition = withDealAlias();
    const fields = dealFields();
    fields[1] = { ...fields[1], maps_to: 'frobnicate' };
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(true);
    expect(crmAliasIssueSummaries(result)).toEqual([
      {
        code: 'composition_entity_field_crm_alias_noncanonical',
        severity: 'warn',
        path: 'ingredients[0].entities.Deal.fields[1].maps_to',
      },
    ]);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('does not emit crm_alias validation codes when no entity declares crm_alias', () => {
    const result = validateComposition(baseComposition());

    expect(result.valid).toBe(true);
    expect(crmAliasIssueSummaries(result)).toEqual([]);
  });

  it('rejects two entity keys that normalize to the same id (would decompose to duplicate schemas)', () => {
    // In the nested two-table model the author writes ONE key per entity; two
    // keys that normalize to the same id (`Deal` / `deal`) would decompose to
    // duplicate `entity_id`/`scope` schemas and let split crm/acct aliases dodge
    // the per-entity conflict check — so it fails closed.
    const composition = withDealAlias();
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields: dealFields() },
      deal: { crm_alias: 'deal', fields: dealFields() },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'composition_entity_key_duplicate')).toBe(true);
  });
});

// D-192 S4 — the engagement facet rides the SAME composition→decompose path as
// crm_alias/acct_alias. `validateComposition` runs both the raw-composition
// validator (`composition_entity_engagement_invalid` + the domain conflict) AND,
// via decompose, the entity-schema shape check + the 1×1 dropped warning.
const engagementFacet = { capability: 'always' as const, sync_kind: 'delta_cursor' as const };
const engagementFields = (op = 'deal.read'): IngredientEntityField[] => [
  { field_path: 'activityid', type: 'string', maps_to: 'id', source_operation: op },
  { field_path: 'subject', type: 'string', maps_to: 'subject', source_operation: op },
];
const withEngagement = (over: Partial<IngredientEntity> = {}): CompositionIngredient => {
  const composition = baseComposition();
  composition.ingredients[0].entities = {
    Email: { engagement: engagementFacet, fields: engagementFields(), ...over },
  };
  return composition;
};

describe('D-192 S4 engagement facet composition threading', () => {
  it('accepts an engagement-only entity (no engagement/domain-conflict codes)', () => {
    const result = validateComposition(withEngagement());
    expect(
      result.issues.filter(
        (i) => i.code.includes('engagement') || i.code === 'composition_entity_alias_domain_conflict',
      ),
    ).toEqual([]);
  });

  it('flags an invalid engagement facet with composition_entity_engagement_invalid', () => {
    const result = validateComposition(
      withEngagement({ engagement: { capability: 'always', sync_kind: 'push' } as never }),
    );
    expect(
      result.issues.some((i) => i.code === 'composition_entity_engagement_invalid' && /sync_kind/.test(i.message)),
    ).toBe(true);
  });

  it('flags engagement + crm_alias as a domain conflict', () => {
    const result = validateComposition(withEngagement({ crm_alias: 'deal' }));
    expect(result.issues.some((i) => i.code === 'composition_entity_alias_domain_conflict')).toBe(true);
  });

  it('decompose copies the engagement facet onto the EntitySchemaIngredientInput', () => {
    const artifacts = decomposeComposition[1](withEngagement());
    expect(artifacts.entity_schemas).toHaveLength(1);
    expect(artifacts.entity_schemas?.[0].engagement).toEqual(engagementFacet);
    expect(artifacts.entity_schemas?.[0].crm_alias).toBeUndefined();
  });

  it('warns composition_1x1_engagement_dropped when a 1×1 API path drops the facet', () => {
    const oneByOne: CompositionIngredient = {
      schema_version: 1,
      slug: 'dyn',
      catalog_kind: 'private_byo',
      ingredients: [{
        slug: 'dyn',
        kind: 'http',
        http: { base: 'https://example.crm.dynamics.com', connection: 'dyn' },
        entities: { Email: { engagement: engagementFacet, fields: engagementFields('email.read') } },
      }],
      operations: [{
        op: 'email.read',
        ingredient: 'dyn',
        risk: 'read',
        approval: 'never',
        bind: readBind('/api/data/v9.2/emails({id})'),
        description: 'Read one Dynamics email activity.',
        idempotency: 'safe',
        cache_ttl_ms: 60_000,
      }],
    };
    const artifacts = decomposeComposition[1](oneByOne);
    expect(artifacts.entity_schemas).toBeUndefined();
    expect(artifacts.warnings).toEqual([
      expect.objectContaining({ code: 'composition_1x1_engagement_dropped', path: 'ingredients' }),
    ]);
  });
});

const granularityIssueSummaries = (result: ReturnType<typeof validateComposition>) =>
  result.issues
    .filter((issue) => issue.code.startsWith('composition_entity_field_date_granularity_'))
    .map(({ code, severity, path }) => ({ code, severity, path }));

describe('D-170 G2 date_granularity composition validation', () => {
  it('accepts date_granularity on a datetime row', () => {
    const composition = baseComposition();
    composition.ingredients[0].entities!.Deal.fields.push({
      field_path: 'properties.closedate',
      type: 'datetime',
      maps_to: 'closed_at',
      source_operation: 'deal.read',
      date_granularity: 'date',
    });

    const result = validateComposition(composition);

    expect(granularityIssueSummaries(result)).toEqual([]);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('rejects an invalid date_granularity value', () => {
    const composition = baseComposition();
    composition.ingredients[0].entities!.Deal.fields.push({
      field_path: 'properties.closedate',
      type: 'datetime',
      maps_to: 'closed_at',
      source_operation: 'deal.read',
      date_granularity: 'day' as unknown as IngredientEntityField['date_granularity'],
    });

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(granularityIssueSummaries(result)).toEqual([
      {
        code: 'composition_entity_field_date_granularity_invalid',
        severity: 'error',
        path: 'ingredients[0].entities.Deal.fields[3].date_granularity',
      },
    ]);
  });

  it('rejects date_granularity on a non-datetime row', () => {
    const composition = baseComposition();
    // The `amount` row is a `number` — granularity is meaningless there.
    composition.ingredients[0].entities!.Deal.fields[2] = {
      ...composition.ingredients[0].entities!.Deal.fields[2],
      date_granularity: 'date',
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(granularityIssueSummaries(result)).toEqual([
      {
        code: 'composition_entity_field_date_granularity_type',
        severity: 'error',
        path: 'ingredients[0].entities.Deal.fields[2].date_granularity',
      },
    ]);
  });
});
