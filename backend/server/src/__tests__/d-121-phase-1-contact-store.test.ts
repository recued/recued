/** D-121 Phase 1 — `data.contact` SQLite store tests.
 *
 *  Covers:
 *    - first-seen-wins for source / first_seen / name
 *    - last_interaction MAX-merge across observations
 *    - interaction_count bumps once per observation
 *    - manual upsert overrides name, preserves provenance
 *    - canonicalization at every write site (mixed-case → one row)
 *    - bistemporal: first_seen carries source event_at, not now()
 *    - list filters (name_contains, source, since)
 *    - delete + count + get */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createContactStore,
  ensureContactSchema,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureContactSchema', () => {
  it('creates the contacts table + indexes idempotently', () => {
    // Already created in beforeEach via createContactStore — calling
    // it again must be a no-op.
    ensureContactSchema(db);
    ensureContactSchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'`)
      .all();
    expect(tables.length).toBe(1);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contacts'`)
      .all() as Array<{ name: string }>;
    const names = indexes.map((r) => r.name);
    expect(names).toContain('idx_contacts_last_interaction');
    expect(names).toContain('idx_contacts_name_collate');
    expect(names).toContain('idx_contacts_source');
  });
});

describe('observe — first-seen-wins', () => {
  it('inserts a new contact stamped with the source record event_at', () => {
    const eventAt = 1_000_000;
    const result = store.observe(
      { email: 'bob@x.com', name: 'Bob Smith', source: 'email_from', event_at: eventAt },
      9_999_999,
    );
    expect(result).toMatchObject({
      _id: 'bob@x.com',
      _collection: 'contact',
      email: 'bob@x.com',
      name: 'Bob Smith',
      first_seen: eventAt,
      last_interaction: eventAt,
      interaction_count: 1,
      source: 'email_from',
    });
    expect(result.created_at).toBe(9_999_999);
  });

  it('preserves source / first_seen / name on subsequent observations', () => {
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'email_from', event_at: 100 });
    const result = store.observe(
      // Later mail from a different angle — calendar attendee, no name.
      { email: 'bob@x.com', source: 'calendar_attendee', event_at: 200 },
    );
    expect(result.source).toBe('email_from');
    expect(result.first_seen).toBe(100);
    expect(result.name).toBe('Bob');
    expect(result.last_interaction).toBe(200);
    expect(result.interaction_count).toBe(2);
  });

  it('uses the email local-part as a fallback display name', () => {
    const result = store.observe({
      email: 'maria@example.org',
      source: 'email_from',
      event_at: 100,
    });
    expect(result.name).toBe('maria');
  });
});

describe('observe — last_interaction MAX-merge', () => {
  it('keeps the newer event_at when an earlier observation arrives second', () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 500 });
    const result = store.observe(
      { email: 'bob@x.com', source: 'email_from', event_at: 100 },
    );
    // last_interaction is MAX(existing, incoming) — so it stays at 500.
    expect(result.last_interaction).toBe(500);
    expect(result.interaction_count).toBe(2);
  });

  it('advances last_interaction when the new event_at is newer', () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100 });
    const result = store.observe(
      { email: 'bob@x.com', source: 'email_from', event_at: 999 },
    );
    expect(result.last_interaction).toBe(999);
  });
});

describe('observe — canonicalization', () => {
  it('collides mixed-case observations onto one row', () => {
    store.observe({ email: 'BOB@X.COM', source: 'email_from', event_at: 100 });
    store.observe({ email: 'Bob@x.com', source: 'email_from', event_at: 200 });
    const all = store.list();
    expect(all.length).toBe(1);
    expect(all[0]?.email).toBe('bob@x.com');
    expect(all[0]?.interaction_count).toBe(2);
  });

  it('throws on completely unparseable input', () => {
    expect(() =>
      store.observe({ email: 'not-an-email', source: 'email_from', event_at: 100 }),
    ).toThrow(/contact_invalid_email/);
  });
});

