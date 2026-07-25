import type { ContactMergeScanMode } from '@recued/contracts';

import type { BootedServerIdentity } from '../identity/boot.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';
import type { EventTriggerDispatcher } from '../triggers/dispatcher.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';
import type { UpstreamMergeRegistry } from '../data/vendor-boot-registry.js';
import type { ExposureStateMachine } from '../exposure/index.js';
import type { WsServerHandle } from '../ws-server.js';
import {
  composeServeLifecycle,
  type ComposeServeLifecycleOptions,
  type ServeHttpServerRef,
} from './compose-lifecycle.js';
import {
  startBootRecoveryAndAdapters,
  type StartBootRecoveryAndAdaptersOptions,
} from './start-boot-recovery-and-adapters.js';
import {
  startPreListenerRuntime,
  type StartPreListenerRuntimeOptions,
} from './start-pre-listener-runtime.js';
import { composeArchiveRpcDeps } from '../archive/archive-runtime.js';
import { createUploadSessionStore } from '../storage/upload-session-store.js';

/** The upload-session lookup the boot reclaim wants, when this composition can
 *  actually provide one. Returns an empty object rather than throwing: the
 *  reclaim degrades to skipping the upload tree, and a boot must not fail over
 *  a housekeeping nicety. */
const uploadSessionsForReclaim = (
  db: unknown,
): { uploadSessions?: Pick<import('../storage/upload-session-store.js').UploadSessionStore, 'get'> } => {
  if (!db) return {};
  try {
    return { uploadSessions: createUploadSessionStore(db as never) };
  } catch {
    return {};
  }
};
import { handleGetStatus } from '../bootstrap-handler.js';
import type { PassportExportRpcDeps } from '../passport/export-handler.js';

type LifecycleRecoveryPreListenerOptions = Omit<
  StartPreListenerRuntimeOptions,
  | 'lifecycle'
  | 'signingIdentity'
  | 'getExposureMachine'
  | 'publishExposureMachine'
  | 'publishPassportExportDeps'
  | 'getWsHandleForLockout'
  | 'publishWsHandleForLockout'
  | 'publishHttpServer'
  | 'publishBridgeDispatcher'
  | 'getUpstreamMergeRegistry'
  | 'publishUpstreamMergeRegistry'
  | 'setActiveContactMergeScanMode'
  | 'getApiConnectionLookup'
  | 'getRefreshAuth'
  | 'getRegisterSalesforceCallEntity'
  | 'getAutoRunHandle'
  | 'publishSchedulersBundle'
  | 'publishVendorRefs'
  | 'getActiveContactMergeScanMode'
  | 'getContactMergeCycleObserver'
  | 'getSigningIdentity'
  | 'cascade'
>;

