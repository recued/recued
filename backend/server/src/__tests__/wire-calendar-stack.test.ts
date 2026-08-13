import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// `vi.mock` is hoisted; keep the mocked exports as `vi.fn`s so the
// composer's static named imports close over inspectable functions.
const calendarMocks = vi.hoisted(() => {
  const stack = {
    tag: 'calendar-stack',
    // D-173 P4.3 — composeCalendarBoot now ensures the default local
    // calendar instance via stack.instances; the sentinel must expose it.
    instances: { get: vi.fn(() => null), upsert: vi.fn() },
  };
  return {
    stack,
    composeCalendarStack: vi.fn(() => stack),
    createGcalAdapterFactory: vi.fn(() => ({ kind: 'gcal', tag: 'gcal' })),
    createGraphCalAdapterFactory: vi.fn(() => ({ kind: 'graph', tag: 'graph' })),
    createCalDavAdapterFactory: vi.fn(() => ({ kind: 'caldav', tag: 'caldav' })),
    deriveContactsFromCalendar: vi.fn(() => []),
  };
});

vi.mock('../collections/calendar/compose.js', () => ({
  composeCalendarStack: calendarMocks.composeCalendarStack,
}));
vi.mock('../collections/calendar/gcal-provider.js', () => ({
  createGcalAdapterFactory: calendarMocks.createGcalAdapterFactory,
}));
vi.mock('../collections/calendar/graph-provider.js', () => ({
  createGraphCalAdapterFactory: calendarMocks.createGraphCalAdapterFactory,
}));
vi.mock('../collections/calendar/caldav-provider.js', () => ({
  createCalDavAdapterFactory: calendarMocks.createCalDavAdapterFactory,
}));
vi.mock('../warehouse/contact-derive.js', () => ({
  deriveContactsFromCalendar: calendarMocks.deriveContactsFromCalendar,
}));

import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { ServerAccountStore } from '../account-store.js';
import type { GateRegistry } from '../storage-gates.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { ProviderEventPayload } from '../collections/calendar/provider.js';
import type {
  CalendarStack,
  CalendarAdapterBundle,
  CalendarStackStorageDeps,
  ComposeCalendarStackOptions,
} from '../collections/calendar/compose.js';
import { composeCalendarStack } from '../collections/calendar/compose.js';
import { createGcalAdapterFactory } from '../collections/calendar/gcal-provider.js';
import { createGraphCalAdapterFactory } from '../collections/calendar/graph-provider.js';
import { createCalDavAdapterFactory } from '../collections/calendar/caldav-provider.js';
import { deriveContactsFromCalendar } from '../warehouse/contact-derive.js';
import {
  composeCalendarBoot,
  type ComposeCalendarStackBootDeps,
} from '../composition/bin/wire-calendar-stack.js';

type ComposeCall = [
  Database.Database,
  CalendarStackStorageDeps,
  CalendarAdapterBundle,
  ComposeCalendarStackOptions,
];

type TestGateRegistry = GateRegistry & {
  get: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
};

type TestAccountStore = ServerAccountStore & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  totalBytes: ReturnType<typeof vi.fn>;
};

type TestContactStore = ContactStore & {
  observeBatch: ReturnType<typeof vi.fn>;
};

const sentinelStack = calendarMocks.stack as unknown as CalendarStack;

const resetCalendarMocks = (): void => {
  vi.mocked(composeCalendarStack).mockReset();
  vi.mocked(composeCalendarStack).mockImplementation(() => sentinelStack);
  vi.mocked(createGcalAdapterFactory).mockReset();
  vi.mocked(createGcalAdapterFactory).mockImplementation(
    () => ({ kind: 'gcal', tag: 'gcal' }) as never,
  );
  vi.mocked(createGraphCalAdapterFactory).mockReset();
  vi.mocked(createGraphCalAdapterFactory).mockImplementation(
    () => ({ kind: 'graph', tag: 'graph' }) as never,
  );
  vi.mocked(createCalDavAdapterFactory).mockReset();
  vi.mocked(createCalDavAdapterFactory).mockImplementation(
    () => ({ kind: 'caldav', tag: 'caldav' }) as never,
  );
  vi.mocked(deriveContactsFromCalendar).mockReset();
  vi.mocked(deriveContactsFromCalendar).mockReturnValue([]);
  calendarMocks.stack.instances.get.mockReset();
  calendarMocks.stack.instances.get.mockReturnValue(null);
  calendarMocks.stack.instances.upsert.mockReset();
};

resetCalendarMocks();

afterEach(() => {
  try {
    vi.restoreAllMocks();
  } finally {
    resetCalendarMocks();
  }
});

