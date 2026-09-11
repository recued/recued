import {
  composeAppContext,
  type AppContext,
  type ComposeAppContextOptions,
} from './compose-app-context.js';
import { dirname } from 'node:path';
import { backgroundServices as defaultBackgroundServices } from '../composition/bin/background-services-instance.js';
import { housekeepingSchedulerRegistry as defaultSchedulerRegistry } from '../composition/bin/housekeeping-scheduler-instance.js';
import type { BaseContext } from './compose-base-context.js';
import {
  createExecutionLateBoundRefs,
  type ExecutionLateBoundRefs,
} from './compose-execution-context.js';
import {
  composeStorageContext,
  type StorageContext,
} from './compose-storage-context.js';
import type { VendorSubstratePublishedRefs } from './compose-vendor-substrate.js';
import {
  startPostAppCollectionExecutionRuntime,
  type PostAppCollectionExecutionRuntimeResult,
  type StartPostAppCollectionExecutionRuntimeOptions,
} from './start-post-app-collection-execution-runtime.js';
import { resolveReceptionInboxFanoutModeFromStore } from '../ports/reception/handlers/trust-footer.js';
import type { KeyManager } from '../key-manager.js';
import { autoUnlockServerVaultFromKeyfile } from '../server-vault-enrollment.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import {
  reconcileServerBundleSwap,
  sweepOrphanedRestoreStaging,
} from '../archive/server-bundle-swap.js';
import { reclaimDisplacedBlobs } from '../archive/archive-restore.js';

type CollectionDerivedKeys =
  | 'db'
  | 'dbPath'
  | 'auditLog'
  | 'cacheBlobs'
  | 'warehouseBus'
  | 'contactStore'
  | 'gateRegistry'
  | 'eventBus'
  | 'keys'
  | 'connectionStore'
  | 'workEntityStore'
  | 'enrichmentCascade'
  | 'annotationDeps';
type ExecutionDerivedKeys = 'app' | 'lateBound';
type AppContextKey = 'app';
type RuntimeDerivedKeys = 'getContactMergeCycleObserver';

export interface StartPostStorageAppCollectionExecutionRuntimeOptions {
  readonly app: Omit<ComposeAppContextOptions, 'chatLateBound'>;
  /** Slice 3b — publish the composed KeyManager back to the boot runtime
   *  (called right after `composeAppContext`) so the post-boot
   *  signing-identity step can auto-unlock the server vault from the
   *  keyfile before listeners accept work. */
  readonly publishKeys?: (keys: KeyManager | undefined) => void;
  readonly collection: Omit<
    StartPostAppCollectionExecutionRuntimeOptions['collection'],
    CollectionDerivedKeys
  >;
  readonly execution: Omit<
    StartPostAppCollectionExecutionRuntimeOptions['execution'],
    ExecutionDerivedKeys
  >;
  readonly postApp: Omit<
    StartPostAppCollectionExecutionRuntimeOptions,
    'collection' | 'execution' | 'postExecution'
  > & {
    readonly postExecution: Omit<
      StartPostAppCollectionExecutionRuntimeOptions['postExecution'],
      'bootstrapCascade' | 'maintenance' | 'runtime'
    > & {
      readonly bootstrapCascade: Omit<
        StartPostAppCollectionExecutionRuntimeOptions['postExecution']['bootstrapCascade'],
        AppContextKey
      >;
      readonly maintenance: Omit<
        StartPostAppCollectionExecutionRuntimeOptions['postExecution']['maintenance'],
        AppContextKey
      >;
      readonly runtime: Omit<
        StartPostAppCollectionExecutionRuntimeOptions['postExecution']['runtime'],
        'preListener' | RuntimeDerivedKeys
      > & {
        readonly preListener: Omit<
          StartPostAppCollectionExecutionRuntimeOptions['postExecution']['runtime']['preListener'],
          AppContextKey
        >;
      };
    };
  };
}

export interface PostStorageAppCollectionExecutionRuntimeResult {
  readonly lateBound: ExecutionLateBoundRefs;
  readonly app: AppContext;
  readonly postApp: PostAppCollectionExecutionRuntimeResult;
}

type BaseRuntimeContext = Pick<
  BaseContext,
  | 'args'
  | 'subcommand'
  | 'bootTrace'
  | 'dbPath'
  | 'port'
  | 'distribution'
  | 'loadedConfig'
  | 'runtimeConfig'
  | 'vaultQuotas'
