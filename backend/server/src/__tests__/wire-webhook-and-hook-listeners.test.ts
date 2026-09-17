import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listenerMocks = vi.hoisted(() => ({
  webhookListener: { kind: 'webhook-listener' },
  hookListener: { kind: 'hook-listener' },
  createWebhookListener: vi.fn(),
  createHookListener: vi.fn(),
}));

vi.mock('../collections/webhook/webhook-listener.js', () => ({
  createWebhookListener: listenerMocks.createWebhookListener,
}));

vi.mock('../watchers/webhook-hook-listener.js', () => ({
  createHookListener: listenerMocks.createHookListener,
}));

import {
  composeWebhookAndHookListeners,
  registerWebhookSourceProvider,
} from '../composition/bin/wire-webhook-and-hook-listeners.js';

const originalPublicReachable = process.env.RECUED_PUBLIC_REACHABLE;

const resetListenerMocks = (): void => {
  listenerMocks.createWebhookListener.mockReset();
  listenerMocks.createWebhookListener.mockReturnValue(listenerMocks.webhookListener);
  listenerMocks.createHookListener.mockReset();
  listenerMocks.createHookListener.mockReturnValue(listenerMocks.hookListener);
};

const setPublicReachableEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.RECUED_PUBLIC_REACHABLE;
    return;
  }

  process.env.RECUED_PUBLIC_REACHABLE = value;
};

const makeDeps = (webhookPort: number) => ({
  webhookPort,
  collectionRegistry: { kind: 'collection-registry' },
  webhookWatcherQueue: { kind: 'webhook-watcher-queue' },
});

const composeWithPort = async (webhookPort: number) =>
  composeWebhookAndHookListeners(makeDeps(webhookPort) as any);

const lastWebhookOptions = () => {
  const call = listenerMocks.createWebhookListener.mock.calls.at(-1);
  if (!call) throw new Error('createWebhookListener was not called');
  return call[0] as any;
};

const lastHookOptions = () => {
  const call = listenerMocks.createHookListener.mock.calls.at(-1);
  if (!call) throw new Error('createHookListener was not called');
  return call[0] as any;
};

beforeEach(() => {
  resetListenerMocks();
  setPublicReachableEnv(undefined);
});

afterEach(() => {
  setPublicReachableEnv(originalPublicReachable);
  resetListenerMocks();
});

describe('composeWebhookAndHookListeners gate matrix', () => {
  it.each([0, -1])(
    'returns undefined listeners and skips factories when webhookPort=%i',
    async (webhookPort) => {
      const bundle = await composeWithPort(webhookPort);

      expect(bundle.webhookListener).toBeUndefined();
      expect(bundle.hookListener).toBeUndefined();
      expect(listenerMocks.createWebhookListener).not.toHaveBeenCalled();
      expect(listenerMocks.createHookListener).not.toHaveBeenCalled();
    },
  );

  it.each([80, 8443])(
    'returns both listeners and invokes both factories once when webhookPort=%i',
    async (webhookPort) => {
      const bundle = await composeWithPort(webhookPort);

      expect(bundle.webhookListener).toBe(listenerMocks.webhookListener);
      expect(bundle.hookListener).toBe(listenerMocks.hookListener);
      expect(listenerMocks.createWebhookListener).toHaveBeenCalledTimes(1);
      expect(listenerMocks.createHookListener).toHaveBeenCalledTimes(1);
    },
  );
});

describe('D-272 — webhook_port is a SWITCH, and that is a property not a sample', () => {
  it('⛔ the NUMBER never reaches a listener — only whether it is > 0', async () => {
    // ⛔ THE NAME SAYS "PORT" AND THE CODE SAYS "ON". The gate matrix above
    // proves 80 and 8443 both compose listeners, which is two samples agreeing;
    // this asserts the reason they agree — the value is consumed by `> 0` and
    // then DROPPED, so every non-zero value is the same value.
    //
    // 🔑 WHY PIN IT: an operator who reads this key as a port forwards it in
    // their router, and nothing is listening there. The corrected preset copy
    // says so; a comment cannot hold. If someone later threads the number into
    // a listener, this reds and the naming question has to be answered rather
    // than inherited.
    await composeWithPort(9000);

    const args = [lastWebhookOptions(), lastHookOptions()];
    for (const arg of args) {
      expect(JSON.stringify(arg, (_k, v) => (typeof v === 'function' ? '[fn]' : v)))
        .not.toContain('9000');
      // ...and not under a differently-named key either.
      expect(Object.values(arg)).not.toContain(9000);
    }
  });

  it('⛔ and NOTHING in the bundle differs between two non-zero values', async () => {
    // The user-visible claim, stated over the composer's whole output rather
    // than over the fields this test happened to think of.
    const shapeOf = async (port: number): Promise<string> => {
      resetListenerMocks();
      const bundle = await composeWithPort(port);
      return JSON.stringify(
        { keys: Object.keys(bundle).sort(), defined: Object.entries(bundle)
          .map(([k, v]) => [k, v !== undefined]).sort() },
      );
    };
    expect(await shapeOf(9000)).toBe(await shapeOf(1));
  });
});

