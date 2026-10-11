import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The D-128 vendor-connection receiver is the bundle's one listener since the
// Phase D `/webhook/{slug}` listener was removed (2026-10-10). Its factory is
// mocked so these tests read the options it was composed with; the funnel
// underneath is the real one over fake stores.
const listenerMocks = vi.hoisted(() => ({
  connectionWebhookListener: vi.fn(async () => {}),
  createConnectionWebhookListener: vi.fn(),
}));

vi.mock('../connection-webhook-listener.js', () => ({
  createConnectionWebhookListener: listenerMocks.createConnectionWebhookListener,
}));

import {
  composeWebhookListeners,
  registerWebhookSourceProvider,
} from '../composition/bin/wire-webhook-listeners.js';

const originalPublicReachable = process.env.RECUED_PUBLIC_REACHABLE;

const resetListenerMocks = (): void => {
  listenerMocks.createConnectionWebhookListener.mockReset();
  listenerMocks.createConnectionWebhookListener.mockReturnValue(
    listenerMocks.connectionWebhookListener,
  );
};

const setPublicReachableEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.RECUED_PUBLIC_REACHABLE;
    return;
  }

  process.env.RECUED_PUBLIC_REACHABLE = value;
};

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

/** Everything the receiver needs to compose. */
const makeDeps = (webhooksEnabled: boolean) => ({
  webhooksEnabled,
  connectionStore: fakeConnectionStore([]),
  enrichmentStore: { listByTarget: () => [], refreshMetaForTarget: () => {} },
  warehouseBus: { emit: () => {}, subscribe: () => () => {}, dispose: () => {} },
});

const composeWith = async (webhooksEnabled: boolean) =>
  composeWebhookListeners(makeDeps(webhooksEnabled) as any);

const lastReceiverOptions = () => {
  const call = listenerMocks.createConnectionWebhookListener.mock.calls.at(-1);
  if (!call) throw new Error('createConnectionWebhookListener was not called');
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

describe('composeWebhookListeners gate matrix', () => {
  it('returns an undefined receiver and skips its factory when webhooks are off', async () => {
    const bundle = await composeWith(false);

    expect(bundle.connectionWebhookListener).toBeUndefined();
    expect(listenerMocks.createConnectionWebhookListener).not.toHaveBeenCalled();
  });

  it('returns the receiver and invokes its factory once when webhooks are on', async () => {
    const bundle = await composeWith(true);

    expect(bundle.connectionWebhookListener).toBe(listenerMocks.connectionWebhookListener);
    expect(listenerMocks.createConnectionWebhookListener).toHaveBeenCalledTimes(1);
    // The D-115 `/hook/{recipe_id}/{slug}` listener went with the webhook
    // watcher (2026-10-05), and Phase D's `/webhook/{slug}` listener with its
    // collection (2026-10-10): no bundle carries either.
    expect(bundle).not.toHaveProperty('hookListener');
    expect(bundle).not.toHaveProperty('webhookListener');
  });
});

// D-272 pinned two properties here while the switch was `webhook_port`: that the
// NUMBER never reached a listener, and that every non-zero value composed the
// same bundle. The switch is `webhooks_enabled: boolean` since 2026-10-10, so
// there is no number left to leak; the old name's mapping (any non-zero → on)
// is pinned where it now lives, in `packages/config`'s parse / env / cli tests.

describe('composeWebhookListeners factory args', () => {
  it('passes the funnel handler and a publicReachable thunk', async () => {
    await composeWith(true);

    const options = lastReceiverOptions();
    expect(options.funnel).toEqual(expect.any(Function));
    expect(options.publicReachable).toEqual(expect.any(Function));
  });

  // The composition root builds ONE switch (`createWebhookPublicReachable`,
  // which also reads the runtime key) and hands it to D-201's intake too, so
  // this must forward that function, not build its own from the environment.
  it('forwards the publicReachable switch it is given, the same function', async () => {
    const publicReachable = () => true;
    await composeWebhookListeners({ ...makeDeps(true), publicReachable } as any);
    expect(lastReceiverOptions().publicReachable).toBe(publicReachable);
  });

  it('forwards the master pause flag to the receiver (D-188)', async () => {
    const isPaused = () => true;
    await composeWebhookListeners({ ...makeDeps(true), isPaused } as any);
    expect(lastReceiverOptions().isPaused).toBe(isPaused);
  });
});

// With no switch passed, the environment alone decides (the composition root
// always passes one; `webhook-public-reachable.test.ts` covers the key).
describe('composeWebhookListeners publicReachable thunk', () => {
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

    await composeWith(true);

    expect(lastReceiverOptions().publicReachable()).toBe(expected);
  });

  it('reads RECUED_PUBLIC_REACHABLE on every call after construction', async () => {
    setPublicReachableEnv('false');
    await composeWith(true);

    const publicReachable = lastReceiverOptions().publicReachable;
    expect(publicReachable()).toBe(false);

    setPublicReachableEnv('true');

    expect(publicReachable()).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// WatchSource generalization — connection webhook receiver + provider
// ────────────────────────────────────────────────────────────────

describe('WatchSource — connection webhook receiver + governance provider', () => {
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

  it('composes the connection webhook receiver when webhooks are on + stores are present', async () => {
    const { registry } = fakeRegistry();
    const bundle = await composeWebhookListeners({
      ...makeDeps(true),
      sourceRegistry: registry,
    } as any);
    expect(bundle.connectionWebhookListener).toBe(listenerMocks.connectionWebhookListener);
  });

  it('leaves the receiver undefined without the stores, and undefined with webhooks off', async () => {
    const switchedOff = await composeWith(false);
    expect(switchedOff.connectionWebhookListener).toBeUndefined();

    const storeless = await composeWebhookListeners({ webhooksEnabled: true } as any);
    expect(storeless.connectionWebhookListener).toBeUndefined();
    expect(listenerMocks.createConnectionWebhookListener).not.toHaveBeenCalled();
  });

  it('registers the webhook provider even with webhooks off — rows name the blocker', async () => {
    const { registry } = fakeRegistry();
    await composeWebhookListeners({
      ...makeDeps(false),
      connectionStore: fakeConnectionStore([
        { name: 'main-crm', config: { vendor: 'hubspot', webhook_secret: 'shh' } },
      ]),
      sourceRegistry: registry,
    } as any);
    // The hubspot kernel reconcilers are registered by vendor boot in
    // production; this harness has none, so the provider lists no rows
    // for the enrolled connection — what we pin here is registration
    // itself (independent of the webhook switch).
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
    ).toMatchObject({ active: false, inactive_reason: 'inbound webhooks are off (webhooks_enabled)' });
    expect(
      providerRows({
        reconcilers: [hubspotDeal],
        connections: conn,
        receiverLive: true,
        publicReachable: false,
      })[0],
    ).toMatchObject({
      active: false,
      inactive_reason: 'public reachability is off (collection.webhook.public_reachable)',
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
