/** D-131 A.4 + A.5 — contact + calendar source-walker tests.
 *
 *  Verifies the two new walkers added to the housekeeping enrichment
 *  harness's source layer:
 *
 *    - **Calendar walker** (A.5) — mirrors the mail walker shape
 *      exactly (slug-ASC outer, record_id-ASC inner, composite cursor).
 *      Different hash fields (start_at / end_at / attendees / status /
 *      organizer / location / summary).
 *
 *    - **Contact walker** (A.4) — single-table, email-keyed. Reads
 *      through `ContactStore.walkByEmail` so cursor stability is
 *      grounded in the table's primary key (lex-stable across writes
 *      that touch `last_interaction` / `interaction_count`).
 *
 *  Together with `d-123-phase-4-source-walkers.test.ts` (mail) these
 *  cover the three live walkers in the launch sequence Phase A. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../collections/types.js';
import type {
  CollectionHealth,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  ContactRecord,
} from '@recued/contracts';

import { createCollectionRegistry } from '../collections/registry.js';
import {
  createCalendarSourceWalker,
  createContactSourceWalker,
  createSourceWalkerRegistry,
  hashCalendarRecord,
  hashContactRecord,
} from '../housekeeping/source-walkers.js';
import {
  createContactStore,
  ensureContactSchema,
  type ContactStore,
} from '../storage/contact-store.js';

// ────────────────────────────────────────────────────────────────
// Calendar fixtures (mirrors the mail walker test layout)
// ────────────────────────────────────────────────────────────────

const makeStubCalendarCollection = (
  slug: string,
  records: CollectionRecord[],
): Collection => {
  const byId = new Map(records.map((r) => [r.record_id, r]));
  const stubSync: CollectionSyncAdapter = {
    start: () => undefined,
    stop: () => undefined,
  } as unknown as CollectionSyncAdapter;
  const stubGate: Collection['gate'] = {} as Collection['gate'];
  return {
    platform: 'calendar' satisfies CollectionPlatform as CollectionPlatform,
    slug,
    gate: stubGate,
    upsert: () => undefined,
    delete: () => false,
    get: (record_id: string) => byId.get(record_id) ?? null,
    list: (query: CollectionListQuery) =>
      query.slug === slug ? [...records] : [],
    search: (_q: CollectionSearchQuery): CollectionSearchMatch[] => [],
    sync: stubSync,
    health: (): CollectionHealth => ({
      platform: 'calendar',
      slug,
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'idle',
    }),
    runRetention: async (): Promise<CollectionPruneResult> => ({
      pruned_count: 0,
      bytes_freed: 0,
      blob_hashes_freed: [],
      duration_ms: 0,
    }),
    close: async () => undefined,
  };
};

const fakeCalendarRecord = (
  record_id: string,
  hot: Record<string, unknown> = {},
): CollectionRecord => ({
  record_id,
  received_at: 1_700_000_000_000,
  modified_at: 1_700_000_000_000,
  hot_fields: {
    summary: 'Sync',
    start_at: 1_700_010_000_000,
    end_at: 1_700_013_600_000,
    status: 'confirmed',
    organizer: 'alice@example.com',
    location: '',
    attendees: ['alice@example.com', 'bob@example.com'],
    ...hot,
  },
  size_bytes: 200,
  source_id: record_id,
});

// ────────────────────────────────────────────────────────────────
// Calendar walker
// ────────────────────────────────────────────────────────────────

describe('createCalendarSourceWalker', () => {
  it('walks live calendar collections in slug-ASC order with record_id-ASC inside', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubCalendarCollection('z-account', [
        fakeCalendarRecord('e4'),
        fakeCalendarRecord('e1'),
      ]),
    );
    registry.register(
      makeStubCalendarCollection('a-account', [
        fakeCalendarRecord('e3'),
        fakeCalendarRecord('e2'),
      ]),
    );
    const walker = createCalendarSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 10));
    expect(out.map((r) => r.target_id)).toEqual(['e2', 'e3', 'e1', 'e4']);
  });

  it('respects batch_size to bound iteration', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubCalendarCollection(
        'a',
        ['a', 'b', 'c', 'd', 'e'].map((id) => fakeCalendarRecord(id)),
      ),
    );
    const walker = createCalendarSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 3));
    expect(out.map((r) => r.target_id)).toEqual(['a', 'b', 'c']);
  });

  it('resumes past the cursor_token across slug boundaries', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubCalendarCollection('a', [
        fakeCalendarRecord('a1'),
        fakeCalendarRecord('a2'),
      ]),
    );
    registry.register(
      makeStubCalendarCollection('b', [
        fakeCalendarRecord('b1'),
        fakeCalendarRecord('b2'),
      ]),
    );
    const walker = createCalendarSourceWalker(registry);

    const first = Array.from(walker.walkAfter('', 2));
    expect(first.map((r) => r.target_id)).toEqual(['a1', 'a2']);

    const last = first[first.length - 1]!;
    const second = Array.from(walker.walkAfter(last.cursor_token, 10));
    expect(second.map((r) => r.target_id)).toEqual(['b1', 'b2']);
  });

  it('skips non-calendar collections in the registry', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubCalendarCollection('a', [fakeCalendarRecord('eA')]),
    );
    // Inject a non-calendar collection — walker should ignore it.
    registry.register({
      ...makeStubCalendarCollection('b-mail', []),
      platform: 'mail' satisfies CollectionPlatform as CollectionPlatform,
      slug: 'b-mail',
    } as unknown as Collection);

    const walker = createCalendarSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 10));
    expect(out.map((r) => r.target_id)).toEqual(['eA']);
  });

  it('fetchOne resolves a record by target_id across all live calendar collections', () => {
    const registry = createCollectionRegistry();
    registry.register(
      makeStubCalendarCollection('a', [fakeCalendarRecord('eA')]),
    );
    registry.register(
      makeStubCalendarCollection('b', [fakeCalendarRecord('eB')]),
    );
    const walker = createCalendarSourceWalker(registry);

    expect(walker.fetchOne('eA')?.target_id).toBe('eA');
    expect(walker.fetchOne('eB')?.target_id).toBe('eB');
    expect(walker.fetchOne('eZ')).toBeNull();
  });

  // ─── Production-shape calendar collections ─────────────────────
  // Real `CalendarCollection`s have `Collection.list` stubbed to []
  // and expose the full read path through `table.listSnapshots(...)`
  // (per `calendar-collection.ts`). The walker prefers that path and
  // synthesises CollectionRecord with attendees / organizer email /
  // description / timezone folded into hot_fields so producers reading
  // `record.hot_fields.attendees` work uniformly. These tests verify
  // both the table-backed walk + the snapshot → CollectionRecord
  // synthesiser without spinning up a full calendar collection.

  it('reads via table.listSnapshots when a calendar collection exposes one', () => {
    const eventOne: Record<string, unknown> = {
      record_id: 'cal:slug-a:src-1',
      source_id: 'src-1',
      received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000,
      size_bytes: 220,
      hot: {
        calendar_id: 'primary',
        summary: 'Event one',
        start_at: 1_700_010_000_000,
        end_at: 1_700_013_600_000,
        status: 'confirmed',
        organizer: 'alice@example.com',
        ical_uid: 'uid-1',
        location: 'Office',
        is_all_day: false,
        is_recurring: false,
      },
      event: {
        source_id: 'src-1',
        ical_uid: 'uid-1',
        calendar_id: 'primary',
        summary: 'Event one',
        description: 'Discussion topics',
        location: 'Office',
        start_at: 1_700_010_000_000,
        end_at: 1_700_013_600_000,
        timezone: 'America/New_York',
        is_all_day: false,
        organizer: { email: 'alice@example.com' },
        attendees: [
          { email: 'alice@example.com', response_status: 'accepted' },
          { email: 'bob@example.com', response_status: 'needs_action' },
        ],
        status: 'confirmed',
        created_at: 0,
        updated_at: 0,
      },
      prior: null,
      body_inline: null,
      blob_hash: null,
      etag: null,
    };
    const tableBacked: Collection = {
      ...makeStubCalendarCollection('a', []),
      // @ts-expect-error — runtime field; the walker reads it via duck-type cast.
      table: {
        listSnapshots: () => [eventOne],
      },
    };
    const registry = createCollectionRegistry();
    registry.register(tableBacked);

    const walker = createCalendarSourceWalker(registry);
    const out = Array.from(walker.walkAfter('', 10));

    expect(out).toHaveLength(1);
    const yielded = out[0]!;
    expect(yielded.target_id).toBe('cal:slug-a:src-1');
    // Synthesised hot_fields includes attendees from event payload
    const hot = yielded.data.hot_fields as Record<string, unknown>;
    expect(hot.attendees).toEqual(eventOne.event && (eventOne.event as { attendees: unknown }).attendees);
    expect(hot.organizer).toBe('alice@example.com');
    expect(hot.description).toBe('Discussion topics');
    expect(hot.timezone).toBe('America/New_York');
  });

  it('table-backed fetchOne resolves by record_id via listSnapshots scan', () => {
    const snapshot = {
      record_id: 'cal:slug-a:src-9',
      source_id: 'src-9',
      received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000,
      size_bytes: 100,
      hot: {
        calendar_id: 'primary',
        summary: 'X',
        start_at: 1_700_010_000_000,
        end_at: 1_700_013_600_000,
        status: 'confirmed',
        organizer: 'alice@example.com',
        ical_uid: 'uid-9',
        location: '',
        is_all_day: false,
        is_recurring: false,
      },
      event: {
        source_id: 'src-9',
        ical_uid: 'uid-9',
        calendar_id: 'primary',
        summary: 'X',
        start_at: 1_700_010_000_000,
        end_at: 1_700_013_600_000,
        timezone: 'UTC',
        is_all_day: false,
        organizer: { email: 'alice@example.com' },
        attendees: [],
        status: 'confirmed',
        created_at: 0,
        updated_at: 0,
      },
      prior: null,
      body_inline: null,
      blob_hash: null,
      etag: null,
    };
    const tableBacked: Collection = {
      ...makeStubCalendarCollection('a', []),
      // @ts-expect-error — runtime field; the walker reads it via duck-type cast.
      table: {
        listSnapshots: () => [snapshot],
      },
    };
    const registry = createCollectionRegistry();
    registry.register(tableBacked);

    const walker = createCalendarSourceWalker(registry);
    expect(walker.fetchOne('cal:slug-a:src-9')?.target_id).toBe('cal:slug-a:src-9');
    expect(walker.fetchOne('cal:slug-a:missing')).toBeNull();
  });
});

describe('hashCalendarRecord', () => {
  it('hashes only producer-relevant hot fields (received_at irrelevant)', () => {
    const record = fakeCalendarRecord('e1');
    const hash1 = hashCalendarRecord(record);
    const hash2 = hashCalendarRecord({
      ...record,
      received_at: 9_999_999_999_999,
      modified_at: 9_999_999_999_999,
    });
    expect(hash1).toBe(hash2);
  });

  it('changes when start_at moves (reschedule signal)', () => {
    const before = fakeCalendarRecord('e1', { start_at: 1_700_010_000_000 });
    const after = fakeCalendarRecord('e1', { start_at: 1_700_020_000_000 });
    expect(hashCalendarRecord(before)).not.toBe(hashCalendarRecord(after));
  });

  it('changes when status flips (cancelled → confirmed)', () => {
    const cancelled = fakeCalendarRecord('e1', { status: 'cancelled' });
    const confirmed = fakeCalendarRecord('e1', { status: 'confirmed' });
    expect(hashCalendarRecord(cancelled)).not.toBe(hashCalendarRecord(confirmed));
  });

  it('changes when attendee composition changes', () => {
    const small = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com'],
    });
    const big = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com', 'bob@example.com'],
    });
    expect(hashCalendarRecord(small)).not.toBe(hashCalendarRecord(big));
  });

  it('is order-insensitive for attendees (ordering is presentation, not signal)', () => {
    // Producers like `attendee_patterns` care about the SET of attendees,
    // not their array order. The hash sorts internally so a rearrange
    // that the calendar provider may emit doesn't trigger re-derivation.
    const ordA = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com', 'bob@example.com'],
    });
    const ordB = fakeCalendarRecord('e1', {
      attendees: ['bob@example.com', 'alice@example.com'],
    });
    expect(hashCalendarRecord(ordA)).toBe(hashCalendarRecord(ordB));
  });

  it('handles attendees as object[] with email field', () => {
    // Some calendar providers emit attendees as `{email, response_status, ...}`
    // objects. The hash extracts the email from each entry.
    const objForm = fakeCalendarRecord('e1', {
      attendees: [
        { email: 'alice@example.com', response_status: 'accepted' },
        { email: 'bob@example.com', response_status: 'declined' },
      ],
    });
    const stringForm = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com', 'bob@example.com'],
    });
    expect(hashCalendarRecord(objForm)).toBe(hashCalendarRecord(stringForm));
  });
});

// ────────────────────────────────────────────────────────────────
// Contact walker — drives the real ContactStore over an in-memory db
// ────────────────────────────────────────────────────────────────

describe('createContactSourceWalker', () => {
  let dir: string;
  let db: Database.Database;
  let store: ContactStore;
  const t0 = 1_700_000_000_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd-131-contact-walker-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    ensureContactSchema(db);
    store = createContactStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (emails: string[]): void => {
    for (const email of emails) {
      store.observe({ email, source: 'email_from', event_at: t0 });
    }
  };

  it('walks contacts in lex-ASC email order', () => {
    seed(['charlie@x.com', 'alice@x.com', 'bob@x.com']);
    const walker = createContactSourceWalker(store);
    const out = Array.from(walker.walkAfter('', 10));
    expect(out.map((r) => r.target_id)).toEqual([
      'alice@x.com',
      'bob@x.com',
      'charlie@x.com',
    ]);
  });

  it('cursor_token equals the email for a single-table walk', () => {
    seed(['alice@x.com']);
    const walker = createContactSourceWalker(store);
    const [record] = Array.from(walker.walkAfter('', 10));
    expect(record?.cursor_token).toBe('alice@x.com');
    expect(record?.target_id).toBe('alice@x.com');
  });

  it('respects batch_size', () => {
    seed(['a@x', 'b@x', 'c@x', 'd@x']);
    const walker = createContactSourceWalker(store);
    const out = Array.from(walker.walkAfter('', 2));
    expect(out.map((r) => r.target_id)).toEqual(['a@x', 'b@x']);
  });

  it('resumes past the cursor_token deterministically', () => {
    seed(['a@x', 'b@x', 'c@x', 'd@x']);
    const walker = createContactSourceWalker(store);
    const first = Array.from(walker.walkAfter('', 2));
    const last = first[first.length - 1]!;
    const second = Array.from(walker.walkAfter(last.cursor_token, 10));
    expect(second.map((r) => r.target_id)).toEqual(['c@x', 'd@x']);
  });

  it('cursor stability survives concurrent observe() touching last_interaction', () => {
    seed(['alice@x.com', 'bob@x.com', 'charlie@x.com']);
    const walker = createContactSourceWalker(store);
    const first = Array.from(walker.walkAfter('', 1));
    expect(first[0]?.target_id).toBe('alice@x.com');

    // Mid-walk observation bumps charlie's last_interaction. Email
    // is the cursor key — a last_interaction bump must NOT cause
    // charlie to skip past or duplicate. The list()-based ordering
    // would have shuffled charlie to position 0; walkByEmail stays
    // stable.
    store.observe({
      email: 'charlie@x.com',
      source: 'email_from',
      event_at: t0 + 86_400_000,
    });

    const second = Array.from(walker.walkAfter(first[0]!.cursor_token, 10));
    expect(second.map((r) => r.target_id)).toEqual([
      'bob@x.com',
      'charlie@x.com',
    ]);
  });

  it('fetchOne resolves by email, returns null for unknown', () => {
    seed(['alice@x.com', 'bob@x.com']);
    const walker = createContactSourceWalker(store);

    const found = walker.fetchOne('alice@x.com');
    expect(found?.target_id).toBe('alice@x.com');
    expect(found?.cursor_token).toBe('alice@x.com');
    expect(walker.fetchOne('mallory@x.com')).toBeNull();
  });

  it('exposes the canonical ContactRecord shape on .data (not CollectionRecord)', () => {
    seed(['alice@x.com']);
    const walker = createContactSourceWalker(store);
    const [record] = Array.from(walker.walkAfter('', 10));
    const data = record!.data;
    // ContactRecord-specific fields the producer stack reads:
    expect(data.email).toBe('alice@x.com');
    expect(typeof data.first_seen).toBe('number');
    expect(typeof data.last_interaction).toBe('number');
    expect(typeof data.interaction_count).toBe('number');
    expect(data.source).toBe('email_from');
  });
});

describe('hashContactRecord', () => {
  const baseContact = (overrides: Partial<ContactRecord> = {}): ContactRecord => ({
    _id: 'alice@x.com',
    _collection: 'contact',
    email: 'alice@x.com',
    name: 'Alice',
    first_seen: 1_700_000_000_000,
    last_interaction: 1_700_500_000_000,
    interaction_count: 5,
    source: 'email_from',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_500_000_000,
    ...overrides,
  });

  it('hashes only producer-relevant fields (first_seen / created_at / updated_at irrelevant)', () => {
    const a = baseContact();
    const b = baseContact({
      first_seen: 1, created_at: 2, updated_at: 3,
    });
    expect(hashContactRecord(a)).toBe(hashContactRecord(b));
  });

  it('changes when last_interaction moves (the key freshness signal)', () => {
    const before = baseContact({ last_interaction: 1_000 });
    const after = baseContact({ last_interaction: 2_000 });
    expect(hashContactRecord(before)).not.toBe(hashContactRecord(after));
  });

  it('changes when interaction_count moves', () => {
    expect(hashContactRecord(baseContact({ interaction_count: 5 }))).not.toBe(
      hashContactRecord(baseContact({ interaction_count: 6 })),
    );
  });

  it('changes when name is updated (signature-parsing producers care)', () => {
    expect(hashContactRecord(baseContact({ name: 'Alice' }))).not.toBe(
      hashContactRecord(baseContact({ name: 'Alice Smith' })),
    );
  });

  it('treats missing name as distinct from an empty string but matches across re-runs', () => {
    const noName1 = baseContact({});
    delete (noName1 as { name?: string }).name;
    const noName2 = baseContact({});
    delete (noName2 as { name?: string }).name;
    expect(hashContactRecord(noName1)).toBe(hashContactRecord(noName2));
  });
});

// ────────────────────────────────────────────────────────────────
// Registry wiring — both walkers register; contact gated on store
// ────────────────────────────────────────────────────────────────

describe('createSourceWalkerRegistry — D-131 A.4/A.5 wiring', () => {
  it('registers calendar even with an empty CollectionRegistry', () => {
    const sw = createSourceWalkerRegistry({ collections: createCollectionRegistry() });
    expect(sw.get('calendar')).toBeDefined();
    expect(Array.from(sw.get('calendar')!.walkAfter('', 10))).toEqual([]);
  });

  it('registers contact when contactStore is supplied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd-131-contact-reg-'));
    try {
      const db = new Database(join(dir, 'test.db'));
      ensureContactSchema(db);
      const store = createContactStore(db);
      store.observe({ email: 'alice@x.com', source: 'manual', event_at: 1_700_000_000_000 });

      const sw = createSourceWalkerRegistry({
        collections: createCollectionRegistry(),
        contactStore: store,
      });
      const walker = sw.get('contact');
      expect(walker).toBeDefined();
      const out = Array.from(walker!.walkAfter('', 10));
      expect(out.map((r) => r.target_id)).toEqual(['alice@x.com']);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits contact when contactStore is absent', () => {
    const sw = createSourceWalkerRegistry({ collections: createCollectionRegistry() });
    expect(sw.get('contact')).toBeUndefined();
  });
});
