/** Phase D (D-106) end-to-end integration — Commit 19.
 *
 *  Ties the full warehouse chain together:
 *    - Collection registry composition (file + mail-stub).
 *    - Real SQLite + CAS + FTS5 + gate registry underneath.
 *    - Kernel ingredient dispatch via `collection.*` rpcs.
 *    - Retention + drain pipelines.
 *    - Heartbeat envelope picks up collection health.
 *
 *  Mail runs against an in-process stub provider (Commits 13-15 have
 *  their own unit tests for IMAP/Gmail/Graph transport specifics).
 *  File is a folder Recued watches, through the file stack as the server
 *  composes it, over a real directory. (A webhook collection was a third
 *  member until it was removed 2026-10-10: nothing in production ever
 *  created one. Until the same day the file member was the Phase D
 *  `createFileCollection`, which nothing in production created either.)
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
import { composeFileStack, type FileStack } from '../collections/file/compose.js';
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
    mail: StorageGate;
  };
  mailStub: ReturnType<typeof makeStubProvider>;
  fileStack: FileStack;
  close(): Promise<void>;
}

const BIG_QUOTA = 128 * 1024 * 1024;

/** `seed` writes into the watched directory BEFORE any adapter starts, so a file
 *  is picked up by the initial directory walk rather than by a live `fs.watch`
 *  event. See the "existing file" test for why that distinction decides whether
 *  the test is deterministic. */
const mkWorld = async (opts: { seed?: (watchedDir: string) => void } = {}): Promise<World> => {
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
    mail: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' }),
  };

  const registry = createCollectionRegistry();

  // The folder's collection is registered by the stack when it starts.
  const fileStack = composeFileStack(db);
  fileStack.attachWatchedFolders({
    registry, bus, gates: { get: () => gates.file, release: () => {} },
  });
  fileStack.instances.upsert({
    platform: 'file', slug: 'docs', adapter_type: 'fs', config: { path: watchedDir },
    caps: {
      read: 'yes', write: 'yes', delete: 'yes', watch: 'realtime',
      mirror: 'optional', auth: 'none', path_style: 'posix',
    },
    auth_state: 'healthy', last_synced_at: null,
  });

  const mailStub = makeStubProvider('work');
  const mailColl = createMailCollection({
    db, blobs, gate: gates.mail, bus, slug: 'work',
    provider: mailStub.provider,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA }),
  });
  registry.register(mailColl);

  // ⛔ BEFORE THE FILE STACK STARTS, DELIBERATELY. A file seeded here is found
  // by the initial directory walk, which `startAll()` awaits; a file written
  // after start is found only if the OS delivers an `fs.watch` event.
  opts.seed?.(watchedDir);

  // The file stack walks the folder; the mail provider stands up its stub
  // callback.
  await fileStack.startAll();
  for (const c of registry.list()) {
    await c.sync.start();
  }
  // ⛔ NO SLEEP HERE, AND NONE IS NEEDED. `startAll()` is already the barrier:
  // it starts each adapter and awaits it, and the fs adapter's `start()`
  // resolves only after the initial directory walk completes and the watch is
  // attached. The 30 ms tick that used to sit here described a guarantee it did
  // not provide and the loop above already had — a barrier made of hope beside
  // a real one.

  return {
    dir: base, watchedDir, db, blobs, bus, events, registry, gates, mailStub, fileStack,
    async close() {
      await registry.dispose();
      await fileStack.disposeAll();
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
  it('registers two collections and lists them via listEndpoints', async () => {
    w = await mkWorld();
    const deps: CollectionHandlerDeps = { registry: w.registry };
    const res = await handleCollectionListEndpoints(deps);
    const slugs = res.endpoints.map((h) => `${h.platform}:${h.slug}`).sort();
    expect(slugs).toEqual(['file:docs', 'mail:work']);
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
  // ⛔ 60s, BECAUSE `waitForSourceId` ASKS FOR 45 AND THE SUITE ALLOWS 30.
  // `vitest.config.ts` sets `testTimeout: 30_000`, so the helper's deliberately
  // generous 45s deadline was unreachable: vitest killed the test at 30,010 ms
  // and reported an opaque timeout instead of the helper's own message naming
  // the source id that never appeared. The budget was a lie and the diagnostic
  // was lost with it. Measured under a full-suite run 2026-08-31. Paid only on a
  // genuine failure — the poll returns the moment the record lands (~500 ms).
  it('indexes an existing file + emits a warehouse event', async () => {
    // ⛔⛔ SEEDED BEFORE START, WHICH IS WHAT "EXISTING" MEANS. Writing the file
    // AFTER `sync.start()` made this test depend on a live `fs.watch` event, and
    // an OS watch event is LOSSY under load: in a full-suite run it failed with
    // `0 record(s) indexed` after polling 45s — zero for 45 seconds is an event
    // that never arrived, not a slow one, and no timeout can fix that. Seeding
    // first routes it through the initial directory walk, which `start()`
    // genuinely awaits, so the record exists before the first poll.
    //
    // 🔑 NO COVERAGE IS LOST. The watch path has its own dedicated test —
    // `watched-folders.test.ts` "with a live watch, a file written later lands" —
    // which is where a lossy-event dependency belongs, named for what it tests.
    w = await mkWorld({
      seed: (dir) => { writeFileSync(join(dir, 'hello.txt'), 'full text contents'); },
    });

    const deps: CollectionHandlerDeps = { registry: w.registry };
    const rec = await waitForSourceId(deps, { platform: 'file', slug: 'docs' }, 'hello.txt');
    expect(rec).toBeDefined();
    const fullRec = await handleCollectionGet(deps, { platform: 'file', slug: 'docs', record_id: rec!.record_id });
    expect(fullRec.record?.body_inline).toBe('full text contents');
    expect(
      w.events.filter((e) => e.platform === 'file' && e.record_id === rec!.record_id).map((e) => e.event_kind),
      'the walk announced it',
    ).toEqual(['created']);
  }, 60_000);
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

  it('runRetention is callable through the handler', async () => {
    w = await mkWorld();
    const deps: CollectionHandlerDeps = { registry: w.registry };
    const res = await handleCollectionRunRetention(deps, {
      platform: 'mail', slug: 'work',
    });
    expect(typeof res.pruned).toBe('number');
    expect(typeof res.bytes_freed).toBe('number');
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
    expect(res.endpoints.length).toBe(2);
    for (const h of res.endpoints) {
      expect(typeof h.last_indexed_at).toBe('number');
      expect(typeof h.error_count_24h).toBe('number');
      expect(['connected', 'disconnected', 'syncing', 'idle', 'error']).toContain(h.state);
    }
  });
});