const db = (): Database.Database =>
  ({ tag: 'db' }) as unknown as Database.Database;

const cacheBlobs = (): NonNullable<ComposeCalendarStackBootDeps['cacheBlobs']> =>
  ({
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  }) as unknown as NonNullable<ComposeCalendarStackBootDeps['cacheBlobs']>;

const warehouseBus = (): ComposeCalendarStackBootDeps['warehouseBus'] =>
  ({ emit: vi.fn() }) as unknown as ComposeCalendarStackBootDeps['warehouseBus'];

const oauthConfig = (
  provider: 'gcal' | 'graph',
  clientId = `${provider}-client`,
) => ({
  tokenUrl: `https://${provider}.test/token`,
  clientId,
  clientSecret: `${provider}-secret`,
});

const makeGateRegistry = (
  options: {
    existing?: StorageGate;
    registered?: StorageGate;
  } = {},
): TestGateRegistry =>
  ({
    get: vi.fn(() => options.existing),
    register: vi.fn(() =>
      options.registered ?? ({ tag: 'registered-gate' } as unknown as StorageGate),
    ),
  }) as unknown as TestGateRegistry;

const makeAccountStore = (
  entries: Record<string, string> = {},
): TestAccountStore => ({
  get: vi.fn(async (key: string) => entries[key] ?? null),
  set: vi.fn(async (key: string, value: string) => {
    entries[key] = value;
  }),
  delete: vi.fn(async (key: string) => {
    delete entries[key];
  }),
  getAll: vi.fn(async () => ({ ...entries })),
  clear: vi.fn(async () => {
    for (const key of Object.keys(entries)) delete entries[key];
  }),
  totalBytes: vi.fn(async () => 0),
});

const makeContactStore = (): TestContactStore =>
  ({
    observeBatch: vi.fn(() => 0),
  }) as unknown as TestContactStore;

const buildDeps = (
  overrides: Partial<ComposeCalendarStackBootDeps> = {},
): ComposeCalendarStackBootDeps => ({
  db: db(),
  cacheBlobs: cacheBlobs(),
  warehouseBus: warehouseBus(),
  gateRegistry: makeGateRegistry(),
  resolveOAuthConfig: (adapter) => oauthConfig(adapter),
  ...overrides,
});

const lastComposeCall = (): ComposeCall => {
  const call = vi.mocked(composeCalendarStack).mock.calls.at(-1);
  if (!call) throw new Error('composeCalendarStack was not called');
  return call as ComposeCall;
};

const factoryTags = (bundle: CalendarAdapterBundle): string[] =>
  bundle.factories.map((factory) => (factory as unknown as { kind: string }).kind);

const eventPayload = (): ProviderEventPayload => ({
  event: {
    source_id: 'event-1',
    ical_uid: 'ical-1',
    calendar_id: 'primary',
    summary: 'Planning',
    start_at: 1_700_000_000_000,
    end_at: 1_700_003_600_000,
    timezone: 'UTC',
    is_all_day: false,
    status: 'confirmed',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  },
  description_bytes: 0,
});

