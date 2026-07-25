/** D-192 C-2 (Stance 2) slice 1 — the contribution stores.
 *
 *  `contact_attribute` (descriptive facts) + `contact_source_blob` (the raw
 *  remote record they were derived from). Both key on `contact_id`, never on
 *  email — that is what makes the C-2 internal re-key work without touching the
 *  physical `contacts` table.
 *
 *  Exercised through the REAL store against a real SQLite file (no mocks): the
 *  invariants under test are the UNIQUE indexes and the upsert conflict clauses,
 *  and a mocked store would assert nothing about either.
 *
 *  Spec: D-192; decisions-log § D-192 C-2. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_SOURCE_ID_DERIVED,
  CONTACT_SOURCE_ID_MANUAL,
  resolveContributionsByKind,
} from '@recued/contracts';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

/** Mint a real contact and hand back its `contact_id` — every contribution
 *  hangs off one, and the store refuses an orphan. */
const seedContact = (email: string): string => {
  store.observe({ email, name: 'Seed', source: 'email_from', event_at: 1_000 });
  const contact_id = store.get(email)?.contact_id;
  if (!contact_id) throw new Error('seed contact has no contact_id');
  return contact_id;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-contribution-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-192 C-2 slice 1 — contact_attribute', () => {
  it('records an assertion and reads it back with provenance intact', () => {
    const id = seedContact('bob@example.com');
    const rec = store.upsertContactAttribute({
      contact_id: id,
      kind: 'title',
      value: 'VP Sales',
      source_id: 'hubspot.prod.contact',
      source: 'vendor_meta',
      confidence: 0.9,
      as_of: 5_000,
    });

    expect(rec.value).toBe('VP Sales');
    expect(rec.source).toBe('vendor_meta');
    expect(rec.source_id).toBe('hubspot.prod.contact');
    expect(rec.as_of).toBe(5_000);

    // Two, not one: slice 3 wired the write paths, so the seeding `observe` now
    // contributes a `derived` name of its own. The store no longer holds only
    // what a test explicitly wrote into it — every contact arrives with the
    // contributions its own creation earned.
    const all = store.listContactAttributes(id);
    expect(all.map((r) => r.kind).sort()).toEqual(['name', 'title']);
  });

  it('holds CONFLICTING assertions from different sources side by side', () => {
    // The entire reason the store exists. A single-valued column cannot do this
    // — the second writer would destroy the first, silently.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme (typed)',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Corporation',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'ACME inc',
      source_id: 'google.personal.contact', source: 'contact_book',
    });

    const rows = store.listContactAttributes(id, 'org');
    expect(rows).toHaveLength(3);

    // …and the projection picks the user's own word, per the C-2a ladder.
    const winner = resolveContributionsByKind(rows).get('org');
    expect(winner?.value).toBe('Acme (typed)');
    expect(winner?.source).toBe('manual');
  });

  // ── The peer-clobber regression ────────────────────────────────────────
  it('TWO SOURCES AT THE SAME RUNG do not clobber each other', () => {
    // The bug this key exists to prevent. Google Contacts and Outlook Contacts
    // are BOTH `contact_book`; HubSpot and Salesforce are BOTH `vendor_meta`.
    // If the row were keyed on the RUNG rather than the source INSTANCE, each
    // peer would overwrite the other every sync cycle and the projection would
    // ping-pong between their values — silently, forever.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme',
      source_id: 'google.personal.contact', source: 'contact_book', as_of: 1_000,
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Inc',
      source_id: 'outlook.work.contact', source: 'contact_book', as_of: 2_000,
    });

    const rows = store.listContactAttributes(id, 'org');
    expect(rows).toHaveLength(2); // BOTH survive
    expect(rows.map((r) => r.value).sort()).toEqual(['Acme', 'Acme Inc']);

    // Same rung ⇒ the ladder can't separate them, so recency decides — and it
    // decides STABLY, not by whoever synced last.
    const winner = resolveContributionsByKind(rows).get('org');
    expect(winner?.value).toBe('Acme Inc');
    expect(winner?.source_id).toBe('outlook.work.contact');
  });

  it('a source RESTATING a field overwrites its OWN claim, not anyone else’s', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme (typed)',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Old Co',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta', as_of: 1_000,
    });
    // HubSpot revises its own view.
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'New Co',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta', as_of: 2_000,
    });

    const rows = store.listContactAttributes(id, 'org');
    expect(rows).toHaveLength(2); // upsert, not a third row
    expect(rows.find((r) => r.source_id === 'hubspot.prod.contact')?.value).toBe('New Co');
    // The user's assertion is untouched.
    expect(rows.find((r) => r.source === 'manual')?.value).toBe('Acme (typed)');
  });

  it('preserves first-seen created_at across a restatement, but moves as_of', () => {
    const id = seedContact('bob@example.com');
    const first = store.upsertContactAttribute(
      {
        contact_id: id, kind: 'title', value: 'Rep',
        source_id: 'hubspot.prod.contact', source: 'vendor_meta', as_of: 1_000,
      },
      500,
    );
    const second = store.upsertContactAttribute(
      {
        contact_id: id, kind: 'title', value: 'VP',
        source_id: 'hubspot.prod.contact', source: 'vendor_meta', as_of: 9_000,
      },
      8_000,
    );

    expect(second.created_at).toBe(first.created_at); // ingestion clock: first-seen
    expect(second.as_of).toBe(9_000);                 // event clock: moves forward
    expect(second.id).toBe(first.id);
  });

  it('re-ranks a source whose trust rung changed', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP',
      source_id: 'acme.conn.contact', source: 'ai_inferred',
    });
    // The same writer, re-declared at a higher trust level (a connection
    // re-enrolled, a producer promoted) — its standing must move with it.
    const promoted = store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP',
      source_id: 'acme.conn.contact', source: 'vendor_meta',
    });
    expect(promoted.source).toBe('vendor_meta');
    expect(store.listContactAttributes(id, 'title')).toHaveLength(1);
  });

  it('stores a structured value (an address is an object, not a string)', () => {
    const id = seedContact('bob@example.com');
    const addr = { street: '1 Main St', city: 'Boston', zip: '02101', country: 'US' };
    store.upsertContactAttribute({
      contact_id: id, kind: 'address', value: addr,
      source_id: 'google.personal.contact', source: 'contact_book',
    });
    expect(store.listContactAttributes(id, 'address')[0]?.value).toEqual(addr);
  });

  it('REJECTS an unknown kind, an unknown source, and a missing source_id', () => {
    const id = seedContact('bob@example.com');
    // A typo'd source would otherwise sail through and rank LAST at projection
    // time (the runtime floor) — reading as "weak source" rather than "typo".
    expect(() =>
      store.upsertContactAttribute({
        contact_id: id, kind: 'phone' as never, value: '+1',
        source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
      }),
    ).toThrow(/contact_attribute_kind_invalid/);
    expect(() =>
      store.upsertContactAttribute({
        contact_id: id, kind: 'org', value: 'x',
        source_id: CONTACT_SOURCE_ID_MANUAL, source: 'legacy' as never,
      }),
    ).toThrow(/contact_attribute_source_invalid/);
    // An empty source_id would collapse every writer at a rung onto one row.
    expect(() =>
      store.upsertContactAttribute({
        contact_id: id, kind: 'org', value: 'x', source_id: '', source: 'manual',
      }),
    ).toThrow(/contact_attribute_source_id_required/);
  });

  it('REJECTS an orphan contribution (no such contact)', () => {
    expect(() =>
      store.upsertContactAttribute({
        contact_id: 'nope', kind: 'org', value: 'x',
        source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
      }),
    ).toThrow(/contact_attribute_contact_unknown/);
  });

  it('deletes one contribution without disturbing its peers', () => {
    const id = seedContact('bob@example.com');
    const a = store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'A',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'B',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
    });

    expect(store.deleteContactAttribute(a.id)).toBe(true);
    expect(store.deleteContactAttribute(a.id)).toBe(false);
    const left = store.listContactAttributes(id, 'org');
    expect(left).toHaveLength(1);
    expect(left[0]?.source).toBe('vendor_meta');
  });

  it('purges one Source’s contributions and leaves its peers standing', () => {
    // Source teardown (D-192 source-data-removal). Unimplementable without
    // source_id: there would be no way to tell a disconnected Google account's
    // assertions from a still-connected Outlook one's.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'G',
      source_id: 'google.personal.contact', source: 'contact_book',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP',
      source_id: 'google.personal.contact', source: 'contact_book',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'O',
      source_id: 'outlook.work.contact', source: 'contact_book',
    });

    expect(store.deleteContactAttributesForSource('google.personal.contact')).toBe(2);
    // Asserted by SOURCE, not by count: the seeding `observe` contributes a
    // `recued.derived` name of its own now, and teardown must leave that standing
    // too. What has to be gone is Google's, and ONLY Google's — a teardown that
    // took a peer's rows with it would be the same peer-clobber the `source_id`
    // key exists to prevent, just arriving by a different door.
    const left = store.listContactAttributes(id);
    expect(left.map((r) => r.source_id).sort()).toEqual(
      [CONTACT_SOURCE_ID_DERIVED, 'outlook.work.contact'].sort(),
    );
  });

  it('withdraws ONE contact’s contributions from a Source, leaving its other people alone', () => {
    // The slice-6a widening. Whole-Source teardown (above) is a DISCONNECT; this
    // is one remote record going away from a still-connected Source — where only
    // THAT person's contributions may be withdrawn. Without the contact scope the
    // sync's per-record delete-cascade had only the blunt instrument, and one
    // deleted HubSpot contact would have purged the Source's contributions to
    // EVERY person it feeds.
    const bob = seedContact('bob@example.com');
    const ann = seedContact('ann@example.com');
    const SRC = 'hubspot.work.contact';

    store.upsertContactAttribute({
      contact_id: bob, kind: 'org', value: 'Acme', source_id: SRC, source: 'vendor_meta',
    });
    store.upsertContactAttribute({
      contact_id: ann, kind: 'org', value: 'Globex', source_id: SRC, source: 'vendor_meta',
    });

    expect(store.deleteContactAttributesForSource(SRC, bob)).toBe(1);
    expect(store.listContactAttributes(bob).some((r) => r.source_id === SRC)).toBe(false);
    // Ann still has hers — the Source is still connected and still feeds her.
    expect(store.listContactAttributes(ann).some((r) => r.source_id === SRC)).toBe(true);
  });

  it('an EMPTY contact_id withdraws nothing — it must never widen into a whole-Source purge', () => {
    // `undefined` means "every contact" (teardown). An empty string arriving from
    // a caller that failed to resolve a contact must NOT silently mean the same
    // thing — that is a one-record cascade quietly purging the entire Source.
    const bob = seedContact('bob@example.com');
    const SRC = 'hubspot.work.contact';
    store.upsertContactAttribute({
      contact_id: bob, kind: 'org', value: 'Acme', source_id: SRC, source: 'vendor_meta',
    });

    expect(store.deleteContactAttributesForSource(SRC, '')).toBe(0);
    expect(store.deleteContactAliasesForSource(SRC, '')).toBe(0);
    expect(store.listContactAttributes(bob).some((r) => r.source_id === SRC)).toBe(true);
  });
});

