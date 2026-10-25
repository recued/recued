/** `contact.search` by name offers the closest names on file when it found no one.
 *
 *  ⛔ FULL NAMES, never a word of one: the chat's privacy layer swaps whole names
 *  on file for placeholders, and a placeholder the model searches with is turned
 *  back into the name before the search runs. ⛔ Asked of the same local and
 *  mirror sources the search used, never the live CRM. Through a real contact
 *  store and the handler's own wrappers. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createContactStore } from '../storage/contact-store.js';

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

interface ContactResult { candidates: Array<{ record: { name?: string } }>; hint?: string; partial?: boolean }

const world = (
  people: Record<string, string>,
  opts: {
    mirror?: Array<{ name: string; email: string }>;
    breakLocal?: boolean;
    /** A live CRM behind the mirror; counts each vendor call. */
    live?: { calls: number };
  } = {},
) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  for (const [email, name] of Object.entries(people)) store.upsertManual({ email, name }, 1000);
  const local = opts.breakLocal === true
    ? { ...store, list: () => { throw new Error('contact store mid-migration'); } }
    : store;
  // A bound CRM mirror, filtered as the real one is: a name substring, case-insensitive.
  const mirrorRows = (opts.mirror ?? []).map((m, i) => ({ target_id: `hubspot_contact_hs_${i}`, meta: { name: m.name, email: m.email } }));
  const live = opts.live;
  const handlers = buildChatTier1Handlers({
    getContactStore: () => local,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    ...(opts.mirror !== undefined ? {
      getBoundCrmMirrorSources: () => [{ source_id: 'hubspot', scope: 'connection.api.hubspot.contact' }],
      getCrmRecordMirror: () => ({
        list: (_scope: string, q: { name_contains?: string; email_exact?: string; limit?: number }) => mirrorRows
          .filter((r) => q.name_contains === undefined || r.meta.name.toLowerCase().includes(q.name_contains.toLowerCase()))
          .filter((r) => q.email_exact === undefined || r.meta.email === q.email_exact)
          .slice(0, q.limit ?? 20),
      }),
    } : {}),
    ...(live !== undefined ? {
      // Synced just now, so only a lookup that misses goes to the vendor.
      getCrmConnectionFreshness: () => [{ connection_name: 'hs', vendor: 'hubspot', entity: 'contact', synced_at: Date.now() }],
      getCrmLiveRecords: async () => {
        live.calls += 1;
        return new Map(mirrorRows.map((r, i) => [String(i), r.meta as Record<string, unknown>]));
      },
    } : {}),
  } as never) as Record<string, (a: unknown, c: unknown) => Promise<unknown>>;
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  return async (args: Record<string, unknown>): Promise<ContactResult> =>
    ((await handlers['contact.search']!({ limit: 20, ...args }, ctx)) as { result: ContactResult }).result;
};

const PEOPLE = {
  'ana@castellanos.test': 'Ana Castellanos',
  'pat@acme.test': 'Pat Okoro',
  'z@northwind.test': 'Zephyrine Aldridge',
};

