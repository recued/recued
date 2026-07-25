/**
 * Connection-agnostic op dispatch (slice 2) — `entityFieldsFromRegistry`.
 *
 * The registry is the SINGLE, frozen vendor→canonical mapping source: the
 * install resolver projects op results to canonical fields from these rows
 * (NOT from any pack-authored mapping). Proves the helper:
 *   - covers a vendor's `crm_alias` entities (deal/contact/account family);
 *   - maps canonical key → vendor `source_path` (HubSpot nested `properties.*`,
 *     Salesforce FLAT) with the registry entity name + response-side metadata;
 *   - PROJECTS computed fields via their `derivation` (`close_state` closed_state,
 *     `name` concat — D-190) and SKIPS the still-source-less `mailing_address` (G3);
 *   - returns `[]` for a non-CRM vendor.
 * Spec: internal design notes.
 */
import { describe, it, expect } from 'vitest';
import {
  CONNECTION_VENDOR_ENTITIES,
  entityFieldsFromRegistry,
  vendorEntitiesFromComposition,
} from '../index.js';
import type { EntityFieldRow, EntitySchemaIngredientInput } from '../index.js';

const byMapsTo = (rows: EntityFieldRow[], entity: string): Map<string, EntityFieldRow> =>
  new Map(rows.filter((r) => r.entity === entity).map((r) => [r.maps_to, r]));

