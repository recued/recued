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
  createServerDisownedFlag,
  type ServerDisownedFlag,
} from '../pro-convenience/disconnect-announcer.js';
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
    /** The lifecycle seam `recordLapse` writes through. Forwarded so a test can
     *  assert which stand-downs record a subscription fact and which only pace
     *  themselves — without it every lapse write is a silent no-op here. */
    applyLifecycle?: () => { applyLifecycleUpdate: (args: { state: string; now: number }) => Promise<void> };
    /** ⚠ FORWARDED EXPLICITLY, like every other seam here — this harness spreads
     *  only the options it names, so an unforwarded one is silently dropped and
     *  the test asserts against a dep the poller never received. */
    announceDisconnect?: (source: 'ddns_publish') => Promise<boolean> | boolean;
    disownedFlag?: ServerDisownedFlag;
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
    ...(opts.applyLifecycle ? { applyLifecycle: opts.applyLifecycle as never } : {}),
    ...(opts.announceDisconnect ? { announceDisconnect: opts.announceDisconnect } : {}),
    ...(opts.disownedFlag ? { disownedFlag: opts.disownedFlag } : {}),
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

/** ⛔⛔ A PERMANENT REFUSAL MUST NOT BE RETRIED PER TICK. The cloud answers
 *  `ddns_handle_mismatch` when the handle reservation is not owned by this
 *  publisher_id — because another of the owner's servers now holds it, or the
 *  denormalized authority copy disagrees. No number of retries fixes either, and
 *  it fell into the generic "log + retry next tick" branch: one rejected request
 *  per tick, forever. That is the measured 288/day that made the identical
 *  behaviour unacceptable for a lapsed subscription, and the lapse branch was
 *  added to stop it — for one code, leaving its twin hammering.
 *
 *  ⚠ PACING ONLY. A lapse is a subscription fact recorded through the state
 *  machine; this is an OWNERSHIP fact, and writing 'grace' would label a handle
 *  the owner may still be paying for as lapsed. */
