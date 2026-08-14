import type { RuntimeConfigStore } from '@recued/config';
import { zoneByLabel, type LifecycleStatus } from '@recued/contracts';
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
import { composeProCertEnrollment } from '../composition/bin/wire-pro-cert-enrollment.js';
import { composeCustomDomainEnrollment } from '../composition/bin/wire-custom-domain-enrollment.js';
import {
  createNodeCustomDomainDnsResolver,
  runCustomDomainPreflight,
} from '../hostname/custom-domain-preflight.js';
import { createSqliteHandleStateStore } from '../handle/sqlite-store.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';
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
import { classifyRunFailure } from '@recued/engine';
import { composeExchangeRetry } from '../composition/bin/wire-exchange-retry.js';
import { composePeerAskTimeoutSweep } from '../composition/bin/wire-peer-ask-timeout.js';
import { RUN_INGREDIENT_RECIPE } from '../run-ingredient-recipe.js';
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
  // `serverInstanceId` stamps the enrollment row the same way
  // `compose-listeners` stamps rows written by `collection.hostname.*`.
  & Pick<StorageContext, 'recordsStore' | 'recipeStore' | 'serverInstanceId'>;

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
  /** D-225 auto-mint — the `mcp-pack-first-mint` sweep's deps, ALREADY BOUND by
   *  `composeListeners`. Deliberately an input rather than something this file
   *  builds: the mint needs the composition-capable install slice, which lives
   *  there. Undefined ⇒ the task does not register. */
  readonly mcpPackFirstMintDeps?:
    StartHousekeepingStartupOptions['mcpPackFirstMintDeps'];
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
    // D-225 auto-mint — arrives already bound from `composeListeners`; NOT built
    // here, because this site has no composition-capable install slice and a mint
    // on the bare one defers its composition while reporting success.
    ...(options.mcpPackFirstMintDeps
      ? { mcpPackFirstMintDeps: options.mcpPackFirstMintDeps }
      : {}),
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
    // D-148 § A.5.6 — the last hop of the lapse-recovery wiring. Resolved
    // LAZILY: the cert stack fills `handleStateMachineRef` in `composeLate`,
    // which can land after this call, so capturing the value here would pin
    // `undefined` and silently disable recovery with everything still typed
    // and green.
    applyLifecycle: () => options.certStack.getHandleStateMachineRef(),
  });

  // D-148 — Pro DDNS certificate enrollment. Nothing else creates a hostname
  // row or orders a first certificate: the only `.upsert(` callers are the
  // user-facing `collection.hostname.*` rpcs, and the renewal task explicitly
  // skips un-provisioned handles. Without this a paid server never gets a cert
  // unless a human opens Settings → Hostnames and adds it by hand.
  // ⚠ `getInitialAcmeIssuer` is resolved LAZILY — `composeLate` fills the ref
  //   after this runs, so capturing it here would pin `undefined` and disable
  //   enrollment with everything green.
  // ── D-232 § 24 — the retry sweep ──────────────────────────────────────
  //
  // ⚠ A RETRY MUST RUN UNDER THE AUTHORITY THAT SENT THE ORIGINAL, and that is
  // the only genuinely hard part of this wiring. The carrier's audit anchor
  // persisted its `execution_source` and `contract_snapshot`, so the re-send
  // restores them rather than minting fresh ones — a retry that ran as somebody
  // else would be a privilege escalation dressed as a convenience, and D-232
  // § 20.19 already had to make the same argument for the nested carrier run.
  // No anchor identity ⇒ NO RESEND: an exchange we cannot re-authorize is one we
  // must leave alone.
  // D-234 § 234.4m — THE DEADLINE FIRES. Registered here rather than in
  // housekeeping because housekeeping is IDLE-driven: a deadline that lands while
  // the server is busy would wait for a lull, and "your question expires at 5pm
  // unless the machine is working" is not a promise worth making.
  //
  // ⛔ GATED ON BOTH STORES AND BOTH RESUME DEPENDENCIES, and the gate is honest
  // rather than defensive: with any of them missing there is no way to record a
  // timeout or resume the run it belongs to, and a sweep that silently swallowed
  // that would be exactly the unkept promise this whole section exists to close.
  const timeoutDb = options.storage.db;
  const timeoutExecuteDeps = options.executeDeps;
  const timeoutOutbox = timeoutExecuteDeps?.peerAskOutbox;
  const timeoutAuditLog = options.storage.auditLog;
  const timeoutCheckpoints = timeoutExecuteDeps?.checkpointStore;
  if (
    timeoutDb !== undefined
    && timeoutExecuteDeps !== undefined
    && timeoutOutbox !== undefined
    && timeoutAuditLog !== undefined
    && timeoutCheckpoints !== undefined
  ) {
    const db = timeoutDb;
    const executeDeps = timeoutExecuteDeps;
    const outbox = timeoutOutbox;
    const auditLogForTimeout = timeoutAuditLog;
    const checkpoints = timeoutCheckpoints;
    void (async () => {
      const [{ createPeerAnswerStore }, { resumePeerHold }] = await Promise.all([
        import('../storage/peer-answer-store.js'),
        import('../peer-hold-resumer.js'),
      ]);
      const peerAnswers = createPeerAnswerStore(db);
      composePeerAskTimeoutSweep({
        registry: options.backgroundServices,
        // ⚠ DEV-ONLY OVERRIDE, for the same reason `exchange-retry` has one:
        // proving the sweep FIRES end to end otherwise needs a 60s wall-clock
        // wait that no drive will sit through. Absent ⇒ production default.
        ...(process.env.RECUED_PEER_ASK_TIMEOUT_INTERVAL_MS !== undefined
          ? { intervalMs: Number(process.env.RECUED_PEER_ASK_TIMEOUT_INTERVAL_MS) }
          : {}),
        sweep: {
          outbox,
          answers: peerAnswers,
          resume: async (target) => {
            await resumePeerHold(target, {
              getExecuteDeps: () => executeDeps,
              auditLog: auditLogForTimeout,
              checkpoints,
            });
          },
          logActivity: (row) => {
            void (auditLogForTimeout as unknown as {
              logActivity?: (r: unknown) => void;
            }).logActivity?.({ ...row, timestamp: Date.now() });
          },
        },
        // D-234 § 234.4n — the orphaned-hold half, on the same tick. ⚠ Gated on
        // the dish store: with no way to ask "is this dish still there", the
        // only safe answer is to abandon nothing.
        ...(executeDeps.dishStore !== undefined
          ? {
              abandon: {
                outbox,
                answers: peerAnswers,
                auditLog: auditLogForTimeout,
                dishes: executeDeps.dishStore,
                // ⛔ BEST EFFORT, AND THE CALLER SWALLOWS THE REJECTION. This is
                // a letter, not a recall: the local hold is already retired by
                // the time this runs, and an unreachable peer must not resurrect
                // it. Same direct path the ANSWER goes out on, for the same
                // reason — there is no run here to preflight, and asking the
                // owner to approve "tell them I stopped waiting" would spend the
                // attention this notice exists to save.
                notifyWithdrawn: async (row) => {
                  const { createServerExecutor } = await import('../server-executor.js');
                  const { CONNECTION_DIRECT_SLUG } = await import('@recued/contracts');
                  const { PEER_RECEIVE_ASK_TOOL } = await import('../peer-receive-ask-recipe.js');
                  const cfg = executeDeps.executorConfig;
                  if (cfg === undefined) throw new Error('executor config not yet published');
                  const res = await createServerExecutor(cfg)(CONNECTION_DIRECT_SLUG, {
                    connection_kind: 'mcp',
                    connection: row.connection,
                    // ⛔ THE ASK DOOR, DISCRIMINATED ON SHAPE — not a second
                    // tool. A withdrawal is the same conversation on the same
                    // door, so it needs no grant, no checklist entry and no
                    // advertisement of its own. § 234.4n's first cut shipped a
                    // separate tool and the per-token checklist refused it for
                    // every peer, silently, before any handler could log it.
                    tool: PEER_RECEIVE_ASK_TOOL,
                    args: { exchange_ref: row.exchange_ref, withdraw: true },
                  });
                  // ⛔⛔ A REFUSAL IS A RESULT, NOT AN ERROR ENVELOPE — the same
                  // rule this arc already learned at the ask door, re-learned
                  // here the hard way. The call SUCCEEDS and answers
                  // `withdrawn: false` when the peer kept the card, so a bare
                  // try/catch counted "sent" for a notice that closed nothing.
                  // The live drive is what said so: `notice sent=1 failed=0` on
                  // the same run where bob's card was still on his screen.
                  // ⚠ This changes no local decision — the hold is already
                  // retired — it only stops the counter from lying.
                  // ⛔⛔ ONLY AN EXPLICIT `withdrawn: true` COUNTS, AND THE FIRST
                  // CUT PATTERN-MATCHED THE ONE REFUSAL IT HAD THOUGHT OF
                  // (`"withdrawn":false`). Everything else — a tool error, an
                  // unknown-tool result, a shape we did not anticipate — sailed
                  // through as "sent". The drive said `notice sent=1 failed=0` on
                  // a run where the receiving server had not logged the call at
                  // all. 🔑 A refusal is a RESULT, not an error envelope, and
                  // enumerating refusals is how you miss the next one: assert the
                  // POSITIVE and treat every other answer as a failure.
                  const said = JSON.stringify(res ?? null);
                  if (!said.includes('"withdrawn":true')) {
                    throw new Error(`the peer did not confirm a withdrawal — ${said.slice(0, 200)}`);
                  }
                },
                logActivity: (row) => {
                  void (auditLogForTimeout as unknown as {
                    logActivity?: (r: unknown) => void;
                  }).logActivity?.({ ...row, timestamp: Date.now() });
                },
              },
            }
          : {}),
      });
    })();
  }

  if (options.storage.auditLog) {
    const auditLog = options.storage.auditLog;
    const carrierOf = async (ref: string) => {
      const rows = await auditLog.listByExchangeRef(ref, 200);
      return rows
        .filter((r) => r.recipe_id === 'run-ingredient')
        .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))[0];
    };
    composeExchangeRetry({
      registry: options.backgroundServices,
      // ⚠ DEV-ONLY OVERRIDE, and it exists because the honest test is otherwise
      // unrunnable: proving a retry FIRES end to end needs a 60s interval plus a
      // 60s backoff to elapse, which no drive waits for. Absent ⇒ production
      // default. A short interval is the only way this path has ever been
      // observed working rather than merely registered.
      ...(process.env.RECUED_EXCHANGE_RETRY_INTERVAL_MS !== undefined
        ? { intervalMs: Number(process.env.RECUED_EXCHANGE_RETRY_INTERVAL_MS) }
        : {}),
      pendingRefs: () => auditLog.listPendingExchangeRefs(50),
      rowsForRef: async (ref) =>
        (await auditLog.listByExchangeRef(ref, 200)).map((r) => ({
          recipe_id: r.recipe_id,
          status: String(r.commit_status ?? ''),
          at: r.finished_at ?? r.started_at ?? 0,
          errors: r.errors ?? [],
          config: r.config_snapshot ?? {},
          // D-232 § 30 — CHANGES NOTHING TODAY, AND IS HERE ANYWAY. `pendingRefs`
          // admits only refs whose newest CARRIER run FAILED, and an
          // `unanswerable` exchange has a succeeded carrier — so a peer verdict
          // cannot currently reach this sweep, and even if it did, the
          // carrier-failed rule outranks it inside the fold.
          //
          // ⚠ BUT THIS IS THE SECOND CALL SITE OF `deriveExchangeStatus`, and the
          // other one (the § 23 status surface) DOES map it. Two callers folding
          // one rule over different inputs is how a reordering later becomes a
          // silent divergence between "what the owner is told" and "what the
          // sweep decides" — with only one of them updated.
          ...(r.exchange_peer_ack !== undefined
            ? { peer_ack: r.exchange_peer_ack }
            : {}),
        })),
      // The carrier's own args carry the callback the exchange named.
      callbackForRef: () => undefined,
      healthForRef: () => undefined,
      classify: ((errors: readonly unknown[]) =>
        classifyRunFailure(errors)) as never,
      resend: async (ref, args) => {
        const carrier = await carrierOf(ref);
        if (carrier?.execution_source === undefined) {
          // See the authority note above — silence here is deliberate and safe:
          // the sweep simply never retries what it cannot re-authorize.
          return;
        }
        await handleExecute(
          options.executeDeps as Parameters<typeof handleExecute>[0],
          {
            // ⛔ INLINE, NOT BY ID. `run-ingredient` is a KERNEL recipe — bundled
            // in the binary and absent from `recipeStore` — so a resend by id
            // dies "Recipe 'run-ingredient' not found". The fire itself passes
            // the definition inline for exactly this reason; a retry that does
            // not is a sweep that finds its candidate, plans the attempt, logs
            // that it is re-sending, and sends nothing. Which is what it did.
            recipe: RUN_INGREDIENT_RECIPE as unknown as Record<string, unknown>,
            config: args,
            execution_source: carrier.execution_source,
            ...(carrier.contract_snapshot !== undefined
              ? { contract_snapshot: carrier.contract_snapshot }
              : {}),
          },
          // Files the new attempt under the SAME ref, which is what makes it an
          // attempt rather than a new exchange — and what lets the next sweep
          // count it.
          { exchange_ref: ref },
        );
      },
    });
  }

  if (options.storage.db) {
    composeProCertEnrollment({
      registry: options.backgroundServices,
      handleStateStore: createSqliteHandleStateStore({ db: options.storage.db }),
      hostnameRegistry: createHostnameRegistryStore(options.storage.db),
      getInitialAcmeIssuer: () => options.certStack.getInitialAcmeDomainIssuerRef(),
      serverIdentityId: () => options.storage.serverInstanceId,
      // ⛔ THIS LINE WAS MISSING AND THE GATE WAS INERT. The dep is optional, so
      //    omitting it silently means "treat as unlocked" — the composer, its
      //    tests (which pass their own predicate) and tsc were all green while
      //    a sealed server would have run enrollment anyway. Classic
      //    caller-obligation seam: the factory made the caller do the last
      //    step, and the caller forgot.
      isVaultUnlocked: options.app.isVaultUnlocked,
    });

    // D-235 P3 — the bring-your-own-domain sibling. Shares the issuer ref and
    // the vault gate with the fleet-zone service above but keeps its own
    // backoff, so a user's broken zone cannot delay the address they need in
    // order to come back and fix it (§ 4.1 — the Pro DDNS host is the recovery
    // path).
    //
    // ⚠ `isVaultUnlocked` is passed EXPLICITLY. The dep is optional and
    //   omitting it silently means "treat as unlocked" — the exact
    //   caller-obligation seam the note above records being burned by.
    const customDomainHostnameRegistry = createHostnameRegistryStore(options.storage.db);
    const customDomainHandleStore = createSqliteHandleStateStore({ db: options.storage.db });
    composeCustomDomainEnrollment({
      registry: options.backgroundServices,
      hostnameRegistry: customDomainHostnameRegistry,
      getInitialAcmeIssuer: () => options.certStack.getInitialAcmeDomainIssuerRef(),
      runPreflight: async (hostname) => {
        const state = await customDomainHandleStore.load();
        const handle = state?.current_handle ?? '';
        return runCustomDomainPreflight({
          hostname,
          handle,
          ...(state?.ddns_zone !== undefined
            ? (() => {
                const zone = zoneByLabel(state.ddns_zone);
                return zone !== undefined ? { zone } : {};
              })()
            : {}),
          resolver: createNodeCustomDomainDnsResolver(),
        });
      },
      readProDdnsBinding: async () => {
        const state = await customDomainHandleStore.load();
        if (!state || state.current_handle.length === 0) return null;
        // ⚠ `active` ONLY — `grace` is excluded for the same reason the
        //   fleet-zone service excludes it: the cloud has already pulled a
        //   lapsed subscription's DNS records, so DNS-01 cannot validate and
        //   every attempt would burn CA quota to fail.
        return { subscription_active: state.subscription_state === 'active' };
      },
      serverIdentityId: () => options.storage.serverInstanceId,
      isVaultUnlocked: options.app.isVaultUnlocked,
    });
  }

  return {
    schedulersBundle,
    vendorRefs,
  };
};
