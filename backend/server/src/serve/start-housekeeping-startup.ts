import { resolveServerTimeZone } from '@recued/contracts';
import type { UpstreamMergeRegistry } from '../data/vendor-boot-registry.js';
import type { EventBus } from '../events/bus.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { clearDefaultHousekeepingRegistry } from '../housekeeping/index.js';
import type { HousekeepingSchedulerBundle } from '../composition/bin/wire-housekeeping-substrate.js';
import {
  composeHousekeepingLlmCallables,
  type HousekeepingLlmCallableSubstrate,
} from './compose-housekeeping-llm-callables.js';
import {
  composeVendorSubstrateContext,
  type VendorSubstrateAppContext,
  type VendorSubstratePublishedRefs,
} from './compose-vendor-substrate.js';
import {
  startServeHousekeepingScheduler,
  type ServeHousekeepingAppContext,
  type ServeHousekeepingCollectionContext,
  type ServeHousekeepingStorageContext,
  type StartServeHousekeepingSchedulerOptions,
} from './start-schedulers.js';

export type HousekeepingStartupStorageContext =
  ServeHousekeepingStorageContext & {
    readonly eventBus: EventBus;
  };

export type HousekeepingStartupAppContext =
  ServeHousekeepingAppContext
  & VendorSubstrateAppContext
  & HousekeepingLlmCallableSubstrate;

export type HousekeepingStartupCollectionContext =
  ServeHousekeepingCollectionContext;

export interface StartHousekeepingStartupOptions {
  readonly storage: HousekeepingStartupStorageContext;
  /** D-269 step 4 — called once when quiet hours ends, with a digest recomputed
   *  from anchor rows. Threaded from the caller, which owns the notification
   *  block. Absent ⇒ no card. */
  /** D-269 — the booking / calendar reminder sink, threaded from the caller
   *  that owns the notification block. */
  readonly notifyReminder?: (message: { title: string; text: string }) => void;
  readonly onQuietHoursReleased?: (
    digest: import('@recued/contracts').QuietHoursDigest,
  ) => void;
  readonly app: HousekeepingStartupAppContext;
  readonly collection: HousekeepingStartupCollectionContext;
  readonly upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  readonly publishVendorRefs: (refs: VendorSubstratePublishedRefs) => void;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly rotationEngine: StartServeHousekeepingSchedulerOptions['rotationEngine'];
  readonly tlsCertSource: StartServeHousekeepingSchedulerOptions['tlsCertSource'];
  readonly tlsRenewerConfigured:
    StartServeHousekeepingSchedulerOptions['tlsRenewerConfigured'];
  readonly getSchedulerBundle:
    StartServeHousekeepingSchedulerOptions['getSchedulerBundle'];
  readonly getActiveContactMergeScanMode:
    StartServeHousekeepingSchedulerOptions['getActiveContactMergeScanMode'];
  readonly getContactMergeCycleObserver:
    StartServeHousekeepingSchedulerOptions['getContactMergeCycleObserver'];
  readonly enrichmentProducers:
    StartServeHousekeepingSchedulerOptions['enrichmentProducers'];
  /** D-196 §6.3 (s2b) — the pre-built seller-access reconcile deps, built by the
   *  caller (the post-listener wire, where the seller stores + gateway spine both
   *  exist). Undefined ⇒ the task doesn't register. */
  readonly sellerAccessReconcileDeps?:
    StartServeHousekeepingSchedulerOptions['sellerAccessReconcileDeps'];
  /** D-225 § 12 — deps for the mcp tool-drift probe. Absent ⇒ the task does not
   *  register and drift detection stays inert. */
  readonly mcpToolsDriftProbeDeps?:
    StartServeHousekeepingSchedulerOptions['mcpToolsDriftProbeDeps'];
  /** D-225 auto-mint — deps for the first-mint retry + backfill sweep. Absent ⇒
   *  the task does not register and a connection whose server was down at enroll
   *  stays packless. */
  readonly mcpPackFirstMintDeps?:
    StartServeHousekeepingSchedulerOptions['mcpPackFirstMintDeps'];
}

export const startHousekeepingStartup = async (
  options: StartHousekeepingStartupOptions,
): Promise<HousekeepingSchedulerBundle> => {
  const { storage, app } = options;
  if (
    !storage.db
    || !app.enrichmentStoreRef
    || !app.housekeepingConfigRef
    || !app.housekeepingStateRef
  ) {
    return { scheduler: undefined };
  }

  clearDefaultHousekeepingRegistry();

  const vendorRefs = await composeVendorSubstrateContext({
    app,
    upstreamMergeRegistry: options.upstreamMergeRegistry,
    // D-269 step 1 — the owner's declared server zone. ⚠ Read PER CALL, not
    // captured: under `follows_host` the answer is the host clock, which moves
    // with the machine, and a reconciliation cycle outlives any one reading.
    prefsTimezone: (): string | null => resolveServerTimeZone(
      storage.serverTimeZoneStore.read(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    backgroundServices: options.backgroundServices,
  });
  if (vendorRefs) {
    options.publishVendorRefs(vendorRefs);
  }

  const housekeepingLlmCallables = composeHousekeepingLlmCallables({
    substrate: app,
  });

  return startServeHousekeepingScheduler({
    ...(options.notifyReminder ? { notifyReminder: options.notifyReminder } : {}),
    ...(options.onQuietHoursReleased
      ? { onQuietHoursReleased: options.onQuietHoursReleased }
      : {}),
    storage,
    app,
    collection: options.collection,
    llmCallables: housekeepingLlmCallables,
    rotationEngine: options.rotationEngine,
    tlsCertSource: options.tlsCertSource,
    tlsRenewerConfigured: options.tlsRenewerConfigured,
    getSchedulerBundle: options.getSchedulerBundle,
    getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
    getContactMergeCycleObserver: options.getContactMergeCycleObserver,
    enrichmentProducers: options.enrichmentProducers,
    ...(options.sellerAccessReconcileDeps
      ? { sellerAccessReconcileDeps: options.sellerAccessReconcileDeps }
      : {}),
    ...(options.mcpToolsDriftProbeDeps
      ? { mcpToolsDriftProbeDeps: options.mcpToolsDriftProbeDeps }
      : {}),
    ...(options.mcpPackFirstMintDeps
      ? { mcpPackFirstMintDeps: options.mcpPackFirstMintDeps }
      : {}),
  });
};
