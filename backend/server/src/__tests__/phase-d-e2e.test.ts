/** Phase D (D-106) end-to-end integration — Commit 19.
 *
 *  Ties the full warehouse chain together:
 *    - Collection registry composition (file + webhook + mail-stub).
 *    - Real SQLite + CAS + FTS5 + gate registry underneath.
 *    - Kernel ingredient dispatch via `collection.*` rpcs.
 *    - Retention + drain pipelines.
 *    - Heartbeat envelope picks up collection health.
 *
 *  Mail runs against an in-process stub provider (Commits 13-15 have
 *  their own unit tests for IMAP/Gmail/Graph transport specifics).
 *  File uses a real filesystem scan; webhook uses direct `ingest()`
 *  calls to bypass the HTTP route (the listener has its own tests).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  createStorageGate,
  type StorageGate,
} from '@recued/storage-gate';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry, type CollectionRegistry } from '../collections/registry.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { createWebhookCollection } from '../collections/webhook/webhook-collection.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import {
  handleCollectionList,
  handleCollectionSearch,
  handleCollectionGet,
  handleCollectionRunRetention,
  handleCollectionListEndpoints,
  type CollectionHandlerDeps,
} from '../collections/collection-handler.js';
import type {
  CanonicalMessage,
  MailProvider,
  ProviderSyncCallback,
} from '../collections/mail/provider.js';

// ────────────────────────────────────────────────────────────────
// Mail stub provider — scriptable message stream
// ────────────────────────────────────────────────────────────────

const makeStubProvider = (slug: string): {
  provider: MailProvider;
  push: (msg: CanonicalMessage) => Promise<void>;
} => {
  let cb: ProviderSyncCallback | null = null;
  let scanMsgs: CanonicalMessage[] = [];
  const provider: MailProvider = {
    kind: 'imap', slug,
    sendCapable: false,
    mutationCapable: false,
    accountEmail: '',
    async connect() { /* noop */ },
    async initialScan(opts) {
      for (const m of scanMsgs) {
        await opts.onMessage(m);
      }
    },
    async startSync(c) { cb = c; return async () => { cb = null; }; },
    async close() { /* noop */ },
    health() { return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 }; },
  };
  return {
    provider,
    async push(m) {
      if (!cb) throw new Error('push before startSync');
      await cb({ kind: 'created', source_id: m.source_id, message: m });
    },
  };
};

// ────────────────────────────────────────────────────────────────
// World — one big paired harness
// ────────────────────────────────────────────────────────────────

interface World {
  dir: string;
  watchedDir: string;
  db: Database.Database;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  events: WarehouseEvent[];
  registry: CollectionRegistry;
  gates: {
    file: StorageGate;
    webhook: StorageGate;
    mail: StorageGate;
  };
  mailStub: ReturnType<typeof makeStubProvider>;
  webhookCollection: ReturnType<typeof createWebhookCollection>;
  close(): Promise<void>;
}

const BIG_QUOTA = 128 * 1024 * 1024;

