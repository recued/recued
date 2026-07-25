import { describe, expect, it } from 'vitest';
import type { BulkPackManifest, CompositionIngredient } from '@recued/contracts';
import {
  compileForReview,
  decomposeComposition,
} from '../index.js';

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

const oneByOneComposition = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'hubspot-contact-read',
  catalog_kind: 'private_byo',
  ingredients: [
    {
      slug: 'hubspot-contact-read',
      kind: 'http',
      http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
      entities: {
        Contact: {
          fields: [
            {
              field_path: 'properties.email',
              type: 'string',
              maps_to: 'email',
              pii: 'email',
              source_operation: 'contact.read',
            },
          ],
        },
      },
    },
  ],
  operations: [
    {
      op: 'contact.read',
      ingredient: 'hubspot-contact-read',
      risk: 'read',
      approval: 'never',
      bind: readBind('/crm/v3/objects/contacts/{contact_id}'),
      description: 'Read one HubSpot contact.',
    },
  ],
});

const multiComposition = (): CompositionIngredient => ({
  schema_version: 1,
  slug: 'hubspot',
  catalog_kind: 'official',
  ingredients: [
    {
      slug: 'hubspot',
      kind: 'http',
      http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
      entities: {
        Deal: {
          fields: [
            {
              field_path: 'id',
              type: 'string',
              maps_to: 'id',
              pii: 'external_id',
              source_operation: 'deal.read',
            },
            {
              field_path: 'properties.email',
              type: 'string',
              maps_to: 'email',
              pii: 'email',
              source_operation: 'deal.read',
            },
            {
              field_path: 'properties.description',
              type: 'string',
              maps_to: 'description',
              pii: 'content',
              optional: true,
              source_operation: 'deal.read',
            },
            {
              field_path: 'properties.amount',
              type: 'number',
              maps_to: 'amount',
              optional: true,
              source_operation: 'deal.read',
            },
          ],
        },
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
    },
    {
      op: 'deal.create',
      ingredient: 'hubspot',
      risk: 'write',
      approval: 'ask',
      bind: writeBind(),
      description: 'Create a HubSpot deal.',
    },
  ],
});

const packWithComposition = (composition = multiComposition()): BulkPackManifest => ({
  manifest_version: 2,
  slug: 'hubspot-crm',
  publisher: 'recued-core',
  name: 'HubSpot CRM',
  description: 'HubSpot operations and entity schemas.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: ['hubspot', 'crm'],
  pack_kind: 'app_pack',
  contents: [
    { type: 'composition', composition },
    { type: 'recipe', slug: 'hubspot-starter-flow', version: 1 },
  ],
});

const codes = (view: { issues: Array<{ code: string }> }): string[] =>
  view.issues.map((issue) => issue.code);

describe('D-170 N.12 compile-on-demand review projection', () => {
  it('projects a 1x1 composition into a review summary, operation table, and PII matrix', () => {
    const view = compileForReview(oneByOneComposition());

    expect(view.valid).toBe(true);
    expect(view.summary).toMatchObject({
      catalog_slug: 'hubspot-contact-read',
      catalog_slugs: ['hubspot-contact-read'],
      artifact_shape: '1x1',
      counts: {
        compositions: 1,
        operation_families: 1,
        entity_fields: 1,
        pii_fields: 1,
        pack_contents: 0,
        compiled_outputs: 1,
      },
    });
    expect(view.operation_families).toEqual([
      {
        key: 'contact.read',
        surface: 'api',
        risk_tier: 'read',
        approval_mapping: 'never',
      },
    ]);
    expect(view.field_privacy).toEqual([
      { path: 'properties.email', privacy_kind: 'email' },
    ]);
  });

  it('projects a multi-artifact pack carrying composition content refs', () => {
    const view = compileForReview(packWithComposition());

    expect(view.valid).toBe(true);
    expect(view.summary).toMatchObject({
      catalog_slug: 'hubspot',
      catalog_slugs: ['hubspot'],
      artifact_shape: 'multi',
      counts: {
        compositions: 1,
        operation_families: 2,
        entity_fields: 4,
        pii_fields: 3,
        pack_contents: 2,
        compiled_outputs: 5,
      },
    });
    expect(view.operation_families).toEqual([
      {
        key: 'deal.create',
        surface: 'api',
        risk_tier: 'write',
        approval_mapping: 'ask',
      },
      {
        key: 'deal.read',
        surface: 'api',
        risk_tier: 'read',
        approval_mapping: 'never',
      },
    ]);
    expect(view.field_privacy).toEqual([
      { path: 'id', privacy_kind: 'external_id' },
      { path: 'properties.description', privacy_kind: 'content' },
      { path: 'properties.email', privacy_kind: 'email' },
    ]);
  });

  it('surfaces unknown composition schema versions without throwing', () => {
    const view = compileForReview({ ...multiComposition(), schema_version: 999 });

    expect(view.valid).toBe(false);
    expect(view.summary.artifact_shape).toBe('unknown');
    expect(view.operation_families).toEqual([]);
    expect(codes(view)).toContain('unknown_schema_version');
  });

  it('surfaces decomposer failures as review issues without throwing', () => {
    const original = decomposeComposition[1];
    decomposeComposition[1] = () => {
      throw new Error('review boom');
    };
    try {
      const view = compileForReview(multiComposition());

      expect(view.valid).toBe(false);
      expect(view.summary.artifact_shape).toBe('unknown');
      expect(view.field_privacy).toEqual([]);
      expect(codes(view)).toContain('decompose_failed');
      expect(view.issues.find((issue) => issue.code === 'decompose_failed')?.message).toBe('review boom');
    } finally {
      decomposeComposition[1] = original;
    }
  });

  it('emits deterministic ordering for equivalent composition rows', () => {
    const composition = multiComposition();
    const reordered: CompositionIngredient = {
      ...composition,
      operations: [...composition.operations].reverse(),
      ingredients: composition.ingredients.map((ing) => ({
        ...ing,
        entities: {
          Deal: {
            ...ing.entities!.Deal,
            fields: [...ing.entities!.Deal.fields].reverse(),
          },
        },
      })),
    };

    const first = compileForReview(composition);
    const second = compileForReview(reordered);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
