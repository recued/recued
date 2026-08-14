import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import {
  createWebhookCollection,
  type WebhookCollection,
} from '../collections/webhook/webhook-collection.js';
import {
  handleCollectionGet,
  handleCollectionList,
} from '../collections/collection-handler.js';

const BIG_QUOTA = 100 * 1024 * 1024;

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

interface Harness {
  base: string;
  db: Database.Database;
  collection: WebhookCollection;
  dispatchers: KernelDispatchers;
  close(): Promise<void>;
}

const setup = async (): Promise<Harness> => {
  const base = mkdtempSync(join(tmpdir(), 'webhook-kernel-'));
  const data = join(base, 'data');
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:webhook:github' });
  const blobs = createBlobStore(join(data, 'blobs'));
  const bus = createWarehouseEventBus();
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  const registry = createCollectionRegistry();
  const collection = createWebhookCollection({
    db, blobs, gate, bus, slug: 'github',
    config: () => ({ retention_days: 30, quota_bytes: BIG_QUOTA }),
    auditLog,
  });
  registry.register(collection);
  await collection.sync.start();

  // Seed two deliveries so list/get have something to return.
  await collection.ingest({
    method: 'POST', body: Buffer.from('{"event":"push"}'),
    contentType: 'application/json',
    headersSubset: { 'x-github-event': 'push' },
    query: {}, remoteIp: '10.0.0.1',
  });
  await collection.ingest({
    method: 'POST', body: Buffer.from('{"event":"star"}'),
    contentType: 'application/json',
    headersSubset: { 'x-github-event': 'star' },
    query: {}, remoteIp: '10.0.0.1',
  });

  const dispatchers: KernelDispatchers = {
    collectionList: async (input) => {
      const res = await handleCollectionList({ registry }, input);
      // D-236 — forward `source_freshness` exactly as the production closure in
      // wire-executor-config does. A harness that narrows where production does
      // not is a stub that diverges from the thing it stands in for.
      return { records: res.records, source_freshness: res.source_freshness };
    },
    collectionGet: async (input) => handleCollectionGet({ registry }, input),
  };

  return {
    base, db, collection, dispatchers,
    async close() {
      await collection.close();
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
};

let h: Harness;
beforeEach(async () => { h = await setup(); });
afterEach(async () => { await h.close(); });

describe('webhook-list kernel ingredient', () => {
  it('returns every delivery for the slug', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const res = await adapter(mkCall('webhook-list', { slug: 'github' })) as {
      records: Array<{ record_id: string; hot_fields: Record<string, unknown> }>;
    };
    expect(res.records.length).toBe(2);
    const events = res.records.map((r) => (r.hot_fields.headers_subset as Record<string, string>)['x-github-event']);
    expect(events.sort()).toEqual(['push', 'star']);
  });

  it('filters by hot_fields equality through the handler', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const res = await adapter(mkCall('webhook-list', {
      slug: 'github',
      filters: { method: 'POST' },
    })) as { records: unknown[] };
    expect(res.records.length).toBe(2);
    const filtered = await adapter(mkCall('webhook-list', {
      slug: 'github',
      filters: { method: 'DELETE' },
    })) as { records: unknown[] };
    expect(filtered.records.length).toBe(0);
  });

  it('routes platform=webhook even though the caller only passed slug', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      ...h.dispatchers,
      collectionList: async (input) => { captured = input; return { records: [] }; },
    });
    await adapter(mkCall('webhook-list', { slug: 'github' }));
    expect((captured as { platform: string }).platform).toBe('webhook');
  });

  it('surfaces COLLECTION_NOT_FOUND for an unregistered slug', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    await expect(adapter(mkCall('webhook-list', { slug: 'unregistered' })))
      .rejects.toThrow(/COLLECTION_NOT_FOUND/);
  });
});

describe('webhook-get kernel ingredient', () => {
  it('returns the record by record_id', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const list = await adapter(mkCall('webhook-list', { slug: 'github' })) as {
      records: Array<{ record_id: string; body_inline?: string }>;
    };
    const id = list.records[0].record_id;
    const got = await adapter(mkCall('webhook-get', { slug: 'github', record_id: id })) as {
      record: { record_id: string; body_inline?: string } | null;
    };
    expect(got.record).not.toBeNull();
    expect(got.record?.record_id).toBe(id);
    expect(got.record?.body_inline).toMatch(/^{"event":/);
  });

  it('returns null for an unknown record_id', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const res = await adapter(mkCall('webhook-get', {
      slug: 'github', record_id: 'webhook:NONEXISTENT',
    })) as { record: unknown };
    expect(res.record).toBeNull();
  });
});
