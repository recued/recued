/** D-124 Phase 2.1 — backfill state + denormalization.
 *
 *  Covers the four moving pieces:
 *    1. `collection_instances.backfill_complete` column + idempotent
 *       schema migration (DEFAULT FALSE on insert; preserved on
 *       upsert-as-update).
 *    2. `markBackfillComplete` writer — idempotent UPDATE flipping
 *       the bool to TRUE.
 *    3. `createBackfillStateLookup` helper — reads through (a flip is
 *       seen at once; it no longer caches), draining-vs-vacuous platforms,
 *       `data.contact` AND across mail + calendar.
 *    4. Adapter-collection wiring sites — calling
 *       `markBackfillComplete` after `provider.initialScan`/
 *       `watcher.start` resolves cleanly.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CalendarCollectionCaps,
  FileCollectionCaps,
} from '@recued/contracts';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../collections/instance-store.js';
import { createBackfillStateLookup } from '../triggers/backfill-state.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import type {
  CanonicalMessage,
  MailProvider,
  ProviderSyncCallback,
} from '../collections/mail/provider.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';

const fileCaps = (): FileCollectionCaps => ({
  read: 'yes',
  write: 'yes',
  delete: 'yes',
  watch: 'realtime',
  mirror: 'optional',
  auth: 'none',
  path_style: 'posix',
});

const calCaps = (): CalendarCollectionCaps => ({
  read: 'yes',
  list_calendars: 'yes',
  create_event: 'yes',
  update_event: 'yes',
  delete_event: 'yes',
  rsvp: 'yes',
  search: 'remote',
  watch: 'poll',
  auth: 'oauth',
  recurrence: 'server',
});

// Mail rows currently store a FileCollectionCaps-shaped object on the
// `caps` column — the contracts union still lists FileCollectionCaps
// alongside calendar / service shapes only. Tests + production callers
// (mail enroll handlers) lean on the same shape.
const mailCaps = (): FileCollectionCaps => fileCaps();

// ────────────────────────────────────────────────────────────────
// instance-store column additions
// ────────────────────────────────────────────────────────────────

describe('instance-store: backfill_complete column', () => {
  let db: Database.Database;
  let store: CollectionInstanceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createInstanceStore({ db });
  });
  afterEach(() => db.close());

  it('inserts a row with backfill_complete=false by default', () => {
    const row = store.upsert({
      platform: 'file',
      slug: 'docs',
      adapter_type: 'fs',
      config: { path: '/tmp' },
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    expect(row.backfill_complete).toBe(false);
    const fetched = store.get('file', 'docs');
    expect(fetched?.backfill_complete).toBe(false);
  });

  it('markBackfillComplete flips the column to true', () => {
    store.upsert({
      platform: 'file',
      slug: 'docs',
      adapter_type: 'fs',
      config: {},
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const updated = store.markBackfillComplete('file', 'docs');
    expect(updated?.backfill_complete).toBe(true);
    expect(store.get('file', 'docs')?.backfill_complete).toBe(true);
  });

  it('markBackfillComplete is idempotent — second call no-ops the value', () => {
    store.upsert({
      platform: 'mail',
      slug: 'work',
      adapter_type: 'imap',
      config: {},
      caps: mailCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    store.markBackfillComplete('mail', 'work');
    const second = store.markBackfillComplete('mail', 'work');
    expect(second?.backfill_complete).toBe(true);
  });

  it('markBackfillComplete returns null when (platform, slug) is unknown', () => {
    expect(store.markBackfillComplete('file', 'never-enrolled')).toBeNull();
  });

  it('upsert-as-update PRESERVES backfill_complete (only markBackfill writes)', () => {
    store.upsert({
      platform: 'calendar',
      slug: 'personal',
      adapter_type: 'gcal',
      config: { backfill_days: 30 },
      caps: calCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    store.markBackfillComplete('calendar', 'personal');
    expect(store.get('calendar', 'personal')?.backfill_complete).toBe(true);

    // Routine reconfigure (e.g. enroll handler upsert path on probe
    // refresh) — bool must NOT reset.
    store.upsert({
      platform: 'calendar',
      slug: 'personal',
      adapter_type: 'gcal',
      config: { backfill_days: 365 },
      caps: calCaps(),
      auth_state: 'healthy',
      last_synced_at: 1_700_000_000_000,
    });
    expect(store.get('calendar', 'personal')?.backfill_complete).toBe(true);
  });

  it('migrates pre-D-124 DBs idempotently (ALTER TABLE adds the column)', () => {
    // Simulate a pre-D-124 schema: drop the new column, then re-init.
    const fresh = new Database(':memory:');
    fresh.exec(`
      CREATE TABLE collection_instances (
        platform        TEXT NOT NULL,
        slug            TEXT NOT NULL,
        adapter_type    TEXT NOT NULL,
        config_json     TEXT NOT NULL,
        caps_json       TEXT NOT NULL,
        auth_state      TEXT NOT NULL,
        last_synced_at  INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (platform, slug)
      );
    `);
    fresh
      .prepare(
        `INSERT INTO collection_instances (
           platform, slug, adapter_type,
           config_json, caps_json,
           auth_state, last_synced_at, created_at, updated_at
         ) VALUES ('file', 'legacy', 'fs', '{}', '{}', 'healthy', NULL, 1, 2)`,
      )
      .run();

    // First call to createInstanceStore against the legacy schema
    // should run the ALTER and surface a backfill_complete=false on
    // the legacy row.
    const upgraded = createInstanceStore({ db: fresh });
    const legacy = upgraded.get('file', 'legacy');
    expect(legacy?.backfill_complete).toBe(false);

    // Second createInstanceStore on the same db is a no-op (PRAGMA
    // table_info already shows the column).
    expect(() => createInstanceStore({ db: fresh })).not.toThrow();
    fresh.close();
  });
});

// ────────────────────────────────────────────────────────────────
// backfill-state lookup helper
// ────────────────────────────────────────────────────────────────

describe('createBackfillStateLookup', () => {
  let db: Database.Database;
  let instances: CollectionInstanceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    instances = createInstanceStore({ db });
  });
  afterEach(() => db.close());

  it('returns false for a draining platform whose row is mid-drain', () => {
    instances.upsert({
      platform: 'mail',
      slug: 'inbox',
      adapter_type: 'imap',
      config: {},
      caps: mailCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const lookup = createBackfillStateLookup({ instances });
    expect(lookup.isComplete('mail', 'inbox')).toBe(false);
  });

  it('returns true once the adapter has flipped the bool', () => {
    instances.upsert({
      platform: 'calendar',
      slug: 'personal',
      adapter_type: 'gcal',
      config: {},
      caps: calCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const lookup = createBackfillStateLookup({ instances });
    expect(lookup.isComplete('calendar', 'personal')).toBe(false);
    instances.markBackfillComplete('calendar', 'personal');
    expect(lookup.isComplete('calendar', 'personal')).toBe(true);
  });

  it('⛔ reads through — a flip is seen at once, and a mailbox enrolled again drains again', () => {
    // It used to CACHE: the first read of a drain pinned `false`, and nothing
    // in production ever invalidated it, so a new mailbox's triggers stayed
    // silent until a restart. Both halves here were wrong under the cache.
    const row = {
      platform: 'mail' as const,
      slug: 'work',
      adapter_type: 'gmail',
      config: {},
      caps: mailCaps(),
      auth_state: 'healthy' as const,
      last_synced_at: null,
    };
    instances.upsert(row);
    const lookup = createBackfillStateLookup({ instances });
    expect(lookup.isComplete('mail', 'work')).toBe(false);
    instances.markBackfillComplete('mail', 'work');
    expect(lookup.isComplete('mail', 'work')).toBe(true);
    // Deleted and enrolled again: a fresh drain, which must not fire triggers.
    instances.delete('mail', 'work');
    instances.upsert(row);
    expect(lookup.isComplete('mail', 'work')).toBe(false);
  });

  it('returns true for unknown (platform, slug) — opt-in suppression by row presence', () => {
    const lookup = createBackfillStateLookup({ instances });
    // No rows enrolled — events for arbitrary platform/slug shouldn't
    // be suppressed by the helper.
    expect(lookup.isComplete('file', 'never-existed')).toBe(true);
  });

  it('webhook + service rows are vacuously backfill_complete', () => {
    instances.upsert({
      platform: 'webhook',
      slug: 'github-deliveries',
      adapter_type: 'webhook',
      config: {},
      caps: { read: 'yes', write: 'no', delete: 'no' } as never,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    instances.upsert({
      platform: 'service',
      slug: 'slack-team',
      adapter_type: 'slack',
      config: {},
      caps: {} as never,
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const lookup = createBackfillStateLookup({ instances });
    expect(lookup.isComplete('webhook', 'github-deliveries')).toBe(true);
    expect(lookup.isComplete('service', 'slack-team')).toBe(true);
  });

  it('contact derivation: vacuous-true with no mail/calendar feeders', () => {
    const lookup = createBackfillStateLookup({ instances });
    expect(lookup.isComplete('contact', 'any-slug')).toBe(true);
  });

  it('contact derivation: AND across mail + calendar feeders', () => {
    instances.upsert({
      platform: 'mail',
      slug: 'inbox',
      adapter_type: 'imap',
      config: {},
      caps: mailCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    instances.upsert({
      platform: 'calendar',
      slug: 'personal',
      adapter_type: 'gcal',
      config: {},
      caps: calCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const lookup = createBackfillStateLookup({ instances });

    // Both mid-drain → contact also incomplete.
    expect(lookup.isComplete('contact', 'any-slug')).toBe(false);

    // Only mail done → still incomplete.
    instances.markBackfillComplete('mail', 'inbox');
    expect(lookup.isComplete('contact', 'any-slug')).toBe(false);

    // Both done → contact derives true.
    instances.markBackfillComplete('calendar', 'personal');
    expect(lookup.isComplete('contact', 'any-slug')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// adapter-collection wiring: createFileCollection flips the bool
// after watcher.start() resolves
// ────────────────────────────────────────────────────────────────

describe('file-collection: post-initial-walk wiring', () => {
  let tmpRoot: string;
  let db: Database.Database;
  let blobsDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'd124-fc-'));
    blobsDir = await mkdtemp(join(tmpdir(), 'd124-blobs-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(blobsDir, { recursive: true, force: true });
  });

  it('flips backfill_complete for the matching slug after sync.start() resolves', async () => {
    await writeFile(join(tmpRoot, 'a.txt'), 'hello');

    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'file',
      slug: 'docs',
      adapter_type: 'fs',
      config: { path: tmpRoot },
      caps: fileCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    expect(instances.get('file', 'docs')?.backfill_complete).toBe(false);

    const blobs = createBlobStore(blobsDir);
    const bus = createWarehouseEventBus();
    const collection = createFileCollection({
      db,
      blobs,
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus,
      slug: 'docs',
      config: () => ({
        path: tmpRoot,
        ignore: [],
        max_body_bytes: 10 * 1024 * 1024,
        retention_days: 0,
        quota_bytes: 1024 * 1024,
      }),
      instances,
    });

    await collection.sync.start();
    try {
      expect(instances.get('file', 'docs')?.backfill_complete).toBe(true);
    } finally {
      await collection.sync.stop();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// adapter-collection wiring: mail collection flips on success,
// stays false on initialScan failure
// ────────────────────────────────────────────────────────────────

const stubMailProvider = (
  hooks: { scanMessages?: CanonicalMessage[]; scanError?: string } = {},
): MailProvider => {
  let _cb: ProviderSyncCallback | null = null;
  return {
    kind: 'imap',
    slug: 'inbox',
    sendCapable: false,
    mutationCapable: false,
    accountEmail: '',
    async connect() {},
    async initialScan(opts) {
      if (hooks.scanError) throw new Error(hooks.scanError);
      for (const msg of hooks.scanMessages ?? []) {
        const cont = await opts.onMessage(msg);
        if (!cont) break;
      }
    },
    async startSync(cb) {
      _cb = cb;
      return async () => { _cb = null; };
    },
    async close() {},
    health() {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
  };
};

const sampleMessage = (): CanonicalMessage => ({
  source_id: 'msg-1',
  from: 'a@example.com',
  to: ['b@example.com'],
  cc: [],
  subject: 'hi',
  thread_id: 'T-1',
  folder_or_label: 'INBOX',
  is_read: false,
  is_flagged: false,
  has_attachments: false,
  received_at: 1_700_000_000_000,
  body_text: 'body',
});

describe('mail-collection: post-initialScan wiring', () => {
  let tmpRoot: string;
  let db: Database.Database;
  let blobsDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'd124-mc-'));
    blobsDir = await mkdtemp(join(tmpdir(), 'd124-mb-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(blobsDir, { recursive: true, force: true });
  });

  it('flips backfill_complete after a clean initialScan', async () => {
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail',
      slug: 'inbox',
      adapter_type: 'imap',
      config: {},
      caps: mailCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'inbox',
      provider: stubMailProvider({ scanMessages: [sampleMessage()] }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      instances,
    });

    expect(instances.get('mail', 'inbox')?.backfill_complete).toBe(false);
    await collection.sync.start();
    try {
      expect(instances.get('mail', 'inbox')?.backfill_complete).toBe(true);
    } finally {
      await collection.sync.stop();
    }
  });

  it('LEAVES backfill_complete=false when initialScan throws', async () => {
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail',
      slug: 'inbox',
      adapter_type: 'imap',
      config: {},
      caps: mailCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'inbox',
      provider: stubMailProvider({ scanError: 'imap connection reset' }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      instances,
    });

    await collection.sync.start();
    try {
      // initialScan threw → catch block runs → markBackfillComplete
      // not reached → bool stays false. Phase 2.2's suppression gate
      // therefore keeps trigger fan-out off until the next successful
      // drain (after restart / resync).
      expect(instances.get('mail', 'inbox')?.backfill_complete).toBe(false);
    } finally {
      await collection.sync.stop();
    }
  });
});
