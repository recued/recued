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
  readonly listener: ComposeListenersOptions;
  readonly exposure: Omit<
    ComposeServeExposureOptions,
    'listenerCoordinator' | 'lanBindAddress' | 'wsHandleClientCount'
  >;
  readonly runtime: Omit<
    StartPostListenerRuntimeOptions,
    'server' | 'lanAdvertisedAddress' | 'webclientServed' | 'actualPort' | 'eventTriggerDispatcher' | 'watchManager' | 'runUpdateBootReconcile'
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
  const listeners = await composeListeners({
    ...options.listener,
  });

  options.publishWsHandleForLockout(listeners.serverHandlerSet.wsHandle);

  await composeServeExposure({
    ...options.exposure,
    listenerCoordinator: listeners.listenerCoordinator,
    lanBindAddress: listeners.lanBindAddress,
    wsHandleClientCount: () =>
      listeners.serverHandlerSet.wsHandle.clientCount(),
  });

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
    // D-178 slice 4b — on-boot update reconcile thunk; the post-housekeeping
    // tail runs it after markBooted.
    runUpdateBootReconcile: listeners.runUpdateBootReconcile,
  });

  return {
    ...listeners,
    actualPort,
    runtime,
  };
};