>;
type BackgroundServices =
  StartPostStorageAppCollectionExecutionRuntimeOptions['postApp']['postExecution']['maintenance']['backgroundServices'];
type SchedulerRegistry =
  StartPostStorageAppCollectionExecutionRuntimeOptions['postApp']['postExecution']['runtime']['preListener']['schedulerRegistry'];
type UpstreamMergeRegistry = Map<
  import('@recued/contracts').UpstreamMergeObjectType,
  import('../data/vendor-merge.js').VendorMergeClient
>;
type ConnectionLookup =
  import('../housekeeping/reconciliation/vendor-reconciler.js').ConnectionLookup;
type RefreshApiConnectionAuth = (
  connection: import('@recued/contracts').ConnectionRecord,
) => Promise<import('@recued/contracts').ConnectionAuth>;
type RegisterSalesforceCallEntity = NonNullable<
  VendorSubstratePublishedRefs['registerSalesforceCallEntity']
>;

export interface StartPostBaseStorageVaultRuntimeOptions {
  readonly base: BaseRuntimeContext;
  readonly serverVersion: string;
  readonly backgroundServices?: BackgroundServices;
  readonly schedulerRegistry?: SchedulerRegistry;
  readonly env?: Record<string, string | undefined>;
  readonly publishDbCleanup?: (cleanup: () => void) => void;
}

export interface PostBaseStorageVaultRuntimeResult {
  readonly storage: StorageContext;
  readonly postStorage: PostStorageAppCollectionExecutionRuntimeResult;
  readonly getBaseVault: () => Record<string, unknown>;
  readonly getSigningIdentity: () => StorageContext['signingIdentity'];
}

