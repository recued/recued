/** D-205 merge-review item 3 — the PER-SOURCE value view (`contact.contributions`).
 *
 *  The projection materializes only the WINNER onto the contact row, so a client
 *  could see what a field holds and (since #2a) who asserted it — but never what the
 *  OTHER sources said. The ladder was legible in its OUTCOME and invisible in its
 *  INPUT. This is the read that closes that.
 *
 *  🔑 **What these tests actually defend is the ROW SET.** The obvious implementation
 *  — `listContactAttributes(contact_id)` — is wrong in two independent ways, and both
 *  produce a view that is not merely incomplete but *lying*: it would present a set
 *  of "everything behind this field" that does not contain the value the record
 *  holds. The merge-group case and the phone case below are those two traps. Delete
 *  either test and the natural refactor ("why not just list the attributes?") silently
 *  reintroduces the bug.
 *
 *  Exercised through the REAL store + the REAL handler against real SQLite — the
 *  invariant is which rows come back and which one is stamped `winner`, and a mock
 *  asserts neither. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONTACT_SOURCE_ID_MANUAL } from '@recued/contracts';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import { handleContactContributions } from '../contact-handler.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

const seedContact = (email: string): string => {
  store.observe({ email, name: 'Seed', source: 'email_from', event_at: 1_000 });
  const contact_id = store.get(email)?.contact_id;
  if (!contact_id) throw new Error('seed contact has no contact_id');
  return contact_id;
};

const contributionsFor = async (email: string) =>
  (await handleContactContributions({ store }, { email })).contributions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-contributions-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-205 item 3 — contact.contributions: the row set', () => {
  it('returns every source’s value for a field, and stamps the LADDER’s pick as winner', () => {
    const id = seedContact('bob@example.com');
    // Google asserted a fresher value at a WEAKER rung; HubSpot a staler one at a
    // stronger rung. The projection keeps HubSpot's — and the view must say so, or a
    // user reading it would conclude Recued is showing them Google's.
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Corp',
      source: 'contact_book', source_id: 'google.personal.contact', as_of: 1_700_000_000_000,
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Inc.',
      source: 'vendor_meta', source_id: 'hubspot.prod.contact', as_of: 1_600_000_000_000,
    });
    store.materializeContactProjection(id);

    return contributionsFor('bob@example.com').then((rows) => {
      const orgs = rows.filter((r) => r.kind === 'org');
      expect(orgs).toHaveLength(2);
      expect(orgs.find((r) => r.winner)?.value).toBe('Acme Inc.');
      expect(orgs.filter((r) => !r.winner).map((r) => r.value)).toEqual(['Acme Corp']);
      // And the winner is the value the record actually holds.
      expect(store.get('bob@example.com')?.company).toBe('Acme Inc.');
    });
  });

  it('🔑 spans the MERGE GROUP — a merge moves nothing, so the loser’s rows are still evidence', async () => {
    // THE trap. `listContactAttributes(survivor)` reads ONE contact_id, but a merge
    // MOVES NOTHING (D-205 §1) — the absorbed contact keeps its own contributions and
    // the survivor reads them through the merge GROUP. So a per-contact read of a
    // merged survivor drops the absorbed rows, AND — as here — the dropped row can be
    // the one that WON. The view would then omit the very value the record displays.
    const survivor = seedContact('bob@example.com');
    const loser = seedContact('b.smith@example.com');

    // The absorbed contact is the one carrying the CRM's assertion.
    store.upsertContactAttribute({
      contact_id: loser, kind: 'org', value: 'Acme Inc.',
      source: 'vendor_meta', source_id: 'hubspot.prod.contact', as_of: 1_600_000_000_000,
    });
    store.upsertContactAttribute({
      contact_id: survivor, kind: 'org', value: 'Acme Corp',
      source: 'contact_book', source_id: 'google.personal.contact', as_of: 1_700_000_000_000,
    });

    const loserRow = store.get('b.smith@example.com')!;
    store.setMergedInto([loserRow], 'bob@example.com', Date.now());
    store.materializeContactProjection(survivor);

    // The projection reads the group, so the record holds the ABSORBED row's value.
    expect(store.get('bob@example.com')?.company).toBe('Acme Inc.');

    const orgs = (await contributionsFor('bob@example.com')).filter((r) => r.kind === 'org');
    expect(orgs).toHaveLength(2);
    // The absorbed contact's row is present AND is the winner. A `listContactAttributes`
    // implementation returns only 'Acme Corp' here — a one-row view, missing the winner,
    // contradicting the value on screen.
    expect(orgs.find((r) => r.winner)?.value).toBe('Acme Inc.');
    expect(orgs.find((r) => r.winner)?.source_id).toBe('hubspot.prod.contact');
  });

  it('🔑 includes PHONE — a phone is an ALIAS, not an attribute', async () => {
    // The second trap. `phone` is an IDENTIFIER: it lives in `contact_alias` as
    // `phone_alias`, gathered by `phoneContributionsFor`. An attribute-only read shows
    // NO phone rows at all — for a field the detail page renders.
    const id = seedContact('bob@example.com');
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550100',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    store.materializeContactProjection(id);

    const rows = await contributionsFor('bob@example.com');
    const phones = rows.filter((r) => r.kind === 'phone');
    expect(phones).toHaveLength(1);
    expect(phones[0]!.value).toBe('+16175550100');
    expect(phones[0]!.winner).toBe(true);
    // It is genuinely absent from the attribute store — which is exactly why an
    // attribute-only read would have shown nothing.
    expect(store.listContactAttributes(id, 'phone' as never)).toHaveLength(0);
  });
});

describe('D-205 item 3 — contact.contributions: what it refuses to claim', () => {
  it('marks NO winner for a kind whose value the projection DROPPED', async () => {
    // The materializer discards a winner whose value has the wrong shape (an object
    // where a scalar belongs) rather than writing "[object Object]", and then claims
    // no provenance for that field. The record holds NOTHING for it — so calling the
    // resolver's pick "kept" would be a lie about what the user is looking at.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: { nope: 'an object where a string belongs' },
      source: 'manual', source_id: CONTACT_SOURCE_ID_MANUAL,
    });
    store.materializeContactProjection(id);

    // The projection dropped it: no column, no provenance.
    const rec = store.get('bob@example.com');
    expect(rec?.title).toBeUndefined();
    expect(rec?.projection_provenance?.title).toBeUndefined();

    const titles = (await contributionsFor('bob@example.com')).filter((r) => r.kind === 'title');
    // The row is still returned — it IS evidence, and hiding it would be its own lie.
    expect(titles).toHaveLength(1);
    // But nobody won, because the record holds nothing.
    expect(titles[0]!.winner).toBe(false);
  });

  it('🔑 asked about a MERGED-AWAY address, answers about the survivor — with a winner', async () => {
    // Both halves have to resolve through the merge chain or they answer about
    // DIFFERENT contacts. `store.get` is a plain PK lookup: for a merged-away address
    // it returns the TOMBSTONE, whose columns (and `projection_provenance`) are
    // deliberately BLANKED. Read the rows from the survivor's group but the provenance
    // off the tombstone and you get the right evidence with NOTHING marked kept —
    // every source rendered as a loser, and the value the record actually holds
    // attributed to nobody.
    const survivor = seedContact('bob@example.com');
    const loser = seedContact('b.smith@example.com');
    store.upsertContactAttribute({
      contact_id: survivor, kind: 'org', value: 'Acme Inc.',
      source: 'vendor_meta', source_id: 'hubspot.prod.contact', as_of: 1_600_000_000_000,
    });
    store.upsertContactAttribute({
      contact_id: loser, kind: 'org', value: 'Acme Corp',
      source: 'contact_book', source_id: 'google.personal.contact', as_of: 1_700_000_000_000,
    });
    store.setMergedInto([store.get('b.smith@example.com')!], 'bob@example.com', Date.now());
    store.materializeContactProjection(survivor);

    // The tombstone's own provenance is gone — which is exactly the trap.
    expect(store.get('b.smith@example.com')?.projection_provenance).toBeUndefined();

    const orgs = (await contributionsFor('b.smith@example.com')).filter((r) => r.kind === 'org');
    expect(orgs).toHaveLength(2);
    expect(orgs.find((r) => r.winner)?.value).toBe('Acme Inc.');
  });

  it('returns an empty list for an unknown contact rather than throwing', async () => {
    expect(await contributionsFor('nobody@example.com')).toEqual([]);
  });

  it('rejects a missing email', async () => {
    await expect(handleContactContributions({ store }, { email: '  ' })).rejects.toThrow(
      /email is required/,
    );
  });
});
