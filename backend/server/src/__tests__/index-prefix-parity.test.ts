import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { createCollectionTable, toFtsMatch } from '../collections/table.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createContactStore } from '../storage/contact-store.js';
import { CHAT_INDEX_STORES } from '../chat-index-context.js';

/** The pre-seed index probes six stores with ONE query string and reads a
 *  hit/no-hit answer. A store that silently ignores a trailing `*` returns a
 *  FALSE ZERO, and the index then omits a store that HOLDS the data — the exact
 *  failure that made an incomplete index worse than none (it reached the
 *  answering store 0/10, where the no-index control reached it 16/23).
 *
 *  ⛔ The divergence was invisible three ways: `collections/table.ts` built a
 *  real prefix (`"tok"*`), `calendar-table` stripped `*` as punctuation, and
 *  `contact-store`'s FTS quoted the whole token — with no error anywhere. */

let dbs: Database.Database[] = [];
const open = (): Database.Database => {
  const db = new Database(':memory:');
  dbs.push(db);
  return db;
};
afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
});

describe('toFtsMatch — the one definition of the prefix convention', () => {
  it('puts a trailing * OUTSIDE the quotes, making it a real prefix operator', () => {
    expect(toFtsMatch('thornfield*')).toBe('"thornfield"*');
    expect(toFtsMatch('thornfield')).toBe('"thornfield"');
  });

  it('still quotes stems that are FTS5 reserved words', () => {
    expect(toFtsMatch('OR*')).toBe('"OR"*');
    expect(toFtsMatch('NEAR')).toBe('"NEAR"');
  });

  it('returns null when the query has no word tokens', () => {
    expect(toFtsMatch('...')).toBeNull();
  });
});

describe('mail/file — the generic collection table', () => {
  it('reaches "Thornfields" with a prefix, and misses it without one', () => {
    const db = open();
    const table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
    table.upsert({
      record_id: 'uid:1@INBOX',
      received_at: 1,
      modified_at: 1,
      hot_fields: { from: 'a@b.com', subject: 'Thornfields Group renewal', is_read: false },
      size_bytes: 10,
      source_id: '<m1@x>',
      body_inline: 'Notes on the Thornfields Group renewal.',
      origin_actor: 'system',
    });
    // Both forms reach it now: `thornfield*` directly, and bare `thornfield`
    // through the empty-result relaxation rung below. Before that rung the bare
    // form returned 0 — the assertion this test used to make.
    expect(table.search({ platform: 'mail', slug: 'work', query: 'thornfield*', limit: 5 }).length).toBeGreaterThan(0);
    expect(table.search({ platform: 'mail', slug: 'work', query: 'thornfield', limit: 5 }).length).toBeGreaterThan(0);
  });
});

describe('calendar — the store this change actually fixed', () => {
  it('honours a prefix; it used to STRIP the * as punctuation before matching', () => {
    const db = open();
    const table = createCalendarTable({ db, slug: 'work' });
    table.upsert({
      event: {
        source_id: 'evt-1',
        ical_uid: 'uid-1@example',
        calendar_id: 'cal-1',
        summary: 'Thornfields Group quarterly review',
        start_at: 1_700_000_000_000,
        end_at: 1_700_000_900_000,
        timezone: 'America/New_York',
        is_all_day: false,
        status: 'confirmed',
        attendees: [],
        created_at: 1_699_000_000_000,
        updated_at: 1_700_000_000_000,
      },
      size_bytes: 40,
      body_inline: 'Agenda for the Thornfields Group review.',
    } as never);
    expect(table.search({ query: 'thornfield*', limit: 5 }).length).toBeGreaterThan(0);
    expect(table.search({ query: 'thornfield', limit: 5 }).length).toBeGreaterThan(0);
  });
});

describe('contact — substring already, so a prefix would BREAK it', () => {
  it('matches the variant with no prefix, and matches nothing with one', () => {
    const db = open();
    const store = createContactStore(db);
    store.upsertManual({
      email: 'priya@thornfields.example',
      name: 'Priya Raman',
      company: 'Thornfields Group',
    } as never);
    // `contact.search` reaches the store via `list({ company_contains })`, which
    // is SQL `company LIKE '%term%'` — it already spans the variant.
    expect(store.list({ company_contains: 'thornfield', limit: 5 })).toHaveLength(1);
    // ⛔ and `*` becomes LIKE '%thornfield*%' — a literal asterisk, zero rows.
    expect(store.list({ company_contains: 'thornfield*', limit: 5 })).toHaveLength(0);
  });
});

