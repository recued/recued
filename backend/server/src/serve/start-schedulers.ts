import {
  composeSchedulers,
  type SchedulerBootContext,
  type SchedulersBundle,
} from '../composition/bin/wire-schedulers.js';
import { housekeepingSchedulerRegistry } from '../composition/bin/housekeeping-scheduler-instance.js';
import {
  composeHousekeepingScheduler,
  type ComposeHousekeepingSchedulerDeps,
  type HousekeepingSchedulerBundle,
} from '../composition/bin/wire-housekeeping-substrate.js';
import type { AppContext } from './compose-app-context.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { StorageContext } from './compose-storage-context.js';

export type StartSchedulersOptions = SchedulerBootContext;
export type StartHousekeepingSchedulerOptions = ComposeHousekeepingSchedulerDeps;

export type ServeHousekeepingStorageContext = Omit<
  Pick<
    StorageContext,
    | 'db'
    | 'recipeStore'
    | 'eventBus'
    | 'auditLog'
    | 'workEntityStoreRef'
  >,
  'db'
> & {
  readonly db: ComposeHousekeepingSchedulerDeps['db'] | undefined;
};

export type ServeHousekeepingAppContext = Pick<
  AppContext,
  | 'housekeepingConfigRef'
  | 'housekeepingStateRef'
  | 'housekeepingTrustRef'
  | 'housekeepingTunableParamsRef'
  | 'housekeepingLlmResultCacheRef'
  | 'enrichmentStoreRef'
  | 'crmRecordMirrorStoreRef'
  | 'cacheBlobs'
  | 'warehouseBus'
  | 'contactStoreRef'
  // D-192 email flagship (E2b) — the contact-engagements resolver bundle for
  // the commitment_tracker task's fan-in.
  | 'contactEngagementsResolveDepsRef'
  // D-192 email flagship (E3) — the F1 proposal `fire` runtime ref, so the
  // commitment_tracker task can funnel extracted commitments to held
  // commitment-propose runs (read lazily; late-populated by the post-listener).
  | 'commitmentEvidenceRuntimeRef'
  | 'enrichmentCascadeRef'
  | 'externalContextRegistryRef'
  // D-177 N.13 (P6b) — gates the delegation-rule-suggestion learner task.
  | 'contractStoreRef'
  // D-184 — the shared vendor rate gate for the reconciliation harness.
  | 'vendorRateGateRef'
  // R21.1 — gates the autonomous idle-probe loop on vault-unlocked.
  | 'isVaultUnlocked'
>;

export type ServeHousekeepingCollectionContext = Pick<
  CollectionContext,
  // D-172 — `uploadService` gates the `upload-session-sweep` reaper registration.
  // M4b.1 — `archiveUploadService` gates the `archive-upload-sweep` registration.
  'collectionRegistry' | 'uploadService' | 'archiveUploadService'
>;

export interface StartServeHousekeepingSchedulerOptions {
  readonly storage: ServeHousekeepingStorageContext;
  readonly app: ServeHousekeepingAppContext;
  readonly collection: ServeHousekeepingCollectionContext;
  readonly llmCallables: ComposeHousekeepingSchedulerDeps['llmCallables'];
  readonly rotationEngine: ComposeHousekeepingSchedulerDeps['rotationEngine'] | undefined;
  readonly tlsCertSource: ComposeHousekeepingSchedulerDeps['tlsCertSource'] | undefined;
  readonly tlsRenewerConfigured:
    | ComposeHousekeepingSchedulerDeps['tlsRenewerConfigured']
    | undefined;
  readonly getSchedulerBundle: () => SchedulersBundle | undefined;
  readonly getActiveContactMergeScanMode: NonNullable<
    ComposeHousekeepingSchedulerDeps['getActiveContactMergeScanMode']
  >;
  readonly getContactMergeCycleObserver: NonNullable<
    ComposeHousekeepingSchedulerDeps['getContactMergeCycleObserver']
  >;
  readonly enrichmentProducers: ComposeHousekeepingSchedulerDeps['enrichmentProducers'];
  /** D-196 §6.3 (s2b) — the pre-built seller-access reconcile deps. Undefined on
   *  a boot without the seller substrate ⇒ the task doesn't register. */
  readonly sellerAccessReconcileDeps?: ComposeHousekeepingSchedulerDeps['sellerAccessReconcileDeps'];
}

export const startSchedulers = (
  options: StartSchedulersOptions,
): SchedulersBundle => composeSchedulers(options);

export const startHousekeepingScheduler = async (
  options: StartHousekeepingSchedulerOptions,
): Promise<HousekeepingSchedulerBundle> => {
  const bundle = await composeHousekeepingScheduler(options);
  // The background-services stop closure reads this singleton, so publish
  // only after the scheduler exists.
  if (bundle.scheduler) {
    housekeepingSchedulerRegistry.setScheduler(bundle.scheduler);
  }
  return bundle;
};

