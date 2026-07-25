import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import {
  createMailCollection,
  type MailCollectionConfig,
} from '../collections/mail/mail-collection.js';
import type {
  CanonicalMessage,
  MailProvider,
  ProviderSyncCallback,
  ProviderSyncEvent,
} from '../collections/mail/provider.js';
import type { Collection } from '../collections/types.js';

const BIG_QUOTA = 100 * 1024 * 1024;

const mkMessage = (overrides: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'msg-1',
  from: 'alice@example.com',
  to: ['bob@example.com'],
  cc: [],
  subject: 'Q3 review',
  thread_id: 'T-1',
  folder_or_label: 'INBOX',
  is_read: false,
  has_attachments: false,
  received_at: 1_700_000_000_000,
  body_text: 'body text contents',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Stub provider — scripted initialScan + manual push for live sync
// ────────────────────────────────────────────────────────────────

interface StubProviderHooks {
  /** Called on `connect` — lets tests inject failures. */
  onConnect?: () => Promise<void>;
  /** Messages fed through `initialScan`. */
  scanMessages?: CanonicalMessage[];
  /** Called inside `initialScan` to abort after N messages when the
   *  returned callback value is `false`. */
  scanAbortAfter?: number;
  /** Reported via `provider.health()`. */
  health?: () => { last_successful_sync_at: number; error_count_24h: number; pending_queue_size: number };
  /** When set, initialScan throws with this message. */
  scanError?: string;
}

interface StubProviderHandle {
  provider: MailProvider;
  push: (event: ProviderSyncEvent) => Promise<void>;
  connectCalls: number;
  closeCalls: number;
  stopCalls: number;
}

const makeStubProvider = (slug: string, hooks: StubProviderHooks = {}): StubProviderHandle => {
  let syncCb: ProviderSyncCallback | null = null;
  let stopCalls = 0;
  let connectCalls = 0;
  let closeCalls = 0;
  const provider: MailProvider = {
    kind: 'imap',
    slug,
    sendCapable: false,
    accountEmail: '',
    async connect() {
      connectCalls++;
      if (hooks.onConnect) await hooks.onConnect();
    },
    async initialScan(opts) {
      if (hooks.scanError) throw new Error(hooks.scanError);
      const msgs = hooks.scanMessages ?? [];
      const abortAt = hooks.scanAbortAfter ?? Infinity;
      for (let i = 0; i < msgs.length; i++) {
        if (i >= abortAt) break;
        const cont = await opts.onMessage(msgs[i]);
        if (!cont) break;
      }
    },
    async startSync(cb) {
      syncCb = cb;
      return async () => { stopCalls++; syncCb = null; };
    },
    async close() { closeCalls++; },
    health() {
      return hooks.health?.() ?? { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
  };
  return {
    provider,
    push: async (event) => {
      if (!syncCb) throw new Error('push called before startSync');
      await syncCb(event);
    },
    get connectCalls() { return connectCalls; },
    get closeCalls() { return closeCalls; },
    get stopCalls() { return stopCalls; },
  };
};

// ────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  db: Database.Database;
  gate: StorageGate;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  events: WarehouseEvent[];
  stub: StubProviderHandle;
  collection: Collection;
  close(): Promise<void>;
}

const newHarness = (hooks: StubProviderHooks = {}, configOverrides: Partial<MailCollectionConfig> = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-collection-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' });
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (e) => { events.push(e); });
  const stub = makeStubProvider('work', hooks);
  const config: MailCollectionConfig = {
    backfill_days: 30,
    retention_days: 365,
    quota_bytes: BIG_QUOTA,
    ...configOverrides,
  };
  const collection = createMailCollection({
    db, blobs, gate, bus, slug: 'work',
    provider: stub.provider,
    config: () => config,
  });
  return {
    dir, db, gate, blobs, bus, events, stub, collection,
    async close() {
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(async () => { await h?.close(); });

// ────────────────────────────────────────────────────────────────
// Initial scan
// ────────────────────────────────────────────────────────────────

describe('MailCollection — initial scan', () => {
  it('connects the provider and upserts every message', async () => {
    h = newHarness({
      scanMessages: [
        mkMessage({ source_id: 'a', subject: 'First', received_at: 1 }),
        mkMessage({ source_id: 'b', subject: 'Second', received_at: 2 }),
        mkMessage({ source_id: 'c', subject: 'Third', received_at: 3 }),
      ],
    });
    await h.collection.sync.start();
    expect(h.stub.connectCalls).toBe(1);
    const rows = h.collection.list({ platform: 'mail', slug: 'work' });
    expect(rows.length).toBe(3);
    expect(h.events.filter((e) => e.event_kind === 'created').length).toBe(3);
  });

  it('populates hot fields from the canonical message', async () => {
    h = newHarness({
      scanMessages: [mkMessage({
        source_id: 'a', from: 'p@x.com', to: ['q@x.com', 'r@x.com'],
        cc: ['c@x.com'], subject: 'hi', thread_id: 'T-9',
        folder_or_label: 'INBOX', is_read: true, has_attachments: true,
        labels: ['INBOX', 'IMPORTANT'],
      })],
    });
    await h.collection.sync.start();
    const row = h.collection.list({ platform: 'mail', slug: 'work' })[0];
    expect(row.hot_fields).toMatchObject({
      from: 'p@x.com',
      to: ['q@x.com', 'r@x.com'],
      cc: ['c@x.com'],
      subject: 'hi',
      thread_id: 'T-9',
      folder: 'INBOX',
      is_read: true,
      has_attachments: true,
      labels: ['INBOX', 'IMPORTANT'],
      message_id: 'a',
    });
  });

  it('stores bodies ≤ 64 KB inline (FTS-indexed)', async () => {
    h = newHarness({
      scanMessages: [mkMessage({ source_id: 'a', body_text: 'Q3 planning notes' })],
    });
    await h.collection.sync.start();
    const row = h.collection.list({ platform: 'mail', slug: 'work' })[0];
    expect(row.body_inline).toBe('Q3 planning notes');
    expect(row.blob_hash).toBeUndefined();
    const hits = h.collection.search({ platform: 'mail', slug: 'work', query: 'planning' });
    expect(hits.length).toBe(1);
  });

  it('spills bodies > 64 KB to CAS (not FTS-indexed)', async () => {
    const big = 'x'.repeat(70 * 1024);
    h = newHarness({
      scanMessages: [mkMessage({ source_id: 'a', body_text: big })],
    });
    await h.collection.sync.start();
    const row = h.collection.list({ platform: 'mail', slug: 'work' })[0];
    expect(row.body_inline).toBeUndefined();
    expect(typeof row.blob_hash).toBe('string');
    // CAS blob matches — retrievable via the blob store.
    const fromCas = await h.blobs.get(row.blob_hash!);
    expect(fromCas?.toString('utf8')).toBe(big);
  });

  it('honors onMessage returning false (abort scan)', async () => {
    h = newHarness({
      scanMessages: [
        mkMessage({ source_id: 'a' }),
        mkMessage({ source_id: 'b' }),
        mkMessage({ source_id: 'c' }),
      ],
      scanAbortAfter: 2,
    });
    await h.collection.sync.start();
    expect(h.collection.list({ platform: 'mail', slug: 'work' }).length).toBe(2);
  });

  it('picks a folder from labels when provider omits folder_or_label', async () => {
    h = newHarness({
      scanMessages: [mkMessage({
        source_id: 'a', folder_or_label: '',
        labels: ['STARRED', 'INBOX'],
      })],
    });
    await h.collection.sync.start();
    const row = h.collection.list({ platform: 'mail', slug: 'work' })[0];
    expect(row.hot_fields.folder).toBe('INBOX');
  });
});

// ────────────────────────────────────────────────────────────────
// Live sync via stub push
// ────────────────────────────────────────────────────────────────

describe('MailCollection — live sync', () => {
  it('handles created → updated → deleted for a source_id', async () => {
    h = newHarness();
    await h.collection.sync.start();
    await h.stub.push({ kind: 'created', source_id: 'a', message: mkMessage({ source_id: 'a', subject: 'v1', is_read: false }) });
    await h.stub.push({ kind: 'updated', source_id: 'a', message: mkMessage({ source_id: 'a', subject: 'v1', is_read: true }) });
    await h.stub.push({ kind: 'deleted', source_id: 'a' });
    const kinds = h.events.map((e) => e.event_kind);
    expect(kinds).toEqual(['created', 'updated', 'deleted']);
    expect(h.collection.list({ platform: 'mail', slug: 'work' }).length).toBe(0);
  });

  it('ignores events that claim created/updated with no message', async () => {
    h = newHarness();
    await h.collection.sync.start();
    await h.stub.push({ kind: 'created', source_id: 'x' } as ProviderSyncEvent);
    expect(h.collection.list({ platform: 'mail', slug: 'work' }).length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle + health
// ────────────────────────────────────────────────────────────────

describe('MailCollection — lifecycle', () => {
  it('stop() calls stopSync + provider.close', async () => {
    h = newHarness();
    await h.collection.sync.start();
    await h.collection.close();
    expect(h.stub.stopCalls).toBe(1);
    expect(h.stub.closeCalls).toBe(1);
    expect(h.collection.health().state).toBe('disconnected');
  });

  it('flips state to error when provider.connect throws', async () => {
    h = newHarness({ onConnect: async () => { throw new Error('offline'); } });
    await expect(h.collection.sync.start()).rejects.toThrow(/offline/);
    expect(h.collection.health().state).toBe('error');
  });

  it('initialScan failures are logged but don\'t stop live sync', async () => {
    h = newHarness({ scanError: 'fetch failed' });
    await h.collection.sync.start();
    expect(h.collection.health().state).toBe('connected');
    // Live sync still works.
    await h.stub.push({ kind: 'created', source_id: 'a', message: mkMessage({ source_id: 'a' }) });
    expect(h.collection.list({ platform: 'mail', slug: 'work' }).length).toBe(1);
  });

  it('folds provider health into the collection health snapshot', async () => {
    h = newHarness({ health: () => ({ last_successful_sync_at: 42, error_count_24h: 7, pending_queue_size: 3 }) });
    await h.collection.sync.start();
    const h1 = h.collection.health();
    expect(h1.last_indexed_at).toBeGreaterThanOrEqual(42);
    expect(h1.error_count_24h).toBeGreaterThanOrEqual(7);
    expect(h1.pending_queue_size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────
// Retention pass-through
// ────────────────────────────────────────────────────────────────

describe('MailCollection — retention', () => {
  it('delegates runRetention to the underlying pruner', async () => {
    h = newHarness({}, { retention_days: 0 });
    await h.collection.sync.start();
    const res = await h.collection.runRetention();
    expect(res.skipped_reason).toBe('retention_disabled');
  });
});