describe('entityFieldsFromRegistry (slice 2 — registry is the single mapping source)', () => {
  it('hubspot — projects deal/contact/company; nested properties.* paths; close_state + name via derivation; skips source-less mailing_address', () => {
    const rows = entityFieldsFromRegistry('hubspot');
    expect(new Set(rows.map((r) => r.entity))).toEqual(new Set(['deal', 'contact', 'company']));

    const deals = byMapsTo(rows, 'deal');
    expect(deals.get('name')?.field_path).toBe('properties.dealname');
    expect(deals.get('stage')?.field_path).toBe('properties.dealstage');
    expect(deals.get('amount')?.field_path).toBe('properties.amount');
    expect(deals.get('owner')?.field_path).toBe('properties.hubspot_owner_id');
    expect(deals.get('pipeline')?.field_path).toBe('properties.pipeline');
    // PROJECTED via the closed_state derivation (the G3 lift) — no single
    // source_path, but the row carries a derivation + its closed flag field_path.
    expect(deals.has('close_state')).toBe(true);
    expect(deals.get('close_state')?.derivation).toEqual({
      kind: 'closed_state',
      closed_path: 'properties.hs_is_closed',
      won_path: 'properties.hs_is_closed_won',
    });
    expect(deals.get('close_state')?.field_path).toBe('properties.hs_is_closed');

    const contacts = byMapsTo(rows, 'contact');
    expect(contacts.get('email')?.field_path).toBe('properties.email');
    // PROJECTED via the concat derivation (D-190 — first + last, space-joined, email
    // local-part fallback); `field_path` carries the primary input (firstname).
    expect(contacts.has('name')).toBe(true);
    expect(contacts.get('name')?.derivation).toEqual({
      kind: 'concat',
      parts: ['properties.firstname', 'properties.lastname'],
      separator: ' ',
      fallback_path: 'properties.email',
      fallback_transform: 'local_part',
    });
    expect(contacts.get('name')?.field_path).toBe('properties.firstname');
    // The structured address object stays non-projectable (no source_path / derivation).
    expect(contacts.has('mailing_address')).toBe(false);
    // PROJECTABLE name parts — also their own canonical fields (a `contact.read`/`search`
    // projects first_name/last_name directly alongside the derived `name`).
    expect(contacts.get('first_name')?.field_path).toBe('properties.firstname');
    expect(contacts.get('last_name')?.field_path).toBe('properties.lastname');

    // every row is response-side + reviewed (frozen registry mapping).
    for (const r of rows) {
      expect(r.applies).toBe('response');
      expect(r.reviewed).toBe(true);
    }
  });

  it('salesforce — canonical deal→opportunity with FLAT (no properties.) paths; domain←Website', () => {
    const rows = entityFieldsFromRegistry('salesforce');
    expect(new Set(rows.map((r) => r.entity))).toEqual(new Set(['opportunity', 'contact', 'account']));

    const opps = byMapsTo(rows, 'opportunity');
    expect(opps.get('name')?.field_path).toBe('Name'); // flat — SOQL records are top-level
    expect(opps.get('stage')?.field_path).toBe('StageName');
    expect(opps.get('amount')?.field_path).toBe('Amount');
    // PROJECTED via the closed_state derivation (cross-vendor with hubspot).
    expect(opps.has('close_state')).toBe(true);
    expect(opps.get('close_state')?.derivation).toEqual({
      kind: 'closed_state', closed_path: 'IsClosed', won_path: 'IsWon',
    });

    const accounts = byMapsTo(rows, 'account');
    // canonical `domain` ← Salesforce `Website` (cross-vendor with hubspot.company.domain).
    expect(accounts.get('domain')?.field_path).toBe('Website');

    // PROJECTABLE name parts — cross-vendor with hubspot (FirstName/LastName are flat
    // SOQL fields); the derived `name` concat NOW projects too (D-190).
    const sfContacts = byMapsTo(rows, 'contact');
    expect(sfContacts.get('first_name')?.field_path).toBe('FirstName');
    expect(sfContacts.get('last_name')?.field_path).toBe('LastName');
    expect(sfContacts.has('name')).toBe(true);
    expect(sfContacts.get('name')?.derivation).toEqual({
      kind: 'concat', parts: ['FirstName', 'LastName'], separator: ' ', fallback_path: 'Email', fallback_transform: 'local_part',
    });
  });

  it('pipedrive — canonical contact→person and account→organization with flat v2 paths', () => {
    const rows = entityFieldsFromRegistry('pipedrive');
    expect(new Set(rows.map((r) => r.entity))).toEqual(new Set(['deal', 'person', 'organization']));

    const deals = byMapsTo(rows, 'deal');
    expect(deals.get('name')?.field_path).toBe('title');
    expect(deals.get('amount')?.field_path).toBe('value');
    expect(deals.get('close_state')?.field_path).toBe('status');
    expect(deals.get('updated_at')?.field_path).toBe('update_time');

    const people = byMapsTo(rows, 'person');
    expect(people.get('email')?.field_path).toBe('emails.0.value');
    expect(people.get('phone')?.field_path).toBe('phones.0.value');
    expect(people.get('account_id')?.field_path).toBe('org_id');

    const organizations = byMapsTo(rows, 'organization');
    expect(organizations.get('domain')?.field_path).toBe('website');
    expect(organizations.get('annual_revenue')?.field_path).toBe('annual_revenue');
  });

  it('type mapping — number→number, date_ms→datetime, string→string', () => {
    const deals = byMapsTo(entityFieldsFromRegistry('hubspot'), 'deal');
    expect(deals.get('amount')?.type).toBe('number');
    expect(deals.get('key_dates.close_date')?.type).toBe('datetime');
    expect(deals.get('name')?.type).toBe('string');
  });

  it('threads per-field date_granularity onto the EntityFieldRow (G2 request-side filter)', () => {
    // HubSpot: close_date is a DATE field, created_at a DATETIME field.
    const hsDeals = byMapsTo(entityFieldsFromRegistry('hubspot'), 'deal');
    expect(hsDeals.get('key_dates.close_date')?.date_granularity).toBe('date');
    expect(hsDeals.get('key_dates.created_at')?.date_granularity).toBe('datetime');
    expect(hsDeals.get('amount')?.date_granularity).toBeUndefined();
    // Same canonical field, different granularity per vendor: recent_activity_at is a
    // datetime on HubSpot but a Date field on Salesforce — the reason granularity is
    // per-vendor-field, not canonical.
    const hsContacts = byMapsTo(entityFieldsFromRegistry('hubspot'), 'contact');
    const sfContacts = byMapsTo(entityFieldsFromRegistry('salesforce'), 'contact');
    expect(hsContacts.get('recent_activity_at')?.date_granularity).toBe('datetime');
    expect(sfContacts.get('recent_activity_at')?.date_granularity).toBe('date');
  });

  it('non-CRM vendor (no crm_alias entity) → []', () => {
    expect(entityFieldsFromRegistry('notion')).toEqual([]);
  });
});

