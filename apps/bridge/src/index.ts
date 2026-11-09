/** D-148 § A.3 — Browser Bridge thin executor.
 *
 *  Public package surface for `apps/bridge/`. Re-exports the modular
 *  pieces so test suites + the SW boot file can import from a single
 *  entry point.
 *
 *  Hard rule (D-148 invariant I-8): the bridge is structurally
 *  unaware of recipe shape. No engine. No storage beyond the six
 *  documented fields. Imports from `packages/engine`,
 *  `packages/recipes`, `packages/storage`, or `packages/ingredients`
 *  are forbidden — the role-boundary lint test in
 *  `packages/contracts/src/__tests__/d-148-phase-1-role-boundary.test.ts`
 *  asserts at every commit.
 *
 *  Storage substrate per spec § A.3.4 + D-169 P0 Slice 2B (the bridge
 *  now persists the same AES-GCM-wrapped `webclient_token` record the
 *  webclient does + the § A.4.1 pair_metadata / cert_pin_state
 *  widenings):
 *    - server_url, webclient_token, server_public_key, pair_metadata,
 *      cert_pin_state, chrome_permissions_state, idempotency_cache,
 *      pending_outbox, blocked_sites, approval_notices_shown
 *  Anything else is a CI-gate failure (Appendix I.15).
 */

export const BRIDGE_RESERVATION_MARKER = 'recued.bridge.p3.thin-executor' as const;
export const BRIDGE_VERSION = '0.0.8' as const;

export {
  type BridgeLocalState,
  type BridgeLocalKey,
  type BridgeLocalStore,
  type ChromeStorageLocal,
  createInMemoryBridgeLocalStore,
  createChromeBridgeLocalStore,
} from './storage/local-store.js';

export {
  type WebclientTokenAad,
  type WebclientTokenWrapDeps,
  type WebclientTokenStore,
  WebclientTokenCorruptError,
  WEBCLIENT_TOKEN_AES_PARAMS,
  createWebclientTokenStore,
} from './storage/token-store.js';

export {
  type IdempotencyEntry,
  type IdempotencyCache,
  type BridgeIdempotencyScope,
  type BridgeInFlightEntry,
  type BridgeInFlightInspection,
  type BridgeConfirmedOutcome,
  type BridgeConfirmedInspection,
  type BridgeReceiptInspection,
  type BridgeIdempotencyInspection,
  type IdempotencyClaim,
  BRIDGE_IN_FLIGHT_INSPECTION_LIMIT,
  BRIDGE_CONFIRMED_INSPECTION_LIMIT,
  createInMemoryIdempotencyCache,
  stampIdempotencyResult,
} from './idempotency/cache.js';

export {
  createIndexedDbIdempotencyCache,
  BRIDGE_RECEIPT_DATABASE_NAME,
  BRIDGE_RECEIPT_STORE_NAME,
  BRIDGE_IN_FLIGHT_STORE_NAME,
} from './idempotency/indexed-db-cache.js';

export {
  type BridgeGrantStore,
  type GrantCheckOutcome,
  createInMemoryBridgeGrantStore,
  checkIngredientGrant,
  buildGrant,
} from './permissions/grants.js';

export {
  type EnqueueOutcome,
  type FifoQueueState,
  type BridgeFifoQueue,
  createFifoQueue,
} from './queue/fifo-queue.js';

export {
  type ActionExecutorRequest,
  type ActionExecutorOutcome,
  type BridgeActionExecutor,
  type DispatcherDeps,
  type DispatchOutcome,
  resolveCommandAction,
  clampCommandTimeout,
  dispatchBridgeCommand,
} from './queue/dispatcher.js';

export {
  type WsTransport,
  type WsTransportFactory,
  type WsClientHandlers,
  type WsClientOptions,
  type WsClient,
  createWsClient,
} from './transport/ws-client.js';

export {
  BRIDGE_RPC_DEFAULT_TIMEOUT_MS,
  type BridgeRpcConn,
  type BridgeRpcConnOptions,
  type BridgeRpcRequestEnvelope,
  type BridgeRpcResultEnvelope,
  createBridgeRpcConn,
} from './realtime/rpc-conn.js';

export {
  BRIDGE_DEFAULT_SUBSCRIPTIONS,
  type BridgeBroadcastSubscriber,
  type BroadcastListener,
  createBridgeBroadcastSubscriber,
} from './realtime/subscriber.js';

export {
  BRIDGE_BUS_BUFFER_CAP,
  type BridgeBusApproval,
  type BridgeBusBuffer,
  type BridgeBusBufferOptions,
  type BridgeBusBufferSnapshot,
  type BridgeBusNotification,
  type BridgeBusRecipeResult,
  createBridgeBusBuffer,
} from './realtime/bus-buffer.js';

export {
  KEEPALIVE_ALARM_NAME,
  KEEPALIVE_PERIOD_MINUTES,
  KEEPALIVE_PING_INTERVAL_MS,
  type KeepaliveTickContext,
  type KeepaliveTickReport,
  type ChromeAlarmsApi,
  type ChromeRuntimeInfoApi,
  runKeepaliveTick,
  installKeepaliveAlarm,
  removeKeepaliveAlarm,
} from './transport/keepalive.js';