describe('D-192 C-2 slice 1 — contact_source_blob (the mirror)', () => {
  it('mirrors a remote record and exposes its hash for the incremental seam', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactSourceBlob({
      contact_id: id,
      source_id: 'hubspot.work.contact',
      vendor: 'hubspot',
      remote_id: 'hs_47291',
      blob: { properties: { email: 'bob@example.com', jobtitle: 'VP' } },
      snapshot_hash: 'h1',
      as_of: 5_000,
    });

    const hashes = store.listContactSourceBlobHashes('hubspot.work.contact');
    expect(hashes.get('hs_47291')).toBe('h1');

    const blobs = store.listContactSourceBlobs(id);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.source_id).toBe('hubspot.work.contact');
    expect(blobs[0]?.blob).toEqual({
      properties: { email: 'bob@example.com', jobtitle: 'VP' },
    });
  });

  it('ONE remote record maps to at most one contact — a re-import re-points, never fans out', () => {
    const bob = seedContact('bob@example.com');
    const rob = seedContact('rob@example.com');

    store.upsertContactSourceBlob({
      contact_id: bob, source_id: 'hubspot.work.contact', vendor: 'hubspot', remote_id: 'hs_1',
      blob: { v: 1 }, snapshot_hash: 'h1',
    });
    // A merge absorbed the record into `rob` — this is an UPDATE of the same
    // row, not a second row. Otherwise one HubSpot contact would hydrate two
    // people.
    store.upsertContactSourceBlob({
      contact_id: rob, source_id: 'hubspot.work.contact', vendor: 'hubspot', remote_id: 'hs_1',
      blob: { v: 2 }, snapshot_hash: 'h2',
    });

    expect(store.listContactSourceBlobs(bob)).toHaveLength(0);
    const moved = store.listContactSourceBlobs(rob);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.snapshot_hash).toBe('h2');
  });

  it('TWO SOURCES OF ONE VENDOR DO NOT COLLIDE — the slice-6a re-key', () => {
    // ⚠ The regression this re-key exists for, and the one the ORIGINAL test
    // ("scopes hashes per vendor") actively pinned the WRONG way round.
    //
    // Two D-125 connections to one vendor are TWO Sources with INDEPENDENT
    // record-id spaces — a Salesforce sandbox + prod pair (D-130 ships that
    // toggle), two HubSpot portals. Keyed on the VENDOR they collided on one row,
    // and the sync's delete diff was worse than the collision: each Source's walk
    // saw the OTHER's records as absent and would tombstone them, every cycle.
    // Same defect `contact_attribute` was built to avoid — a vendor is not an
    // identity.
    const bob = seedContact('bob@example.com');
    const ann = seedContact('ann@example.com');

    // The SAME remote_id in two Salesforce orgs — different people entirely.
    store.upsertContactSourceBlob({
      contact_id: bob, source_id: 'salesforce.prod.contact', vendor: 'salesforce',
      remote_id: '003xx', blob: { who: 'bob' }, snapshot_hash: 'prod',
    });
    store.upsertContactSourceBlob({
      contact_id: ann, source_id: 'salesforce.sandbox.contact', vendor: 'salesforce',
      remote_id: '003xx', blob: { who: 'ann' }, snapshot_hash: 'sandbox',
    });

    // Two rows, not one — neither clobbered the other.
    expect(store.listContactSourceBlobs(bob)).toHaveLength(1);
    expect(store.listContactSourceBlobs(ann)).toHaveLength(1);

    // And each Source's incremental seam sees ONLY its own records. Under the
    // vendor key both maps carried both rows, so each cycle's delete diff found
    // the other Source's record "absent" and tombstoned it.
    const prod = store.listContactSourceBlobHashes('salesforce.prod.contact');
    const sandbox = store.listContactSourceBlobHashes('salesforce.sandbox.contact');
    expect(prod.get('003xx')).toBe('prod');
    expect(prod.size).toBe(1);
    expect(sandbox.get('003xx')).toBe('sandbox');
    expect(sandbox.size).toBe(1);
  });

  it('scopes hashes per SOURCE — the same remote_id in two sources is two records', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'shared_id', blob: { a: 1 }, snapshot_hash: 'hs',
    });
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'google.personal.contact', vendor: 'google',
      remote_id: 'shared_id', blob: { b: 2 }, snapshot_hash: 'g',
    });

    expect(store.listContactSourceBlobHashes('hubspot.work.contact').get('shared_id')).toBe('hs');
    expect(store.listContactSourceBlobHashes('google.personal.contact').get('shared_id')).toBe('g');
    expect(store.listContactSourceBlobs(id)).toHaveLength(2);
  });

  it('returns an empty hash map for an unknown source (not a throw)', () => {
    expect(store.listContactSourceBlobHashes('nobody.x.contact').size).toBe(0);
  });

  it('purges every mirrored record for a SOURCE (Source teardown)', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'a', blob: {}, snapshot_hash: 'h',
    });
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'b', blob: {}, snapshot_hash: 'h',
    });
    // A SECOND HubSpot connection — teardown of one must not touch the other.
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.personal.contact', vendor: 'hubspot',
      remote_id: 'c', blob: {}, snapshot_hash: 'h',
    });

    expect(store.deleteContactSourceBlobsForSource('hubspot.work.contact')).toBe(2);
    expect(store.listContactSourceBlobHashes('hubspot.work.contact').size).toBe(0);
    // The peer Source of the SAME vendor is untouched.
    expect(store.listContactSourceBlobHashes('hubspot.personal.contact').size).toBe(1);
  });

  it('SOFT-MARKS one mirrored record — a vendor delete is a disconnection (D-205 §1)', () => {
    // The replacement for the per-record HARD delete, which was removed: it destroyed
    // the receipt while the claim it backed stood. The blob is the evidence behind a
    // contribution that survives the vendor's delete, so the row survives too — it is
    // marked, not dropped.
    const id = seedContact('bob@example.com');
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'a', blob: { name: 'Bob' }, snapshot_hash: 'h',
    });
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'b', blob: {}, snapshot_hash: 'h',
    });

    expect(store.markContactSourceBlobDisconnected('hubspot.work.contact', 'a', 5_000)).toBe(true);

    // The ROW SURVIVES, payload and all — it is still the audit trail behind whatever
    // it contributed.
    const marked = store.getContactSourceBlob('hubspot.work.contact', 'a');
    expect(marked?.disconnected_at).toBe(5_000);
    expect(marked?.blob).toEqual({ name: 'Bob' });

    // But it leaves the hash map — which is what stops the reconciler's absence diff
    // seeing it as "prior but not polled" on every subsequent cycle, forever.
    const hashes = store.listContactSourceBlobHashes('hubspot.work.contact');
    expect(hashes.size).toBe(1);
    expect(hashes.has('a')).toBe(false);

    // Idempotent — a second mark is a no-op, so the timestamp keeps recording when the
    // record FIRST vanished rather than creeping forward every cycle.
    expect(store.markContactSourceBlobDisconnected('hubspot.work.contact', 'a', 9_000)).toBe(false);
    expect(store.getContactSourceBlob('hubspot.work.contact', 'a')?.disconnected_at).toBe(5_000);
  });

  it('CLEARS the mark when the record comes back', () => {
    // Undeleted upstream. Without the clear it would stay out of the hash map forever:
    // never hash-skipped, therefore re-contributed on every single cycle.
    const id = seedContact('bob@example.com');
    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'a', blob: {}, snapshot_hash: 'h',
    });
    store.markContactSourceBlobDisconnected('hubspot.work.contact', 'a', 5_000);

    store.upsertContactSourceBlob({
      contact_id: id, source_id: 'hubspot.work.contact', vendor: 'hubspot',
      remote_id: 'a', blob: {}, snapshot_hash: 'h2',
    });

    expect(store.getContactSourceBlob('hubspot.work.contact', 'a')?.disconnected_at).toBeNull();
    expect(store.listContactSourceBlobHashes('hubspot.work.contact').get('a')).toBe('h2');
  });

  it('REJECTS a mirror row with no source_id — the mirror key is not optional', () => {
    const id = seedContact('bob@example.com');
    expect(() =>
      store.upsertContactSourceBlob({
        contact_id: id, source_id: '', vendor: 'hubspot', remote_id: 'x',
        blob: {}, snapshot_hash: 'h',
      }),
    ).toThrow(/contact_source_blob_source_id_required/);
  });

  it('REJECTS an orphan mirror row', () => {
    expect(() =>
      store.upsertContactSourceBlob({
        contact_id: 'nope', source_id: 'hubspot.work.contact', vendor: 'hubspot',
        remote_id: 'x', blob: {}, snapshot_hash: 'h',
      }),
    ).toThrow(/contact_source_blob_contact_unknown/);
  });
});

