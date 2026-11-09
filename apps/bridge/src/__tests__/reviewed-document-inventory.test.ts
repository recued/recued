/** D-261 — the reviewed-document inventory is scoped to granted origins.
 *
 *  ⛔ WHAT THIS REPLACES: `tabs.query({})` — every open tab — with a script
 *  injected into each to read `location.href`, rebuilt on every tab update,
 *  close and replace. The owner's whole browsing list went to the server
 *  continuously, whether or not any pre-approval was in flight.
 *
 *  The filter is free: `describeDocument` (the only consumer) already refuses a
 *  request whose `target_domain_pattern` is not within the bridge's
 *  `granted_origins`, so a URL that could ever be selected is inside them by
 *  construction. Nothing selectable is dropped — including, critically, nothing
 *  that would turn an ambiguous target into a unique one. */

import { describe, expect, it, vi } from 'vitest';

import { describeOpenBridgeDocuments } from '../actions/reviewed-document.js';

const GRANTS = ['https://app.hubspot.com/*'];

const scripting = (result: unknown, documentId = 'doc-1') => ({
  executeScript: vi.fn(async (_opts: { target: { tabId: number }; func: unknown; args: readonly unknown[] }) =>
    [{ documentId, result }]),
});

describe('describeOpenBridgeDocuments', () => {
  it('asks chrome only for tabs inside the granted origins', async () => {
    const tabs = { query: vi.fn(async (_o: { url?: string | string[] }) => [{ id: 4 }]) };
    const docs = await describeOpenBridgeDocuments(
      tabs, scripting('https://app.hubspot.com/contacts/1'), GRANTS);
    expect(tabs.query).toHaveBeenCalledWith({ url: GRANTS });
    expect(docs).toEqual([{ tab_id: 4, document_id: 'doc-1', url: 'https://app.hubspot.com/contacts/1' }]);
  });

  /** ⛔ THE ONE THAT MATTERS. A bridge granted nothing was scripting every tab
   *  it could see to build an inventory that could never yield a candidate. */
  it('queries and injects nothing at all when the owner has granted no origins', async () => {
    const tabs = { query: vi.fn(async () => [{ id: 4 }]) };
    const script = scripting('https://anywhere.example/secret');
    expect(await describeOpenBridgeDocuments(tabs, script, [])).toEqual([]);
    expect(tabs.query).not.toHaveBeenCalled();
    expect(script.executeScript).not.toHaveBeenCalled();
  });

  /** An unusable match pattern must fail closed, never widen back to every tab. */
  it('returns nothing when the scoped query throws', async () => {
    const tabs = { query: vi.fn(async () => { throw new Error('invalid match pattern'); }) };
    const script = scripting('https://app.hubspot.com/x');
    expect(await describeOpenBridgeDocuments(tabs, script, ['::bogus::'])).toEqual([]);
    expect(script.executeScript).not.toHaveBeenCalled();
  });

  /** The owner client answers `null` from the injected probe and is not a
   *  reviewable target — unchanged, and still true inside the granted set. */
  it('excludes the owner client even when it sits inside a granted origin', async () => {
    const tabs = { query: vi.fn(async () => [{ id: 9 }]) };
    expect(await describeOpenBridgeDocuments(tabs, scripting(null), GRANTS)).toEqual([]);
  });

  /** Refusing an incomplete inventory is what stops an omitted second matching
   *  tab from making an ambiguous target look unique. The cap now applies to the
   *  granted subset, which is the set a candidate can come from. */
  it('refuses the whole inventory rather than truncate it', async () => {
    const many = Array.from({ length: 200 }, (_v, i) => ({ id: i + 1 }));
    const tabs = { query: vi.fn(async () => many) };
    const script = scripting('https://app.hubspot.com/x');
    expect(await describeOpenBridgeDocuments(tabs, script, GRANTS)).toEqual([]);
    expect(script.executeScript).not.toHaveBeenCalled();
  });

  it('skips a tab whose injection is refused without losing the rest', async () => {
    const tabs = { query: vi.fn(async () => [{ id: 1 }, { id: 2 }]) };
    let call = 0;
    const script = {
      executeScript: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('cannot access contents');
        return [{ documentId: 'doc-2', result: 'https://app.hubspot.com/deals/2' }];
      }),
    };
    expect(await describeOpenBridgeDocuments(tabs, script, GRANTS))
      .toEqual([{ tab_id: 2, document_id: 'doc-2', url: 'https://app.hubspot.com/deals/2' }]);
  });
});
