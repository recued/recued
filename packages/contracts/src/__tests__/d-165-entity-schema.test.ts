/** D-165 entity-schema contract tests for enum guards, canonical fixtures, and validator tripwires. */

import { describe, it, expect } from 'vitest';

import {
  ENTITY_SCHEMA_MODES,
  META_FIELD_TYPES,
  PROJECTION_MODES,
  assertEntitySchemaIngredientShape,
  assertEntitySchemaIngredientValid,
  isEntitySchemaMode,
  isMetaFieldType,
  isProjectionMode,
} from '../entity-schema.js';
import type {
  EntitySchemaIngredientInput,
  EntitySchemaMode,
  MetaField,
  MetaFieldType,
  ProjectionMode,
} from '../entity-schema.js';

const expectedProjectionModes = [
  'platform_reference',
  'canonical_mirror',
  'contributing_source',
] as const satisfies readonly ProjectionMode[];

const expectedEntitySchemaModes = [
  'static',
  'dynamic_per_connection',
] as const satisfies readonly EntitySchemaMode[];

const expectedMetaFieldTypes = [
  'string',
  'number',
  'boolean',
  'datetime',
  'json',
] as const satisfies readonly MetaFieldType[];

const hubSpotDealPlatformReference = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'recued-core/hubspot',
  wraps_vendor: 'hubspot',
  entity_id: 'deal',
  scope: 'connection.api.hubspot.deal',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  target_id: { fields: ['id'], template: 'hubspot_deal_{id}' },
  crm_alias: 'deal',
  source_operations: {
    list: {
      catalog: 'recued-core/hubspot',
      operation: 'recued-core/hubspot.deals.search',
    },
    get: {
      catalog: 'recued-core/hubspot',
      operation: 'recued-core/hubspot.deals.get',
    },
    webhook: {
      catalog: 'recued-core/hubspot',
      operation: 'recued-core/hubspot.webhooks.deal_changed',
    },
  },
  meta_fields: [
    {
      key: 'name',
      type: 'string',
      source_path: 'properties.dealname',
      required: true,
    },
    {
      key: 'amount',
      type: 'number',
      source_path: 'properties.amount',
      transform: 'parse_number',
      fallback: 0,
    },
    {
      key: 'stage',
      type: 'string',
      source_path: 'properties.dealstage',
    },
    {
      key: 'owner_email',
      type: 'string',
      source_path: 'properties.hubspot_owner_id',
      transform: 'resolve_owner_email',
    },
  ],
});

const googleContactsContributingSource = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'recued-core/google-contacts',
  wraps_vendor: 'google-contacts',
  entity_id: 'contact',
  scope: 'data.contact',
  projection_mode: 'contributing_source',
  schema_mode: 'static',
  target_id: { fields: ['primary_email'], template: '{primary_email}' },
  source_operations: {
    list: {
      catalog: 'recued-core/google-contacts',
      operation: 'recued-core/google-contacts.people.list',
    },
    get: {
      catalog: 'recued-core/google-contacts',
      operation: 'recued-core/google-contacts.people.get',
    },
  },
  meta_fields: [
    {
      key: 'primary_email',
      type: 'string',
      source_path: 'emailAddresses[0].value',
      required: true,
    },
    {
      key: 'display_name',
      type: 'string',
      source_path: 'names[0].displayName',
    },
    {
      key: 'given_name',
      type: 'string',
      source_path: 'names[0].givenName',
    },
    {
      key: 'family_name',
      type: 'string',
      source_path: 'names[0].familyName',
    },
    {
      key: 'phone',
      type: 'string',
      source_path: 'phoneNumbers[0].value',
    },
  ],
});

const notionDynamicPerConnection = (): Record<string, unknown> => ({
  ingredient_id: 'recued-core/notion',
  wraps_vendor: 'notion',
  entity_id: 'database',
  scope: 'connection.api.notion.database',
  projection_mode: 'platform_reference',
  schema_mode: 'dynamic_per_connection',
  target_id: {
    fields: ['database_id'],
    template: 'notion_db_{database_id}',
  },
  source_operations: {
    get: {
      catalog: 'recued-core/notion',
      operation: 'recued-core/notion.databases.retrieve',
    },
  },
  schema_discovery_operation: 'recued-core/notion.databases.retrieve',
});