describe('D-192 C-2 slice 1 — the identifier-axis indexes', () => {
  it('an email identifies AT MOST ONE person (global uniqueness)', () => {
    // This is what lets slice 4 collapse the `merged_into` redirect-chain walk
    // into a single indexed lookup.
    const bob = seedContact('bob@example.com');
    const rob = seedContact('rob@example.com');

    store.upsertContactAlias({
      contact_id: bob, kind: 'email_alias',
      alias_pattern: 'bob.old@example.com', source: 'manual',
    });
    expect(() =>
      store.upsertContactAlias({
        contact_id: rob, kind: 'email_alias',
        alias_pattern: 'bob.old@example.com', source: 'manual',
      }),
    ).toThrow();
  });

  it('a phone MAY be shared — a household line is not a uniqueness violation', () => {
    const bob = seedContact('bob@example.com');
    const ann = seedContact('ann@example.com');

    store.upsertContactAlias({
      contact_id: bob, kind: 'phone_alias',
      alias_pattern: '+16175550100', source: 'manual',
    });
    // Deliberately NOT globally unique — a shared home/office line legitimately
    // belongs to several people.
    expect(() =>
      store.upsertContactAlias({
        contact_id: ann, kind: 'phone_alias',
        alias_pattern: '+16175550100', source: 'manual',
      }),
    ).not.toThrow();

    expect(store.listContactAliases(bob, 'phone_alias')).toHaveLength(1);
    expect(store.listContactAliases(ann, 'phone_alias')).toHaveLength(1);
  });
});
