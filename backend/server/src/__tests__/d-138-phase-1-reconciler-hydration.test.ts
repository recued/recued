/** D-138 Phase 1 — CRM-reconciler hydration tests.
 *
 *  Asserts the widened HubSpot + Salesforce contact reconcilers
 *  project the new identity fields (`phone`, `mailing_address`,
 *  `company`) and include them in the canonical hash so cascades
 *  fire when those fields change. Reviewer #9 of the D-138 spec
 *  pass-4 calls these out explicitly. */

import { describe, expect, it } from 'vitest';

import {
  computeContactHash as computeHubSpotContactHash,
  projectContactMeta as projectHubSpotContactMeta,
} from '../data/hubspot/contact-reconciler.js';
import {
  computeContactHash as computeSalesforceContactHash,
  projectContactMeta as projectSalesforceContactMeta,
} from '../data/salesforce/contact-reconciler.js';

describe('D-138 P1 — HubSpot contact reconciler', () => {
  const baseRaw = {
    id: '47291',
    properties: {
      email: 'bob@example.com',
      firstname: 'Bob',
      lastname: 'Smith',
      lifecyclestage: 'lead',
      hubspot_owner_id: '1234',
      associatedcompanyid: 'co-9',
      notes_last_contacted: '1700000000000',
      hs_lastmodifieddate: '1700000000000',
      phone: '(415) 555-1234',
      address: '123 Main St.',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
      company: 'Acme Inc.',
    },
  };

  it('projects phone in E.164 form', () => {
    const meta = projectHubSpotContactMeta(baseRaw, 'fnv1a:abc', 1);
    expect(meta.phone).toBe('+14155551234');
  });

  it('projects mailing_address as a structured object', () => {
    const meta = projectHubSpotContactMeta(baseRaw, 'fnv1a:abc', 1);
    expect(meta.mailing_address).toEqual({
      address1: '123 main street',
      city: 'springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
    });
  });

  it('projects company verbatim (the contact-level company-string property)', () => {
    const meta = projectHubSpotContactMeta(baseRaw, 'fnv1a:abc', 1);
    expect(meta.company).toBe('Acme Inc.');
  });

  it('hash tuple changes when phone changes (cascade fires)', () => {
    const h1 = computeHubSpotContactHash(baseRaw);
    const h2 = computeHubSpotContactHash({
      ...baseRaw,
      properties: { ...baseRaw.properties, phone: '+14155559999' },
    });
    expect(h1).not.toBe(h2);
  });

  it('hash tuple reacts to local-format phone changes (codex review fix)', () => {
    // Pre-fix the hash defaulted phone to '' for any input lacking
    // a + prefix, so two different local-format phone numbers would
    // hash identically and reconciliation would skip refreshing
    // meta.phone. The hash must use the same default as the projector.
    const h1 = computeHubSpotContactHash({
      ...baseRaw,
      properties: { ...baseRaw.properties, phone: '(415) 555-1234' },
    });
    const h2 = computeHubSpotContactHash({
      ...baseRaw,
      properties: { ...baseRaw.properties, phone: '(415) 555-9999' },
    });
    expect(h1).not.toBe(h2);
  });

  it('hash tuple changes when address changes', () => {
    const h1 = computeHubSpotContactHash(baseRaw);
    const h2 = computeHubSpotContactHash({
      ...baseRaw,
      properties: { ...baseRaw.properties, city: 'Chicago' },
    });
    expect(h1).not.toBe(h2);
  });

  it('hash tuple changes when company changes', () => {
    const h1 = computeHubSpotContactHash(baseRaw);
    const h2 = computeHubSpotContactHash({
      ...baseRaw,
      properties: { ...baseRaw.properties, company: 'Globex' },
    });
    expect(h1).not.toBe(h2);
  });

  it('hash is deterministic across runs', () => {
    const h1 = computeHubSpotContactHash(baseRaw);
    for (let i = 0; i < 100; i++) {
      expect(computeHubSpotContactHash(baseRaw)).toBe(h1);
    }
  });

  it('partial address (missing required field) drops the mailing_address projection', () => {
    const meta = projectHubSpotContactMeta(
      {
        ...baseRaw,
        properties: { ...baseRaw.properties, zip: '' /* missing required */ },
      },
      'fnv1a:abc',
      1,
    );
    expect(meta.mailing_address).toBeUndefined();
  });
});

describe('D-138 P1 — Salesforce contact reconciler', () => {
  const baseRaw = {
    Id: '003A0000005XYZAB',
    Email: 'bob@example.com',
    FirstName: 'Bob',
    LastName: 'Smith',
    LeadSource: 'Web',
    OwnerId: 'user-1',
    AccountId: 'account-1',
    LastActivityDate: '2026-05-01',
    LastModifiedDate: '2026-05-01T14:32:18.000Z',
    Phone: '(415) 555-1234',
    MailingStreet: '123 Main St.\nApt 4B',
    MailingCity: 'Springfield',
    MailingState: 'IL',
    MailingPostalCode: '62701',
    MailingCountry: 'US',
  };

  it('projects phone in E.164 form', () => {
    const meta = projectSalesforceContactMeta(baseRaw, 'fnv1a:abc', 1);
    expect(meta.phone).toBe('+14155551234');
  });

  it('splits MailingStreet on newline into address1 + address2', () => {
    const meta = projectSalesforceContactMeta(baseRaw, 'fnv1a:abc', 1);
    expect(meta.mailing_address).toEqual({
      address1: '123 main street',
      address2: 'apt 4b',
      city: 'springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
    });
  });

  it('does NOT project a company field (Salesforce contact lacks a flat company column; reached via Account)', () => {
    const meta = projectSalesforceContactMeta(baseRaw, 'fnv1a:abc', 1);
    expect(meta.company).toBeUndefined();
  });

  it('hash tuple changes when phone changes', () => {
    const h1 = computeSalesforceContactHash(baseRaw);
    const h2 = computeSalesforceContactHash({ ...baseRaw, Phone: '+14155559999' });
    expect(h1).not.toBe(h2);
  });

  it('hash tuple reacts to local-format phone changes (codex review fix)', () => {
    const h1 = computeSalesforceContactHash({ ...baseRaw, Phone: '(415) 555-1234' });
    const h2 = computeSalesforceContactHash({ ...baseRaw, Phone: '(415) 555-9999' });
    expect(h1).not.toBe(h2);
  });

  it('hash tuple changes when address changes', () => {
    const h1 = computeSalesforceContactHash(baseRaw);
    const h2 = computeSalesforceContactHash({ ...baseRaw, MailingCity: 'Chicago' });
    expect(h1).not.toBe(h2);
  });

  it('hash is deterministic across runs', () => {
    const h1 = computeSalesforceContactHash(baseRaw);
    for (let i = 0; i < 100; i++) {
      expect(computeSalesforceContactHash(baseRaw)).toBe(h1);
    }
  });

  it('partial address (missing required field) drops the mailing_address projection', () => {
    const meta = projectSalesforceContactMeta(
      { ...baseRaw, MailingPostalCode: '' /* missing required */ },
      'fnv1a:abc',
      1,
    );
    expect(meta.mailing_address).toBeUndefined();
  });
});