export const startPostBaseStorageVaultRuntime = async (
  options: StartPostBaseStorageVaultRuntimeOptions,
): Promise<PostBaseStorageVaultRuntimeResult> => {
  const { base } = options;
  const backgroundServices =
    options.backgroundServices ?? defaultBackgroundServices;
  const schedulerRegistry =
    options.schedulerRegistry ?? defaultSchedulerRegistry;
  // D-212 slice 1 — resolve the dual-wrapped Master-DEK bundle sidecar BEFORE
  // storage composition. The store itself is pure filesystem I/O and does not
  // need SQLite open; later slices can therefore unlock/key the db at this
  // boundary without reintroducing the old bundle-inside-db cycle.
  // A restore killed between overlaying a blob and committing leaves the
  // pre-restore original parked beside it. Their fate is only decidable from
  // the swap outcome: a completed swap means the archive's blobs are the live
  // ones, anything else means the OLD database survived and still references
  // the parked bytes. The CAS sweep cannot make that call and deliberately
  // leaves parks alone, so this is where they are reclaimed.
  //
  // Passed INTO the reconcile rather than run after it: the marker is the only
  // durable record of the verdict, so the parks have to be resolved while it
  // still exists. Reclaiming afterwards meant a kill in the gap left "parks,
  // no marker" — read by the next boot as an uncommitted restore.
  let reclaimedParks = { restored: 0, reaped: 0, complete: true };
  const bundleSwapRecovery = reconcileServerBundleSwap(
    base.dbPath,
    (committed) => {
      reclaimedParks = reclaimDisplacedBlobs(dirname(base.dbPath), committed);
      // Reported back so the journal keeps its marker when a park could not be
      // resolved — the next boot then re-decides it rather than losing the verdict.
      return reclaimedParks.complete;
    },
    { configPath: base.loadedConfig.source },
  );
  if (bundleSwapRecovery.recovery !== 'none') {
    console.warn(
      `[archive] ${bundleSwapRecovery.recovery} interrupted db + server-bundle restore swap`,
    );
  }
  // Boot proceeds on an unretired journal — a park it cannot move must never
  // fail a boot (that is the standing rule for this reclaim). The marker simply
  // waits for a boot that can finish it. Say so, because the realm is carrying
  // an open journal and the operator is the one who can clear the blocker.
  if (!bundleSwapRecovery.retired) {
    console.warn(
      '[archive] a parked pre-restore blob could not be reclaimed; the restore journal is kept '
        + 'for the next boot. Archive restores are refused until it retires.',
    );
  }
  // A kill before the marker publication has no journal transaction to consume
  // the complete staged database. Reconcile first so any marker-owned staging
  // is either consumed or explicitly preserved, then reap every other exact
  // restore-staging shape before opening SQLite.
  const sweptRestoreStaging = sweepOrphanedRestoreStaging(
    base.dbPath,
    base.loadedConfig.source,
  );
  if (sweptRestoreStaging > 0) {
    console.warn(
      `[archive] reclaimed ${sweptRestoreStaging} orphaned restore staging artifact(s)`,
    );
  }
  // No journal at all — so no restore reached the point of having one, and any
  // park is debris from a kill DURING the stream, before the marker existed.
  // The old database is still the live one; put them back.
  if (bundleSwapRecovery.recovery === 'none') {
    reclaimedParks = reclaimDisplacedBlobs(dirname(base.dbPath), false);
  }
  if (reclaimedParks.restored > 0 || reclaimedParks.reaped > 0) {
    console.warn(
      `[archive] reclaimed interrupted-restore blobs (restored=${reclaimedParks.restored}, reaped=${reclaimedParks.reaped})`,
    );
  }
  const serverBundleStore = createServerBundleStore(base.dbPath);
  const initialServerBundle = serverBundleStore.load();
  // Slice 4 — late-bound vault key. `keysRef` is published after
  // composeAppContext (deeper in the boot), so at the first-boot vault load
  // it returns null (locked ⇒ env-only baseVault) and yields the real
  // `sub_dek.vault` only post-unlock, when the vault is re-loaded below.
  let keysRef: KeyManager | undefined;
  const storageContext = await composeStorageContext({
    dbPath: base.dbPath,
    restoreJournalReconciled: true,
    bootTrace: base.bootTrace,
    runtimeConfig: base.runtimeConfig,
    vaultQuotas: base.vaultQuotas,
    getVaultKey: () => keysRef?.keyProvider('vault')() ?? null,
  });
  options.publishDbCleanup?.(() => {
    storageContext.db.close();
  });

  // A STABLE baseVault object. The executor captures THIS reference
  // (`vault: deps.baseVault` → `stores.vault`, read live at dispatch), so a
  // post-unlock re-load must MUTATE it in place, never reassign — otherwise
  // an enrolled server's reboot would leave the executor on the empty
  // pre-unlock snapshot and drop persisted `{{vault.*}}` creds.
  const baseVault: Record<string, unknown> = {};
  const syncBaseVault = (): void => {
    for (const k of Object.keys(baseVault)) delete baseVault[k];
    Object.assign(baseVault, storageContext.baseVault);
  };
  const initVault = async (): Promise<void> => {
    await storageContext.initVault();
    syncBaseVault();
  };

  let signingIdentityRef: StorageContext['signingIdentity'] =
    storageContext.signingIdentity;
  const bootSigningIdentity = async (): Promise<void> => {
    await storageContext.bootSigningIdentity();
    signingIdentityRef = storageContext.signingIdentity;
    // Slice 3b — headless boot auto-unlock. Now that the keyfile keyStore
    // is up, reopen the Master DEK from the keyfile-held server key so the
    // server decrypts its own warehouse with no human present. No-op on a
    // fresh / unenrolled realm. `keysRef` was published right after
    // `composeAppContext` (which runs before this boot step). Best-effort:
    // a wrong / tampered keyfile key leaves the vault LOCKED (executors
    // stay gated; recovery-key re-pair rescues) rather than bricking boot.
    const keyStore = signingIdentityRef?.keyStore;
    if (keysRef && keyStore) {
      try {
        const outcome = await autoUnlockServerVaultFromKeyfile({ keys: keysRef, keyStore });
        if (outcome === 'unlocked') {
          // Slice 4 — the vault sub-DEK is now available. Re-load the vault
          // so persisted `{{vault.*}}` creds (undecryptable at the locked
          // first load) populate the STABLE baseVault the executor reads.
          await initVault();
        }
      } catch (err) {
        console.error(
          '[vault] boot auto-unlock failed — server stays locked '
            + '(recovery-key re-pair required): '
            + (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  };

  let upstreamMergeRegistryRef: UpstreamMergeRegistry | undefined;
  let activeContactMergeScanMode: 'delta' | 'full' = 'delta';
  let apiConnectionLookupRef: ConnectionLookup | undefined;
  let refreshApiConnectionAuthRef: RefreshApiConnectionAuth | undefined;
  let registerSalesforceCallEntityRef: RegisterSalesforceCallEntity | undefined;

  base.bootTrace.mark('shared-setup-complete');
  base.bootTrace.mark('vault-init-start');
  await initVault();
  base.bootTrace.mark('vault-init-complete');
  base.bootTrace.mark('dispatch-subcommand', base.subcommand ?? 'serve');

  const postStorage = await startPostStorageAppCollectionExecutionRuntime({
    app: {
      db: storageContext.db,
      dbPath: base.dbPath,
      serverBundleStore,
      initialServerBundle,
      envLlmConfig: storageContext.envLlmConfig,
      gateRegistry: storageContext.gateRegistry,
      auditLog: storageContext.auditLog,
      eventBus: storageContext.eventBus,
      serverInstanceId: storageContext.serverInstanceId,
      recipeStore: storageContext.recipeStore,
      pairedInstances: storageContext.pairedInstances,
      workEntityStore: storageContext.workEntityStoreRef,
    },
    publishKeys: (keys) => {
      keysRef = keys;
    },
    collection: {
      runtimeConfig: base.runtimeConfig,
      manifests: storageContext.manifests,
      baseVault,
      accountStore: storageContext.accountStore,
    },
    execution: {
      storage: storageContext,
      baseVault,
      env: options.env ?? process.env,
    },
    postApp: {
      postExecution: {
        bootstrapCascade: {
          base: {
            loadedConfig: base.loadedConfig,
            runtimeConfig: base.runtimeConfig,
          },
          serverVersion: options.serverVersion,
          storage: storageContext,
        },
        maintenance: {
          dbPath: base.dbPath,
          storage: storageContext,
          backgroundServices,
        },
        runtime: {
          lifecycle: {
            db: storageContext.db,
            base: {
              dbPath: base.dbPath,
              port: base.port,
              distribution: base.distribution,
              loadedConfig: base.loadedConfig,
              runtimeConfig: base.runtimeConfig,
            },
            serverVersion: options.serverVersion,
            auditLog: storageContext.auditLog,
            // Blob-encryption fix Phase 2 — late-bound KeyManager accessor for
            // the archive rpc deps (export decrypts the encrypted cache_blobs
            // root). Late-bound over `keysRef`, which `publishKeys` populates
            // once `composeAppContext` runs (after this bag is assembled);
            // resolved at export time. Same pattern as `getVaultKey` above.
            getKeys: () => keysRef,
            storage: storageContext,
            backgroundServices,
          },
          recovery: {
            bootSigningIdentity,
            configPath: base.loadedConfig.source,
            checkpointStore: storageContext.checkpointStore,
            auditLog: storageContext.auditLog,
            commitStore: storageContext.commitStore,
            gatedActionStore: storageContext.gatedActionStore,
            preapprovalStorage: storageContext.preapprovalStorage,
            fileStack: storageContext.fileStack,
            // D-210 Phase C — so the boot sweep does not re-raise the
            // actionable ask for a notify-mode reception hold that is
            // ask-less on purpose.
            ...(storageContext.publicEndpointRegistryStoreRef
              ? {
                  resolveInboxFanoutMode: () =>
                    resolveReceptionInboxFanoutModeFromStore(
                      storageContext.publicEndpointRegistryStoreRef!,
                    ),
                }
              : {}),
          },
          preListener: {
            args: base.args,
            dbPath: base.dbPath,
            port: base.port,
            webhookPort: base.loadedConfig.bootstrap.webhook_port,
            runtimeConfig: base.runtimeConfig,
            backgroundServices,
            storage: storageContext,
            schedulerRegistry,
            enrichmentProducers: schedulerRegistry.producers(),
            env: options.env ?? process.env,
          },
          getSigningIdentity: () => signingIdentityRef,
          getUpstreamMergeRegistry: () => upstreamMergeRegistryRef,
          publishUpstreamMergeRegistry: (registry) => {
            upstreamMergeRegistryRef = registry;
          },
          setActiveContactMergeScanMode: (mode) => {
            activeContactMergeScanMode = mode;
          },
          getApiConnectionLookup: () => apiConnectionLookupRef,
          getRefreshAuth: () => refreshApiConnectionAuthRef,
          getRegisterSalesforceCallEntity: () => registerSalesforceCallEntityRef,
          publishVendorRefs: (vendorRefs) => {
            apiConnectionLookupRef = vendorRefs.apiConnectionLookup;
            refreshApiConnectionAuthRef = vendorRefs.refreshApiConnectionAuth;
            if (vendorRefs.registerSalesforceCallEntity !== undefined) {
              registerSalesforceCallEntityRef =
                vendorRefs.registerSalesforceCallEntity;
            }
          },
          getActiveContactMergeScanMode: () => activeContactMergeScanMode,
        },
      },
    },
  });

  return {
    storage: storageContext,
    postStorage,
    getBaseVault: () => baseVault,
    getSigningIdentity: () => signingIdentityRef,
  };
};

export const startPostStorageAppCollectionExecutionRuntime = async (
  options: StartPostStorageAppCollectionExecutionRuntimeOptions,
): Promise<PostStorageAppCollectionExecutionRuntimeResult> => {
  const lateBound = createExecutionLateBoundRefs();
  const app = composeAppContext({
    ...options.app,
    chatLateBound: lateBound,
  });
  options.postApp.postExecution.maintenance.backgroundServices.register({
    name: 'warehouse-event-bridges',
    kind: 'emitter',
    stop: app.stopWarehouseEventBridges,
  });
  // ⛔ PUBLISHED HERE because this is the one place holding BOTH halves: the
  //   full refs bag (`lateBound`) and the composed app. `composeAppContext`
  //   receives only the GETTERS half by type (`AppContextChatLateBoundGetters`)
  //   and so cannot publish; the execution context is composed after this line
  //   and reads the sink through the same bag at settle time.
  lateBound.publishRunSettledSink(app.chatRunSettledSink);
  const contactBackfillDone = app.contactBackfillDone;
  if (contactBackfillDone !== undefined) {
    options.postApp.postExecution.maintenance.backgroundServices.register({
      name: 'contact-boot-backfill',
      kind: 'emitter',
      stop: () => contactBackfillDone,
    });
  }
  // Slice 3b — publish the KeyManager up to the boot runtime so the
  // post-boot signing-identity step can auto-unlock the server vault from
  // the keyfile before listeners accept work.
  options.publishKeys?.(app.keys);

  const postApp = await startPostAppCollectionExecutionRuntime({
    collection: {
      ...options.collection,
      db: options.app.db,
      dbPath: options.app.dbPath,
      auditLog: options.app.auditLog,
      cacheBlobs: app.cacheBlobs,
      warehouseBus: app.warehouseBus,
      contactStore: app.contactStoreRef,
      gateRegistry: options.app.gateRegistry,
      eventBus: options.app.eventBus,
      keys: app.keys,
      vaultStateBus: app.vaultStateBus,
      connectionStore: app.connectionStoreRef,
      workEntityStore: options.app.workEntityStore,
      enrichmentCascade: app.enrichmentCascadeRef,
      // D-192 P4b — late-bound: the ref is populated post-listener by
      // `composeWorkEntityWriteExecutor` once the fetch deps exist.
      getWorkEntityWriteExecutor: () => app.workEntityWriteExecutorRef.current,
      annotationDeps: app.annotationDeps,
      // D-192 remote byte-fetch — mail-send attachment refs resolve a
      // `file:remote:*` id through the shared bundle (lazy; undefined until the
      // file-source wiring runs).
      getRemoteFileReadDeps: app.getRemoteFileReadDeps,
    },
    execution: {
      ...options.execution,
      app,
      lateBound,
    },
    postExecution: {
      ...options.postApp.postExecution,
      bootstrapCascade: {
        ...options.postApp.postExecution.bootstrapCascade,
        app,
      },
      maintenance: {
        ...options.postApp.postExecution.maintenance,
        app,
      },
      runtime: {
        ...options.postApp.postExecution.runtime,
        preListener: {
          ...options.postApp.postExecution.runtime.preListener,
          app,
        },
        getContactMergeCycleObserver: () => app.contactMergeCycleObserverRef,
        // D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — wire the
        // late-bound dispatcher publisher through the listener-runtime
        // chain so `composeListeners` fires it BEFORE schedulers spin
        // up. Without this in-chain hook, cron + auto_run schedulers
        // could dispatch a DOM step into the dom slot before the
        // dispatcher is published, mis-classifying the unwired state
        // as `ROLE_RESTRICTION` "no bridge connected." The in-chain
        // publish AND the listener-runtime's return path both feed the
        // same `lateBound.publishBridgeDispatcher`; the chain publish
        // wins by ordering.
        publishBridgeDispatcher: lateBound.publishBridgeDispatcher,
      },
    },
  });

  return {
    lateBound,
    app,
    postApp,
  };
};
