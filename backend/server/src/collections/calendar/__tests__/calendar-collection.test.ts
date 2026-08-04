/** D-117 Phase 6 — calendar collection composition tests.
 *
 *  Covers the wiring between the table, the provider, and the
 *  warehouse event bus. The provider here is a stub that drives
 *  `initialScan` + `startSync` deterministically.
 */

import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';
import type { CalendarCollectionHealth, CanonicalEvent } from '@recued/contracts';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import {
  createCalendarCollection,
  type CalendarCollection,
  type CalendarCollectionConfig,
} from '../calendar-collection.js';
import type {
  CalendarProvider,
  CalendarSyncCallback,
  CalendarSyncEvent,
  CreateEventInput,
  DeleteEventInput,
  ProviderEventPayload,
  RsvpEventInput,
  UpdateEventInput,
} from '../provider.js';

const BIG_QUOTA = 1024 * 1024 * 1024;

const baseEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id: 'evt-1',
  ical_uid: 'uid-1',
  calendar_id: 'cal-1',
  summary: 'Standup',
  start_at: 1_700_000_000_000,
  end_at: 1_700_000_900_000,
  timezone: 'UTC',
  is_all_day: false,
  status: 'confirmed',
  created_at: 1_690_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

interface StubControl {
  initialEvents: ProviderEventPayload[];
  connectWait?: Promise<void>;
  connectCount: number;
  closeCount: number;
  connected: boolean;
  initialScanWait?: Promise<void>;
  pushSyncEvent: (event: CalendarSyncEvent) => Promise<void>;
  fail: { connect?: boolean; initialScan?: boolean; startSync?: boolean; close?: boolean };
  health: { last: number; errors: number; queue: number; pending: number };
}

const makeStubProvider = (control: StubControl): CalendarProvider => {
  let cb: CalendarSyncCallback | null = null;
  control.pushSyncEvent = async (event) => { if (cb) await cb(event); };
  return {
    kind: 'gcal',
    slug: 'work',
    async connect() {
      control.connectCount += 1;
      await control.connectWait;
      if (control.fail.connect) throw new Error('boom');
      control.connected = true;
    },
    async initialScan(opts) {
      if (control.fail.initialScan) throw new Error('scan boom');
      await control.initialScanWait;
      for (const payload of control.initialEvents) {
        const keep = await opts.onEvent(payload);
        if (!keep) break;
      }
    },
    async startSync(callback) {
      if (control.fail.startSync) throw new Error('start boom');
      cb = callback;
      return async () => { cb = null; };
    },
    async close() {
      control.closeCount += 1;
      control.connected = false;
      cb = null;
      if (control.fail.close) throw new Error('close boom');
    },
    health: () => ({
      last_successful_sync_at: control.health.last,
      error_count_24h: control.health.errors,
      pending_queue_size: control.health.queue,
      pending_series_expansions: control.health.pending,
    }),
    async createEvent(_calendar_id: string, _event: CreateEventInput): Promise<ProviderEventPayload> {
      return { event: baseEvent({ source_id: 'created' }), description_bytes: 0 };
    },
    async updateEvent(_input: UpdateEventInput): Promise<ProviderEventPayload> {
      return { event: baseEvent({ source_id: 'updated' }), description_bytes: 0 };
    },
    async deleteEvent(_input: DeleteEventInput): Promise<void> {/* no-op */},
    async rsvpEvent(_input: RsvpEventInput): Promise<ProviderEventPayload> {
      return { event: baseEvent({ source_id: 'rsvp' }), description_bytes: 0 };
    },
  };
};

interface Harness {
  dir: string;
  db: Database.Database;
  gate: StorageGate;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  events: WarehouseEvent[];
  control: StubControl;
  collection: CalendarCollection;
  close(): Promise<void>;
}