export const startServeHousekeepingScheduler = async (
  options: StartServeHousekeepingSchedulerOptions,
): Promise<HousekeepingSchedulerBundle> => {
  const {
    storage,
    app,
    collection,
  } = options;
  const stores: ComposeHousekeepingSchedulerDeps['stores'] = {
    configStore: app.housekeepingConfigRef,
    stateStore: app.housekeepingStateRef,
    trustStore: app.housekeepingTrustRef,
    tunableParamsStore: app.housekeepingTunableParamsRef,
    llmResultCacheStore: app.housekeepingLlmResultCacheRef,
  };

  if (
    !storage.db
    || !app.enrichmentStoreRef
    || !stores.configStore
    || !stores.stateStore
  ) {
    return { scheduler: undefined };
  }

  const schedulerBundle = options.getSchedulerBundle();

  return startHousekeepingScheduler({
    db: storage.db,
    stores,
    enrichmentStore: app.enrichmentStoreRef,
    // D-190 — the dedicated CRM record mirror, threaded onto the scheduler ctx
    // so the reconciliation harness writes every CRM record (deal.search reads it).
    ...(app.crmRecordMirrorStoreRef
      ? { crmRecordMirror: app.crmRecordMirrorStoreRef }
      : {}),
    recipeStore: storage.recipeStore,
    collectionRegistry: collection.collectionRegistry,
    cacheBlobs: app.cacheBlobs as ComposeHousekeepingSchedulerDeps['cacheBlobs'],
    eventBus: storage.eventBus,
    warehouseBus: app.warehouseBus,
    auditLog: storage.auditLog,
    llmCallables: options.llmCallables,
    ...(app.contactStoreRef ? { contactStore: app.contactStoreRef } : {}),
    // D-192 email flagship (E2b) — thread the contact-engagements resolver
    // bundle so the commitment_tracker task can fan in over engagement rows.
    ...(app.contactEngagementsResolveDepsRef
      ? { contactEngagementsResolveDeps: app.contactEngagementsResolveDepsRef }
      : {}),
    // D-192 email flagship (E3) — thread the F1 proposal `fire` runtime ref so
    // the commitment_tracker task can funnel extracted commitments to held
    // commitment-propose runs. The ref is always present on the AppContext
    // (populated late by the post-listener wire; the funnel reads `.current`
    // lazily at task-run time).
    ...(app.commitmentEvidenceRuntimeRef
      ? { commitmentEvidenceRuntimeRef: app.commitmentEvidenceRuntimeRef }
      : {}),
    // D-177 N.13 (P6b) — the delegation-rule-suggestion learner registers
    // when the contract substrate is composed.
    ...(app.contractStoreRef ? { contractStore: app.contractStoreRef } : {}),
    ...(storage.workEntityStoreRef
      ? { workEntityStore: storage.workEntityStoreRef }
      : {}),
    // D-172 — register the upload-session TTL/orphan sweep when the webclient
    // upload service is wired (built in compose-collection-context).
    ...(collection.uploadService
      ? { uploadService: collection.uploadService }
      : {}),
    // M4b.1 — register the archive-upload sweep (sessions + staged-archive TTL)
    // when the archive upload service is wired.
    ...(collection.archiveUploadService
      ? { archiveUploadService: collection.archiveUploadService }
      : {}),
    ...(app.enrichmentCascadeRef
      ? { enrichmentCascade: app.enrichmentCascadeRef }
      : {}),
    ...(app.externalContextRegistryRef
      ? { externalContextRegistry: app.externalContextRegistryRef }
      : {}),
    // D-184 — the shared vendor rate gate (daily budget + skip-if-busy) for the
    // reconciliation harness; one instance built alongside the rate-control store.
    ...(app.vendorRateGateRef ? { rateGate: app.vendorRateGateRef } : {}),
    ...(options.rotationEngine ? { rotationEngine: options.rotationEngine } : {}),
    ...(options.tlsCertSource ? { tlsCertSource: options.tlsCertSource } : {}),
    tlsRenewerConfigured: options.tlsRenewerConfigured,
    ...(app.isVaultUnlocked ? { isVaultUnlocked: app.isVaultUnlocked } : {}),
    ...(schedulerBundle?.autoRun
      ? {
          getAutoRunInFlight: () =>
            options.getSchedulerBundle()?.autoRun?.getHandle()?.inFlight() ?? false,
        }
      : {}),
    getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
    getContactMergeCycleObserver: options.getContactMergeCycleObserver,
    enrichmentProducers: options.enrichmentProducers,
    // D-196 §6.3 (s2b) — register the seller-access reconciler when its deps
    // were built upstream (the post-listener wire, where the seller stores +
    // the gateway spine both exist).
    ...(options.sellerAccessReconcileDeps
      ? { sellerAccessReconcileDeps: options.sellerAccessReconcileDeps }
      : {}),
  });
};
