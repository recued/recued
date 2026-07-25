/** D-129 Phase 3 — HubSpot contact vendor-entity registration tests.
 *
 *  Covers the contract surface P3 ships:
 *  - `CONNECTION_VENDOR_ENTITIES` includes `hubspot.contact` with the
 *    canonical 6-field meta_fields shape (spec § A.2).
 *  - `HUBSPOT_CONTACT_PROPERTIES` is the 8-property request projection
 *    (spec § Constants — deviating to `hs_lastmodifieddate` so the
 *    search helper's hard-coded filter + sort work).
 *  - Lookup helpers resolve the new entry by scope + (vendor, entity).
 *
 *  Reconciler-side concerns (search pagination / hashOf / toMeta /
 *  email canonicalization) live in the backend/server P3 test file. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_CONTACT_PROPERTIES,
  composeVendorEntityScope,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
  listRegisteredVendors,
} from '../index.js';

describe('D-129 P3 — hubspot.contact entity registration', () => {
  const contactEntry = getVendorEntityByVendorEntity('hubspot', 'contact');

  it('is in CONNECTION_VENDOR_ENTITIES with the canonical scope', () => {
    expect(contactEntry).not.toBeNull();
    expect(contactEntry!.scope).toBe('connection.api.hubspot.contact');
    expect(contactEntry!.scope).toBe(composeVendorEntityScope('hubspot', 'contact'));
  });

  it('declares the canonical meta_fields per spec §A.2 (D-138 P1 widens the contact-level identity surface)', () => {
    expect(contactEntry!.meta_fields.map((f) => f.key)).toEqual([
      'email',
      // R2 step 6 — response-side canonical record id (find-then-act, §1.3).
      'id',
      'name',
      // PROJECTABLE name parts (op-step projection — vendor-reader→canonical retirement).
      'first_name',
      'last_name',
      'lifecycle_stage',
      'owner',
      'account_id',
      'recent_activity_at',
      // D-138 P1 — predicate-match identity fields
      'phone',
      'mailing_address',
      'company',
    ]);
  });

  it('uses the right field types', () => {
    const byKey = new Map(contactEntry!.meta_fields.map((f) => [f.key, f.type]));
    expect(byKey.get('email')).toBe('string');
    expect(byKey.get('name')).toBe('string');
    expect(byKey.get('lifecycle_stage')).toBe('string');
    expect(byKey.get('owner')).toBe('string');
    expect(byKey.get('account_id')).toBe('string');
    expect(byKey.get('recent_activity_at')).toBe('date_ms');
    // D-138 P1
    expect(byKey.get('phone')).toBe('string');
    expect(byKey.get('mailing_address')).toBe('object');
    expect(byKey.get('company')).toBe('string');
  });

  it('shows up in CONNECTION_VENDOR_ENTITIES list alongside hubspot.deal', () => {
    const scopes = CONNECTION_VENDOR_ENTITIES.map((e) => e.scope);
    expect(scopes).toContain('connection.api.hubspot.deal');
    expect(scopes).toContain('connection.api.hubspot.contact');
  });

  it('resolves via getVendorEntityForScope', () => {
    const found = getVendorEntityForScope('connection.api.hubspot.contact');
    expect(found).not.toBeNull();
    expect(found!.display_name).toBe('HubSpot Contact');
  });

  it('does not introduce a duplicate vendor in listRegisteredVendors', () => {
    const vendors = listRegisteredVendors();
    // Should still be exactly one 'hubspot' entry — the helper de-dupes.
    expect(vendors.filter((v) => v === 'hubspot')).toHaveLength(1);
  });
});

describe('D-129 P3 — HUBSPOT_CONTACT_PROPERTIES', () => {
  it('lists the canonical request properties (D-138 P1 widens with phone / mailing-address / company)', () => {
    expect(HUBSPOT_CONTACT_PROPERTIES).toEqual([
      'email',
      'firstname',
      'lastname',
      'lifecyclestage',
      'hubspot_owner_id',
      'associatedcompanyid',
      'notes_last_contacted',
      'hs_lastmodifieddate',
      // D-138 P1
      'phone',
      'address',
      'address2',
      'city',
      'state',
      'zip',
      'country',
      'company',
    ]);
  });

  it('includes phone + address fields + company for D-138 predicate matching', () => {
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('phone');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('address');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('city');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('state');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('zip');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('country');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('company');
  });

  it('includes hs_lastmodifieddate so the search helper cursor filter has the field', () => {
    // The search helper hard-codes filter + sort on hs_lastmodifieddate
    // and listUpdatedSince reads raw.properties.hs_lastmodifieddate to
    // stamp modified_at — without this property in the request body
    // the response wouldn't carry it back and every record would be
    // skipped.
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('hs_lastmodifieddate');
  });

  it('includes email so the canonical join key for engagement_score_per_contact is populated', () => {
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('email');
  });

  it('includes firstname + lastname for meta.name reconstitution', () => {
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('firstname');
    expect(HUBSPOT_CONTACT_PROPERTIES).toContain('lastname');
  });
});
