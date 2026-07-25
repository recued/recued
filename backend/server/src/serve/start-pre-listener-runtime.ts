import type { RuntimeConfigStore } from '@recued/config';
import type { ContactMergeScanMode } from '@recued/contracts';

import {
  composeClientSecurityContext,
  type ComposeClientSecurityContextOptions,
} from './compose-client-security-context.js';
import {
  composeIngressRpcContext,
  type ComposeIngressRpcContextOptions,
} from './compose-ingress-rpc-context.js';
import {
  composeRpcContext,
  type ComposeRpcContextOptions,
} from './compose-rpc-context.js';
import {
  startListenerExposureRuntime,
  type ListenerExposureRuntimeResult,
  type StartListenerExposureRuntimeOptions,
} from './start-listener-exposure-runtime.js';
import type { PassportExportRpcDeps } from '../passport/export-handler.js';

type PreListenerStorageContext =
  ComposeIngressRpcContextOptions['storage']
  & ComposeRpcContextOptions['storage']
  & StartListenerExposureRuntimeOptions['listener']['storage']
  & StartListenerExposureRuntimeOptions['runtime']['storage'];

type PreListenerAppContext =
  ComposeIngressRpcContextOptions['app']
  & ComposeRpcContextOptions['app']
  & StartListenerExposureRuntimeOptions['listener']['app']
  & StartListenerExposureRuntimeOptions['runtime']['app'];

type PreListenerCollectionContext =
  StartListenerExposureRuntimeOptions['listener']['collection']
  & StartListenerExposureRuntimeOptions['runtime']['collection']
  // D-172 P3 § A.5 — the drop_link drain (composed in the ingress context)
  // needs the `received` collection + registry. `options.collection` is the
  // full CollectionContext at the call site, so widen the intersection to
  // require these too (they're always present on the real value).
  & NonNullable<ComposeIngressRpcContextOptions['collection']>;

type PreListenerExecutionContext =
  ComposeIngressRpcContextOptions['execution']
  & ComposeRpcContextOptions['execution']
  & StartListenerExposureRuntimeOptions['listener']['execution'];

export interface StartPreListenerRuntimeOptions {
  readonly args: string[];
  readonly dbPath: string;
  readonly port: number;
  readonly webhookPort: number;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly backgroundServices: ComposeIngressRpcContextOptions['backgroundServices'];
  readonly storage: PreListenerStorageContext;
  readonly app: PreListenerAppContext;
  readonly collection: PreListenerCollectionContext;
  readonly execution: PreListenerExecutionContext;
  readonly bootstrapDeps: StartListenerExposureRuntimeOptions['listener']['bootstrapDeps'];
  readonly scheduleDeps: StartListenerExposureRuntimeOptions['listener']['scheduleDeps'];
  readonly dishDeps: StartListenerExposureRuntimeOptions['listener']['dishDeps'];
  readonly migrateDeps: StartListenerExposureRuntimeOptions['listener']['migrateDeps'];
  readonly pressureDeps: StartListenerExposureRuntimeOptions['listener']['pressureDeps'];
  readonly lifecycle: StartListenerExposureRuntimeOptions['listener']['lifecycle'];
  /** Scope-B (D-108/D-109) — live `server.archive.*` runtime deps,
   *  forwarded into `composeListeners`. Absent → the rpc stays unwired. */
  readonly archiveDeps?: StartListenerExposureRuntimeOptions['listener']['archiveDeps'];
  /** M1 slice 3 — publish the passport-export substrate back to the
   *  late-bound archive runtime once `composeClientSecurityContext` (which
   *  owns the cert stack the passport providers need) has built it. The
   *  archive runtime reads it at export time to embed `passport.json`. */
  readonly publishPassportExportDeps?: (deps: PassportExportRpcDeps | undefined) => void;
  readonly signingIdentity: ComposeClientSecurityContextOptions['signingIdentity'];
  readonly schedulerRegistry: ComposeRpcContextOptions['schedulerRegistry'];
  readonly getExposureMachine: ComposeIngressRpcContextOptions['getExposureMachine'];
  readonly publishExposureMachine:
    StartListenerExposureRuntimeOptions['exposure']['publishExposureMachine'];
  readonly getWsHandleForLockout:
    ComposeIngressRpcContextOptions['getWsHandleForLockout'];
  readonly publishWsHandleForLockout:
    StartListenerExposureRuntimeOptions['publishWsHandleForLockout'];
  readonly publishHttpServer:
    StartListenerExposureRuntimeOptions['publishHttpServer'];
  /** D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — forwarded
   *  through `ComposeListenersOptions.publishBridgeDispatcher` so the
   *  DOM-runner's late-bound dispatcher ref publishes BEFORE schedulers
   *  fire. Optional — when omitted the in-chain publish becomes a no-op
   *  and the boot site's post-return publish (legacy path) still
   *  catches it (with the documented boot-race exposure). */
  readonly publishBridgeDispatcher?:
    NonNullable<StartListenerExposureRuntimeOptions['listener']['publishBridgeDispatcher']>;
  readonly getUpstreamMergeRegistry:
    () => ComposeRpcContextOptions['upstreamMergeRegistry'];
  readonly publishUpstreamMergeRegistry:
    (registry: NonNullable<ComposeRpcContextOptions['upstreamMergeRegistry']>) => void;
  readonly setActiveContactMergeScanMode: (mode: ContactMergeScanMode) => void;
  readonly getApiConnectionLookup: ComposeRpcContextOptions['getApiConnectionLookup'];
  readonly getRefreshAuth: ComposeRpcContextOptions['getRefreshAuth'];
  readonly getRegisterSalesforceCallEntity:
    ComposeRpcContextOptions['getRegisterSalesforceCallEntity'];
  readonly executorConfig: StartListenerExposureRuntimeOptions['runtime']['executorConfig'];
  readonly scheduleStore: StartListenerExposureRuntimeOptions['runtime']['scheduleStore'];
  readonly executeDeps: StartListenerExposureRuntimeOptions['runtime']['executeDeps'];
  readonly circuitStore: ComposeRpcContextOptions['circuitStore'];
  readonly autoRunSettingsStore: ComposeRpcContextOptions['autoRunSettingsStore'];
  readonly getAutoRunHandle: ComposeRpcContextOptions['getAutoRunHandle'];
  readonly publishSchedulersBundle:
    StartListenerExposureRuntimeOptions['runtime']['publishSchedulersBundle'];
  readonly publishVendorRefs:
    StartListenerExposureRuntimeOptions['runtime']['publishVendorRefs'];
  readonly getActiveContactMergeScanMode:
    StartListenerExposureRuntimeOptions['runtime']['getActiveContactMergeScanMode'];
  readonly getContactMergeCycleObserver:
    StartListenerExposureRuntimeOptions['runtime']['getContactMergeCycleObserver'];
  readonly enrichmentProducers:
    StartListenerExposureRuntimeOptions['runtime']['enrichmentProducers'];
  readonly getSigningIdentity:
    StartListenerExposureRuntimeOptions['runtime']['getSigningIdentity'];
  /** Tier 3 — live lifecycle snapshot thunk for the heartbeat emitter's
   *  READY gate. Threaded through to `startPostListenerRuntime`. */
  readonly getLifecycleSnapshot?:
    StartListenerExposureRuntimeOptions['runtime']['getLifecycleSnapshot'];
  /** D-109 A2 — running-server health thunk for the heartbeat snapshot's
   *  pill paused/attention states. Threaded through the same path. */
  readonly getServerHealth?:
    StartListenerExposureRuntimeOptions['runtime']['getServerHealth'];
  readonly cascade: StartListenerExposureRuntimeOptions['runtime']['cascade'];
  readonly env?: ComposeIngressRpcContextOptions['env'];
}

