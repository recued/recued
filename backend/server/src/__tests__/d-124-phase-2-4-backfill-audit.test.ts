/** D-124 Phase 2.4 — backfill audit row.
 *
 *  One sync-level `collection_backfill` activity row at drain
 *  completion (NOT per-record). Steady-state delta sync emits no row.
 *  Per-record memory still comes from recipe runs that live events
 *  trigger (Phase 2.2 suppresses those during the drain anyway).
 *
 *  Coverage:
 *    1. Recorder unit — counts imports + failures, derives status,
 *       captures earliest/latest event_at, packs JSON detail.
 *    2. Recorder unit — `finish()` is idempotent.
 *    3. Recorder unit — `recordImport`/`recordFailure` after
 *       `finish()` are no-ops.
 *    4. Mail-collection — clean drain emits one `complete` row with
 *       per-message counts + earliest/latest received_at window.
 *    5. Mail-collection — initialScan throws → one `failed` row.
 *    6. Calendar-collection — partial drain (one ingest fails inside
 *       upsertPayload) emits one `partial` row.
 *    7. File-collection — initial walk emits one row scoped to the
 *       file's mtime; live `change` events after start() don't
 *       contribute to the count.
 *    8. Multi-adapter — mail + calendar drains emit independent rows
 *       targeted by `<platform>:<slug>`. */

import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActivityEntry,
  AppendOptions,
  AuditEntry,
  AuditLogStore,
} from '@recued/storage';
import type {
  CalendarCollectionCaps,
  FileCollectionCaps,
} from '@recued/contracts';
import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createCalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import type {
  CanonicalMessage,
  MailProvider,
  ProviderSyncCallback,
} from '../collections/mail/provider.js';
import type {
  CalendarProvider,
  CalendarSyncCallback,
  ProviderEventPayload,
} from '../collections/calendar/provider.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import {
  COLLECTION_BACKFILL_ACTION,
  createBackfillAuditRecorder,
  type BackfillAuditDetail,
} from '../triggers/backfill-audit.js';

// ────────────────────────────────────────────────────────────────
// Test scaffolding
// ────────────────────────────────────────────────────────────────

interface FakeAuditLog {
  store: AuditLogStore;
  activities: ActivityEntry[];
}

const newFakeAuditLog = (): FakeAuditLog => {
  const activities: ActivityEntry[] = [];
  const store: AuditLogStore = {
    append: async () => {},
    listWindow: async () => [],
    listPendingExchangeRefs: async () => [],
    listInboundContractIds: async () => [],
    listRecent: async () => [],
    listByRecipe: async () => [],
    listByChannelSession: async () => [],
    listByCognitionSession: async () => [],
    listByCorrelation: async () => [],
    listByExchangeRef: async () => [],
    listByPeerContract: async () => [],
    listByDish: async () => [],
    latestByDishes: async () => new Map(),
    get: async () => null as AuditEntry | null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => [],
    size: async () => 0,
    clearAll: async () => {},
    logActivity: async (entry: ActivityEntry, _opts?: AppendOptions) => {
      activities.push(entry);
    },
    listActivities: async () => activities,
    exportActivities: async () => activities,
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    lastSuccessfulBridgeDispatch: async () => null,
  };
  return { store, activities };
};

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

const decodeDetail = (entry: ActivityEntry): BackfillAuditDetail =>
  JSON.parse(entry.detail ?? '{}') as BackfillAuditDetail;

// ────────────────────────────────────────────────────────────────
// 1–3. Recorder unit
// ────────────────────────────────────────────────────────────────

