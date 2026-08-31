/** D-130 Phase 3 — Salesforce contact vendor-entity registration tests.
 *
 *  Covers the contract surface P3 ships:
 *  - `CONNECTION_VENDOR_ENTITIES` includes `salesforce.contact` with
 *    the canonical 6-field meta_fields shape (spec § A.2).
 *  - `SALESFORCE_CONTACT_FIELDS` is the 9-field SOQL projection
 *    (spec § Constants).
 *  - Lookup helpers resolve the new entry by scope + (vendor, entity).
 *  - Sales Cloud trio (opportunity + contact) coexists in the registry.
 *
 *  Reconciler-side concerns (SOQL pagination / hashOf / toMeta /
 *  email canonicalization / name fallback / 401-refresh round-trip)
 *  live in the backend/server P3 test file. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  SALESFORCE_CONTACT_FIELDS,
  composeVendorEntityScope,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
} from '../index.js';

describe('D-130 P3 — salesforce.contact entity registration', () => {
  const contactEntry = getVendorEntityByVendorEntity('salesforce', 'contact');

  it('is in CONNECTION_VENDOR_ENTITIES with the canonical scope', () => {
    expect(contactEntry).not.toBeNull();
    expect(contactEntry!.scope).toBe('connection.api.salesforce.contact');
    expect(contactEntry!.scope).toBe(composeVendorEntityScope('salesforce', 'contact'));
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
      // D-138 P1
      'phone',
      'mailing_address',
      // Portable role field — paired with hubspot.contact `job_title`.
      'job_title',
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
  });

  it('shows up in CONNECTION_VENDOR_ENTITIES list', () => {
    expect(CONNECTION_VENDOR_ENTITIES.some((e) => e.scope === 'connection.api.salesforce.contact')).toBe(true);
  });

  it('resolves via getVendorEntityForScope', () => {
    const found = getVendorEntityForScope('connection.api.salesforce.contact');
    expect(found).not.toBeNull();
    expect(found!.display_name).toBe('Salesforce Contact');
  });

  it('coexists with the opportunity entry in the registry', () => {
    const salesforceEntities = CONNECTION_VENDOR_ENTITIES
      .filter((e) => e.vendor === 'salesforce')
      .map((e) => e.entity);
    expect(salesforceEntities).toContain('opportunity');
    expect(salesforceEntities).toContain('contact');
  });

  it('declares email as the canonical join key (string type, first field)', () => {
    expect(contactEntry!.meta_fields[0]!.key).toBe('email');
    expect(contactEntry!.meta_fields[0]!.type).toBe('string');
  });
});

describe('D-130 P3 — SALESFORCE_CONTACT_FIELDS', () => {
  it('lists the canonical SOQL projection fields (D-138 P1 widens with Phone / MailingStreet / MailingCity / MailingState / MailingPostalCode / MailingCountry)', () => {
    expect(SALESFORCE_CONTACT_FIELDS).toEqual([
      'Id',
      'Email',
      'FirstName',
      'LastName',
      'LeadSource',
      'OwnerId',
      'AccountId',
      'LastActivityDate',
      'LastModifiedDate',
      // D-138 P1
      'Phone',
      'MailingStreet',
      'MailingCity',
      'MailingState',
      'MailingPostalCode',
      'MailingCountry',
    ]);
  });

  it('includes phone + mailing-address fields for D-138 predicate matching', () => {
    expect(SALESFORCE_CONTACT_FIELDS).toContain('Phone');
    expect(SALESFORCE_CONTACT_FIELDS).toContain('MailingStreet');
    expect(SALESFORCE_CONTACT_FIELDS).toContain('MailingCity');
    expect(SALESFORCE_CONTACT_FIELDS).toContain('MailingState');
    expect(SALESFORCE_CONTACT_FIELDS).toContain('MailingPostalCode');
    expect(SALESFORCE_CONTACT_FIELDS).toContain('MailingCountry');
  });

  it('includes Id so the slim record can mint the salesforce_contact_<id> target_id', () => {
    expect(SALESFORCE_CONTACT_FIELDS).toContain('Id');
  });

  it('includes LastModifiedDate so the cursor filter has the field to read', () => {
    expect(SALESFORCE_CONTACT_FIELDS).toContain('LastModifiedDate');
  });

  it('includes Email so the canonical join key is projected', () => {
    expect(SALESFORCE_CONTACT_FIELDS).toContain('Email');
  });
});