describe('observeBatch', () => {
  it('applies a batch atomically and skips malformed rows', () => {
    const inserted = store.observeBatch([
      { email: 'a@x.com', source: 'email_from', event_at: 100 },
      { email: 'not-an-email', source: 'email_from', event_at: 100 },
      { email: 'b@x.com', source: 'email_to', event_at: 200 },
    ]);
    expect(inserted).toBe(2);
    expect(store.count()).toBe(2);
  });

  it('returns 0 for an empty batch without touching the table', () => {
    expect(store.observeBatch([])).toBe(0);
    expect(store.count()).toBe(0);
  });

  it('coalesces duplicates within one batch', () => {
    store.observeBatch([
      { email: 'a@x.com', name: 'A', source: 'email_from', event_at: 100 },
      { email: 'a@x.com', source: 'email_to', event_at: 200 },
    ]);
    const a = store.get('a@x.com');
    expect(a?.interaction_count).toBe(2);
    expect(a?.first_seen).toBe(100);
    expect(a?.last_interaction).toBe(200);
    expect(a?.source).toBe('email_from');
  });
});

describe('upsertManual', () => {
  it('inserts a fresh row with source=manual when none exists', () => {
    const result = store.upsertManual(
      { email: 'jane@x.com', name: 'Jane', first_seen: 50, last_interaction: 99 },
      1000,
    );
    expect(result).toMatchObject({
      email: 'jane@x.com',
      name: 'Jane',
      first_seen: 50,
      last_interaction: 99,
      interaction_count: 1,
      source: 'manual',
    });
  });

  it('overrides name on an existing adapter-derived row but preserves source / first_seen', () => {
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'email_from', event_at: 100 });
    const result = store.upsertManual({ email: 'bob@x.com', name: 'Robert Smith' }, 500);
    expect(result.name).toBe('Robert Smith');
    expect(result.source).toBe('email_from');
    expect(result.first_seen).toBe(100);
    expect(result.interaction_count).toBe(2);
  });

  it('canonicalizes the email before lookup', () => {
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 100 });
    store.upsertManual({ email: 'BOB@X.COM', name: 'Robert' });
    expect(store.count()).toBe(1);
    expect(store.get('bob@x.com')?.name).toBe('Robert');
  });

  it('throws on unparseable email input', () => {
    expect(() => store.upsertManual({ email: 'gibberish' })).toThrow(/contact_invalid_email/);
  });
});

describe('list / get / delete / count', () => {
  beforeEach(() => {
    store.observe({ email: 'alice@x.com', name: 'Alice', source: 'email_from', event_at: 100 });
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'calendar_attendee', event_at: 200 });
    store.upsertManual({ email: 'charlie@x.com', name: 'Charlie' }, 300);
  });

  it('returns rows ordered by last_interaction desc', () => {
    const all = store.list();
    expect(all.map((c) => c.email)).toEqual([
      'charlie@x.com',
      'bob@x.com',
      'alice@x.com',
    ]);
  });

  it('filters by name_contains case-insensitively', () => {
    const result = store.list({ name_contains: 'ALI' });
    expect(result.map((c) => c.email)).toEqual(['alice@x.com']);
  });

  it('filters by company_contains case-insensitively (D-167 B3 org search)', () => {
    store.upsertManual({ email: 'dana@x.com', name: 'Dana', company: 'Acme Corp' }, 400);
    store.upsertManual({ email: 'eve@x.com', name: 'Eve', company: 'Globex' }, 410);
    const result = store.list({ company_contains: 'acme' });
    expect(result.map((c) => c.email)).toEqual(['dana@x.com']);
    // No company match → empty (not the whole list — proves it's a real filter).
    expect(store.list({ company_contains: 'nonesuch' })).toEqual([]);
  });

  it('filters by source', () => {
    const result = store.list({ source: 'manual' });
    expect(result.map((c) => c.email)).toEqual(['charlie@x.com']);
  });

  it('filters by since', () => {
    const result = store.list({ since: 250 });
    expect(result.map((c) => c.email)).toEqual(['charlie@x.com']);
  });

  it('paginates via limit + offset', () => {
    const page1 = store.list({ limit: 2, offset: 0 });
    const page2 = store.list({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(1);
  });

  it('returns null for unknown email', () => {
    expect(store.get('unknown@x.com')).toBeNull();
  });

  it('returns null for unparseable email instead of throwing', () => {
    expect(store.get('not-an-email')).toBeNull();
  });

  it('deletes by canonical email and returns true', () => {
    expect(store.delete('BOB@X.COM')).toBe(true);
    expect(store.count()).toBe(2);
  });

  it('returns false for delete of unknown email', () => {
    expect(store.delete('unknown@x.com')).toBe(false);
  });

  it('returns false for delete of unparseable email', () => {
    expect(store.delete('gibberish')).toBe(false);
  });
});

