/** D-123 Phase 4 — End-to-end integration test.
 *
 *  Drives the full stack: source-walker → harness → producer →
 *  enrichment store → resolver. Verifies that recipe-side refs of
 *  the form `{{data.enrichment.mail.<id>.thread_signals}}` resolve
 *  to the producer's emitted value after one housekeeping cycle. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CollectionRecord,
  HousekeepingStepResult,
} from '@recued/contracts';

import {
  buildEnrichmentProducerTask,
  threadSignalsProducer,
} from '../housekeeping/index.js';
import type {
  HousekeepingContext,
} from '../housekeeping/registry.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentResolver } from '../storage/enrichment-resolver.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now = 1_700_000_000_000;
const ONE_DAY = 86_400_000;
const mailTableName = 'collection_mail_test';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-p4-integration-'));
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
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
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

const allMailRows = (): SourceRecord[] => {
  const rows = db
    .prepare(`SELECT * FROM ${mailTableName} ORDER BY record_id ASC`)
    .all() as Array<{
      record_id: string;
      received_at: number;
      modified_at: number;
      hot_fields: string;
      size_bytes: number;
      source_id: string;
    }>;
  return rows.map((row) => {
    const data: CollectionRecord = {
      record_id: row.record_id,
      received_at: row.received_at,
      modified_at: row.modified_at,
      hot_fields: JSON.parse(row.hot_fields) as Record<string, unknown>,
      size_bytes: row.size_bytes,
      source_id: row.source_id,
    };
    return { target_id: row.record_id, data, cursor_token: row.record_id };
  });
};

/** Walker over the test mail table. Mirrors the production
 *  `createMailSourceWalker` shape but reads SQL directly so the
 *  test doesn't need to spin up `composeMailStack`. */
const testMailWalker = (): SourceCollectionWalker => {
  const FIELDS = ['from', 'to', 'cc', 'subject', 'thread_id', 'folder', 'is_read'] as const;
  const hash = (record: SourceRecord): string => {
    const parts = FIELDS.map((k) => String(record.data.hot_fields[k] ?? ''));
    return parts.join('|');
  };
  return {
    *walkAfter(cursor_token, batch_size) {
      let yielded = 0;
      for (const r of allMailRows()) {
        if (r.cursor_token <= cursor_token) continue;
        if (yielded >= batch_size) return;
        yield r;
        yielded += 1;
      }
    },
    hashOf: hash,
    fetchOne(target_id) {
      return allMailRows().find((r) => r.target_id === target_id) ?? null;
    },
  };
};

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

describe('D-123 P4 integration — harness → producer → resolver', () => {
  it('resolves data.enrichment.mail.<id>.thread_signals after one cycle', async () => {
    insertMail('m1', {
      thread_id: 't-101',
      from: 'alice@example.com',
      to: ['bob@example.com'],
      is_read: true,
    }, now - ONE_DAY);
    insertMail('m2', {
      thread_id: 't-101',
      from: 'bob@example.com',
      to: ['alice@example.com'],
      is_read: false,
    }, now);

    const task = buildEnrichmentProducerTask({
      producer: threadSignalsProducer,
      walker: testMailWalker(),
    });
    const result: HousekeepingStepResult = await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');

    const resolver = createEnrichmentResolver(store);
    const resolved = resolver.resolve(['mail', 'm1', 'thread_signals']);
    expect(resolved.kind).toBe('value');
    if (resolved.kind === 'value') {
      expect(resolved.value).toMatchObject({
        thread_id: 't-101',
        message_count: 2,
        participant_count: 2,
        span_days: 1,
        has_unread: true,
      });
    }
  });

  it('returns null on resolver lookup before the producer runs', () => {
    insertMail('m1', { thread_id: 't-100', from: 'a@x.com', is_read: true });
    const resolver = createEnrichmentResolver(store);
    const resolved = resolver.resolve(['mail', 'm1', 'thread_signals']);
    expect(resolved.kind).toBe('null');
  });

  it('emits one row per source record under the housekeeping authored_by stamp', async () => {
    insertMail('m1', { thread_id: 't-A', from: 'a@x.com', is_read: true }, now - ONE_DAY);
    insertMail('m2', { thread_id: 't-A', from: 'b@x.com', is_read: true }, now);
    insertMail('m3', { thread_id: 't-B', from: 'a@x.com', is_read: false });

    const task = buildEnrichmentProducerTask({
      producer: threadSignalsProducer,
      walker: testMailWalker(),
    });
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);

    const rows = store.list({ topic: 'thread_signals' });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.scope).toBe('mail');
      expect(row.authored_by).toBe('system.housekeeping.thread_signals');
    }

    // Per-record bag listing via the resolver also surfaces the row.
    const resolver = createEnrichmentResolver(store);
    const m3Bag = resolver.resolve(['mail', 'm3']);
    expect(m3Bag.kind).toBe('list');
    if (m3Bag.kind === 'list') {
      expect(m3Bag.records.find((r) => r.topic === 'thread_signals')).toBeDefined();
    }
  });
});