describe('ddns poller — standing down on an ownership refusal', () => {
  const mismatch = () => ({ ok: false as const, error: 'ddns_handle_mismatch' as const });

  it('stops re-publishing after the cloud says the handle is not ours', async () => {
    const update = vi.fn<DdnsUpdateClient['update']>(async () => mismatch());
    const poller = composeHarness({ update });

    await poller.runTick();
    expect(update).toHaveBeenCalledTimes(1);

    // Every subsequent tick inside the backoff must not reach the cloud at all.
    await poller.runTick();
    await poller.runTick();
    expect(update, 'a permanent refusal must not be retried every tick').toHaveBeenCalledTimes(1);
  });

  /** ⚠ AND IT MUST STILL RECOVER UNATTENDED. If the owner moves the handle back,
   *  the server has to resume without a restart — the same requirement the lapse
   *  branch carries, for the same reason. */
  it('resumes once the refusal stops', async () => {
    // ⚠ Typed as the real result union, not a hand-rolled shape — the `as never`
    // that was here papered over a wrong generic and would have hidden a genuine
    // mismatch between the fake and the client contract.
    let answer: Awaited<ReturnType<DdnsUpdateClient['update']>> = mismatch();
    const update = vi.fn<DdnsUpdateClient['update']>(async () => answer);
    const poller = composeHarness({ update });

    await poller.runTick();
    expect(update).toHaveBeenCalledTimes(1);

    // Past the backoff window, the poller probes again.
    // Past the first backoff step, which is an hour — not a guess: see
    // LAPSE_BACKOFF_START_MS in the poller.
    vi.advanceTimersByTime(61 * 60 * 1000);
    answer = { ok: true as const, data: updateResponse() };
    await poller.runTick();
    expect(update, 'the stand-down must be a pause, not a stop').toHaveBeenCalledTimes(2);
  });

  it('does not mark the handle lapsed — that is a different fact', async () => {
    const applyLifecycleUpdate = vi.fn(async () => {});
    const update = vi.fn<DdnsUpdateClient['update']>(async () => mismatch());
    const poller = composeHarness({
      update,
      applyLifecycle: () => ({ applyLifecycleUpdate }),
    });
    await poller.runTick();

    expect(update, 'the refusal must have been reached').toHaveBeenCalledTimes(1);
    expect(
      applyLifecycleUpdate,
      'an ownership refusal must not be recorded as a subscription lapse',
    ).not.toHaveBeenCalled();
  });
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

  /** ⚠ THE FIXTURE GAINED `published_targets`, AND THAT IS THE POINT OF THE
   *  TEST, not noise in it. The property is "this target was acknowledged at
   *  this IP, so do not post again". A snapshot WITHOUT `published_targets`
   *  records an IP and a timestamp and nothing about which handle it was for —
   *  it cannot express "already published" about any particular name, and the
   *  branch that used to infer one is gone (see the poller). */
  it('skips the POST when the resolved IPv4 matches the last published IPv4', async () => {
    const ipStateStore = createSpyIpStore({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_100_000,
      published_targets: [{ publisher_id: 'pub_test_01', handle: 'alice' }],
    });
    const harness = composeHarness({ ipStateStore });

    await harness.runTick();

    expect(harness.update).not.toHaveBeenCalled();
    expect(ipStateStore.save).not.toHaveBeenCalled();
  });

  /** ⛔⛔⛔ THE OUTAGE A RENAME WOULD HAVE CAUSED ON A LEGACY ROW.
   *
   *  A pre-D-152 snapshot has no `published_targets`, and the poller used to
   *  mark every `source: 'handle_state'` target as already acknowledged — sound
   *  while a handle could not change, an outage once a dashboard rename migrates
   *  it. The NEW name was marked published without ever being posted; the old
   *  name stopped being a target; nothing published, so the row was never
   *  upgraded and the skip repeated every tick. The reservation moves, the cert
   *  is issued, and the A record is never written — after the ~24h soft redirect
   *  the server answers at NEITHER name.
   *
   *  🔑 The legacy row cannot say which handle it was for, so "I do not know"
   *  must read as "nothing", not as "whatever it is called now". */
  it('publishes the handle target on a legacy snapshot — it cannot know what was published', async () => {
    const ipStateStore = createSpyIpStore({
      ip_v4: '203.0.113.10',
      last_published_at: 1_700_000_100_000,
    });
    const harness = composeHarness({ ipStateStore });

    await harness.runTick();

    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'alice', ip_v4: '203.0.113.10' }),
    );
    // ⚠ And the redundant post is paid ONCE: the success writes a modern row,
    // so the next tick dedups normally.
    expect(ipStateStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        published_targets: [{ publisher_id: 'pub_test_01', handle: 'alice' }],
      }),
    );
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

    // ⚠ NOW BOTH, and the registry half is still what this test is for. The
    // handle target joins it because a legacy row can no longer be read as
    // "the current handle was already published" — one redundant post, once.
    expect(harness.update).toHaveBeenCalledTimes(2);
    expect(harness.update).toHaveBeenCalledWith({
      publisher_id: 'publisher-bob',
      handle: 'bob',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });
    expect(ipStateStore.save).toHaveBeenLastCalledWith({
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

/** ⛔⛔⛔ AN UNBOUND SERVER PROBED FOREVER FOR A SUBSCRIPTION THAT WAS NEVER
 *  COMING BACK.
 *
 *  `deactivateAuthorityRow` (unbind / account deletion) and the Paddle path
 *  (a lapsed subscription) both wrote `subscription_active: false`, so the cloud
 *  answered both with `ddns_subscription_lapsed` and the poller — correctly, for
 *  what it was told — kept probing on the lapse backoff. The distinction was
 *  destroyed at WRITE TIME in KV, which is why the fix needed a field on the
 *  authority row before it could need an error code.
 *
 *  🔑 THIS IS THE ONLY REFUSAL THE POLLER TREATS AS TERMINAL. A lapse resolves
 *  when the owner pays; a handle mismatch now self-heals when the provisioner
 *  re-targets. Retirement resolves only when the owner BINDS this machine again
 *  — an action taken elsewhere, not a state that can be waited out.
 */
describe('ddns poller — standing down when the cloud says the server is retired', () => {
  const retired = () => ({ ok: false as const, error: 'ddns_publisher_retired' as const });

  /** ⛔⛔⛔ AND IT HAS TO BE ABLE TO COME BACK. The stand-down used to be a
   *  PRIVATE `let retired = false` that nothing could clear, so an owner who
   *  reconnected their server got no DDNS publishing until the process restarted
   *  — Pro card healthy, provisioner working, hostname quietly stale. A
   *  stand-down with no resume path is only correct if the state is permanent,
   *  and this one is not: reconnecting is the whole remedy.
   *
   *  🔑 The poller cannot notice the reconnection itself — noticing would mean
   *  asking the cloud, which is exactly what it has stopped doing. The mint
   *  detector sees it within a tick and clears the shared flag. */
  it('resumes when the shared flag is cleared, without a restart', async () => {
    const disownedFlag = createServerDisownedFlag();
    let answer: Awaited<ReturnType<DdnsUpdateClient['update']>> = retired();
    const update = vi.fn<DdnsUpdateClient['update']>(async () => answer);
    const poller = composeHarness({ update, disownedFlag });

    await poller.runTick();
    expect(update).toHaveBeenCalledTimes(1);
    await poller.runTick();
    expect(update, 'stood down').toHaveBeenCalledTimes(1);

    // The owner reconnects; the mint detector clears the flag.
    disownedFlag.markConnected();
    answer = { ok: true as const, data: updateResponse() };
    await poller.runTick();

    expect(
      update,
      'a reconnected server must publish again without restarting',
    ).toHaveBeenCalledTimes(2);
  });

  /** ⚠ THE CLOCK HAS TO MOVE, OR THIS TEST CANNOT TELL STOPPED FROM BACKED-OFF.
   *  The first version looped five ticks without advancing time, and a backoff
   *  suppresses those too — so replacing the stand-down with `advanceBackoff()`
   *  left it green. The lapse backoff caps at 6h, so the clock walks a week past
   *  it: a poller that is merely pacing WILL post again in that window, and a
   *  retired one never will. */
  it('stops publishing entirely, rather than backing off', async () => {
    let clock = 1_700_000_000_000;
    const update = vi.fn<DdnsUpdateClient['update']>(async () => retired());
    const poller = composeHarness({ update, now: () => clock, disownedFlag: createServerDisownedFlag() });

    await poller.runTick();
    expect(update).toHaveBeenCalledTimes(1);

    // A week, in 6-hour strides — every one of them past the backoff ceiling.
    for (let i = 0; i < 28; i += 1) {
      clock += 6 * 60 * 60 * 1000;
      await poller.runTick();
    }
    expect(
      update,
      'a backoff would have posted again within the week — this must be terminal',
    ).toHaveBeenCalledTimes(1);
  });

  /** ⚠ AND IT MUST NOT LOOK LIKE A LAPSE. `recordLapse` writes the handle
   *  lifecycle through the state machine; retirement is an OWNERSHIP fact about
   *  this machine, not a subscription fact about the account — the owner may
   *  still be paying, and labelling their handle lapsed would be wrong. */
  it('does not write a lapse lifecycle', async () => {
    const applyLifecycle = vi.fn();
    const update = vi.fn<DdnsUpdateClient['update']>(async () => retired());
    const poller = composeHarness({ update, applyLifecycle, disownedFlag: createServerDisownedFlag() });

    await poller.runTick();

    expect(applyLifecycle).not.toHaveBeenCalled();
  });

  /** ⚠ THE POLLER REPORTS; IT DOES NOT DECIDE. The entitlement mint sees the
   *  same disconnection on its own five-minute cadence, so the once-only rule
   *  lives in the announcer — a `console.warn` here plus a notification there
   *  would tell the owner twice about one event. */
  it('reports the disconnection exactly once, and only to the announcer', async () => {
    const announceDisconnect = vi.fn(async () => true);
    const update = vi.fn<DdnsUpdateClient['update']>(async () => retired());
    const poller = composeHarness({ update, announceDisconnect, disownedFlag: createServerDisownedFlag() });

    await poller.runTick();
    await poller.runTick();

    expect(announceDisconnect).toHaveBeenCalledTimes(1);
    expect(announceDisconnect).toHaveBeenCalledWith('ddns_publish');
  });

  /** ⚠ AND AN ANNOUNCER THAT THROWS MUST NOT COST THE STAND-DOWN — the point of
   *  the branch is to stop publishing; telling the owner is the bonus. */
  it('stands down even when announcing fails', async () => {
    const announceDisconnect = vi.fn(async () => { throw new Error('bus down'); });
    const update = vi.fn<DdnsUpdateClient['update']>(async () => retired());
    const poller = composeHarness({ update, announceDisconnect, disownedFlag: createServerDisownedFlag() });

    await poller.runTick();
    await poller.runTick();

    expect(update, 'the stand-down must survive a failed announcement').toHaveBeenCalledTimes(1);
  });

  /** ⛔ NOT PERSISTED, AND THAT IS THE DESIGN. A fresh process re-ASKS rather
   *  than assuming, so a server rebound while it was down resumes on its first
   *  tick instead of staying dead until someone notices. One request per process
   *  start is the price; stopping 288/day was the goal. */
  it('a fresh process asks again instead of staying dead', async () => {
    const first = vi.fn<DdnsUpdateClient['update']>(async () => retired());
    const stopped = composeHarness({ update: first, disownedFlag: createServerDisownedFlag() });
    await stopped.runTick();
    await stopped.runTick();
    expect(first).toHaveBeenCalledTimes(1);

    // A new process — same server, owner has since reconnected it.
    const second = composeHarness({});
    await second.runTick();
    expect(second.update, 'a restart must re-ask, not inherit the stand-down').toHaveBeenCalled();
  });
});

/** ⛔⛔⛔ THE FEATURE WAS DEAD ON THE WIRE AND 8,587 TESTS WERE GREEN.
 *
 *  `ddns_publisher_retired` was defined in contracts, returned by the cloud and
 *  branched on by the poller — and collapsed to `'network_error'` in the update
 *  client, because its runtime allowlist was a hand-written
 *  `new Set<DdnsErrorCode>([...])`. Adding a member to the union does not force
 *  adding it to a Set literal; the literal is merely assignable.
 *
 *  🔑 EVERY POLLER TEST STUBBED THE CLIENT and handed the branch a value the real
 *  parser could not produce. A stub proves the call, not the message — so this
 *  drives the REAL client with a real 403 body, which is the only place the
 *  allowlist is reachable.
 */
describe('update client — a new cloud error code survives the parse', () => {
  const errorResponse = (code: string, status: number) =>
    jsonResponse({ error: { code, message: 'nope' } }, { status });

  it('surfaces ddns_publisher_retired instead of collapsing it to network_error', async () => {
    const { client } = createClientHarness(errorResponse('ddns_publisher_retired', 403));
    const result = await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });
    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.error,
      'collapsed to network_error — the poller stand-down can never fire',
    ).toBe('ddns_publisher_retired');
  });

  /** ⚠ AND THE COLLAPSE ITSELF STILL WORKS — it is the right answer for a code
   *  this build genuinely does not know, which is what an older server sees when
   *  the cloud ships one first. Retrying is correct there; silently adopting an
   *  unknown code would not be. */
  it('still collapses a code it has never heard of', async () => {
    const { client } = createClientHarness(errorResponse('ddns_from_the_future', 403));
    const result = await client.update({
      publisher_id: 'pub_test_01',
      handle: 'alice',
      ip_v4: '203.0.113.10',
      timestamp: fixedTimestamp,
    });
    expect(result.ok === false && result.error).toBe('network_error');
  });
});