const notionDynamicWithEmptyMetaFields = (): EntitySchemaIngredientInput => ({
  ...(notionDynamicPerConnection() as Omit<
    EntitySchemaIngredientInput,
    'meta_fields'
  >),
  meta_fields: [],
});

const mailCanonicalMirror = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'recued-core/gmail',
  wraps_vendor: 'gmail',
  entity_id: 'message',
  scope: 'data.mail',
  projection_mode: 'canonical_mirror',
  schema_mode: 'static',
  target_id: { fields: ['id'], template: 'gmail_message_{id}' },
  source_operations: {
    list: {
      catalog: 'recued-core/gmail',
      operation: 'recued-core/gmail.messages.list',
    },
  },
  meta_fields: [
    {
      key: 'subject',
      type: 'string',
      source_path: 'payload.headers.Subject',
    },
  ],
});

const expectNoIssues = (entry: unknown): void => {
  expect(assertEntitySchemaIngredientShape(entry)).toEqual([]);
};

const expectIssueContaining = (entry: unknown, substring: string): void => {
  expect(assertEntitySchemaIngredientShape(entry)).toEqual(
    expect.arrayContaining([expect.stringContaining(substring)]),
  );
};

describe('D-165 entity-schema exported type surface', () => {
  it('compiles typed literals for modes, meta fields, and ingredient inputs', () => {
    const projectionMode: ProjectionMode = 'canonical_mirror';
    const schemaMode: EntitySchemaMode = 'static';
    const fieldType: MetaFieldType = 'datetime';
    const metaField: MetaField = {
      key: 'key_dates.close_date',
      type: fieldType,
      description: 'Expected close date',
      required: false,
      source_path: 'properties.closedate',
      transform: 'parse_iso',
      fallback: null,
    };
    const ingredient: EntitySchemaIngredientInput = {
      ...mailCanonicalMirror(),
      projection_mode: projectionMode,
      schema_mode: schemaMode,
      meta_fields: [metaField],
    };

    expect(ingredient.projection_mode).toBe('canonical_mirror');
    expect(ingredient.meta_fields?.[0]).toBe(metaField);
  });
});

describe('D-165 entity-schema canonical fixtures', () => {
  it.each([
    ['HubSpot deal platform_reference', hubSpotDealPlatformReference],
    ['Google Contacts contributing_source', googleContactsContributingSource],
    ['Notion dynamic_per_connection platform_reference', notionDynamicPerConnection],
  ])('%s produces zero validator issues', (_name, fixture) => {
    expectNoIssues(fixture());
  });
});

describe('D-165 projection-mode scope validation', () => {
  it('rejects platform_reference with a bare data.mail scope', () => {
    expectIssueContaining(
      { ...hubSpotDealPlatformReference(), scope: 'data.mail' },
      "field 'scope' for projection_mode 'platform_reference'",
    );
  });

  it.each([
    'canonical_mirror',
    'contributing_source',
  ] as const satisfies readonly Exclude<ProjectionMode, 'platform_reference'>[])(
    'rejects %s with a connection.api.* scope',
    (projectionMode) => {
      expectIssueContaining(
        {
          ...hubSpotDealPlatformReference(),
          projection_mode: projectionMode,
          scope: 'connection.api.hubspot.deal',
        },
        `field 'scope' for projection_mode '${projectionMode}' must start with 'data.'`,
      );
    },
  );

  it('accepts publisher-scoped platform_reference and data.mail canonical_mirror scopes', () => {
    expectNoIssues({
      ...hubSpotDealPlatformReference(),
      scope: 'data.entity.acme.slug.deal',
    });
    expectNoIssues(mailCanonicalMirror());
  });

  it('rejects platform_reference connection.api.* scopes that mismatch wraps_vendor/entity_id', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        scope: 'connection.api.salesforce.opportunity',
      },
      "connection.api.hubspot.deal",
    );
  });
});

describe('D-165 wraps_vendor validation', () => {
  it('accepts hyphenated vendor identifiers', () => {
    expectNoIssues(googleContactsContributingSource());
  });

  it('rejects space/caps vendor identifiers', () => {
    expectIssueContaining(
      {
        ...googleContactsContributingSource(),
        wraps_vendor: 'Google Contacts',
      },
      "field 'wraps_vendor' must match",
    );
  });
});