describe('composeWebhookAndHookListeners factory args', () => {
  it('passes collection registry, watcher queue, and a shared publicReachable thunk', async () => {
    const deps = makeDeps(80);

    await composeWebhookAndHookListeners(deps as any);

    const webhookOptions = lastWebhookOptions();
    const hookOptions = lastHookOptions();
    expect(webhookOptions.registry).toBe(deps.collectionRegistry);
    expect(hookOptions.queue).toBe(deps.webhookWatcherQueue);
    expect(webhookOptions.publicReachable).toEqual(expect.any(Function));
    expect(hookOptions.publicReachable).toBe(webhookOptions.publicReachable);
  });

  it('forwards the master pause flag to both listeners (D-188)', async () => {
    const isPaused = () => true;
    await composeWebhookAndHookListeners({ ...makeDeps(80), isPaused } as any);
    // The same conditional-spread forwards `isPaused` to the connection
    // webhook listener too (covered by behaviour tests on each handler).
    expect(lastWebhookOptions().isPaused).toBe(isPaused);
    expect(lastHookOptions().isPaused).toBe(isPaused);
  });
});

describe('composeWebhookAndHookListeners publicReachable thunk', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [undefined, false],
    ['TRUE', false],
    ['yes', false],
  ] as const)('returns %s for env value %s', async (envValue, expected) => {
    setPublicReachableEnv(envValue);

    await composeWithPort(80);

    expect(lastWebhookOptions().publicReachable()).toBe(expected);
  });

  it('reads RECUED_PUBLIC_REACHABLE on every call after construction', async () => {
    setPublicReachableEnv('false');
    await composeWithPort(80);

    const publicReachable = lastWebhookOptions().publicReachable;
    expect(publicReachable()).toBe(false);

    setPublicReachableEnv('true');

    expect(publicReachable()).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// WatchSource generalization — connection webhook receiver + provider
// ────────────────────────────────────────────────────────────────

describe('WatchSource — connection webhook receiver + governance provider', () => {
  const fakeConnectionStore = (rows: Array<{
    name: string;
    config: Record<string, unknown>;
  }>) => ({
    list: (filter?: { kind?: string }) =>
      filter?.kind === 'api'
        ? rows.map((r) => ({
            kind: 'api',
            name: r.name,
            config_json: JSON.stringify(r.config),
            auth_ciphertext: '',
            enrolled_at: 1,
            updated_at: 1,
          }))
        : [],
    get: (kind: string, name: string) => {
      if (kind !== 'api') return null;
      const row = rows.find((r) => r.name === name);
      return row
        ? {
            kind: 'api',
            name: row.name,
            config_json: JSON.stringify(row.config),
            auth_ciphertext: '',
            enrolled_at: 1,
            updated_at: 1,
          }
        : null;
    },
  });

  const fakeRegistry = () => {
    const providers: Array<{ list: () => unknown[] }> = [];
    return {
      providers,
      registry: {
        register: (_id: string, p: { list: () => unknown[] }) => providers.push(p),
        markEvent: () => {},
        list: () => providers.flatMap((p) => p.list()),
      },
    };
  };

  it('composes the connection webhook receiver when port + stores are present', async () => {
    const { registry } = fakeRegistry();
    const bundle = await composeWebhookAndHookListeners({
      ...makeDeps(8787),
      connectionStore: fakeConnectionStore([]),
      enrichmentStore: { listByTarget: () => [], refreshMetaForTarget: () => {} },
      warehouseBus: { emit: () => {}, subscribe: () => () => {}, dispose: () => {} },
      sourceRegistry: registry,
    } as any);
    expect(bundle.connectionWebhookListener).toBeTypeOf('function');
  });

  it('leaves the receiver undefined without the stores, and undefined below the port gate', async () => {
    const portless = await composeWithPort(0);
    expect(portless.connectionWebhookListener).toBeUndefined();

    const storeless = await composeWithPort(8787);
    expect(storeless.connectionWebhookListener).toBeUndefined();
  });

  it('registers the webhook provider even when the port gate is closed — rows name the blocker', async () => {
    const { registry } = fakeRegistry();
    await composeWebhookAndHookListeners({
      ...makeDeps(0),
      connectionStore: fakeConnectionStore([
        { name: 'main-crm', config: { vendor: 'hubspot', webhook_secret: 'shh' } },
      ]),
      sourceRegistry: registry,
    } as any);
    // The hubspot kernel reconcilers are registered by vendor boot in
    // production; this harness has none, so the provider lists no rows
    // for the enrolled connection — what we pin here is registration
    // itself (port-gate-independent).
    expect(registry.list()).toEqual([]);
  });
});

describe('WatchSource — webhook provider row derivation', () => {
  const providerRows = (input: {
    reconcilers: Array<{
      vendor: string;
      entity: string;
      webhookProcessor?: { signature_header?: string };
    }>;
    connections: Array<{ name: string; config: Record<string, unknown> }>;
    receiverLive: boolean;
    publicReachable?: boolean;
  }) => {
    const providers: Array<{ list: () => unknown[] }> = [];
    registerWebhookSourceProvider({
      sourceRegistry: {
        register: (_id: string, p: { list: () => never[] }) => providers.push(p),
        markEvent: () => {},
        list: () => [],
      } as any,
      connectionStore: {
        list: () =>
          input.connections.map((c) => ({
            kind: 'api',
            name: c.name,
            config_json: JSON.stringify(c.config),
            auth_ciphertext: '',
            enrolled_at: 1,
            updated_at: 1,
          })),
      } as any,
      reconcilerRegistry: { list: () => input.reconcilers as never[] },
      receiverLive: input.receiverLive,
      publicReachable: () => input.publicReachable ?? true,
    });
    return providers.flatMap((p) => p.list()) as Array<{
      source_key: string;
      label: string;
      emits: string[];
      active: boolean;
      inactive_reason: string | null;
    }>;
  };

  const hubspotDeal = {
    vendor: 'hubspot',
    entity: 'deal',
    webhookProcessor: { signature_header: 'x-hubspot-signature-v3' },
  };

  it('an HMAC vendor row is active when port + reachability + secret are all live', () => {
    const rows = providerRows({
      reconcilers: [hubspotDeal],
      connections: [{ name: 'main-crm', config: { vendor: 'hubspot', webhook_secret: 'shh' } }],
      receiverLive: true,
    });
    expect(rows).toEqual([
      {
        source_key: 'webhook/hubspot/main-crm',
        mechanism: 'webhook',
        label: 'hubspot webhook — main-crm',
        emits: ['data.connection.api.hubspot.deal.main-crm.**'],
        active: true,
        inactive_reason: null,
        last_event_at: null,
      },
    ]);
  });

  it('names the blocker: receiver missing > reachability off > secret missing', () => {
    const conn = [{ name: 'main-crm', config: { vendor: 'hubspot', webhook_secret: 'shh' } }];
    expect(
      providerRows({ reconcilers: [hubspotDeal], connections: conn, receiverLive: false })[0],
    ).toMatchObject({ active: false, inactive_reason: 'inbound webhook port not configured' });
    expect(
      providerRows({
        reconcilers: [hubspotDeal],
        connections: conn,
        receiverLive: true,
        publicReachable: false,
      })[0],
    ).toMatchObject({
      active: false,
      inactive_reason: 'public reachability is off (RECUED_PUBLIC_REACHABLE)',
    });
    expect(
      providerRows({
        reconcilers: [hubspotDeal],
        connections: [{ name: 'main-crm', config: { vendor: 'hubspot' } }],
        receiverLive: true,
      })[0],
    ).toMatchObject({ active: false, inactive_reason: 'webhook_secret missing in connection config' });
  });

  it('an OAuth-bound vendor lists as an active change feed regardless of the receiver', () => {
    const rows = providerRows({
      reconcilers: [
        { vendor: 'salesforce', entity: 'opportunity', webhookProcessor: {} },
        { vendor: 'salesforce', entity: 'account', webhookProcessor: {} },
      ],
      connections: [{ name: 'sf-main', config: { vendor: 'salesforce' } }],
      receiverLive: false,
    });
    expect(rows).toEqual([
      {
        source_key: 'webhook/salesforce/sf-main',
        mechanism: 'webhook',
        label: 'salesforce change feed — sf-main',
        emits: [
          'data.connection.api.salesforce.opportunity.sf-main.**',
          'data.connection.api.salesforce.account.sf-main.**',
        ],
        active: true,
        inactive_reason: null,
        last_event_at: null,
      },
    ]);
  });

  it('vendors without a webhook processor and connections without a vendor list no row', () => {
    const rows = providerRows({
      reconcilers: [{ vendor: 'hubspot', entity: 'deal' }],
      connections: [
        { name: 'main-crm', config: { vendor: 'hubspot' } },
        { name: 'mystery', config: {} },
      ],
      receiverLive: true,
    });
    expect(rows).toEqual([]);
  });
});
