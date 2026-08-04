/** The Microsoft Graph contacts leaf — twin of `d-205-google-people-leaf.test.ts`.
 *
 *  ## What is actually being tested
 *
 *  Same two things as the Google twin, but the SHAPE half diverges sharply, and the
 *  divergences are the point of this file:
 *
 *  - Graph has **no primary flag** on `emailAddresses` — People does. Array order is
 *    the user's own ordering and must be preserved rather than re-sorted.
 *  - Phones arrive across **three separate fields** (`mobilePhone` scalar,
 *    `businessPhones[]`, `homePhones[]`), not one multi-valued array.
 *  - Addresses arrive across **three slots** (`businessAddress` / `homeAddress` /
 *    `otherAddress`), each a `physicalAddress` with Graph's own field names
 *    (`street`, `countryOrRegion`) rather than People's.
 *  - `as_of` comes from `lastModifiedDateTime`, a top-level scalar, not from a
 *    nested `metadata.sources[].updateTime` walk.
 *  - **`photo` is unsuppliable**, where Google supplies a URL. Graph's is a
 *    navigation property returning bytes.
 */

import { describe, expect, it, vi } from 'vitest';

import { getContactSourceDeclaration, type ContactSourceDeclaration } from '@recued/contracts';

// The dispatcher is the seam. Mock it BEFORE importing the leaf.
const runSourceMirrorFetch = vi.fn();
vi.mock('../source-mirror/fetch.js', () => ({
  runSourceMirrorFetch: (...args: unknown[]) => runSourceMirrorFetch(...args),
}));

const { createGraphPeopleLeaf } = await import(
  '../contact-source-adapters/graph-people-leaf.js'
);

const MICROSOFT = getContactSourceDeclaration('microsoft') as ContactSourceDeclaration;

const deps = (overrides: { profile?: unknown; manifest?: unknown } = {}) =>
  ({
    fetchDeps: {
      profiles: {
        get: () =>
          overrides.profile === undefined
            ? { catalog_slug: 'microsoft-contacts' }
            : overrides.profile,
      },
      executorConfig: {
        manifests: {
          get: () =>
            overrides.manifest === undefined
              ? { operations: { 'contact.list': { result_path: 'value' } } }
              : overrides.manifest,
        },
      },
    },
    now: () => 5_000,
  }) as never;

const request = {
  source_id: 'microsoft.work.contact',
  connection_name: 'work',
  vendor: 'microsoft',
  declaration: MICROSOFT,
} as never;

const gatewayReturns = (contacts: readonly Record<string, unknown>[], complete = true): void => {
  runSourceMirrorFetch.mockResolvedValue({
    ok: true,
    records: new Map(contacts.map((c) => [String(c.id), c])),
    truncated: !complete,
    complete,
    skipped_no_id: 0,
  });
};

const runLeaf = async (contacts: readonly Record<string, unknown>[], complete = true) => {
  gatewayReturns(contacts, complete);
  const leaf = createGraphPeopleLeaf(deps());
  const out = await leaf(request);
  if (!out.ok) throw new Error(`leaf failed: ${out.reason}`);
  return out;
};

