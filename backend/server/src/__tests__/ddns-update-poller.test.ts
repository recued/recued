import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  DDNS_UPDATE_INTERVAL_MS,
  type DdnsUpdateResponse,
  type HostnameProjection,
} from '@recued/contracts';
import { canonicalJSONStringify } from '@recued/crypto';

import {
  createDdnsUpdateClient,
  type DdnsUpdateClient,
} from '../ddns/update-client.js';
import {
  createInMemoryDdnsIpStateStore,
  createSqliteDdnsIpStateStore,
  type DdnsIpStateStore,
} from '../ddns/ip-state-store.js';
import {
  composeDdnsUpdatePoller,
} from '../composition/bin/wire-ddns-update-poller.js';
import {
  createBackgroundServiceRegistry,
  type BackgroundServiceRegistry,
  type IntervalServiceSpec,
} from '../composition/bin/wire-background-services.js';
import {
  createInMemoryHandleStateStore,
  type HandleState,
  type HandleStateStore,
} from '../handle/index.js';
import type {
  ProSubscriptionStateRow,
  ProSubscriptionStateStore,
} from '../hostname/pro-subscription-state.js';
import type { HostnameRegistryStore } from '../storage/hostname-registry.js';

const fixedTimestamp = 1_700_000_000_123;

const updateResponse = (
  override: Partial<DdnsUpdateResponse> = {},
): DdnsUpdateResponse => ({
  ddns_record_updated_at: 1_700_000_100_000,
  ttl: 300,
  warnings: [],
  ...override,
});

const jsonResponse = (
  body: unknown,
  init: ResponseInit = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' },
  });

const createClientHarness = (
  response: Response = jsonResponse({ data: updateResponse() }),
) => {
  const signPayload = vi.fn((canonical: string) => `sig:${canonical}`);
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  const client = createDdnsUpdateClient({
    cloud_base_url: 'https://cloud.example///',
    signPayload,
    fetch: fetchMock,
  });
  return { client, signPayload, fetchMock };
};

const postedBody = (
  fetchMock: ReturnType<typeof createClientHarness>['fetchMock'],
): Record<string, unknown> => {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
};

const sampleHandleState = (
  subscription_state: HandleState['subscription_state'] = 'active',
): HandleState => ({
  publisher_id: 'pub_test_01',
  current_handle: 'alice',
  handle_history: [],
  subscription_state,
  last_synced_at: 1_700_000_000_000,
});

const sampleHostname = (
  hostname: string,
  override: Partial<HostnameProjection> = {},
): HostnameProjection => ({
  hostname_id: `host-${hostname}`,
  hostname,
  cert_source: 'recued_acme',
  ownership_status: 'verified',
  listener_ports: [443],
  ddns_managed: true,
  enabled: true,
  tls_topology: 'server_terminated',
  ...override,
});

const sampleSubscriptionState = (
  hostname: string,
  publisher_id = `publisher-${hostname}`,
  status: ProSubscriptionStateRow['status'] = 'active',
): ProSubscriptionStateRow => ({
  state_id: `state-${hostname}`,
  publisher_id,
  hostname_normalized: hostname,
  status,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
});

const flushAsyncTick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};

const createCapturingRegistry = (): {
  registry: BackgroundServiceRegistry;
  interval: () => IntervalServiceSpec;
} => {
  let captured: IntervalServiceSpec | null = null;
  const registry: BackgroundServiceRegistry = {
    register: vi.fn(),
    registerInterval: vi.fn((spec: IntervalServiceSpec) => {
      captured = spec;
      return vi.fn();
    }),
    stopAll: vi.fn(async () => {}),
    list: vi.fn(() => (captured ? [captured.name] : [])),
  };
  return {
    registry,
    interval: () => {
      if (!captured) {
        throw new Error('interval was not registered');
      }
      return captured;
    },
  };
};

