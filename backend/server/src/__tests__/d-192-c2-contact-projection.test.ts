/** D-192 C-2 (Stance 2) slice 2 — the PROJECTION / materializer.
 *
 *  The `data.contact` row stops being STORAGE and becomes a PROJECTION over the
 *  contributions: each field independently takes its strongest assertion via the
 *  one C-2a ladder. A contact carries a hand-typed `org` AND a CRM-sourced
 *  `title` at once, each with its own provenance — which a single-valued column
 *  can never do, because the second writer destroys the first.
 *
 *  Exercised through the REAL store against a real SQLite file: the invariants
 *  under test are the materialized columns, the D-138 blocking keys, and the
 *  FTS / phone-form triggers that hang off them — none of which a mock asserts.
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
} from '@recued/contracts';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

const seedContact = (email: string): string => {
  store.observe({ email, name: 'Seed', source: 'email_from', event_at: 1_000 });
  const contact_id = store.get(email)?.contact_id;
  if (!contact_id) throw new Error('seed contact has no contact_id');
  return contact_id;
};

/** Read the raw row — the projection's real output is COLUMNS, and asserting on
 *  the record alone would miss a column the record shape happens to hide. */
const rawRow = (contact_id: string): Record<string, unknown> =>
  db
    .prepare('SELECT * FROM contacts WHERE contact_id = ?')
    .get(contact_id) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-projection-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-192 C-2 slice 2 — the projection', () => {
  it('projects each field INDEPENDENTLY from its strongest source', () => {
    const id = seedContact('bob@example.com');
    // The user typed the org. HubSpot knows the title. Google has an old title.
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme (typed)',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Corporation',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP Sales',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'Sales Rep',
      source_id: 'google.personal.contact', source: 'contact_book',
    });

    const rec = store.materializeContactProjection(id);

    // Hand-typed org survives the CRM; CRM title beats the stale address book.
    expect(rec?.company).toBe('Acme (typed)');
    expect(rec?.title).toBe('VP Sales');
  });

  it('carries per-field provenance — so a surface can say WHERE a value came from', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
    });

    const rec = store.materializeContactProjection(id);

    // D-205: the entry carries the winner's `as_of` + `confidence` alongside the
    // rung. Not decoration — they are the two tiebreakers BELOW the rung in
    // `resolveContribution`, and the merge-review highlight cannot PREDICT the
    // post-merge value without them: a rung tie (two mail-derived duplicates —
    // the commonest merge of all) would be undecidable, and the dialog would
    // either guess or, as it does now, decline to highlight at all. Drop these
    // and the client silently degrades to no highlight. Hence pinned here.
    expect(rec?.projection_provenance?.org).toEqual({
      source: 'manual', source_id: CONTACT_SOURCE_ID_MANUAL,
      as_of: expect.any(Number), confidence: expect.any(Number),
    });
    expect(rec?.projection_provenance?.title).toEqual({
      source: 'vendor_meta', source_id: 'hubspot.prod.contact',
      as_of: expect.any(Number), confidence: expect.any(Number),
    });
  });

  it('D-205: provenance carries the WINNER’s as_of — not the loser’s, not the clock', () => {
    // The value the merge-review highlight ranks on. If it were stamped from the
    // losing contribution (or from `Date.now()`), the dialog would rank a rung tie
    // on a number that has nothing to do with who asserted what — the same class of
    // error as the `last_interaction` bug this replaced.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Inc.',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
      as_of: 1_600_000_000_000, confidence: 0.9,
    });
    // Fresher, but a WEAKER rung — it loses, and its `as_of` must not be stamped.
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Corp',
      source_id: 'google.personal.contact', source: 'contact_book',
      as_of: 1_700_000_000_000, confidence: 1,
    });

    const rec = store.materializeContactProjection(id);

    expect(rec?.company).toBe('Acme Inc.');
    expect(rec?.projection_provenance?.org).toEqual({
      source: 'vendor_meta', source_id: 'hubspot.prod.contact',
      as_of: 1_600_000_000_000, confidence: 0.9,
    });
  });

  it('closes the UNIVERSAL GAP — title, photo and birthday finally land', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'Chief Cheese Officer',
      source_id: 'google.personal.contact', source: 'contact_book',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'photo', value: 'https://example.com/bob.jpg',
      source_id: 'google.personal.contact', source: 'contact_book',
    });
    // Year-less birthdays are real; an ISO string holds one, an epoch cannot.
    store.upsertContactAttribute({
      contact_id: id, kind: 'birthday', value: '--03-04',
      source_id: 'google.personal.contact', source: 'contact_book',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.title).toBe('Chief Cheese Officer');
    expect(rec?.photo).toBe('https://example.com/bob.jpg');
    expect(rec?.birthday).toBe('--03-04');
  });

  it('projects a structured address, and a phone from its alias', () => {
    const id = seedContact('bob@example.com');
    const addr = { street: '1 Main St', city: 'Boston', zip: '02101', country: 'US' };
    store.upsertContactAttribute({
      contact_id: id, kind: 'address', value: addr,
      source_id: 'google.personal.contact', source: 'contact_book',
    });
    // Phone lives on the IDENTIFIER axis (it is matchable), so it arrives as an
    // alias — but it still projects onto the `contacts.phone` column.
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias',
      alias_pattern: '+16175550100', source: 'manual',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.mailing_address).toEqual(addr);
    expect(rec?.phone).toBe('+16175550100');
  });

  // ── The blocking keys — a quiet false-negative in dedup is the worst case ──
  it('RECOMPUTES the D-138 blocking keys from the projected values', () => {
    // `contact_merge_candidate_scan` only evaluates its predicate against pairs
    // sharing a blocking key. A stale key does not mis-match — it produces NO
    // match, so the merge detector silently stops seeing a duplicate it should
    // have caught, and nothing surfaces it.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'name', value: 'Bob Smith',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Inc.',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'address',
      value: { street: '1 Main St', city: 'Boston', zip: '02101', country: 'US' },
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });

    store.materializeContactProjection(id);

    const row = rawRow(id);
    expect(row.name_key).toBeTruthy();
    expect(row.company_norm).toBeTruthy();
    expect(row.address_zip_country_key).toBeTruthy();
    // And they track the PROJECTED value, not a stale one.
    expect(String(row.company_norm)).toContain('acme');
  });

  it('keeps the FTS + phone-form triggers correct — the reason we materialize INTO the row', () => {
    // The projection lives in COLUMNS precisely because `contacts_fts` (name,
    // company) and `contact_phone_forms` (phone) are maintained by SQL triggers
    // on this table. A projection that lived only in the contribution stores
    // would leave search and phone-matching reading stale values forever, with
    // nothing to notice.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'name', value: 'Zebediah Quicksilver',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias',
      alias_pattern: '+16175550100', source: 'manual',
    });

    store.materializeContactProjection(id);

    const hits = db
      .prepare("SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH 'Zebediah'")
      .all();
    expect(hits.length).toBe(1);

    const forms = db
      .prepare(
        `SELECT COUNT(*) AS n FROM contact_phone_forms
           WHERE rowid_ref = (SELECT rowid FROM contacts WHERE contact_id = ?)`,
      )
      .get(id) as { n: number };
    expect(forms.n).toBeGreaterThan(0);
  });

  // ── company_source: a dead enum member comes alive ─────────────────────
  it('finally writes company_source = vendor_meta (dead since D-138)', () => {
    // No CRM reconciler has ever touched this store, so `'vendor_meta'` has been
    // a declared-but-unwritable enum value. The projection is its first writer.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme Corp',
      source_id: 'hubspot.prod.contact', source: 'vendor_meta',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.company).toBe('Acme Corp');
    expect(rec?.company_source).toBe('vendor_meta');
  });

  it('leaves company_source unset for a rung the narrow enum cannot express', () => {
    // `contact_book` has no `ContactCompanySource` equivalent — and `undefined`
    // is the CORRECT answer for that column's one consumer, the D-138 domain
    // inference seed pool: a company nobody authoritative asserted must not seed
    // inference about other people.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme',
      source_id: 'google.personal.contact', source: 'contact_book',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.company).toBe('Acme');
    expect(rec?.company_source).toBeUndefined();
    // …but the full truth is never lost.
    expect(rec?.projection_provenance?.org?.source).toBe('contact_book');
  });

  // ── Boundaries ────────────────────────────────────────────────────────
  it('NEVER touches email — re-electing a primary is an identity op (slice 4)', () => {
    // `contacts.email` is the PK and the public address. Changing it must
    // cascade to the six email-keyed tables — that cannot be a side effect of
    // materializing a title.
    const id = seedContact('bob@example.com');
    store.upsertContactAlias({
      contact_id: id, kind: 'email_alias',
      alias_pattern: 'bob.other@example.com', source: 'manual',
    });
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.email).toBe('bob@example.com');
    expect(rec?.title).toBe('VP');
  });

  it('a field with NO contribution projects to NULL — absent is not empty', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: 'VP',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.title).toBe('VP');
    // `company` has no contribution, so the projection holds nothing there — the
    // rule that made the materializer a LOADED GUN until slice 3, because it
    // would have blanked every legacy column no contribution had claimed.
    expect(rec?.company).toBeUndefined();
    // And this is the gate closing. Before slice 3 the seeded row's `name` had no
    // contribution either, and projecting it WIPED the name. Now the write path
    // that created the contact contributed one, so the same projection preserves
    // it — which is the entire licence to run the materializer automatically.
    expect(rec?.name).toBe('Seed');
    expect(rec?.projection_provenance?.name?.source).toBe('derived');
  });

  it('drops a value whose SHAPE is wrong rather than writing "[object Object]"', () => {
    // A garbage column value is worse than an absent one: it looks like data.
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'title', value: { nested: 'wrong' },
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.title).toBeUndefined();
    // …and it must not claim provenance for a value the row does not hold.
    expect(rec?.projection_provenance?.title).toBeUndefined();
  });

  // ── Provenance must never LIE ─────────────────────────────────────────
  it('reports the REAL source of an imported phone — not "the user typed it"', () => {
    // `contact_alias` records both halves: the trust RUNG (`source`) and the
    // source INSTANCE (`source_id`). Without the instance the projection would
    // have to fabricate one, and a Google-imported phone would be reported as
    // hand-typed. Provenance that lies is worse than provenance that is absent,
    // because a surface renders it as fact.
    const id = seedContact('bob@example.com');
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550100',
      source: 'contact_book', source_id: 'google.personal.contact',
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.phone).toBe('+16175550100');
    expect(rec?.projection_provenance?.phone).toEqual({
      source: 'contact_book', source_id: 'google.personal.contact',
      // An alias carries no event time, so `as_of` is its ingestion time — the
      // honest proxy `phoneContributionsFor` already documents, not a fabrication.
      as_of: expect.any(Number), confidence: expect.any(Number),
    });
  });

  it('OMITS source_id when the writer recorded none — "unknown" beats a guess', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550100',
      source: 'ai_inferred', // no source_id supplied
    });

    const rec = store.materializeContactProjection(id);
    expect(rec?.projection_provenance?.phone?.source).toBe('ai_inferred');
    expect(rec?.projection_provenance?.phone?.source_id).toBeUndefined();
  });

  it('a manual alias self-fills its source_id — there is exactly one of the user', () => {
    const id = seedContact('bob@example.com');
    const alias = store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias',
      alias_pattern: '+16175550100', source: 'manual',
    });
    expect(alias.source_id).toBe(CONTACT_SOURCE_ID_MANUAL);
  });

  it('a promotion carries source_id with it — authorship follows the value', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550100',
      source: 'ai_inferred', source_id: 'recipe.guessed_it',
    });
    // A stronger writer takes the alias over — and takes its authorship too.
    // Leaving the old instance behind would credit the new value to whoever
    // happened to write it first.
    const promoted = store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550100',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    expect(promoted.source).toBe('contact_book');
    expect(promoted.source_id).toBe('google.personal.contact');
  });

  it('purges one Source’s aliases and leaves its peers standing', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550100',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    store.upsertContactAlias({
      contact_id: id, kind: 'chat_alias', alias_pattern: 'bobby',
      source: 'contact_book', source_id: 'google.personal.contact',
    });
    store.upsertContactAlias({
      contact_id: id, kind: 'phone_alias', alias_pattern: '+16175550199',
      source: 'contact_book', source_id: 'outlook.work.contact',
    });

    expect(store.deleteContactAliasesForSource('google.personal.contact')).toBe(2);
    // Asserted by SOURCE, not by count: the seeding `observe` now contributes the
    // contact's own `email_alias` (slice 3), and teardown must leave it standing —
    // a disconnected address book does not take the person's email address with
    // it. What has to be gone is Google's, and only Google's.
    const left = store.listContactAliases(id);
    expect(left.map((r) => r.source_id).sort()).toEqual(
      [CONTACT_SOURCE_ID_DERIVED, 'outlook.work.contact'].sort(),
    );
    expect(left.find((r) => r.kind === 'email_alias')?.alias_pattern).toBe(
      'bob@example.com',
    );
  });

  it('is idempotent', () => {
    const id = seedContact('bob@example.com');
    store.upsertContactAttribute({
      contact_id: id, kind: 'org', value: 'Acme',
      source_id: CONTACT_SOURCE_ID_MANUAL, source: 'manual',
    });

    const a = store.materializeContactProjection(id, 5_000);
    const b = store.materializeContactProjection(id, 5_000);
    expect(b?.company).toBe(a?.company);
    expect(b?.projection_provenance).toEqual(a?.projection_provenance);
  });

  it('returns null for an unknown contact_id', () => {
    expect(store.materializeContactProjection('nope')).toBeNull();
  });
});