describe('listForPrefetchScan (D-167 follow-on — prefetch coverage cap lifted)', () => {
  it('returns the LEAN row shape (email/name/phone/company only) ordered by recency', () => {
    store.upsertManual({ email: 'old@x.com', name: 'Old One', company: 'Acme' }, 100);
    store.upsertManual({ email: 'new@x.com', name: 'New One', phone: '+14155550111' }, 200);
    const rows = store.listForPrefetchScan();
    expect(rows.map((r) => r.email)).toEqual(['new@x.com', 'old@x.com']); // recency desc
    // Lean: ONLY the four scored columns, no _id / _collection / platform_ids / …
    expect(Object.keys(rows[1]!).sort()).toEqual(['company', 'email', 'name']);
    expect(rows[1]).toEqual({ email: 'old@x.com', name: 'Old One', company: 'Acme' });
    expect(rows[0]).toEqual({ email: 'new@x.com', name: 'New One', phone: '+14155550111' });
  });

  it('scans PAST the general list() MAX_LIMIT=1000 — the lifted clamp', () => {
    // Seed 1100 contacts (one batch). The general list() still caps at 1000 (its
    // UI-page safety ceiling); listForPrefetchScan returns all 1100 so the prefetch
    // covers contacts past the 1000 most-recent (and scanComplete can hold true).
    const obs = Array.from({ length: 1100 }, (_, i) => ({
      email: `c${i}@scan-bench.com`,
      name: `Contact ${i}`,
      source: 'manual' as const,
      event_at: 1000 + i,
    }));
    expect(store.observeBatch(obs)).toBe(1100);
    expect(store.list({ limit: 5000 }).length).toBe(1000); // general cap UNCHANGED
    expect(store.listForPrefetchScan().length).toBe(1100); // clamp lifted
  });

  it('honours an explicit limit below the cap', () => {
    store.observeBatch(
      Array.from({ length: 50 }, (_, i) => ({
        email: `d${i}@scan-bench.com`,
        name: `D ${i}`,
        source: 'manual' as const,
        event_at: 1000 + i,
      })),
    );
    expect(store.listForPrefetchScan(10)).toHaveLength(10);
  });

  it('caps at PREFETCH_SCAN_MAX=10000 — neither the default nor an over-cap limit exceeds it', () => {
    // Seed > the cap (single-token names skip the per-row name_key UPDATE → fast).
    store.observeBatch(
      Array.from({ length: 10001 }, (_, i) => ({
        email: `e${i}@scan-bench.com`,
        name: `E${i}`,
        source: 'manual' as const,
        event_at: 1000 + i,
      })),
    );
    expect(store.count()).toBe(10001);
    expect(store.listForPrefetchScan().length).toBe(10000);       // default → cap
    expect(store.listForPrefetchScan(50000).length).toBe(10000);  // over-cap request clamped
  });
});
