/** D-130 Phase 4 — Salesforce account vendor-entity registration tests.
 *
 *  Covers the contract surface P4 ships:
 *  - `CONNECTION_VENDOR_ENTITIES` includes `salesforce.account` with
 *    the canonical 6-field meta_fields shape (spec § A.2).
 *  - `SALESFORCE_ACCOUNT_FIELDS` is the 8-field SOQL projection
 *    (spec § Constants).
 *  - Lookup helpers resolve the new entry by scope + (vendor, entity).
 *  - Sales Cloud trio (opportunity + contact + account) coexists in
 *    the registry — closes D-130's Sales Cloud entity coverage.
 *
 *  Reconciler-side concerns (SOQL pagination / hashOf / toMeta /
 *  401-refresh round-trip) live in the backend/server P4 test file. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  SALESFORCE_ACCOUNT_FIELDS,
  composeVendorEntityScope,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
  listRegisteredVendors,
} from '../index.js';

describe('D-130 P4 — salesforce.account entity registration', () => {
  const accountEntry = getVendorEntityByVendorEntity('salesforce', 'account');

  it('is in CONNECTION_VENDOR_ENTITIES with the canonical scope', () => {
    expect(accountEntry).not.toBeNull();
    expect(accountEntry!.scope).toBe('connection.api.salesforce.account');
    expect(accountEntry!.scope).toBe(composeVendorEntityScope('salesforce', 'account'));
  });

  it('declares the 6 canonical meta_fields per spec §A.2', () => {
    expect(accountEntry!.meta_fields.map((f) => f.key)).toEqual([
      // R2 step 6 — response-side canonical record id (find-then-act, §1.3).
      'id',
      'name',
      'domain',
      'industry',
      'num_employees',
      'owner',
      'annual_revenue',
    ]);
  });

  it('uses the right field types', () => {
    const byKey = new Map(accountEntry!.meta_fields.map((f) => [f.key, f.type]));
    expect(byKey.get('name')).toBe('string');
    expect(byKey.get('domain')).toBe('string');
    expect(byKey.get('industry')).toBe('string');
    expect(byKey.get('num_employees')).toBe('number');
    expect(byKey.get('owner')).toBe('string');
    expect(byKey.get('annual_revenue')).toBe('number');
  });

  it('shows up in CONNECTION_VENDOR_ENTITIES list', () => {
    expect(CONNECTION_VENDOR_ENTITIES.some((e) => e.scope === 'connection.api.salesforce.account')).toBe(true);
  });

  it('resolves via getVendorEntityForScope', () => {
    const found = getVendorEntityForScope('connection.api.salesforce.account');
    expect(found).not.toBeNull();
    expect(found!.display_name).toBe('Salesforce Account');
  });

  it('Sales Cloud trio (opportunity + contact + account) coexist in the registry', () => {
    // D-130 P4 baseline asserts the trio ships; D-139 P1b widens with
    // engagement entities (task / event / email_message / voice_call /
    // call_history). The trio invariant survives — assert via subset
    // semantics rather than equality.
    const salesforceEntries = CONNECTION_VENDOR_ENTITIES.filter((e) => e.vendor === 'salesforce');
    const entityNames = new Set(salesforceEntries.map((e) => e.entity));
    expect(entityNames.has('opportunity')).toBe(true);
    expect(entityNames.has('contact')).toBe(true);
    expect(entityNames.has('account')).toBe(true);
  });

  it('listRegisteredVendors still surfaces salesforce alongside hubspot', () => {
    const vendors = listRegisteredVendors();
    expect(vendors).toContain('hubspot');
    expect(vendors).toContain('salesforce');
  });
});

describe('D-130 P4 — SALESFORCE_ACCOUNT_FIELDS', () => {
  it('lists the 8 canonical SOQL projection fields per spec § Constants', () => {
    expect(SALESFORCE_ACCOUNT_FIELDS).toEqual([
      'Id',
      'Name',
      'Website',
      'Industry',
      'NumberOfEmployees',
      'OwnerId',
      'AnnualRevenue',
      'LastModifiedDate',
    ]);
  });

  it('includes Id so the slim record can mint the salesforce_account_<id> target_id', () => {
    expect(SALESFORCE_ACCOUNT_FIELDS).toContain('Id');
  });

  it('includes LastModifiedDate so the cursor filter has the field to read', () => {
    expect(SALESFORCE_ACCOUNT_FIELDS).toContain('LastModifiedDate');
  });
});
