import type { RuntimeConfigStore } from '@recued/config';
import type { LifecycleStatus } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';

import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import {
  composeServerHeartbeatEmitter,
  type ServerHealthSnapshot,
} from '../composition/bin/wire-server-heartbeat-emitter.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';
import type { EventTriggerDispatcher } from '../triggers/dispatcher.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';
import type { MessengerIngressSupervisor } from '../messenger-ingress/supervisor.js';
import type { UpstreamMergeRegistry } from '../data/vendor-boot-registry.js';
import type { EvictionCascade } from '../eviction-cascade.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import type { Lifecycle } from '../lifecycle/index.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { AppContext } from './compose-app-context.js';
import {
  composeCertStackLate,
  type ComposeCertStackLateOptions,
} from './compose-cert-stack-late.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { ListenerServerFacade } from './compose-listeners.js';
import type { StorageContext } from './compose-storage-context.js';
import type { VendorSubstratePublishedRefs } from './compose-vendor-substrate.js';
import { composeCanonicalCrmReconciliation } from './compose-canonical-crm-reconciliation.js';
import { composeGenericEngagementReconciliation } from './compose-generic-engagement-reconciliation.js';
import { composeWorkEntitySourceSync } from './compose-work-entity-source-sync.js';
import { composeContactSourceSync } from './compose-contact-source-sync.js';
import { buildCanonicalPollDeps } from '../watch/canonical-poll-deps.js';
import { handleExecute } from '../execute-handler.js';
import { liveVendorRegistry } from '../connection-convention-families.js';
import { buildSellerAccessReconcileDepsIfReady } from '../seller/access-reconcile-deps.js';
import { handleConnectionProbe } from '../connection-handler.js';
import { mcpGeneratedPackSlug } from '@recued/ingredient-authoring';
import type { McpToolsDriftProbeDeps } from '../housekeeping/tasks/mcp-tools-drift-probe.js';
import {
  startHousekeepingStartup,
  type StartHousekeepingStartupOptions,
} from './start-housekeeping-startup.js';
import {
  startPostHousekeepingTail,
  type StartPostHousekeepingTailOptions,
} from './start-post-housekeeping-tail.js';
import { startProConvenienceProvisioning } from './start-pro-convenience-provisioning.js';
import {
  startSchedulers,
  type StartSchedulersOptions,
} from './start-schedulers.js';
import { wrapServePeerCache } from './wrap-peer-cache.js';
import { wireVaultGatedExecutors } from '../vault-gated-executors.js';
import { composeRecordsOutbox } from '../composition/bin/wire-records-outbox.js';

export type PostListenerRuntimeStorageContext =
  StartHousekeepingStartupOptions['storage']
  & StartPostHousekeepingTailOptions['storage']
  & Pick<StorageContext, 'recordsStore' | 'recipeStore'>;

export type PostListenerRuntimeAppContext =
  StartHousekeepingStartupOptions['app']
  & StartPostHousekeepingTailOptions['app']
  & Pick<
    AppContext,
    | 'cacheStore' | 'isVaultUnlocked' | 'vaultStateBus'
    // D-192 P3b — the work-entity Source sync substrate.
    | 'workEntitySourceMirrorRef' | 'workEntitySourceSyncStateRef'
    // D-192 — the shared connection→catalog-manifest resolver (pack-declared
    // `work_entity_sources` in the sync wire, no drift vs. boot/write).
    | 'resolveWorkEntityCatalogManifestRef'
    // D-192 — join the install-hook reconcile fan-out (sync-task reinstall).
    | 'registerWorkEntitySourceReconcilerRef'
    // D-192 P5 — the work-graph edge substrate (sync-fold reconcile).
    | 'workEntityEdgeStoreRef'
    // D-192 — the container-entity selection store (persist-dependency list
    // scoping + CORE #8b hydration read args in the sync wire).
    | 'workEntitySourceDependencyStoreRef'
    // D-192 P4b — the late-bound write-executor factory.
    | 'composeWorkEntityWriteExecutor'
    // D-192 F1 — the commitment-evidence capture runtime ref + the
    // `record_contact_edges` counterparty resolver handed to it.
    | 'commitmentEvidenceRuntimeRef'
    | 'resolveCommitmentEvidenceCounterparty'
    // D-205 #4c — the contact Source SYNC substrate. The wire moved here from
    // `composeAppContext` because the Google People leaf dispatches through the
    // catalog gateway, whose deps only exist post-listener.
    //
    // ⚠ A ref the composer cannot SEE is a ref the composer silently does without —
    // this family has produced that bug twice (#2c's `contactSourceSyncStateRef` was
    // a function-local `let`; `de2a1ec6f`'s `enrichmentCascadeRef` was on the context
    // but absent from a `Pick<>`). Both times the feature was "built" and wired to
    // nothing. So: on the Pick, explicitly.
    | 'contactStoreRef'
    | 'contactSourceSyncStateRef'
    | 'crmRecordMirrorStoreRef'
    // D-196 §6.3 (s2b) — the seller stores the access reconciler converges. On
    // the Pick explicitly, per the warning above: this wire is the FIRST place
    // both these refs AND `executeDeps` (the gateway spine) exist, so it is the
    // only place the reconciler deps can be built — and a ref left off the Pick
    // is a reconciler silently wired to nothing, which is the exact bug s1/s2a/
    // s2c already skirted by shipping inert.
    | 'sellerStoreRef'
    | 'contractStoreRef'
    | 'chatInboundTokenStoreRef'
    | 'sellerClaimStoreRef'
  >;