describe('D-165 source_path leniency', () => {
  it.each([
    'emailAddresses[0].value',
    '$..author',
    "$['Due Date']",
  ])('accepts %s without source_path issues', (sourcePath) => {
    expectNoIssues({
      ...hubSpotDealPlatformReference(),
      meta_fields: [
        {
          key: 'source_value',
          type: 'string',
          source_path: sourcePath,
        },
      ],
    });
  });

  it.each(['', '   '])('rejects blank source_path %j', (sourcePath) => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          {
            key: 'source_value',
            type: 'string',
            source_path: sourcePath,
          },
        ],
      },
      'source_path must be a non-empty string',
    );
  });
});

describe('D-165 schema_discovery_operation validation', () => {
  it('requires schema_discovery_operation when schema_mode is dynamic_per_connection', () => {
    const dynamicWithoutDiscovery = notionDynamicWithEmptyMetaFields();
    delete (dynamicWithoutDiscovery as unknown as Record<string, unknown>)
      .schema_discovery_operation;

    expectIssueContaining(
      dynamicWithoutDiscovery,
      "field 'schema_discovery_operation' is required",
    );
  });

  it('allows schema_discovery_operation on static schemas when it is non-empty', () => {
    expectNoIssues({
      ...hubSpotDealPlatformReference(),
      schema_discovery_operation: 'recued-core/hubspot.properties.retrieve',
    });
  });
});

describe('D-165 meta_fields validation', () => {
  it('rejects duplicate keys', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          { key: 'name', type: 'string', source_path: 'properties.dealname' },
          { key: 'name', type: 'string', source_path: 'properties.name_copy' },
        ],
      },
      "duplicates an earlier entry",
    );
  });

  it('rejects a type outside META_FIELD_TYPES', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          { key: 'score', type: 'integer', source_path: 'properties.score' },
        ],
      },
      'type must be one of string / number / boolean / datetime / json',
    );
  });

  it('rejects invalid privacy kinds and accepts the email privacy kind', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          {
            key: 'owner_email',
            type: 'string',
            source_path: 'properties.owner_email',
            privacy: 'secret',
          },
        ],
      },
      'privacy must be a valid EntityFieldPrivacy kind',
    );

    expectNoIssues({
      ...hubSpotDealPlatformReference(),
      meta_fields: [
        {
          key: 'owner_email',
          type: 'string',
          source_path: 'properties.owner_email',
          privacy: 'email',
        },
      ],
    });
  });

  it('rejects keys outside the canonical lowercase dotted regex', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          { key: 'Owner Email', type: 'string', source_path: 'properties.email' },
        ],
      },
      'key must match',
    );
  });

  it('G2 — accepts date_granularity on a datetime field (3rd-party authoring)', () => {
    expectNoIssues({
      ...hubSpotDealPlatformReference(),
      meta_fields: [
        { key: 'closed_at', type: 'datetime', source_path: 'properties.closedate', date_granularity: 'date' },
        { key: 'updated_at', type: 'datetime', source_path: 'properties.hs_lastmodifieddate', date_granularity: 'datetime' },
        // datetime without granularity is fine (the field just isn't server-filterable).
        { key: 'created_at', type: 'datetime', source_path: 'properties.createdate' },
      ],
    });
  });

  it('G2 — rejects an invalid date_granularity value', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          { key: 'closed_at', type: 'datetime', source_path: 'properties.closedate', date_granularity: 'day' },
        ],
      },
      "date_granularity must be 'date' or 'datetime' when present",
    );
  });

  it('G2 — rejects date_granularity on a non-datetime field', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        meta_fields: [
          { key: 'amount', type: 'number', source_path: 'properties.amount', date_granularity: 'date' },
        ],
      },
      "date_granularity is only valid on a 'datetime' field (got type 'number')",
    );
  });
});

describe('D-165 source_operations validation', () => {
  it('rejects an empty source_operations object', () => {
    expectIssueContaining(
      { ...hubSpotDealPlatformReference(), source_operations: {} },
      'at least one source operation',
    );
  });

  it.each([
    ['catalog', { list: { operation: 'recued-core/hubspot.deals.search' } }],
    ['operation', { list: { catalog: 'recued-core/hubspot' } }],
  ])('rejects a source operation missing %s', (_missing, sourceOperations) => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        source_operations: sourceOperations,
      },
      "source_operations['list'] must be { catalog: string; operation: string }",
    );
  });
});

