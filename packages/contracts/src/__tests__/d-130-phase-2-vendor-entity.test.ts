/** D-130 Phase 2 — Salesforce opportunity vendor-entity registration
 *  tests.
 *
 *  Covers the contract surface P2 ships:
 *  - `CONNECTION_VENDOR_ENTITIES` includes `salesforce.opportunity`
 *    with the canonical 9-field meta_fields shape (spec § A.2).
 *  - `SALESFORCE_OPPORTUNITY_FIELDS` is the 12-field SOQL projection
 *    (spec § Constants).
 *  - Lookup helpers resolve the new entry by scope + (vendor, entity).
 *  - `listRegisteredVendors` surfaces `salesforce` alongside `hubspot`.
 *
 *  Reconciler-side concerns (SOQL pagination / hashOf / toMeta /
 *  401-refresh round-trip) live in the backend/server P2 test file. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  SALESFORCE_OPPORTUNITY_FIELDS,
  composeVendorEntityScope,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
  listRegisteredVendors,
} from '../index.js';

describe('D-130 P2 — salesforce.opportunity entity registration', () => {
  const opportunityEntry = getVendorEntityByVendorEntity('salesforce', 'opportunity');

  it('is in CONNECTION_VENDOR_ENTITIES with the canonical scope', () => {
    expect(opportunityEntry).not.toBeNull();
    expect(opportunityEntry!.scope).toBe('connection.api.salesforce.opportunity');
    expect(opportunityEntry!.scope).toBe(composeVendorEntityScope('salesforce', 'opportunity'));
  });

  it('declares the canonical meta_fields per spec §A.2 (+ the R2 step-6 canonical record id + the D-192 F1 next_step)', () => {
    expect(opportunityEntry!.meta_fields.map((f) => f.key)).toEqual([
      // R2 step 6 — response-side canonical record id (find-then-act, §1.3).
      'id',
      'name',
      'stage',
      'amount',
      'owner',
      'key_dates.close_date',
      'key_dates.created_at',
      'forecast_amount',
      'close_state',
      'probability',
      // D-192 F1 — SF parity row for the canonical next_step key (rep-authored
      // next-step note; rides the SOQL SELECT + computeOpportunityHash).
      'next_step',
    ]);
  });

  it('uses the right field types', () => {
    const byKey = new Map(opportunityEntry!.meta_fields.map((f) => [f.key, f.type]));
    expect(byKey.get('name')).toBe('string');
    expect(byKey.get('stage')).toBe('string');
    expect(byKey.get('amount')).toBe('number');
    expect(byKey.get('owner')).toBe('string');
    expect(byKey.get('key_dates.close_date')).toBe('date_ms');
    expect(byKey.get('key_dates.created_at')).toBe('date_ms');
    expect(byKey.get('forecast_amount')).toBe('number');
    expect(byKey.get('close_state')).toBe('string');
    expect(byKey.get('probability')).toBe('number');
    expect(byKey.get('next_step')).toBe('string');
  });

  it('shows up in CONNECTION_VENDOR_ENTITIES list', () => {
    expect(CONNECTION_VENDOR_ENTITIES.some((e) => e.scope === 'connection.api.salesforce.opportunity')).toBe(true);
  });

  it('resolves via getVendorEntityForScope', () => {
    const found = getVendorEntityForScope('connection.api.salesforce.opportunity');
    expect(found).not.toBeNull();
    expect(found!.display_name).toBe('Salesforce Opportunity');
  });

  it('listRegisteredVendors includes salesforce alongside hubspot', () => {
    const vendors = listRegisteredVendors();
    expect(vendors).toContain('hubspot');
    expect(vendors).toContain('salesforce');
  });
});

describe('D-130 P2 — SALESFORCE_OPPORTUNITY_FIELDS', () => {
  it('lists the 13 canonical SOQL projection fields (spec § Constants + the D-192 F1 NextStep)', () => {
    expect(SALESFORCE_OPPORTUNITY_FIELDS).toEqual([
      'Id',
      'Name',
      'StageName',
      'Amount',
      'CloseDate',
      'CreatedDate',
      'LastModifiedDate',
      'OwnerId',
      'IsClosed',
      'IsWon',
      'ForecastCategory',
      'Probability',
      // D-192 F1 — rides the SELECT so the reconciler projects + hashes next_step.
      'NextStep',
    ]);
  });

  it('includes Id so the slim record can mint the salesforce_opportunity_<id> target_id', () => {
    expect(SALESFORCE_OPPORTUNITY_FIELDS).toContain('Id');
  });

  it('includes LastModifiedDate so the cursor filter has the field to read', () => {
    expect(SALESFORCE_OPPORTUNITY_FIELDS).toContain('LastModifiedDate');
  });

  it('includes the IsClosed + IsWon discriminators that toMeta projects to close_state', () => {
    expect(SALESFORCE_OPPORTUNITY_FIELDS).toContain('IsClosed');
    expect(SALESFORCE_OPPORTUNITY_FIELDS).toContain('IsWon');
  });
});
