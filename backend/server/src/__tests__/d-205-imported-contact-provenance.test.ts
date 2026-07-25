/** D-205 #4a — an IMPORT may never launder its provenance.
 *
 *  Contact books are the first `full_import` source, and `full_import` means
 *  CREATE. Every create path that existed before this could only stamp what the
 *  ROW's own creator was — and both of them lied for an importer:
 *
 *    - `createMentionOnlyContact` hardcodes `source='manual'` **in its SQL**, so a
 *      contact-book import would have read as **hand-typed by the user** — parked
 *      at the TOP of the C-2a ladder where the user's own typing could never
 *      correct it. That is the exact data loss the ladder exists to prevent.
 *    - `observe` carries no `source_id`, so its contributions are attributed via
 *      `contributionSourceIdForRung` → `recued.derived`: a claim that Recued
 *      derived from a mail header a name that Google asserted, and a COLLISION
 *      with the contact's real derived rows on `(contact_id, kind, source_id)`.
 *
 *  So an import gets its own path: `createImportedContact` mints the IDENTITY and
 *  writes **no contributions at all** — the sync's write pass supplies every field
 *  at the declaration's rung with the Source's own id.
 *
 *  Also pinned: the `ContactSource → rung` map. It was a ternary
 *  (`source === 'manual' ? 'manual' : 'derived'`) with an `| string` signature, so
 *  `contact_book` would have landed on `derived` **silently, with no compile
 *  error** — an import ranked below the rung of its own name. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_CONTRIBUTION_SOURCES,
  CONTACT_IMPORT_RUNGS,
  contactContributionRank,
  contactSourceToContributionRung,
} from '@recued/contracts';
import {
  createContactStore,
  isMentionOnlyEmail,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-import-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-205 #4a — the contact_book rung', () => {
  it('sits BELOW a CRM and ABOVE derived — renamed in place, so every rank is preserved', () => {
    expect([...CONTACT_CONTRIBUTION_SOURCES]).toEqual([
      'manual',
      'user_confirmed',
      'vendor_meta',
      'contact_book',
      'derived',
      'ai_inferred',
      'domain_inferred',
    ]);
    // Contact books rot; CRMs are curated — just not by this human.
    expect(contactContributionRank('vendor_meta')).toBeLessThan(
      contactContributionRank('contact_book'),
    );
    // But somebody CHOSE to keep this person. Nobody chooses to appear in a
    // mail header.
    expect(contactContributionRank('contact_book')).toBeLessThan(
      contactContributionRank('derived'),
    );
  });

  it('is an IMPORT rung — so no importer can ever write a user rung', () => {
    expect([...CONTACT_IMPORT_RUNGS]).toEqual(['vendor_meta', 'contact_book']);
    expect(CONTACT_IMPORT_RUNGS).not.toContain('manual');
    expect(CONTACT_IMPORT_RUNGS).not.toContain('user_confirmed');
  });

  it('🔑 the ContactSource→rung map does NOT collapse contact_book into derived', () => {
    // The bug this pins. The map was `source === 'manual' ? 'manual' : 'derived'`
    // with an `| string` signature: adding a member landed it on `derived` with no
    // compile error, ranking an import BELOW the rung of its own name.
    expect(contactSourceToContributionRung('contact_book')).toBe('contact_book');
    // …while the warehouse-traffic sources still are what `derived` exists for.
    expect(contactSourceToContributionRung('email_from')).toBe('derived');
    expect(contactSourceToContributionRung('email_to')).toBe('derived');
    expect(contactSourceToContributionRung('calendar_attendee')).toBe('derived');
    expect(contactSourceToContributionRung('manual')).toBe('manual');
    // The runtime floor: a value that crossed a boundary and never met the type.
    expect(contactSourceToContributionRung('who_knows')).toBe('derived');
  });
});

describe('D-205 #4a — createImportedContact', () => {
  it('an entry WITH an address is keyed on it and is verified', () => {
    const bob = store.createImportedContact({
      email: 'Bob@Example.COM',
      name: 'Bob Smith',
      source: 'contact_book',
    });

    expect(bob.email).toBe('bob@example.com'); // canonicalized
    expect(bob.identity_status).toBe('verified');
    expect(bob.source).toBe('contact_book');
    expect(bob.contact_id).toBeTruthy();
  });

  it('🔑 THE DENTIST — name + no address → a PARTIAL contact on a synthetic key', () => {
    const dentist = store.createImportedContact({
      name: 'Dr. Smith',
      source: 'contact_book',
      identity_status: 'partial',
    });

    // `contacts.email` IS the PK, so a contact without an address still needs
    // something to be keyed on — and everything written about them until they get
    // a real one is keyed on THAT.
    expect(isMentionOnlyEmail(dentist.email)).toBe(true);
    expect(dentist.identity_status).toBe('partial');
    expect(dentist.source).toBe('contact_book');

    // And he is promotable the day he emails you — the whole point of `partial`.
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: dentist.contact_id!,
      email: 'dr.smith@dental.example',
    });
    expect(promoted.identity_status).toBe('verified');
    expect(promoted.contact_id).toBe(dentist.contact_id); // identity is immutable
  });

  it('defaults to mention_only when the caller says nothing (a name and nothing else)', () => {
    const c = store.createImportedContact({ name: 'The Cheese Guy', source: 'contact_book' });
    expect(c.identity_status).toBe('mention_only');
  });

  it('⛔ REFUSES source: manual — an import may never claim the user typed it', () => {
    expect(() =>
      store.createImportedContact({ email: 'x@y.com', name: 'X', source: 'manual' }),
    ).toThrow(/imported_contact_source_manual/);
  });

  it('refuses a nameless contact — an identity nothing could ever match', () => {
    expect(() =>
      store.createImportedContact({ name: '   ', source: 'contact_book' }),
    ).toThrow(/imported_contact_name_required/);
  });

  it('🔑 writes NO contributions — the write pass owns them, at the Sources rung', () => {
    const bob = store.createImportedContact({
      email: 'bob@example.com',
      name: 'Bob Smith',
      source: 'contact_book',
    });

    // Nothing here may claim provenance it does not have. A `name` written on this
    // path would have to route through `contributionSourceIdForRung` → the
    // `recued.derived` instance, claiming Recued derived from warehouse traffic a
    // name that Google asserted — and colliding with the contact's real derived
    // rows on `(contact_id, kind, source_id)`.
    expect(store.listContactAttributes(bob.contact_id!)).toEqual([]);

    // The write pass then supplies it, correctly attributed…
    store.upsertContactAttribute({
      contact_id: bob.contact_id!,
      kind: 'name',
      value: 'Bob Smith',
      source: 'contact_book',
      source_id: 'google.personal.contact',
      as_of: 1000,
    });
    store.materializeContactProjection(bob.contact_id!, 2000);

    // …and the projection attributes the field to the SOURCE, not to Recued.
    const projected = store.get('bob@example.com');
    expect(projected?.projection_provenance?.name?.source).toBe('contact_book');
    expect(projected?.projection_provenance?.name?.source_id).toBe('google.personal.contact');
  });

  it('a CRM import outranks a contact book for the same field — the ladder, not the clock', () => {
    const bob = store.createImportedContact({
      email: 'bob@example.com',
      name: 'Bob Smith',
      source: 'contact_book',
    });

    // Google says Acme Corp (contact_book). HubSpot says Acme Inc. (vendor_meta).
    // HubSpot wins on RUNG even though Google wrote later — the merge dialog's
    // latest-write-wins highlight disagrees with this, which is its own bug.
    store.upsertContactAttribute({
      contact_id: bob.contact_id!,
      kind: 'org',
      value: 'Acme Inc.',
      source: 'vendor_meta',
      source_id: 'hubspot.work.contact',
      as_of: 1000,
    });
    store.upsertContactAttribute({
      contact_id: bob.contact_id!,
      kind: 'org',
      value: 'Acme Corp',
      source: 'contact_book',
      source_id: 'google.personal.contact',
      as_of: 9999, // FRESHER, and it still loses
    });
    store.materializeContactProjection(bob.contact_id!, 10_000);

    const projected = store.get('bob@example.com');
    expect(projected?.company).toBe('Acme Inc.');
    // ⚠ the provenance map is keyed by CONTRIBUTION KIND (`org`), not the column
    // name (`company`) — the #2a trap.
    expect(projected?.projection_provenance?.org?.source).toBe('vendor_meta');

    // Both rows survive. Nothing was overwritten; the ladder just chose.
    const orgRows = store.listContactAttributes(bob.contact_id!, 'org');
    expect(orgRows).toHaveLength(2);
  });
});