export interface StartLifecycleRecoveryPreListenerRuntimeOptions {
  readonly lifecycle: Omit<
    ComposeServeLifecycleOptions,
    'getHttpServer' | 'getSchedulersBundle'
  >;
  readonly recovery: Omit<StartBootRecoveryAndAdaptersOptions, 'lifecycle'>;
  readonly preListener: LifecycleRecoveryPreListenerOptions;
  readonly getSchedulersBundle: () => SchedulersBundle | undefined;
  readonly publishSchedulersBundle: (bundle: SchedulersBundle) => void;
  /** Reactive-substrate slice 1 (codex HIGH fold) — publishes the live
   *  event-trigger dispatcher composed by `composeListeners` so the
   *  maintenance context's exit hook can `rebuild()` it. Optional —
   *  harnesses that never enter maintenance omit it. */
  readonly publishEventTriggerDispatcher?: (
    dispatcher: EventTriggerDispatcher | undefined,
  ) => void;
  /** Poll-manager / G6 — publishes the live watch manager so the
   *  maintenance exit hook can `recompute()` (re-arm the poll loops
   *  the maintenance-enter stopAll drained). Same late-binding
   *  contract as the dispatcher publish above. */
  readonly publishWatchManager?: (
    manager: PollManagerHandle | undefined,
  ) => void;
  readonly getSigningIdentity: () => BootedServerIdentity | undefined;
  readonly getUpstreamMergeRegistry: () => UpstreamMergeRegistry | undefined;
  readonly publishUpstreamMergeRegistry: (registry: UpstreamMergeRegistry) => void;
  readonly setActiveContactMergeScanMode: (mode: ContactMergeScanMode) => void;
  readonly getApiConnectionLookup: StartPreListenerRuntimeOptions['getApiConnectionLookup'];
  readonly getRefreshAuth: StartPreListenerRuntimeOptions['getRefreshAuth'];
  readonly getRegisterSalesforceCallEntity:
    StartPreListenerRuntimeOptions['getRegisterSalesforceCallEntity'];
  readonly publishVendorRefs: StartPreListenerRuntimeOptions['publishVendorRefs'];
  readonly getActiveContactMergeScanMode:
    StartPreListenerRuntimeOptions['getActiveContactMergeScanMode'];
  readonly getContactMergeCycleObserver:
    StartPreListenerRuntimeOptions['getContactMergeCycleObserver'];
  /** D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — forwarded
   *  down so `composeListeners` publishes the live bridge dispatcher
   *  BEFORE schedulers start. The boot-site caller wires this to
   *  `lateBound.publishBridgeDispatcher`. Optional — absent paths fall
   *  through to the boot-site's post-return publish (with the
   *  documented boot-race exposure). */
  readonly publishBridgeDispatcher?:
    StartPreListenerRuntimeOptions['publishBridgeDispatcher'];
}

export interface LifecycleRecoveryPreListenerRuntimeResult {
  readonly lifecycle: Awaited<ReturnType<typeof composeServeLifecycle>>;
  readonly listenerRuntime: Awaited<ReturnType<typeof startPreListenerRuntime>>;
}

