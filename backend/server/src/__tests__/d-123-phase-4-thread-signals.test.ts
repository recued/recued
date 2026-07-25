/** D-123 Phase 4 — `thread_signals` canary producer tests.
 *
 *  Drives the producer end-to-end against a stubbed mail
 *  collection table layout that mirrors what
 *  `backend/server/src/collections/table.ts:227` produces in
 *  production. The producer scans `collection_mail_*` tables via
 *  raw SQL — same approach D-123 P3's `link-discovery` task uses
 *  for the provenance `links` table — so the test setup mirrors
 *  the real collection-table shape rather than going through
 *  `composeMailStack`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { threadSignalsProducer } from '../housekeeping/producers/thread-signals.js';
import type {
  HousekeepingContext,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { CollectionRecord, ThreadSignalsValue } from '@recued/contracts';

let dir: string;
let db: Database.Database;
let now = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

const mailTableName = 'collection_mail_test';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-p4-thread-signals-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${mailTableName} (
      record_id   TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      hot_fields  TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      source_id   TEXT NOT NULL,
      body_inline TEXT,
      blob_hash   TEXT
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insertMail = (
  record_id: string,
  hot: Record<string, unknown>,
  received_at = now,
): void => {
  db.prepare(
    `INSERT INTO ${mailTableName} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(record_id, received_at, received_at, JSON.stringify(hot), 100, record_id);
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const sourceFor = (record_id: string): SourceRecord => {
  const row = db
    .prepare(`SELECT * FROM ${mailTableName} WHERE record_id = ?`)
    .get(record_id) as
    | {
        record_id: string;
        received_at: number;
        modified_at: number;
        hot_fields: string;
        size_bytes: number;
        source_id: string;
      }
    | undefined;
  if (!row) throw new Error(`fixture mail '${record_id}' missing`);
  const data: CollectionRecord = {
    record_id: row.record_id,
    received_at: row.received_at,
    modified_at: row.modified_at,
    hot_fields: JSON.parse(row.hot_fields) as Record<string, unknown>,
    size_bytes: row.size_bytes,
    source_id: row.source_id,
  };
  return { target_id: record_id, data, cursor_token: record_id };
};

describe('threadSignalsProducer metadata', () => {
  it('declares the registry topic + scope + zero-token estimate', () => {
    expect(threadSignalsProducer.topic).toBe('thread_signals');
    expect(threadSignalsProducer.source_scope).toBe('mail');
    expect(threadSignalsProducer.estimate_per_record_tokens()).toBe(0);
  });
});

describe('threadSignalsProducer.produce — single-record threads', () => {
  it('emits trivial rollup for a record with empty thread_id', async () => {
    insertMail('m1', {
      thread_id: '',
      from: 'Alice <alice@example.com>',
      to: ['bob@example.com'],
      is_read: true,
    });
    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect(result?.value).toEqual({
      thread_id: '',
      message_count: 1,
      participant_count: 2, // alice@ + bob@
      span_days: 0,
      has_unread: false,
      // Bench-harvest extras: the fixture sets no subject and has no
      // contacts directory, so only thread recency is denormalized.
      latest_received_at: now,
    });
  });

  it('emits one-of-one rollup for a thread with a single message', async () => {
    insertMail('m1', {
      thread_id: 't-solo',
      from: 'alice@example.com',
      to: ['bob@example.com'],
      is_read: false,
    });
    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect(result?.value).toEqual({
      thread_id: 't-solo',
      message_count: 1,
      participant_count: 2,
      span_days: 0,
      has_unread: true,
      latest_received_at: now,
    });
  });
});

describe('threadSignalsProducer.produce — multi-record threads', () => {
  it('aggregates message_count + participant_count across siblings', async () => {
    insertMail('m1', {
      thread_id: 't-1',
      from: 'alice@example.com',
      to: ['bob@example.com', 'cara@example.com'],
      is_read: true,
    }, now - 2 * ONE_DAY);
    insertMail('m2', {
      thread_id: 't-1',
      from: 'bob@example.com',
      to: ['alice@example.com'],
      cc: ['cara@example.com', 'dave@example.com'],
      is_read: true,
    }, now - ONE_DAY);
    insertMail('m3', {
      thread_id: 't-1',
      from: 'cara@example.com',
      to: ['alice@example.com', 'bob@example.com', 'dave@example.com'],
      is_read: false,
    }, now);

    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m2'));
    expect(result?.value).toEqual({
      thread_id: 't-1',
      message_count: 3,
      participant_count: 4, // alice + bob + cara + dave
      span_days: 2,
      has_unread: true,
      // Latest sibling is m3 (received_at = now); its missing subject
      // keeps the optional `subject` field omitted.
      latest_received_at: now,
    });
  });

  it('denormalizes subject, resolved participants, and recency (bench harvest)', async () => {
    // A name-capable contacts directory: alice + bob are named; zed is
    // not listed — he counts as a participant but gains no resolved pair.
    db.exec(`CREATE TABLE IF NOT EXISTS contacts (email TEXT PRIMARY KEY, name TEXT)`);
    const ins = db.prepare(`INSERT INTO contacts (email, name) VALUES (?, ?)`);
    ins.run('alice@example.com', 'Alice Njoku');
    ins.run('bob@example.com', 'Bob Okafor');

    insertMail('m1', {
      thread_id: 't-h',
      from: 'alice@example.com',
      to: ['bob@example.com'],
      subject: 'Budget Q4',
      is_read: true,
    }, now - ONE_DAY);
    insertMail('m2', {
      thread_id: 't-h',
      from: 'bob@example.com',
      to: ['alice@example.com', 'zed@example.com'],
      subject: 'Re: Re: Budget Q4',
      is_read: true,
    }, now);

    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    const v = result?.value as ThreadSignalsValue;
    // Latest sibling is m2; its Re:-chain strips to the canonical subject.
    expect(v.subject).toBe('Budget Q4');
    expect(v.latest_received_at).toBe(now);
    expect(v.participant_count).toBe(3); // alice + bob + zed
    expect(v.participant_contacts).toEqual([
      { entity: 'alice@example.com', name: 'Alice Njoku' },
      { entity: 'bob@example.com', name: 'Bob Okafor' },
    ]);
  });

  it('flags has_unread when any sibling carries is_read=false', async () => {
    insertMail('m1', { thread_id: 't-2', from: 'a@x.com', is_read: true });
    insertMail('m2', { thread_id: 't-2', from: 'b@x.com', is_read: true });
    insertMail('m3', { thread_id: 't-2', from: 'c@x.com', is_read: false });
    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect((result?.value as { has_unread: boolean }).has_unread).toBe(true);
  });

  it('keeps has_unread=false when every sibling is read', async () => {
    insertMail('m1', { thread_id: 't-3', from: 'a@x.com', is_read: true });
    insertMail('m2', { thread_id: 't-3', from: 'b@x.com', is_read: true });
    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect((result?.value as { has_unread: boolean }).has_unread).toBe(false);
  });

  it('span_days is the integer day-count between earliest + latest received_at', async () => {
    insertMail('m1', { thread_id: 't-4', from: 'a@x.com', is_read: true }, now - 7 * ONE_DAY);
    insertMail('m2', { thread_id: 't-4', from: 'b@x.com', is_read: true }, now);
    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect((result?.value as { span_days: number }).span_days).toBe(7);
  });

  it('case-insensitive participant matching (Alice <Alice@X.com> equals alice@x.com)', async () => {
    insertMail('m1', { thread_id: 't-5', from: 'Alice <Alice@X.com>', to: ['bob@x.com'], is_read: true });
    insertMail('m2', { thread_id: 't-5', from: 'alice@x.com', to: ['BOB@X.COM'], is_read: true });
    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect((result?.value as { participant_count: number }).participant_count).toBe(2);
  });
});

describe('threadSignalsProducer.produce — multi-account threading', () => {
  it('aggregates across multiple collection_mail_* tables sharing thread_id', async () => {
    const otherTable = 'collection_mail_other';
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${otherTable} (
        record_id   TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        hot_fields  TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        source_id   TEXT NOT NULL,
        body_inline TEXT,
        blob_hash   TEXT
      );
    `);
    insertMail('m1', { thread_id: 't-shared', from: 'alice@x.com', is_read: true }, now - ONE_DAY);
    db.prepare(
      `INSERT INTO ${otherTable} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      'm2',
      now,
      now,
      JSON.stringify({ thread_id: 't-shared', from: 'bob@y.com', is_read: false }),
      100,
      'm2',
    );

    const result = await threadSignalsProducer.produce(stubCtx(), sourceFor('m1'));
    expect(result?.value).toMatchObject({
      thread_id: 't-shared',
      message_count: 2,
      participant_count: 2,
      span_days: 1,
      has_unread: true,
    });
  });
});
