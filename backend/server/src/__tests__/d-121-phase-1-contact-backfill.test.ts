/** D-121 Phase 1 — boot backfill tests.
 *
 *  Covers:
 *    - mail-table walk pulls From/To/CC into contacts
 *    - calendar-table walk pulls organizer + attendees
 *    - batch yield budget honored (small batch_size triggers
 *      multiple ticks; onBatch fires per tick)
 *    - idempotent: second call doesn't double-insert (counts go up
 *      via interaction_count, contacts row count stays the same)
 *    - corrupted JSON rows skipped without aborting
 *    - empty database -> 0/0/0 result */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  backfillContacts,
  backfillContactsFromMail,
  backfillContactsFromCalendar,
  type BackfillProgress,
} from '../warehouse/contact-backfill.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

const setupMailTable = (table: string): void => {
  db.exec(`
    CREATE TABLE ${table} (
      record_id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      hot_fields TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      body_inline TEXT,
      blob_hash TEXT
    );
  `);
};

const insertMailRow = (
  table: string,
  args: { record_id: string; received_at: number; from: string; to?: string[]; cc?: string[] },
): void => {
  db.prepare(
    `INSERT INTO ${table}
       (record_id, received_at, modified_at, hot_fields, size_bytes, source_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.record_id,
    args.received_at,
    args.received_at,
    JSON.stringify({
      from: args.from,
      to: args.to ?? [],
      cc: args.cc ?? [],
      subject: '',
      message_id: args.record_id,
    }),
    100,
    args.record_id,
  );
};

const setupCalendarTable = (table: string): void => {
  db.exec(`
    CREATE TABLE ${table} (
      record_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      record_payload TEXT NOT NULL
    );
  `);
};

const insertCalendarRow = (
  table: string,
  args: {
    record_id: string;
    start_at: number;
    organizer_email?: string;
    attendee_emails?: string[];
  },
): void => {
  const event = {
    source_id: args.record_id,
    ical_uid: `uid-${args.record_id}`,
    calendar_id: 'cal-1',
    summary: 'Sync',
    start_at: args.start_at,
    end_at: args.start_at + 60_000,
    timezone: 'UTC',
    is_all_day: false,
    status: 'confirmed',
    created_at: args.start_at,
    updated_at: args.start_at,
    ...(args.organizer_email
      ? { organizer: { email: args.organizer_email } }
      : {}),
    attendees: (args.attendee_emails ?? []).map((email) => ({
      email,
      response_status: 'accepted',
    })),
  };
  db.prepare(
    `INSERT INTO ${table}
       (record_id, source_id, received_at, modified_at, size_bytes, record_payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.record_id, args.record_id, args.start_at, args.start_at, 200, JSON.stringify(event));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-backfill-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backfillContactsFromMail', () => {
  it('returns zero result when no mail tables exist', async () => {
    const result = await backfillContactsFromMail(db, store);
    expect(result).toEqual({ tables: 0, processed: 0, observed: 0 });
    expect(store.count()).toBe(0);
  });

  it('materializes contacts from one mail table', async () => {
    setupMailTable('collection_mail_aaaaaaaaaa');
    insertMailRow('collection_mail_aaaaaaaaaa', {
      record_id: 'm1',
      received_at: 100,
      from: 'Bob <bob@x.com>',
      to: ['alice@x.com'],
    });
    const result = await backfillContactsFromMail(db, store);
    expect(result.tables).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.observed).toBe(2);
    expect(store.count()).toBe(2);
    const bob = store.get('bob@x.com');
    expect(bob?.first_seen).toBe(100);
    expect(bob?.source).toBe('email_from');
  });

  it('walks multiple mail tables', async () => {
    setupMailTable('collection_mail_aaaaaaaaaa');
    setupMailTable('collection_mail_bbbbbbbbbb');
    insertMailRow('collection_mail_aaaaaaaaaa', {
      record_id: 'm1',
      received_at: 100,
      from: 'Bob <bob@x.com>',
    });
    insertMailRow('collection_mail_bbbbbbbbbb', {
      record_id: 'm2',
      received_at: 200,
      from: 'Carol <carol@x.com>',
    });
    const result = await backfillContactsFromMail(db, store);
    expect(result.tables).toBe(2);
    expect(store.count()).toBe(2);
  });

  it('skips rows with corrupt hot_fields JSON', async () => {
    setupMailTable('collection_mail_aaaaaaaaaa');
    db.prepare(
      `INSERT INTO collection_mail_aaaaaaaaaa
         (record_id, received_at, modified_at, hot_fields, size_bytes, source_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('bad', 100, 100, '{not json', 0, 'bad');
    insertMailRow('collection_mail_aaaaaaaaaa', {
      record_id: 'm1',
      received_at: 100,
      from: 'Bob <bob@x.com>',
    });
    const result = await backfillContactsFromMail(db, store);
    expect(result.processed).toBe(2);
    // Only the valid row produced an observation.
    expect(result.observed).toBe(1);
    expect(store.count()).toBe(1);
  });
});

describe('backfillContactsFromCalendar', () => {
  it('materializes contacts from organizer + attendees', async () => {
    setupCalendarTable('collection_calendar_aaaaaaaaaa');
    insertCalendarRow('collection_calendar_aaaaaaaaaa', {
      record_id: 'e1',
      start_at: 1000,
      organizer_email: 'host@x.com',
      attendee_emails: ['guest1@x.com', 'guest2@x.com'],
    });
    const result = await backfillContactsFromCalendar(db, store);
    expect(result.tables).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.observed).toBe(3);
    const host = store.get('host@x.com');
    expect(host?.source).toBe('calendar_attendee');
    expect(host?.first_seen).toBe(1000);
  });

  it('ignores _fts companion tables', async () => {
    setupCalendarTable('collection_calendar_aaaaaaaaaa');
    db.exec(`CREATE TABLE collection_calendar_aaaaaaaaaa_fts (key TEXT, blob TEXT);`);
    const result = await backfillContactsFromCalendar(db, store);
    expect(result.tables).toBe(1);
  });
});

describe('batch yield + onBatch progress', () => {
  it('yields between batches and reports progress per tick', async () => {
    setupMailTable('collection_mail_aaaaaaaaaa');
    for (let i = 0; i < 7; i++) {
      insertMailRow('collection_mail_aaaaaaaaaa', {
        record_id: `m${i}`,
        received_at: 100 + i,
        from: `user${i}@x.com`,
      });
    }
    const progress: BackfillProgress[] = [];
    let yields = 0;
    await backfillContactsFromMail(db, store, {
      batch_size: 3,
      onBatch: (p) => progress.push(p),
      yieldBatch: async () => { yields++; },
    });
    // 7 rows / batch=3 → 3 batches (3 + 3 + 1).
    expect(progress.length).toBe(3);
    expect(progress[0]?.batch_count).toBe(3);
    expect(progress[1]?.batch_count).toBe(3);
    expect(progress[2]?.batch_count).toBe(1);
    expect(progress[2]?.total_processed).toBe(7);
    // Yields fire BETWEEN batches — between batch 1+2 and 2+3 = 2 yields.
    // (No yield after the final batch because the loop terminates first.)
    expect(yields).toBe(2);
  });
});

describe('idempotency', () => {
  it('does not double-insert on a second run', async () => {
    setupMailTable('collection_mail_aaaaaaaaaa');
    insertMailRow('collection_mail_aaaaaaaaaa', {
      record_id: 'm1',
      received_at: 100,
      from: 'Bob <bob@x.com>',
    });
    await backfillContactsFromMail(db, store);
    const firstCount = store.count();
    const firstInteractions = store.get('bob@x.com')?.interaction_count;

    await backfillContactsFromMail(db, store);
    expect(store.count()).toBe(firstCount);
    // Re-running counts as a second observation; first-seen wins for
    // source / first_seen / name. interaction_count bumps every time.
    expect(store.get('bob@x.com')?.interaction_count).toBe((firstInteractions ?? 0) + 1);
    expect(store.get('bob@x.com')?.first_seen).toBe(100);
  });
});

describe('backfillContacts (combined)', () => {
  it('runs mail + calendar in sequence and returns both results', async () => {
    setupMailTable('collection_mail_aaaaaaaaaa');
    setupCalendarTable('collection_calendar_bbbbbbbbbb');
    insertMailRow('collection_mail_aaaaaaaaaa', {
      record_id: 'm1',
      received_at: 100,
      from: 'bob@x.com',
    });
    insertCalendarRow('collection_calendar_bbbbbbbbbb', {
      record_id: 'e1',
      start_at: 200,
      organizer_email: 'bob@x.com',
    });
    const result = await backfillContacts(db, store, { yieldBatch: async () => {} });
    expect(result.mail.processed).toBe(1);
    expect(result.calendar.processed).toBe(1);
    // bob@x.com seen by mail first → first_seen = 100, source = email_from.
    const bob = store.get('bob@x.com');
    expect(bob?.first_seen).toBe(100);
    expect(bob?.source).toBe('email_from');
    expect(bob?.interaction_count).toBe(2);
  });
});
