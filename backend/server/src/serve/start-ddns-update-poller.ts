import type Database from 'better-sqlite3';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { composeDdnsUpdatePoller } from '../composition/bin/wire-ddns-update-poller.js';
import { createSqliteDdnsIpStateStore } from '../ddns/ip-state-store.js';
import { createSqliteDdnsEnabledStore } from '../ddns/ddns-enabled-store.js';
import { createDdnsUpdateClient } from '../ddns/update-client.js';
import { createSqliteHandleStateStore } from '../handle/sqlite-store.js';
import { createProSubscriptionStateStore } from '../hostname/pro-subscription-state.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';
import { fetchPublicIpv4 } from '../cli/url-enumerate.js';

export interface StartDdnsUpdatePollerOptions {
  /** D-148 § A.5.6 — lifecycle applier so a lapsed server can record 'grace'
   *  and recover to 'active' by itself. Resolved lazily: the cert stack fills
   *  its handle-state-machine ref after this runs. */
  readonly applyLifecycle?: () => Pick<
    import('../handle/index.js').HandleStateMachine,
    'applyLifecycleUpdate'
  > | undefined;

  db: Database.Database | undefined;
  backgroundServices: BackgroundServiceRegistry;
  cloudBaseUrl: string;
  getSigningIdentity: () => BootedServerIdentity | undefined;
}

export const startDdnsUpdatePoller = (
  options: StartDdnsUpdatePollerOptions,
): void => {
  if (!options.db || !options.getSigningIdentity()) return;

  const handleStateStore = createSqliteHandleStateStore({ db: options.db });
  const ipStateStore = createSqliteDdnsIpStateStore(options.db);
  const ddnsEnabled = createSqliteDdnsEnabledStore(options.db);
  const hostnameRegistry = createHostnameRegistryStore(options.db);
  const subscriptionState = createProSubscriptionStateStore(options.db);
  const updateClient = createDdnsUpdateClient({
    cloud_base_url: options.cloudBaseUrl,
    signPayload: (canonical) =>
      options.getSigningIdentity()!.identity.signWithServerIdentity(canonical),
  });

  composeDdnsUpdatePoller({
    registry: options.backgroundServices,
    handleStateStore,
    fetchPublicIpv4,
    updateClient,
    ipStateStore,
    ddnsEnabled,
    ...(options.applyLifecycle ? { applyLifecycle: options.applyLifecycle } : {}),
    hostnameRegistry,
    subscriptionState,
  });
};