const createSpyIpStore = (
  prior: ReturnType<DdnsIpStateStore['load']> = null,
): DdnsIpStateStore & {
  load: ReturnType<typeof vi.fn<DdnsIpStateStore['load']>>;
  save: ReturnType<typeof vi.fn<DdnsIpStateStore['save']>>;
} => ({
  load: vi.fn<DdnsIpStateStore['load']>(() => prior),
  save: vi.fn<DdnsIpStateStore['save']>(),
});

type FetchPublicIpv4Mock = ReturnType<
  typeof vi.fn<() => Promise<string | null>>
>;
type DdnsUpdateMock = ReturnType<typeof vi.fn<DdnsUpdateClient['update']>>;

const composeHarness = (
  opts: {
    handleState?: HandleState | null;
    handleStateStore?: HandleStateStore;
    fetchPublicIpv4?: FetchPublicIpv4Mock;
    ipStateStore?: DdnsIpStateStore;
    update?: DdnsUpdateMock;
    hostnameRegistry?: Pick<HostnameRegistryStore, 'list'>;
    subscriptionState?: Pick<ProSubscriptionStateStore, 'get'>;
    ddnsEnabled?: { isEnabled: () => boolean };
    now?: () => number;
    intervalMs?: number;
  } = {},
) => {
  const capture = createCapturingRegistry();
  const fetchPublicIpv4 =
    opts.fetchPublicIpv4 ??
    vi.fn<() => Promise<string | null>>(async () => '203.0.113.10');
  const update =
    opts.update ??
    vi.fn<DdnsUpdateClient['update']>(async () => ({
      ok: true as const,
      data: updateResponse(),
    }));
  const handleStateStore =
    opts.handleStateStore ??
    createInMemoryHandleStateStore(
      opts.handleState === null
        ? undefined
        : opts.handleState ?? sampleHandleState(),
    );
  const ipStateStore = opts.ipStateStore ?? createSpyIpStore();

  composeDdnsUpdatePoller({
    registry: capture.registry,
    handleStateStore,
    fetchPublicIpv4,
    updateClient: { update },
    ipStateStore,
    ...(opts.hostnameRegistry ? { hostnameRegistry: opts.hostnameRegistry } : {}),
    ...(opts.subscriptionState ? { subscriptionState: opts.subscriptionState } : {}),
    ...(opts.ddnsEnabled ? { ddnsEnabled: opts.ddnsEnabled } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
  });

  const runTick = async (): Promise<void> => {
    capture.interval().tick();
    await flushAsyncTick();
  };

  return { ...capture, fetchPublicIpv4, update, ipStateStore, runTick };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createDdnsUpdateClient', () => {
  it('passes the exact canonical string with ip_v6 null for an IPv4-only update', async () => {
    const { client, signPayload } = createClientHarness();

    await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });

    expect(signPayload).toHaveBeenCalledWith(
      canonicalJSONStringify({
        publisher_id: 'pub_test_01',
        handle: 'alice',
        ip_v4: '203.0.113.10',
        ip_v6: null,
        timestamp: fixedTimestamp,
      }),
    );
  });

  it('passes the exact canonical string with the provided ip_v6 value', async () => {
    const { client, signPayload } = createClientHarness();

    await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      ip_v6: '2001:db8::10',
      timestamp: fixedTimestamp,
    });

    expect(signPayload).toHaveBeenCalledWith(
      canonicalJSONStringify({
        publisher_id: 'pub_test_01',
        handle: 'alice',
        ip_v4: '203.0.113.10',
        ip_v6: '2001:db8::10',
        timestamp: fixedTimestamp,
      }),
    );
  });

  it('omits the ip_v6 key from the POST body when it is not provided', async () => {
    const { client, fetchMock } = createClientHarness();

    await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });

    expect(Object.prototype.hasOwnProperty.call(postedBody(fetchMock), 'ip_v6')).toBe(false);
  });

  it('includes ip_v6 in the POST body when it is provided', async () => {
    const { client, fetchMock } = createClientHarness();

    await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      ip_v6: '2001:db8::10',
      timestamp: fixedTimestamp,
    });

    expect(postedBody(fetchMock).ip_v6).toBe('2001:db8::10');
  });

  it('posts to /v1/ddns/update after trimming trailing slashes from the base URL', async () => {
    const { client, fetchMock } = createClientHarness();

    await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });

    expect(fetchMock.mock.calls[0]![0]).toBe('https://cloud.example/v1/ddns/update');
  });

  it('sends application/json content type', async () => {
    const { client, fetchMock } = createClientHarness();

    await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { 'content-type': 'application/json' },
    });
  });

  it('maps a successful cloud envelope to ok true with data', async () => {
    const data = updateResponse({ warnings: ['low_ttl'] });
    const { client } = createClientHarness(jsonResponse({ data }));

    await expect(
      client.update({
        publisher_id: 'pub_test_01',
        handle: 'alice',
        ip_v4: '203.0.113.10',
        timestamp: fixedTimestamp,
      }),
    ).resolves.toEqual({ ok: true, data });
  });

  it('maps a known 403 DDNS error code through unchanged', async () => {
    const { client } = createClientHarness(
      jsonResponse(
        {
          error: {
            code: 'ddns_signature_invalid',
            message: 'signature did not verify',
          },
        },
        { status: 403, statusText: 'Forbidden' },
      ),
    );

    await expect(
      client.update({
        publisher_id: 'pub_test_01',
        handle: 'alice',
        ip_v4: '203.0.113.10',
        timestamp: fixedTimestamp,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'ddns_signature_invalid',
      message: 'signature did not verify',
    });
  });

  it('collapses an unknown cloud error code to network_error with status context', async () => {
    const { client } = createClientHarness(
      jsonResponse(
        { error: { code: 'unexpected_ddns_error', message: 'unknown fold' } },
        { status: 418, statusText: "I'm a teapot" },
      ),
    );

    await expect(
      client.update({
        publisher_id: 'pub_test_01',
        handle: 'alice',
        ip_v4: '203.0.113.10',
        timestamp: fixedTimestamp,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'network_error',
      message: 'http_418: unknown fold',
    });
  });

  it('collapses fetch throws to network_error with the thrown message', async () => {
    const signPayload = vi.fn(() => 'sig');
    const fetchMock = vi.fn(async () => {
      throw new Error('socket down');
    });
    const client = createDdnsUpdateClient({
      cloud_base_url: 'https://cloud.example',
      signPayload,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.update({
        publisher_id: 'pub_test_01',
        handle: 'alice',
        ip_v4: '203.0.113.10',
        timestamp: fixedTimestamp,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'network_error',
      message: 'socket down',
    });
  });

  it('collapses invalid JSON responses to network_error with parse_failed context', async () => {
    const { client } = createClientHarness(
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('network_error');
      expect(result.message).toMatch(/^parse_failed:/);
    }
  });

  // ── R27 delta-B — client.pause (POST /v1/ddns/pause) ──────────────
  it('pause signs {publisher_id, handle, paused, timestamp} and POSTs /v1/ddns/pause', async () => {
    const { client, signPayload, fetchMock } = createClientHarness(
      jsonResponse({ data: { handle: 'alice', paused: true, at: 1_700_000_100_000 } }),
    );

    const result = await client.pause({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      paused: true,
      timestamp: fixedTimestamp,
    });

    expect(result).toEqual({
      ok: true,
      data: { handle: 'alice', paused: true, at: 1_700_000_100_000 },
    });
    const canonical = canonicalJSONStringify({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      paused: true,
      timestamp: fixedTimestamp,
    });
    expect(signPayload).toHaveBeenCalledWith(canonical);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://cloud.example/v1/ddns/pause');
    expect(postedBody(fetchMock)).toEqual({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      paused: true,
      timestamp: fixedTimestamp,
      signature: `sig:${canonical}`,
    });
  });

  it('pause maps a known cloud error code (subscription lapsed)', async () => {
    const { client } = createClientHarness(
      jsonResponse(
        { error: { code: 'ddns_pause_subscription_lapsed', message: 'Pro subscription required' } },
        { status: 402 },
      ),
    );

    const result = await client.pause({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      paused: false,
      timestamp: fixedTimestamp,
    });

    expect(result).toEqual({
      ok: false,
      error: 'ddns_pause_subscription_lapsed',
      message: 'Pro subscription required',
    });
  });

  it('pause collapses an unknown error code to network_error', async () => {
    const { client } = createClientHarness(
      jsonResponse({ error: { code: 'totally_unknown' } }, { status: 500 }),
    );

    const result = await client.pause({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      paused: true,
      timestamp: fixedTimestamp,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('network_error');
  });
});

describe('createSqliteDdnsIpStateStore', () => {
  it('returns null when no singleton row exists', () => {
    const db = new Database(':memory:');
    try {
      const store = createSqliteDdnsIpStateStore(db);

      expect(store.load()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('round-trips a saved IPv4 snapshot', () => {
    const db = new Database(':memory:');
    try {
      const store = createSqliteDdnsIpStateStore(db);
      const snapshot = {
        ip_v4: '203.0.113.10',
        last_published_at: 1_700_000_100_000,
      };

      store.save(snapshot);

      expect(store.load()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('overwrites the prior singleton row on a second save', () => {
    const db = new Database(':memory:');
    try {
      const store = createSqliteDdnsIpStateStore(db);

      store.save({
        ip_v4: '203.0.113.10',
        last_published_at: 1_700_000_100_000,
      });
      const latest = {
        ip_v4: '198.51.100.20',
        last_published_at: 1_700_000_200_000,
      };
      store.save(latest);

      expect(store.load()).toEqual(latest);
    } finally {
      db.close();
    }
  });

  it('returns null for corrupt JSON in the singleton row', () => {
    const db = new Database(':memory:');
    try {
      const store = createSqliteDdnsIpStateStore(db);
      db.prepare(
        `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
      ).run('ddns_ip_state', '{not valid json');

      expect(store.load()).toBeNull();
    } finally {
      db.close();
    }
  });

  it('round-trips a snapshot containing ip_v6', () => {
    const db = new Database(':memory:');
    try {
      const store = createSqliteDdnsIpStateStore(db);
      const snapshot = {
        ip_v4: '203.0.113.10',
        ip_v6: '2001:db8::10',
        last_published_at: 1_700_000_100_000,
      };

      store.save(snapshot);

      expect(store.load()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('round-trips acknowledged DDNS publish targets', () => {
    const db = new Database(':memory:');
    try {
      const store = createSqliteDdnsIpStateStore(db);
      const snapshot = {
        ip_v4: '203.0.113.10',
        last_published_at: 1_700_000_100_000,
        published_targets: [
          { publisher_id: 'publisher-alice', handle: 'alice' },
          { publisher_id: 'publisher-bob', handle: 'bob' },
        ],
      };

      store.save(snapshot);

      expect(store.load()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });
});

describe('composeDdnsUpdatePoller', () => {
  it('registers a timer interval with the default cadence and fireImmediate enabled', async () => {
    const registry = createBackgroundServiceRegistry();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    composeDdnsUpdatePoller({
      registry,
      handleStateStore: createInMemoryHandleStateStore(sampleHandleState()),
      fetchPublicIpv4: vi.fn(async () => null),
      updateClient: { update: vi.fn() } as unknown as DdnsUpdateClient,
      ipStateStore: createInMemoryDdnsIpStateStore(),
    });
    await flushAsyncTick();

    expect(registry.list({ kind: 'timer' })).toEqual(['ddns-update-poll']);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), DDNS_UPDATE_INTERVAL_MS);
    await registry.stopAll({ kind: 'timer' });
  });

  it('forwards a custom intervalMs override to registerInterval', () => {
    const harness = composeHarness({ intervalMs: 12_345 });

    expect(harness.interval()).toMatchObject({
      name: 'ddns-update-poll',
      intervalMs: 12_345,
      fireImmediate: true,
    });
  });

  it('does nothing when no handle is configured', async () => {
    const harness = composeHarness({ handleState: null });

    await harness.runTick();

    expect(harness.fetchPublicIpv4).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("does nothing when the handle subscription state is 'released'", async () => {
    const harness = composeHarness({ handleState: sampleHandleState('released') });

    await harness.runTick();

    expect(harness.fetchPublicIpv4).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("proceeds when the handle subscription state is 'active'", async () => {
    const harness = composeHarness({ handleState: sampleHandleState('active') });

    await harness.runTick();

    expect(harness.fetchPublicIpv4).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it("proceeds when the handle subscription state is 'grace'", async () => {
    const harness = composeHarness({ handleState: sampleHandleState('grace') });

    await harness.runTick();

    expect(harness.fetchPublicIpv4).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it('publishes enabled ddns-managed registry hostnames through active Pro subscription state', async () => {
    const hostnameRegistry = {
      list: vi.fn(() => [sampleHostname('bob.recued.net')]),
    };
    const subscriptionState = {
      get: vi.fn((hostname: string) =>
        sampleSubscriptionState(hostname, 'publisher-bob'),
      ),
    };
    const harness = composeHarness({
      handleState: null,
      hostnameRegistry,
      subscriptionState,
      now: () => fixedTimestamp,
    });

    await harness.runTick();

    expect(hostnameRegistry.list).toHaveBeenCalledTimes(1);
    expect(subscriptionState.get).toHaveBeenCalledWith('bob.recued.net');
    expect(harness.update).toHaveBeenCalledWith({
      publisher_id: 'publisher-bob',
      handle: 'bob',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });
  });

  it('does not publish registry rows that are disabled, unverified, unmanaged, or released', async () => {
    const hostnameRegistry = {
      list: vi.fn(() => [
        sampleHostname('disabled.recued.net', { enabled: false }),
        sampleHostname('pending.recued.net', { ownership_status: 'pending' }),
        sampleHostname('manual.recued.net', { ddns_managed: false }),
        sampleHostname('released.recued.net'),
      ]),
    };
    const subscriptionState = {
      get: vi.fn((hostname: string) =>
        sampleSubscriptionState(
          hostname,
          `publisher-${hostname}`,
          hostname === 'released.recued.net' ? 'released' : 'active',
        ),
      ),
    };
    const harness = composeHarness({
      handleState: null,
      hostnameRegistry,
      subscriptionState,
    });

    await harness.runTick();

    expect(harness.fetchPublicIpv4).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it('does nothing when the public IPv4 resolver returns null', async () => {
    const harness = composeHarness({
      fetchPublicIpv4: vi.fn(async () => null),
      ipStateStore: createSpyIpStore(),
    });

    await harness.runTick();

    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.ipStateStore.save).not.toHaveBeenCalled();
  });

  it('skips the POST when the resolved IPv4 matches the last published IPv4', async () => {
    const ipStateStore = createSpyIpStore({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_100_000,
    });
    const harness = composeHarness({ ipStateStore });

    await harness.runTick();

    expect(harness.update).not.toHaveBeenCalled();
    expect(ipStateStore.save).not.toHaveBeenCalled();
  });

  it('publishes a new registry target even when a legacy singleton snapshot has the same IP', async () => {
    const ipStateStore = createSpyIpStore({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_100_000,
    });
    const hostnameRegistry = {
      list: vi.fn(() => [sampleHostname('bob.recued.net')]),
    };
    const subscriptionState = {
      get: vi.fn((hostname: string) =>
        sampleSubscriptionState(hostname, 'publisher-bob'),
      ),
    };
    const harness = composeHarness({
      ipStateStore,
      hostnameRegistry,
      subscriptionState,
      now: () => fixedTimestamp,
    });

    await harness.runTick();

    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledWith({
      publisher_id: 'publisher-bob',
      handle: 'bob',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });
    expect(ipStateStore.save).toHaveBeenCalledWith({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_100_000,
      published_targets: [
        { publisher_id: 'pub_test_01', handle: 'alice' },
        { publisher_id: 'publisher-bob', handle: 'bob' },
      ],
    });
  });

  it('skips registry targets already acknowledged for the current IP', async () => {
    const ipStateStore = createSpyIpStore({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_100_000,
      published_targets: [
        { publisher_id: 'publisher-bob', handle: 'bob' },
      ],
    });
    const harness = composeHarness({
      handleState: null,
      ipStateStore,
      hostnameRegistry: {
        list: vi.fn(() => [sampleHostname('bob.recued.net')]),
      },
      subscriptionState: {
        get: vi.fn((hostname: string) =>
          sampleSubscriptionState(hostname, 'publisher-bob'),
        ),
      },
    });

    await harness.runTick();

    expect(harness.update).not.toHaveBeenCalled();
    expect(ipStateStore.save).not.toHaveBeenCalled();
  });

  it('POSTs when there is no prior IP snapshot', async () => {
    const harness = composeHarness({
      ipStateStore: createSpyIpStore(null),
      now: () => fixedTimestamp,
    });

    await harness.runTick();

    expect(harness.update).toHaveBeenCalledWith({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });
  });

  it('POSTs when the prior IPv4 differs from the resolved IPv4', async () => {
    const harness = composeHarness({
      ipStateStore: createSpyIpStore({
        ip_v4: '198.51.100.20',
        last_published_at: 1_700_000_100_000,
      }),
    });

    await harness.runTick();

    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it('saves the resolved IPv4 and cloud timestamp after a successful POST', async () => {
    const ipStateStore = createSpyIpStore(null);
    const harness = composeHarness({
      ipStateStore,
      update: vi.fn(async () => ({
        ok: true as const,
        data: updateResponse({ ddns_record_updated_at: 1_700_000_222_000 }),
      })),
    });

    await harness.runTick();

    expect(ipStateStore.save).toHaveBeenCalledWith({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_222_000,
      published_targets: [
        { publisher_id: 'pub_test_01', handle: 'alice' },
      ],
    });
  });

  it('does not save IP state after a failed POST', async () => {
    const ipStateStore = createSpyIpStore(null);
    const harness = composeHarness({
      ipStateStore,
      update: vi.fn(async () => ({
        ok: false as const,
        error: 'network_error' as const,
        message: 'cloud down',
      })),
    });

    await harness.runTick();

    expect(ipStateStore.save).not.toHaveBeenCalled();
  });

  it('catches handle store load errors, logs, and resolves the tick', async () => {
    const err = new Error('sqlite locked');
    const handleStateStore: HandleStateStore = {
      load: vi.fn(async () => {
        throw err;
      }),
      save: vi.fn(async () => {}),
    };
    const harness = composeHarness({ handleStateStore });

    await expect(harness.runTick()).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith('[ddns-update-poll] tick failed', err);
  });

  it('forwards the now() override as the update timestamp', async () => {
    const harness = composeHarness({ now: () => fixedTimestamp });

    await harness.runTick();

    expect(harness.update).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: fixedTimestamp }),
    );
  });

  // R27 delta-B — a user-paused server stops refreshing its DDNS record.
  it('skips the tick entirely when ddnsEnabled.isEnabled() is false (user paused)', async () => {
    const harness = composeHarness({ ddnsEnabled: { isEnabled: () => false } });

    await harness.runTick();

    expect(harness.fetchPublicIpv4).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it('publishes normally when ddnsEnabled.isEnabled() is true', async () => {
    const harness = composeHarness({ ddnsEnabled: { isEnabled: () => true } });

    await harness.runTick();

    expect(harness.update).toHaveBeenCalledTimes(1);
  });
});