export type PostListenerRuntimeCollectionContext =
  StartHousekeepingStartupOptions['collection']
  & StartPostHousekeepingTailOptions['collection'];

export interface StartPostListenerRuntimeOptions {
  readonly dbPath: string;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly storage: PostListenerRuntimeStorageContext;
  readonly app: PostListenerRuntimeAppContext;
  readonly collection: PostListenerRuntimeCollectionContext;
  readonly executorConfig: Pick<ServerExecutorConfig, 'cacheStore' | 'wsServer'>;
  readonly server: Pick<ListenerServerFacade, 'wsServer' | 'port' | 'close'>;
  readonly scheduleStore: StartSchedulersOptions['scheduleStore'];
  readonly executeDeps: StartSchedulersOptions['executeDeps'];
  readonly circuitStore: StartSchedulersOptions['circuitStore'];
  readonly autoRunSettingsStore: StartSchedulersOptions['autoRunSettingsStore'];
  readonly certStack: ComposeCertStackLateOptions['certStack'];
  readonly tlsDomainStore: ComposeCertStackLateOptions['tlsDomainStore'];
  readonly lanAdvertisedAddress: ComposeCertStackLateOptions['lanAdvertisedAddress'];
  /** Whether a verified webclient bundle is served (for the boot banner's
   *  local-webclient URL). Threaded from `composeListeners`. */
  readonly webclientServed: boolean;
  readonly actualPort: ComposeCertStackLateOptions['actualPort'];
  readonly upstreamMergeRegistry: UpstreamMergeRegistry | undefined;
  /** Reactive-substrate slice 1 — live event-trigger dispatcher from
   *  `composeListeners` (undefined on dbless boots). Registered with
   *  the background-services registry here so shutdown + maintenance
   *  disarm it alongside the schedulers. */
  readonly eventTriggerDispatcher: EventTriggerDispatcher | undefined;
  /** Poll-manager / G6 — live watch manager from `composeListeners`
   *  (undefined on dbless boots). Same registration posture as the
   *  dispatcher: stop disarms every poll loop + awaits in-flight
   *  polls; maintenance exit re-arms via the maintenance context's
   *  late-bound recompute hook. */
  readonly watchManager: PollManagerHandle | undefined;
  /** Outbound-established messenger connections stay live during scheduler-only
   * maintenance and stop during whole-process shutdown. */
  readonly messengerIngressSupervisor?: MessengerIngressSupervisor;
  readonly publishSchedulersBundle: (bundle: SchedulersBundle) => void;
  readonly publishVendorRefs: (refs: VendorSubstratePublishedRefs) => void;
  readonly rotationEngine: StartHousekeepingStartupOptions['rotationEngine'];
  readonly getActiveContactMergeScanMode:
    StartHousekeepingStartupOptions['getActiveContactMergeScanMode'];
  readonly getContactMergeCycleObserver:
    StartHousekeepingStartupOptions['getContactMergeCycleObserver'];
  readonly enrichmentProducers:
    StartHousekeepingStartupOptions['enrichmentProducers'];
  readonly cloudBaseUrl: string;
  readonly getSigningIdentity: () => BootedServerIdentity | undefined;
  /** Tier 3 — live lifecycle snapshot for the `server_heartbeat` emitter's
   *  READY gate (it emits only while `running`). Threaded as a thunk like
   *  `getSigningIdentity` rather than widening the narrow lifecycle Pick,
   *  since the emitter needs only the snapshot. Absent → the emitter is
   *  not wired (db-less / no-lifecycle boots have no warehouse + no clients). */
  readonly getLifecycleSnapshot?: () => LifecycleStatus | undefined;
  /** Tier 3 / D-109 A2 — running-server health (kill-switch + pressure) for
   *  the heartbeat snapshot's pill paused/attention states. Threaded as a
   *  thunk alongside `getLifecycleSnapshot`. Absent → pill stays plain green. */
  readonly getServerHealth?: () => ServerHealthSnapshot | undefined;
  readonly lifecycle: Pick<Lifecycle, 'install' | 'markBooted'> | undefined;
  readonly cascade: Pick<EvictionCascade, 'close'> | undefined;
  /** D-157 N.8 — threaded to the stale-checkpoint retention sweep
   *  (`startPostHousekeepingTail` → `startRetentionPruners`). */
  readonly notificationBlock:
    | Pick<NotificationBlock, 'getAsk' | 'cancelAsk' | 'recoverPendingAsks' | 'pruneHandledAsks'>
    | undefined;
  /** D-178 slice 4b — on-boot update reconcile; the tail runs it after
   *  markBooted. Undefined on a delegated channel / dbless boot. */
  readonly runUpdateBootReconcile: StartPostHousekeepingTailOptions['runUpdateBootReconcile'];
}