describe('contact.search — a name no contact holds', () => {
  it('⛔ offers the full name on file, never a word of it', async () => {
    const search = world(PEOPLE);
    const result = await search({ query: 'Castelanos' });
    expect(result.candidates).toEqual([]);
    expect(result.hint).toBe('No contact\'s name holds "Castelanos", but one contact\'s name is a close spelling '
      + 'of it: "Ana Castellanos". Names can reach you as placeholders, so do not judge the spelling yourself: '
      + 'this search already compared them. Search again with the query "Ana Castellanos", then answer from '
      + 'that contact, beginning by telling the owner you read "Castelanos" as "Ana Castellanos": it may be a '
      + 'different person.');
  });

  it('lists several close names, fewest edits first', async () => {
    const search = world({ ...PEOPLE, 'luis@castellano.test': 'Luis Castellano' });
    const result = await search({ query: 'Castelanos' });
    expect(result.hint).toBe('No contact\'s name holds "Castelanos", but these contacts\' names are close '
      + 'spellings of it: "Ana Castellanos", "Luis Castellano". Names can reach you as placeholders, so do not '
      + 'judge the spelling yourself: this search already compared them. Ask the owner which of them they '
      + 'meant, naming each.');
  });

  it('checks each word of a full name on its own', async () => {
    const search = world(PEOPLE);
    // "Ana" is on file; only the surname is misspelled.
    expect((await search({ query: 'Ana Castelanos' })).hint)
      .toMatch(/^No contact's name holds "Castelanos", but one contact's name is a close spelling of it: "Ana Castellanos"\./u);
    // A word typed twice is named once.
    expect((await search({ query: 'Castelanos, castelanos' })).hint)
      .toMatch(/^No contact's name holds "Castelanos", but one contact's name/u);
  });

  it('splits a name at an apostrophe or a hyphen, as the names on file are', async () => {
    const search = world({ ...PEOPLE, 'liam@obrien.test': 'Liam O\'Brien', 'anna@smith-jones.test': 'Anna Smith-Jones' });
    expect((await search({ query: 'O\'Brian' })).hint)
      .toMatch(/^No contact's name holds "Brian", but one contact's name is a close spelling of it: "Liam O'Brien"\./u);
    // "Smith" is on file; only "Jnes" is checked.
    expect((await search({ query: 'Smith-Jnes' })).hint)
      .toMatch(/^No contact's name holds "Jnes", but one contact's name is a close spelling of it: "Anna Smith-Jones"\./u);
  });

  it('⛔ never "corrects" a word some contact\'s name holds, though a close one is on file too', async () => {
    const search = world({ ...PEOPLE, 'marta@lopez.test': 'Marta Lopez', 'martha@okafor.test': 'Martha Okafor' });
    // No one is "Marta Castelanos", so the lookup is empty — but "Marta" is a name on file.
    const result = await search({ query: 'Marta Castelanos' });
    expect(result.candidates).toEqual([]);
    expect(result.hint).toMatch(/^No contact's name holds "Castelanos", but one contact's name is a close spelling of it: "Ana Castellanos"\./u);
    expect(result.hint).not.toContain('Martha');
  });

  it('offers a name from a bound CRM mirror too', async () => {
    const search = world(PEOPLE, { mirror: [{ name: 'Thornbury Hale', email: 't@hale.test' }] });
    expect((await search({ query: 'Thornbry' })).hint)
      .toMatch(/^No contact's name holds "Thornbry", but one contact's name is a close spelling of it: "Thornbury Hale"\./u);
  });

  it('⛔ spends no live CRM call of its own', async () => {
    const live = { calls: 0 };
    const search = world(PEOPLE, { mirror: [{ name: 'Thornbury Hale', email: 't@hale.test' }], live });
    expect((await search({ query: 'Thornbry' })).hint)
      .toMatch(/^No contact's name holds "Thornbry", but one contact's name is a close spelling of it: "Thornbury Hale"\./u);
    // The lookup's own miss went to the vendor once; the hint's several lookups did not.
    expect(live.calls).toBe(1);
  });

  it('says nothing of its own when someone was found, or nothing is close', async () => {
    const search = world(PEOPLE);
    const found = await search({ query: 'Castellanos' });
    expect(found.candidates.map((c) => c.record.name)).toEqual(['Ana Castellanos']);
    expect(found.hint).toBeUndefined();
    expect((await search({ query: 'Wolfeschlegel' })).hint).toMatch(/^contact\.search found nothing/u);
  });

  it('⛔ fails closed: a source that could not answer may hold the name', async () => {
    const search = world(PEOPLE, { breakLocal: true, mirror: [{ name: 'Ana Castellanos', email: 'a@x.test' }] });
    const result = await search({ query: 'Castelanos' });
    expect(result.partial).toBe(true);
    expect(result.hint ?? '').not.toContain('close spelling');
  });

  it('stays out of email, phone and company lookups, and an address typed as a name', async () => {
    const search = world(PEOPLE);
    for (const args of [{ email: 'anna@castelanos.test' }, { company: 'Castelanos' }, { query: 'anna@castelanos.test' }]) {
      expect((await search(args)).hint ?? '').not.toContain('close spelling');
    }
  });
});
