/** D-192 S4b follow-on — `isEnrichmentScopeSupported`, the shared per_record
 *  scope-support check the enrichment STORE write gate + the recipe VALIDATOR
 *  both call. These pin the widening rule directly; the store's end-to-end
 *  behaviour is `d-192-s4b-store-scope-widening.test.ts` and the validator's is
 *  the `d-192-unit3-pack-crm-validate.test.ts` tripwire. */

import { describe, expect, it } from 'vitest';

import {
  buildConnectionVendorEntity,
  CONNECTION_VENDOR_ENTITIES,
  isEnrichmentScopeSupported,
  type EnrichmentScope,
} from '../index.js';

// A contact-anchored topic's static scopes (mirrors `engagement_score_per_contact`).
const CONTACT_SCOPES: EnrichmentScope[] = [
  'connection.api.hubspot.contact',
  'connection.api.salesforce.contact',
  'connection.api.pipedrive.person',
];

// A pack CRM contact vendor present ONLY in the live merged registry.
const dynamicsContact = buildConnectionVendorEntity({
  vendor: 'dynamics', entity: 'contact', display_name: 'Dynamics Contact',
  crm_alias: 'contact', meta_fields: [{ key: 'email', type: 'string', description: 'primary email' }],
});
const liveRegistry = [...CONNECTION_VENDOR_ENTITIES, dynamicsContact];
const DYNAMICS_CONTACT = 'connection.api.dynamics.contact' as EnrichmentScope;

describe('isEnrichmentScopeSupported', () => {
  it('accepts a statically declared scope (fast path), with or without a live registry', () => {
    expect(
      isEnrichmentScopeSupported(CONTACT_SCOPES, 'connection.api.hubspot.contact', CONNECTION_VENDOR_ENTITIES),
    ).toBe(true);
  });

  it('WIDENS a pack CRM crm_alias-family scope the live registry declares', () => {
    expect(isEnrichmentScopeSupported(CONTACT_SCOPES, DYNAMICS_CONTACT, liveRegistry)).toBe(true);
  });

  it('REJECTS the same pack scope with only the frozen built-in registry (no widening)', () => {
    expect(isEnrichmentScopeSupported(CONTACT_SCOPES, DYNAMICS_CONTACT, CONNECTION_VENDOR_ENTITIES)).toBe(false);
  });

  it('NEVER re-includes a BUILT-IN crm_alias scope a topic omits from its static list', () => {
    // A contact-anchored topic WITHOUT pipedrive.person statically must still
    // reject it (built-in, contact-family) — the widening adds only pack vendors.
    const noPipedrive: EnrichmentScope[] = [
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
    ];
    expect(
      isEnrichmentScopeSupported(noPipedrive, 'connection.api.pipedrive.person', liveRegistry),
    ).toBe(false);
  });

  it('does NOT cross crm_alias families (a deal scope on a contact-anchored topic)', () => {
    const dynamicsDeal = buildConnectionVendorEntity({
      vendor: 'dynamics', entity: 'opportunity', display_name: 'Dynamics Opportunity',
      crm_alias: 'deal', meta_fields: [{ key: 'amount', type: 'number', description: 'x' }],
    });
    expect(
      isEnrichmentScopeSupported(
        CONTACT_SCOPES,
        'connection.api.dynamics.opportunity' as EnrichmentScope,
        [...liveRegistry, dynamicsDeal],
      ),
    ).toBe(false); // deal-family scope, topic is contact-anchored
  });

  it('returns false for an undeclared scope on a non-CRM topic (empty family) + for undefined scopes', () => {
    expect(isEnrichmentScopeSupported(['mail'] as EnrichmentScope[], DYNAMICS_CONTACT, liveRegistry)).toBe(false);
    expect(isEnrichmentScopeSupported(undefined, 'connection.api.hubspot.contact', liveRegistry)).toBe(false);
  });
});
