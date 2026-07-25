import type { RuntimeConfigStore } from '@recued/config';
import type { NotificationBlock } from '@recued/notification';

import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { EvictionCascade } from '../eviction-cascade.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import type { Lifecycle } from '../lifecycle/index.js';
import type { AppContext } from './compose-app-context.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { ListenerServerFacade } from './compose-listeners.js';
import type { StorageContext } from './compose-storage-context.js';
import {
  installShutdown,
  type InstalledShutdown,
} from './install-shutdown.js';
import { logBootBanner } from './log-boot-banner.js';
import { SERVER_VERSION } from '../server-version.js';
import { startDdnsUpdatePoller } from './start-ddns-update-poller.js';
import { startHostnameReconciliationRunner } from './start-hostname-reconciliation-runner.js';
import { startRetentionPruners } from './start-retention-pruners.js';

export type PostHousekeepingTailStorageContext = Pick<
  StorageContext,
  | 'db'
  | 'manifests'
  | 'recipeStore'
  | 'pairing'
  | 'recoveryKeyCheck'
  | 'auditRetention'
  | 's2sPreviewStoreRef'
  | 'correctionEventsStoreRef'
  | 'fileStack'
  // D-157 N.8 — the stale-checkpoint retention sweep's stores.
  | 'checkpointStore'
  | 'auditLog'
>;

export type PostHousekeepingTailAppContext = Pick<
  AppContext,
  'llmConfig' | 'executionCaseLifecycle'
>;

export type PostHousekeepingTailCollectionContext = Pick<
  CollectionContext,
  | 'calendarStack'
  | 'serviceStack'
  | 'supervisionStack'
>;

export interface StartPostHousekeepingTailOptions {
  readonly dbPath: string;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly storage: PostHousekeepingTailStorageContext;
  readonly app: PostHousekeepingTailAppContext;
  readonly collection: PostHousekeepingTailCollectionContext;
  readonly cloudBaseUrl: string;
  readonly getSigningIdentity: () => BootedServerIdentity | undefined;
  readonly lifecycle: Pick<Lifecycle, 'install' | 'markBooted'> | undefined;
  readonly cascade: Pick<EvictionCascade, 'close'> | undefined;
  readonly server: Pick<ListenerServerFacade, 'port' | 'close'>;
  /** LAN bind address the listener resolved to (banner: the local webclient +
   *  Server URL). May be loopback when the LAN interface is ambiguous. */
  readonly lanBindAddress: string;
  /** Whether the bundled webclient is served (banner: advertise the local
   *  `/webclient/` URL only when it actually serves). */
  readonly webclientServed: boolean;
  /** D-157 N.8 — the notification block's ask-state reads for the
   *  stale-checkpoint sweep (threaded from the execution context;
   *  undefined on db-less boots, where the sweep is skipped anyway). */
  readonly notificationBlock:
    | Pick<NotificationBlock, 'getAsk' | 'cancelAsk' | 'pruneHandledAsks'>
    | undefined;
  /** D-178 slice 4b — on-boot update reconcile (commit / auto-revert +
   *  ledger→audit replay). Invoked AFTER `installShutdown` runs markBooted,
   *  so a staged release that reached a serving state commits. Best-effort
   *  (the thunk swallows its own errors); undefined on a delegated channel. */
  readonly runUpdateBootReconcile?: (() => Promise<void>) | undefined;
}

export const startPostHousekeepingTail = (
  options: StartPostHousekeepingTailOptions,
): InstalledShutdown => {
  const { storage } = options;

  startRetentionPruners({
    backgroundServices: options.backgroundServices,
    runtimeConfig: options.runtimeConfig,
    auditRetention: storage.auditRetention,
    s2sPreviewStore: storage.s2sPreviewStoreRef,
    correctionEventsStore: storage.correctionEventsStoreRef,
    checkpointStore: storage.checkpointStore,
    auditLog: storage.auditLog,
    executionCaseLifecycle: options.app.executionCaseLifecycle,
    notificationBlock: options.notificationBlock,
  });

  startDdnsUpdatePoller({
    db: storage.db,
    backgroundServices: options.backgroundServices,
    cloudBaseUrl: options.cloudBaseUrl,
    getSigningIdentity: options.getSigningIdentity,
  });

  startHostnameReconciliationRunner({
    db: storage.db,
    backgroundServices: options.backgroundServices,
  });

  logBootBanner({
    version: SERVER_VERSION,
    port: options.server.port,
    lanBindAddress: options.lanBindAddress,
    webclientServed: options.webclientServed,
    dbPath: options.dbPath,
    recipeCount: storage.recipeStore.size(),
    ingredientCount: storage.manifests.size(),
    llmConfig: options.app.llmConfig,
    pairingCode: storage.pairing?.getCode(),
    notEnrolled: storage.recoveryKeyCheck
      ? !storage.recoveryKeyCheck.exists()
      : false,
  });

  const shutdown = installShutdown({
    lifecycle: options.lifecycle,
    backgroundServices: options.backgroundServices,
    fileStack: storage.fileStack,
    calendarStack: options.collection.calendarStack,
    serviceStack: options.collection.serviceStack,
    supervisionStack: options.collection.supervisionStack,
    cascade: options.cascade,
    server: options.server,
    db: storage.db,
  });

  // D-178 slice 4b — run the on-boot update reconcile AFTER markBooted (above):
  // the server is serving, so a staged release that reached here booted healthy
  // → commit. An auto-revert path requests a restart of its own. Fire-and-forget
  // + self-swallowing, so it never blocks or fails the boot it follows.
  void options.runUpdateBootReconcile?.();

  return shutdown;
};
