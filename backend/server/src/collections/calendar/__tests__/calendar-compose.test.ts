/** D-117 Phase 9 — composition + heartbeat + bin wiring tests.
 *
 *  Isolates `composeCalendarStack` against in-memory fakes for the
 *  provider + account store + warehouse bus. Exercises:
 *
 *    - kernel dispatchers resolve through the live collection map
 *    - calendar-watcher dispatch routes through the shared watcher slot
 *    - enrollDeps.onEnrolled spins up a live collection
 *    - enrollDeps.onDeleted tears one down
 *    - startAll() rehydrates every platform='calendar' row
 *    - disposeAll() closes every live collection
 *    - registerCalendarCollections mirrors live set into the shared
 *      registry (heartbeat picks them up via registry.list())
 *    - watcher cursor store survives reboot via the same DB instance
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWarehouseEventBus,
  type WarehouseEventBus,
} from '@recued/warehouse-events';
import type {
  CalendarCollectionCaps,
  CanonicalEvent,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';

import { createCollectionRegistry } from '../../registry.js';
import { createInstanceStore } from '../../instance-store.js';
import {
  composeCalendarStack,
  registerCalendarCollections,
  type CalendarStack,
} from '../compose.js';
import { handleCalendarWatcher } from '../calendar-watcher.js';
import type {
  CalendarAdapterContext,
  CalendarAdapterFactory,
} from '../adapter-registry.js';
import type {
  CalendarProvider,
  CreateEventInput,
  ProviderEventPayload,
} from '../provider.js';

const FULL_CAPS: CalendarCollectionCaps = {
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
};

const mkNoopGate = (): StorageGate =>
  ({
    addUsed: () => { /* no-op */ },
    setUsed: () => { /* no-op */ },
    info: () => ({ surface: 'test', used: 0, quota: 1_000_000, reservePct: 0, state: 'healthy' }),
  } as unknown as StorageGate);

interface FakeProviderHooks {
  connect: number;
  close: number;
  startSyncCount: number;
  stopSyncCount: number;
  factoryCreated: number;
  createCalls: CreateEventInput[];
}

const mkFakeProvider = (
  kind: 'gcal' | 'graph' | 'caldav',
  slug: string,
  hooks: FakeProviderHooks,
): CalendarProvider => ({
  kind,
  slug,
  async connect() { hooks.connect += 1; },
  async initialScan() { /* no-op */ },
  async startSync() {
    hooks.startSyncCount += 1;
    return async () => { hooks.stopSyncCount += 1; };
  },
  async close() { hooks.close += 1; },
  health: () => ({
    last_successful_sync_at: 0,
    error_count_24h: 0,
    pending_queue_size: 0,
    pending_series_expansions: 0,
  }),
  async createEvent(_calendar_id, event) {
    hooks.createCalls.push(event);
    const canonical: CanonicalEvent = {
      source_id: `created-${hooks.createCalls.length}`,
      ical_uid: `uid-${hooks.createCalls.length}@test`,
      calendar_id: 'primary',
      summary: event.summary ?? 'Untitled',
      start_at: event.start_at ?? 0,
      end_at: event.end_at ?? 0,
      timezone: event.timezone ?? 'UTC',
      is_all_day: event.is_all_day ?? false,
      status: event.status ?? 'confirmed',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    };
    return { event: canonical, description_bytes: 0 } as ProviderEventPayload;
  },
  async updateEvent() { throw new Error('not used'); },
  async deleteEvent() { /* no-op */ },
  async rsvpEvent() { throw new Error('not used'); },
});

const mkFactory = (
  kind: 'gcal' | 'graph' | 'caldav',
  hooks: FakeProviderHooks,
): CalendarAdapterFactory => ({
  kind,
  async probeCaps() { return FULL_CAPS; },
  create(ctx: CalendarAdapterContext): CalendarProvider {
    hooks.factoryCreated += 1;
    return mkFakeProvider(kind, ctx.slug, hooks);
  },
});

interface Harness {
  db: Database.Database;
  bus: WarehouseEventBus;
  stack: CalendarStack;
  hooks: FakeProviderHooks;
  cleanup: () => void;
}

