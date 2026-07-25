/** D-129 Phase 4 — HubSpot company vendor-entity registration tests.
 *
 *  Covers the contract surface P4 ships:
 *  - `CONNECTION_VENDOR_ENTITIES` includes `hubspot.company` with the
 *    canonical 6-field meta_fields shape (spec § A.2).
 *  - `HUBSPOT_COMPANY_PROPERTIES` is the 7-property request projection
 *    (spec § Constants — already uses `hs_lastmodifieddate`, no
 *    deviation needed).
 *  - Lookup helpers resolve the new entry by scope + (vendor, entity).
 *
 *  Reconciler-side concerns (search pagination / hashOf / toMeta) live
 *  in the backend/server P4 test file. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_COMPANY_PROPERTIES,
  composeVendorEntityScope,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
  listRegisteredVendors,
} from '../index.js';

describe('D-129 P4 — hubspot.company entity registration', () => {
  const companyEntry = getVendorEntityByVendorEntity('hubspot', 'company');

  it('is in CONNECTION_VENDOR_ENTITIES with the canonical scope', () => {
    expect(companyEntry).not.toBeNull();
    expect(companyEntry!.scope).toBe('connection.api.hubspot.company');
    expect(companyEntry!.scope).toBe(composeVendorEntityScope('hubspot', 'company'));
  });

  it('declares the 6 canonical meta_fields per spec §A.2', () => {
    expect(companyEntry!.meta_fields.map((f) => f.key)).toEqual([
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
    const byKey = new Map(companyEntry!.meta_fields.map((f) => [f.key, f.type]));
    expect(byKey.get('name')).toBe('string');
    expect(byKey.get('domain')).toBe('string');
    expect(byKey.get('industry')).toBe('string');
    expect(byKey.get('num_employees')).toBe('number');
    expect(byKey.get('owner')).toBe('string');
    expect(byKey.get('annual_revenue')).toBe('number');
  });

  it('shows up in CONNECTION_VENDOR_ENTITIES list alongside deal + contact (closed Sales Hub set)', () => {
    const scopes = CONNECTION_VENDOR_ENTITIES.map((e) => e.scope);
    expect(scopes).toContain('connection.api.hubspot.deal');
    expect(scopes).toContain('connection.api.hubspot.contact');
    expect(scopes).toContain('connection.api.hubspot.company');
  });

  it('resolves via getVendorEntityForScope', () => {
    const found = getVendorEntityForScope('connection.api.hubspot.company');
    expect(found).not.toBeNull();
    expect(found!.display_name).toBe('HubSpot Company');
  });

  it('does not introduce a duplicate vendor in listRegisteredVendors', () => {
    const vendors = listRegisteredVendors();
    expect(vendors.filter((v) => v === 'hubspot')).toHaveLength(1);
  });
});

describe('D-129 P4 — HUBSPOT_COMPANY_PROPERTIES', () => {
  it('lists the 7 canonical request properties', () => {
    expect(HUBSPOT_COMPANY_PROPERTIES).toEqual([
      'name',
      'domain',
      'industry',
      'numberofemployees',
      'hubspot_owner_id',
      'annualrevenue',
      'hs_lastmodifieddate',
    ]);
  });

  it('includes hs_lastmodifieddate so the search helper cursor filter has the field', () => {
    expect(HUBSPOT_COMPANY_PROPERTIES).toContain('hs_lastmodifieddate');
  });

  it('uses HubSpot one-word property names (numberofemployees / annualrevenue) — projection to snake_case happens in the reconciler', () => {
    expect(HUBSPOT_COMPANY_PROPERTIES).toContain('numberofemployees');
    expect(HUBSPOT_COMPANY_PROPERTIES).toContain('annualrevenue');
  });
});
