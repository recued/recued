/** R2 step 6 - write-saga compensation derivation tests. */

import type { IngredientManifest } from '@recued/contracts';
import {
  COMPENSATION_CONNECTION_VARIABLE,
  COMPENSATION_RECIPE_ID_PREFIX,
  deriveCompensation,
  extractCreatedRecordId,
  type LandedCatalogWrite,
} from '@recued/recipes';
import { describe, expect, it } from 'vitest';

const op = (operation_id: string, risk_tier: string): Record<string, unknown> => ({
  operation_id,
  description: `${operation_id} fixture`,
  risk_tier,
  groups: [],
  required_scopes: [],
});

const rest = (method: string, path_template: string): Record<string, unknown> => ({
  kind: 'rest',
  method,
  path_template,
});

const hubspotOperations = (): Record<string, unknown> => ({
  'deal.create': op('recued-core/hubspot.deal.create', 'write'),
  'deal.delete': op('recued-core/hubspot.deal.delete', 'destructive'),
});

const hubspotExecutes = (): Record<string, unknown> => ({
  'deal.create': rest('POST', '/crm/v3/objects/deals'),
  'deal.delete': rest('DELETE', '/crm/v3/objects/deals/{{deal_id}}'),
});

const hubspotCatalog = (
  overrides: {
    operations?: Record<string, unknown>;
    executes?: Record<string, unknown>;
  } = {},
): IngredientManifest => ({
  slug: 'hubspot-catalog',
  name: 'HubSpot catalog fixture',
  description: 'Real-shaped HubSpot catalog fixture for saga compensation.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  input: { operation: null, args: null },
  output: { result: 'result' },
  operations: overrides.operations ?? hubspotOperations(),
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.hubapi.com',
      result_path: 'results',
      search_style: 'hubspot_search',
      write_style: 'hubspot_properties',
      executes: overrides.executes ?? hubspotExecutes(),
    },
  },
} as unknown as IngredientManifest);

const landed = (
  overrides: Partial<LandedCatalogWrite> = {},
): LandedCatalogWrite => ({
  commit_id: 'commit-create-1',
  operation_key: 'deal.create',
  operation_id: 'recued-core/hubspot.deal.create',
  catalog_slug: 'hubspot-catalog',
  connection_name: 'hubspot1',
  output: { result: { id: '31337' } },
  ...overrides,
});

describe('deriveCompensation', () => {
  it('derives a single canonical delete op-step for a landed HubSpot deal create', () => {
    const result = deriveCompensation(landed(), hubspotCatalog());

    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected compensation plan');

    expect(result.predecessor_commit_id).toBe('commit-create-1');
    expect(result.config).toEqual({
      [COMPENSATION_CONNECTION_VARIABLE]: 'hubspot1',
    });
    expect(result.recipe.recipe_id).toBe(
      `${COMPENSATION_RECIPE_ID_PREFIX}commit-create-1`,
    );
    expect(result.recipe.steps).toEqual([
      {
        id: 'undo',
        op: 'deal.delete',
        connection: '{{config.target_connection}}',
        args: { id: '31337' },
      },
    ]);
    expect(result.recipe.output).toEqual({ render: [] });
    expect(result.description).toContain('31337');
    expect(result.description).toContain("'hubspot1'");
    expect(result.description).toContain('recued-core/hubspot.deal.create');
    expect(result.recipe.metadata.description).toContain('31337');
    expect(result.recipe.metadata.description).toContain("'hubspot1'");
  });

  it.each(['deal.update', 'deal.delete'] as const)(
    'does not derive a v1 inverse for %s',
    (operation_key) => {
      expect(
        deriveCompensation(landed({ operation_key }), hubspotCatalog()),
      ).toBeNull();
    },
  );

  it('returns null when the inverse operation row is missing', () => {
    const operations = hubspotOperations();
    delete operations['deal.delete'];

    expect(
      deriveCompensation(landed(), hubspotCatalog({ operations })),
    ).toBeNull();
  });

  it('returns null when the inverse REST execute binding is missing', () => {
    const executes = hubspotExecutes();
    delete executes['deal.delete'];

    expect(
      deriveCompensation(landed(), hubspotCatalog({ executes })),
    ).toBeNull();
  });

  it('returns null when the catalog slug has no registered vendor', () => {
    expect(
      deriveCompensation(
        landed({ catalog_slug: 'private-hubspot-like-catalog' }),
        hubspotCatalog(),
      ),
    ).toBeNull();
  });

  it('returns null when the vendor entity has no crm_alias', () => {
    const manifest = hubspotCatalog({
      operations: {
        'email.create': op('recued-core/hubspot.email.create', 'write'),
        'email.delete': op('recued-core/hubspot.email.delete', 'destructive'),
      },
      executes: {
        'email.create': rest('POST', '/crm/v3/objects/emails'),
        'email.delete': rest('DELETE', '/crm/v3/objects/emails/{{email_id}}'),
      },
    });

    expect(
      deriveCompensation(
        landed({
          operation_key: 'email.create',
          operation_id: 'recued-core/hubspot.email.create',
        }),
        manifest,
      ),
    ).toBeNull();
  });
});

describe('extractCreatedRecordId', () => {
  it.each([
    [{ result: { id: '31337' } }, '31337'],
    [{ result: { Id: '006SF000001AbCdEAF' } }, '006SF000001AbCdEAF'],
    [{ result: { id: 31337 } }, '31337'],
  ] as const)('extracts %s as %s', (output, expected) => {
    expect(extractCreatedRecordId(output)).toBe(expected);
  });

  it.each([
    {},
    { result: null },
    { result: ['31337'] },
    null,
  ])('returns undefined for missing/null/array result %#', (output) => {
    expect(extractCreatedRecordId(output)).toBeUndefined();
  });

  it.each([
    { result: { id: '../../admin' } },
    { result: { id: 'a b' } },
    { result: { id: '' } },
    // leading-alnum rule: no real vendor id starts with '-'/'_', and this
    // also rejects a negative-number coercion (String(-5) = '-5').
    { result: { id: -5 } },
    { result: { id: '-traversal' } },
    { result: { id: '_x' } },
  ])('rejects unsafe id charset %#', (output) => {
    expect(extractCreatedRecordId(output)).toBeUndefined();
  });

  it.each([
    { result: { id: Number.NaN } },
    { result: { id: Number.POSITIVE_INFINITY } },
    { result: { id: Number.NEGATIVE_INFINITY } },
  ])('rejects non-finite numeric ids %#', (output) => {
    expect(extractCreatedRecordId(output)).toBeUndefined();
  });
});
