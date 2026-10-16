/** A calendar's `last_synced_at` — what Connections shows as synced — and the
 *  auth state a sync is evidence for.
 *
 *  ⛔ Nothing wrote it but the owner's Re-sync, so every calendar, empty or
 *  full, read "First sync pending" for good (live, 2026-10-15): the first
 *  import delivers nothing from an empty calendar, and a quiet poll delivers
 *  nothing at all. The collection now writes it when the first import
 *  completes and on each clean poll its provider reports, at most once a
 *  minute.
 *
 *  A sync that worked also makes the calendar healthy again, as mail's does,
 *  and a rejected credential marks it expired at once, so the healing can never
 *  leave a dead credential looking healthy. A transient failure changes
 *  nothing: a calendar's writes are refused while it is not healthy.
 */

import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { CalendarAdapterError, type CalendarCollectionCaps } from '@recued/contracts';

import { createBlobStore } from '../../../storage/blob-store.js';
import { createInstanceStore, type CollectionInstanceStore } from '../../instance-store.js';
import { createCalendarCollection, type CalendarCollection } from '../calendar-collection.js';
import type { CalendarProvider, CalendarSyncOutcome } from '../provider.js';

const BIG_QUOTA = 1024 * 1024 * 1024;
const T0 = Date.UTC(2026, 9, 15, 17, 0, 0);

const CAPS: CalendarCollectionCaps = {
  read: 'yes', list_calendars: 'yes', create_event: 'yes', update_event: 'yes', delete_event: 'yes',
  rsvp: 'yes', search: 'remote', watch: 'poll', auth: 'oauth', recurrence: 'server',
};

const rejected = () => new CalendarAdapterError('auth_expired', 'graph calendarView: 401 — credentials rejected');

interface Harness {
  collection: CalendarCollection;
  instances: CollectionInstanceStore;
  /** Report one poll's outcome, as the provider's poll tick does. */
  poll(outcome: CalendarSyncOutcome): void;
  close(): Promise<void>;
}

const harness = (opts: { connect?: Error; initialScan?: Error } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-sync-clock-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 't.db'));
  db.pragma('journal_mode = WAL');
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'calendar', slug: 'work', adapter_type: 'graph', config: {}, caps: CAPS,
    auth_state: 'healthy', last_synced_at: null,
  });
  const listeners = new Set<(outcome: CalendarSyncOutcome) => void>();
  const provider: CalendarProvider = {
    kind: 'graph',
    slug: 'work',
    async connect() { if (opts.connect) throw opts.connect; },
    async initialScan() { if (opts.initialScan) throw opts.initialScan; },
    async startSync() { return async () => {}; },
    async close() {},
    health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0, pending_series_expansions: 0 }),
    onSyncOutcome(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async createEvent() { throw new Error('not used'); },
    async updateEvent() { throw new Error('not used'); },
    async deleteEvent() { throw new Error('not used'); },
    async rsvpEvent() { throw new Error('not used'); },
  };
  const collection = createCalendarCollection({
    db,
    blobs: createBlobStore(join(dataDir, 'blobs')),
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:calendar:work' }),
    bus: createWarehouseEventBus(),
    slug: 'work',
    provider,
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA, expansion_past_days: 30, expansion_future_days: 90 }),
    instances,
    now: () => T0,
  });
  return {
    collection,
    instances,
    poll: (outcome) => { for (const listener of listeners) listener(outcome); },
    async close() {
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const row = (h: Harness) => h.instances.get('calendar', 'work')!;

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe("a calendar's sync time", () => {
  it('⛔ an empty calendar records it when its first import completes', async () => {
    h = harness();
    expect(row(h).last_synced_at).toBeNull();
    await h.collection.sync.start();
    expect(row(h)).toMatchObject({ auth_state: 'healthy', last_synced_at: T0 });
  });

  it('a poll that finds nothing moves it, at most once a minute', async () => {
    h = harness();
    await h.collection.sync.start();
    h.poll({ ok: true, at: T0 + 30_000 });
    expect(row(h).last_synced_at).toBe(T0);
    h.poll({ ok: true, at: T0 + 61_000 });
    expect(row(h).last_synced_at).toBe(T0 + 61_000);
  });

  it('a first import that fails records nothing', async () => {
    h = harness({ initialScan: new Error('scan failed') });
    await h.collection.sync.start();
    expect(row(h)).toMatchObject({ auth_state: 'healthy', last_synced_at: null });
  });

  it('a closed collection records nothing more', async () => {
    h = harness();
    await h.collection.sync.start();
    await h.collection.close();
    h.poll({ ok: true, at: T0 + 120_000 });
    h.poll({ ok: false, failure: 'auth', at: T0 + 180_000 });
    expect(row(h)).toMatchObject({ auth_state: 'healthy', last_synced_at: T0 });
  });
});

describe("a sync is the calendar's credential's evidence", () => {
  it('a sync makes a stale expired calendar healthy again, as mail’s does', async () => {
    h = harness();
    h.instances.updateAuthState('calendar', 'work', { auth_state: 'expired' });
    await h.collection.sync.start();
    expect(row(h)).toMatchObject({ auth_state: 'healthy', last_synced_at: T0 });
  });

  it('heals at once, though within the minute', async () => {
    h = harness();
    await h.collection.sync.start();
    // A Re-sync's probe failed after the first import.
    h.instances.updateAuthState('calendar', 'work', { auth_state: 'degraded' });
    h.poll({ ok: true, at: T0 + 20_000 });
    expect(row(h)).toMatchObject({ auth_state: 'healthy', last_synced_at: T0 + 20_000 });
  });

  it('⛔ a poll refused for its credential marks it expired at once, and the clock stays', async () => {
    // Else a calendar healed by a poll that still held a live access token
    // would look healthy after its refresh token had died.
    h = harness();
    await h.collection.sync.start();
    h.poll({ ok: false, failure: 'auth', at: T0 + 10_000 });
    expect(row(h)).toMatchObject({ auth_state: 'expired', last_synced_at: T0 });
  });

  it('a transient failure changes nothing: a calendar not healthy refuses every write', async () => {
    h = harness();
    await h.collection.sync.start();
    h.poll({ ok: false, failure: 'transient', at: T0 + 10_000 });
    expect(row(h)).toMatchObject({ auth_state: 'healthy', last_synced_at: T0 });
  });

  it('a connect refused for its credential marks it expired', async () => {
    h = harness({ connect: rejected() });
    await expect(h.collection.sync.start()).rejects.toMatchObject({ code: 'auth_expired' });
    expect(row(h)).toMatchObject({ auth_state: 'expired', last_synced_at: null });
  });

  it('a first import refused for its credential marks it expired', async () => {
    h = harness({ initialScan: rejected() });
    await h.collection.sync.start();
    expect(row(h)).toMatchObject({ auth_state: 'expired', last_synced_at: null });
  });
});
