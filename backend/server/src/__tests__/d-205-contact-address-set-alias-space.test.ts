/** D-205 #3.5b — `contactAddressSet` spans the WHOLE address space, not just the
 *  merge graph.
 *
 *  ## The bug this pins
 *  #3.5 shipped `contactAddressSet` to close the reverse direction: a contact's
 *  reads must span every address it answers to, because nothing MOVES rows onto
 *  the survivor's key. It walked `contacts.merged_into` — and only that. But a
 *  merge is one of TWO ways an address joins a person, and the substrate's own
 *  resolver (`resolveCanonicalEmail` → `contactByAnyEmail`) reads BOTH tables:
 *
 *    | how the address joined            | where it lives afterwards | in the set before? |
 *    |-----------------------------------|---------------------------|--------------------|
 *    | a MERGE absorbed it               | `contacts.merged_into`    | ✅ yes             |
 *    | an IMPORT attached it             | `contact_alias`           | ❌ **no**          |
 *    | a PROMOTION retired it            | `contact_alias`           | ❌ **no**          |
 *
 *  So the set promised "every address the contact answers to" and delivered a
 *  strict subset. Both misses are LIVE, and neither needs a merge to occur:
 *
 *   - **the import miss ships today.** A vendor record is multi-valued upstream
 *     and the sync write-pass upserts every supplied address as an `email_alias`.
 *     Bob's mail from `bob@personal.com` is Bob's mail — and all thirteen
 *     contact-scoped producers could not see it.
 *   - **the promotion miss is D-205 #4's blocker.** `promoteMentionOnlyToVerified`
 *     re-keys the `email` PK and keeps the outgoing synthetic as an `email_alias`,
 *     NOT a tombstone. Every row written while the contact was `mention_only`
 *     stays keyed on that synthetic. Contact books mint those contacts en masse.
 *
 *  The failure mode is the one #3.5 was written about: the row is not missing, it
 *  is unreachable from the contact's key, so a producer computes a confident
 *  number over a fraction of the evidence and the model states it as fact.
 *
 *  ## What is pinned
 *  The union, from all three directions, plus the invariant that makes the fix
 *  safe to land: at zero merges AND zero aliases the set is unchanged. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contactAddressSet } from '../storage/contact-merge-graph.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-address-set-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The sync write-pass's alias upsert, verbatim (`contact-source-sync.ts`). */
const importAlias = (contact_id: string, email: string, source_id: string): void => {
  store.upsertContactAlias({
    contact_id,
    kind: 'email_alias',
    alias_pattern: email,
    source: 'vendor_meta',
    source_id,
  });
};

describe('D-205 #3.5b — the address set is the union of the merge graph AND the alias space', () => {
  it('BEHAVIOR-IDENTICAL at zero merges and zero aliases — the fix widens, it does not change', () => {
    const bob = store.observe({
      email: 'bob@work.com',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    expect(bob.contact_id).toBeTruthy();

    // `observe` writes an `email_alias` for the address it just observed, so this
    // also proves the union does not DOUBLE-count the primary back in.
    expect(contactAddressSet(db, 'bob@work.com')).toEqual(['bob@work.com']);
  });

  it('THE IMPORT MISS — a second address an import attached is in the set (no merge involved)', () => {
    const bob = store.observe({
      email: 'bob@work.com',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    // HubSpot's record for Bob carries a second address. Never merged, never a
    // tombstone — but the contact demonstrably ANSWERS TO it.
    importAlias(bob.contact_id!, 'bob@personal.com', 'hubspot.work.contact');

    expect(store.resolveCanonicalEmail('bob@personal.com').canonical_email).toBe('bob@work.com');
    expect(contactAddressSet(db, 'bob@work.com')).toEqual(['bob@personal.com', 'bob@work.com']);
  });

  it('THE PROMOTION MISS — the retired synthetic is in the set (D-205 #4s blocker)', () => {
    // The dentist: name + phone, no email. A contact book mints these en masse.
    const stub = store.createMentionOnlyContact({ name: 'The Dentist' });
    const synthetic = stub.email;

    // Rows accumulate under the synthetic — it IS his canonical address for now.
    // Then he emails you, and promotion re-keys the PK out from under them.
    store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'dentist@example.com',
    });

    // FORWARD still resolved before this fix (81c5a9671) — which is exactly what
    // made the reverse miss invisible.
    expect(store.resolveCanonicalEmail(synthetic).canonical_email).toBe('dentist@example.com');

    // REVERSE: the set every producer reads must still reach his old rows.
    expect(contactAddressSet(db, 'dentist@example.com')).toContain(synthetic);
  });

  it('the alias of an ABSORBED contact is in the survivors set — a merge moves nothing', () => {
    store.observe({ email: 'bob@home.com', name: 'Bob', source: 'email_from', event_at: 1 });
    const loser = store.observe({
      email: 'bob@work.com',
      name: 'Bob',
      source: 'email_from',
      event_at: 2,
    });
    // The alias hangs off the LOSER's contact_id — and the merge leaves it there.
    // Reading only the survivor's aliases would reintroduce the under-read one
    // table over.
    importAlias(loser.contact_id!, 'bob@personal.com', 'hubspot.work.contact');
    store.setMergedInto([loser], 'bob@home.com', 3);

    expect(contactAddressSet(db, 'bob@home.com')).toEqual([
      'bob@home.com',
      'bob@personal.com',
      'bob@work.com',
    ]);
  });

  it('resolves from ANY address in the set, not just the survivors — the walk is forward-first', () => {
    const bob = store.observe({
      email: 'bob@work.com',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    importAlias(bob.contact_id!, 'bob@personal.com', 'hubspot.work.contact');

    // A stored row keyed on the ALIAS must reach the same set as one keyed on the
    // primary — a producer is handed whatever address its row was written under.
    expect(contactAddressSet(db, 'bob@personal.com')).toEqual(
      contactAddressSet(db, 'bob@work.com'),
    );
  });

  it('🔑 a row still KEYED on the retired synthetic reaches the contacts whole set', () => {
    // The production shape of D-205 #4, and the one a merge-only walk cannot see.
    // A contact book mints the dentist as `mention_only`; a task is assigned to
    // him; `data_task.assigned_contact_id` holds his address of record — the
    // SYNTHETIC. Then he emails you and promotion re-keys the PK away from it.
    //
    // A producer sweeping that task is handed the synthetic. It must still find
    // the person — and everything else of theirs, under every address they have
    // ever answered to. Before the alias fall-through this returned `[synthetic]`:
    // a set of one, for a contact with a real address and a full history.
    const stub = store.createMentionOnlyContact({ name: 'The Dentist' });
    const synthetic = stub.email;
    store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'dentist@example.com',
    });
    // ...and his practice's billing address, from the contact book.
    importAlias(stub.contact_id!, 'billing@dentist.example', 'google.personal.contact');

    expect(contactAddressSet(db, synthetic)).toEqual([
      'billing@dentist.example',
      'dentist@example.com',
      synthetic,
    ]);
  });

  it('a phone_alias is NOT an address — folding it in would poison every LIKE pre-narrow', () => {
    const bob = store.observe({
      email: 'bob@work.com',
      name: 'Bob',
      source: 'email_from',
      event_at: 1,
    });
    store.upsertContactAlias({
      contact_id: bob.contact_id!,
      kind: 'phone_alias',
      alias_pattern: '+15550100',
      source: 'vendor_meta',
      source_id: 'hubspot.work.contact',
    });

    expect(contactAddressSet(db, 'bob@work.com')).toEqual(['bob@work.com']);
  });
});
