/** D-124 follow-on — `data.contact` warehouse-bus emit.
 *
 *  D-121 Phase 1 shipped the contact store without bus integration.
 *  D-124 spec §1.3 deferred the emit wiring; this file is the
 *  regression coverage when it landed.
 *
 *  Covers:
 *    - observe (single, batch) → `created` for new email,
 *      `updated` for existing, with prev hot-fields slice
 *    - upsertManual → `created` / `updated` paths
 *    - delete → `deleted` with prev (no emit when row absent or no
 *      bus is wired)
 *    - silent: true on every mutating method skips the bus emit
 *    - synthetic path is `data.contact.<slug>.<entity_type>.<kind>`
 *      and matches `canary-backfill-suppression`'s pattern
 *      `data.contact.**.created`
 *    - omitting bus from createContactStore is back-compat (no
 *      emits, existing tests untouched)
 *    - boot backfill via `backfillContacts(...)` defaults to silent
 *      so re-derivation on every restart doesn't broadcast a flood
 *      of `created` / `updated` events */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWarehouseEventBus,
  eventPath,
  matchesPattern,
  type WarehouseEvent,
} from '@recued/warehouse-events';

import { createContactStore } from '../storage/contact-store.js';
import { backfillContacts } from '../warehouse/contact-backfill.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-bus-emit-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const collectAll = (): { events: WarehouseEvent[]; bus: ReturnType<typeof createWarehouseEventBus> } => {
  const events: WarehouseEvent[] = [];
  const bus = createWarehouseEventBus();
  bus.subscribe('**', (e) => { events.push(e); });
  return { events, bus };
};

describe('observe — emit', () => {
  it('emits `created` with no prev for a new email', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe(
      { email: 'new@example.com', name: 'New', source: 'email_from', event_at: 1_000 },
      9_999,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: 'contact',
      slug: 'default',
      entity_type: 'contact',
      event_kind: 'created',
      record_id: 'new@example.com',
    });
    expect(events[0].prev).toBeUndefined();
    expect(events[0].at).toBeTypeOf('number');
  });

  it('emits `updated` with prev hot-fields for an existing email', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'email_from', event_at: 100 });
    events.length = 0; // discard the create
    store.observe({ email: 'bob@x.com', source: 'email_from', event_at: 200 });
    expect(events).toHaveLength(1);
    expect(events[0].event_kind).toBe('updated');
    expect(events[0].prev).toMatchObject({
      name: 'Bob',
      email: 'bob@x.com',
      last_interaction: 100,
      interaction_count: 1,
      source: 'email_from',
    });
  });

  it('does not emit when silent: true', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe(
      { email: 'silent@x.com', name: 'Silent', source: 'email_from', event_at: 100 },
      9_999,
      { silent: true },
    );
    expect(events).toHaveLength(0);
    // Row was still written.
    expect(store.get('silent@x.com')).not.toBeNull();
  });
});

describe('observeBatch — emit', () => {
  it('emits one event per observation, in batch order, after the SQLite tx commits', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    const n = store.observeBatch(
      [
        { email: 'a@x.com', name: 'A', source: 'email_from', event_at: 100 },
        { email: 'b@x.com', name: 'B', source: 'email_to',   event_at: 110 },
        { email: 'c@x.com', name: 'C', source: 'calendar_attendee', event_at: 120 },
      ],
      9_999,
    );
    expect(n).toBe(3);
    expect(events.map((e) => e.record_id)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(events.every((e) => e.event_kind === 'created')).toBe(true);
    // Post-commit ordering — every emit reflects the durable row.
    for (const e of events) {
      expect(store.get(e.record_id)).not.toBeNull();
    }
  });

  it('emits `updated` with prev for existing rows in the batch', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe({ email: 'a@x.com', name: 'A', source: 'email_from', event_at: 100 });
    events.length = 0;
    store.observeBatch([
      { email: 'a@x.com', source: 'email_from', event_at: 200 },
      { email: 'b@x.com', name: 'B', source: 'email_from', event_at: 300 },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].event_kind).toBe('updated');
    expect(events[0].prev).toMatchObject({ email: 'a@x.com', interaction_count: 1 });
    expect(events[1].event_kind).toBe('created');
    expect(events[1].prev).toBeUndefined();
  });

  it('skips malformed observations and emits only for the survivors', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    const n = store.observeBatch([
      { email: 'good@x.com', source: 'email_from', event_at: 100 },
      { email: '', source: 'email_from', event_at: 100 }, // invalid → skipped
      { email: 'also-good@x.com', source: 'email_to', event_at: 100 },
    ]);
    expect(n).toBe(2);
    expect(events.map((e) => e.record_id)).toEqual(['good@x.com', 'also-good@x.com']);
  });

  it('does not emit when silent: true even though rows are written', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    const n = store.observeBatch(
      [
        { email: 'a@x.com', source: 'email_from', event_at: 100 },
        { email: 'b@x.com', source: 'email_from', event_at: 100 },
      ],
      undefined,
      { silent: true },
    );
    expect(n).toBe(2);
    expect(events).toHaveLength(0);
    expect(store.count()).toBe(2);
  });
});

