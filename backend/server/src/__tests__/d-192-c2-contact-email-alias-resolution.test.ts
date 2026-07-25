/** D-192 C-2 (Stance 2) slice 4 — `email_alias` becomes the ADDRESS SPACE.
 *
 *  Identity resolution stops being "walk the `merged_into` chain" and becomes "find
 *  the contact that OWNS this address, then resolve THAT CONTACT". The address space
 *  is `contact_alias`; the merge graph is `merged_into`; they are different questions
 *  and they now have different answers.
 *
 *  The headline is not the hop count — it is that `merged_into` CANNOT EXPRESS "Bob
 *  has two email addresses", so a second mailbox from an address book had nowhere to
 *  live at all.
 *
 *  ⚠ **NOTHING MOVES BETWEEN CONTACTS.** Not aliases, not contributions. A merge
 *  records an edge and leaves every row where it was written; the survivor's
 *  projection reads ACROSS the group. Moving would destroy the one thing
 *  `contact.merge.split` needs — whose the rows were — and, for contributions, would
 *  silently CLOBBER on `(contact_id, kind, source_id)`. Both are pinned below.
 *
 *  Spec: D-192 (build plan step 4). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTACT_SOURCE_ID_MANUAL } from '@recued/contracts';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-alias-resolution-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Give an existing contact a SECOND mailbox, the way an address-book import will. */
