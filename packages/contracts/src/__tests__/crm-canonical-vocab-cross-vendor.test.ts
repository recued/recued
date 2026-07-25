import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  buildConnectionVendorEntity,
  canonicalCrmFieldSet,
  getVendorEntityByCrmAlias,
  type ConnectionVendorEntity,
  type CrmAlias,
} from '../index.js';

const readCrmEntity = (
  vendor: 'hubspot' | 'salesforce',
  crmAlias: CrmAlias,
) => {
  const entry = getVendorEntityByCrmAlias(vendor, crmAlias);
  expect(entry).not.toBeNull();
  if (entry === null) {
    throw new Error(`missing CRM entity registration for ${vendor}.${crmAlias}`);
  }
  return entry;
};

const metaFieldsByKey = (entry: Pick<ConnectionVendorEntity, 'meta_fields'>) => {
  return new Map(entry.meta_fields.map((field) => [field.key, field]));
};

const metaFieldKeys = (entry: Pick<ConnectionVendorEntity, 'meta_fields'>) => {
  return entry.meta_fields.map((field) => field.key);
};

const sharedMetaFieldKeys = (crmAlias: CrmAlias) => {
  const hubspotKeys = new Set(metaFieldKeys(readCrmEntity('hubspot', crmAlias)));
  const salesforceKeys = new Set(metaFieldKeys(readCrmEntity('salesforce', crmAlias)));
  return [...hubspotKeys].filter((key) => salesforceKeys.has(key));
};

const sorted = (values: Iterable<string>) => [...values].sort();

const registeredCanonicalKeys = (crmAlias: CrmAlias) => sorted(new Set([
  'id',
  ...CONNECTION_VENDOR_ENTITIES
    .filter((entry) => entry.crm_alias === crmAlias)
    .flatMap((entry) => metaFieldKeys(entry)),
]));

describe('canonical CRM vocabulary portability across HubSpot and Salesforce', () => {
  it('uses account_id for the portable contact account link on both vendors', () => {
    const hubspotContactKeys = metaFieldKeys(readCrmEntity('hubspot', 'contact'));
    const salesforceContactKeys = metaFieldKeys(readCrmEntity('salesforce', 'contact'));

    expect(hubspotContactKeys).toContain('account_id');
    expect(salesforceContactKeys).toContain('account_id');

    // Retired vendor-shaped keys must stay absent; reintroducing them
    // breaks connection-agnostic recipes that read one canonical meta key.
    expect(hubspotContactKeys).not.toContain('company_id');
    expect(salesforceContactKeys).not.toContain('company_id');
  });

  it('uses domain for the portable account web domain on both vendors', () => {
    const hubspotAccountKeys = metaFieldKeys(readCrmEntity('hubspot', 'account'));
    const salesforceAccountKeys = metaFieldKeys(readCrmEntity('salesforce', 'account'));

    expect(hubspotAccountKeys).toContain('domain');
    expect(salesforceAccountKeys).toContain('domain');

    // Retired vendor-shaped keys must stay absent; reintroducing them
    // breaks connection-agnostic recipes that read one canonical meta key.
    expect(hubspotAccountKeys).not.toContain('website');
    expect(salesforceAccountKeys).not.toContain('website');
  });

  it('keeps portable renamed fields typed as strings on both vendors', () => {
    const hubspotContactByKey = metaFieldsByKey(readCrmEntity('hubspot', 'contact'));
    const salesforceContactByKey = metaFieldsByKey(readCrmEntity('salesforce', 'contact'));
    const hubspotAccountByKey = metaFieldsByKey(readCrmEntity('hubspot', 'account'));
    const salesforceAccountByKey = metaFieldsByKey(readCrmEntity('salesforce', 'account'));

    expect(hubspotContactByKey.get('account_id')?.type).toBe('string');
    expect(salesforceContactByKey.get('account_id')?.type).toBe('string');
    expect(hubspotAccountByKey.get('domain')?.type).toBe('string');
    expect(salesforceAccountByKey.get('domain')?.type).toBe('string');
  });

  it('keeps each CRM alias shared core portable without pinning vendor-specific extras', () => {
    expect(sharedMetaFieldKeys('deal')).toEqual(expect.arrayContaining([
      'name',
      'stage',
      'amount',
      'owner',
      'key_dates.close_date',
      'key_dates.created_at',
      'forecast_amount',
      'close_state',
    ]));

    expect(sharedMetaFieldKeys('contact')).toEqual(expect.arrayContaining([
      'email',
      'name',
      'lifecycle_stage',
      'owner',
      'account_id',
      'recent_activity_at',
      'phone',
      'mailing_address',
    ]));

    expect(sharedMetaFieldKeys('account')).toEqual(expect.arrayContaining([
      'name',
      'domain',
      'industry',
      'num_employees',
      'owner',
      'annual_revenue',
    ]));
  });

  it('derives canonicalCrmFieldSet from registered CRM meta fields plus id', () => {
    for (const crmAlias of ['deal', 'contact', 'account'] as const) {
      const canonical = canonicalCrmFieldSet(crmAlias);

      expect(sorted(canonical)).toEqual(registeredCanonicalKeys(crmAlias));
      expect(canonical.has('id')).toBe(true);
    }
  });

  it('keeps source-less derived fields in the canonical CRM field set', () => {
    expect(canonicalCrmFieldSet('deal').has('close_state')).toBe(true);
    expect(canonicalCrmFieldSet('contact').has('name')).toBe(true);
    expect(canonicalCrmFieldSet('contact').has('mailing_address')).toBe(true);
  });

  it('restricts canonicalCrmFieldSet to the supplied registry', () => {
    const registry = [
      buildConnectionVendorEntity({
        vendor: 'mini',
        entity: 'deal',
        display_name: 'Mini Deal',
        crm_alias: 'deal',
        meta_fields: [
          { key: 'name', type: 'string', description: 'deal name' },
          { key: 'custom_score', type: 'number', description: 'custom score' },
        ],
      }),
      buildConnectionVendorEntity({
        vendor: 'mini',
        entity: 'contact',
        display_name: 'Mini Contact',
        crm_alias: 'contact',
        meta_fields: [
          { key: 'email', type: 'string', description: 'email' },
        ],
      }),
    ];

    expect(sorted(canonicalCrmFieldSet('deal', registry))).toEqual(['custom_score', 'id', 'name']);
  });

  it('returns only id when a supplied registry has no entity for the alias', () => {
    const registry = [
      buildConnectionVendorEntity({
        vendor: 'mini',
        entity: 'case',
        display_name: 'Mini Case',
        meta_fields: [
          { key: 'title', type: 'string', description: 'case title' },
        ],
      }),
    ];

    expect(sorted(canonicalCrmFieldSet('account', registry))).toEqual(['id']);
  });
});
