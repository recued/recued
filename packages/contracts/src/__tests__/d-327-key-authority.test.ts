import { describe, expect, it } from 'vitest';

import {
  BROWSER_JOB_TOOLS,
  isBrowserKeyTool,
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

  // 2026-11-23 (the owner: "recued_startJob/recued_endJob should be just another tool in contracts required to be enabled
  // if any browser tool is enabled") — live, Codex on an agreement's key was told both were "not available for this
  // contract", so no app on a key could make its browser work into a recipe.
  it('gives the job tools with any browser tool the agreement grants, a Toolkit recipe or a browser op, and only then', () => {
    const JOB = { recued_startJob: true, recued_endJob: true };
    expect([...BROWSER_JOB_TOOLS]).toEqual(['recued_startJob', 'recued_endJob']);
    expect(keyChecklistFromAgreementGrants([{ entry_key: 'recipe.recued-core/read-web-text', granted: true }]))
      .toEqual({ 'recued-core/read-web-text': true, ...JOB });
    expect(keyChecklistFromAgreementGrants([{ entry_key: 'core.dom.inspect', granted: true }]))
      .toEqual({ 'core.dom.inspect': true, ...JOB });
    // None granted, one revoked, another publisher's recipe of a Toolkit name, or a recipe that is not the Toolkit's.
    for (const rows of [
      [{ entry_key: 'primitive.mail.search', granted: true }],
      [{ entry_key: 'recipe.recued-core/read-web-text', granted: false }],
      [{ entry_key: 'recipe.acme/read-web-text', granted: true }],
      [{ entry_key: 'recipe.recued-core/peer-request-appointment', granted: true }],
    ]) {
      const checklist = keyChecklistFromAgreementGrants(rows);
      expect(checklist, JSON.stringify(rows)).not.toHaveProperty('recued_startJob');
      expect(checklist, JSON.stringify(rows)).not.toHaveProperty('recued_endJob');
    }
    expect(isBrowserKeyTool('recued-core/act-on-web-page')).toBe(true);
    expect(isBrowserKeyTool('core.dom.act')).toBe(true);
    expect(isBrowserKeyTool('core.http.get')).toBe(false);
  });
});