const buildHarness = (opts: { isVaultUnlocked?: () => boolean } = {}): Harness => {
  const db = new Database(':memory:');
  const bus = createWarehouseEventBus();
  const hooks: FakeProviderHooks = {
    connect: 0, close: 0, startSyncCount: 0, stopSyncCount: 0,
    factoryCreated: 0, createCalls: [],
  };
  const stack = composeCalendarStack(
    db,
    {
      blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
      bus,
      getGate: () => mkNoopGate(),
    },
    {
      factories: [mkFactory('gcal', hooks), mkFactory('graph', hooks), mkFactory('caldav', hooks)],
      ...(opts.isVaultUnlocked ? { isVaultUnlocked: opts.isVaultUnlocked } : {}),
    },
  );
  const cleanup = () => { bus.dispose(); db.close(); };
  return { db, bus, stack, hooks, cleanup };
};

const enrollRow = (
  harness: Harness,
  slug: string,
  adapter: 'gcal' | 'graph' | 'caldav' = 'gcal',
) => {
  const store = createInstanceStore({ db: harness.db });
  return store.upsert({
    platform: 'calendar',
    slug,
    adapter_type: adapter,
    config: {},
    caps: FULL_CAPS,
    auth_state: 'healthy',
    last_synced_at: null,
  });
};

let harness: Harness;

beforeEach(() => { harness = buildHarness(); });
afterEach(() => harness.cleanup());

describe('composeCalendarStack — lifecycle', () => {
  it('startAll spins up a live collection per instance row', async () => {
    enrollRow(harness, 'work', 'gcal');
    enrollRow(harness, 'holidays', 'graph');
    expect(harness.stack.listLive()).toHaveLength(0);
    await harness.stack.startAll();
    const live = harness.stack.listLive();
    expect(live.map((c) => c.slug).sort()).toEqual(['holidays', 'work']);
    expect(harness.hooks.factoryCreated).toBe(2);
    expect(harness.hooks.connect).toBeGreaterThanOrEqual(1);
  });

  it('disposeAll closes every live collection', async () => {
    enrollRow(harness, 'work', 'caldav');
    await harness.stack.startAll();
    expect(harness.stack.listLive()).toHaveLength(1);
    await harness.stack.disposeAll();
    expect(harness.stack.listLive()).toHaveLength(0);
    expect(harness.hooks.close).toBe(1);
  });

  it('disposeAll is coalesced and permanently closes start/resume admission', async () => {
    enrollRow(harness, 'work', 'gcal');
    await harness.stack.startAll();
    const first = harness.stack.disposeAll();
    const second = harness.stack.disposeAll();
    expect(second).toBe(first);
    await first;

    const row = enrollRow(harness, 'late', 'gcal');
    await harness.stack.enrollDeps.onEnrolled?.({
      slug: row.slug,
      platform: 'calendar',
      adapter_type: row.adapter_type,
      caps: row.caps as CalendarCollectionCaps,
      auth_state: row.auth_state,
      last_synced_at: row.last_synced_at,
    });
    await harness.stack.startAll();
    await harness.stack.resumeSync();

    expect(harness.stack.listLive()).toEqual([]);
    expect(harness.hooks.factoryCreated).toBe(1);
    expect(harness.hooks.startSyncCount).toBe(1);
  });

  it('enrollDeps.onEnrolled spins up a live collection after a fresh enroll', async () => {
    const row = enrollRow(harness, 'work');
    expect(harness.stack.listLive()).toHaveLength(0);
    await harness.stack.enrollDeps.onEnrolled?.({
      slug: row.slug,
      platform: 'calendar',
      adapter_type: row.adapter_type,
      caps: row.caps as CalendarCollectionCaps,
      auth_state: row.auth_state,
      last_synced_at: row.last_synced_at,
    });
    expect(harness.stack.listLive()).toHaveLength(1);
  });

  it('enrollDeps.onDeleted tears down an existing live collection', async () => {
    enrollRow(harness, 'work');
    await harness.stack.startAll();
    expect(harness.stack.listLive()).toHaveLength(1);
    await harness.stack.enrollDeps.onDeleted?.('work');
    expect(harness.stack.listLive()).toHaveLength(0);
    expect(harness.hooks.close).toBe(1);
  });
});

