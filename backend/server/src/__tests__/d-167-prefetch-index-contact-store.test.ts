import Database from 'better-sqlite3';
import { phoneMatchDigits } from '@recued/transforms';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContactPrefetchSearch } from '../chat-prefetch-search.js';
import {
  createContactStore,
  ensureContactSchema,
  PREFETCH_FTS_LIMIT,
  type ContactStore,
} from '../storage/contact-store.js';

let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
});

const refsFor = (query: {
  readonly tokens?: readonly string[];
  readonly forms?: readonly string[];
  readonly emails?: readonly string[];
}): string[] =>
  store.prefetchCandidates({
    tokens: query.tokens ?? [],
    forms: query.forms ?? [],
    emails: query.emails ?? [],
  }).map((r) => r.email).sort();

/** Direct insert for the null-name / null-company edge ONLY: `upsertManual` derives
 *  a display name from the email local-part when none is given, so a genuinely
 *  null-`name` (or null-`company`) row — the case `listAllNamesAndCompanies`'s
 *  null-filter guards — can't be produced through the public write API. Normal
 *  fixtures use `store.upsertManual` (the real trigger-maintained path). */
const insertNullableContact = (input: {
  readonly email: string;
  readonly name?: string | null;
  readonly company?: string | null;
  readonly now?: number;
}): void => {
  const now = input.now ?? 1_000;
  db.prepare(
    `INSERT INTO contacts
       (email, name, first_seen, last_interaction, interaction_count, source,
        created_at, updated_at, company, contact_id)
       VALUES (?, ?, ?, ?, 1, 'manual', ?, ?, ?, ?)`,
    // D-192 C-2 slice 3 — `contact_id` is the STORAGE IDENTITY now (every
    // contribution keys on it) and a BEFORE-INSERT trigger enforces it. This
    // fixture used to omit it, which meant it was minting rows that no
    // contribution could ever attach to — the exact silent orphan the trigger
    // exists to make loud. Even a raw-SQL fixture has to mint one.
  ).run(
    input.email,
    input.name ?? null,
    now,
    now,
    now,
    now,
    input.company ?? null,
    `ct_${input.email.replace(/[^a-z0-9]/gi, '')}`,
  );
};

describe('D-167 §1.A contact prefetch index schema', () => {
  it('creates the FTS and phone-form tables and remains idempotent', () => {
    expect(() => {
      ensureContactSchema(db);
      ensureContactSchema(db);
    }).not.toThrow();

    const tables = db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('contacts_fts', 'contact_phone_forms')`,
    ).all() as Array<{ name: string }>;

    expect(tables.map((r) => r.name).sort()).toEqual(['contact_phone_forms', 'contacts_fts']);
  });

  it('keeps FTS rows and phone forms fresh across insert, update, and delete', () => {
    store.upsertManual({
      email: 'rae@x.com',
      name: 'Renee Kim',
      phone: '+14155550199',
      company: 'Acme Labs',
    }, 1_000);

    expect(refsFor({ tokens: ['renee'] })).toEqual(['rae@x.com']);
    expect(refsFor({ tokens: ['acme'] })).toEqual(['rae@x.com']);
    expect(refsFor({ forms: ['14155550199'] })).toEqual(['rae@x.com']);
    expect(store.countPhoneForm('14155550199')).toBe(1);
    expect(store.countPhoneForm('4155550199')).toBe(1);

    const insertedForms = db.prepare(
      `SELECT form FROM contact_phone_forms ORDER BY form`,
    ).all() as Array<{ form: string }>;
    expect(insertedForms.map((r) => r.form)).toEqual(['14155550199', '4155550199']);

    store.upsertManual({
      email: 'rae@x.com',
      name: 'Maya Chen',
      phone: '+14155550222',
      company: 'Globex',
    }, 1_001);

    expect(refsFor({ tokens: ['renee'] })).toEqual([]);
    expect(refsFor({ tokens: ['maya'] })).toEqual(['rae@x.com']);
    expect(refsFor({ tokens: ['acme'] })).toEqual([]);
    expect(refsFor({ tokens: ['globex'] })).toEqual(['rae@x.com']);
    expect(refsFor({ forms: ['14155550199'] })).toEqual([]);
    expect(refsFor({ forms: ['14155550222'] })).toEqual(['rae@x.com']);
    expect(store.countPhoneForm('14155550199')).toBe(0);
    expect(store.countPhoneForm('14155550222')).toBe(1);

    expect(store.delete('rae@x.com')).toBe(true);
    expect(refsFor({ tokens: ['maya'] })).toEqual([]);
    expect(refsFor({ tokens: ['globex'] })).toEqual([]);
    expect(refsFor({ forms: ['14155550222'] })).toEqual([]);
    expect(store.countPhoneForm('14155550222')).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM contact_phone_forms`).get()).toEqual({ n: 0 });
  });

  it('backfills both indexes for contacts that predate the index (upgrade path)', async () => {
    // A warehouse whose rows were written by older code (no FTS / phone-forms
    // triggers): the rows exist but neither index is populated. createContactStore
    // → ensureContactSchema must rebuild/backfill so prefetch sees them.
    const upgradeDb = new Database(':memory:');
    upgradeDb.exec(`
      CREATE TABLE contacts (
        email TEXT PRIMARY KEY, name TEXT, first_seen INTEGER NOT NULL,
        last_interaction INTEGER NOT NULL, interaction_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        phone TEXT, company TEXT
      );
    `);
    upgradeDb.prepare(
      `INSERT INTO contacts(email, name, first_seen, last_interaction, interaction_count, source, created_at, updated_at, phone, company)
         VALUES ('legacy@x.com', 'Preexisting Sole', 1, 1, 1, 'manual', 1, 1, '+14155551234', 'Datadog')`,
    ).run();

    // Index is empty before the schema install (rows predate the triggers).
    const upgradeStore = createContactStore(upgradeDb); // ensureContactSchema → backfill
    const upgradeSearch = createContactPrefetchSearch(() => upgradeStore);

    // FTS name + company backfilled; phone-forms backfilled.
    expect(upgradeStore.prefetchCandidates({ tokens: ['preexisting'], forms: [], emails: [] }).map((r) => r.email))
      .toEqual(['legacy@x.com']);
    expect(upgradeStore.prefetchCandidates({ tokens: ['datadog'], forms: [], emails: [] }).map((r) => r.email))
      .toEqual(['legacy@x.com']);
    expect(upgradeStore.countPhoneForm('14155551234')).toBe(1);
    const phoneHit = await upgradeSearch({ tokens: ['14155551234'], phoneRuns: [], emailRuns: [], limit: 5 });
    expect(phoneHit[0]?.ref).toBe('legacy@x.com');

    upgradeDb.close();
  });

  it('per-token retrieval surfaces a rare token past a flooding token (no starvation)', async () => {
    // More than PREFETCH_FTS_LIMIT recent contacts share the "megacorp" company
    // token. Under a single global OR cap (recency-ordered) the older, unique "Kim
    // Solo" would be starved out of the result entirely. Per-token retrieval reaches
    // Kim, and the confident-before-ambiguous tiebreak surfaces it ahead of the
    // ambiguous Megacorp crowd.
    const tx = db.transaction(() => {
      for (let i = 0; i < PREFETCH_FTS_LIMIT + 5; i++) {
        store.upsertManual({ email: `m${i}@x.com`, name: `Person ${i}`, company: 'Megacorp' }, 1_000 + i);
      }
    });
    tx();
    store.upsertManual({ email: 'kim@x.com', name: 'Kim Solo' }, 500); // older than every Megacorp row

    // The rare token's contact is retrieved (NOT starved by the flooding token) ...
    expect(store.prefetchCandidates({ tokens: ['megacorp', 'kim'], forms: [], emails: [] }).map((r) => r.email))
      .toContain('kim@x.com');

    const search = createContactPrefetchSearch(() => store);
    const candidates = await search({ tokens: ['megacorp', 'kim'], phoneRuns: [], emailRuns: [], limit: 3 });
    const kim = candidates.find((c) => c.ref === 'kim@x.com');
    expect(kim).toBeDefined();              // ... surfaces in the top-K ...
    expect(kim?.ambiguous).toBeUndefined(); // ... as the confident sole "kim" matcher
    // every other surfaced candidate is an ambiguous Megacorp contact.
    expect(candidates.filter((c) => c.ref !== 'kim@x.com').every((c) => c.ambiguous === true)).toBe(true);
  });
});

