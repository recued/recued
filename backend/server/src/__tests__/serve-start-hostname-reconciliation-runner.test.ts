import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostnameRunnerMocks = vi.hoisted(() => ({
  createSqliteDdnsIpStateStore: vi.fn(),
  createHostnameRegistryStore: vi.fn(),
  createProSubscriptionStateStore: vi.fn(),
  createDdnsIpStateDnsReconciliationAdapter: vi.fn(),
  createDisabledHostnameCertRenewalAdapter: vi.fn(),
  createDnsProviderCapabilityAdapter: vi.fn(),
  createConsoleHostnameReconciliationAlertSink: vi.fn(),
  registerDailyHostnameReconciliationRunner: vi.fn(),
}));

vi.mock('../ddns/ip-state-store.js', () => ({
  createSqliteDdnsIpStateStore: hostnameRunnerMocks.createSqliteDdnsIpStateStore,
}));

vi.mock('../storage/hostname-registry.js', () => ({
  createHostnameRegistryStore: hostnameRunnerMocks.createHostnameRegistryStore,
}));

vi.mock('../hostname/pro-subscription-state.js', () => ({
  createProSubscriptionStateStore: hostnameRunnerMocks.createProSubscriptionStateStore,
}));

vi.mock('../hostname/reconciliation-adapters.js', () => ({
  createDdnsIpStateDnsReconciliationAdapter:
    hostnameRunnerMocks.createDdnsIpStateDnsReconciliationAdapter,
  createDisabledHostnameCertRenewalAdapter:
    hostnameRunnerMocks.createDisabledHostnameCertRenewalAdapter,
  createDnsProviderCapabilityAdapter:
    hostnameRunnerMocks.createDnsProviderCapabilityAdapter,
  createConsoleHostnameReconciliationAlertSink:
    hostnameRunnerMocks.createConsoleHostnameReconciliationAlertSink,
}));

vi.mock('../hostname/reconciliation-jobs.js', () => ({
  registerDailyHostnameReconciliationRunner:
    hostnameRunnerMocks.registerDailyHostnameReconciliationRunner,
}));

import type Database from 'better-sqlite3';
import {
  parseHostnameReconciliationSafetyFromEnv,
  startHostnameReconciliationRunner,
} from '../serve/start-hostname-reconciliation-runner.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';

const backgroundServices = { registerInterval: vi.fn() } as unknown as BackgroundServiceRegistry;
const db = { tag: 'db' } as unknown as Database.Database;
const hostnameRegistry = { tag: 'hostname-registry' };
const subscriptionState = { tag: 'subscription-state' };

beforeEach(() => {
  hostnameRunnerMocks.createSqliteDdnsIpStateStore.mockReset();
  hostnameRunnerMocks.createHostnameRegistryStore.mockReset();
  hostnameRunnerMocks.createProSubscriptionStateStore.mockReset();
  hostnameRunnerMocks.createDdnsIpStateDnsReconciliationAdapter.mockReset();
  hostnameRunnerMocks.createDisabledHostnameCertRenewalAdapter.mockReset();
  hostnameRunnerMocks.createDnsProviderCapabilityAdapter.mockReset();
  hostnameRunnerMocks.createConsoleHostnameReconciliationAlertSink.mockReset();
  hostnameRunnerMocks.registerDailyHostnameReconciliationRunner.mockReset();
  hostnameRunnerMocks.createSqliteDdnsIpStateStore.mockReturnValue({ tag: 'ip-state-store' });
  hostnameRunnerMocks.createHostnameRegistryStore.mockReturnValue(hostnameRegistry);
  hostnameRunnerMocks.createProSubscriptionStateStore.mockReturnValue(subscriptionState);
  hostnameRunnerMocks.createDdnsIpStateDnsReconciliationAdapter.mockReturnValue({ tag: 'dns' });
  hostnameRunnerMocks.createDisabledHostnameCertRenewalAdapter.mockReturnValue({ tag: 'certs' });
  hostnameRunnerMocks.createDnsProviderCapabilityAdapter.mockReturnValue({ tag: 'provider' });
  hostnameRunnerMocks.createConsoleHostnameReconciliationAlertSink.mockReturnValue({ tag: 'alerts' });
});

describe('startHostnameReconciliationRunner', () => {
  it('does not compose the runner without a database handle', () => {
    startHostnameReconciliationRunner({
      db: undefined,
      backgroundServices,
    });

    expect(hostnameRunnerMocks.createSqliteDdnsIpStateStore).not.toHaveBeenCalled();
    expect(hostnameRunnerMocks.createHostnameRegistryStore).not.toHaveBeenCalled();
    expect(hostnameRunnerMocks.createProSubscriptionStateStore).not.toHaveBeenCalled();
    expect(hostnameRunnerMocks.registerDailyHostnameReconciliationRunner).not.toHaveBeenCalled();
  });

  it('wires concrete adapters and keeps destructive safety flags off by default', () => {
    startHostnameReconciliationRunner({
      db,
      backgroundServices,
      env: {},
    });

    expect(hostnameRunnerMocks.createSqliteDdnsIpStateStore).toHaveBeenCalledWith(db);
    expect(hostnameRunnerMocks.createHostnameRegistryStore).toHaveBeenCalledWith(db);
    expect(hostnameRunnerMocks.createProSubscriptionStateStore).toHaveBeenCalledWith(db);
    expect(hostnameRunnerMocks.createDdnsIpStateDnsReconciliationAdapter)
      .toHaveBeenCalledWith({ ipStateStore: { tag: 'ip-state-store' } });
    expect(hostnameRunnerMocks.createDisabledHostnameCertRenewalAdapter).toHaveBeenCalledTimes(1);
    expect(hostnameRunnerMocks.createDnsProviderCapabilityAdapter).toHaveBeenCalledTimes(1);
    expect(hostnameRunnerMocks.createConsoleHostnameReconciliationAlertSink).toHaveBeenCalledTimes(1);
    expect(hostnameRunnerMocks.registerDailyHostnameReconciliationRunner).toHaveBeenCalledWith({
      backgroundServices,
      deps: {
        hostnameRegistry,
        subscriptionState,
        dns: { tag: 'dns' },
        certs: { tag: 'certs' },
        provider: { tag: 'provider' },
        alerts: { tag: 'alerts' },
        safety: {
          allowHandleRemoval: false,
          allowDnsCorrection: false,
        },
      },
      onError: expect.any(Function),
    });
  });

  it('parses opt-in safety flags from environment variables', () => {
    expect(parseHostnameReconciliationSafetyFromEnv({
      RECUED_HOSTNAME_RECONCILIATION_ALLOW_HANDLE_REMOVAL: 'true',
      RECUED_HOSTNAME_RECONCILIATION_ALLOW_DNS_CORRECTION: '1',
    })).toEqual({
      allowHandleRemoval: true,
      allowDnsCorrection: true,
    });
  });
});
