import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContactPrefetchSearch } from '../chat-prefetch-search.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

interface ContactSeed {
  readonly email: string;
  readonly name?: string;
  readonly phone?: string;
  readonly company?: string;
}

let db: Database.Database;
let store: ContactStore;
let search: ReturnType<typeof createContactPrefetchSearch>;
let now: number;

beforeEach(() => {
  db = new Database(':memory:');
  store = createContactStore(db);
  search = createContactPrefetchSearch(() => store);
  now = 1_000;
});

afterEach(() => {
  db.close();
});

const upsert = (input: ContactSeed): void => {
  store.upsertManual(input, now++);
};

const run = (
  tokens: readonly string[],
  phoneRuns: readonly string[] = [],
  emailRuns: readonly string[] = [],
  limit = 5,
) => search({ tokens, phoneRuns, emailRuns, limit });

describe('createContactPrefetchSearch — phone identifier', () => {
  it('matches a contact by its canonical phone digits and carries the phone', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });

    const out = await run(['14155550199']);

    expect(out).toEqual([
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, pinned: true, phone: '+14155550199' },
    ]);
  });

  it('an exact phone hit outranks a fuzzy single-name-token overlap', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });
    upsert({ email: 'kim@x.com', name: 'Kim Park' });

    const out = await run(['14155550199', 'kim']);

    expect(out[0]?.ref).toBe('rae@x.com');
    expect(out[0]?.score).toBe(6);
    expect(out[0]?.phone).toBe('+14155550199');
  });

  it('still matches by name, omitting phone when the contact has none', async () => {
    upsert({ email: 'pat@x.com', name: 'Pat Lee' });

    const out = await run(['Pat', 'Lee']);

    expect(out).toEqual([{ ref: 'pat@x.com', label: 'Pat Lee', kind: 'contact', score: 2 }]);
    expect('phone' in (out[0] ?? {})).toBe(false);
  });

  describe('prose function words are not fuzzy match evidence', () => {
    it('does not surface a contact named "Me" on everyday phrasing tokens', async () => {
      // The bench-measured regression: every seeded warehouse derives a "Me"
      // contact from the calendar organizer display name, and "give me their
      // email" surfaced it beside the asked-for contact — a nameless second
      // candidate (B4 withholds the label) that collapsed prefetch trust.
      upsert({ email: 'me@self.test', name: 'Me' });
      upsert({ email: 'pat@x.com', name: 'Pat Lee' });

      const out = await run(['what', 'is', 'pat', 'lee', 'email', 'address', 'just', 'give', 'me', 'their']);

      expect(out).toEqual([
        { ref: 'pat@x.com', label: 'Pat Lee', kind: 'contact', score: 2 },
      ]);
    });

    it('keeps matching open-category name-words ("Bob", "April") — only closed-class words are excluded', async () => {
      upsert({ email: 'bob@x.com', name: 'Bob Stone' });
      upsert({ email: 'april@x.com', name: 'April Chen' });

      const out = await run(['bob', 'april']);

      expect(new Set(out.map((c) => c.ref))).toEqual(
        new Set(['bob@x.com', 'april@x.com']),
      );
    });

    it('a function-word-only contact stays reachable via its exact email identifier', async () => {
      upsert({ email: 'me@self.test', name: 'Me' });

      const out = await run([], [], ['me@self.test']);

      expect(out).toEqual([
        { ref: 'me@self.test', label: 'Me', kind: 'contact', score: 5, pinned: true },
      ]);
    });

    it('open-class members of the historical mixed block stay matchable ("Day" is a surname)', async () => {
      // Codex fold: the function-word set must hold ONLY closed-class words —
      // "day"/"see"/"new" are open-class (real surname potential) and were
      // pruned back out of the exclusion.
      upsert({ email: 'day@x.com', name: 'Doris Day' });

      const out = await run(['doris', 'day']);

      expect(out).toEqual([
        { ref: 'day@x.com', label: 'Doris Day', kind: 'contact', score: 2 },
      ]);
    });
  });

  it('does not match a short numeric token as a phone (< 7 digits)', async () => {
    upsert({ email: 'x@x.com', name: 'Numbers', phone: '+1234' });

    const out = await run(['1234']);

    expect(out).toEqual([]);
  });

  it('matches the NATIONAL form via a FORMATTED phone run — separated phone, no name', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });

    const out = await run([], ['4155550199']);

    expect(out).toEqual([
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, pinned: true, phone: '+14155550199' },
    ]);
  });

  it('matches a trunk-0 country phone by its national OR trunk-0 run', async () => {
    upsert({ email: 'sam@x.com', name: 'Sam Roe', phone: '+442079460958' });

    for (const phoneRun of ['2079460958', '02079460958']) {
      const out = await run([], [phoneRun]);
      expect(out[0]?.ref, phoneRun).toBe('sam@x.com');
      expect(out[0]?.pinned, phoneRun).toBe(true);
    }
  });

  it('does NOT match the national form against a BARE number token (formatted-run only)', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });

    const out = await run(['4155550199'], []);

    expect(out).toEqual([]);
  });

  it('matches the FULL E.164 even from a bare token (unambiguous)', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });

    const out = await run(['14155550199'], []);

    expect(out[0]?.ref).toBe('rae@x.com');
    expect(out[0]?.pinned).toBe(true);
  });

  it('keeps phone matching enabled when the warehouse exceeds the old scan cap', async () => {
    const tx = db.transaction(() => {
      for (let i = 0; i < 10_005; i++) {
        upsert({ email: `filler-${i}@x.com`, name: `Filler${i}` });
      }
      upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });
    });
    tx();

    const out = await run(['14155550199'], []);

    expect(store.count()).toBe(10_006);
    expect(out).toEqual([
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 5, pinned: true, phone: '+14155550199' },
    ]);
  });

  it('suppresses a store-wide ambiguous national phone form while unique full forms still resolve', async () => {
    upsert({ email: 'us@x.com', name: 'US Contact', phone: '+12079460958' });
    upsert({ email: 'uk@x.com', name: 'UK Contact', phone: '+442079460958' });

    expect(await run([], ['2079460958'])).toEqual([]);
    expect((await run(['12079460958']))[0]?.ref).toBe('us@x.com');
    expect((await run(['442079460958']))[0]?.ref).toBe('uk@x.com');
  });
});

