/** D-121 Phase 1 — `contact.*` rpc handler tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  handleContactUpsert,
  handleContactList,
  handleContactGet,
  handleContactDelete,
} from '../contact-handler.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('handleContactUpsert', () => {
  it('inserts a new contact with source=manual when none exists', async () => {
    const result = await handleContactUpsert(
      { store, now: () => 1000 },
      { email: 'jane@x.com', name: 'Jane' },
    );
    expect(result.contact).toMatchObject({
      _collection: 'contact',
      email: 'jane@x.com',
      name: 'Jane',
      source: 'manual',
    });
  });

  it('updates an adapter-derived contact while preserving source', async () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100, name: 'Bob' });
    const result = await handleContactUpsert(
      { store },
      { email: 'bob@x.com', name: 'Robert' },
    );
    expect(result.contact.name).toBe('Robert');
    expect(result.contact.source).toBe('email_from');
  });

  it('rejects empty email with bad_request', async () => {
    await expect(
      handleContactUpsert({ store }, { email: '' }),
    ).rejects.toThrow(RpcError);
  });

  it('rejects unparseable email with bad_request', async () => {
    await expect(
      handleContactUpsert({ store }, { email: 'gibberish' }),
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});

describe('handleContactList', () => {
  beforeEach(() => {
    store.observe({ email: 'alice@x.com', name: 'Alice', source: 'email_from', event_at: 100 });
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'calendar_attendee', event_at: 200 });
    store.upsertManual({ email: 'charlie@x.com', name: 'Charlie' }, 300);
  });

  it('returns all contacts ordered by last_interaction desc', async () => {
    const result = await handleContactList({ store }, {});
    expect(result.total).toBe(3);
    expect(result.contacts.map((c) => c.email)).toEqual([
      'charlie@x.com',
      'bob@x.com',
      'alice@x.com',
    ]);
  });

  it('filters by source', async () => {
    const result = await handleContactList({ store }, { source: 'manual' });
    expect(result.contacts.length).toBe(1);
    expect(result.contacts[0]?.email).toBe('charlie@x.com');
  });

  it('rejects unknown source with bad_request', async () => {
    await expect(
      handleContactList(
        { store },
        { source: 'bogus' as unknown as 'manual' },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('paginates via limit + offset', async () => {
    const page1 = await handleContactList({ store }, { limit: 2, offset: 0 });
    const page2 = await handleContactList({ store }, { limit: 2, offset: 2 });
    expect(page1.contacts.length).toBe(2);
    expect(page2.contacts.length).toBe(1);
    // Total reflects all rows regardless of paging.
    expect(page2.total).toBe(3);
  });

  it('filters by name_contains case-insensitively', async () => {
    const result = await handleContactList({ store }, { name_contains: 'BOB' });
    expect(result.contacts.map((c) => c.email)).toEqual(['bob@x.com']);
    // `total` reflects the SAME filter (not the whole-table count) — else the
    // UI's "Showing 1 of 3" + load-more would chase rows a search can't return.
    expect(result.total).toBe(1);
  });
});

describe('handleContactGet', () => {
  it('returns null when the contact is unknown', async () => {
    const result = await handleContactGet({ store }, { email: 'unknown@x.com' });
    expect(result.contact).toBeNull();
  });

  it('canonicalizes the email before lookup', async () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100 });
    const result = await handleContactGet({ store }, { email: 'BOB@X.COM' });
    expect(result.contact?.email).toBe('bob@x.com');
  });

  it('rejects empty email with bad_request', async () => {
    await expect(
      handleContactGet({ store }, { email: '' }),
    ).rejects.toThrow(RpcError);
  });
});

describe('handleContactDelete', () => {
  it('deletes by canonical email and reports true', async () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100 });
    const result = await handleContactDelete({ store }, { email: 'BOB@X.COM' });
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
    expect(store.get('bob@x.com')).toBeNull();
  });

  it('reports deleted: false for unknown email', async () => {
    const result = await handleContactDelete({ store }, { email: 'unknown@x.com' });
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
  });

  it('rejects empty email with bad_request', async () => {
    await expect(
      handleContactDelete({ store }, { email: '' }),
    ).rejects.toThrow(RpcError);
  });
});

describe('⛔ contact.list rollups — batched, page-scoped, opt-in', () => {
  beforeEach(() => {
    store.observe({ email: 'alice@x.com', name: 'Alice', source: 'email_from', event_at: 100 });
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'calendar_attendee', event_at: 200 });
    store.upsertManual({ email: 'charlie@x.com', name: 'Charlie' }, 300);
  });

  const spy = () => {
    const calls: readonly string[][] = [];
    const seen: string[][] = calls as string[][];
    return {
      seen,
      rollupsForKeys: (emails: readonly string[]) => {
        seen.push([...emails]);
        return Object.fromEntries(emails.map((email) => [email, [{
          publisher: 'recued-core', pack_slug: 'invoice-book', label: 'Owes you',
          value: { outstanding: '10.0000' }, complete: true,
        }]]));
      },
    };
  };

  it('⛔ OFF by default — a list that does not draw them must not pay for them', () => {
    const s = spy();
    return handleContactList({ store, rollupsForKeys: s.rollupsForKeys }, {}).then((r) => {
      expect(r.rollups).toBeUndefined();
      expect(s.seen, 'the batched read must not run unasked').toEqual([]);
    });
  });

  it('asked for, it returns one entry per contact ON THE PAGE', async () => {
    const s = spy();
    const r = await handleContactList(
      { store, rollupsForKeys: s.rollupsForKeys }, { with_rollups: true });
    expect(Object.keys(r.rollups!).sort()).toEqual(['alice@x.com', 'bob@x.com', 'charlie@x.com']);
  });

  it('⛔⛔ ONE call for the whole page — never one per row', () => {
    // The N+1 this whole path exists to avoid, and the only place a caller
    // could quietly reintroduce it. `seen` is the number of BATCHED reads.
    const s = spy();
    return handleContactList(
      { store, rollupsForKeys: s.rollupsForKeys }, { with_rollups: true }).then(() => {
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0]).toHaveLength(3);
    });
  });

  it('⚠ pages with the rows — a limit narrows what is asked for', async () => {
    const s = spy();
    await handleContactList(
      { store, rollupsForKeys: s.rollupsForKeys }, { with_rollups: true, limit: 2 });
    expect(s.seen[0]).toEqual(['charlie@x.com', 'bob@x.com']);
  });

  it('unwired, the list still works and simply carries none', async () => {
    const r = await handleContactList({ store }, { with_rollups: true });
    expect(r.contacts).toHaveLength(3);
    expect(r.rollups).toBeUndefined();
  });
});
