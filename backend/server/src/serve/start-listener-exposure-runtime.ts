import {
  composeListeners,
  type ComposeListenersOptions,
  type ComposeListenersResult,
} from './compose-listeners.js';
import {
  composeServeExposure,
  type ComposeServeExposureOptions,
} from './compose-exposure.js';
import {
  startPostListenerRuntime,
  type PostListenerRuntimeResult,
  type StartPostListenerRuntimeOptions,
} from './start-post-listener-runtime.js';

export interface ListenerHttpServerRef {
  close(): Promise<void>;
}

export interface StartListenerExposureRuntimeOptions {
  readonly bootTrace?: import('../cli/boot-trace.js').BootTrace;
  readonly listener: ComposeListenersOptions;
  readonly exposure: Omit<
    ComposeServeExposureOptions,
    'listenerCoordinator' | 'lanBindAddress' | 'wsHandleClientCount' | 'hasPublicAddress'
  >;
  readonly runtime: Omit<
    StartPostListenerRuntimeOptions,
    'server' | 'lanAdvertisedAddress' | 'webclientServed' | 'actualPort' | 'eventTriggerDispatcher' | 'watchManager' | 'messengerIngressSupervisor' | 'runUpdateBootReconcile'
  >;
  readonly publishWsHandleForLockout: (
    wsHandle: ComposeListenersResult['serverHandlerSet']['wsHandle'],
  ) => void;
  readonly publishHttpServer: (server: ListenerHttpServerRef) => void;
}

export interface ListenerExposureRuntimeResult extends ComposeListenersResult {
  readonly actualPort: number;
  readonly runtime: PostListenerRuntimeResult;
}

export const startListenerExposureRuntime = async (
  options: StartListenerExposureRuntimeOptions,
): Promise<ListenerExposureRuntimeResult> => {
  options.bootTrace?.mark('listeners-compose-start');
  const listeners = await composeListeners({
    ...options.listener,
  });
  options.bootTrace?.mark('listeners-compose-complete');

  options.publishWsHandleForLockout(listeners.serverHandlerSet.wsHandle);

  options.bootTrace?.mark('exposure-start');
  await composeServeExposure({
    ...options.exposure,
    listenerCoordinator: listeners.listenerCoordinator,
    lanBindAddress: listeners.lanBindAddress,
    wsHandleClientCount: () =>
      listeners.serverHandlerSet.wsHandle.clientCount(),
    // The same service every link the server hands out reads, so the grid
    // allows Public exactly when there is an address to be public at.
    hasPublicAddress: () =>
      options.listener.storage.publicAddress.ownBaseUrls().length > 0,
  });
  options.bootTrace?.mark('exposure-complete');

  const actualPort = listeners.server.port;
  options.publishHttpServer({ close: () => listeners.server.close() });

  const runtime = await startPostListenerRuntime({
    ...options.runtime,
    server: listeners.server,
    // The cert stack publishes `wss://<addr>:<port>/ws` pairing hints, so it
    // needs the REACHABLE address — `0.0.0.0` is not somewhere a peer dials.
    lanAdvertisedAddress: listeners.lanAdvertisedAddress,
    webclientServed: listeners.webclientServed,
    actualPort,
    // Reactive-substrate slice 1 — hand the live dispatcher composed
    // by `composeListeners` to the post-listener runtime so its stop
    // closure lands in the background-services registry.
    eventTriggerDispatcher: listeners.eventTriggerDispatcher,
    // Poll-manager / G6 — same posture for the watch manager.
    watchManager: listeners.watchManager,
    messengerIngressSupervisor: listeners.messengerIngressSupervisor,
    // D-178 slice 4b — on-boot update reconcile thunk; the post-housekeeping
    // tail runs it after markBooted.
    runUpdateBootReconcile: listeners.runUpdateBootReconcile,
    // D-225 auto-mint — the first-mint sweep's deps, bound to the
    // composition-capable seam in `composeListeners` and carried here rather
    // than rebuilt (see the const's own comment on why rebuilding is the bug).
    ...(listeners.mcpPackFirstMintDeps
      ? { mcpPackFirstMintDeps: listeners.mcpPackFirstMintDeps }
      : {}),
  });

  return {
    ...listeners,
    actualPort,
    runtime,
  };
};