export const startPreListenerRuntime = async (
  options: StartPreListenerRuntimeOptions,
): Promise<ListenerExposureRuntimeResult> => {
  const ingressRpcContext = await composeIngressRpcContext({
    dbPath: options.dbPath,
    storage: options.storage,
    app: options.app,
    // D-172 P3 § A.5 — thread the file collection + registry so the
    // drop_link drain can ingest + attach uploaded files.
    collection: options.collection,
    execution: options.execution,
    backgroundServices: options.backgroundServices,
    getExposureMachine: options.getExposureMachine,
    getWsHandleForLockout: options.getWsHandleForLockout,
    // R26.2 Delta 2 — thread the runtime-config store so the exposure rpc
    // deps expose the apex (`network.apex_mode`) get/set.
    runtimeConfig: options.runtimeConfig,
    env: options.env,
  });

  const cloudBaseUrl: string = options.runtimeConfig.get('cloud.base_url') as string;
  const clientSecurity = await composeClientSecurityContext({
    db: options.storage.db,
    auditLog: options.storage.auditLog,
    signingIdentity: options.signingIdentity,
    eventBus: options.storage.eventBus,
    cloudBaseUrl,
    pairedInstances: options.storage.pairedInstances,
    getWsHandleForLockout: options.getWsHandleForLockout,
    getExposureMachine: options.getExposureMachine,
    env: options.env,
  });
  // Publish the passport-export substrate to the (already-constructed)
  // archive runtime's late-bound getter — `clientSecurity` is the first
  // point the cert-stack-dependent passport providers exist. Undefined on a
  // db-less / no-audit boot ⇒ archive exports skip the embedded passport.
  options.publishPassportExportDeps?.(clientSecurity.passportUserRpcDeps?.export);

  let upstreamMergeRegistry = options.getUpstreamMergeRegistry();
  const rpcContext = composeRpcContext({
    storage: options.storage,
    app: options.app,
    execution: options.execution,
    schedulerRegistry: options.schedulerRegistry,
    upstreamMergeRegistry,
    setActiveContactMergeScanMode: options.setActiveContactMergeScanMode,
    getApiConnectionLookup: options.getApiConnectionLookup,
    getRefreshAuth: options.getRefreshAuth,
    getRegisterSalesforceCallEntity: options.getRegisterSalesforceCallEntity,
    circuitStore: options.circuitStore,
    autoRunSettingsStore: options.autoRunSettingsStore,
    getAutoRunHandle: options.getAutoRunHandle,
  });
  if (rpcContext.upstreamMergeRegistry) {
    upstreamMergeRegistry = rpcContext.upstreamMergeRegistry;
    options.publishUpstreamMergeRegistry(rpcContext.upstreamMergeRegistry);
  }

  return startListenerExposureRuntime({
    listener: {
      port: options.port,
      webhookPort: options.webhookPort,
      storage: options.storage,
      app: options.app,
      collection: options.collection,
      execution: options.execution,
      rpc: rpcContext,
      runtimeConfig: options.runtimeConfig,
      bootstrapDeps: options.bootstrapDeps,
      scheduleDeps: options.scheduleDeps,
      dishDeps: options.dishDeps,
      migrateDeps: options.migrateDeps,
      pressureDeps: options.pressureDeps,
      lifecycle: options.lifecycle,
      ...(options.archiveDeps ? { archiveDeps: options.archiveDeps } : {}),
      clientTokens: clientSecurity.clientTokens,
      exposureDeps: ingressRpcContext.exposureRpcDeps,
      tlsDomainDeps: ingressRpcContext.tlsDomainRpcDeps,
      tokenRotationEmitter: clientSecurity.tokenRotationEmitter,
      rotationEngine: clientSecurity.rotationEngine,
      passportFetchDeps: clientSecurity.passportFetchDeps,
      passportUserRpcDeps: clientSecurity.passportUserRpcDeps,
      keyRotateDeps: clientSecurity.keyRotateDeps,
      proAuthMachine: clientSecurity.proAuthStateMachineRef,
      initialAcmeDomainIssuer: () =>
        clientSecurity.certStack.getInitialAcmeDomainIssuerRef(),
      receptionRpcDeps: ingressRpcContext.receptionRpcDeps,
      receptionPortDeps: ingressRpcContext.receptionPortDeps,
      mcpHttpDeps: ingressRpcContext.mcpHttpDeps,
      llmGatewayDeps: ingressRpcContext.llmGatewayDeps,
      // D-165 enroll-host #1 — booted signing identity for the vendor
      // OAuth substrate (state-token signing + verification). Resolved
      // upstream (boot recovery) before this runtime composes, the same
      // ref `composeClientSecurityContext` already consumes; absent
      // (db-less) → the substrate stays unwired.
      ...(options.signingIdentity
        ? { signingIdentity: options.signingIdentity }
        : {}),
      // D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — forwarded
      // to composeListeners so the bridge dispatcher publishes BEFORE
      // schedulers spin up. Absent → no-op publish; the boot site's
      // post-return publish call still wires the ref but with the
      // documented boot-race window.
      ...(options.publishBridgeDispatcher
        ? { publishBridgeDispatcher: options.publishBridgeDispatcher }
        : {}),
    },
    exposure: {
      args: options.args,
      db: options.storage.db,
      auditLog: options.storage.auditLog,
      webhookPort: options.webhookPort,
      publishExposureMachine: options.publishExposureMachine,
      // M-XSURF-1 — thread the shared D-121 bus so an exposure transition
      // fans `exposure_changed` to paired clients (the webclient's
      // Settings → Server → Exposure grid refreshes off it).
      eventBus: options.storage.eventBus,
    },
    runtime: {
      dbPath: options.dbPath,
      runtimeConfig: options.runtimeConfig,
      backgroundServices: options.backgroundServices,
      storage: options.storage,
      app: options.app,
      collection: options.collection,
      executorConfig: options.executorConfig,
      scheduleStore: options.scheduleStore,
      executeDeps: options.executeDeps,
      circuitStore: options.circuitStore,
      autoRunSettingsStore: options.autoRunSettingsStore,
      certStack: clientSecurity.certStack,
      tlsDomainStore: ingressRpcContext.tlsDomainStore,
      upstreamMergeRegistry,
      publishSchedulersBundle: options.publishSchedulersBundle,
      publishVendorRefs: options.publishVendorRefs,
      rotationEngine: clientSecurity.rotationEngine,
      getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
      getContactMergeCycleObserver: options.getContactMergeCycleObserver,
      enrichmentProducers: options.enrichmentProducers,
      cloudBaseUrl,
      getSigningIdentity: options.getSigningIdentity,
      getLifecycleSnapshot: options.getLifecycleSnapshot,
      getServerHealth: options.getServerHealth,
      lifecycle: options.lifecycle,
      cascade: options.cascade,
      // D-157 N.8 — the stale-checkpoint sweep's ask-state reads, off
      // the same block instance `composeExecuteDeps` registered the
      // preflight handlers on.
      notificationBlock: options.execution.notificationBlock,
    },
    publishWsHandleForLockout: options.publishWsHandleForLockout,
    publishHttpServer: options.publishHttpServer,
  });
};
