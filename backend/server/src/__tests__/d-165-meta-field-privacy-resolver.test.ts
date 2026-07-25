/** D-165 — MetaField.privacy resolver for the D-167 egress seam. */

import Database from 'better-sqlite3';
import type { EntitySchemaIngredientInput, IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { describe, expect, it } from 'vitest';

import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  createMetaFieldPrivacyResolver,
  createMetaFieldPrivacyResolverFromLocalManifestStore,
  normalizeMetaFieldSourcePathForPii,
} from '../meta-field-privacy-resolver.js';

const manifest = (slug = 'hubspot'): IngredientManifest => ({
  slug,
  version: 1,
  name: `${slug} catalog`,
  description: 'Test catalog.',
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    'contact.read': {
      operation_id: `recued-core/${slug}.contact.read`,
      risk_tier: 'read',
    },
    'contact.search': {
      operation_id: `recued-core/${slug}.contact.search`,
      risk_tier: 'read',
    },
  },
});

const contactSchema = (overrides: Partial<EntitySchemaIngredientInput> = {}): EntitySchemaIngredientInput => ({
  ingredient_id: 'hubspot',
  wraps_vendor: 'hubspot',
  entity_id: 'contact',
  scope: 'connection.api.hubspot.contact',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  target_id: { fields: ['id'], template: 'contact_{id}' },
  meta_fields: [
    {
      key: 'email',
      type: 'string',
      source_path: 'properties.email',
      privacy: 'email',
    },
    {
      key: 'full_name',
      type: 'string',
      source_path: 'properties.fullName',
      privacy: 'name',
    },
    {
      key: 'notes',
      type: 'string',
      source_path: 'properties.notes',
      privacy: 'content',
    },
    {
      key: 'score',
      type: 'number',
      source_path: 'properties.score',
    },
  ],
  source_operations: {
    read: { catalog: 'hubspot', operation: 'contact.read' },
  },
  ...overrides,
});

describe('createMetaFieldPrivacyResolverFromLocalManifestStore', () => {
  it('reads installed MetaField.privacy tags and feeds the D-167 alias pass', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      store.put({ manifest: manifest(), entity_schemas: [contactSchema()] });
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(store);
      const packet = {
        prior_tool_calls: [
          {
            tool_name: 'recued-core/hubspot.contact.read',
            args: { email: 'raw-arg-stays-out-of-schema-tags@example.com' },
            status: 'ok',
            result: {
              properties: {
                email: 'alice@example.com',
                fullName: 'Alice Ada',
                notes: 'Alice Ada emailed from alice@example.com.',
                score: 99,
              },
            },
          },
          {
            tool_name: 'recued-core/other.contact.read',
            status: 'ok',
            result: { properties: { email: 'bob@example.com' } },
          },
        ],
      };

      const tags = resolver(packet);
      expect(tags).toEqual(expect.arrayContaining([
        { path: 'prior_tool_calls.0.result.properties.email', kind: 'email' },
        { path: 'prior_tool_calls.0.result.properties.fullName', kind: 'name' },
        { path: 'prior_tool_calls.0.result.properties.notes', kind: 'content' },
      ]));
      expect(tags).not.toEqual(expect.arrayContaining([
        { path: 'prior_tool_calls.0.args.email', kind: 'email' },
        { path: 'prior_tool_calls.0.result.properties.score', kind: 'number' },
        { path: 'prior_tool_calls.1.result.properties.email', kind: 'email' },
      ]));

      const result = piiEgress.aliasPacketForEgress({
        ledger: piiEgress.createSessionLedgerStore().getOrCreate('sess-1'),
        packet,
        resolver,
      });
      const aliased = result.aliased as typeof packet;
      const firstResult = aliased.prior_tool_calls[0]!.result.properties;
      expect(firstResult.email).toBe('m1@d1.invalid');
      expect(firstResult.fullName).toBe('pii.Person1');
      expect(firstResult.notes).toBe('pii.Person1 emailed from m1@d1.invalid.');
      expect(firstResult.score).toBe(99);
      expect((aliased.prior_tool_calls[0]!.args as { email: string }).email).toBe(
        'raw-arg-stays-out-of-schema-tags@example.com',
      );
      expect(aliased.prior_tool_calls[1]!.result.properties.email).toBe('bob@example.com');
      expect(result.summary.counts).toEqual({
        email: 1,
        name: 1,
        content_text_replacements: 2,
      });
    } finally {
      db.close();
    }
  });

  it('reads the local manifest store on each packet resolution', () => {
    const db = new Database(':memory:');
    try {
      const store = createLocalManifestStore(db);
      const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(store);
      const packet = {
        prior_tool_calls: [
          {
            tool_name: 'recued-core/hubspot.contact.read',
            status: 'ok',
            result: { properties: { email: 'alice@example.com' } },
          },
        ],
      };

      expect(resolver(packet)).toEqual([]);
      store.put({ manifest: manifest(), entity_schemas: [contactSchema()] });
      expect(resolver(packet)).toEqual(expect.arrayContaining([
        { path: 'prior_tool_calls.0.result.properties.email', kind: 'email' },
      ]));
    } finally {
      db.close();
    }
  });
});