describe('D-167 off-cap recall contact-store surfaces', () => {
  it('listAllNamesAndCompanies enumerates every stored name/company without the list cap', () => {
    const count = 1_200;
    const expectedNames = Array.from(
      { length: count },
      (_, i) => `Recall Person ${String(i).padStart(4, '0')}`,
    );
    const expectedCompanies = Array.from(
      { length: count },
      (_, i) => `Recall Company ${String(i).padStart(4, '0')}`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        store.upsertManual(
          {
            email: `recall-${i}@example.com`,
            name: expectedNames[i]!,
            company: expectedCompanies[i]!,
          },
          2_000 + i,
        );
      }
    });
    tx();
    insertNullableContact({ email: 'company-only@example.com', company: 'Company Only', now: 4_000 });
    insertNullableContact({ email: 'name-only@example.com', name: 'Name Only', now: 4_001 });

    const { names, companies } = store.listAllNamesAndCompanies();

    expect([...names].sort()).toEqual([...expectedNames, 'Name Only'].sort());
    expect([...companies].sort()).toEqual([...expectedCompanies, 'Company Only'].sort());
  });

  it('resolveRecallIdentifiers returns only canonical stored identifiers for exact email and phone-form matches', () => {
    const storedPhone = '+14155550199';
    store.upsertManual(
      { email: 'ada@example.com', name: 'Ada Recall', phone: storedPhone, company: 'Exact Labs' },
      2_000,
    );
    store.upsertManual(
      {
        email: 'unmentioned@example.com',
        name: 'Unmentioned Recall',
        phone: '+14155550222',
        company: 'Silent Labs',
      },
      2_001,
    );
    const { full, national } = phoneMatchDigits(storedPhone);
    const queryForm = national[0] ?? full;
    expect(queryForm).toBeDefined();

    const matches = store.resolveRecallIdentifiers({
      emails: ['ada@example.com', 'missing@example.com'],
      forms: [queryForm!, '9990001111'],
    });

    expect(matches.emails).toEqual(['ada@example.com']);
    expect(matches.phones).toEqual([storedPhone]);
    expect(store.resolveRecallIdentifiers({
      emails: ['missing@example.com'],
      forms: ['9990001111'],
    })).toEqual({ emails: [], phones: [] });
  });
});