const attachSecondEmail = (contact_id: string, email: string): void => {
  store.upsertContactAlias({
    contact_id,
    kind: 'email_alias',
    alias_pattern: email,
    source: 'contact_book',
    source_id: 'google.personal.contact',
  });
};

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 4 — resolving any known address', () => {
  it('resolves a SECOND mailbox to its owner — which `merged_into` could never do', () => {
    // The actual payoff. A redirect chain can only say "this whole contact was
    // absorbed by that one", so Bob's work address had nowhere to live unless you
    // fabricated a tombstone contact for it. There is no contacts row here at all —
    // just an alias Bob owns.
    const bob = store.upsertManual({ email: 'bob@personal.com', name: 'Bob' });
    attachSecondEmail(bob.contact_id!, 'bob@work.com');

    expect(store.resolveCanonicalEmail('bob@work.com')).toEqual({
      canonical_email: 'bob@personal.com',
      chain_depth: 1,
    });
    // …and the primary still resolves to itself, without a hop.
    expect(store.resolveCanonicalEmail('bob@personal.com')).toEqual({
      canonical_email: 'bob@personal.com',
      chain_depth: 0,
    });
  });

  it('an UNKNOWN address resolves to itself — callers canonicalize before creating', () => {
    // Load-bearing: a miss must round-trip the input, not return null. Every caller
    // canonicalizes BEFORE deciding whether to create a contact.
    expect(store.resolveCanonicalEmail('nobody@example.com')).toEqual({
      canonical_email: 'nobody@example.com',
      chain_depth: 0,
    });
  });

  it('still walks the merge chain — the walk moved, it did not vanish', () => {
    const a = store.upsertManual({ email: 'a@example.com', name: 'A' });
    const b = store.upsertManual({ email: 'b@example.com', name: 'B' });
    const c = store.upsertManual({ email: 'c@example.com', name: 'C' });

    store.setMergedInto([store.get(a.email)!], b.email, 2_000);
    store.setMergedInto([store.get(b.email)!], c.email, 3_000);

    // A → B → C. Two hops, cycle-safe and depth-capped, exactly as before — it is
    // simply reached through the OWNER now rather than by walking strings.
    expect(store.resolveCanonicalEmail('a@example.com').canonical_email).toBe(
      'c@example.com',
    );
    expect(store.resolveCanonicalEmail('a@example.com').chain_depth).toBe(2);
  });

  it('resolves a merged contact’s SECOND mailbox to the survivor', () => {
    // Both mechanisms compose: an alias hop to the owner, then the merge walk. This
    // address has no contacts row AND its owner was absorbed.
    const bob = store.upsertManual({ email: 'bob@personal.com', name: 'Bob' });
    attachSecondEmail(bob.contact_id!, 'bob@work.com');
    const robert = store.upsertManual({ email: 'robert@example.com', name: 'Robert' });

    store.setMergedInto([store.get(bob.email)!], robert.email, 2_000);

    expect(store.resolveCanonicalEmail('bob@work.com').canonical_email).toBe(
      'robert@example.com',
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 4 — the write paths resolve FIRST', () => {
  it('mail from a second mailbox bumps the OWNER — it does not mint a stranger', () => {
    // The landmine slice 3 flagged. The old question was "does a contacts row have
    // this PK?", which is the WRONG QUESTION the moment Bob has a second address:
    // it missed him, took the create path, and minted a second Bob — or, once the
    // globally-unique alias index existed, threw `email_alias_already_attached` on
    // the way. Neither is the answer. Mail from bob@work.com IS mail from Bob.
    const bob = store.upsertManual({ email: 'bob@personal.com', name: 'Bob' });
    attachSecondEmail(bob.contact_id!, 'bob@work.com');
    const before = store.get('bob@personal.com')!;

    const observed = store.observe({
      email: 'bob@work.com',
      source: 'email_from',
      event_at: 9_000,
    });

    expect(observed.contact_id).toBe(bob.contact_id);
    expect(observed.email).toBe('bob@personal.com');
    expect(observed.interaction_count).toBe(before.interaction_count + 1);
    expect(store.count()).toBe(1); // no stranger was minted
  });

  it('contact.upsert on a second mailbox EDITS the owner', () => {
    const bob = store.upsertManual({ email: 'bob@personal.com', name: 'Bob' });
    attachSecondEmail(bob.contact_id!, 'bob@work.com');

    const edited = store.upsertManual({ email: 'bob@work.com', company: 'Acme' });

    // The row that changed is Bob's, under Bob's PK — reading back or emitting under
    // the ALIAS would have returned null and announced a record the warehouse has
    // never heard of.
    expect(edited.email).toBe('bob@personal.com');
    expect(edited.contact_id).toBe(bob.contact_id);
    expect(edited.company).toBe('Acme');
    expect(store.count()).toBe(1);
  });

  it('promotion onto someone else’s alias is a COLLISION, not a raw alias error', () => {
    // The PK-only check waved this through and let it surface three calls deeper as
    // an `email_alias_already_attached` out of the alias writer — the same defect
    // class, one door over, and with a far worse error for the caller to route on.
    const bob = store.upsertManual({ email: 'bob@personal.com', name: 'Bob' });
    attachSecondEmail(bob.contact_id!, 'bob@work.com');
    const stub = store.createMentionOnlyContact({ name: 'Mystery' });

    expect(() =>
      store.promoteMentionOnlyToVerified({
        contact_id: stub.contact_id!,
        email: 'bob@work.com',
      }),
    ).toThrow(/promote_email_already_attached/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 4 — a merge UNIONS the assertions (nothing moves)', () => {
  it('the survivor projects the loser’s fields — the contribution model’s promise', () => {
    // Pre-C-2 a merge simply BLANKED the loser's fields and kept only the survivor's:
    // whatever the loser knew was gone. Now the survivor's projection reads across
    // the merge group, so the union surfaces and the ladder settles the conflicts.
    const bob = store.upsertManual({
      email: 'bob@example.com', name: 'Bob', phone: '+16175550100',
    });
    const robert = store.upsertManual({ email: 'robert@example.com', name: 'Robert' });
    // Robert has a company; Bob has a phone. Neither has both.
    store.upsertContactAttribute({
      contact_id: robert.contact_id!, kind: 'org', value: 'Acme',
      source: 'vendor_meta', source_id: 'hubspot.prod.contact',
    });
    store.materializeContactProjection(robert.contact_id!);

    store.setMergedInto([store.get(bob.email)!], robert.email, 2_000);

    const survivor = store.get('robert@example.com')!;
    expect(survivor.phone).toBe('+16175550100'); // ← from BOB. The union.
    expect(survivor.company).toBe('Acme'); // ← still Robert's own
    expect(survivor.name).toBe('Robert'); // ← a tie the survivor wins (first-seen)
    expect(survivor.projection_provenance?.phone?.source).toBe('manual');
  });

  // ── The clobber this design exists to avoid ──────────────────────────────
  it('two contacts’ SAME-SOURCE contributions both survive a merge', () => {
    // THE reason contributions are not moved. The key is
    // `(contact_id, kind, source_id)`. Google exports "Bob Smith" and "Robert Smith"
    // as two records; both sync in as two contacts; both carry a
    // `google.personal.contact` name contribution; D-138's detector flags them; the
    // user merges. MOVING them lands both on
    // `(survivor, 'name', 'google.personal.contact')` — one silently overwrites the
    // other and the split can never give it back. That is the same peer-clobber the
    // `source_id` key was introduced to prevent, arriving through a different door.
    const bob = store.upsertManual({ email: 'bob@example.com' });
    const robert = store.upsertManual({ email: 'robert@example.com' });
    store.upsertContactAttribute({
      contact_id: bob.contact_id!, kind: 'name', value: 'Bob Smith',
      source: 'contact_book', source_id: 'google.personal.contact', as_of: 1_000,
    });
    store.upsertContactAttribute({
      contact_id: robert.contact_id!, kind: 'name', value: 'Robert Smith',
      source: 'contact_book', source_id: 'google.personal.contact', as_of: 2_000,
    });

    store.setMergedInto([store.get(bob.email)!], robert.email, 3_000);

    // BOTH of Google's assertions are still on disk, each under its OWN contact —
    // which is the whole point: they would have collided on
    // `(contact_id, kind, source_id)` had the merge moved them.
    const googlesView = (contact_id: string) =>
      store
        .listContactAttributes(contact_id, 'name')
        .filter((r) => r.source_id === 'google.personal.contact')
        .map((r) => r.value);
    expect(googlesView(bob.contact_id!)).toEqual(['Bob Smith']);
    expect(googlesView(robert.contact_id!)).toEqual(['Robert Smith']);

    // And the projection picks the fresher one — a decision, not a data loss.
    expect(store.get('robert@example.com')?.name).toBe('Robert Smith');
  });

  it('a SPLIT gives each contact its own fields back — both sides re-project', () => {
    const bob = store.upsertManual({
      email: 'bob@example.com', name: 'Bob', phone: '+16175550100',
    });
    const robert = store.upsertManual({ email: 'robert@example.com', name: 'Robert' });
    store.setMergedInto([store.get(bob.email)!], robert.email, 2_000);
    expect(store.get('robert@example.com')?.phone).toBe('+16175550100');

    // Undo it.
    store.setMergedInto([store.get(bob.email)!], null, 3_000);

    // The resurrected contact has its phone back …
    const split = store.get('bob@example.com')!;
    expect(split.merged_into).toBeUndefined();
    expect(split.phone).toBe('+16175550100');
    // … and — the quiet half — the FORMER SURVIVOR gave it up. Forgetting this side
    // leaves Robert still showing a phone number that now belongs to somebody else.
    expect(store.get('robert@example.com')?.phone).toBeUndefined();
  });

  it('re-projects the TERMINAL survivor, not whatever email the caller passed', () => {
    // `upstream-merge-handler` passes a STORED `row.survivor_email`, which may since
    // have been merged onward. Trusting it would land the re-projection on a
    // tombstone — which projects nothing — and the real survivor would keep showing
    // stale columns forever, silently. The merge group is transitive, so it is the
    // TERMINAL contact whose projection actually changed.
    const bob = store.upsertManual({
      email: 'bob@example.com', name: 'Bob', phone: '+16175550100',
    });
    const mid = store.upsertManual({ email: 'mid@example.com', name: 'Mid' });
    const top = store.upsertManual({ email: 'top@example.com', name: 'Top' });

    // mid is absorbed by top FIRST, so `mid@example.com` is now a stale address.
    store.setMergedInto([store.get(mid.email)!], top.email, 2_000);
    // …and now a caller merges bob into the STALE address.
    store.setMergedInto([store.get(bob.email)!], mid.email, 3_000);

    // Bob's phone must surface on TOP, the contact that actually survives.
    expect(store.get('top@example.com')?.phone).toBe('+16175550100');
    expect(store.resolveCanonicalEmail('bob@example.com').canonical_email).toBe(
      'top@example.com',
    );

    // And splitting bob back out must strip it from TOP — not from the tombstone in
    // the middle, which has no columns to strip.
    store.setMergedInto([store.get(bob.email)!], null, 4_000);
    expect(store.get('top@example.com')?.phone).toBeUndefined();
    expect(store.get('bob@example.com')?.phone).toBe('+16175550100');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 4 — a tombstone’s contributions belong to the SURVIVOR', () => {
  it('deleting a merged-away contact strips its data off the survivor', () => {
    // Found by review, and it is a privacy defect, not an untidiness. The merge group
    // means the survivor PROJECTS the loser's contributions — so deleting the loser
    // has to recompute the survivor, or her phone number stays in HIS `contacts.phone`
    // column. And because `contact_phone_forms` is a trigger-maintained index over
    // that column, it stays store-wide SEARCHABLE. The user deleted the person; her
    // number is still in the warehouse, filed under somebody else.
    store.upsertManual({ email: 'alice@old.com', name: 'Alice', phone: '+15550001111' });
    store.upsertManual({ email: 'bob@example.com', name: 'Bob' });
    store.setMergedInto([store.get('alice@old.com')!], 'bob@example.com', 2_000);
    expect(store.get('bob@example.com')?.phone).toBe('+15550001111'); // the union

    expect(store.delete('alice@old.com')).toBe(true);

    expect(store.get('bob@example.com')?.phone).toBeUndefined();
    expect(store.countPhoneForm('15550001111')).toBe(0); // gone from the search index too
  });

  it('a write to a merged-away address lands NOW — it does not vanish and teleport', () => {
    // The other half. `materializeContactProjection` used to silently no-op on a
    // tombstone, so a `contact.upsert` on a merged-away address wrote its contribution
    // and projected NOTHING — the edit was invisible. Then, at some arbitrary later
    // moment, the next unrelated re-projection of the survivor would make it appear.
    // A write that silently defers is worse than one that fails.
    store.upsertManual({ email: 'alice@old.com', name: 'Alice' });
    const bob = store.upsertManual({ email: 'bob@example.com', name: 'Bob' });
    store.setMergedInto([store.get('alice@old.com')!], 'bob@example.com', 2_000);

    store.upsertManual({ email: 'alice@old.com', phone: '+15551234567' });

    // Immediately visible on the survivor — no second event required.
    expect(store.get('bob@example.com')?.phone).toBe('+15551234567');

    // And an unrelated re-projection changes nothing (it is not "arriving late").
    store.materializeContactProjection(bob.contact_id!);
    expect(store.get('bob@example.com')?.phone).toBe('+15551234567');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('D-192 C-2 slice 4 — contact_id is IMMUTABLE', () => {
  it('refuses to re-key a contact, because that would orphan its contributions', () => {
    // Not hypothetical: FOUR test fixtures did exactly this — seed via `upsertManual`,
    // then raw-UPDATE `contact_id` to a readable literal. It was harmless for as long
    // as nothing hung off `contact_id`. The moment slice 3 made it the storage
    // identity, that line started silently orphaning every contribution and blanking
    // the contact at the next projection. A loud abort beats a quietly emptied contact.
    const bob = store.upsertManual({
      email: 'bob@example.com', name: 'Bob', company: 'Acme',
    });
    expect(store.listContactAttributes(bob.contact_id!).length).toBeGreaterThan(0);

    expect(() =>
      db
        .prepare(`UPDATE contacts SET contact_id = 'pretty_id' WHERE email = ?`)
        .run('bob@example.com'),
    ).toThrow(/contact_id_immutable/);

    // Untouched — and the contact still projects.
    expect(store.get('bob@example.com')?.company).toBe('Acme');
    expect(store.get('bob@example.com')?.contact_id).toBe(bob.contact_id);
  });

  it('still permits the boot ASSIGNMENT of a NULL contact_id', () => {
    // The two guards are disjoint: assigning an absent id is what the boot backfill
    // does on a pre-PA8 database and must keep doing. Only CHANGING a real one aborts.
    const bob = store.upsertManual({ email: 'bob@example.com', name: 'Bob' });
    // Blanking is the OTHER guard, and it must raise its OWN error rather than being
    // shadowed — SQLite does not define the firing order of two BEFORE triggers.
    expect(() =>
      db.prepare(`UPDATE contacts SET contact_id = '' WHERE email = ?`).run(bob.email),
    ).toThrow(/contact_id_required/);
  });
});