export {
  type ChromeNotificationsApi,
  type ChromeNotificationOptions,
  type NotificationDispatchOptions,
  type ResolvedClickRoute,
  buildNotificationOptions,
  resolveClickRoute,
  createNotificationDispatcher,
} from './notifications/dispatcher.js';

export {
  type BridgeStateInspection,
  type InspectorDeps,
  buildBridgeStateInspection,
  documentedLocalKeys,
} from './pairing/inspector.js';

export {
  // Stable DOM ids — tests + future inspectors read these.
  BRIDGE_PAIR_CODE_INPUT_FORM_ID,
  BRIDGE_PAIR_CODE_INPUT_SERVER_URL_ID,
  BRIDGE_PAIR_CODE_INPUT_CODE_ID,
  BRIDGE_PAIR_CODE_INPUT_SUBMIT_ID,
  BRIDGE_PAIR_CODE_INPUT_STATUS_ID,
  BRIDGE_PAIR_CODE_INPUT_RECOVERY_PREFIX,
  BRIDGE_PAIR_CODE_INPUT_START_OVER_ID,
  BRIDGE_PAIR_CODE_INPUT_WAITING_ATTR,
  // Error taxonomy + copy
  BRIDGE_PAIR_CODE_INPUT_ERROR_COPY,
  type BridgePairCodeInputClientErrorCode,
  type BridgePairCodeInputServerErrorCode,
  type BridgePairCodeInputErrorCode,
  // Pure submit
  type BridgePairCodeInputCommitOptions,
  type BridgePairCodeInputCommitResult,
  submitBridgePairCodeInput,
  // DOM host
  type BridgePairCodeInputDeeplinkSeed,
  type BridgePairingClient,
  type MountBridgePairCodeInputHostOptions,
  type MountedBridgePairCodeInputHost,
  mountBridgePairCodeInputHost,
} from './pairing/pair-code-input-host.js';

export {
  BRIDGE_PAIR_MESSAGE_TYPE,
  createBridgeWorkerPairing,
  parseBridgePairStartInput,
  type BridgePairOutcome,
  type BridgePairStartInput,
  type BridgePairStatus,
  type BridgePairRequest,
  type BridgeWorkerPairing,
  type BridgeWorkerPairingDeps,
} from './pairing/worker-pairing.js';

export {
  createRuntimePairingClient,
  deriveBridgeDeviceLabel,
  type BridgePairingRuntime,
} from './pairing/pairing-client.js';

export {
  BRIDGE_PENDING_PAIR_SESSION_KEY,
  createSessionPendingPairStore,
  type BridgeAcceptedPair,
  type BridgePendingPairStore,
  type ChromeStorageSessionArea,
} from './pairing/pending-pair-store.js';

export {
  type BridgePairListCaller,
  type BridgePairRevokeCaller,
  type MountBridgeDevicesPageOptions,
  type BridgeDevicesPageMount,
  mountBridgeDevicesPage,
} from './pairing/devices-page-mount.js';

export {
  type BridgeManifest,
  type ManifestCheckOutcome,
  type ReferencedAssets,
  BRIDGE_MANIFEST_RELATIVE_PATH,
  checkBridgeManifest,
  collectReferencedAssets,
} from './manifest/manifest-checks.js';

export {
  type BridgeBrowserApi,
  buildActionExecutor,
} from './actions/executor.js';

// "Watch this element" picker (brick 2). The engine + preview + protocol
// are the pure, testable surface; the SW (brick 3) imports the protocol to
// receive the picker's result message. The overlay + content entry are
// live-DOM binders (not re-exported — they reference `document`).
export {
  type ElementView,
  type MatchCountProbe,
  type DeriveSelectorOptions,
  type DerivedSelector,
  deriveSelector,
  strongToken,
  looksAutoGenerated,
  elementViewFromDom,
} from './picker/selector-engine.js';

export {
  type PreviewProbes,
  type SelectorPreview,
  SAMPLE_PREVIEW_MAX_LEN,
  formatMatchSummary,
  truncateSample,
  previewSelector,
} from './picker/preview.js';

export {
  PICKER_RESULT_MESSAGE_TYPE,
  type PickerResult,
  type PickerPickedResult,
  type PickerCancelledResult,
  type PickerResultMessage,
  isPickerResultMessage,
  isUsablePickedSelector,
} from './picker/picker-protocol.js';

// brick 3 — the SW-side picker launch + url derivation (pure; the SW
// bootstrap consumes both, the entry builds the injector from chrome).
export { deriveWatchUrlPattern } from './picker/url-pattern.js';
export {
  PICKER_SCRIPT_FILE,
  type PickerInjectorActiveTab,
  type PickerInjectorChromeApi,
  type PickerInjectOutcome,
  type BridgePickerInjector,
  isInjectableUrl,
  createPickerInjector,
} from './picker/picker-injector.js';