describe('createContactPrefetchSearch — email identifier (B1)', () => {
  it('resolves a contact by EXACT email with no name overlap, and pins it', async () => {
    upsert({ email: 'bob@globex.com', name: 'Robert Vance' });

    const out = await run([], [], ['bob@globex.com']);

    expect(out).toEqual([
      { ref: 'bob@globex.com', label: 'Robert Vance', kind: 'contact', score: 5, pinned: true },
    ]);
  });

  it('canonicalises the typed email (case / angle-bracket insensitive)', async () => {
    upsert({ email: 'bob@globex.com', name: 'Robert Vance' });

    expect((await run([], [], ['BOB@Globex.com']))[0]?.ref).toBe('bob@globex.com');
    expect((await run([], [], ['<bob@globex.com>']))[0]?.ref).toBe('bob@globex.com');
  });

  it('a typed email nobody owns resolves nothing (inert)', async () => {
    upsert({ email: 'bob@globex.com', name: 'Bob' });

    const out = await run([], [], ['nobody@nowhere.com']);

    expect(out).toEqual([]);
  });

  it('a pinned email match is never crowded out by fuzzy name matches at a small limit', async () => {
    upsert({ email: 'amy@x.com', name: 'Deal Team' });
    upsert({ email: 'ben@x.com', name: 'Deal Team' });
    upsert({ email: 'cara@x.com', name: 'Deal Team' });
    upsert({ email: 'bob@globex.com', name: 'Robert Vance' });

    const out = await run(['deal', 'team'], [], ['bob@globex.com'], 1);

    expect(out.some((c) => c.ref === 'bob@globex.com' && c.pinned)).toBe(true);
  });
});