describe('composeCalendarBoot', () => {
  it('returns undefined and skips composeCalendarStack when db is undefined', () => {
    const stack = composeCalendarBoot(buildDeps({ db: undefined }));

    expect(stack).toBeUndefined();
    expect(composeCalendarStack).not.toHaveBeenCalled();
  });

  it('returns undefined and skips composeCalendarStack when cacheBlobs is undefined', () => {
    const stack = composeCalendarBoot(buildDeps({ cacheBlobs: undefined }));

    expect(stack).toBeUndefined();
    expect(composeCalendarStack).not.toHaveBeenCalled();
  });

  it('returns the composeCalendarStack result and passes db, storage, bundle, and options', () => {
    const deps = buildDeps();

    const stack = composeCalendarBoot(deps);

    expect(stack).toBe(sentinelStack);
    expect(composeCalendarStack).toHaveBeenCalledTimes(1);
    const [dbArg, storage, bundle, options] = lastComposeCall();
    expect(dbArg).toBe(deps.db);
    expect(storage.blobs).toBe(deps.cacheBlobs);
    expect(storage.bus).toBe(deps.warehouseBus);
    expect(bundle.factories).toHaveLength(4);
    expect(options.log).toEqual(expect.any(Function));
  });

  /** ⛔⛔ REGRESSION PIN — same slip as `wire-mail-stack.test.ts`, found the same
   *  day by sweeping for it. `runStartLive` reads
   *  `bundle.getCollectionRegistry?.()`, but the wiring spread it into `storage`,
   *  so the getter was always undefined and a calendar enrolled at RUNTIME never
   *  joined the shared registry — reads answered COLLECTION_NOT_FOUND until a
   *  restart.
   *
   *  ⛔⛔ `...(x ? { x } : {})` is a SPREAD, and spreads are EXEMPT from the
   *  excess-property check; written plainly the same misplacement is TS2353.
   *  ⇒ assert the SIDE a field lands on, not merely that it was forwarded. */
  it('⛔ puts getCollectionRegistry on the BUNDLE, not storage — runStartLive reads it there', () => {
    const registry = {} as never;
    const getCollectionRegistry = () => registry;

    composeCalendarBoot(buildDeps({ getCollectionRegistry }));

    const [, storage, bundle] = lastComposeCall();
    expect(bundle.getCollectionRegistry).toBe(getCollectionRegistry);
    // The half that actually failed: present, but on the object nobody reads.
    expect(Object.hasOwn(storage, 'getCollectionRegistry')).toBe(false);
  });

  it('omits getCollectionRegistry from the bundle when not passed', () => {
    composeCalendarBoot(buildDeps());

    const [, , bundle] = lastComposeCall();
    expect(Object.hasOwn(bundle, 'getCollectionRegistry')).toBe(false);
  });

  it('omits auditLog from storage when auditLog is not passed', () => {
    composeCalendarBoot(buildDeps());

    const [, storage] = lastComposeCall();
    expect(Object.hasOwn(storage, 'auditLog')).toBe(false);
  });

  it('threads auditLog through storage when auditLog is passed', () => {
    const auditLog = { emit: vi.fn() } as unknown as ComposeCalendarStackBootDeps['auditLog'];

    composeCalendarBoot(buildDeps({ auditLog }));

    const [, storage] = lastComposeCall();
    expect(storage.auditLog).toBe(auditLog);
  });

  it('omits onEventUpserted from storage when contactStore is not passed', () => {
    composeCalendarBoot(buildDeps());

    const [, storage] = lastComposeCall();
    expect(Object.hasOwn(storage, 'onEventUpserted')).toBe(false);
  });

  it('wires onEventUpserted to derive and observe non-empty contact observations', () => {
    const contactStore = makeContactStore();
    const observations = [
      {
        email: 'ada@example.com',
        source: 'calendar_attendee',
        event_at: 1_700_000_000_000,
      },
    ] as ReturnType<typeof deriveContactsFromCalendar>;
    vi.mocked(deriveContactsFromCalendar).mockReturnValueOnce(observations);

    composeCalendarBoot(buildDeps({ contactStore }));
    const [, storage] = lastComposeCall();
    const payload = eventPayload();
    storage.onEventUpserted?.(payload);

    expect(deriveContactsFromCalendar).toHaveBeenCalledTimes(1);
    expect(deriveContactsFromCalendar).toHaveBeenCalledWith(payload.event);
    expect(contactStore.observeBatch).toHaveBeenCalledTimes(1);
    expect(contactStore.observeBatch).toHaveBeenCalledWith(observations);
  });

  it('does not observe contacts when derivation returns no observations', () => {
    const contactStore = makeContactStore();
    vi.mocked(deriveContactsFromCalendar).mockReturnValueOnce([]);

    composeCalendarBoot(buildDeps({ contactStore }));
    const [, storage] = lastComposeCall();
    storage.onEventUpserted?.(eventPayload());

    expect(contactStore.observeBatch).not.toHaveBeenCalled();
  });

  it('registers and returns a calendar storage gate when one is missing', () => {
    const registeredGate = { tag: 'registered' } as unknown as StorageGate;
    const gateRegistry = makeGateRegistry({ registered: registeredGate });

    composeCalendarBoot(buildDeps({ gateRegistry }));
    const [, storage] = lastComposeCall();
    const gate = storage.getGate('work');

    expect(gateRegistry.get).toHaveBeenCalledWith('collection:calendar:work');
    expect(gateRegistry.register).toHaveBeenCalledTimes(1);
    expect(gateRegistry.register).toHaveBeenCalledWith(
      'collection:calendar:work',
      {
        quota: 512 * 1024 * 1024,
        reservePct: 10,
        initialUsage: 0,
      },
    );
    expect(gate).toBe(registeredGate);
  });

  it('returns an existing calendar storage gate without registering', () => {
    const existingGate = { tag: 'existing' } as unknown as StorageGate;
    const gateRegistry = makeGateRegistry({ existing: existingGate });

    composeCalendarBoot(buildDeps({ gateRegistry }));
    const [, storage] = lastComposeCall();
    const gate = storage.getGate('work');

    expect(gate).toBe(existingGate);
    expect(gateRegistry.register).not.toHaveBeenCalled();
  });

  it('throws from getGate when gateRegistry is unavailable', () => {
    composeCalendarBoot(buildDeps({ gateRegistry: undefined }));
    const [, storage] = lastComposeCall();

    expect(() => storage.getGate('work')).toThrow(
      'calendarStack: gateRegistry not available',
    );
  });

  it('ALWAYS registers the gcal + graph adapter factories (availability is decided per-use by the resolver, not a boot gate)', () => {
    // Even with a resolver that returns null (nothing configured) the factories
    // still register — the enroll/refresh path surfaces not_configured at use.
    composeCalendarBoot(buildDeps({ resolveOAuthConfig: () => null }));
    let [, , bundle] = lastComposeCall();
    expect(factoryTags(bundle)).toEqual(['local', 'gcal', 'graph', 'caldav']);
    expect(createGcalAdapterFactory).toHaveBeenCalledTimes(1);
    expect(createGraphCalAdapterFactory).toHaveBeenCalledTimes(1);

    resetCalendarMocks();
    composeCalendarBoot(buildDeps());
    [, , bundle] = lastComposeCall();
    expect(factoryTags(bundle)).toEqual(['local', 'gcal', 'graph', 'caldav']);
  });

  it('passes a no-op OAuth account-store double to gcal and graph when accountStore is undefined', async () => {
    composeCalendarBoot(buildDeps());

    const gcalOptions = vi.mocked(createGcalAdapterFactory).mock.calls[0][0];
    const graphOptions = vi.mocked(createGraphCalAdapterFactory).mock.calls[0][0];
    await expect(gcalOptions.accountStore.get('k')).resolves.toBeNull();
    await expect(graphOptions.accountStore.get('k')).resolves.toBeNull();
  });

  it('passes an OAuth account-store double that delegates to the real accountStore', async () => {
    const accountStore = makeAccountStore({ k: 'real' });

    composeCalendarBoot(buildDeps({ accountStore }));

    const gcalOptions = vi.mocked(createGcalAdapterFactory).mock.calls[0][0];
    await expect(gcalOptions.accountStore.get('k')).resolves.toBe('real');
    expect(accountStore.get).toHaveBeenCalledTimes(1);
    expect(accountStore.get).toHaveBeenCalledWith('k');
  });

  it('bundle oauthConfig delegates to the injected per-use resolver', () => {
    composeCalendarBoot(buildDeps());
    let [, , bundle] = lastComposeCall();
    expect(bundle.oauthConfig?.('gcal')).toMatchObject({ clientId: 'gcal-client' });
    expect(bundle.oauthConfig?.('graph')).toMatchObject({ clientId: 'graph-client' });

    // A resolver returning null (not configured) surfaces as null.
    resetCalendarMocks();
    composeCalendarBoot(buildDeps({ resolveOAuthConfig: () => null }));
    [, , bundle] = lastComposeCall();
    expect(bundle.oauthConfig?.('gcal')).toBeNull();
    expect(bundle.oauthConfig?.('graph')).toBeNull();
  });

  it('adds bundle accountStore only when deps.accountStore is present and delegates through a fresh double', async () => {
    const accountStore = makeAccountStore({ k: 'v' });

    composeCalendarBoot(buildDeps({ accountStore }));
    let [, , bundle] = lastComposeCall();
    expect(bundle.accountStore).toBeDefined();
    expect(bundle.accountStore).not.toBe(accountStore);
    await expect(bundle.accountStore?.get('k')).resolves.toBe('v');
    expect(accountStore.get).toHaveBeenCalledWith('k');
    // getAll MUST be threaded through the wrapper — the enroll delete handler's
    // caldav prefix-sweep (caldav.<slug>.* password + etags) silently no-ops to
    // password-only without it. (Regression guard for the threading gap.)
    await expect(bundle.accountStore?.getAll?.()).resolves.toEqual({ k: 'v' });
    expect(accountStore.getAll).toHaveBeenCalledTimes(1);

    resetCalendarMocks();
    composeCalendarBoot(buildDeps({ accountStore: undefined }));
    [, , bundle] = lastComposeCall();
    expect(Object.hasOwn(bundle, 'accountStore')).toBe(false);
  });

  it('uses an empty CalDAV etagStore list when accountStore is undefined', async () => {
    composeCalendarBoot(buildDeps({ accountStore: undefined }));

    const caldavOptions = vi.mocked(createCalDavAdapterFactory).mock.calls[0][0];
    await expect(caldavOptions.etagStore.list('caldav.x.etag.')).resolves.toEqual([]);
  });

  it('lists CalDAV etags from accountStore.getAll at call time filtered by prefix', async () => {
    const accountStore = makeAccountStore({
      'caldav.x.etag.a': '1',
      'caldav.x.etag.b': '2',
      other: '3',
    });

    composeCalendarBoot(buildDeps({ accountStore }));
    const caldavOptions = vi.mocked(createCalDavAdapterFactory).mock.calls[0][0];

    expect(accountStore.getAll).not.toHaveBeenCalled();
    await expect(caldavOptions.etagStore.list('caldav.x.etag.')).resolves.toEqual([
      { key: 'caldav.x.etag.a', value: '1' },
      { key: 'caldav.x.etag.b', value: '2' },
    ]);
    expect(accountStore.getAll).toHaveBeenCalledTimes(1);
  });

  it('auto-creates the default local calendar instance when absent (D-173 P4.3)', () => {
    const instances = calendarMocks.stack.instances;
    composeCalendarBoot(buildDeps());

    expect(instances.get).toHaveBeenCalledWith('calendar', 'local');
    expect(instances.upsert).toHaveBeenCalledTimes(1);
    expect(instances.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'calendar',
        slug: 'local',
        adapter_type: 'local',
        config: {},
        auth_state: 'healthy',
        last_synced_at: null,
        caps: expect.objectContaining({ auth: 'none', create_event: 'yes', read: 'yes' }),
      }),
    );
  });

  // ── Local caps refresh (slice 2, 2026-07-16) ────────────────────────
  //
  // This block replaces a test that asserted the OPPOSITE — "does not re-create
  // the default local calendar when it already exists", expecting `upsert` NOT
  // to be called. That test was green, and it pinned BLOCKER-1 in place.
  //
  // The dispatcher's write gate reads caps from the PERSISTED instance row, not
  // from `LOCAL_CALENDAR_CAPS` (`calendar-dispatcher.ts` requireRow →
  // effectiveCaps → hasCap → 403). Skipping an existing row froze its caps at
  // whatever the code said on FIRST boot — so slice 2 flipping `update_event` /
  // `delete_event` to `'yes'` in the constant would have been INERT on every
  // server that had ever booted. The constant would read `'yes'` and every move
  // and cancel would still 403, forever. [[declared_is_not_backed]].
  //
  // Refresh is correct *for this adapter*: `local` caps are a CODE fact
  // (`probeCaps` returns the static constant — no probe, no user-settable cap
  // surface). Real instance state must still survive, which is what the old
  // skip was actually protecting; that half is asserted below too.

  it('REFRESHES the local caps when the row already exists (a slice-1 server gains edit)', () => {
    const instances = calendarMocks.stack.instances;
    // The real-world state this exists for: a row on disk from a boot when the
    // constant said 'no'.
    instances.get.mockReturnValue({
      slug: 'local',
      adapter_type: 'local',
      config: {},
      caps: { update_event: 'no', delete_event: 'no' },
      auth_state: 'healthy',
      last_synced_at: null,
    } as never);

    composeCalendarBoot(buildDeps());

    expect(instances.upsert).toHaveBeenCalledTimes(1);
    expect(instances.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'local',
        caps: expect.objectContaining({ update_event: 'yes', delete_event: 'yes' }),
      }),
    );
  });

  it('the caps refresh preserves real instance state (config / auth_state / last_synced_at)', () => {
    const instances = calendarMocks.stack.instances;
    instances.get.mockReturnValue({
      slug: 'local',
      adapter_type: 'local',
      config: { display_name: 'My calendar' },
      caps: { update_event: 'no' },
      auth_state: 'degraded',
      last_synced_at: 1_700_000_000_000,
    } as never);

    composeCalendarBoot(buildDeps());

    // Caps track the code; everything else is the instance's own and a refresh
    // that reset it would trade one bug for a worse one.
    expect(instances.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        caps: expect.objectContaining({ update_event: 'yes' }),
        config: { display_name: 'My calendar' },
        auth_state: 'degraded',
        last_synced_at: 1_700_000_000_000,
      }),
    );
  });

  it('passes a log option that routes error to console.error and info to console.log', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    composeCalendarBoot(buildDeps());
    const [, , , options] = lastComposeCall();
    options.log?.('error', 'boom', { x: 1 });
    options.log?.('info', 'hello', undefined);

    expect(errorSpy).toHaveBeenCalledWith('[calendar-stack] boom', { x: 1 });
    expect(logSpy).toHaveBeenCalledWith('[calendar-stack] hello', '');
  });
});
