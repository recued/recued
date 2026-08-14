import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import {
  createWarehouseEventBus,
  type WarehouseEventBus,
} from '@recued/warehouse-events';
import { createKernelAdapter, type KernelDispatchers } from '@recued/ingredients';

import { createBlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import {
  handleCollectionGet,
  handleCollectionList,
} from '../collections/collection-handler.js';

const BIG_QUOTA = 100 * 1024 * 1024;
const DEFAULT_MAX = 10 * 1024 * 1024;

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

interface Harness {
  base: string;
  root: string;
  db: Database.Database;
  registry: ReturnType<typeof createCollectionRegistry>;
  dispatchers: KernelDispatchers;
  bus: WarehouseEventBus;
  close(): Promise<void>;
}

const newHarness = async (): Promise<Harness> => {
  const base = mkdtempSync(join(tmpdir(), 'file-kernel-'));
  const root = join(base, 'watched');
  const data = join(base, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:work' });
  const blobs = createBlobStore(join(data, 'blobs'));
  const bus = createWarehouseEventBus();
  const registry = createCollectionRegistry();

  // Seed a test file + start the file collection so the table has
  // a record to read via the kernel ingredient.
  writeFileSync(join(root, 'note.md'), '# Q3 Review\n\nStuff and things.');
  const collection = createFileCollection({
    db, blobs, gate, bus, slug: 'work',
    config: () => ({
      path: root, ignore: [],
      max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
    }),
  });
  await collection.sync.start();
  registry.register(collection);

  const dispatchers: KernelDispatchers = {
    collectionList: async ({ platform, slug, filters, since, until, limit }) => {
      const res = await handleCollectionList({ registry }, { platform, slug, filters, since, until, limit });
      // D-236 — forward `source_freshness` exactly as the production closure in
      // wire-executor-config does. A harness that narrows where production does
      // not is a stub that diverges from the thing it stands in for.
      return { records: res.records, source_freshness: res.source_freshness };
    },
    collectionGet: async ({ platform, slug, record_id }) => {
      return handleCollectionGet({ registry }, { platform, slug, record_id });
    },
  };

  return {
    base, root, db, registry, dispatchers, bus,
    async close() {
      await collection.close();
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
};

let h: Harness;
beforeEach(async () => { h = await newHarness(); });
afterEach(async () => { await h.close(); });

describe('file-list kernel ingredient → handler roundtrip', () => {
  it('returns the seeded record via the kernel adapter', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const res = await adapter(mkCall('file-list', { slug: 'work' })) as {
      records: Array<{ record_id: string; hot_fields: Record<string, unknown> }>;
    };
    expect(res.records.length).toBe(1);
    expect(res.records[0].hot_fields.path).toBe('note.md');
  });

  it('forwards filters to the handler', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const noMatch = await adapter(mkCall('file-list', {
      slug: 'work', filters: { mime_type: 'application/pdf' },
    })) as { records: unknown[] };
    expect(noMatch.records.length).toBe(0);
    const match = await adapter(mkCall('file-list', {
      slug: 'work', filters: { mime_type: 'text/markdown' },
    })) as { records: unknown[] };
    expect(match.records.length).toBe(1);
  });

  it('surfaces COLLECTION_NOT_FOUND through the adapter', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    // The handler throws an RpcError('not_found'); the kernel adapter
    // lets it propagate so recipe runtime maps it to the final error.
    await expect(adapter(mkCall('file-list', { slug: 'unregistered' })))
      .rejects.toThrow(/COLLECTION_NOT_FOUND/);
  });
});

describe('file-get kernel ingredient → handler roundtrip', () => {
  it('returns the record by id', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const list = await adapter(mkCall('file-list', { slug: 'work' })) as {
      records: Array<{ record_id: string }>;
    };
    const recordId = list.records[0].record_id;
    const got = await adapter(mkCall('file-get', { slug: 'work', record_id: recordId })) as {
      record: { record_id: string; body_inline?: string } | null;
    };
    expect(got.record).not.toBeNull();
    expect(got.record?.record_id).toBe(recordId);
    expect(got.record?.body_inline).toContain('Q3 Review');
  });

  it('returns null for an unknown record_id', async () => {
    const adapter = createKernelAdapter(h.dispatchers);
    const res = await adapter(mkCall('file-get', {
      slug: 'work', record_id: 'file:nonexistent',
    })) as { record: unknown };
    expect(res.record).toBeNull();
  });
});
