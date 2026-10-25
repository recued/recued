import { describe, expect, it } from 'vitest';

import {
  isKeyAuthority,
  isKeyAuthorityContract,
  keyChecklistFromAgreementGrants,
  keyToolNameForGrantEntry,
} from '../index.js';

describe('D-327 — an agreement that is its key\'s whole authority', () => {
  it('recognises only the closed vocabulary', () => {
    expect(isKeyAuthority('contract')).toBe(true);
    expect(isKeyAuthority('checklist')).toBe(false);
    expect(isKeyAuthority(undefined)).toBe(false);
    expect(isKeyAuthorityContract({ key_authority: 'contract' })).toBe(true);
    expect(isKeyAuthorityContract({})).toBe(false);
    expect(isKeyAuthorityContract(null)).toBe(false);
  });
});

describe('D-327 — an agreement\'s grants read as its key\'s tool list', () => {
  it('projects the three kinds a checklist can hold, by their checklist names', () => {
    expect(keyToolNameForGrantEntry('primitive.mail.search')).toBe('mail.search');
    expect(keyToolNameForGrantEntry('recipe.recued-core/peer-request-appointment'))
      .toBe('recued-core/peer-request-appointment');
    expect(keyToolNameForGrantEntry('core.data.calendar.list')).toBe('core.data.calendar.list');
    // A native verb-op projects by its op id; the wire gate joins the static
    // tool that fronts it (`recued_getAudit`) back to this id.
    expect(keyToolNameForGrantEntry('core.audit.read')).toBe('core.audit.read');
  });

  it('never projects a kernel op that is kept off every door', () => {
    // `core.ai.*` would spend the owner's inference budget; an agreement row
    // must not become the way around the exclusion.
    expect(keyToolNameForGrantEntry('core.ai.summarize')).toBeUndefined();
  });

  it('leaves to the agreement what the agreement checks itself', () => {
    expect(keyToolNameForGrantEntry('acme.crm.deal-update')).toBeUndefined();
    expect(keyToolNameForGrantEntry('recued-core/hubspot.deal.update')).toBeUndefined();
    expect(keyToolNameForGrantEntry('data.mail')).toBeUndefined();
    expect(keyToolNameForGrantEntry('enrichment.deal_risk')).toBeUndefined();
    expect(keyToolNameForGrantEntry('peer.label.availability')).toBeUndefined();
  });

  it('refuses names that are not what they claim', () => {
    expect(keyToolNameForGrantEntry('primitive.not-a-tool')).toBeUndefined();
    expect(keyToolNameForGrantEntry('recipe.no-slash')).toBeUndefined();
    expect(keyToolNameForGrantEntry('recipe./missing-publisher')).toBeUndefined();
    expect(keyToolNameForGrantEntry('recipe.missing-id/')).toBeUndefined();
    expect(keyToolNameForGrantEntry('core.not.a.registered.op')).toBeUndefined();
  });

  it('builds an allow-list: revokes and non-projecting rows add nothing', () => {
    expect(keyChecklistFromAgreementGrants([
      { entry_key: 'primitive.mail.search', granted: true },
      { entry_key: 'primitive.contact.search', granted: false },
      { entry_key: 'recipe.recued-core/peer-request-appointment', granted: true },
      { entry_key: 'core.data.calendar.list', granted: true },
      { entry_key: 'core.ai.summarize', granted: true },
      { entry_key: 'data.mail', granted: true },
    ])).toEqual({
      'mail.search': true,
      'recued-core/peer-request-appointment': true,
      'core.data.calendar.list': true,
    });
    expect(keyChecklistFromAgreementGrants([])).toEqual({});
  });
});
