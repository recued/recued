/** D-129 Phase 2 — HubSpot deal vendor-entity registration tests.
 *
 *  Covers the contract surface P2 ships:
 *  - `CONNECTION_VENDOR_ENTITIES` includes `hubspot.deal` with the
 *    canonical meta_fields shape (spec § A.2 + the next-activity key-date).
 *  - `HUBSPOT_DEAL_PROPERTIES` is the 17-property request projection
 *    (spec § Constants + the D5 deal-fold activity / free-text extras).
 *  - Lookup helpers resolve the new entry by scope + (vendor, entity).
 *  - `listRegisteredVendors` surfaces `hubspot`.
 *
 *  Reconciler-side concerns (search pagination / hashOf / toMeta /
 *  401-refresh round-trip) live in the backend/server P2 test file. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  HUBSPOT_DEAL_PROPERTIES,
  composeVendorEntityScope,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
  listRegisteredVendors,
} from '../index.js';

describe('D-129 P2 — hubspot.deal entity registration', () => {
  const dealEntry = getVendorEntityByVendorEntity('hubspot', 'deal');

  it('is in CONNECTION_VENDOR_ENTITIES with the canonical scope', () => {
    expect(dealEntry).not.toBeNull();
    expect(dealEntry!.scope).toBe('connection.api.hubspot.deal');
    expect(dealEntry!.scope).toBe(composeVendorEntityScope('hubspot', 'deal'));
  });

  it('declares the canonical meta_fields per spec §A.2 (+ the R2 step-6 canonical record id + the next-activity key-date)', () => {
    expect(dealEntry!.meta_fields.map((f) => f.key)).toEqual([
      // R2 step 6 — response-side canonical record id (find-then-act, §1.3).
      'id',
      'name',
      'stage',
      'amount',
      'owner',
      'pipeline',
      'key_dates.close_date',
      'key_dates.created_at',
      // next/last-activity key-dates + description/next_step/priority back the
      // deal_contacts / ai-prompt-recipe canonical migration (HubSpot-side, no SF parity).
      'key_dates.next_activity_at',
      'key_dates.last_activity_at',
      'forecast_amount',
      'description',
      'next_step',
      'priority',
      'close_state',
    ]);
  });

  it('uses the right field types', () => {
    const byKey = new Map(dealEntry!.meta_fields.map((f) => [f.key, f.type]));
    expect(byKey.get('name')).toBe('string');
    expect(byKey.get('stage')).toBe('string');
    expect(byKey.get('amount')).toBe('number');
    expect(byKey.get('owner')).toBe('string');
    expect(byKey.get('pipeline')).toBe('string');
    expect(byKey.get('key_dates.close_date')).toBe('date_ms');
    expect(byKey.get('key_dates.created_at')).toBe('date_ms');
    expect(byKey.get('key_dates.next_activity_at')).toBe('date_ms');
    expect(byKey.get('key_dates.last_activity_at')).toBe('date_ms');
    expect(byKey.get('forecast_amount')).toBe('number');
    expect(byKey.get('description')).toBe('string');
    expect(byKey.get('next_step')).toBe('string');
    expect(byKey.get('priority')).toBe('string');
    expect(byKey.get('close_state')).toBe('string');
  });

  it('shows up in CONNECTION_VENDOR_ENTITIES list', () => {
    expect(CONNECTION_VENDOR_ENTITIES.some((e) => e.scope === 'connection.api.hubspot.deal')).toBe(true);
  });

  it('resolves via getVendorEntityForScope', () => {
    const found = getVendorEntityForScope('connection.api.hubspot.deal');
    expect(found).not.toBeNull();
    expect(found!.display_name).toBe('HubSpot Deal');
  });

  it('listRegisteredVendors includes hubspot', () => {
    expect(listRegisteredVendors()).toContain('hubspot');
  });
});

describe('D-129 P2 — HUBSPOT_DEAL_PROPERTIES', () => {
  it('lists the 17 canonical request properties (spec § Constants + the D5 deal-fold extras)', () => {
    expect(HUBSPOT_DEAL_PROPERTIES).toEqual([
      'dealname',
      'dealstage',
      'amount',
      'closedate',
      'createdate',
      'hs_lastmodifieddate',
      'hubspot_owner_id',
      'pipeline',
      'hs_forecast_amount',
      // D5 deal-fold — activity timestamps (projected, not hashed) +
      // rep-authored free text (projected + hashed). See deal-reconciler.
      'notes_next_activity_date',
      'notes_last_contacted',
      'description',
      'hs_next_step',
      'hs_priority',
      'hs_is_closed',
      'hs_is_closed_won',
      'hs_is_closed_lost',
    ]);
  });

  it('includes hs_lastmodifieddate so the cursor filter has the field to read', () => {
    expect(HUBSPOT_DEAL_PROPERTIES).toContain('hs_lastmodifieddate');
  });

  it('includes the three hs_is_closed* discriminators that toMeta projects to close_state', () => {
    expect(HUBSPOT_DEAL_PROPERTIES).toContain('hs_is_closed');
    expect(HUBSPOT_DEAL_PROPERTIES).toContain('hs_is_closed_won');
    expect(HUBSPOT_DEAL_PROPERTIES).toContain('hs_is_closed_lost');
  });
});