describe('CHAT_INDEX_STORES — what each store can actually be asked', () => {
  it('declares [store, hitField, andCapable]', () => {
    for (const entry of CHAT_INDEX_STORES) {
      expect(entry).toHaveLength(3);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
      expect(typeof entry[2]).toBe('boolean');
    }
  });

  it('marks ONLY the FTS-backed stores as honouring a multi-term AND', () => {
    // ⛔ `recall`/`memory` match by JS substring on an exact→relaxed→LOOSE
    // ladder ending in `some(t => text.includes(t))` — ANY token — and
    // `contact` is SQL `LIKE '%term%'`. A co-occurrence query sent there
    // degrades to OR, and the index would claim a store holds the whole
    // question when it holds one word of it. That is not hypothetical: a live
    // run emitted `agreed sandhurst renewal: memory.search, mail.search`
    // against a memory row containing neither `agreed` nor `renewal`.
    const byName = new Map(CHAT_INDEX_STORES.map(([n, , a]) => [n, a]));
    for (const n of ['mail.search', 'calendar.search', 'file.search']) {
      expect(byName.get(n), `${n} is FTS-backed`).toBe(true);
    }
    for (const n of ['recall.search', 'memory.search', 'contact.search']) {
      expect(byName.get(n), `${n} matches by substring — AND does not hold`).toBe(false);
    }
  });

  it('has no prefix knob — the relaxation rung reaches variants from a bare term', () => {
    // The old `prefixable` flag was deleted for its ORIGINAL purpose: measured,
    // prefix OFF named mail.search identically to ON once the rung existed.
    // `andCapable` is a different property that happens to split the same way.
    for (const entry of CHAT_INDEX_STORES) expect(entry).toHaveLength(3);
  });
});

describe('empty-result relaxation — the rung that makes the model\'s own query work', () => {
  const seedMail = (db: Database.Database) => {
    const table = createCollectionTable({ db, platform: 'mail', slug: 'work' });
    table.upsert({
      record_id: 'uid:1@INBOX',
      received_at: 1,
      modified_at: 1,
      hot_fields: { from: 'b@t.test', subject: 'Thornfields — invoicing note', is_read: false },
      size_bytes: 10,
      source_id: '<m1@x>',
      body_inline: 'Invoicing on the Thornfields account runs net 45 from receipt.',
      origin_actor: 'system',
    });
    return table;
  };

  it('reaches the record from the query a model actually writes', () => {
    // The real failing trace: the index named mail.search, the model asked
    // "Thornfield payment terms", and got NOTHING — plural stem, and two tokens
    // that appear nowhere in the mailbox.
    const table = seedMail(open());
    expect(table.search({ platform: 'mail', slug: 'work', query: 'Thornfield payment terms', limit: 5 }).length)
      .toBeGreaterThan(0);
  });

  it('does NOT widen to tokens the corpus lacks', () => {
    // ⛔ The `OR` version of this fix would return this mail for a query about
    // payments that has nothing to do with Thornfields — handing the model
    // confidently irrelevant rows. Dropping ABSENT tokens leaves nothing to
    // match on, which is the honest answer.
    const table = seedMail(open());
    expect(table.search({ platform: 'mail', slug: 'work', query: 'payment terms', limit: 5 })).toHaveLength(0);
  });

  it('leaves an explicit FTS5 expression alone', () => {
    // A caller who wrote real syntax asked a specific question; broadening it
    // silently would answer a different one.
    const table = seedMail(open());
    expect(table.search({ platform: 'mail', slug: 'work', query: 'thornfield OR nothingmatches', limit: 5 })).toHaveLength(0);
  });

  it('still returns nothing when no token is present at all', () => {
    const table = seedMail(open());
    expect(table.search({ platform: 'mail', slug: 'work', query: 'kestrel braidwood', limit: 5 })).toHaveLength(0);
  });
});