const pipedriveDealSchema = (
  overrides: Partial<EntitySchemaIngredientInput> = {},
): EntitySchemaIngredientInput => ({
  ingredient_id: 'pipedrive-crm',
  wraps_vendor: 'pipedrive',
  entity_id: 'deal',
  scope: 'connection.api.pipedrive.deal',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  crm_alias: 'deal',
  target_id: { fields: ['id'], template: 'deal_{id}' },
  meta_fields: [
    { key: 'id', type: 'string', source_path: 'id' },
    { key: 'amount', type: 'number', source_path: 'data.value' },
    { key: 'closed', type: 'boolean', source_path: 'data.is_closed' },
  ],
  source_operations: {},
  ...overrides,
});

describe('vendorEntitiesFromComposition (slice 4.5 — 3rd-party registry merge)', () => {
  it('lifts CRM entity schemas into vendor registry entries and skips non-projectable fields', () => {
    const [entity] = vendorEntitiesFromComposition([
      pipedriveDealSchema({
        meta_fields: [
          { key: 'id', type: 'string', source_path: 'id' },
          { key: 'amount', type: 'number', source_path: 'data.value' },
          { key: 'is_closed', type: 'boolean', source_path: 'data.is_closed' },
          { key: 'closed_at', type: 'datetime', source_path: 'data.closed_at' },
          { key: 'payload', type: 'json', source_path: 'data' },
          { key: 'derived', type: 'string' } as unknown as NonNullable<EntitySchemaIngredientInput['meta_fields']>[number],
        ],
      }),
    ]);

    expect(entity).toMatchObject({
      vendor: 'pipedrive',
      entity: 'deal',
      crm_alias: 'deal',
    });
    expect(entity?.meta_fields.map((field) => ({
      key: field.key,
      type: field.type,
      source_path: field.source_path,
    }))).toEqual([
      { key: 'id', type: 'string', source_path: 'id' },
      { key: 'amount', type: 'number', source_path: 'data.value' },
      { key: 'is_closed', type: 'string', source_path: 'data.is_closed' },
      { key: 'closed_at', type: 'date_ms', source_path: 'data.closed_at' },
      { key: 'payload', type: 'object', source_path: 'data' },
    ]);
  });

  it('skips schemas without a crm_alias or wraps_vendor', () => {
    expect(vendorEntitiesFromComposition([
      pipedriveDealSchema({ crm_alias: undefined }),
      pipedriveDealSchema({ wraps_vendor: undefined }),
      pipedriveDealSchema({ wraps_vendor: '' }),
    ])).toEqual([]);
  });

  it('round-trips lifted registry entries back to projectable entity_fields', () => {
    const lifted = vendorEntitiesFromComposition([
      pipedriveDealSchema({
        meta_fields: [
          { key: 'id', type: 'string', source_path: 'id' },
          { key: 'amount', type: 'number', source_path: 'data.value' },
          { key: 'closed_at', type: 'datetime', source_path: 'data.closed_at' },
        ],
      }),
    ]);

    const rows = entityFieldsFromRegistry('pipedrive', [
      ...CONNECTION_VENDOR_ENTITIES,
      ...lifted,
    ]);
    const deal = byMapsTo(rows, 'deal');

    expect(deal.get('id')).toMatchObject({
      entity: 'deal',
      field_path: 'id',
      type: 'string',
    });
    expect(deal.get('amount')).toMatchObject({
      entity: 'deal',
      field_path: 'data.value',
      type: 'number',
    });
    expect(deal.get('closed_at')).toMatchObject({
      entity: 'deal',
      field_path: 'data.closed_at',
      type: 'datetime',
    });
  });

  it('D-192 S4 — lifts an engagement-only entity (no crm/acct alias), carrying the facet', () => {
    const lifted = vendorEntitiesFromComposition([
      pipedriveDealSchema({
        wraps_vendor: 'dynamics',
        entity_id: 'email',
        scope: 'connection.api.dynamics.email',
        crm_alias: undefined,
        engagement: { capability: 'always', sync_kind: 'delta_cursor' },
        meta_fields: [
          { key: 'id', type: 'string', source_path: 'activityid' },
          { key: 'subject', type: 'string', source_path: 'subject' },
        ],
      }),
    ]);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]).toMatchObject({
      vendor: 'dynamics',
      entity: 'email',
      scope: 'connection.api.dynamics.email',
      engagement: { capability: 'always', sync_kind: 'delta_cursor' },
    });
    // a THIRD category — no crm/acct alias smuggled onto the lifted entity.
    expect(lifted[0].crm_alias).toBeUndefined();
    expect(lifted[0].acct_alias).toBeUndefined();
    // its source-pathed fields survive the lift (engagement entities are NOT
    // projected by entityFieldsFromRegistry, but the facet consumers don't read
    // meta_fields — carrying them is harmless).
    expect(lifted[0].meta_fields.map((f) => f.key)).toEqual(['id', 'subject']);
  });

  it('D-192 S4 — a plain entity (no crm_alias / acct_alias / engagement) is still skipped', () => {
    expect(vendorEntitiesFromComposition([
      pipedriveDealSchema({ crm_alias: undefined }), // no engagement either
    ])).toEqual([]);
  });

  it('G2 — carries authored date_granularity flat→lift→projectable row (3rd-party authoring)', () => {
    const lifted = vendorEntitiesFromComposition([
      pipedriveDealSchema({
        meta_fields: [
          { key: 'id', type: 'string', source_path: 'id' },
          // A `datetime` composition field authors granularity; the lift maps it to a
          // `date_ms` registry field carrying the same granularity (the search builder
          // needs it to emit the right vendor date literal).
          { key: 'closed_at', type: 'datetime', date_granularity: 'date', source_path: 'data.closed_at' },
          { key: 'updated_at', type: 'datetime', date_granularity: 'datetime', source_path: 'data.update_time' },
          // A `datetime` field WITHOUT granularity stays unannotated (filter fails closed downstream).
          { key: 'expected_at', type: 'datetime', source_path: 'data.expected_close_date' },
        ],
      }),
    ]);

    // 1) the lifted registry meta-field carries the authored granularity on a `date_ms` slot.
    const liftedFields = new Map(lifted[0].meta_fields.map((f) => [f.key, f]));
    expect(liftedFields.get('closed_at')).toMatchObject({ type: 'date_ms', date_granularity: 'date' });
    expect(liftedFields.get('updated_at')).toMatchObject({ type: 'date_ms', date_granularity: 'datetime' });
    expect(liftedFields.get('expected_at')?.date_granularity).toBeUndefined();

    // 2) it survives the projection back to the request/response EntityFieldRow.
    const deal = byMapsTo(
      entityFieldsFromRegistry('pipedrive', [...CONNECTION_VENDOR_ENTITIES, ...lifted]),
      'deal',
    );
    expect(deal.get('closed_at')?.date_granularity).toBe('date');
    expect(deal.get('updated_at')?.date_granularity).toBe('datetime');
    expect(deal.get('expected_at')?.date_granularity).toBeUndefined();
  });
});
