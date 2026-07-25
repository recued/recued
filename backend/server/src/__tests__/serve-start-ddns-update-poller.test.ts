import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const ddnsMocks = vi.hoisted(() => ({
  composeDdnsUpdatePoller: vi.fn(),
  createSqliteHandleStateStore: vi.fn(),
  createSqliteDdnsIpStateStore: vi.fn(),
  createSqliteDdnsEnabledStore: vi.fn(),
  createHostnameRegistryStore: vi.fn(),
  createProSubscriptionStateStore: vi.fn(),
  createDdnsUpdateClient: vi.fn(),
  fetchPublicIpv4: vi.fn(),
}));

vi.mock('../composition/bin/wire-ddns-update-poller.js', () => ({
  composeDdnsUpdatePoller: ddnsMocks.composeDdnsUpdatePoller,
}));

vi.mock('../handle/sqlite-store.js', () => ({
  createSqliteHandleStateStore: ddnsMocks.createSqliteHandleStateStore,
}));

vi.mock('../ddns/ip-state-store.js', () => ({
  createSqliteDdnsIpStateStore: ddnsMocks.createSqliteDdnsIpStateStore,
}));

vi.mock('../ddns/ddns-enabled-store.js', () => ({
  createSqliteDdnsEnabledStore: ddnsMocks.createSqliteDdnsEnabledStore,
}));

vi.mock('../storage/hostname-registry.js', () => ({
  createHostnameRegistryStore: ddnsMocks.createHostnameRegistryStore,
}));

vi.mock('../hostname/pro-subscription-state.js', () => ({
  createProSubscriptionStateStore: ddnsMocks.createProSubscriptionStateStore,
}));

vi.mock('../ddns/update-client.js', () => ({
  createDdnsUpdateClient: ddnsMocks.createDdnsUpdateClient,
}));

vi.mock('../cli/url-enumerate.js', () => ({
  fetchPublicIpv4: ddnsMocks.fetchPublicIpv4,
}));

import type Database from 'better-sqlite3';
import { fetchPublicIpv4 } from '../cli/url-enumerate.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import {
  startDdnsUpdatePoller,
  type StartDdnsUpdatePollerOptions,
} from '../serve/start-ddns-update-poller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const startDdnsUpdatePollerPath = join(
  repoRoot,
  'backend/server/src/serve/start-ddns-update-poller.ts',
);
const startPostHousekeepingTailPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-housekeeping-tail.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeBackgroundServices = (): BackgroundServiceRegistry =>
  ({
    register: vi.fn(),
    registerInterval: vi.fn(),
    stopAll: vi.fn(),
    list: vi.fn(() => []),
  }) as unknown as BackgroundServiceRegistry;

const makeIdentity = (
  label: string,
): { value: BootedServerIdentity; sign: ReturnType<typeof vi.fn> } => {
  const sign = vi.fn((canonical: string) => `${label}:${canonical}`);
  return {
    value: {
      identity: { signWithServerIdentity: sign },
    } as unknown as BootedServerIdentity,
    sign,
  };
};

const makeOptions = (
  overrides: Partial<StartDdnsUpdatePollerOptions> = {},
): StartDdnsUpdatePollerOptions => {
  const identity = makeIdentity('initial');
  return {
    db: { tag: 'db' } as unknown as Database.Database,
    backgroundServices: makeBackgroundServices(),
    cloudBaseUrl: 'https://cloud.test',
    getSigningIdentity: vi.fn(() => identity.value),
    ...overrides,
  };
};

beforeEach(() => {
  ddnsMocks.composeDdnsUpdatePoller.mockReset();
  ddnsMocks.createSqliteHandleStateStore.mockReset();
  ddnsMocks.createSqliteDdnsIpStateStore.mockReset();
  ddnsMocks.createSqliteDdnsEnabledStore.mockReset();
  ddnsMocks.createHostnameRegistryStore.mockReset();
  ddnsMocks.createProSubscriptionStateStore.mockReset();
  ddnsMocks.createDdnsUpdateClient.mockReset();
  ddnsMocks.fetchPublicIpv4.mockReset();
  ddnsMocks.createSqliteHandleStateStore.mockReturnValue({ tag: 'handle-store' });
  ddnsMocks.createSqliteDdnsIpStateStore.mockReturnValue({ tag: 'ip-state-store' });
  ddnsMocks.createSqliteDdnsEnabledStore.mockReturnValue({ tag: 'ddns-enabled-store' });
  ddnsMocks.createHostnameRegistryStore.mockReturnValue({ tag: 'hostname-registry' });
  ddnsMocks.createProSubscriptionStateStore.mockReturnValue({ tag: 'subscription-state' });
  ddnsMocks.createDdnsUpdateClient.mockReturnValue({ tag: 'update-client' });
});