describe('D-205 — the Microsoft Graph contacts leaf', () => {
  it('dispatches the PACK operation, never an HTTP call', async () => {
    await runLeaf([{ id: 'AAMk-1' }]);
    expect(runSourceMirrorFetch).toHaveBeenCalledTimes(1);
    const [, call] = runSourceMirrorFetch.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(call.operationKey).toBe('contact.list');
    expect(call.catalogSlug).toBe('microsoft-contacts');
    expect(call.idField).toBe('id');
    // Raw mode — the shape-wrangling is the leaf's job, not a projection's.
    expect(call.projectionTemplate).toBeNull();
  });

  it('requests exactly the fields the supplies promise covers, and lastModifiedDateTime', async () => {
    await runLeaf([{ id: 'AAMk-1' }]);
    const [, call] = runSourceMirrorFetch.mock.calls[0] as [unknown, Record<string, unknown>];
    const select = String((call.args as Record<string, string>)['query.$select']);
    for (const f of [
      'emailAddresses',
      'businessPhones',
      'homePhones',
      'mobilePhone',
      'companyName',
      'businessAddress',
      'homeAddress',
      'otherAddress',
    ]) {
      expect(select, `missing ${f}`).toContain(f);
    }
    // ⚠ Not decoration: without it `as_of` silently becomes ingestion time and
    // freshest-wins degrades to last-synced-wins.
    expect(select).toContain('lastModifiedDateTime');
    // ⛔ Never requested — Graph's photo is bytes behind a nav property, and C-2's
    // rule is that bytes are never fetched.
    expect(select).not.toContain('photo');
  });

  it('⛔ does NOT promise photo — the declaration and the leaf agree', () => {
    // The two must not drift: `supplies` is verified per record, so a promised
    // attribute the leaf never emits fails EVERY record on the FIRST cycle.
    expect(MICROSOFT.supplies.attributes).not.toContain('photo');
    expect([...MICROSOFT.supplies.attributes].sort()).toEqual(['address', 'name', 'org']);
  });

  it('collects emails in Graph order and canonicalizes them', async () => {
    const out = await runLeaf([
      {
        id: 'AAMk-1',
        emailAddresses: [
          { address: 'Ada@Example.COM', name: 'Ada' },
          { address: 'ada.l@example.com', name: 'Ada L' },
        ],
      },
    ]);
    // Order preserved — Graph carries no primary flag, so re-sorting would invent
    // a precedence the vendor does not express.
    expect(out.records[0]?.aliases.email_alias).toEqual(['ada@example.com', 'ada.l@example.com']);
  });

  it('dedupes an address repeated under two labels', async () => {
    const out = await runLeaf([
      {
        id: 'AAMk-1',
        emailAddresses: [
          { address: 'ada@example.com', name: 'Work' },
          { address: 'ADA@example.com', name: 'Home' },
        ],
      },
    ]);
    expect(out.records[0]?.aliases.email_alias).toEqual(['ada@example.com']);
  });

  it('merges phones across all THREE Graph fields, mobile first', async () => {
    const out = await runLeaf([
      {
        id: 'AAMk-1',
        mobilePhone: '+15550100',
        businessPhones: ['+15550101', '+15550102'],
        homePhones: ['+15550103'],
      },
    ]);
    expect(out.records[0]?.aliases.phone_alias).toEqual([
      '+15550100',
      '+15550101',
      '+15550102',
      '+15550103',
    ]);
  });

  it('emits an empty phone list — not a missing key — when the contact has none', async () => {
    const out = await runLeaf([{ id: 'AAMk-1' }]);
    // 🔑 The anti-silence device: `[]` means "I looked and there are none"; a MISSING
    // key means "I never looked", which the runner fails the record for.
    expect(out.records[0]?.aliases).toHaveProperty('phone_alias');
    expect(out.records[0]?.aliases.phone_alias).toEqual([]);
    expect(out.records[0]?.aliases).toHaveProperty('email_alias');
    expect(out.records[0]?.attributes).toHaveProperty('name');
    expect(out.records[0]?.attributes).toHaveProperty('org');
    expect(out.records[0]?.attributes).toHaveProperty('address');
  });

  it('prefers displayName, falling back to givenName + surname', async () => {
    const withDisplay = await runLeaf([
      { id: 'A', displayName: 'Ada Lovelace', givenName: 'Ada', surname: 'Lovelace' },
    ]);
    expect(withDisplay.records[0]?.attributes.name).toBe('Ada Lovelace');

    const composed = await runLeaf([{ id: 'B', givenName: 'Grace', surname: 'Hopper' }]);
    expect(composed.records[0]?.attributes.name).toBe('Grace Hopper');

    // A first name alone is still a name.
    const partial = await runLeaf([{ id: 'C', givenName: 'Grace' }]);
    expect(partial.records[0]?.attributes.name).toBe('Grace');

    const none = await runLeaf([{ id: 'D' }]);
    expect(none.records[0]?.attributes.name).toBeNull();
  });

  it('takes org from companyName — a real string, not a cross-entity link', async () => {
    const out = await runLeaf([{ id: 'A', companyName: 'Analytical Engines Ltd' }]);
    expect(out.records[0]?.attributes.org).toBe('Analytical Engines Ltd');
  });

  it('composes an address from Graph field names, business slot first', async () => {
    const out = await runLeaf([
      {
        id: 'A',
        homeAddress: {
          street: '1 Home Way',
          city: 'London',
          postalCode: 'E1 6AN',
          countryOrRegion: 'United Kingdom',
        },
        businessAddress: {
          street: '2 Work Road',
          city: 'London',
          state: 'Greater London',
          postalCode: 'EC1A 1BB',
          countryOrRegion: 'United Kingdom',
        },
      },
    ]);
    const address = out.records[0]?.attributes.address as Record<string, unknown>;
    expect(address).not.toBeNull();
    // Business wins the slot race for a work-oriented contact book.
    //
    // ⚠ Asserted in the CANONICAL form, which is normalized PER FIELD and not
    // uniformly lowercased: `address1` / `city` go through `collapseLower`, while
    // `zip` goes through `canonicalizeZip` and keeps its case
    // (`contact-match.ts:232-235`). The normalization exists because this value
    // feeds D-138's `address_zip_country_key` — a blocking key that varied by
    // letter case would fail to block.
    expect(address.address1).toBe('2 work road');
    expect(address.city).toBe('london');
    expect(address.zip).toBe('EC1A 1BB');
  });

  it('🔑 refuses a HALF address rather than emitting a bad blocking key', async () => {
    const out = await runLeaf([
      // No postalCode, no country — `canonicalizeMailingAddress` returns null, and
      // that strictness is deliberate: this value feeds D-138's
      // `address_zip_country_key`, and a half address matches the WRONG people.
      { id: 'A', businessAddress: { street: '2 Work Road', city: 'London' } },
    ]);
    expect(out.records[0]?.attributes.address).toBeNull();
    // The record still lands — an incomplete address contributes nothing, it does
    // not fail the contact.
    expect(out.records[0]?.remote_id).toBe('A');
  });

  it('falls through to the next slot when the first does not canonicalize', async () => {
    const out = await runLeaf([
      {
        id: 'A',
        businessAddress: { street: '2 Work Road', city: 'London' },
        homeAddress: {
          street: '1 Home Way',
          city: 'London',
          postalCode: 'E1 6AN',
          countryOrRegion: 'United Kingdom',
        },
      },
    ]);
    const address = out.records[0]?.attributes.address as Record<string, unknown>;
    expect(address.address1).toBe('1 home way');
  });

  it('takes as_of from lastModifiedDateTime — EVENT time, not the clock', async () => {
    const out = await runLeaf([
      { id: 'A', lastModifiedDateTime: '2026-03-01T12:00:00Z' },
    ]);
    expect(out.records[0]?.as_of).toBe(Date.parse('2026-03-01T12:00:00Z'));
    // ⚠ The mocked clock is 5_000. Reading it here instead would silently turn
    // freshest-wins into last-synced-wins.
    expect(out.records[0]?.as_of).not.toBe(5_000);
  });

  it('falls back to now for an absent or unparseable timestamp', async () => {
    const absent = await runLeaf([{ id: 'A' }]);
    expect(absent.records[0]?.as_of).toBe(5_000);
    const junk = await runLeaf([{ id: 'B', lastModifiedDateTime: 'not-a-date' }]);
    expect(junk.records[0]?.as_of).toBe(5_000);
  });

  it('keeps the vendor payload verbatim as the receipt', async () => {
    const contact = { id: 'A', displayName: 'Ada', companyName: 'AE Ltd' };
    const out = await runLeaf([contact]);
    expect(out.records[0]?.raw).toEqual(contact);
  });

  it('emits an unkeyable record rather than dropping it', async () => {
    gatewayReturns([{ displayName: 'No Id Here' } as Record<string, unknown>]);
    const leaf = createGraphPeopleLeaf(deps());
    const out = await leaf(request);
    if (!out.ok) throw new Error('expected ok');
    // 🔑 An unkeyable row fail-closes the delete proof for the cycle — a record we
    // cannot key is a record we cannot prove absent. Dropping it here would hide
    // that from the health surface.
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.remote_id).toBe('');
  });

  it('🔑 passes the gateway completeness proof through UNCHANGED', async () => {
    const complete = await runLeaf([{ id: 'A' }], true);
    expect(complete.complete).toBe(true);
    const partial = await runLeaf([{ id: 'A' }], false);
    // A truncated walk proves nothing about absence ⇒ zero disconnects.
    expect(partial.complete).toBe(false);
  });

  describe('the catalog binding fails CLOSED, never as an empty list', () => {
    it('an unenrolled connection is a config fault', async () => {
      const leaf = createGraphPeopleLeaf(deps({ profile: null }));
      const out = await leaf(request);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe('config');
    });

    it('an uninstalled pack is a config fault', async () => {
      const leaf = createGraphPeopleLeaf(deps({ manifest: null }));
      const out = await leaf(request);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain('microsoft-contacts');
    });

    it('a catalog without contact.list is a config fault', async () => {
      const leaf = createGraphPeopleLeaf(deps({ manifest: { operations: {} } }));
      const out = await leaf(request);
      expect(out.ok).toBe(false);
      // ⚠ An empty list here would read to the runner as "you have no contacts" and,
      // on a complete walk, as "they were all deleted".
      if (!out.ok) expect(out.kind).toBe('config');
    });
  });
});