describe('createContactPrefetchSearch — ambiguity gate (D-167 §2)', () => {
  it('flags every same-first-name fuzzy Sarah as ambiguous and drops none', async () => {
    upsert({ email: 'sarah.adams@x.com', name: 'Sarah Adams' });
    upsert({ email: 'sarah.bell@x.com', name: 'Sarah Bell' });
    upsert({ email: 'sarah.chen@x.com', name: 'Sarah Chen' });

    const out = await run(['sarah']);

    expect(out).toHaveLength(3);
    expect(new Set(out.map((c) => c.ref))).toEqual(new Set([
      'sarah.adams@x.com',
      'sarah.bell@x.com',
      'sarah.chen@x.com',
    ]));
    expect(out.every((c) => c.ambiguous === true)).toBe(true);
  });

  it('keeps Sarah Adams, Kim Lee, and Sarah Kim surfaced and ambiguous for Sarah and Kim', async () => {
    upsert({ email: 'sarah.adams@x.com', name: 'Sarah Adams' });
    upsert({ email: 'kim.lee@x.com', name: 'Kim Lee' });
    upsert({ email: 'sarah.kim@x.com', name: 'Sarah Kim' });

    const out = await run(['sarah', 'and', 'kim']);

    expect(out).toHaveLength(3);
    expect(new Set(out.map((c) => c.ref))).toEqual(new Set([
      'sarah.adams@x.com',
      'kim.lee@x.com',
      'sarah.kim@x.com',
    ]));
    expect(out.every((c) => c.ambiguous === true)).toBe(true);
  });

  it('does not invent ambiguity across distinct single-token references', async () => {
    upsert({ email: 'bob@x.com', name: 'Bob Stone' });
    upsert({ email: 'carol@x.com', name: 'Carol West' });

    const out = await run(['bob', 'carol']);

    expect(new Set(out.map((c) => c.ref))).toEqual(new Set(['bob@x.com', 'carol@x.com']));
    expect(out.every((c) => !('ambiguous' in c))).toBe(true);
  });

  it('leaves a sole fuzzy matcher confident and omits the flag', async () => {
    upsert({ email: 'sarah.adams@x.com', name: 'Sarah Adams' });

    const out = await run(['sarah']);

    expect(out).toEqual([
      { ref: 'sarah.adams@x.com', label: 'Sarah Adams', kind: 'contact', score: 1 },
    ]);
  });

  it('excludes a pinned email match from the fuzzy token contest', async () => {
    upsert({ email: 'sarah.smith@x.com', name: 'Sarah Smith' });
    upsert({ email: 'sarah.jones@x.com', name: 'Sarah Jones' });

    const out = await run(['sarah'], [], ['sarah.smith@x.com']);
    const pinned = out.find((c) => c.ref === 'sarah.smith@x.com');
    const fuzzy = out.find((c) => c.ref === 'sarah.jones@x.com');

    expect(pinned).toEqual({
      ref: 'sarah.smith@x.com',
      label: 'Sarah Smith',
      kind: 'contact',
      score: 6,
      pinned: true,
    });
    expect(fuzzy).toEqual({
      ref: 'sarah.jones@x.com',
      label: 'Sarah Jones',
      kind: 'contact',
      score: 1,
    });
  });

  it('flags company-token contention as ambiguous', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', company: 'Acme' });
    upsert({ email: 'pat@x.com', name: 'Pat Lee', company: 'Acme' });

    const out = await run(['acme']);

    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.ref))).toEqual(new Set(['rae@x.com', 'pat@x.com']));
    expect(out.every((c) => c.ambiguous === true)).toBe(true);
  });

  it('breaks an equal-score tie by recency under the top-K cap', async () => {
    // Both match only "sarah" → equal score. The FTS leg orders by last_interaction
    // DESC, and the scorer's sort is stable, so at limit 1 the more-recently-
    // interacted contact surfaces — replicating the prior recency-ordered scan
    // rather than rowid/insertion order. `upsert` advances `now`, so the second
    // insert is the more recent.
    upsert({ email: 'sarah.older@x.com', name: 'Sarah Older' });
    upsert({ email: 'sarah.newer@x.com', name: 'Sarah Newer' });

    const out = await run(['sarah'], [], [], 1);

    expect(out).toHaveLength(1);
    expect(out[0]?.ref).toBe('sarah.newer@x.com');
  });

  it('recency tie-break spans token buckets (the union is globally recency-sorted)', async () => {
    // Distinct single-token references "alpha" + "beta" both score 1 (confident). The
    // more-recently-interacted contact must win the limit-1 slot regardless of which
    // query token it matched — the deduped union is recency-sorted, not bucketed by
    // token (else the older first-token match would crowd out the newer one).
    upsert({ email: 'alpha@x.com', name: 'Alpha One' }); // older
    upsert({ email: 'beta@x.com', name: 'Beta Two' });   // newer

    const out = await run(['alpha', 'beta'], [], [], 1);

    expect(out).toHaveLength(1);
    expect(out[0]?.ref).toBe('beta@x.com');
  });
});