export const startLifecycleRecoveryPreListenerRuntime = async (
  options: StartLifecycleRecoveryPreListenerRuntimeOptions,
): Promise<LifecycleRecoveryPreListenerRuntimeResult> => {
  let httpServerRef: ServeHttpServerRef | undefined;
  let exposureMachineRef: ExposureStateMachine | undefined;
  let wsHandleForLockoutRef: WsServerHandle | undefined;
  // M1 slice 3 — the passport-export substrate is composed a layer deeper
  // (inside startPreListenerRuntime, after the cert stack). The archive
  // runtime, built here BEFORE that, reads it through this late-bound ref.
  let passportExportDepsRef: PassportExportRpcDeps | undefined;

  const lifecycle = await composeServeLifecycle({
    ...options.lifecycle,
    getHttpServer: () => httpServerRef,
    getSchedulersBundle: options.getSchedulersBundle,
  });

  await startBootRecoveryAndAdapters({
    ...options.recovery,
    lifecycle,
    // M5 S1 — the post-restart provenance hook needs the data dir (marker
    // location) + the just-booted signing identity (the new publisher_id).
    dbPath: options.lifecycle.base.dbPath,
    getSigningIdentity: options.getSigningIdentity,
    // Lets the boot reclaim distinguish a stranded upload scratch file from
    // one a resumable session still owns. Best-effort: the store creates its
    // own table, which a db-less or stubbed composition cannot serve — and the
    // reclaim already treats an absent lookup as "skip the upload tree", which
    // is the fail-safe answer rather than deleting a resumable session's file.
    ...(uploadSessionsForReclaim(options.lifecycle.db)),
  });

  // Scope-B (D-108/D-109) — assemble the live `server.archive.*` runtime
  // here: this is the one layer where the constructed `lifecycle` (restart
  // drain → supervisor handoff → exit) sits alongside the db, the config
  // path, the server version, and the injected exit the lifecycle uses.
  // Returns undefined on a db-less / no-lifecycle boot → rpc stays unwired.
  const archiveDeps = composeArchiveRpcDeps({
    db: options.lifecycle.db,
    dbPath: options.lifecycle.base.dbPath,
    configPath: options.lifecycle.base.loadedConfig.source,
    serverVersion: options.lifecycle.serverVersion,
    auditLog: options.lifecycle.auditLog,
    // Blob-encryption fix Phase 2 — late-bound accessor for the live KeyManager
    // so export can decrypt the encrypted cache_blobs root. Late-bound because
    // the KeyManager is published (into `keysRef`) only after this runtime is
    // wired; resolved at export time. Absent on a keyless / db-less boot.
    ...(options.lifecycle.getKeys ? { getKeys: options.lifecycle.getKeys } : {}),
    lifecycle,
    exit: options.lifecycle.exit,
    // Resolved at export time (after the deeper layer publishes it below).
    getPassportExport: () => passportExportDepsRef,
  });

  const listenerRuntime = await startPreListenerRuntime({
    ...options.preListener,
    lifecycle,
    ...(archiveDeps ? { archiveDeps } : {}),
    signingIdentity: options.getSigningIdentity(),
    getExposureMachine: () => exposureMachineRef,
    publishExposureMachine: (machine) => {
      exposureMachineRef = machine;
    },
    getWsHandleForLockout: () => wsHandleForLockoutRef,
    publishWsHandleForLockout: (wsHandle) => {
      wsHandleForLockoutRef = wsHandle;
    },
    publishPassportExportDeps: (passportExportDeps) => {
      passportExportDepsRef = passportExportDeps;
    },
    publishHttpServer: (serverRef) => {
      httpServerRef = serverRef;
    },
    // D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — forwarded so
    // composeListeners can publish the live dispatcher BEFORE schedulers
    // start. Absent → in-chain publish is a no-op; boot-site's
    // post-return publish (legacy fallback) still catches it.
    ...(options.publishBridgeDispatcher
      ? { publishBridgeDispatcher: options.publishBridgeDispatcher }
      : {}),
    getUpstreamMergeRegistry: options.getUpstreamMergeRegistry,
    publishUpstreamMergeRegistry: options.publishUpstreamMergeRegistry,
    setActiveContactMergeScanMode: options.setActiveContactMergeScanMode,
    getApiConnectionLookup: options.getApiConnectionLookup,
    getRefreshAuth: options.getRefreshAuth,
    getRegisterSalesforceCallEntity: options.getRegisterSalesforceCallEntity,
    getAutoRunHandle: () => options.getSchedulersBundle()?.autoRun?.getHandle(),
    publishSchedulersBundle: options.publishSchedulersBundle,
    publishVendorRefs: options.publishVendorRefs,
    getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
    getContactMergeCycleObserver: options.getContactMergeCycleObserver,
    getSigningIdentity: options.getSigningIdentity,
    // Tier 3 — this is the one layer where the constructed `lifecycle`
    // instance is in scope; hand its snapshot down as a thunk for the
    // heartbeat emitter's READY gate (undefined on a no-lifecycle boot).
    getLifecycleSnapshot: () => lifecycle?.getSnapshot(),
    // D-109 A2 — running-server health for the pill (kill-switch → paused;
    // pressure → attention). `bootstrapDeps` (state + gates + pressureState)
    // is in scope here; `handleGetStatus` is the same assembly the
    // `server.getStatus` rpc uses. Undefined on a db-less boot.
    getServerHealth: () => {
      const bd = options.lifecycle.bootstrapDeps;
      if (!bd) return undefined;
      const status = handleGetStatus(bd);
      return {
        crash_halt_active: status.crash_halt_active,
        // D-188 — the master pause drives the pill's neutral paused glyph.
        paused: status.paused,
        pressure_details: status.pressure_details,
      };
    },
    cascade: options.lifecycle.cascade,
  });
  options.publishSchedulersBundle(listenerRuntime.runtime.schedulersBundle);
  options.publishEventTriggerDispatcher?.(listenerRuntime.eventTriggerDispatcher);
  options.publishWatchManager?.(listenerRuntime.watchManager);

  return {
    lifecycle,
    listenerRuntime,
  };
};
