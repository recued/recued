/** D-145 PA8 follow-on — `contact.resolve` RPC handler tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeEmail, type ContactRecord } from '@recued/contracts';

import { handleContactResolve } from '../contact-handler.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

let db: Database.Database;
let store: ContactStore;
let now = 1_800_000_100_000;

const seedContact = (
  email: string,
  fields: Partial<{
    name: string;
    phone: string;
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
      ...(fields.last_interaction !== undefined
        ? { last_interaction: fields.last_interaction }
        : {}),
    },
    now++,
  );
  // D-192 C-2 slice 4 — the fixture used to RE-KEY `contacts.contact_id` here to a
  // readable literal. That is now a data-corrupting operation and the substrate
  // ABORTS on it (`contact_id_immutable`): `contact_id` is the storage identity,
  // every contribution keys on it with no SQL FK, so rewriting it orphans them all
  // and the next projection blanks the contact. Tests read the store-minted id off
  // the returned record — which is all they ever did with it.
  const seeded = store.get(canonical);
  if (!seeded) throw new Error(`failed to seed ${canonical}`);
  return seeded;
};

beforeEach(() => {
  now = 1_800_000_100_000;
  db = new Database(':memory:');
  store = createContactStore(db, { now: () => now++ });
});

afterEach(() => {
  db.close();
});

describe('handleContactResolve — identifier happy paths', () => {
  it('resolves email to the contact_id and hydrated contact', async () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });

    const result = await handleContactResolve({ store }, { email: 'Alice@Example.com' });

    expect(result).toMatchObject({
      contact_id: alice.contact_id,
      confidence: 1,
      alternatives: [],
      contact: { email: 'alice@example.com', contact_id: alice.contact_id },
    });
  });

  it('walks merged email redirects and returns the survivor contact_id', async () => {
    const survivor = seedContact('survivor@example.com', {
      name: 'Survivor',
    });
    const loser = seedContact('loser@example.com', {
      name: 'Loser',
    });
    store.setMergedInto([loser], survivor.email, now++);

    const result = await handleContactResolve({ store }, { email: loser.email });

    expect(result.contact_id).toBe(survivor.contact_id);
    expect(result.contact?.email).toBe(survivor.email);
    expect(result.contact_id).not.toBe(loser.contact_id);
    expect(result.alternatives).toEqual([]);
  });

  it('resolves a unique phone match', async () => {
    const alice = seedContact('alice@example.com', {
      phone: '+15550002001',
    });

    const result = await handleContactResolve({ store }, { phone: '+15550002001' });

    expect(result.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.contact?.phone).toBe('+15550002001');
    expect(result.alternatives).toEqual([]);
  });

  it('resolves a unique chat alias match', async () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });

    const result = await handleContactResolve({ store }, { alias: 'mom' });

    expect(result.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.contact?.email).toBe(alice.email);
    expect(result.alternatives).toEqual([]);
  });

  it('resolves a platform_id match after validating the platform enum', async () => {
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

    const result = await handleContactResolve(
      { store },
      { platform_id: { platform: 'github', id: 'alice-gh' } },
    );

    expect(result.contact_id).toBe(alice.contact_id);
    expect(result.confidence).toBe(1);
    expect(result.contact?.email).toBe(alice.email);
    expect(result.alternatives).toEqual([]);
  });
});

describe('handleContactResolve — ambiguity and validation', () => {
  it('returns phone alternatives instead of binding to the first shared phone row', async () => {
    const alice = seedContact('alice@example.com', {
      phone: '+15550002002',
      last_interaction: 10,
    });
    const bob = seedContact('bob@example.com', {
      phone: '+15550002002',
      last_interaction: 20,
    });

    const result = await handleContactResolve({ store }, { phone: '+15550002002' });

    expect(result.contact_id).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.alternatives).toEqual([bob.contact_id, alice.contact_id]);
    expect(result.contact).toBeUndefined();
  });

  it('returns alias alternatives for ambiguous chat_alias matches', async () => {
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

    const result = await handleContactResolve({ store }, { alias: 'sam' });

    expect(result.contact_id).toBeNull();
    expect(result.confidence).toBe(0);
    expect([...result.alternatives].sort()).toEqual([
      alice.contact_id,
      bob.contact_id,
    ].sort());
    expect(result.contact).toBeUndefined();
  });

  it('rejects an invalid platform with bad_request', async () => {
    await expect(
      handleContactResolve(
        { store },
        { platform_id: { platform: 'tiktok' as never, id: 'alice' } },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects zero identifiers with bad_request', async () => {
    await expect(handleContactResolve({ store }, {}))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects multiple identifiers with bad_request', async () => {
    await expect(
      handleContactResolve({ store }, { email: 'alice@example.com', phone: '+15550002003' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('treats whitespace-only identifiers as absent', async () => {
    await expect(handleContactResolve({ store }, { email: '   ' }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns null contact_id and confidence 0 when the contact is not found', async () => {
    const result = await handleContactResolve({ store }, { email: 'missing@example.com' });

    expect(result).toEqual({
      contact_id: null,
      confidence: 0,
      alternatives: [],
    });
  });
});