describe('createContactPrefetchSearch — company/org (B4)', () => {
  it('surfaces a contact by a company-token overlap and carries the company', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', company: 'Acme Corp' });

    const out = await run(['acme']);

    expect(out).toEqual([
      { ref: 'rae@x.com', label: 'Rae Kim', kind: 'contact', score: 1, company: 'Acme Corp' },
    ]);
  });

  it('a company-token overlap adds to the score ALONGSIDE a name overlap', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', company: 'Acme Corp' });

    const out = await run(['rae', 'acme']);

    expect(out[0]?.score).toBe(2);
  });

  it('carries the company even when the contact resolved by NAME only (org rides for seeding)', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', company: 'Datadog' });

    const out = await run(['rae', 'kim']);

    expect(out[0]?.company).toBe('Datadog');
    expect(out[0]?.score).toBe(2);
  });

  it('a company token does NOT pin (fuzzy, not an exact identifier)', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', company: 'Acme Corp' });

    const out = await run(['acme']);

    expect('pinned' in (out[0] ?? {})).toBe(false);
  });

  it('omits company when the contact has none (behavior-preserving)', async () => {
    upsert({ email: 'pat@x.com', name: 'Pat Lee' });

    const out = await run(['pat']);

    expect('company' in (out[0] ?? {})).toBe(false);
  });
});

describe('createContactPrefetchSearch — trigger freshness', () => {
  it('keeps FTS and phone paths fresh across rename, phone change, and delete', async () => {
    upsert({ email: 'rae@x.com', name: 'Rae Kim', phone: '+14155550199' });

    expect((await run(['rae']))[0]?.ref).toBe('rae@x.com');
    upsert({ email: 'rae@x.com', name: 'Maya Chen' });
    expect(await run(['rae'])).toEqual([]);
    expect((await run(['maya']))[0]?.ref).toBe('rae@x.com');

    expect((await run(['14155550199']))[0]?.ref).toBe('rae@x.com');
    upsert({ email: 'rae@x.com', name: 'Maya Chen', phone: '+14155550222' });
    expect(await run(['14155550199'])).toEqual([]);
    expect((await run(['14155550222']))[0]?.ref).toBe('rae@x.com');

    expect(store.delete('rae@x.com')).toBe(true);
    expect(await run(['maya'])).toEqual([]);
    expect(await run(['14155550222'])).toEqual([]);
  });
});