describe('D-165 target_id validation', () => {
  it.each([
    ['missing fields array', { template: 'hubspot_deal_{id}' }],
    ['empty fields array', { fields: [], template: 'hubspot_deal_{id}' }],
  ])('rejects %s', (_name, targetId) => {
    expectIssueContaining(
      { ...hubSpotDealPlatformReference(), target_id: targetId },
      "field 'target_id.fields' must be a non-empty array",
    );
  });

  it('rejects a missing target_id template', () => {
    expectIssueContaining(
      {
        ...hubSpotDealPlatformReference(),
        target_id: { fields: ['id'] },
      },
      "field 'target_id.template' must be a non-empty string",
    );
  });
});

describe('D-165 crm_alias validation', () => {
  it('accepts the deal CRM alias', () => {
    expectNoIssues({ ...hubSpotDealPlatformReference(), crm_alias: 'deal' });
  });

  it('rejects CRM aliases outside the closed list', () => {
    expectIssueContaining(
      { ...hubSpotDealPlatformReference(), crm_alias: 'widget' },
      "field 'crm_alias' must be one of",
    );
  });
});

describe('D-192 S4 engagement facet validation', () => {
  it('accepts a well-formed engagement facet (no crm/acct alias)', () => {
    expectNoIssues({
      ...hubSpotDealPlatformReference(),
      crm_alias: undefined,
      engagement: { capability: 'always', sync_kind: 'delta_cursor' },
    });
  });

  it('rejects a malformed engagement facet via the shared shape validator', () => {
    expectIssueContaining(
      { ...hubSpotDealPlatformReference(), crm_alias: undefined, engagement: { capability: 'always', sync_kind: 'push' } },
      'engagement.sync_kind must be one of',
    );
  });

  it('rejects engagement + crm_alias (mutually exclusive — a third category)', () => {
    expectIssueContaining(
      { ...hubSpotDealPlatformReference(), crm_alias: 'deal', engagement: { capability: 'always', sync_kind: 'poll' } },
      "field 'engagement' is mutually exclusive with 'crm_alias' / 'acct_alias'",
    );
  });
});

describe('D-165 assertEntitySchemaIngredientValid', () => {
  it('does not throw for a valid entry', () => {
    expect(() => assertEntitySchemaIngredientValid(hubSpotDealPlatformReference())).not.toThrow();
  });

  it('throws with validator issues for an invalid entry', () => {
    expect(() =>
      assertEntitySchemaIngredientValid({
        ...hubSpotDealPlatformReference(),
        crm_alias: 'widget',
      } as unknown as EntitySchemaIngredientInput),
    ).toThrow(/crm_alias/);
  });
});

describe('D-165 enum arrays and guards', () => {
  it('keeps PROJECTION_MODES exactly aligned with the spec union', () => {
    expect(PROJECTION_MODES).toEqual(expectedProjectionModes);
    expect(PROJECTION_MODES).toHaveLength(3);
  });

  it.each(expectedProjectionModes)('isProjectionMode accepts %s', (mode) => {
    expect(isProjectionMode(mode)).toBe(true);
  });

  it.each(['', 'projection', 'platform-reference', 42, null])(
    'isProjectionMode rejects %j',
    (value) => {
      expect(isProjectionMode(value)).toBe(false);
    },
  );

  it('keeps ENTITY_SCHEMA_MODES exactly aligned with the spec union', () => {
    expect(ENTITY_SCHEMA_MODES).toEqual(expectedEntitySchemaModes);
    expect(ENTITY_SCHEMA_MODES).toHaveLength(2);
  });

  it.each(expectedEntitySchemaModes)('isEntitySchemaMode accepts %s', (mode) => {
    expect(isEntitySchemaMode(mode)).toBe(true);
  });

  it.each(['', 'dynamic_per_subresource', 'STATIC', false, undefined])(
    'isEntitySchemaMode rejects %j',
    (value) => {
      expect(isEntitySchemaMode(value)).toBe(false);
    },
  );

  it('keeps META_FIELD_TYPES exactly aligned with the spec union', () => {
    expect(META_FIELD_TYPES).toEqual(expectedMetaFieldTypes);
    expect(META_FIELD_TYPES).toHaveLength(5);
  });

  it.each(expectedMetaFieldTypes)('isMetaFieldType accepts %s', (fieldType) => {
    expect(isMetaFieldType(fieldType)).toBe(true);
  });

  it.each(['', 'date', 'string[]', 'object', {}, undefined])(
    'isMetaFieldType rejects %j',
    (value) => {
      expect(isMetaFieldType(value)).toBe(false);
    },
  );
});