const newHarness = (
  configOverrides: Partial<CalendarCollectionConfig> = {},
  options: {
    failBlobPut?: boolean;
    blobPutGate?: { started(): void; wait: Promise<void> };
  } = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-collection-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 't.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:calendar:work' });
  const baseBlobs = createBlobStore(join(dataDir, 'blobs'));
  const blobs: BlobStore = options.failBlobPut || options.blobPutGate
    ? {
        ...baseBlobs,
        async put(bytes) {
          if (options.failBlobPut) throw new Error('blob store unavailable');
          options.blobPutGate?.started();
          await options.blobPutGate?.wait;
          return baseBlobs.put(bytes);
        },
      }
    : baseBlobs;
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (e) => { events.push(e); });
  const control: StubControl = {
    initialEvents: [],
    connectCount: 0,
    closeCount: 0,
    connected: false,
    pushSyncEvent: async () => {/* set by stub */},
    fail: {},
    health: { last: 0, errors: 0, queue: 0, pending: 0 },
  };
  const provider = makeStubProvider(control);
  const config: CalendarCollectionConfig = {
    backfill_days: 30,
    retention_days: 365,
    quota_bytes: BIG_QUOTA,
    expansion_past_days: 30,
    expansion_future_days: 90,
    ...configOverrides,
  };
  const collection = createCalendarCollection({
    db, blobs, gate, bus, slug: 'work',
    provider,
    config: () => config,
  });
  return {
    dir, db, gate, blobs, bus, events, control, collection,
    async close() {
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('CalendarCollection — initial scan', () => {
  it('connects, scans, persists each event, and emits warehouse events', async () => {
    h = newHarness();
    h.control.initialEvents = [
      { event: baseEvent({ source_id: 'a' }), description_bytes: 0 },
      { event: baseEvent({ source_id: 'b' }), description_bytes: 0 },
    ];
    await h.collection.sync.start();
    expect(h.collection.table.eventCount()).toBe(2);
    expect(h.events.filter((e) => e.event_kind === 'created')).toHaveLength(2);
    const health = h.collection.health() as CalendarCollectionHealth;
    expect(health.platform).toBe('calendar');
    expect(health.event_count).toBe(2);
  });

  it('continues to live sync even if initial scan throws', async () => {
    h = newHarness();
    h.control.fail.initialScan = true;
    await h.collection.sync.start();
    // Live sync still set up; pushing an event after start works.
    await h.control.pushSyncEvent({
      kind: 'created',
      source_id: 'live',
      payload: { event: baseEvent({ source_id: 'live' }), description_bytes: 0 },
    });
    expect(h.collection.table.eventCount()).toBe(1);
  });

  it('marks state error when connect fails and re-throws', async () => {
    h = newHarness();
    h.control.fail.connect = true;
    await expect(h.collection.sync.start()).rejects.toThrow('boom');
    expect(h.collection.health().state).toBe('error');
  });

  it('start is idempotent — second call coalesces', async () => {
    h = newHarness();
    await h.collection.sync.start();
    await h.collection.sync.start(); // should noop without throwing
  });

  it('close invalidates an in-flight initial scan before live sync starts', async () => {
    h = newHarness();
    let release!: () => void;
    h.control.initialScanWait = new Promise<void>((resolve) => { release = resolve; });
    const starting = h.collection.sync.start();
    await Promise.resolve();

    const closing = h.collection.close();
    release();
    await Promise.all([starting, closing]);
    await h.control.pushSyncEvent({
      kind: 'created',
      source_id: 'late',
      payload: { event: baseEvent({ source_id: 'late' }), description_bytes: 0 },
    });

    expect(h.collection.table.eventCount()).toBe(0);
    await h.collection.sync.start();
    expect(h.collection.table.eventCount()).toBe(0);
  });

  it('close seals a provider that finishes connecting after the first close', async () => {
    h = newHarness();
    let releaseConnect!: () => void;
    h.control.connectWait = new Promise<void>((resolve) => { releaseConnect = resolve; });

    const starting = h.collection.sync.start();
    expect(h.control.connectCount).toBe(1);
    const closing = h.collection.close();
    await Promise.resolve();
    expect(h.control.closeCount).toBe(1);

    releaseConnect();
    await Promise.all([starting, closing]);

    expect(h.control.connected).toBe(false);
    expect(h.control.closeCount).toBe(2);
  });

  it('close reports a provider teardown failure', async () => {
    h = newHarness();
    await h.collection.sync.start();
    h.control.fail.close = true;

    await expect(h.collection.close()).rejects.toThrow(/failed to stop/);

    h.control.fail.close = false;
  });
});

describe('CalendarCollection — live sync', () => {
  beforeEach(() => { h = newHarness(); });

  it('emits updated when an existing event is overwritten', async () => {
    h.control.initialEvents = [
      { event: baseEvent({ source_id: 'evt-1' }), description_bytes: 0 },
    ];
    await h.collection.sync.start();
    h.events.length = 0;
    await h.control.pushSyncEvent({
      kind: 'updated',
      source_id: 'evt-1',
      payload: { event: baseEvent({ source_id: 'evt-1', summary: 'Edited' }), description_bytes: 0 },
    });
    expect(h.events.find((e) => e.event_kind === 'updated')).toBeDefined();
    const snapshot = h.collection.table.get('evt-1');
    expect(snapshot?.event.summary).toBe('Edited');
  });

  it('emits deleted when an event drops out and removes the row', async () => {
    h.control.initialEvents = [
      { event: baseEvent({ source_id: 'evt-1' }), description_bytes: 0 },
    ];
    await h.collection.sync.start();
    h.events.length = 0;
    await h.control.pushSyncEvent({ kind: 'deleted', source_id: 'evt-1' });
    expect(h.events.find((e) => e.event_kind === 'deleted')).toBeDefined();
    expect(h.collection.table.get('evt-1')).toBeNull();
  });

  it('rejects a missing payload so the provider cannot acknowledge it', async () => {
    await h.collection.sync.start();
    await expect(h.control.pushSyncEvent({ kind: 'created', source_id: 'broken' }))
      .rejects.toThrow('missing its payload');
    expect(h.collection.health().error_count_24h).toBeGreaterThan(0);
  });

  it('rejects a live event when durable description storage fails', async () => {
    await h.close();
    h = newHarness({}, { failBlobPut: true });
    await h.collection.sync.start();
    const description = 'x'.repeat(70 * 1024);

    await expect(h.control.pushSyncEvent({
      kind: 'created',
      source_id: 'blob-failure',
      payload: {
        event: baseEvent({ source_id: 'blob-failure', description }),
        description_bytes: Buffer.byteLength(description, 'utf8'),
      },
    })).rejects.toThrow('blob store unavailable');

    expect(h.collection.table.get('blob-failure')).toBeNull();
    expect(h.collection.health().error_count_24h).toBeGreaterThan(0);
  });

  it('does not acknowledge a description write that outlives its sync generation', async () => {
    await h.close();
    let release!: () => void;
    let markStarted!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    h = newHarness({}, {
      blobPutGate: { started: markStarted, wait },
    });
    await h.collection.sync.start();
    const description = 'x'.repeat(70 * 1024);
    const delivering = h.control.pushSyncEvent({
      kind: 'created',
      source_id: 'stale-generation',
      payload: {
        event: baseEvent({ source_id: 'stale-generation', description }),
        description_bytes: Buffer.byteLength(description, 'utf8'),
      },
    });
    await started;

    await h.collection.sync.stop();
    release();

    await expect(delivering).rejects.toThrow('generation is no longer active');
    expect(h.collection.table.get('stale-generation')).toBeNull();
  });

  // D-124 Phase 1 — prev passthrough on updated/deleted.
  it('attaches prev hot-fields snapshot to updated events', async () => {
    h.control.initialEvents = [
      { event: baseEvent({ source_id: 'evt-1', summary: 'Original' }), description_bytes: 0 },
    ];
    await h.collection.sync.start();
    h.events.length = 0;
    await h.control.pushSyncEvent({
      kind: 'updated',
      source_id: 'evt-1',
      payload: {
        event: baseEvent({ source_id: 'evt-1', summary: 'Edited' }),
        description_bytes: 0,
      },
    });
    const updated = h.events.find((e) => e.event_kind === 'updated');
    expect(updated).toBeDefined();
    expect(updated?.prev).toBeDefined();
    // Prev is the calendar canonical hot fields — surfaces summary + start_at +
    // attendees etc. The exact full shape is collection-defined; what matters
    // here is that the *prior* summary survives onto `prev` so a recipe can
    // diff it against the current value.
    expect((updated?.prev as { summary?: string }).summary).toBe('Original');
  });

  it('attaches prev hot-fields snapshot to deleted events', async () => {
    h.control.initialEvents = [
      { event: baseEvent({ source_id: 'evt-1', summary: 'Cancelled meeting' }), description_bytes: 0 },
    ];
    await h.collection.sync.start();
    h.events.length = 0;
    await h.control.pushSyncEvent({ kind: 'deleted', source_id: 'evt-1' });
    const deleted = h.events.find((e) => e.event_kind === 'deleted');
    expect(deleted).toBeDefined();
    expect(deleted?.prev).toBeDefined();
    expect((deleted?.prev as { summary?: string }).summary).toBe('Cancelled meeting');
  });

  it('omits prev on created events', async () => {
    await h.collection.sync.start();
    h.control.initialEvents = [];
    await h.control.pushSyncEvent({
      kind: 'created',
      source_id: 'fresh',
      payload: { event: baseEvent({ source_id: 'fresh' }), description_bytes: 0 },
    });
    const created = h.events.find((e) => e.event_kind === 'created' && e.record_id.includes('fresh'));
    expect(created).toBeDefined();
    expect(created?.prev).toBeUndefined();
  });
});

describe('CalendarCollection — verified write-back hooks', () => {
  beforeEach(() => { h = newHarness(); });

  it('applyVerifiedUpsert writes through the table + emits created on first sight', async () => {
    await h.collection.applyVerifiedUpsert({
      event: baseEvent({ source_id: 'fresh' }),
      description_bytes: 0,
    });
    expect(h.collection.table.get('fresh')).not.toBeNull();
    expect(h.events.find((e) => e.event_kind === 'created' && e.record_id.includes('fresh'))).toBeDefined();
  });

  it('applyVerifiedDelete drops the row + emits deleted', async () => {
    await h.collection.applyVerifiedUpsert({
      event: baseEvent({ source_id: 'gone' }),
      description_bytes: 0,
    });
    h.events.length = 0;
    h.collection.applyVerifiedDelete('gone');
    expect(h.collection.table.get('gone')).toBeNull();
    expect(h.events.find((e) => e.event_kind === 'deleted')).toBeDefined();
  });

  it('large descriptions spill to CAS via blob_hash', async () => {
    const big = 'x'.repeat(70 * 1024);
    await h.collection.applyVerifiedUpsert({
      event: baseEvent({ source_id: 'big', description: big }),
      description_bytes: Buffer.byteLength(big, 'utf8'),
    });
    const snap = h.collection.table.get('big');
    expect(snap?.body_inline).toBeNull();
    expect(snap?.blob_hash).toBeTruthy();
  });
});

describe('CalendarCollection — generic collection.list / collection.get (D-198)', () => {
  beforeEach(() => { h = newHarness(); });

  it('list() projects warehouse events into CollectionRecords with display hot-fields', async () => {
    await h.collection.applyVerifiedUpsert({
      event: baseEvent({ source_id: 'evt-a', summary: 'Design review', start_at: 1_700_000_000_000, location: 'Room 42' }),
      description_bytes: 0,
    });
    const records = h.collection.list({ platform: 'calendar', slug: 'work' });
    expect(records).toHaveLength(1);
    const r = records[0]!;
    // The D-119 display schema reads summary / start_at / location off hot_fields.
    expect(r.hot_fields.summary).toBe('Design review');
    expect(r.hot_fields.start_at).toBe(1_700_000_000_000);
    expect(r.hot_fields.location).toBe('Room 42');
    expect(r.record_id).toMatch(/^cal:/);
    expect(r.source_id).toBe('evt-a');
  });

  it('get() resolves the SAME record_id list() returns (round-trip); bogus id → null', async () => {
    await h.collection.applyVerifiedUpsert({
      event: baseEvent({ source_id: 'evt-b', summary: 'Standup' }),
      description_bytes: 0,
    });
    const listed = h.collection.list({ platform: 'calendar', slug: 'work' })[0]!;
    const got = h.collection.get(listed.record_id);
    expect(got?.source_id).toBe('evt-b');
    expect(got?.hot_fields.summary).toBe('Standup');
    expect(h.collection.get('cal:nope')).toBeNull();
  });

  it('list() honors limit + most-recent-first (start_at desc) order', async () => {
    for (const [id, start] of [['old', 1_000], ['mid', 2_000], ['new', 3_000]] as const) {
      await h.collection.applyVerifiedUpsert({
        event: baseEvent({ source_id: id, start_at: start, updated_at: start }),
        description_bytes: 0,
      });
    }
    expect(h.collection.list({ platform: 'calendar', slug: 'work' }).map((r) => r.source_id)).toEqual(['new', 'mid', 'old']);
    const limited = h.collection.list({ platform: 'calendar', slug: 'work', limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0]!.source_id).toBe('new');
  });

  it('list() fails loud on since/until (received_at bounds it cannot honor)', async () => {
    await h.collection.applyVerifiedUpsert({
      event: baseEvent({ source_id: 'evt-c' }), description_bytes: 0,
    });
    // Silently dropping these would return wrong data for a received_at cursor.
    expect(() => h.collection.list({ platform: 'calendar', slug: 'work', since: 1 }))
      .toThrow(/since\/until/);
    expect(() => h.collection.list({ platform: 'calendar', slug: 'work', until: 2 }))
      .toThrow(/since\/until/);
    // Supported params still work.
    expect(h.collection.list({ platform: 'calendar', slug: 'work', limit: 1 })).toHaveLength(1);
  });
});

describe('CalendarCollection — health', () => {
  it('folds provider counters into the health snapshot', async () => {
    h = newHarness();
    h.control.health = { last: 5_000, errors: 2, queue: 1, pending: 3 };
    h.control.initialEvents = [
      { event: baseEvent({ source_id: 'evt-1', start_at: Date.now() + 60_000 }), description_bytes: 0 },
    ];
    await h.collection.sync.start();
    const health = h.collection.health() as CalendarCollectionHealth;
    expect(health.error_count_24h).toBeGreaterThanOrEqual(2);
    // pending_queue_size = provider.pending + provider.queue
    expect(health.pending_queue_size).toBe(4);
    expect(health.event_count).toBe(1);
    expect(health.upcoming_count_24h).toBe(1);
  });
});