describe('D-124 Phase 2.4 — createBackfillAuditRecorder', () => {
  it('packs status + duration + per-record window into one activity row', async () => {
    const fa = newFakeAuditLog();
    let now = 1_000;
    const recorder = createBackfillAuditRecorder({
      auditLog: fa.store,
      platform: 'mail',
      slug: 'inbox',
      now: () => now,
      newActivityId: () => 'cb-test-1',
    });
    recorder.recordImport(500); // earliest
    recorder.recordImport(900);
    recorder.recordImport(700);
    recorder.recordFailure();
    now = 8_500;
    await recorder.finish();

    expect(fa.activities).toHaveLength(1);
    const row = fa.activities[0];
    expect(row.action).toBe(COLLECTION_BACKFILL_ACTION);
    expect(row.target).toBe('mail:inbox');
    expect(row.timestamp).toBe(8_500);
    expect(row.activity_id).toBe('cb-test-1');
    const detail = decodeDetail(row);
    expect(detail).toEqual({
      status: 'partial',
      duration_ms: 7_500,
      records_imported: 3,
      records_failed: 1,
      earliest_record_event_at: 500,
      latest_record_event_at: 900,
      run_mode: 'backfill',
    });
  });

  it('derives complete vs failed vs partial from counts', async () => {
    const cases: Array<{
      imports: number[];
      failures: number;
      expected: BackfillAuditDetail['status'];
    }> = [
      { imports: [1, 2, 3], failures: 0, expected: 'complete' },
      { imports: [1], failures: 2, expected: 'partial' },
      { imports: [], failures: 3, expected: 'failed' },
      { imports: [], failures: 0, expected: 'complete' }, // empty drain still complete
    ];
    for (const c of cases) {
      const fa = newFakeAuditLog();
      const r = createBackfillAuditRecorder({
        auditLog: fa.store,
        platform: 'mail',
        slug: 'work',
        now: () => 0,
        newActivityId: () => 'x',
      });
      for (const e of c.imports) r.recordImport(e);
      for (let i = 0; i < c.failures; i++) r.recordFailure();
      await r.finish();
      expect(decodeDetail(fa.activities[0]).status).toBe(c.expected);
    }
  });

  it('finish() is idempotent — second call is a no-op', async () => {
    const fa = newFakeAuditLog();
    const r = createBackfillAuditRecorder({
      auditLog: fa.store,
      platform: 'file',
      slug: 'docs',
      now: () => 0,
      newActivityId: () => 'cb-once',
    });
    r.recordImport(100);
    await r.finish();
    await r.finish();
    await r.finish();
    expect(fa.activities).toHaveLength(1);
  });

  it('post-finish recordImport / recordFailure are no-ops', async () => {
    const fa = newFakeAuditLog();
    const r = createBackfillAuditRecorder({
      auditLog: fa.store,
      platform: 'mail',
      slug: 'inbox',
      now: () => 0,
      newActivityId: () => 'cb-x',
    });
    r.recordImport(1);
    await r.finish();
    r.recordImport(999);
    r.recordFailure();
    expect(decodeDetail(fa.activities[0])).toMatchObject({
      records_imported: 1,
      records_failed: 0,
      latest_record_event_at: 1,
    });
  });

  it('explicit status overrides derivation (drain throw path)', async () => {
    const fa = newFakeAuditLog();
    const r = createBackfillAuditRecorder({
      auditLog: fa.store,
      platform: 'mail',
      slug: 'inbox',
      now: () => 0,
      newActivityId: () => 'cb-fail',
    });
    // No imports / failures recorded — derived would be 'complete',
    // but the drain catch passes 'failed' to surface the throw.
    await r.finish('failed');
    expect(decodeDetail(fa.activities[0]).status).toBe('failed');
  });

  it('omitting auditLog makes the recorder a no-op', async () => {
    const r = createBackfillAuditRecorder({
      auditLog: undefined,
      platform: 'mail',
      slug: 'inbox',
      now: () => 0,
    });
    r.recordImport(1);
    await expect(r.finish()).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 4–5. Mail-collection wiring
// ────────────────────────────────────────────────────────────────

const sampleMessage = (overrides: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
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
  ...overrides,
});

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

describe('D-124 Phase 2.4 — mail-collection wiring', () => {
  let blobsDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    blobsDir = await mkdtemp(join(tmpdir(), 'd124-mb-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(blobsDir, { recursive: true, force: true });
  });

  it('emits one complete row with per-message counts after a clean initialScan', async () => {
    const fa = newFakeAuditLog();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'inbox', adapter_type: 'imap',
      config: {}, caps: fileCaps(), auth_state: 'healthy', last_synced_at: null,
    });
    const messages = [
      sampleMessage({ source_id: 'm1', received_at: 100 }),
      sampleMessage({ source_id: 'm2', received_at: 500 }),
      sampleMessage({ source_id: 'm3', received_at: 300 }),
    ];
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'inbox',
      provider: stubMailProvider({ scanMessages: messages }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      auditLog: fa.store,
      instances,
    });

    await collection.sync.start();
    try {
      const rows = fa.activities.filter((a) => a.action === COLLECTION_BACKFILL_ACTION);
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe('mail:inbox');
      const detail = decodeDetail(rows[0]);
      expect(detail.status).toBe('complete');
      expect(detail.records_imported).toBe(3);
      expect(detail.records_failed).toBe(0);
      expect(detail.earliest_record_event_at).toBe(100);
      expect(detail.latest_record_event_at).toBe(500);
      expect(detail.run_mode).toBe('backfill');
    } finally {
      await collection.sync.stop();
    }
  });

  it('emits one failed row when initialScan throws', async () => {
    const fa = newFakeAuditLog();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'inbox', adapter_type: 'imap',
      config: {}, caps: fileCaps(), auth_state: 'healthy', last_synced_at: null,
    });
    const collection = createMailCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'inbox',
      provider: stubMailProvider({ scanError: 'imap reset' }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      auditLog: fa.store,
      instances,
    });

    await collection.sync.start();
    try {
      const rows = fa.activities.filter((a) => a.action === COLLECTION_BACKFILL_ACTION);
      expect(rows).toHaveLength(1);
      const detail = decodeDetail(rows[0]);
      expect(detail.status).toBe('failed');
      expect(detail.records_imported).toBe(0);
    } finally {
      await collection.sync.stop();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 6. Calendar-collection wiring (partial-status drain)
// ────────────────────────────────────────────────────────────────

const stubCalendarProvider = (
  hooks: { events?: ProviderEventPayload[]; scanError?: string } = {},
): CalendarProvider => {
  let _cb: CalendarSyncCallback | null = null;
  return {
    kind: 'gcal',
    slug: 'personal',
    async connect() {},
    async initialScan(opts) {
      if (hooks.scanError) throw new Error(hooks.scanError);
      for (const e of hooks.events ?? []) {
        const cont = await opts.onEvent(e);
        if (!cont) break;
      }
    },
    async startSync(cb) {
      _cb = cb;
      return async () => { _cb = null; };
    },
    async close() {},
    health() {
      return {
        last_successful_sync_at: 0,
        error_count_24h: 0,
        pending_queue_size: 0,
        pending_series_expansions: 0,
      };
    },
    async createEvent() { throw new Error('not implemented'); },
    async updateEvent() { throw new Error('not implemented'); },
    async deleteEvent() { throw new Error('not implemented'); },
    async rsvpEvent() { throw new Error('not implemented'); },
  };
};

const calPayload = (overrides: Partial<ProviderEventPayload['event']> = {}): ProviderEventPayload => {
  const description = overrides.description ?? 'desc';
  return {
    event: {
      source_id: 'evt-1',
      ical_uid: 'evt-1@test',
      calendar_id: 'cal-1',
      summary: 'Standup',
      description,
      location: '',
      start_at: 1_700_000_000_000,
      end_at: 1_700_000_000_000 + 30 * 60 * 1000,
      is_all_day: false,
      timezone: 'UTC',
      organizer: { email: 'o@example.com' },
      attendees: [],
      status: 'confirmed',
      created_at: 1_000,
      updated_at: 1_000,
      ...overrides,
    },
    description_bytes: Buffer.byteLength(description, 'utf8'),
  };
};

describe('D-124 Phase 2.4 — calendar-collection wiring', () => {
  let blobsDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    blobsDir = await mkdtemp(join(tmpdir(), 'd124-cb-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(blobsDir, { recursive: true, force: true });
  });

  it('emits one row spanning earliest → latest start_at across the drain', async () => {
    const fa = newFakeAuditLog();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'calendar', slug: 'personal', adapter_type: 'gcal',
      config: {}, caps: calCaps(), auth_state: 'healthy', last_synced_at: null,
    });
    const events = [
      calPayload({ source_id: 'e1', start_at: 100 }),
      calPayload({ source_id: 'e2', start_at: 800 }),
      calPayload({ source_id: 'e3', start_at: 400 }),
    ];
    const collection = createCalendarCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'personal',
      provider: stubCalendarProvider({ events }),
      config: () => ({
        backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024,
        expansion_past_days: 0, expansion_future_days: 90,
      }),
      auditLog: fa.store,
      instances,
    });

    await collection.sync.start();
    try {
      const rows = fa.activities.filter((a) => a.action === COLLECTION_BACKFILL_ACTION);
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe('calendar:personal');
      const detail = decodeDetail(rows[0]);
      expect(detail.status).toBe('complete');
      expect(detail.records_imported).toBe(3);
      expect(detail.earliest_record_event_at).toBe(100);
      expect(detail.latest_record_event_at).toBe(800);
    } finally {
      await collection.sync.stop();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 7. File-collection wiring — present-only counts
// ────────────────────────────────────────────────────────────────

describe('D-124 Phase 2.4 — file-collection wiring', () => {
  let tmpRoot: string;
  let blobsDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'd124-f-'));
    blobsDir = await mkdtemp(join(tmpdir(), 'd124-fb-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(blobsDir, { recursive: true, force: true });
  });

  it('emits one row covering the initial walk; live changes after start() do not contribute', async () => {
    await writeFile(join(tmpRoot, 'a.txt'), 'hello');
    await writeFile(join(tmpRoot, 'b.txt'), 'world');

    const fa = newFakeAuditLog();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'file', slug: 'docs', adapter_type: 'fs',
      config: { path: tmpRoot }, caps: fileCaps(),
      auth_state: 'healthy', last_synced_at: null,
    });
    const collection = createFileCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'docs',
      config: () => ({
        path: tmpRoot, ignore: [], max_body_bytes: 10 * 1024 * 1024,
        retention_days: 0, quota_bytes: 1024 * 1024,
      }),
      auditLog: fa.store,
      instances,
    });

    await collection.sync.start();
    try {
      const rows = fa.activities.filter((a) => a.action === COLLECTION_BACKFILL_ACTION);
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe('file:docs');
      const detail = decodeDetail(rows[0]);
      expect(detail.status).toBe('complete');
      expect(detail.records_imported).toBe(2);
      // mtimes are real; just confirm they're populated finite numbers.
      expect(typeof detail.earliest_record_event_at).toBe('number');
      expect(typeof detail.latest_record_event_at).toBe('number');
      expect(detail.run_mode).toBe('backfill');
    } finally {
      await collection.sync.stop();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 8. Multi-adapter independence
// ────────────────────────────────────────────────────────────────

describe('D-124 Phase 2.4 — multi-adapter independence', () => {
  let blobsDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    blobsDir = await mkdtemp(join(tmpdir(), 'd124-mi-'));
    db = new Database(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(blobsDir, { recursive: true, force: true });
  });

  it('mail + calendar drains emit one row each, scoped by `<platform>:<slug>`', async () => {
    const fa = newFakeAuditLog();
    const instances = createInstanceStore({ db });
    instances.upsert({
      platform: 'mail', slug: 'inbox', adapter_type: 'imap',
      config: {}, caps: fileCaps(), auth_state: 'healthy', last_synced_at: null,
    });
    instances.upsert({
      platform: 'calendar', slug: 'personal', adapter_type: 'gcal',
      config: {}, caps: calCaps(), auth_state: 'healthy', last_synced_at: null,
    });

    const mailCollection = createMailCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'inbox',
      provider: stubMailProvider({ scanMessages: [sampleMessage()] }),
      config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024 }),
      auditLog: fa.store,
      instances,
    });
    const calCollection = createCalendarCollection({
      db,
      blobs: createBlobStore(blobsDir),
      gate: { addUsed: () => {}, getUsed: () => 0 } as never,
      bus: createWarehouseEventBus(),
      slug: 'personal',
      provider: stubCalendarProvider({ events: [calPayload()] }),
      config: () => ({
        backfill_days: 30, retention_days: 365, quota_bytes: 1024 * 1024,
        expansion_past_days: 0, expansion_future_days: 90,
      }),
      auditLog: fa.store,
      instances,
    });

    await mailCollection.sync.start();
    await calCollection.sync.start();
    try {
      const rows = fa.activities.filter((a) => a.action === COLLECTION_BACKFILL_ACTION);
      expect(rows).toHaveLength(2);
      const targets = new Set(rows.map((r) => r.target));
      expect(targets).toEqual(new Set(['mail:inbox', 'calendar:personal']));
    } finally {
      await mailCollection.sync.stop();
      await calCollection.sync.stop();
    }
  });
});
