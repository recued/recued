import { describe, expect, it } from 'vitest';
import type {
  CompositionIngredient,
  IngredientEntityField,
} from '@recued/contracts';
import { validateComposition } from '../index.js';

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
  { field_path: 'properties.dealstage', type: 'string', maps_to: 'stage', source_operation: 'deal.read' },
  { field_path: 'properties.amount', type: 'number', maps_to: 'amount', source_operation: 'deal.read' },
  { field_path: 'properties.hubspot_owner_id', type: 'string', maps_to: 'owner', source_operation: 'deal.read' },
  { field_path: 'properties.hs_is_closed', type: 'string', maps_to: 'close_state', source_operation: 'deal.read' },
  { field_path: 'properties.closedate', type: 'datetime', maps_to: 'key_dates.close_date', source_operation: 'deal.read' },
  { field_path: 'properties.createdate', type: 'datetime', maps_to: 'key_dates.created_at', source_operation: 'deal.read' },
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

const issueSummaries = (
  result: ReturnType<typeof validateComposition>,
  code: string,
) =>
  result.issues
    .filter((issue) => issue.code === code)
    .map(({ code: issueCode, severity, path }) => ({ code: issueCode, severity, path }));

const errors = (result: ReturnType<typeof validateComposition>) =>
  result.issues.filter((issue) => issue.severity === 'error');

describe('D-190 Slice 3 crm_alias decompose-time conformance', () => {
  it('rejects a canonical amount field authored with a non-conforming pack type', () => {
    const composition = withDealAlias();
    const fields = dealFields();
    fields[3] = { ...fields[3], type: 'string' };
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(issueSummaries(result, 'composition_entity_field_crm_alias_type_mismatch')).toEqual([
      {
        code: 'composition_entity_field_crm_alias_type_mismatch',
        severity: 'error',
        path: 'ingredients[0].entities.Deal.fields[3].type',
      },
    ]);
  });

  it('warns, without invalidating, when a crm_alias deal entity omits a required canonical field', () => {
    const composition = withDealAlias();
    const fields = dealFields().filter((field) => field.maps_to !== 'owner');
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(true);
    expect(errors(result)).toEqual([]);
    expect(issueSummaries(result, 'composition_entity_crm_alias_missing_required')).toEqual([
      {
        code: 'composition_entity_crm_alias_missing_required',
        severity: 'warn',
        path: 'ingredients[0].entities.Deal',
      },
    ]);
  });

  it('warns when two fields on one crm_alias entity share a maps_to value', () => {
    const composition = withDealAlias();
    const fields = dealFields();
    fields.push({
      field_path: 'properties.alternate_name',
      type: 'string',
      maps_to: 'name',
      source_operation: 'deal.read',
    });
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields },
    };

    const result = validateComposition(composition);

    expect(issueSummaries(result, 'composition_entity_field_crm_alias_duplicate_maps_to')).toEqual([
      {
        code: 'composition_entity_field_crm_alias_duplicate_maps_to',
        severity: 'warn',
        path: 'ingredients[0].entities.Deal.fields[8].maps_to',
      },
    ]);
  });

  it('warns when a crm_alias field maps_to a non-canonical field name', () => {
    const composition = withDealAlias();
    const fields = dealFields();
    fields.push({
      field_path: 'properties.frobnicate',
      type: 'boolean',
      maps_to: 'frobnicate',
      source_operation: 'deal.read',
    });
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(true);
    expect(errors(result)).toEqual([]);
    expect(issueSummaries(result, 'composition_entity_field_crm_alias_noncanonical')).toEqual([
      {
        code: 'composition_entity_field_crm_alias_noncanonical',
        severity: 'warn',
        path: 'ingredients[0].entities.Deal.fields[8].maps_to',
      },
    ]);
  });

  it('rejects boolean on a canonical string field instead of false-passing it as string', () => {
    const composition = withDealAlias();
    const fields = dealFields();
    fields[1] = { ...fields[1], type: 'boolean' };
    composition.ingredients[0].entities = {
      Deal: { crm_alias: 'deal', fields },
    };

    const result = validateComposition(composition);

    expect(result.valid).toBe(false);
    expect(issueSummaries(result, 'composition_entity_field_crm_alias_type_mismatch')).toEqual([
      {
        code: 'composition_entity_field_crm_alias_type_mismatch',
        severity: 'error',
        path: 'ingredients[0].entities.Deal.fields[1].type',
      },
    ]);
  });
});