export interface PostListenerRuntimeResult {
  readonly schedulersBundle: SchedulersBundle;
  readonly vendorRefs: VendorSubstratePublishedRefs | undefined;
}

export const startPostListenerRuntime = async (
  options: StartPostListenerRuntimeOptions,
): Promise<PostListenerRuntimeResult> => {
  options.executorConfig.wsServer = options.server.wsServer;

  // Tier 3 — server heartbeat emitter. The ws handle is live now, so start
  // the periodic `server_heartbeat` push: paired clients detect a half-open
  // (socket accepted, rpc/warehouse layer not yet ready) server purely by
  // the ABSENCE of beats, since the composer gates emission on lifecycle
  // `running`. Only wired when the snapshot thunk is threaded — a db-less /
  // no-lifecycle boot has no ready signal (and no paired clients) to serve.
  if (options.getLifecycleSnapshot !== undefined) {
    const getLifecycleSnapshot = options.getLifecycleSnapshot;
    composeServerHeartbeatEmitter({
      registry: options.backgroundServices,
      broadcast: (payload) =>
        options.server.wsServer.broadcastServerHeartbeat(payload),
      getLifecycleSnapshot: () => getLifecycleSnapshot(),
      getServerId: () =>
        options.getSigningIdentity()?.identity.serverIdentityKey()
          .public_key_fingerprint ?? null,
      ...(options.getServerHealth !== undefined
        ? { getServerHealth: options.getServerHealth }
        : {}),
    });
  }

  wrapServePeerCache({
    cacheStore: options.app.cacheStore,
    wsServer: options.server.wsServer,
    executorConfig: options.executorConfig,
  });

  composeRecordsOutbox({
    recordsStore: options.storage.recordsStore,
    recipeStore: options.storage.recipeStore,
    ...(options.app.contractStoreRef
      ? { contractStore: options.app.contractStoreRef }
      : {}),
    executeDeps: options.executeDeps,
    backgroundServices: options.backgroundServices,
  });

  // D-192 P4b — populate the work-entity write executor BEFORE any
  // scheduler starts (codex MEDIUM: a cron/reactive fire in the gap
  // would refuse a valid connection-Source write with
  // SOURCE_NOT_WRITE_CAPABLE). The sync-task wire below stays in its
  // deliberate post-housekeeping slot; the executor has no such
  // ordering constraint — it only needs executeDeps + the connection
  // store, both live here.
  if (options.executeDeps !== undefined && options.app.connectionStoreRef !== undefined) {
    options.app.composeWorkEntityWriteExecutor?.(
      buildCanonicalPollDeps(options.executeDeps, options.app.connectionStoreRef),
    );
  }

  // D-192 F1 — populate the commitment-evidence capture runtime BEFORE
  // the schedulers start (same rationale as the write executor above: a
  // reconciler fold in the gap would skip its capture un-claimed; the
  // NEXT fold of the same value re-proposes, but there is no reason to
  // leave the gap open). The proposal fires through `handleExecute`
  // under the reception drain's reactive/system posture — the kernel
  // `commitment-create` op holds at the D-157 gate (approval: 'ask'),
  // so this wire creates held proposals, never commitments.
  // The ref-presence guard keeps harness parity: unit harnesses build
  // partial app objects (cast), and a missing ref must degrade to
  // "capture skipped" (the producer's own absent-runtime posture) —
  // never a boot throw.
  if (options.executeDeps !== undefined && options.app.commitmentEvidenceRuntimeRef !== undefined) {
    const executeDeps = options.executeDeps;
    options.app.commitmentEvidenceRuntimeRef.current = {
      fire: async ({ recipe, execution_source, payload, run_id }) => {
        const result = await handleExecute(
          executeDeps,
          {
            recipe: recipe as unknown as Record<string, unknown>,
            trigger_source: 'reactive',
            execution_source,
            context: { event: { payload } },
          },
          { run_id },
        );
        // The EXPECTED outcome is a durable HOLD (`awaiting_approval` —
        // the commitment-proposal lift asks for every actor). A success
        // would mean an already-approved mint (keep the claim). A hard
        // failure (neither) must THROW so the producer releases its
        // ledger claim — a transiently-failed proposal re-fires on the
        // next fold of the same value.
        if (!result.success && result.awaiting_approval === undefined) {
          throw new Error(
            `commitment-evidence proposal run failed pre-hold (run_id=${run_id})`,
          );
        }
      },
      resolveVendorRegistry: () => liveVendorRegistry(executeDeps.localManifestStore),
      // D-192 F1 — the deal→contact counterparty seam. The producer
      // calls it per capture; it self-degrades to undefined (empty
      // counterparty) when the engagement / contact stores are absent.
      resolveCounterpartyContactId: options.app.resolveCommitmentEvidenceCounterparty,
    };
  }

  const schedulersBundle = startSchedulers({
    registry: options.backgroundServices,
    db: options.storage.db,
    scheduleStore: options.scheduleStore,
    executeDeps: options.executeDeps,
    recipeStore: options.storage.recipeStore,
    circuitStore: options.circuitStore,
    autoRunSettingsStore: options.autoRunSettingsStore,
    // R21.1 — cron + auto-run ticks no-op while the vault is sealed.
    isVaultUnlocked: options.app.isVaultUnlocked,
  });
  options.publishSchedulersBundle(schedulersBundle);

  // Reactive-substrate slice 1 — event-trigger dispatcher shutdown.
  // Registered `kind: 'scheduler'` so migration maintenance's
  // `stopAll({ kind: 'scheduler' })` also disarms trigger fan-out
  // during the quiet period. Stop awaits `drained()` so a dispatch
  // already inside `runtime.runRecipe` settles before the auth
  // re-encryption quiet period begins — mirrors auto-run's stop()
  // waiting on its in-flight executions (codex HIGH fold). Rebuild on
  // maintenance exit happens via the maintenance context's
  // `onExitMaintenance` hook (second codex HIGH fold), NOT here.
  if (options.eventTriggerDispatcher) {
    const dispatcher = options.eventTriggerDispatcher;
    options.backgroundServices.register({
      name: 'event-trigger-dispatcher',
      kind: 'scheduler',
      stop: async () => {
        dispatcher.dispose();
        await dispatcher.drained();
      },
    });
  }

  // Poll-manager / G6 — watch-loop shutdown. Same `kind: 'scheduler'`
  // class: migration maintenance disarms polling during the quiet
  // period; stop() awaits in-flight polls so a gateway call mid-flight
  // settles first. Re-arm on maintenance exit goes through the
  // maintenance context's recompute hook (the dispatcher-rebuild
  // posture), NOT here.
  if (options.watchManager) {
    const watchManager = options.watchManager;
    options.backgroundServices.register({
      name: 'watch-poll-manager',
      kind: 'scheduler',
      stop: async () => {
        await watchManager.stop();
      },
    });
  }

  if (options.messengerIngressSupervisor) {
    const supervisor = options.messengerIngressSupervisor;
    options.backgroundServices.register({
      name: 'messenger-local-ingress',
      kind: 'emitter',
      stop: async () => {
        await supervisor.stop();
      },
    });
  }

  // R21.1 — vault-gated-executors coordinator. Each executor PAUSES
  // itself while the vault is sealed (its tick/dispatch gates on the
  // live `isVaultUnlocked` predicate); this owns the RESUME edge —
  // on unlock it kicks the executors that would otherwise stay dormant
  // (auto-run + cron catch-up tick, watch re-arm). Registered
  // `kind: 'emitter'` — NOT `'scheduler'` — deliberately: the auth-
  // migration maintenance window does `stopAll({ kind: 'scheduler' })`
  // then rebuilds the schedulers/dispatcher/watches but NOT this, and
  // `keys.unlock()` only fires AFTER maintenance exits. A `'scheduler'`
  // tag would dispose this bus subscription during that window and lose
  // the post-migration unlock kick (the uninitialized→migrate→unlock
  // path is the headline repro). `'emitter'` survives the scheduler-
  // scoped stopAll yet is still disposed at shutdown's unfiltered
  // `stopAll()`. Its handle accessors read the bundle slots' live
  // bindings, so the rebuilt scheduler handles are picked up
  // transparently.
  {
    const coordinator = wireVaultGatedExecutors({
      vaultStateBus: options.app.vaultStateBus,
      getAutoRunHandle: () => schedulersBundle.autoRun?.getHandle(),
      getCronHandle: () => schedulersBundle.cron?.getHandle(),
      watchManager: options.watchManager,
      ...(options.notificationBlock
        ? {
            recoverPendingApprovals: () =>
              options.notificationBlock!.recoverPendingAsks(),
          }
        : {}),
    });
    options.backgroundServices.register({
      name: 'vault-gated-executors',
      kind: 'emitter',
      stop: async () => {
        await coordinator.dispose();
      },
    });
  }

  const {
    tlsCertSource,
    tlsRenewerConfigured,
  } = await composeCertStackLate({
    certStack: options.certStack,
    tlsDomainStore: options.tlsDomainStore,
    lanAdvertisedAddress: options.lanAdvertisedAddress,
    actualPort: options.actualPort,
  });

  // D-175 — Pro-convenience handle provisioning. Composed AFTER the late
  // cert stack so the handle state machine + binding-entitlement source
  // are live. Idempotent + self-gating; reserves `<handle>.recued.cloud`
  // with `publisher_id = serverIdentity fingerprint` once bound + entitled.
  startProConvenienceProvisioning({
    backgroundServices: options.backgroundServices,
    certStack: options.certStack,
    getSigningIdentity: options.getSigningIdentity,
  });

  // D-196 §6.3 (s2b) — build the seller-access reconciler deps HERE, the first
  // and only place both halves exist: the seller stores on the app context and
  // `executeDeps` (the gateway spine). Undefined ⇒ this server has no seller
  // substrate (or a partial harness) ⇒ the composer does not register the task.
  const sellerAccessReconcileDeps =
    options.executeDeps !== undefined
      ? buildSellerAccessReconcileDepsIfReady({
          gateway: {
            executorConfig: options.executeDeps.executorConfig,
            ...(options.executeDeps.connectionOperationProfiles
              ? { connectionOperationProfiles: options.executeDeps.connectionOperationProfiles }
              : {}),
            ...(options.executeDeps.connectionStore
              ? { connectionStore: options.executeDeps.connectionStore }
              : {}),
            ...(options.executeDeps.auditLog ? { auditLog: options.executeDeps.auditLog } : {}),
            ...(options.executeDeps.contractScan ? { contractScan: options.executeDeps.contractScan } : {}),
          },
          seller: {
            ...(options.app.sellerStoreRef ? { sellerStore: options.app.sellerStoreRef } : {}),
            ...(options.app.contractStoreRef ? { contractStore: options.app.contractStoreRef } : {}),
            ...(options.app.chatInboundTokenStoreRef
              ? { inboundTokenStore: options.app.chatInboundTokenStoreRef }
              : {}),
            ...(options.app.sellerClaimStoreRef
              ? { sellerClaimStore: options.app.sellerClaimStoreRef }
              : {}),
          },
        })
      : undefined;

  // D-225 § 12 — the idle drift probe's deps, built HERE for the same reason as
  // the seller reconciler above: the connection store, the manifest store and
  // the MCP transport seams first coexist at this point.
  //
  // 🔑 The probe primitives are read from the SAME sources `compose-listeners`
  // uses for the manual Probe rpc (`keys.keyProvider('connection')`, and
  // `executorConfig.connectionMcp`'s ws/stdio seams). That is deliberate and is
  // the property the whole design rests on: the idle probe is the authority and
  // the manual probe the accelerator, so they must be the same probe. If these
  // ever drift apart, a connection would report one thing on the badge and
  // another when the owner clicks Probe.
  //
  // ⛔ Undefined ⇒ the task does not register ⇒ drift detection is inert and the
  // badge reports what was true at the last manual probe.
  const mcpToolsDriftProbeDeps: McpToolsDriftProbeDeps | undefined = (() => {
    const store = options.app.connectionStoreRef;
    const exec = options.executeDeps;
    if (store === undefined || exec === undefined) return undefined;
    const manifests = exec.localManifestStore;
    if (manifests === undefined) return undefined;
    const mcpSeams = exec.executorConfig.connectionMcp;
    const probeDeps = {
      store,
      ...(options.app.keys && options.app.keys.state() !== 'uninitialized'
        ? { getEncryptionKey: options.app.keys.keyProvider('connection') }
        : {}),
      ...(mcpSeams?.wsConnect ? { wsConnect: mcpSeams.wsConnect } : {}),
      ...(mcpSeams?.spawnStdioMcp ? { spawnStdioMcp: mcpSeams.spawnStdioMcp } : {}),
    } as Parameters<typeof handleConnectionProbe>[0];
    return {
      listConnections: (query) => store.list(query),
      installedPackSlugFor: async (connection) => {
        // Derived, never stored — the same derivation `mcpPackStatus` and
        // teardown use, so all three agree by construction.
        const slug = await mcpGeneratedPackSlug(connection);
        // ⚠ `listManifests()` rather than `getManifest(slug)`: `executeDeps`
        // exposes a deliberately narrow `Pick` of the store, and widening a
        // Pick to suit one consumer is how a narrow surface stops being one.
        // The scan is over the installed set and runs on the idle cadence.
        return manifests.listManifests().some((m) => m.slug === slug) ? slug : null;
      },
      probe: (args) => handleConnectionProbe(probeDeps, args),
    };
  })();

  let vendorRefs: VendorSubstratePublishedRefs | undefined;
  await startHousekeepingStartup({
    storage: options.storage,
    app: options.app,
    collection: options.collection,
    upstreamMergeRegistry: options.upstreamMergeRegistry,
    publishVendorRefs: (refs) => {
      vendorRefs = refs;
      options.publishVendorRefs(refs);
    },
    backgroundServices: options.backgroundServices,
    rotationEngine: options.rotationEngine,
    tlsCertSource,
    tlsRenewerConfigured,
    getSchedulerBundle: () => schedulersBundle,
    getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
    getContactMergeCycleObserver: options.getContactMergeCycleObserver,
    enrichmentProducers: options.enrichmentProducers,
    ...(sellerAccessReconcileDeps ? { sellerAccessReconcileDeps } : {}),
    ...(mcpToolsDriftProbeDeps ? { mcpToolsDriftProbeDeps } : {}),
  });

  // D-190 MS4 — register the generic CRM reconcilers for bound pack-CRM
  // connections (Pipedrive / any `crm_alias` vendor) that lack a bespoke
  // reconciler, so they mirror exactly like hb/sf. AFTER the bespoke vendor boots
  // (`startHousekeepingStartup`) so they're never double-driven, and BEFORE the
  // watch recompute below so the manager defers to their housekeeping tasks the
  // same way it defers to the D-129/D-130 reconcilers.
  composeCanonicalCrmReconciliation({
    getExecuteDeps: () => options.executeDeps,
    connectionStore: options.app.connectionStoreRef,
    crmRecordMirror: options.app.crmRecordMirrorStoreRef,
    lookupConnection: vendorRefs?.apiConnectionLookup,
  });

  // D-192 S4c2 — the engagement-plane sibling of the CRM wire above: register the
  // generic `delta_cursor` engagement reconcilers for bound pack connections
  // (Dynamics / any delta engagement vendor) whose vendor has a registered leaf.
  // Same placement + rationale: AFTER the bespoke vendor boots (so hb/sf are
  // skipped) and BEFORE the watch recompute. Inert until S4c3 registers the
  // Dynamics leaf (the leaf registry is empty at S4c2).
  composeGenericEngagementReconciliation({
    getExecuteDeps: () => options.executeDeps,
    connectionStore: options.app.connectionStoreRef,
    engagementStore: options.app.engagementStoreRef,
    lookupConnection: vendorRefs?.apiConnectionLookup,
    contactStore: options.app.contactStoreRef,
  });

  // D-192 P3b — one housekeeping sync task per registered
  // connection-Source with a work-entity declaration (kernel hb/sf
  // today; pack-declared vendors when the decomposer pass-through
  // lands). Same placement rationale as the CRM wire above: executeDeps
  // is live, and the watch recompute below sees the registered tasks.
  composeWorkEntitySourceSync({
    getExecuteDeps: () => options.executeDeps,
    connectionStore: options.app.connectionStoreRef,
    mirror: options.app.workEntitySourceMirrorRef,
    syncState: options.app.workEntitySourceSyncStateRef,
    // D-192 P5 — the edge substrate + its resolution lookups (contact
    // stack for D-138 pairing, work-entity store for canonical_id
    // verification; the mirror above doubles as the sibling-Source
    // resolver).
    edges: options.app.workEntityEdgeStoreRef,
    contactStore: options.app.contactStoreRef,
    workEntityStore: options.storage.workEntityStoreRef,
    // D-192 — the container-entity selection store: the sync cycle populates
    // persist selections (lone-option auto-select) AND consumes them for the
    // list scope + CORE #8b hydration read args (codex HIGH: previously never
    // reached the sync wire, leaving persist deps test-only in production).
    dependencyStore: options.app.workEntitySourceDependencyStoreRef,
    // D-192 — the SAME closure the boot wire + write executor consume, so
    // sync tasks enumerate pack-declared Sources (kernel ∪ pack) without drift.
    resolveCatalogManifest: options.app.resolveWorkEntityCatalogManifestRef,
    // D-192 — join the install-hook fan-out so a reinstall re-derives the sync
    // task's declaration closure alongside the Source (follow-on #2).
    registerReconciler: options.app.registerWorkEntitySourceReconcilerRef,
  });

  // D-205 #4c — the declared contact Source sync tasks. Same placement rationale as
  // the two wires above: `executeDeps` is live by now, which the Google People leaf
  // REQUIRES (it dispatches the pack's `contact.connections.list` through the gated +
  // audited catalog gateway — there is no vendor client in this tree). The CRM
  // contact leaf rides along; it only ever needed the mirror.
  //
  // Source REGISTRATION already happened in `composeAppContext` — a Source that
  // cannot sync must still be visible, and say so.
  composeContactSourceSync({
    getExecuteDeps: () => options.executeDeps,
    connectionStore: options.app.connectionStoreRef,
    store: options.app.contactStoreRef,
    syncState: options.app.contactSourceSyncStateRef,
    crmMirror: options.app.crmRecordMirrorStoreRef,
  });

  // Poll-manager / G6 — FIRST demand compute, deliberately AFTER
  // `startHousekeepingStartup` so the vendor reconcilers (D-129 /
  // D-130) have registered their housekeeping tasks and the manager's
  // deference check sees them. A compose-time recompute would arm poll
  // loops for kernel-vendor keys the reconciler already covers (one
  // spurious gated poll per key per boot).
  options.watchManager?.recompute();

  startPostHousekeepingTail({
    dbPath: options.dbPath,
    runtimeConfig: options.runtimeConfig,
    backgroundServices: options.backgroundServices,
    storage: options.storage,
    app: options.app,
    collection: options.collection,
    cloudBaseUrl: options.cloudBaseUrl,
    getSigningIdentity: options.getSigningIdentity,
    lifecycle: options.lifecycle,
    cascade: options.cascade,
    server: options.server,
    webclientServed: options.webclientServed,
    notificationBlock: options.notificationBlock,
    runUpdateBootReconcile: options.runUpdateBootReconcile,
  });

  return {
    schedulersBundle,
    vendorRefs,
  };
};
