/** D-145 PA8 follow-on — `contact.upsert` widening tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeEmail,
  type ContactRecord,
  type MailingAddress,
  type NetworkDomain,
} from '@recued/contracts';

import {
  handleContactList,
  handleContactUpsert,
} from '../contact-handler.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

let db: Database.Database;
let store: ContactStore;
const NOW = 1_800_000_200_000;

const address: MailingAddress = {
  address1: '10 main street',
  city: 'springfield',
  state: 'CA',
  zip: '94105',
  country: 'US',
};

const seedContact = (
  email: string,
  fields: Partial<{ name: string; phone: string }> = {},
): ContactRecord => {
  const canonical = canonicalizeEmail(email);
  if (!canonical) throw new Error(`bad test email: ${email}`);
  store.upsertManual(
    {
      email: canonical,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
    },
    NOW,
  );
  // D-192 C-2 slice 4 — the fixture used to RE-KEY `contacts.contact_id` here.
  // That now ABORTS (`contact_id_immutable`): it is the storage identity, every
  // contribution keys on it with no SQL FK, so rewriting it orphans them all and
  // the next projection blanks the contact.
  const seeded = store.get(canonical);
  if (!seeded) throw new Error(`failed to seed ${canonical}`);
  return seeded;
};

beforeEach(() => {
  db = new Database(':memory:');
  store = createContactStore(db, { now: () => NOW });
});

afterEach(() => {
  db.close();
});

describe('handleContactUpsert — widened manual fields', () => {
  it('forwards phone to ContactStore.upsertManual', async () => {
    const result = await handleContactUpsert(
      { store, now: () => NOW },
      { email: '<ALICE@example.com>', name: 'Alice', phone: '+15550003001' },
    );

    expect(result.contact.phone).toBe('+15550003001');
    expect(store.get('alice@example.com')?.phone).toBe('+15550003001');
  });

  it('forwards mailing_address to ContactStore.upsertManual', async () => {
    const result = await handleContactUpsert(
      { store, now: () => NOW },
      { email: 'alice@example.com', mailing_address: address },
    );

    expect(result.contact.mailing_address).toEqual(address);
    expect(store.get('alice@example.com')?.mailing_address).toEqual(address);
  });

  it('forwards company and tags company_source as manual', async () => {
    const result = await handleContactUpsert(
      { store, now: () => NOW },
      { email: 'alice@example.com', company: 'Acme' },
    );

    expect(result.contact.company).toBe('Acme');
    expect(result.contact.company_source).toBe('manual');
    expect(store.get('alice@example.com')?.company_source).toBe('manual');
  });

  it('forwards job title and an absolute/yearless birthday unchanged', async () => {
    const result = await handleContactUpsert(
      { store, now: () => NOW },
      {
        email: 'alice@example.com',
        name: 'Alice',
        title: 'Director',
        birthday: '--03-04',
      },
    );

    expect(result.contact.title).toBe('Director');
    expect(result.contact.birthday).toBe('--03-04');
    expect(store.get('alice@example.com')).toMatchObject({
      title: 'Director',
      birthday: '--03-04',
    });
  });

  it('validates network_domain through sanitizeNetworkDomains before writing', async () => {
    const result = await handleContactUpsert(
      { store, now: () => NOW },
      {
        email: 'alice@example.com',
        name: 'Alice',
        network_domain: ['work', 'social', 'work'],
      },
    );

    expect(result.contact.network_domain).toEqual(['work', 'social']);
    expect(store.get('alice@example.com')?.network_domain).toEqual(['work', 'social']);
  });

  it('rejects an invalid network_domain with bad_request', async () => {
    await expect(
      handleContactUpsert(
        { store, now: () => NOW },
        {
          email: 'alice@example.com',
          network_domain: ['work', 'hobby'] as unknown as NetworkDomain[],
        },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });

    expect(store.count()).toBe(0);
  });

  it('does not call setNetworkDomain when the upserted contact has no contact_id', async () => {
    const realContact = seedContact('alice@example.com', {
      name: 'Alice',
    });
    const setNetworkDomain = vi.fn(store.setNetworkDomain);
    const fakeStore = {
      ...store,
      upsertManual: vi.fn(() => {
        const { contact_id: _contactId, ...withoutContactId } = realContact;
        return withoutContactId as ContactRecord;
      }),
      setNetworkDomain,
    } as unknown as ContactStore;

    const result = await handleContactUpsert(
      { store: fakeStore, now: () => NOW },
      { email: 'alice@example.com', network_domain: ['family'] },
    );

    expect(result.contact.contact_id).toBeUndefined();
    expect(setNetworkDomain).not.toHaveBeenCalled();
  });
});

describe('handleContactList — phone_exact', () => {
  it('returns only contacts whose phone exactly matches phone_exact', async () => {
    await handleContactUpsert(
      { store, now: () => NOW },
      { email: 'alice@example.com', name: 'Alice', phone: '+15550003002' },
    );
    await handleContactUpsert(
      { store, now: () => NOW },
      { email: 'bob@example.com', name: 'Bob', phone: '+15550003003' },
    );
    await handleContactUpsert(
      { store, now: () => NOW },
      { email: 'carol@example.com', name: 'Carol', phone: '+15550003002' },
    );

    const result = await handleContactList(
      { store },
      { phone_exact: '+15550003002', limit: 10 },
    );

    expect(result.contacts.map((c) => c.email).sort()).toEqual([
      'alice@example.com',
      'carol@example.com',
    ]);
    expect(result.contacts.every((c) => c.phone === '+15550003002')).toBe(true);
  });
});