describe('composeCalendarStack — vault-lock gate (poll deferred while locked)', () => {
  it('startAll does NOT arm the provider poll while the vault is LOCKED — collection stays live/readable', async () => {
    const h = buildHarness({ isVaultUnlocked: () => false });
    enrollRow(h, 'work', 'gcal');

    await h.stack.startAll();

    // The collection is live (its reads work against the plaintext warehouse)…
    expect(h.stack.listLive()).toHaveLength(1);
    // …but the provider poll loop was NOT armed while sealed → no fetch, no
    // CAS drop, no cursor advance (the D-117 locked-window data loss).
    expect(h.hooks.startSyncCount).toBe(0);

    h.cleanup();
  });

  it('resumeSync arms the deferred poll (the vault→unlocked edge action)', async () => {
    const h = buildHarness({ isVaultUnlocked: () => false });
    enrollRow(h, 'work', 'gcal');

    await h.stack.startAll();
    expect(h.hooks.startSyncCount).toBe(0); // deferred at boot (locked)

    await h.stack.resumeSync();
    expect(h.hooks.startSyncCount).toBe(1); // armed once resumed

    h.cleanup();
  });

  it('unlocked at boot → poll arms normally; pauseSync stops it (the re-lock edge)', async () => {
    const h = buildHarness({ isVaultUnlocked: () => true });
    enrollRow(h, 'work', 'gcal');

    await h.stack.startAll();
    expect(h.hooks.startSyncCount).toBe(1);

    await h.stack.pauseSync();
    expect(h.hooks.stopSyncCount).toBe(1);

    h.cleanup();
  });

  it('no predicate (dbless / no vault) → poll arms as before', async () => {
    const h = buildHarness();
    enrollRow(h, 'work', 'gcal');

    await h.stack.startAll();
    expect(h.hooks.startSyncCount).toBe(1);

    h.cleanup();
  });
});

describe('composeCalendarStack — dispatcher wiring', () => {
  it('kernelDispatchers.calendarList routes through the live collection', async () => {
    enrollRow(harness, 'work');
    await harness.stack.startAll();
    // No seeded events → empty result, but the dispatch path must
    // still succeed (instance exists + live collection is mapped).
    const res = await harness.stack.kernelDispatchers.calendarList({ slug: 'work' });
    expect(res.records).toEqual([]);
  });

  it('kernelDispatchers.calendarList rejects missing instance with not_found', async () => {
    await expect(
      harness.stack.kernelDispatchers.calendarList({ slug: 'unknown' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('live collections + watcherCursors route starting_soon through the warehouse', async () => {
    enrollRow(harness, 'work');
    await harness.stack.startAll();
    const res = await handleCalendarWatcher(
      {
        getCollection: (slug) =>
          harness.stack.listLive().find((c) => c.slug === slug),
        cursors: harness.stack.watcherCursors,
      },
      { slug: 'work', kind: 'starting_soon', minutes_ahead: 15 },
    );
    // Empty warehouse → no fire.
    expect(res).toMatchObject({ should_run: false, items: [] });
  });

  it('watcherCursors persists cursor through startAll reboot', async () => {
    harness.stack.watcherCursors.set('my-recipe', 42_000);
    // Simulate a restart: rebuild the stack against the same DB.
    const second = composeCalendarStack(
      harness.db,
      {
        blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
        bus: harness.bus,
        getGate: () => mkNoopGate(),
      },
      { factories: [] },
    );
    expect(second.watcherCursors.get('my-recipe')).toBe(42_000);
  });
});

describe('composeCalendarStack — registry mirror', () => {
  it('registerCalendarCollections pushes every live collection into the shared registry', async () => {
    enrollRow(harness, 'work');
    enrollRow(harness, 'holidays');
    await harness.stack.startAll();
    const registry = createCollectionRegistry();
    registerCalendarCollections(harness.stack, registry);
    const slugs = registry.list().map((c) => c.slug).sort();
    expect(slugs).toEqual(['holidays', 'work']);
    // Calling twice is a no-op (dedupes on platform+slug).
    registerCalendarCollections(harness.stack, registry);
    expect(registry.list()).toHaveLength(2);
  });

  it('an unknown adapter_type logs and skips without crashing startAll', async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const stack = composeCalendarStack(
      harness.db,
      {
        blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
        bus: harness.bus,
        getGate: () => mkNoopGate(),
      },
      { factories: [] },
      {
        log: (level, msg) => { logs.push({ level, msg }); },
      },
    );
    enrollRow(harness, 'work', 'gcal');
    await stack.startAll();
    expect(stack.listLive()).toHaveLength(0);
    expect(logs.some((l) => l.msg.includes("unknown adapter_type 'gcal'"))).toBe(true);
  });
});
