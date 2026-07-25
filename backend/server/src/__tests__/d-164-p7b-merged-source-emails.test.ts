/** D-164 P7 follow-up — `ContactStore.listMergedSourceEmails`.
 *
 *  The reverse `merged_into` walk feeding the mail from-count person-scoping:
 *  every tombstone email whose redirect chain terminates at the supplied
 *  contact. Pins:
 *    - empty result for unknown / never-merged emails;
 *    - direct tombstones surface;
 *    - TRANSITIVE chains surface every hop (A→B→C: asking C yields A AND B —
 *      the merge handler skips already-merged losers, so chains are real);
 *    - input canonicalization (case) + email-ascending order;
 *    - mention-only placeholder tombstones are RAW TRUTH here (the gate
 *      filters; the store reports what is stored);
 *    - a corrupt redirect CYCLE terminates (UNION dedup) instead of hanging. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merged-source-emails-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (email: string, name: string): void => {
  store.observe({ email, name, source: 'email_from', event_at: 1_000 }, 1_000);
};

/** Tombstone `loser` into `survivor` via the substrate primitive the merge
 *  transaction uses. */
const mergeInto = (loser: string, survivor: string): void => {
  const row = store.get(loser);
  expect(row).not.toBeNull();
  store.setMergedInto([row!], survivor, 2_000);
};

describe('listMergedSourceEmails', () => {
  it('returns [] for an unknown email and for a contact nothing merged into', () => {
    seed('alone@x.com', 'Alone');
    expect(store.listMergedSourceEmails('missing@x.com')).toEqual([]);
    expect(store.listMergedSourceEmails('alone@x.com')).toEqual([]);
  });

  it('returns [] for a blank / uncanonicalizable input', () => {
    expect(store.listMergedSourceEmails('')).toEqual([]);
    expect(store.listMergedSourceEmails('   ')).toEqual([]);
  });

  it('surfaces direct tombstones, email-ascending', () => {
    seed('pat@x.com', 'Pat Lee');
    seed('zz-old@x.com', 'Pat Lee');
    seed('aa-old@x.com', 'Pat Lee');
    mergeInto('zz-old@x.com', 'pat@x.com');
    mergeInto('aa-old@x.com', 'pat@x.com');
    expect(store.listMergedSourceEmails('pat@x.com')).toEqual([
      'aa-old@x.com',
      'zz-old@x.com',
    ]);
  });

  it('walks TRANSITIVE chains — A→B→C surfaces both A and B for C', () => {
    seed('a@x.com', 'Pat Lee');
    seed('b@x.com', 'Pat Lee');
    seed('c@x.com', 'Pat Lee');
    mergeInto('a@x.com', 'b@x.com'); // A → B
    mergeInto('b@x.com', 'c@x.com'); // B → C (A still points at B — a real chain)
    expect(store.listMergedSourceEmails('c@x.com')).toEqual(['a@x.com', 'b@x.com']);
    // Asking a mid-chain tombstone surfaces only its own sub-tree.
    expect(store.listMergedSourceEmails('b@x.com')).toEqual(['a@x.com']);
  });

  it('canonicalizes the input email (case-insensitive ask)', () => {
    seed('pat@x.com', 'Pat Lee');
    seed('old@x.com', 'Pat Lee');
    mergeInto('old@x.com', 'pat@x.com');
    expect(store.listMergedSourceEmails('PAT@X.COM')).toEqual(['old@x.com']);
  });

  it('reports mention-only placeholder tombstones verbatim (callers filter)', () => {
    seed('pat@x.com', 'Pat Lee');
    const stub = store.createMentionOnlyContact({ name: 'Pat Lee' }, 1_500);
    mergeInto(stub.email, 'pat@x.com');
    expect(store.listMergedSourceEmails('pat@x.com')).toEqual([stub.email]);
  });

  it('REFUSES to close a merge cycle rather than corrupting the graph', () => {
    // D-192 C-2 slice 4. `setMergedInto` used to be a raw primitive with no cycle
    // guard, and this test abused it to manufacture the corruption below. It now
    // refuses: a cyclic `merged_into` graph has NO terminal survivor, so every read
    // that walks it is left with no correct answer to give. The check runs before the
    // write and the transaction rolls back, so the graph is never even transiently
    // corrupt.
    seed('a@x.com', 'Pat Lee');
    seed('b@x.com', 'Pat Lee');
    mergeInto('a@x.com', 'b@x.com');

    expect(() => mergeInto('b@x.com', 'a@x.com')).toThrow(/contact_merge_cycle/);
    // Rolled back — b is still a live contact, not a half-written tombstone.
    expect(store.get('b@x.com')?.merged_into).toBeUndefined();
  });

  it('terminates on a corrupt redirect CYCLE instead of recursing forever', () => {
    seed('a@x.com', 'Pat Lee');
    seed('b@x.com', 'Pat Lee');
    // The substrate now refuses to BUILD a cycle (above), so the only way one can
    // exist is if something outside it wrote the column directly — which is exactly
    // the corruption the UNION-dedup CTE has to survive. Manufacture it that way.
    db.prepare(`UPDATE contacts SET merged_into = ? WHERE email = ?`).run('b@x.com', 'a@x.com');
    db.prepare(`UPDATE contacts SET merged_into = ? WHERE email = ?`).run('a@x.com', 'b@x.com');

    const out = store.listMergedSourceEmails('a@x.com');
    // Content on corrupt data is best-effort; termination + both members of
    // the cycle appearing once each is the pin.
    expect(out).toEqual(['a@x.com', 'b@x.com']);
  });
});
