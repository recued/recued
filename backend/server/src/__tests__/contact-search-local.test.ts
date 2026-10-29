import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReservedLocalRpc } from '@recued/contracts';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { handleContactList, handleContactSearchLocal, makeContactHandlers } from '../contact-handler.js';
import type { WsClient } from '../ws-server.js';

let db: Database.Database;
let store: ContactStore;
beforeEach(() => { db = new Database(':memory:'); store = createContactStore(db); });
afterEach(() => db.close());
const search = (query: string, page: { limit?: number; offset?: number } = {}) => handleContactSearchLocal({ store }, { query, ...page });

describe('owner saved-contact search', () => {
  it('finds names, email, formatted phones, company and aliases literally without resolving or changing aliases', async () => {
    const alex = store.upsertManual({ email: 'alex_100%real@example.test', name: 'Alex Example', phone: '+14155550123', company: 'Northwind' }, 1);
    store.upsertManual({ email: 'alexX100Xreal@example.test', name: 'Another person' }, 1);
    store.upsertContactAlias({ contact_id: alex.contact_id!, kind: 'chat_alias', alias_pattern: 'The Desk', source: 'manual' }, 2);
    store.upsertContactAlias({ contact_id: alex.contact_id!, kind: 'phone_alias', alias_pattern: '+442079460123', source: 'manual' }, 2);
    const aliases = db.prepare('SELECT * FROM contact_alias ORDER BY id').all();
    for (const query of ['Alex Example', 'ALEX_100%REAL@', '(415) 555-0123', 'Northwind', 'the desk', '+44 (20) 7946-0123', 'alex_100%']) {
      expect((await search(query)).contacts.map(contact => contact.email), query).toEqual([alex.email]);
    }
    expect((await search('unknown')).total).toBe(0);
    expect(db.prepare('SELECT * FROM contact_alias ORDER BY id').all()).toEqual(aliases);
  });

  it('follows aliases through merge chains and deduplicates before pagination, excluding corrupted cyclic identities', async () => {
    const a = store.upsertManual({ email: 'old-a@example.test', name: 'Old A' }, 1);
    const b = store.upsertManual({ email: 'old-b@example.test', name: 'Old B' }, 1);
    const survivor = store.upsertManual({ email: 'survivor@example.test', name: 'Current' }, 1);
    for (const contact of [a, b, survivor]) store.upsertContactAlias({ contact_id: contact.contact_id!, kind: 'chat_alias', alias_pattern: 'Shared desk', source: 'manual' }, 2);
    store.setMergedInto([a], b.email, 3); store.setMergedInto([b], survivor.email, 4);
    expect(await search('Shared desk', { limit: 1 })).toMatchObject({ contacts: [{ email: survivor.email }], total: 1 });
    expect((await search(a.email)).contacts.map(contact => contact.email)).toEqual([survivor.email]);
    expect((await search('Shared desk', { limit: 1, offset: 1 })).contacts).toEqual([]);
    // Normal merges reject cycles; model a corrupted stored redirect directly.
    db.prepare('UPDATE contacts SET merged_into=? WHERE email=?').run(a.email, survivor.email);
    expect(await search('Shared desk')).toMatchObject({ contacts: [], total: 0 });
  });

  it('pages the whole filtered result with matching totals and reads rollups only for the requested page', async () => {
    for (let index = 0; index < 7; index++) store.upsertManual({ email: `person${index}@example.test`, name: `Person ${index}`, company: 'Group company' }, 10);
    store.observe({ email: 'external@example.test', name: 'Group external', source: 'email_from', event_at: 10 }, 10);
    const rollups = vi.fn((_emails: readonly string[]) => ({}));
    const found: string[] = [];
    for (const offset of [0, 2, 4, 6]) {
      const page = await handleContactSearchLocal({ store, rollupsForKeys: rollups }, { query: 'Group', source: 'manual', limit: 2, offset });
      expect(page.total).toBe(7); found.push(...page.contacts.map(contact => contact.email));
    }
    expect(found).toEqual(Array.from({ length: 7 }, (_, index) => `person${index}@example.test`));
    expect(rollups).not.toHaveBeenCalled();
    const page = await handleContactSearchLocal({ store, rollupsForKeys: rollups }, { query: 'Group', limit: 2, with_rollups: true });
    expect(rollups).toHaveBeenCalledExactlyOnceWith(page.contacts.map(contact => contact.email));
    expect(page.total).toBe(8);
  });

  it('requires a paired client and keeps the private search family separate from the governed contact.search tool', async () => {
    store.upsertManual({ email: 'owner-contact@example.test', name: 'A contact', company: 'Northwind' });
    const handler = makeContactHandlers({ store })!.handlers['contact.search.local'];
    const client: WsClient = { ws: null, realm: 'test', instance_id: null, display_name: 'test', connected_at: 1 };
    await expect(handler({ query: 'Northwind' }, client)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(handler({ query: 'Northwind' }, { ...client, instance_id: 'paired' })).resolves.toMatchObject({ total: 1 });
    expect(isReservedLocalRpc('contact.search.local')).toBe(true);
    expect(isReservedLocalRpc('contact.search')).toBe(false);
  });

  it('validates owner queries and does not expose private alias filtering through extra public-list arguments', async () => {
    const a = store.upsertManual({ email: 'one@example.test', name: 'One' });
    store.upsertManual({ email: 'two@example.test', name: 'Two' });
    store.upsertContactAlias({ contact_id: a.contact_id!, kind: 'chat_alias', alias_pattern: 'Private nickname', source: 'manual' });
    await expect(search('x', { limit: 0 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(search('x', { offset: -1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(search('Private\0other')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await search('   ')).toMatchObject({ contacts: [], total: 0 });
    const extra = { search: 'Private nickname' } as unknown as Parameters<typeof handleContactList>[1];
    expect((await handleContactList({ store }, extra)).total).toBe(2);
    expect((await search('Private nickname')).total).toBe(1);
  });
});