describe('startDdnsUpdatePoller', () => {
  it('does not compose the poller without a database handle', () => {
    startDdnsUpdatePoller(makeOptions({ db: undefined }));

    expect(ddnsMocks.createSqliteHandleStateStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createSqliteDdnsIpStateStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createHostnameRegistryStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createProSubscriptionStateStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createDdnsUpdateClient).not.toHaveBeenCalled();
    expect(ddnsMocks.composeDdnsUpdatePoller).not.toHaveBeenCalled();
  });

  it('does not compose the poller without a signing identity', () => {
    const getSigningIdentity = vi.fn(() => undefined);

    startDdnsUpdatePoller(makeOptions({ getSigningIdentity }));

    expect(getSigningIdentity).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createSqliteHandleStateStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createHostnameRegistryStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createProSubscriptionStateStore).not.toHaveBeenCalled();
    expect(ddnsMocks.createDdnsUpdateClient).not.toHaveBeenCalled();
    expect(ddnsMocks.composeDdnsUpdatePoller).not.toHaveBeenCalled();
  });

  it('wires the DDNS stores, client, IPv4 resolver, and live signing closure', () => {
    const db = { tag: 'db' } as unknown as Database.Database;
    const backgroundServices = makeBackgroundServices();
    const firstIdentity = makeIdentity('first');
    const secondIdentity = makeIdentity('second');
    let currentIdentity = firstIdentity.value;
    const getSigningIdentity = vi.fn(() => currentIdentity);
    const options = makeOptions({
      db,
      backgroundServices,
      cloudBaseUrl: 'https://cloud.example',
      getSigningIdentity,
    });

    startDdnsUpdatePoller(options);

    expect(ddnsMocks.createSqliteHandleStateStore).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createSqliteHandleStateStore).toHaveBeenCalledWith({ db });
    expect(ddnsMocks.createSqliteDdnsIpStateStore).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createSqliteDdnsIpStateStore).toHaveBeenCalledWith(db);
    expect(ddnsMocks.createSqliteDdnsEnabledStore).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createSqliteDdnsEnabledStore).toHaveBeenCalledWith(db);
    expect(ddnsMocks.createHostnameRegistryStore).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createHostnameRegistryStore).toHaveBeenCalledWith(db);
    expect(ddnsMocks.createProSubscriptionStateStore).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createProSubscriptionStateStore).toHaveBeenCalledWith(db);
    expect(ddnsMocks.createDdnsUpdateClient).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.createDdnsUpdateClient).toHaveBeenCalledWith({
      cloud_base_url: 'https://cloud.example',
      signPayload: expect.any(Function),
    });

    currentIdentity = secondIdentity.value;
    const clientOptions = ddnsMocks.createDdnsUpdateClient.mock.calls[0]![0] as {
      signPayload: (canonical: string) => string;
    };
    expect(clientOptions.signPayload('canonical-payload')).toBe(
      'second:canonical-payload',
    );
    expect(firstIdentity.sign).not.toHaveBeenCalled();
    expect(secondIdentity.sign).toHaveBeenCalledWith('canonical-payload');

    expect(ddnsMocks.composeDdnsUpdatePoller).toHaveBeenCalledTimes(1);
    expect(ddnsMocks.composeDdnsUpdatePoller).toHaveBeenCalledWith({
      registry: backgroundServices,
      handleStateStore: { tag: 'handle-store' },
      fetchPublicIpv4,
      updateClient: { tag: 'update-client' },
      ipStateStore: { tag: 'ip-state-store' },
      ddnsEnabled: { tag: 'ddns-enabled-store' },
      hostnameRegistry: { tag: 'hostname-registry' },
      subscriptionState: { tag: 'subscription-state' },
    });
  });
});

describe('start-ddns-update-poller source boundary', () => {
  it('keeps the DDNS startup wiring behind the post-housekeeping tail', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const tailSource = readFileSync(startPostHousekeepingTailPath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-post-housekeeping-tail\.js/);
    expect(tailSource).toMatch(/start-ddns-update-poller\.js/);
    expect(tailSource).toMatch(/start-hostname-reconciliation-runner\.js/);
    expect(tailSource).toMatch(/startDdnsUpdatePoller\(\{/);
  });

  it('preserves retention, DDNS, hostname reconciliation, banner, and shutdown ordering in the tail helper', () => {
    const source = readFileSync(startPostHousekeepingTailPath, 'utf8');
    const retentionIndex = source.indexOf('startRetentionPruners({');
    const ddnsIndex = source.indexOf('startDdnsUpdatePoller({');
    const hostnameIndex = source.indexOf('startHostnameReconciliationRunner({');
    const bannerIndex = source.indexOf('logBootBanner({');
    // D-178.p1 (`63d22969`) changed `return installShutdown({` →
    // `const shutdown = installShutdown({` (to run a post-shutdown reconcile);
    // match the call site regardless of the binding form. Ordering intent holds.
    const shutdownIndex = source.indexOf('installShutdown({');

    expect(retentionIndex).toBeGreaterThanOrEqual(0);
    expect(ddnsIndex).toBeGreaterThan(retentionIndex);
    expect(hostnameIndex).toBeGreaterThan(ddnsIndex);
    expect(bannerIndex).toBeGreaterThan(hostnameIndex);
    expect(shutdownIndex).toBeGreaterThan(bannerIndex);
  });

  it('keeps the DDNS helper focused on poller startup only', () => {
    const source = readFileSync(startDdnsUpdatePollerPath, 'utf8');

    expect(source).toMatch(/composeDdnsUpdatePoller/);
    expect(source).toMatch(/createSqliteHandleStateStore/);
    expect(source).toMatch(/createSqliteDdnsIpStateStore/);
    expect(source).toMatch(/createHostnameRegistryStore/);
    expect(source).toMatch(/createProSubscriptionStateStore/);
    expect(source).toMatch(/createDdnsUpdateClient/);
    expect(source).toMatch(/fetchPublicIpv4/);
    expect(stripSourceComments(source)).not.toMatch(/composeRetentionPruners/);
    expect(stripSourceComments(source)).not.toMatch(/logBootBanner|installShutdown/);
    expect(stripSourceComments(source)).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(stripSourceComments(source)).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
  });
});