const mkWorld = async (): Promise<World> => {
  const base = mkdtempSync(join(tmpdir(), 'phase-d-e2e-'));
  const watchedDir = join(base, 'files');
  const data = join(base, 'data');
  mkdirSync(watchedDir, { recursive: true });
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, 'test.db'));
  db.pragma('journal_mode = WAL');

  const blobs = createBlobStore(join(data, 'blobs'));
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (e) => { events.push(e); });

  const gates = {
    file: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:docs' }),
    webhook: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:webhook:gh' }),
    mail: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' }),
  };

  const registry = createCollectionRegistry();

  const fileColl = createFileCollection({
    db, blobs, gate: gates.file, bus, slug: 'docs',
    config: () => ({
      path: watchedDir,
      ignore: ['**/.DS_Store'],
      max_body_bytes: 1024 * 1024,
      retention_days: 0,
      quota_bytes: BIG_QUOTA,
    }),
  });
  registry.register(fileColl);

  const webhookColl = createWebhookCollection({
    db, blobs, gate: gates.webhook, bus, slug: 'gh',
    config: () => ({ retention_days: 30, quota_bytes: BIG_QUOTA }),
  });
  registry.register(webhookColl);

  const mailStub = makeStubProvider('work');
  const mailColl = createMailCollection({
    db, blobs, gate: gates.mail, bus, slug: 'work',
    provider: mailStub.provider,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA }),
  });
  registry.register(mailColl);

  // Start all sync adapters so the file scan completes + webhook +
  // mail providers stand up their listeners / stub callbacks.
  for (const c of registry.list()) {
    await c.sync.start();
  }
  // ⛔ NO SLEEP HERE, AND NONE IS NEEDED. `sync.start()` is already the barrier:
  // the fs watcher's `start()` resolves only after the initial directory walk
  // completes and `fs.watch` is attached (`file-collection.ts`: "resolves only
  // after the initial directory walk completes (`scanDir(root)` in fs-adapter)").
  // The 30 ms tick that used to sit here described a guarantee it did not provide
  // and the loop above already had — a barrier made of hope beside a real one.

  return {
    dir: base, watchedDir, db, blobs, bus, events, registry, gates, mailStub, webhookCollection: webhookColl,
    async close() {
      await registry.dispose();
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
};

let w: World;
afterEach(async () => { await w?.close(); });

// ────────────────────────────────────────────────────────────────
// Composition + registry
// ────────────────────────────────────────────────────────────────

describe('Phase D e2e — composition', () => {
  it('registers three collections and lists them via listEndpoints', async () => {
    w = await mkWorld();
    const deps: CollectionHandlerDeps = { registry: w.registry };
    const res = await handleCollectionListEndpoints(deps);
    const slugs = res.endpoints.map((h) => `${h.platform}:${h.slug}`).sort();
    expect(slugs).toEqual(['file:docs', 'mail:work', 'webhook:gh']);
  });
});

// ────────────────────────────────────────────────────────────────
// File collection — real fs.watch round-trip
// ────────────────────────────────────────────────────────────────

/** ⛔ POLL FOR THE RECORD, NEVER SLEEP FOR IT.
 *
 *  This replaced `await setTimeout(650)` — 500 ms of production fs.watch debounce
 *  plus a 150 ms margin. A 30% margin is nothing on a loaded four-worker run, so
 *  the test passed in isolation and failed under directory-wide parallelism, which
 *  reads as flake and was really the assertion firing before the pipeline finished.
 *  Confirmed causally rather than assumed: shrinking the sleep to 20 ms reproduces
 *  `expected 0 to be greater than 0` — the exact message the parallel run printed.
 *
 *  🔑 Polling is BOTH more robust and faster. It returns the moment the record
 *  lands (~500 ms idle) instead of always paying the worst case, and under load it
 *  waits as long as the machine needs. A genuine regression still fails — after the
 *  deadline, with a message naming what never arrived instead of a bare `0`. */
const waitForSourceId = async (
  deps: CollectionHandlerDeps,
  query: { platform: string; slug: string },
  sourceId: string,
  // ⚠ GENEROUS ON PURPOSE, AND IT COSTS NOTHING. The poll returns the moment the
  // record lands (~500 ms idle), so the deadline is paid ONLY on a genuine failure.
  // 10 s was not enough under a full multi-root suite: this failed repeatedly there
  // while passing 7/7 in isolation, which is starvation, not a missing event.
  timeoutMs = 45_000,
): Promise<Awaited<ReturnType<typeof handleCollectionList>>['records'][number]> => {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const list = await handleCollectionList(deps, query);
    seen = list.records.length;
    const hit = list.records.find((r) => r.source_id === sourceId);
    if (hit) return hit;
    if (Date.now() >= deadline) {
      throw new Error(
        // ⛔ STATES THE FACTS AND DOES NOT ADJUDICATE THE CAUSE. The first version
        // ended "which is a real failure and not a slow machine" — and a slow
        // machine is exactly what it turned out to be under a full-suite run. A
        // diagnostic that rules out a cause it cannot rule out sends the next
        // reader hunting a pipeline bug that is not there.
        `waitForSourceId: '${sourceId}' never appeared in `
        + `${query.platform}/${query.slug} within ${timeoutMs} ms `
        + `(${seen} record(s) indexed). Either the collection pipeline did not `
        + 'deliver it, or this run was starved of scheduling — the count above '
        + 'distinguishes them: 0 with a healthy pipeline means the event never '
        + 'arrived.',
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('Phase D e2e — file collection', () => {
  it('indexes an existing file + emits a warehouse event', async () => {
    w = await mkWorld();
    writeFileSync(join(w.watchedDir, 'hello.txt'), 'full text contents');

    const deps: CollectionHandlerDeps = { registry: w.registry };
    const rec = await waitForSourceId(deps, { platform: 'file', slug: 'docs' }, 'hello.txt');
    expect(rec).toBeDefined();
    const fullRec = await handleCollectionGet(deps, { platform: 'file', slug: 'docs', record_id: rec!.record_id });
    expect(fullRec.record?.body_inline).toBe('full text contents');
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook collection — ingest + list + retention
// ────────────────────────────────────────────────────────────────

describe('Phase D e2e — webhook collection', () => {
  it('round-trips an ingest through list + get', async () => {
    w = await mkWorld();
    await w.webhookCollection.ingest({
      method: 'POST',
      body: Buffer.from(JSON.stringify({ action: 'opened', pr: 42 })),
      contentType: 'application/json',
      headersSubset: { 'x-github-event': 'pull_request' },
      query: {},
      remoteIp: '1.2.3.4',
      hmacHeader: null,
      hmacSecret: null,
    });

    const deps: CollectionHandlerDeps = { registry: w.registry };
    const list = await handleCollectionList(deps, { platform: 'webhook', slug: 'gh' });
    expect(list.records.length).toBe(1);
    const rec = list.records[0];
    expect(rec.hot_fields.method).toBe('POST');

    const full = await handleCollectionGet(deps, {
      platform: 'webhook', slug: 'gh', record_id: rec.record_id,
    });
    expect(full.record?.body_inline).toContain('"action":"opened"');
    expect((rec.hot_fields.headers_subset as any)?.['x-github-event']).toBe('pull_request');
  });

  it('runRetention is callable and respects retention_days', async () => {
    w = await mkWorld();
    const deps: CollectionHandlerDeps = { registry: w.registry };
    const res = await handleCollectionRunRetention(deps, {
      platform: 'webhook', slug: 'gh',
    });
    expect(typeof res.pruned).toBe('number');
    expect(typeof res.bytes_freed).toBe('number');
  });
});

// ────────────────────────────────────────────────────────────────
// Mail collection — stub provider + list + search
// ────────────────────────────────────────────────────────────────

describe('Phase D e2e — mail collection', () => {
  it('pushes a message through stub provider and finds it via search', async () => {
    w = await mkWorld();
    await w.mailStub.push({
      source_id: 'msg-1',
      from: 'alice@example.com',
      to: ['bob@example.com'],
      cc: [],
      subject: 'Q3 review',
      thread_id: 'T-1',
      folder_or_label: 'INBOX',
      is_read: false,
      is_flagged: false,
      has_attachments: false,
      received_at: Date.now(),
      body_text: 'planning notes for the quarter',
    });
    const deps: CollectionHandlerDeps = { registry: w.registry };
    const search = await handleCollectionSearch(deps, {
      platform: 'mail', slug: 'work', query: 'planning',
    });
    expect(search.matches.length).toBe(1);
    expect(search.matches[0].hot_fields.subject).toBe('Q3 review');

    const list = await handleCollectionList(deps, { platform: 'mail', slug: 'work' });
    expect(list.records.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Drain — dispose calls close on every adapter
// ────────────────────────────────────────────────────────────────

describe('Phase D e2e — drain', () => {
  it('registry.dispose cleanly closes every collection', async () => {
    w = await mkWorld();
    // Each collection's close() is idempotent so calling dispose
    // multiple times (once in the test, once in afterEach via w.close())
    // should not throw.
    await w.registry.dispose();
    await w.registry.dispose();
    // Second invocation is a no-op per the registry contract.
    expect(w.registry.list().length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Heartbeat health roll-up — aggregates per-adapter metrics
// ────────────────────────────────────────────────────────────────

describe('Phase D e2e — heartbeat roll-up', () => {
  it('listEndpoints returns live state per collection', async () => {
    w = await mkWorld();
    await w.mailStub.push({
      source_id: 'msg-1', from: 'a@x', to: ['b@x'], cc: [],
      subject: 's', thread_id: 't', folder_or_label: 'INBOX',
      is_read: false, has_attachments: false, received_at: Date.now(),
      is_flagged: false,
      body_text: 'x',
    });
    const deps: CollectionHandlerDeps = { registry: w.registry };
    const res = await handleCollectionListEndpoints(deps);
    expect(res.endpoints.length).toBe(3);
    for (const h of res.endpoints) {
      expect(typeof h.last_indexed_at).toBe('number');
      expect(typeof h.error_count_24h).toBe('number');
      expect(['connected', 'disconnected', 'syncing', 'idle', 'error']).toContain(h.state);
    }
  });
});