describe('createMetaFieldPrivacyResolver', () => {
  it('matches catalog operation names and canonical-key fallbacks', () => {
    const resolver = createMetaFieldPrivacyResolver({
      getEntitySchemas: () => [
        contactSchema({
          meta_fields: [
            {
              key: 'primary_email',
              type: 'string',
              source_path: 'contacts[0].email',
              privacy: 'email',
            },
          ],
          source_operations: {
            search: { catalog: 'hubspot', operation: 'contact.search' },
          },
        }),
      ],
    });
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'hubspot.contact.search',
          status: 'ok',
          result: {
            contacts: [{ email: 'alice@example.com' }],
            primary_email: 'bob@example.com',
          },
        },
      ],
    };

    const result = piiEgress.aliasPacketForEgress({
      ledger: piiEgress.createSessionLedgerStore().getOrCreate('sess-1'),
      packet,
      resolver,
    });
    const aliased = result.aliased as typeof packet;
    expect(aliased.prior_tool_calls[0]!.result.contacts[0]!.email).toBe('m1@d1.invalid');
    expect(aliased.prior_tool_calls[0]!.result.primary_email).toBe('m2@d1.invalid');
    expect(result.summary.counts).toEqual({ email: 2 });
  });

  it('operation-scans recall_context records at the same paths as prior_tool_calls', () => {
    const resolver = createMetaFieldPrivacyResolver({
      getEntitySchemas: () => [contactSchema()],
    });
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'hubspot.contact.read',
          status: 'ok',
          result: {
            properties: {
              email: 'alice@example.com',
              fullName: 'Alice Ada',
            },
          },
        },
      ],
      recall_context: [
        {
          tool_name: 'hubspot.contact.read',
          status: 'ok',
          result: {
            properties: {
              email: 'diego@example.com',
              fullName: 'Diego Okafor',
            },
          },
        },
      ],
    };

    expect(resolver(packet)).toEqual(expect.arrayContaining([
      { path: 'prior_tool_calls.0.result.properties.email', kind: 'email' },
      { path: 'prior_tool_calls.0.result.properties.fullName', kind: 'name' },
      { path: 'recall_context.0.result.properties.email', kind: 'email' },
      { path: 'recall_context.0.result.properties.fullName', kind: 'name' },
    ]));
  });

  it('also resolves top-level record envelopes when the packet is not a chat turn body', () => {
    const resolver = createMetaFieldPrivacyResolver({
      getEntitySchemas: () => [contactSchema()],
      getManifest: (slug) => (slug === 'hubspot' ? manifest() : null),
    });
    const packet = {
      operation_id: 'recued-core/hubspot.contact.read',
      result: { properties: { email: 'alice@example.com' } },
    };

    expect(resolver(packet)).toEqual(expect.arrayContaining([
      { path: 'result.properties.email', kind: 'email' },
    ]));
  });
});

describe('normalizeMetaFieldSourcePathForPii', () => {
  it('normalizes the JSONPath subset D-167 dot-paths can honor', () => {
    expect(normalizeMetaFieldSourcePathForPii('$.contacts[0].email')).toBe(
      'contacts.0.email',
    );
    expect(normalizeMetaFieldSourcePathForPii("$['owner email']")).toBe('owner email');
    expect(normalizeMetaFieldSourcePathForPii('$..email')).toBeNull();
    expect(normalizeMetaFieldSourcePathForPii('$.items[*].email')).toBeNull();
  });
});
