import type Database from 'better-sqlite3';

import { createSqliteDdnsIpStateStore } from '../ddns/ip-state-store.js';
import {
  createConsoleHostnameReconciliationAlertSink,
  createDdnsIpStateDnsReconciliationAdapter,
  createDisabledHostnameCertRenewalAdapter,
  createDnsProviderCapabilityAdapter,
} from '../hostname/reconciliation-adapters.js';
import {
  registerDailyHostnameReconciliationRunner,
  type HostnameReconciliationSafetyOptions,
} from '../hostname/reconciliation-jobs.js';
import { createProSubscriptionStateStore } from '../hostname/pro-subscription-state.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';

export interface StartHostnameReconciliationRunnerOptions {
  db: Database.Database | undefined;
  backgroundServices: BackgroundServiceRegistry;
  env?: Record<string, string | undefined>;
}

const TRUE_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const parseHostnameReconciliationSafetyFromEnv = (
  env: Record<string, string | undefined>,
): HostnameReconciliationSafetyOptions => ({
  allowHandleRemoval: TRUE_FLAG_VALUES.has(
    (env.RECUED_HOSTNAME_RECONCILIATION_ALLOW_HANDLE_REMOVAL ?? '').toLowerCase(),
  ),
  allowDnsCorrection: TRUE_FLAG_VALUES.has(
    (env.RECUED_HOSTNAME_RECONCILIATION_ALLOW_DNS_CORRECTION ?? '').toLowerCase(),
  ),
});

export const startHostnameReconciliationRunner = (
  options: StartHostnameReconciliationRunnerOptions,
): void => {
  if (!options.db) return;

  const ipStateStore = createSqliteDdnsIpStateStore(options.db);
  const hostnameRegistry = createHostnameRegistryStore(options.db);
  const subscriptionState = createProSubscriptionStateStore(options.db);
  const safety = parseHostnameReconciliationSafetyFromEnv(options.env ?? process.env);

  registerDailyHostnameReconciliationRunner({
    backgroundServices: options.backgroundServices,
    deps: {
      hostnameRegistry,
      subscriptionState,
      dns: createDdnsIpStateDnsReconciliationAdapter({ ipStateStore }),
      certs: createDisabledHostnameCertRenewalAdapter(),
      provider: createDnsProviderCapabilityAdapter(),
      alerts: createConsoleHostnameReconciliationAlertSink(),
      safety,
    },
    onError(error) {
      console.warn('[hostname-reconciliation] daily runner failed', error);
    },
  });
};
