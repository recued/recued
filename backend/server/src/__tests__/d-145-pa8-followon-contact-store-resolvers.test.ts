/** D-145 PA8 follow-on — contact identifier resolver storage tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeEmail, type ContactRecord, type MailingAddress } from '@recued/contracts';

import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

let db: Database.Database;
let store: ContactStore;
let now = 1_800_000_000_000;

const seedContact = (
  email: string,
  fields: Partial<{
    name: string;
    phone: string;
    mailing_address: MailingAddress;
    company: string;
    last_interaction: number;
  }> = {},
): ContactRecord => {
  const canonical = canonicalizeEmail(email);
  if (!canonical) throw new Error(`bad test email: ${email}`);
  store.upsertManual(
    {
      email: canonical,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
      ...(fields.mailing_address !== undefined
        ? { mailing_address: fields.mailing_address }
        : {}),
      ...(fields.company !== undefined ? { company: fields.company } : {}),
      ...(fields.last_interaction !== undefined
        ? { last_interaction: fields.last_interaction }
        : {}),
    },
    now++,
  );
  // D-192 C-2 — the fixture used to RE-KEY `contacts.contact_id` here to a
  // readable literal. That is now a data-corrupting operation and the substrate
  // aborts on it: `contact_id` is the storage identity, every contribution keys on
  // it with no SQL FK, so rewriting it orphans them all and the next projection
  // blanks the contact. Tests read the store-minted id off the returned record —
  // which is all they ever did with it.
  const seeded = store.get(canonical);
  if (!seeded) throw new Error(`failed to seed ${canonical}`);
  return seeded;
};

beforeEach(() => {
  now = 1_800_000_000_000;
  db = new Database(':memory:');
  store = createContactStore(db, { now: () => now++ });
});

afterEach(() => {
  db.close();
});

describe('D-145 PA8 follow-on — findByPhone', () => {
  it('returns an empty result for empty or unknown phone input', () => {
    expect(store.findByPhone('')).toEqual({
      contact: null,
      confidence: 0,
      alternatives: [],
    });
    expect(store.findByPhone('+15550009999')).toEqual({
      contact: null,
      confidence: 0,
      alternatives: [],
    });
  });

  it('returns a single non-tombstoned phone match at exact confidence', () => {
    const alice = seedContact('Alice <ALICE@example.com>', {
      name: 'Alice',
      phone: '+15550001001',
    });

    const result = store.findByPhone('+15550001001');

    expect(result.contact?.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.alternatives).toEqual([]);
  });

  it('surfaces alternatives instead of picking the first row when a phone is shared', () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
      phone: '+15550001002',
      last_interaction: 10,
    });
    const bob = seedContact('bob@example.com', {
      name: 'Bob',
      phone: '+15550001002',
      last_interaction: 20,
    });

    const result = store.findByPhone('+15550001002');

    expect(result.contact).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.alternatives.map((c) => c.contact_id)).toEqual([
      bob.contact_id,
      alice.contact_id,
    ]);
  });

  it('excludes merged_into tombstones even when stale phone data remains on the row', () => {
    const survivor = seedContact('survivor@example.com', {
      phone: '+15550001003',
      last_interaction: 10,
    });
    const loser = seedContact('loser@example.com', {
      phone: '+15550001003',
      last_interaction: 99,
    });
    store.setMergedInto([loser], survivor.email, now++);
    db.prepare(`UPDATE contacts SET phone = ? WHERE contact_id = ?`)
      .run('+15550001003', loser.contact_id);

    const result = store.findByPhone('+15550001003');

    expect(result.contact?.contact_id).toBe(survivor.contact_id);
    expect(result.alternatives).toEqual([]);
  });
});

describe('D-145 PA8 follow-on — findByAlias', () => {
  it('returns an empty result for empty or unknown alias input', () => {
    expect(store.findByAlias({ alias_pattern: '' })).toEqual({
      contact: null,
      confidence: 0,
      alternatives: [],
    });
    expect(store.findByAlias({ alias_pattern: 'unknown' })).toEqual({
      contact: null,
      confidence: 0,
      alternatives: [],
    });
  });

  it('resolves a single chat_alias row to its contact', () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });

    const result = store.findByAlias({ alias_pattern: ' mom ' });

    expect(result.contact?.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.alternatives).toEqual([]);
  });

  it('peekByAlias resolves identically without stamping last_resolved_at', () => {
    const alice = seedContact('alice-peek@example.com', {
      name: 'Alice',
    });
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });

    const result = store.peekByAlias({ alias_pattern: 'mom' });

    expect(result.contact?.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.alternatives).toEqual([]);
    expect(store.listContactAliases(alice.contact_id!, 'chat_alias')[0]?.last_resolved_at)
      .toBeUndefined();
  });

  it('surfaces chat_alias alternatives when the alias is ambiguous', () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });
    const bob = seedContact('bob@example.com', {
      name: 'Bob',
    });
    for (const contact of [alice, bob]) {
      store.upsertContactAlias({
        contact_id: contact.contact_id!,
        kind: 'chat_alias',
        alias_pattern: 'Sam',
        source: 'manual',
      });
    }

    const result = store.findByAlias({ alias_pattern: 'sam' });

    expect(result.contact).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.alternatives.map((c) => c.contact_id).sort()).toEqual([
      alice.contact_id,
      bob.contact_id,
    ].sort());
  });

  it('resolves a platform_id alias through the platform branch', () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'platform_id',
      platform: 'github',
      alias_pattern: 'alice-gh',
      source: 'manual',
    });

    const result = store.findByAlias({
      alias_pattern: 'alice-gh',
      platform: 'github',
    });

    expect(result.contact?.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.alternatives).toEqual([]);
  });

  it('follows merged_into when an alias still points at a loser contact_id', () => {
    const survivor = seedContact('survivor@example.com', {
      name: 'Survivor',
    });
    const loser = seedContact('loser@example.com', {
      name: 'Loser',
    });
    store.upsertContactAlias({
      contact_id: loser.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'the closer',
      source: 'manual',
    });
    store.setMergedInto([loser], survivor.email, now++);

    const result = store.findByAlias({ alias_pattern: 'the closer' });

    expect(result.contact?.contact_id).toBe(survivor.contact_id);
    expect(result.contact?.email).toBe(survivor.email);
    expect(result.contact?.contact_id).not.toBe(loser.contact_id);
    expect(result.alternatives).toEqual([]);
  });

  it('dedupes alternatives when multiple alias rows redirect to the same survivor', () => {
    const survivor = seedContact('survivor@example.com', {
      name: 'Survivor',
    });
    const loserA = seedContact('loser-a@example.com', {
      name: 'Loser A',
    });
    const loserB = seedContact('loser-b@example.com', {
      name: 'Loser B',
    });
    for (const loser of [loserA, loserB]) {
      store.upsertContactAlias({
        contact_id: loser.contact_id!,
        kind: 'chat_alias',
        alias_pattern: 'shared alias',
        source: 'manual',
      });
    }
    store.setMergedInto([loserA, loserB], survivor.email, now++);

    const result = store.findByAlias({ alias_pattern: 'shared alias' });

    expect(result.contact).toBeNull();
    expect(result.alternatives.map((c) => c.contact_id)).toEqual([
      survivor.contact_id,
    ]);
  });
});

describe('D-145 PA8 follow-on — list phone_exact and network_domain storage', () => {
  it('filters contact list by exact phone', () => {
    seedContact('alice@example.com', {
      phone: '+15550001004',
      last_interaction: 1,
    });
    seedContact('bob@example.com', {
      phone: '+15550001005',
      last_interaction: 2,
    });
    seedContact('carol@example.com', {
      phone: '+15550001004',
      last_interaction: 3,
    });

    const matches = store.list({ phone_exact: '+15550001004' });

    expect(matches.map((c) => c.email)).toEqual([
      'carol@example.com',
      'alice@example.com',
    ]);
  });

  it('persists network_domain after a manual upsert through setNetworkDomain', () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });

    const updated = store.setNetworkDomain(alice.contact_id!, ['family', 'work'], now++);

    expect(updated.network_domain).toEqual(['family', 'work']);
    expect(store.get('alice@example.com')?.network_domain).toEqual(['family', 'work']);
  });
});