describe('upsertManual — emit', () => {
  it('emits `created` for a new manual entry', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.upsertManual({ email: 'new@x.com', name: 'New' }, 1_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_kind: 'created',
      record_id: 'new@x.com',
    });
    expect(events[0].prev).toBeUndefined();
  });

  it('emits `updated` with prev when overriding an existing row', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe({ email: 'bob@x.com', name: 'Bob', source: 'email_from', event_at: 100 });
    events.length = 0;
    store.upsertManual({ email: 'bob@x.com', name: 'Robert' }, 2_000);
    expect(events).toHaveLength(1);
    expect(events[0].event_kind).toBe('updated');
    expect(events[0].prev).toMatchObject({
      name: 'Bob',
      email: 'bob@x.com',
      source: 'email_from',
    });
  });

  it('does not emit when silent: true', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.upsertManual({ email: 'silent@x.com', name: 'Silent' }, 1_000, { silent: true });
    expect(events).toHaveLength(0);
    expect(store.get('silent@x.com')).not.toBeNull();
  });
});

describe('delete — emit', () => {
  it('emits `deleted` with prev for an existing row', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe({ email: 'doomed@x.com', name: 'Doomed', source: 'email_from', event_at: 500 });
    events.length = 0;
    expect(store.delete('doomed@x.com')).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_kind: 'deleted',
      record_id: 'doomed@x.com',
    });
    expect(events[0].prev).toMatchObject({
      name: 'Doomed',
      email: 'doomed@x.com',
      source: 'email_from',
    });
  });

  it('does not emit when the row is absent', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    expect(store.delete('never-seen@x.com')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does not emit when silent: true', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe({ email: 'silent-del@x.com', source: 'email_from', event_at: 100 });
    events.length = 0;
    expect(store.delete('silent-del@x.com', { silent: true })).toBe(true);
    expect(events).toHaveLength(0);
    expect(store.get('silent-del@x.com')).toBeNull();
  });
});

describe('back-compat — no bus wired', () => {
  it('omitting bus leaves the store in legacy no-emit mode', () => {
    // Reproduces every existing call site that constructs without
    // options. No subscriber needed; absence of throws + correct row
    // mutation is the contract.
    const store = createContactStore(db);
    expect(() => store.observe({ email: 'x@y.com', source: 'email_from', event_at: 100 })).not.toThrow();
    expect(() => store.observeBatch([{ email: 'a@b.com', source: 'email_to', event_at: 100 }])).not.toThrow();
    expect(() => store.upsertManual({ email: 'm@n.com' })).not.toThrow();
    expect(store.delete('x@y.com')).toBe(true);
  });
});

describe('synthetic path — canary-backfill-suppression compatibility', () => {
  it('emit path matches `data.contact.**.created`', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    store.observe({ email: 'p@x.com', source: 'email_from', event_at: 100 });
    expect(events).toHaveLength(1);
    const path = eventPath(
      events[0].platform,
      events[0].slug,
      events[0].entity_type,
      events[0].event_kind,
    );
    expect(matchesPattern('data.contact.**.created', path)).toBe(true);
  });

  it('honors slug + entityType overrides for future multi-instance contact use', () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, {
      bus,
      slug: 'work',
      entityType: 'person',
    });
    store.observe({ email: 'p@x.com', source: 'email_from', event_at: 100 });
    expect(events).toHaveLength(1);
    expect(events[0].slug).toBe('work');
    expect(events[0].entity_type).toBe('person');
    const path = eventPath(
      events[0].platform,
      events[0].slug,
      events[0].entity_type,
      events[0].event_kind,
    );
    // Wildcard still matches.
    expect(matchesPattern('data.contact.**.created', path)).toBe(true);
    expect(path).toBe('data.contact.work.person.created');
  });
});

describe('boot backfill — silent by default', () => {
  it('backfillContacts does not emit even when bus is wired (production safety)', async () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    // Pre-populate a mail collection so backfillContactsFromMail has
    // something to walk. Schema mirrors what `createCollectionTable`
    // produces (collection_mail_<slug>). Only the columns
    // `mailRowToMessage` reads need to be present.
    db.exec(`
      CREATE TABLE collection_mail_99999999cc (
        record_id TEXT PRIMARY KEY,
        hot_fields TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      INSERT INTO collection_mail_99999999cc (record_id, hot_fields, received_at) VALUES
        ('m1', '{"from":"alice@x.com","to":["bob@x.com"],"cc":[],"message_id":"m1"}', 1000),
        ('m2', '{"from":"carol@x.com","to":["dave@x.com"],"cc":[],"message_id":"m2"}', 2000);
    `);
    const result = await backfillContacts(db, store, {
      yieldBatch: () => Promise.resolve(),
    });
    // Backfill applied observations …
    expect(result.mail.observed).toBeGreaterThan(0);
    expect(store.count()).toBeGreaterThan(0);
    // … but no events made it onto the bus.
    expect(events).toHaveLength(0);
  });

  it('explicit silent: false during backfill flips to emit (for tests / debug paths)', async () => {
    const { events, bus } = collectAll();
    const store = createContactStore(db, { bus });
    db.exec(`
      CREATE TABLE collection_mail_99999999cc (
        record_id TEXT PRIMARY KEY,
        hot_fields TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      INSERT INTO collection_mail_99999999cc (record_id, hot_fields, received_at) VALUES
        ('m1', '{"from":"alice@x.com","to":["bob@x.com"],"cc":[],"message_id":"m1"}', 1000);
    `);
    await backfillContacts(db, store, {
      yieldBatch: () => Promise.resolve(),
      silent: false,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.event_kind === 'created')).toBe(true);
  });
});
