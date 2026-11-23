/** D-169 P0 Slice 1 — Browser Bridge service-worker bootstrap.
 *
 *  Pure composition function `bootBridgeServiceWorker(deps)` that
 *  wires the typed modules under `apps/bridge/src/` into a live SW.
 *  The side-effecty bundler entry is `service-worker-entry.ts`; this
 *  module just exports the composition so tests can drive it with
 *  in-memory fakes. The production entry builds the deps from
 *  `globalThis.chrome` + `globalThis.crypto.subtle` and invokes
 *  `bootBridgeServiceWorker` exactly once at module load.
 *
 *  Mirrors the webclient pattern of `webclient-bootstrap.ts` (pure)
 *  paired with `webclient-main.ts` (side-effecty bundler entry).
 *
 *  ── Lifecycle ──────────────────────────────────────────────────────
 *
 *  1. SW install / activate handlers wired to skipWaiting + claim so
 *     the first install promotes the new SW to the active version
 *     immediately (matches the 60-line placeholder's posture).
 *  2. Read pair state from chrome.storage via the existing typed
 *     `BridgeLocalStore`.
 *  3. Register the side panel's message responders on
 *     `chrome.runtime.onMessage` — the pairing session among them. Always
 *     registered, even pre-pair, so the panel can pair the bridge and
 *     render the empty state.
 *  4. If unpaired (`server_url` / `webclient_token` / `server_public_key`
 *     null): stop here. The side panel's pair form asks the pairing
 *     session to pair; when it finishes, the session starts the paired
 *     runtime (step 5) in this same worker. No restart: an extension
 *     reload would close the side panel the user is pairing from.
 *  5. If paired: construct the WS client + envelope router. Install
 *     the keepalive alarm. Start the WS connect loop.
 *
 *  The toolbar icon's wiring (it opens the side panel) is not here: it has
 *  to run before the entry's first `await` (`toolbar-icon.ts`).
 *
 *  ── Envelope routing ───────────────────────────────────────────────
 *
 *  D-169 P0 Slice 3 promoted the WS to a two-protocol multiplex.
 *  Inbound text frames parse once, then route by discriminator:
 *    - `{ type: 'rpc_result', request_id, … }` → `rpcConn.dispatchInbound`
 *      (settles the matching in-flight `Conn<ServerRpcRegistry>` call).
 *    - `{ kind: 'command' | 'cancel' | 'notification', … }` →
 *      `BridgeWireEnvelope` router:
 *        - `command` → bounded FIFO; the single drain loop invokes
 *          `dispatchBridgeCommand` and sends each result on the same
 *          WS. Overflow returns a transient `queue_full` result.
 *        - `cancel` → drop a queued command (returning `cancelled`) or
 *          flip the running command's cooperative-cancel signal.
 *        - `notification` → `notificationDispatcher.dispatch`.
 *
 *  Malformed JSON, an unknown `type`, or an unknown `kind` is dropped
 *  silently; SWs cannot surface server-side bugs by failing loud.
 *
 *  ── Lifecycle caveat ───────────────────────────────────────────────
 *
 *  `bootBridgeServiceWorker` returns `paired: true` as soon as the
 *  WsClient's connect loop is scheduled (the WsClient's `start()`
 *  returns once the loop is in flight, not when the WS handshake
 *  resolves — see `apps/bridge/src/transport/ws-client.ts`). Production
 *  tolerates this because the SW persists across the microtask gap;
 *  callers that need "actually connected" should observe via
 *  `WsClient.isConnected()` or via the handler `onConnected` hook
 *  rather than treating the boot-handle's `paired` flag as a
 *  connectivity signal.
 */

import {
  subscribeToKnownKinds,
  type BridgeCommand,
  type BridgeFromBridgeWireEnvelope,
  type BridgeResult,
  type BridgeWireEnvelope,
  type ServerToBridgeNotification,
} from '@recued/contracts';
import {
  createChromeBridgeLocalStore,
  type BridgeLocalStore,
  type ChromeStorageLocal,
} from '../storage/local-store.js';
import {
  WebclientTokenCorruptError,
  type WebclientTokenStore,
} from '../storage/token-store.js';
import {
  createInMemoryIdempotencyCache,
  type BridgeIdempotencyScope,
  type IdempotencyCache,
} from '../idempotency/cache.js';
import { observeIdempotencyChanges } from '../idempotency/observed-cache.js';
import { createCoalescedTask } from '../coalesced-task.js';
import {
  createInMemoryBridgeGrantStore,
  type BridgeGrantStore,
} from '../permissions/grants.js';
import {
  createFifoQueue,
  type BridgeFifoQueue,
} from '../queue/fifo-queue.js';
import {
  type BridgeActionExecutor,
  dispatchBridgeCommand,
} from '../queue/dispatcher.js';
import {
  createWsClient,
  type WsClient,
  type WsTransportFactory,
} from '../transport/ws-client.js';
import {
  installKeepaliveAlarm,
  runKeepaliveTick,
  type ChromeAlarmsApi,
  type ChromeRuntimeInfoApi,
} from '../transport/keepalive.js';
import {
  createNotificationDispatcher,
  type ChromeNotificationsApi,
} from '../notifications/dispatcher.js';
import { createApprovalNotices, type ApprovalNotices } from '../notifications/approval-notices.js';
import {
  buildBridgeStateInspection,
  type BridgeStateInspection,
} from '../pairing/inspector.js';
import {
  finalizeBridgePair,
  type BridgePairPassportInvoker,
} from '../pairing/pair-completion.js';
import { submitBridgePairCodeInput } from '../pairing/pair-code-input-host.js';
import { createBridgePairPassportInvoker } from '../pairing/pair-passport-invoker.js';
import {
  createSessionPendingPairStore,
  type ChromeStorageSessionArea,
} from '../pairing/pending-pair-store.js';
import {
  createInMemorySignInRefusalStore,
  createSessionSignInRefusalStore,
  pairFormServerUrl,
} from '../pairing/sign-in-refusal-store.js';
import {
  BRIDGE_PAIR_MESSAGE_TYPE,
  createBridgeWorkerPairing,
  parseBridgePairStartInput,
  type BridgePairOutcome,
  type BridgePairRequest,
} from '../pairing/worker-pairing.js';
import {
  createBridgeRpcConn,
  type BridgeRpcConn,
} from '../realtime/rpc-conn.js';
import {
  BRIDGE_DEFAULT_SUBSCRIPTIONS,
  createBridgeBroadcastSubscriber,
} from '../realtime/subscriber.js';
import {
  createBridgeBusBuffer,
  type BridgeBusBuffer,
  BRIDGE_BUS_BUFFER_CAP,
} from '../realtime/bus-buffer.js';
import {
  createBridgeCapabilityProfileMonitor,
  type BridgeCapabilityProfileMonitor,
  type BridgeCapabilityProfileSnapshot,
  type ChromePermissionsApi,
} from '../permissions/profile-monitor.js';
import { isPickerResultMessage } from '../picker/picker-protocol.js';
import { deriveWatchUrlPattern } from '../picker/url-pattern.js';
import type { BridgePickerInjector } from '../picker/picker-injector.js';
import { createPickerSessions } from '../picker/picker-sessions.js';

/** chrome.runtime.onMessage's listener signature. The handler returns
 *  `true` when it intends to call `sendResponse` asynchronously
 *  (matches the chrome API contract); returning `undefined` lets
 *  Chrome continue dispatching to other listeners. */
export interface ChromeRuntimeOnMessageApi {
  addListener(
    handler: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean | undefined,
  ): void;
}

/** SW lifecycle event subscriptions. The production wrapper binds
 *  these to `self.addEventListener('install', …)` etc.; tests inject
 *  fakes that capture handler refs. */
export interface BridgeSwLifecycle {
  onInstall(handler: () => void): void;
  onActivate(handler: (event: { waitUntil(p: Promise<unknown>): void }) => void): void;
  skipWaiting(): Promise<void> | void;
  claim(): Promise<unknown>;
}

/** All collaborators the SW composition needs. Production builds these
 *  from `globalThis.chrome` + `globalThis.crypto.subtle`; tests inject
 *  in-memory fakes. */
export interface BridgeServiceWorkerDeps {
  /** chrome.storage.local adapter. */
  chromeStorage: ChromeStorageLocal;
  /** chrome.runtime.onMessage subscription. */
  chromeRuntimeOnMessage: ChromeRuntimeOnMessageApi;
  /** D-169 P2 Slice 4 (live-mode propagation) — `chrome.runtime.sendMessage`
   *  wrapper. Optional — when present, the paired-path bus subscriber uses
   *  it to push a one-shot `bridge-mode-invalidated` signal to the (possibly
   *  open) side panel so it re-reads its own mode the instant a
   *  `notification.bridge_mode_changed` event lands (and on every reconnect),
   *  instead of waiting on the side panel's poll cadence. Absent ⇒ the push
   *  is a no-op (tests / dev bench); the side panel still resolves its mode
   *  on mount + reconnect-driven re-fetch. */
  chromeRuntimeSendMessage?: (message: unknown) => Promise<unknown> | void;
  /** chrome.alarms adapter for keepalive. Optional — tests that don't
   *  exercise the alarm path can omit. */
  chromeAlarms?: ChromeAlarmsApi;
  /** chrome.runtime.getPlatformInfo for keepalive wake. */
  chromeRuntimeInfo?: ChromeRuntimeInfoApi;
  /** chrome.notifications adapter for OS notification dispatch. */
  chromeNotifications?: ChromeNotificationsApi;
  openNotificationUrl?(url: string): Promise<unknown> | void;
  /** D-169 P0 — `chrome.permissions` adapter (`getAll` + `onAdded` +
   *  `onRemoved`). Optional — when present, the bootstrap wires a
   *  capability-profile monitor that re-pushes `BridgeCapabilityProfile`
   *  to the server via `bridge.capabilityProfile.push` on every (re)connect
   *  AND on every permission-state change (TR-17). Without it, the
   *  server's eligibility filter stays on whatever profile the bridge
   *  reported at pair time; tests omit when not exercising the path. */
  chromePermissions?: ChromePermissionsApi;
  /** Static fields of the capability profile that don't move at
   *  permission-event time (software / chrome version, optional UA,
   *  offscreen / alarms support). Re-read on every push. Optional —
   *  absent ⇒ no monitor is wired even when `chromePermissions` is
   *  present (a profile without a software_version is malformed by
   *  contract). */
  capabilityProfileSnapshot?: (context: import('../permissions/profile-monitor.js').BridgeCapabilitySnapshotContext)
    => BridgeCapabilityProfileSnapshot | Promise<BridgeCapabilityProfileSnapshot>;
  /** SW lifecycle event subscriptions. */
  swLifecycle: BridgeSwLifecycle;
  /** WsTransportFactory — production wires `createBrowserBridgeTransportFactory()`; tests inject a fake. */
  wsTransportFactory: WsTransportFactory;
  /** D-169 P0 Slice 2B — AES-GCM wrap/unwrap primitive over the
   *  bridge's `webclient_token` record. Production wires the
   *  WebCrypto-backed factory; tests inject an in-memory fake. The
   *  resolveBearer path calls `unwrap` on every (re)connect attempt
   *  so plaintext never lives longer than one connect microtask
   *  (mirrors webclient bootstrap DD#2). */
  tokenStore: WebclientTokenStore;
  /** Bridge version string for result envelopes. */
  bridgeVersion: string;
  /** Default OS-notification icon URL. */
  defaultNotificationIconUrl: string;
  /** Action executor implementation (chrome.scripting wrappers). */
  actionExecutor: BridgeActionExecutor;
  /** D-169 P2 brick 3 — "Watch this element" picker injector (queries the
   *  active tab + `executeScript`s `picker/picker.js`). Optional — when
   *  present, the side-panel `launch-picker` responder uses it; absent ⇒ the
   *  responder replies `picker_unavailable` (tests / dev bench). */
  pickerInjector?: BridgePickerInjector;
  /** Optional clock — defaults to Date.now. */
  now?: () => number;
  /** Explicit cache override for fixtures and custom hosts. Takes precedence
   *  over idempotencyForPair. Without either, fixtures use volatile storage. */
  idempotency?: IdempotencyCache;
  /** Production opens durable receipts scoped to the authenticated server
   *  identity and client token. Reused for the lifetime of this worker. */
  idempotencyForPair?: (scope: BridgeIdempotencyScope) => IdempotencyCache;
  /** Optional fixture overrides for grants and queue. */
  grants?: BridgeGrantStore;
  queue?: BridgeFifoQueue;
  /** D-169 P1.5 — one-shot `passport.fetch` invoker the pairing session's
   *  finalize drives after `/auth/pair` succeeds. Optional;
   *  defaults to `createBridgePairPassportInvoker({ wsTransportFactory })`
   *  so production picks up the same browser-WebSocket factory the
   *  long-lived WS uses. Tests inject an in-memory fake. */
  pairPassportInvoker?: BridgePairPassportInvoker;
  /** D-169 P1.5 — UUID-mint seam used by the pairing session's finalize.
   *  Optional; defaults to `crypto.randomUUID()`. Tests pin a
   *  deterministic id for assertions on the wrapped record's AAD. */
  pairCompletionMintTokenId?: () => string;
  /** `chrome.storage.session`, where the pairing session holds an accepted
   *  pairing until setup finishes (`pairing/pending-pair-store.ts`). Absent
   *  (tests / dev bench) ⇒ the reply is held in this worker's memory only. */
  chromeStorageSession?: ChromeStorageSessionArea;
  /** `chrome.runtime.reload` — used only when the paired runtime will not
   *  start in place after a successful pair, so the bridge still comes up
   *  paired (at the cost of closing the side panel). Absent (tests / dev
   *  bench) ⇒ no fallback. */
  chromeRuntimeReload?: () => void;
  /** Fetch for the pairing session's `/auth/pair` POST. Absent ⇒
   *  `globalThis.fetch` (production). */
  fetch?: typeof fetch;
  /** Mints the instance id sent with each pair (tests pin one). Defaults
   *  to `crypto.randomUUID()`. */
  pairMintInstanceId?: () => string;
}

/** Returned by `bootBridgeServiceWorker` so the caller (production
 *  entry / tests) can observe the boot's outcome + tear down. The runtime
 *  fields are read live: a bridge that boots unpaired and pairs later
 *  starts its paired runtime in place, and these then report it. */
export interface BridgeServiceWorkerHandle {
  /** True iff the paired runtime is running (WS pipeline built). */
  readonly paired: boolean;
  /** Snapshot of the pair-state inspection the paired runtime last started
   *  from (else the boot's). Always present so the caller can render
   *  diagnostic copy. */
  readonly pairSnapshot: BridgeStateInspection;
  /** The constructed WS client (paired path only). */
  readonly wsClient: WsClient | null;
  /** D-169 P0 Slice 3 — typed rpc conn over the WS (paired path only).
   *  Side-panel mounts + Settings rows + future inbound-reply paths
   *  all call against this `Conn<ServerRpcRegistry>` rather than
   *  inventing their own correlation primitive. Null while unpaired
   *  + null after `stop()` (the conn is disposed during teardown). */
  readonly rpcConn: BridgeRpcConn | null;
  /** D-169 P0 — capability profile monitor (paired path only + when
   *  `chromePermissions` + `capabilityProfileSnapshot` were both wired).
   *  Tests `pushNow()` to drive the rpc on demand; the monitor's own
   *  chrome.permissions listeners fire it on every grant change. */
  readonly capabilityMonitor: BridgeCapabilityProfileMonitor | null;
  /** Navigation, same-URL reload, tab closure or replacement retires a picker. */
  retirePickerForTab(tab_id: number): void;
  /** Stop the SW pipeline. Idempotent — safe to call from a chrome
   *  unload listener or a test teardown. */
  stop(): Promise<void>;
}

/** What a started paired runtime holds (the handle reads these live). */
interface BridgePairedRuntime {
  ws: WsClient;
  rpcConn: BridgeRpcConn;
  capabilityMonitor: BridgeCapabilityProfileMonitor | null;
  stop(): Promise<void>;
}

/** The `paired` check: server URL, wrapped bearer and server key stored. */
/** How long the side panel's Disconnect waits for the server to take this bridge off its
 *  devices before forgetting the pairing anyway. */
export const DISCONNECT_WAIT_MS = 5_000;

const isStoredPaired = (local: BridgeStateInspection['local']): boolean =>
  local.server_url !== null && local.webclient_token !== null && local.server_public_key !== null;

/** Build a result envelope back to the server. The server's WS layer
 *  routes by `command_id` to the awaiting dispatcher slot. Typed
 *  against `BridgeFromBridgeWireEnvelope` so the wire-protocol shape
 *  stays a contract — drift between this producer + the future
 *  server-side consumer is a compile-time failure on one side. */
const sendBridgeResult = (ws: WsClient, result: BridgeResult): void => {
  const envelope: BridgeFromBridgeWireEnvelope = { kind: 'result', result };
  try {
    ws.send(JSON.stringify(envelope));
  } catch {
    // Disconnected mid-result. The server's idempotency layer will
    // request a replay on the next reconnect via a fresh BridgeCommand
    // carrying the same idempotency_key (D-148 § A.3.3).
  }
};

interface BridgeEnvelopeRouter {
  dispatch(envelope: BridgeWireEnvelope): void;
  resumeCommands(): void;
  stop(): void;
}

/** Wire the inbound `BridgeWireEnvelope` router. Pure factory — the
 *  router function is invoked by the SW's inbound dispatcher
 *  (`buildInboundDispatcher`, below) after a parse-once step has
 *  established the frame matches the `BridgeWireEnvelope` discriminator
 *  (`typeof envelope.kind === 'string'`). The router itself only
 *  branches on `kind`; the outer dispatcher owns the parse + the
 *  multiplex with the rpc conn. */
const buildEnvelopeRouter = (args: {
  ws: WsClient;
  bridgeVersion: string;
  now: () => number;
  executor: BridgeActionExecutor;
  grants: BridgeGrantStore;
  getIdempotencyCache(): IdempotencyCache;
  queue: BridgeFifoQueue;
  onQueueReleased(): void;
  notificationDispatch: (
    notification: ServerToBridgeNotification,
  ) => Promise<void> | void;
  notificationPermission(): Promise<'granted' | 'denied'>;
  notificationClear(id: string): Promise<void>;
  inflight: Map<string, { signalled: boolean }>;
}): BridgeEnvelopeRouter => {
  let draining = false;
  let stopped = false;
  // Reconnecting with another token must not redirect a queued or running
  // command's receipt to that token's namespace.
  const receiptCaches = new WeakMap<BridgeCommand, IdempotencyCache>();

  /** One drain per runtime. The shared FIFO's running slot serializes
   *  dispatches across runtimes, including one stopped while awaiting
   *  its executor. Enqueues during this drain are picked up on its next
   *  iteration. */
  const drainQueue = async (): Promise<void> => {
    if (stopped || draining) return;
    draining = true;
    try {
      while (!stopped) {
        const command = args.queue.dequeue();
        if (!command) return;

        const cancel = { signalled: false };
        args.inflight.set(command.command_id, cancel);
        try {
          const outcome = await dispatchBridgeCommand(
            command,
            {
              bridge_version: args.bridgeVersion,
              now: args.now,
              executor: args.executor,
              grants: args.grants,
              idempotency: receiptCaches.get(command) ?? args.getIdempotencyCache(),
            },
            cancel,
          );
          if (!stopped) sendBridgeResult(args.ws, outcome.result);
        } catch {
          // A receipt read/write failure must not acknowledge completion.
          // The action may already have run if its receipt could not commit;
          // leave the server to classify that uncertain outcome. Always release
          // queue ownership so later commands are not wedged.
        } finally {
          receiptCaches.delete(command);
          args.inflight.delete(command.command_id);
          args.queue.complete(command.command_id);
        }
      }
    } finally {
      draining = false;
      // The shared queue keeps its running slot until this dispatch settles.
      // A new runtime may already have queued work and found that slot busy.
      // Wake its drain, rather than consuming its work through this old owner.
      if (stopped) args.onQueueReleased();
    }
  };

  const dispatch = (envelope: BridgeWireEnvelope): void => {
    if (stopped) return;
    if (envelope.kind === 'command') {
      const command = envelope.command;
      const enqueued = args.queue.enqueue(command);
      if (!enqueued.ok) {
        // A WS write cannot synchronously return HTTP 429. Carry the
        // same backpressure signal in the typed result frame; the
        // server retries this command_id after exponential backoff.
        sendBridgeResult(args.ws, {
          command_id: command.command_id,
          status: 'rejected',
          error: {
            code: 'queue_full',
            message: `bridge: command queue full (${enqueued.depth}/${enqueued.max} pending)`,
          },
          duration_ms: 0,
          bridge_version: args.bridgeVersion,
          idempotency_key_seen: false,
        });
        return;
      }
      receiptCaches.set(command, args.getIdempotencyCache());
      void drainQueue();
      return;
    }

    if (envelope.kind === 'cancel') {
      const command_id = envelope.cancel.command_id;
      const cancelled = args.queue.cancel(command_id);
      if (cancelled === 'running') {
        const cancel = args.inflight.get(command_id);
        if (cancel) cancel.signalled = true;
      } else if (cancelled === 'dropped') {
        sendBridgeResult(args.ws, {
          command_id,
          status: 'cancelled',
          duration_ms: 0,
          bridge_version: args.bridgeVersion,
          idempotency_key_seen: false,
        });
      }
      return;
    }

    const receipt = (request_id: string, outcome: import('@recued/contracts').BridgeNotificationReceipt['outcome'], notification_id?: string) => {
      try { const response: BridgeFromBridgeWireEnvelope = { kind: 'notification_receipt', receipt: { request_id, outcome, ...(notification_id ? { notification_id } : {}) } };
        args.ws.send(JSON.stringify(response)); } catch { /* The durable sender will reconcile or replace this exact OS id. */ }
    };
    if (envelope.kind === 'notification.probe') {
      void args.notificationPermission().then(value => receipt(envelope.request_id, value === 'granted' ? 'ready' : 'denied'),
        () => receipt(envelope.request_id, 'failed')); return;
    }
    if (envelope.kind === 'notification.clear') {
      void args.notificationClear(envelope.notification_id).then(() => receipt(envelope.request_id, 'cleared', envelope.notification_id),
        () => receipt(envelope.request_id, 'failed', envelope.notification_id)); return;
    }
    if (envelope.kind === 'notification') {
      const id = envelope.receipt_request_id;
      void (async () => {
        try { if (id && await args.notificationPermission() !== 'granted') { receipt(id, 'denied', envelope.notification.notification_id); return; }
          await args.notificationDispatch(envelope.notification);
          if (id) receipt(id, 'displayed', envelope.notification.notification_id);
        } catch { if (id) receipt(id, 'failed', envelope.notification.notification_id); }
      })();
      return;
    }

    // Unknown kind — drop. The TypeScript discriminated union assertion
    // catches new variants at compile time; runtime here just defends.
  };
  return {
    dispatch,
    resumeCommands: () => { void drainQueue(); },
    stop: () => { stopped = true; },
  };
};

/** D-169 P0 Slice 3 (+ P2 Slice 1) — three-protocol inbound dispatcher.
 *
 *  Builds the function the WsClient's `handlers.onMessage` invokes on
 *  every inbound text frame. The SW carries three wire protocols on the
 *  one WS:
 *
 *    1. Standard rpc framing for `Conn<ServerRpcRegistry>` calls
 *       (events.subscribe, system.status, notification.submitAnswer,
 *       …). Reply frame shape: `{ type: 'rpc_result', request_id, … }`.
 *    2. `BridgeWireEnvelope` framing for DOM-executor wire protocol —
 *       `{ kind: 'command' | 'cancel' | 'notification', … }`.
 *    3. D-169 P2 — broadcast-bus push envelope:
 *       `{ type: 'server_event', event: ServerEvent }` (the same
 *       envelope the webclient consumes; D-121 / contracts `events.ts`).
 *
 *  The discriminators are disjoint: the bus + rpc frames carry a
 *  top-level `type` (and NO top-level `kind` — the bus event's `kind`
 *  is nested under `.event`); the BridgeWireEnvelope carries a
 *  top-level `kind` (and no `type`). A parse-once dispatch routes
 *  deterministically:
 *
 *    - `parsed.type === 'rpc_result'`   → `rpcConn.dispatchInbound(parsed)`
 *      (the conn settles the matching in-flight caller; non-matching
 *      `request_id` is dropped silently).
 *    - `parsed.type === 'server_event'` → `dispatchServerEvent(parsed.event)`
 *      (the subscriber validates the inner kind + fans to the bus buffer).
 *    - `typeof parsed.kind === 'string'` → `envelopeRouter(parsed)`
 *      (the BridgeWireEnvelope router branches on `kind`).
 *    - Anything else → silent drop (malformed JSON, missing/unknown
 *      discriminator). SWs MUST NOT raise on a server-shaped bug.
 *
 *  The single parse-and-discriminate posture (one `JSON.parse` per
 *  inbound frame, not one per router) is the natural shape because
 *  the bootstrap now owns the multiplex decision; routers consume
 *  pre-parsed structured frames. */
const buildInboundDispatcher = (args: {
  rpcConn: BridgeRpcConn;
  envelopeRouter: (envelope: BridgeWireEnvelope) => void;
  /** D-169 P2 Slice 1 — broadcast-bus event sink. The dispatcher hands
   *  it the inner `event` payload of a `server_event` frame. */
  dispatchServerEvent: (event: unknown) => void;
}): ((payload: string) => void) => {
  return (payload: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // malformed JSON — silently drop
    }
    if (!parsed || typeof parsed !== 'object') return;
    const frame = parsed as { type?: unknown; kind?: unknown; event?: unknown };
    // Codex 2026-05-27 MINOR (Angle 1) fold — drop ambiguous mixed-
    // discriminator frames. The `type` and `kind` shapes are disjoint
    // by contract, so a `type`-tagged frame (rpc_result / server_event)
    // also carrying a top-level `kind` is a server-shaped bug; routing
    // it either way would mask the bug + risk double-processing if the
    // dispatch ever extends to fan-out. Drop silently — SWs MUST NOT
    // raise on server-side bugs.
    const hasRpcDiscriminator = frame.type === 'rpc_result';
    const hasServerEventDiscriminator = frame.type === 'server_event';
    const hasEnvelopeDiscriminator = typeof frame.kind === 'string';
    if (
      (hasRpcDiscriminator || hasServerEventDiscriminator) &&
      hasEnvelopeDiscriminator
    ) {
      return;
    }
    if (hasRpcDiscriminator) {
      args.rpcConn.dispatchInbound(parsed);
      return;
    }
    if (hasServerEventDiscriminator) {
      // Hand the inner event to the subscriber; it validates the kind
      // (∈ BROADCAST_EVENT_KIND_SET) + drops a missing/malformed payload.
      args.dispatchServerEvent(frame.event);
      return;
    }
    if (hasEnvelopeDiscriminator) {
      args.envelopeRouter(parsed as BridgeWireEnvelope);
      return;
    }
    // Unknown frame — drop. New protocols would add a fresh
    // discriminator branch here.
  };
};

/** Boot the bridge service worker. Pure composition — wires the
 *  typed modules into a live SW. Production calls this from a thin
 *  wrapper (`bridgeServiceWorkerMain` below) that binds chrome.*
 *  globals to the deps shape. Tests call directly with fakes.
 *
 *  Always-on side effects: SW install + activate handlers and the side
 *  panel's responders (the pairing session among them) are registered
 *  regardless of pair state, so an unpaired panel can pair the bridge. */
export const bootBridgeServiceWorker = async (
  deps: BridgeServiceWorkerDeps,
): Promise<BridgeServiceWorkerHandle> => {
  const now = deps.now ?? ((): number => Date.now());
  // Chrome storage has no compare-and-delete transaction. Pair finalization,
  // runtime starts and teardown persistence share this queue, so checking an
  // identity and clearing it cannot interleave with a supported new pairing.
  let pairWork: Promise<void> = Promise.resolve();
  const runPairWork = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = pairWork.then(work);
    pairWork = result.then(() => undefined, () => undefined);
    return result;
  };
  type TeardownResult = { told_server: boolean };
  type PairOwner = {
    serverUrl: string;
    serverKey: string;
    tokenId: string;
    instanceId: string | null;
    conn: BridgeRpcConn | null;
    confirmedRevocation: boolean;
    teardown: Promise<TeardownResult> | null;
  };
  let currentPairOwner: PairOwner | null = null;

  // 1. SW lifecycle handlers — skipWaiting + claim so the new SW
  // becomes the active version immediately.
  deps.swLifecycle.onInstall(() => {
    void Promise.resolve(deps.swLifecycle.skipWaiting());
  });
  deps.swLifecycle.onActivate((event) => {
    event.waitUntil(Promise.resolve(deps.swLifecycle.claim()));
  });

  // 2. Build the local-store + queue/grants/idempotency collaborators.
  const localStore: BridgeLocalStore = createChromeBridgeLocalStore(deps.chromeStorage);
  const queue = deps.queue ?? createFifoQueue();
  let activeEnvelopeRouter: BridgeEnvelopeRouter | null = null;
  // Invalidation contains no command data. A closed or slow panel cannot
  // delay committed admission/results or accumulate broadcast promises.
  const diagnosticChanges = createCoalescedTask(() => deps.chromeRuntimeSendMessage?.({
    type: 'recued.bridge.side-panel.diagnostics-invalidated',
  }));
  const observeCache = (cache: IdempotencyCache): IdempotencyCache => observeIdempotencyChanges(cache, () => {
    if (deps.chromeRuntimeSendMessage) diagnosticChanges.request();
  });
  let idempotency = observeCache(deps.idempotency ?? createInMemoryIdempotencyCache({ now }));
  const pairCaches = new Map<string, IdempotencyCache>();
  const getIdempotencyForPair = (scope: BridgeIdempotencyScope): IdempotencyCache => {
    if (deps.idempotency || !deps.idempotencyForPair) return idempotency;
    const key = JSON.stringify([scope.server_public_key, scope.token_id]);
    let cache = pairCaches.get(key);
    if (!cache) {
      cache = observeCache(deps.idempotencyForPair(scope));
      pairCaches.set(key, cache);
    }
    return cache;
  };
  const selectIdempotencyForPair = (scope: BridgeIdempotencyScope): void => {
    idempotency = getIdempotencyForPair(scope);
  };
  const selectStoredPairCache = async (): Promise<void> => {
    const { server_url, server_public_key, webclient_token } = await localStore.inspect();
    if (server_url !== null && server_public_key !== null && webclient_token !== null) {
      selectIdempotencyForPair({ server_public_key, token_id: webclient_token.token_id });
    }
  };
  const grants = deps.grants ?? createInMemoryBridgeGrantStore();
  const inspectState = (): Promise<BridgeStateInspection> => buildBridgeStateInspection({
    local: localStore, queue, idempotency, grants, now,
    ...(deps.idempotencyForPair && !deps.idempotency ? { idempotencyForPair: getIdempotencyForPair } : {}),
  });
  // D-169 P1.5 — one-shot passport.fetch invoker, built lazily from
  // the same `WsTransportFactory` the long-lived WS uses. Tests inject
  // a fake via `deps.pairPassportInvoker`; production picks up the
  // browser-WebSocket factory through the default path. The invoker
  // itself is stateless — each call opens its own transport — so a
  // single instance per SW lifetime is fine.
  const pairPassportInvoker: BridgePairPassportInvoker =
    deps.pairPassportInvoker ??
    createBridgePairPassportInvoker({
      wsTransportFactory: deps.wsTransportFactory,
    });

  /** Starts the paired runtime from what a finished pair stored. Assigned
   *  with the runtime below; the pairing session only calls it after the
   *  boot has returned (the entry holds every message until then). */
  let startPairedInPlace: () => Promise<void> = async () => {
    throw new Error('the paired runtime is not wired yet');
  };

  /** The stored connection URL when the three fields the `paired` check
   *  reads are all present, else null. */
  const readStoredPair = async (): Promise<{ serverUrl: string } | null> => {
    const [serverUrl, token, serverKey] = await Promise.all([
      localStore.get('server_url'),
      localStore.get('webclient_token'),
      localStore.get('server_public_key'),
    ]);
    return serverUrl !== null && token !== null && serverKey !== null ? { serverUrl } : null;
  };

  // The pairing session (`pairing/worker-pairing.ts`). "Pair this bridge"
  // runs HERE rather than in the side panel, so it survives the panel
  // closing: the `/auth/pair` POST, the held reply, the finalize, and then
  // the paired runtime's start (`startPairedInPlace`, below).
  // It runs one attempt at a time (Codex HIGH #11: `finalizeBridgePair`
  // reads `webclient_token` and then performs five awaited writes, so two
  // concurrent finalizes would interleave into a mixed-generation paired
  // state with mismatched AAD).
  /** Which server refused this bridge's sign-in, for the pair form (`forgetRefusedPairing`). */
  const refusals = deps.chromeStorageSession
    ? createSessionSignInRefusalStore(deps.chromeStorageSession)
    : createInMemorySignInRefusalStore();
  const pairing = createBridgeWorkerPairing({
    submit: (options) =>
      submitBridgePairCodeInput({ ...options, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    finalize: (accepted) => runPairWork(() =>
      finalizeBridgePair({
        serverUrl: accepted.serverUrl,
        bearer: accepted.token,
        ...(accepted.token_id !== undefined ? { token_id: accepted.token_id } : {}),
        ...(accepted.passport !== undefined ? { passport: accepted.passport } : {}),
        ...(accepted.instanceId !== undefined ? { instanceId: accepted.instanceId } : {}),
        localStore,
        tokenStore: deps.tokenStore,
        invokePassportFetch: pairPassportInvoker,
        now,
        ...(deps.pairCompletionMintTokenId
          ? { mintTokenId: deps.pairCompletionMintTokenId }
          : {}),
      })),
    readPaired: readStoredPair,
    ...(deps.chromeStorageSession
      ? { pendingStore: createSessionPendingPairStore(deps.chromeStorageSession) }
      : {}),
    // Paired: connect from this worker, now. Declared below; only ever
    // called after the boot has returned.
    onPaired: () => runPairWork(() => startPairedInPlace()),
    ...(deps.pairMintInstanceId ? { mintInstanceId: deps.pairMintInstanceId } : {}),
    refusals,
  });

  // The SW retains a placeholder for the latest rpcConn so the
  // side-panel `fetch-status` responder can invoke `system.status`.
  // Defined here (before the inspect responder) + assigned when the
  // paired runtime starts — at boot, or in place after a pair; null
  // until then.
  let rpcConnForSidePanel: BridgeRpcConn | null = null;
  // Whether the paired socket is up right now. Null until the paired-path
  // boot builds it; read by the `fetch-status` responder so a status asked
  // for before the socket connects is answered "connecting" rather than
  // failing with the transport's "send called while disconnected".
  let isServerConnected: (() => boolean) | null = null;
  /** Set while the owner disconnects this bridge from its side panel (`disconnect`, below): the
   *  server closing the socket with 4003, for the revoke this bridge asked for itself, is its
   *  answer, not a refusal to note. */
  let disconnecting: { owner: PairOwner; closed(code: number): void } | null = null;
  /** The side panel's Disconnect. Assigned with the paired runtime's state, below. */
  let disconnect: (() => Promise<{ told_server: boolean }>) | null = null;
  const pickerSessions = createPickerSessions<BridgeRpcConn>(now);
  let pickerLaunchPending = false;

  // D-169 P2 Slice 1 — the live broadcast-bus buffer. Created
  // unconditionally (pure in-memory; the unpaired path just never feeds
  // it) so the `fetch-frames` responder below can close over the same
  // instance the paired-path subscriber writes to. The buffer is the
  // single accumulator; the side-panel store is a render-through cache
  // re-applied wholesale on each poll (N.4 / I-7 — no retention layer).
  const busBuffer: BridgeBusBuffer = createBridgeBusBuffer({ now });

  // D-169 P2 Slice 2 — forward-declared historical-view seeder. Declared
  // here (before the message responders close over it) + assigned after
  // `rpcConn` is constructed. Fires the three historical-view rpcs
  // (`execution.recent` / `notification.recent` / `notification.pending_asks`)
  // and REPLACES the bus buffer's three sections with the authoritative
  // recent slice (spec § A.4 / A.5). Awaitable so the `fetch-history`
  // responder can return the post-seed snapshot for an immediate
  // mount-time render; also fired (fire-and-forget) from `onConnected` so
  // the bridge re-fetches on every (re)connect (cursorless re-fetch — the
  // rpc slice is authoritative, no `cursor_since`). Null until the paired-
  // path wiring assigns it (the responders no-op to the current buffer).
  let fetchAndSeedHistory: (() => Promise<void>) | null = null;
  // D-169 P2 Slice 2 Codex P2 fold — monotonic generation for the
  // single-flight seed guard above; only the newest seed's result is
  // applied so a slow stale fetch can't overwrite a newer one.
  let seedGeneration = 0;

  // D-169 P2 Slice 4 (live-mode propagation) — push a one-shot
  // `bridge-mode-invalidated` signal to the (possibly open) side panel.
  // The side panel can't see the broadcast bus directly (the WS lives in
  // this SW), so a `notification.bridge_mode_changed` event has to cross
  // the SW → side-panel boundary as a runtime message; the side panel
  // re-reads its OWN self-scoped mode via `my_bridge_mode` on receipt
  // (signal only — we never forward the event's flags; the server is
  // authoritative). Declared unconditionally (pure closure over `deps`)
  // before the WsClient + bus subscriber close over it; a no-op when no
  // `chromeRuntimeSendMessage` dep is wired. `sendMessage` rejects when
  // the side panel is closed (no receiver) — swallowed: a closed panel
  // re-reads its mode on next open.
  const pushBridgeModeInvalidated = (): void => {
    if (!deps.chromeRuntimeSendMessage) return;
    try {
      const out = deps.chromeRuntimeSendMessage({
        type: 'recued.bridge.side-panel.bridge-mode-invalidated',
      });
      if (out && typeof (out as Promise<unknown>).catch === 'function') {
        (out as Promise<unknown>).catch(() => {});
      }
    } catch {
      // sendMessage threw synchronously (no receiver / teardown) — ignore.
    }
  };

  /** Tells an open side panel the socket just (re)connected, so a status
   *  read that found it still connecting runs again at once instead of on
   *  the 30 s tick. Signal only, like the mode ping above; a closed panel
   *  makes `sendMessage` reject, which is swallowed. */
  const pushServerConnected = (): void => {
    if (!deps.chromeRuntimeSendMessage) return;
    try {
      const out = deps.chromeRuntimeSendMessage({
        type: 'recued.bridge.side-panel.server-connected',
      });
      if (out && typeof (out as Promise<unknown>).catch === 'function') {
        (out as Promise<unknown>).catch(() => {});
      }
    } catch {
      // sendMessage threw synchronously (no receiver / teardown) — ignore.
    }
  };

  /** D-169 P2 brick 3 — push the "Watch this element" create outcome to the
   *  (open) side panel so it can render the confirmation + #automation enable
   *  hint. Value-carrying (unlike the mode-invalidate ping): the panel needs
   *  the create result to show the right status line. No-op when no
   *  `chromeRuntimeSendMessage` dep / the panel is closed (a lost push just
   *  means no confirmation line; the user launched from the panel, so it's
   *  normally still open). */
  const pushPickerResult = (payload: {
    launch_id: string;
    ok: boolean;
    cancelled?: boolean;
    created?: boolean;
    recipe_id?: string;
    url?: string;
    error?: string;
  }): void => {
    if (!deps.chromeRuntimeSendMessage) return;
    try {
      const out = deps.chromeRuntimeSendMessage({
        type: 'recued.bridge.side-panel.picker-result',
        ...payload,
      });
      if (out && typeof (out as Promise<unknown>).catch === 'function') {
        (out as Promise<unknown>).catch(() => {});
      }
    } catch {
      // sendMessage threw synchronously (no receiver / teardown) — ignore.
    }
  };

  // 4. The side panel's responders — always wired. `recued.bridge.inspect`
  //    returns a `BridgeStateInspection` for the panel's diagnostic
  //    section. `fetch-status`: when paired, proxies to `system.status`
  //    via the WS rpc; when unpaired, returns a typed error. The pairing
  //    session's messages are routed here too, which is why this runs
  //    before the pair state is read.
  deps.chromeRuntimeOnMessage.addListener((message, sender, sendResponse) => {
    const typed = message as { type?: unknown } | null | undefined;
    if (typed && typed.type === 'recued.bridge.inspect') {
      void inspectState().catch(() => null).then((snapshot) => {
        try { sendResponse(snapshot); } catch { /* The panel may have closed. */ }
      });
      return true; // async response — Chrome keeps the channel open
    }
    // The owner disconnects this bridge from its side panel (`disconnect`, below). The panel,
    // watching the stored pair, then shows the pair form.
    if (typed && typed.type === 'recued.bridge.side-panel.disconnect') {
      void (async () => {
        if (disconnect === null) {
          sendResponse({ ok: false, error: 'bridge_not_ready' });
          return;
        }
        try {
          sendResponse({ ok: true, ...(await disconnect()) });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }
    if (typed && typed.type === 'recued.bridge.side-panel.fetch-status') {
      void (async () => {
        if (rpcConnForSidePanel === null) {
          // Stored as paired but no runtime yet: a pair just finished and
          // its runtime is starting (the panel switches to its paired
          // sections the moment the storage writes land, which is before
          // the runtime starts). That is a wait, not "not paired".
          let stored: { serverUrl: string } | null = null;
          try {
            stored = await readStoredPair();
          } catch {
            stored = null;
          }
          sendResponse({
            ok: false,
            error: stored !== null ? 'bridge_connecting' : 'bridge_not_paired',
          });
          return;
        }
        // The panel opened while the socket is still coming up. Say so —
        // the panel shows "Connecting to your server…" — and let the
        // `server-connected` push bring it back for the real answer. Asking
        // anyway used to fail with the transport's own "send called while
        // disconnected", which the panel showed in red for 30 seconds.
        if (isServerConnected !== null && !isServerConnected()) {
          sendResponse({ ok: false, error: 'bridge_connecting' });
          return;
        }
        try {
          const reply = await rpcConnForSidePanel.call('system.status');
          sendResponse({ ok: true, status: reply.status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    // D-169 P2 Slice 4 — side-panel "what is THIS bridge's own mode?"
    // fetch. Proxies to the self-scoped `notifications.my_bridge_mode` rpc
    // (the server keys it on the authenticated `client_token_id` — no arg,
    // a client can only ask about itself). The side panel reads it on
    // mount + each periodic tick to gate its approval-card rendering on
    // this bridge's approval mode. Unpaired → typed error (the panel keeps
    // its fail-closed both-off default).
    if (typed && typed.type === 'recued.bridge.side-panel.fetch-bridge-mode') {
      void (async () => {
        if (rpcConnForSidePanel === null) {
          sendResponse({ ok: false, error: 'bridge_not_paired' });
          return;
        }
        try {
          const reply = await rpcConnForSidePanel.call(
            'notifications.my_bridge_mode',
          );
          sendResponse({ ok: true, modes: reply.modes });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    // D-169 P2 Slice 1 — side-panel live-list poll. Returns the current
    // bus-buffer snapshot (sections #2/#3/#4). Synchronous in-memory
    // read; the `sendMessage` round-trip structurally clones it so the
    // side panel never references the buffer's live arrays. Returns the
    // (empty) snapshot regardless of pair state — the side panel only
    // polls when paired, and an empty snapshot pre-pair is harmless.
    if (typed && typed.type === 'recued.bridge.side-panel.fetch-frames') {
      sendResponse({ ok: true, ...busBuffer.snapshot() });
      return true;
    }
    // D-169 P2 Slice 2 — side-panel mount-time historical fetch (spec
    // § A.4 "on side-panel mount"). Triggers a fresh authoritative seed of
    // the bus buffer (the 3 historical-view rpcs), then returns the
    // post-seed snapshot so the panel renders recent history immediately
    // on open — not after the next 5s `fetch-frames` tick. When the seeder
    // isn't wired yet (unpaired / pre-boot) the buffer is empty and is
    // returned as-is. Errors inside the seed are swallowed there (the
    // buffer is left intact), so this responder always resolves `ok`.
    if (typed && typed.type === 'recued.bridge.side-panel.fetch-history') {
      void (async () => {
        if (fetchAndSeedHistory !== null) {
          await fetchAndSeedHistory();
        }
        sendResponse({ ok: true, ...busBuffer.snapshot() });
      })();
      return true;
    }
    // D-169 P2 Slice 3 — side-panel approval-card submit. Funnels the
    // chosen option into the server's `notification.submitAnswer` rpc (→
    // the block's `submitAnswer`, first-answer-wins dedup across surfaces,
    // D-158 I-6). On success, re-seed history so the answered ask (now no
    // longer `open`) drops out of the approvals section immediately, ahead
    // of the `notification.ask_closed` bus frame that also resolves it.
    if (typed && typed.type === 'recued.bridge.side-panel.submit-answer') {
      const payload = message as {
        ask_id?: unknown; option_id?: unknown; note?: unknown;
      };
      const ask_id =
        typeof payload.ask_id === 'string' ? payload.ask_id : '';
      const option_id =
        typeof payload.option_id === 'string' ? payload.option_id : '';
      void (async () => {
        if (rpcConnForSidePanel === null) {
          sendResponse({ ok: false, error: 'bridge_not_paired' });
          return;
        }
        if (ask_id === '' || option_id === '') {
          sendResponse({
            ok: false,
            error: 'submit-answer requires string ask_id + option_id',
          });
          return;
        }
        try {
          await rpcConnForSidePanel.call('notification.submitAnswer', {
            ask_id,
            option_id,
            // D-234 § 234.4e — the LAST hop. Validated only for type: the server
            // block owns whether this ask invited a note, the cap, and the
            // required-ness, and re-deciding any of it here would put the rule
            // in a second place that cannot see `note_prompt`.
            ...(typeof payload.note === 'string' && payload.note !== ''
              ? { note: payload.note }
              : {}),
          });
          if (fetchAndSeedHistory !== null) {
            await fetchAndSeedHistory();
          }
          sendResponse({ ok: true, ...busBuffer.snapshot() });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    // D-181 slice 6a — side-panel active-executions snapshot. Proxies to the
    // `execution.active` rpc (a paired bridge is `view`-capable per §8 — the
    // server authorises any authenticated paired caller to read). No
    // session_id arg: the bridge is the owner's own device and gets the full
    // owner active-list. Unpaired → typed error (the panel only polls when
    // paired; an empty list pre-pair is harmless).
    if (typed && typed.type === 'recued.bridge.side-panel.fetch-active') {
      void (async () => {
        if (rpcConnForSidePanel === null) {
          sendResponse({ ok: false, error: 'bridge_not_paired' });
          return;
        }
        try {
          const reply = await rpcConnForSidePanel.call('execution.active', {});
          sendResponse({ ok: true, entries: reply.entries, lanes: reply.lanes });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    // D-181 slice 6a — side-panel live-control mutators (kill / cancel /
    // promote). Each proxies to the matching `execution.*` rpc; the SERVER
    // re-checks the bridge-approval gate (fail-closed: a bridge without
    // `bridge_mode.approval` is denied with `forbidden`, surfaced here as
    // `ok:false`), so this is defence-in-depth alongside the side panel only
    // rendering the buttons in approval mode. The verdict (`status`) is
    // returned so the panel can render a legible notice for a non-terminal
    // outcome; the panel then re-fetches `execution.active` to refresh the list.
    if (typed && typed.type === 'recued.bridge.side-panel.execution-kill') {
      const payload = message as { run_id?: unknown };
      const run_id = typeof payload.run_id === 'string' ? payload.run_id : '';
      void (async () => {
        if (rpcConnForSidePanel === null) {
          sendResponse({ ok: false, error: 'bridge_not_paired' });
          return;
        }
        if (run_id === '') {
          sendResponse({ ok: false, error: 'execution-kill requires a string run_id' });
          return;
        }
        try {
          const reply = await rpcConnForSidePanel.call('execution.kill', { run_id });
          sendResponse({ ok: true, status: reply.status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    if (typed && typed.type === 'recued.bridge.side-panel.execution-cancel') {
      const payload = message as { queued_call_id?: unknown };
      const queued_call_id =
        typeof payload.queued_call_id === 'string' ? payload.queued_call_id : '';
      void (async () => {
        if (rpcConnForSidePanel === null) {
          sendResponse({ ok: false, error: 'bridge_not_paired' });
          return;
        }
        if (queued_call_id === '') {
          sendResponse({
            ok: false,
            error: 'execution-cancel requires a string queued_call_id',
          });
          return;
        }
        try {
          const reply = await rpcConnForSidePanel.call('execution.cancel', {
            queued_call_id,
          });
          sendResponse({ ok: true, status: reply.status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    if (typed && typed.type === 'recued.bridge.side-panel.execution-promote') {
      const payload = message as { queued_call_id?: unknown };
      const queued_call_id =
        typeof payload.queued_call_id === 'string' ? payload.queued_call_id : '';
      void (async () => {
        if (rpcConnForSidePanel === null) {
          sendResponse({ ok: false, error: 'bridge_not_paired' });
          return;
        }
        if (queued_call_id === '') {
          sendResponse({
            ok: false,
            error: 'execution-promote requires a string queued_call_id',
          });
          return;
        }
        try {
          const reply = await rpcConnForSidePanel.call('execution.promote', {
            queued_call_id,
          });
          sendResponse({ ok: true, status: reply.status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }
    // D-169 P2 brick 3 — side-panel "Watch this element" launch. Injects the
    // picker content script into the active tab (the sanctioned write
    // gesture). The picked element returns later as a separate `picker.result`
    // message (below). Replies the inject outcome so the panel shows
    // "pick an element…" or a failure reason. The launch belongs to this
    // paired connection before any asynchronous injection work begins.
    if (typed && typed.type === 'recued.bridge.side-panel.launch-picker') {
      void (async () => {
        if (!deps.pickerInjector) {
          sendResponse({ ok: false, reason: 'picker_unavailable' });
          return;
        }
        const owner = rpcConnForSidePanel;
        if (owner === null) { sendResponse({ ok: false, reason: 'bridge_not_paired' }); return; }
        if (pickerLaunchPending) { sendResponse({ ok: false, reason: 'picker_busy' }); return; }
        pickerLaunchPending = true;
        const launch = pickerSessions.begin(owner);
        try {
          const outcome = await deps.pickerInjector.injectIntoActiveTab({
            launch_id: launch.launch_id,
            expires_at: launch.expires_at,
            bind: document => pickerSessions.bind(launch, rpcConnForSidePanel, document),
          });
          if (!pickerSessions.current(launch, rpcConnForSidePanel)) {
            sendResponse({ ok: false, reason: 'picker_session_invalid' });
          } else if (!outcome.ok || launch.document === null) {
            pickerSessions.retire(launch);
            sendResponse(outcome.ok ? { ok: false, reason: 'inject_failed' } : outcome);
          } else sendResponse({ ok: true, launch_id: launch.launch_id });
        } catch {
          pickerSessions.retire(launch);
          sendResponse({ ok: false, reason: 'inject_failed' });
        } finally { pickerLaunchPending = false; }
      })();
      return true;
    }
    // D-169 P2 brick 3 — the picker's outcome, from the injected content
    // script (fire-and-forget — it doesn't await this response). On 'picked',
    // derive the Chrome match pattern from the page url (fork 4) + create the
    // DISARMED watch via `triggers.createElementWatch`, then push the result
    // to the side panel for the confirmation + #automation enable hint.
    // Cancellation consumes the launch without creating a watch.
    //
    // The launch credential is single-use and bound to Chrome's sender
    // document, URL, top frame and this paired RPC connection. Validate and
    // consume before the first await, including cancellation and RPC failure.
    if (isPickerResultMessage(message)) {
      const accepted = pickerSessions.consume(message, sender, rpcConnForSidePanel);
      if (!accepted.ok) {
        if (accepted.expired) pushPickerResult({ launch_id: accepted.expired.launch_id, ok: false, error: accepted.error });
        sendResponse({ ok: false, error: accepted.error });
        return false;
      }
      const { launch } = accepted;
      const result = message.result;
      if (result.status !== 'picked') {
        pushPickerResult({ launch_id: launch.launch_id, ok: true, cancelled: true });
        sendResponse({ ok: true, cancelled: true });
        return false;
      }
      void (async () => {
        const url = deriveWatchUrlPattern(result.page_url);
        if (url === null) {
          pushPickerResult({ launch_id: launch.launch_id, ok: false, error: 'unsupported_page' });
          sendResponse({ ok: false, error: 'unsupported_page' });
          return;
        }
        try {
          const reply = await launch.owner.call(
            'triggers.createElementWatch',
            { url, selector: result.selector },
          );
          if (pickerSessions.current(launch, rpcConnForSidePanel)) pushPickerResult({
            launch_id: launch.launch_id,
            ok: true,
            created: reply.created,
            recipe_id: reply.recipe_id,
            url,
          });
          sendResponse({
            ok: true,
            created: reply.created,
            recipe_id: reply.recipe_id,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (pickerSessions.current(launch, rpcConnForSidePanel)) pushPickerResult({ launch_id: launch.launch_id, ok: false, error });
          sendResponse({ ok: false, error });
        }
      })();
      return true;
    }
    // The pairing session (`pairing/worker-pairing.ts`), asked by the side
    // panel's pair form. Every op answers through `sendResponse`. The
    // session never throws by contract; the catch backstops anything that
    // escapes, so the panel gets an outcome to render rather than Chrome's
    // channel-closed error.
    if (typed && typed.type === BRIDGE_PAIR_MESSAGE_TYPE) {
      const request = typed as Partial<BridgePairRequest> & { input?: unknown };
      void (async () => {
        try {
          switch (request.op) {
            case 'status':
              sendResponse(await pairing.status());
              return;
            case 'wait':
              sendResponse(await pairing.wait());
              return;
            case 'start': {
              const input = parseBridgePairStartInput(request.input);
              sendResponse(
                input === null
                  ? ({
                      ok: false,
                      kind: 'error',
                      detail: 'pair start is missing the server address',
                    } satisfies BridgePairOutcome)
                  : await pairing.start(input),
              );
              return;
            }
            case 'finish':
              sendResponse(await pairing.finish());
              return;
            case 'abandon':
              sendResponse(await pairing.abandon());
              return;
            default:
              sendResponse({
                ok: false,
                kind: 'error',
                detail: `unknown pair op: ${String(request.op)}`,
              } satisfies BridgePairOutcome);
          }
        } catch (err) {
          sendResponse({
            ok: false,
            kind: 'error',
            detail: `pairing crashed: ${err instanceof Error ? err.message : String(err)}`,
          } satisfies BridgePairOutcome);
        }
      })();
      return true;
    }
    return undefined;
  });

  // 5. Read pair state. Paired ⇒ start the runtime now. Unpaired ⇒ the
  // side panel's pair form asks the pairing session, which starts the
  // runtime in place when it finishes (`startPairedInPlace`).
  await selectStoredPairCache();
  const bootSnapshot = await inspectState();
  /** The snapshot the running runtime started from, else the boot's. */
  let currentSnapshot: BridgeStateInspection = bootSnapshot;
  /** The running paired runtime; null while unpaired and after `stop()`. */
  let runtime: BridgePairedRuntime | null = null;
  /** A start under way, which a second request joins instead of repeating. */
  let runtimeStarting: Promise<void> | null = null;

  /** The server refused this bridge's sign-in for good (`onSignInRefused`, below): note which
   *  server, stop the runtime, and clear the pairing. `clear` keeps the owner's blocked sites. The
   *  side panel, watching the stored pair, then mounts the pair form, which reads the note and
   *  says why. Before, nothing handled the refusal: the bridge reconnected every ~40 ms, forever,
   *  and behind a proxy that kept every other client of the server out (measured 2026-11-03). */
  const revokeOwnedPair = async (owner: PairOwner): Promise<void> => {
    const conn = owner.conn;
    if (owner.confirmedRevocation || conn === null || conn !== rpcConnForSidePanel
      || !owner.instanceId || isServerConnected?.() !== true) return;
    let closeCode: number | null = null;
    let closed!: (confirmed: boolean) => void;
    const close = new Promise<boolean>(resolve => { closed = resolve; });
    const signal = { owner, closed(code: number) { closeCode = code; closed(code === 4003); } };
    disconnecting = signal;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      const answered = conn.call('pair.revoke', { instance_id: owner.instanceId }).then(() => true, () => false);
      const waited = new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), DISCONNECT_WAIT_MS); });
      const ok = await Promise.race([answered, close, waited]);
      // RPC rejection can precede the fatal-close callback. Only 4003 on
      // this runtime confirms revocation; a 4401 proves no such outcome.
      if (!ok && closeCode === null) {
        await Promise.race([close, new Promise<void>(resolve => { grace = setTimeout(resolve, 1_000); })]);
      }
      owner.confirmedRevocation = ok || closeCode === 4003;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      if (grace !== undefined) clearTimeout(grace);
      if (disconnecting === signal) disconnecting = null;
    }
  };

  const teardownPair = (owner: PairOwner, cause: 'disconnect' | 'refused'): Promise<TeardownResult> => {
    // Claim synchronously, before any await. Keep a successful receipt for
    // this lifetime; a storage failure permits retry without losing proof
    // that the server already confirmed revocation.
    if (owner.teardown !== null) return owner.teardown;
    const task = runPairWork(async (): Promise<TeardownResult> => {
      if (currentPairOwner !== owner) return { told_server: owner.confirmedRevocation };
      pickerSessions.retire();
      if (cause === 'disconnect') await revokeOwnedPair(owner);
      const running = runtime;
      runtime = null;
      await running?.stop().catch(() => undefined);
      const stored = await localStore.inspect();
      const ownsStorage = currentPairOwner === owner && stored.server_url === owner.serverUrl
        && stored.server_public_key === owner.serverKey && stored.webclient_token?.token_id === owner.tokenId
        && (stored.pair_metadata?.instance_id ?? null) === owner.instanceId;
      if (ownsStorage) {
        if (cause === 'refused' || !owner.confirmedRevocation) {
          await refusals.save({ serverUrl: pairFormServerUrl(owner.serverUrl), at: now(),
            ...(cause === 'disconnect' ? { kind: 'disconnected' as const } : {}) }).catch(() => undefined);
        }
        await localStore.clear();
      }
      return { told_server: owner.confirmedRevocation };
    }).catch((error: unknown) => {
      if (owner.teardown === task) owner.teardown = null;
      throw error;
    });
    owner.teardown = task;
    return task;
  };

  const forgetRefusedPairing = async (owner: PairOwner, info: { code: number; reason: string }): Promise<void> => {
    if (currentPairOwner !== owner) return;
    console.warn(`bridge.service-worker-bootstrap: the server refused this bridge's sign-in (close ${String(info.code)}); unpairing it so it can be paired again`);
    await teardownPair(owner, 'refused').catch((error: unknown) => {
      console.warn('bridge.service-worker-bootstrap: clearing the refused pairing failed', error);
    });
  };

  /** The owning runtime supplies both the revoke target and the local
   * clearing identity. Concurrent panels join its operation and receipt. */
  disconnect = () => currentPairOwner === null
    ? Promise.resolve({ told_server: false })
    : teardownPair(currentPairOwner, 'disconnect');

  /** 6–7. Build the WS pipeline from a stored pair and start connecting.
   *  Runs at boot for a paired bridge, and in place right after a pair. */
  const startPaired = async (snapshot: BridgeStateInspection): Promise<void> => {
    const pair = snapshot.local;
    // 6. Build WS pipeline. The envelope router is constructed up front
    // so it's captured in the handlers' onMessage closure; the WsClient
    // forwards inbound frames to it.
    const inflight = new Map<string, { signalled: boolean }>();

    // D-169 P0 Slice 2B — defensive re-narrow + AAD construction. Both
    // callers check `isStoredPaired` first, but TS can't carry that
    // narrowing through the `snapshot.local` read; refer back via `pair`
    // after a throw-on-null check (should be unreachable). The AAD binds the
    // wrapped bearer's ciphertext to the active pair context — swap any
    // of token_id / server_public_key and AEAD verify
    // rejects (Codex P2 #5 fold in the webclient's token-store; same
    // posture here).
    if (
      pair.server_url === null ||
      pair.webclient_token === null ||
      pair.server_public_key === null
    ) {
      throw new Error('bridge.service-worker-entry: paired discriminant failed post-narrow');
    }
    const serverUrl = pair.server_url;
    const serverPublicKey = pair.server_public_key;
    const initialTokenId = pair.webclient_token.token_id;
    const owner: PairOwner = { serverUrl, serverKey: serverPublicKey, tokenId: initialTokenId,
      instanceId: pair.pair_metadata?.instance_id ?? null, conn: null,
      confirmedRevocation: false, teardown: null };
    currentPairOwner = owner;
    const notificationDispatcher = deps.chromeNotifications
      ? createNotificationDispatcher(deps.chromeNotifications, { default_icon_url: deps.defaultNotificationIconUrl },
        route => { if (route.url) { try { void Promise.resolve(deps.openNotificationUrl?.(route.url)).catch(() => {}); } catch { /* Chrome may refuse a tab after shutdown. */ } } }, { server_url: serverUrl }) : null;

    let inboundDispatcher: ((payload: string) => void) | null = null;
    // The conn is built after the WS; wire its loss handler before ws.start().
    let onRpcDisconnected: (() => void) | null = null;
    // Forward-declared so the WsClient's `onConnected` handler can fire
    // the initial capability-profile push. The monitor is constructed
    // after rpcConn (which it pushes through) so the reference is null
    // until the paired-path boot finishes wiring — `onConnected` fires
    // on every (re)connect, so a null monitor on the first connect is
    // harmless (the boot-end synchronous push covers it; subsequent
    // reconnects observe the assigned monitor).
    let capabilityMonitor: BridgeCapabilityProfileMonitor | null = null;
    // D-169 P2 Slice 1 — forward-declared bus-subscription firer. Assigned
    // after `rpcConn` is constructed (it calls `events.subscribe` over the
    // conn); referenced from the WsClient `onConnected` hook so the bridge
    // (re)subscribes on every (re)connect (A.5 reconnect catch-up — no
    // cursor, live-only). Null on a synchronous first-connect (test fakes)
    // is covered by an `isConnected()` check at assignment time.
    let fireBusSubscription: (() => void) | null = null;
    // A pending approval, as an OS notification when this Bridge's Notify switch is on
    // (`approval-notices.ts`). Assigned once the rpc conn exists, below.
    let approvalNotices: ApprovalNotices | null = null;
    const ws = createWsClient({
      url: serverUrl,
      // D-169 P0 Slice 2B — bearer resolver. Re-reads the wrapped record
      // from chrome.storage on every (re)connect attempt + unwraps fresh
      // so plaintext never persists between reconnects + a mid-session
      // rotation (`webclient_token_rotate` broadcast → updated record)
      // is picked up on the next reconnect without a SW restart.
      //
      // Codex 2026-05-27 MAJOR 2 fold — NO fallback to the boot-time
      // snapshot. If chrome.storage returns null after the SW survived
      // a "Clear this bridge" affordance (P1 surfaces this in the side
      // panel), the resolver throws a typed error so the connect loop
      // backs off instead of authenticating with a stale captured
      // bearer. The webclient's analogous `?? pair.token` fallback is
      // safe there because the route-mount path detects unpaired state
      // and remounts the pair form on the same SPA tick; the bridge SW
      // has no equivalent re-mount, so the stale-auth window must close
      // at the resolver. Persistent absence → reconnect backoff floors
      // at 30s; Slice 3's rpc Conn lands the corrupt-state side panel
      // surface so the user-visible signal isn't deferred indefinitely.
      //
      // The structured `${token_id}.${plaintext}` wire shape unlocks the
      // server's rpc-layer gate (matches webclient bootstrap line 689).
      resolveBearer: async (attempt) => {
        const current = await localStore.get('webclient_token');
        if (current === null) {
          // Console.warn provides diagnostic visibility ahead of the
          // P1 side-panel render; one line per failed connect attempt
          // is acceptable noise given the reconnect floor.
          console.warn(
            'bridge.service-worker-bootstrap: webclient_token missing on resolveBearer (post-paired-boot)',
          );
          throw new WebclientTokenCorruptError(
            'webclient_token missing on resolveBearer',
          );
        }
        try {
          // ⚠ NO `server_url` — the AAD is v2 and does not bind the address.
          // Binding it meant a server that MOVED could never be unwrapped again.
          const plaintext = await deps.tokenStore.unwrap(current, {
            token_id: current.token_id,
            server_public_key: serverPublicKey,
          });
          // A successful unwrap can reload a rotated credential for this
          // runtime. Keep its clearing identity current without adopting a
          // different server or instance, which remain pinned in owner.
          if (attempt.isCurrent() && currentPairOwner === owner) {
            owner.tokenId = current.token_id;
            selectIdempotencyForPair({ server_public_key: serverPublicKey, token_id: current.token_id });
          }
          return `${current.token_id}.${plaintext}`;
        } catch (err) {
          // Surface AEAD-verify failures via console.warn for the same
          // reason as above; rethrow so the WsClient's catch backs off.
          console.warn('bridge.service-worker-bootstrap: bearer unwrap failed', err);
          throw err;
        }
      },
      factory: deps.wsTransportFactory,
      handlers: {
        onMessage(payload) {
          inboundDispatcher?.(payload);
        },
        onDisconnected() {
          onRpcDisconnected?.();
        },
        // The server refused this sign-in for good (4003: removed from its devices; 4401: the
        // bearer was rejected). The client has stopped; unpair, so the panel asks to pair again.
        onSignInRefused(info) {
          // The owner's own Disconnect: the server's answer to it, not a refusal.
          if (disconnecting?.owner === owner) {
            disconnecting.closed(info.code);
            return;
          }
          void forgetRefusedPairing(owner, info);
        },
        onConnected() {
          // D-169 P0 — re-push capability profile on every successful
          // (re)connect. Slice 4's eligibility filter consults the
          // server's per-bridge `granted_origins`; without this push the
          // registry would stay on whatever profile the bridge reported
          // at pair time (which today is nothing — the WS-upgrade path
          // doesn't yet thread capabilities through). Fire-and-forget;
          // push errors land in the monitor's onPushError sink.
          void capabilityMonitor?.pushNow();
          // D-169 P2 Slice 1 — (re)subscribe to the broadcast bus on every
          // (re)connect (A.5 reconnect catch-up — live-only, no cursor).
          // Null until the paired-path wiring assigns it; the first real
          // (async) connect lands after the synchronous boot completes, so
          // the assignment is in place by then.
          fireBusSubscription?.();
          // D-169 P2 Slice 2 — re-fetch + re-seed the historical slice on
          // every (re)connect (cursorless re-fetch, spec § A.5). The seeded
          // authoritative base + live bus events combine in the buffer the
          // side-panel `fetch-frames` poll reads.
          void fetchAndSeedHistory?.();
          // D-169 P2 Slice 4 — nudge the side panel to re-read its mode on
          // every (re)connect. This fires AFTER the reconnect (not inline),
          // so on a re-pair to a NEW server it can't race the SW connecting
          // to that server — and it replaces the retired status-tick's
          // re-pair coverage for the per-bridge mode.
          pushBridgeModeInvalidated();
          // The Notify switch may have changed while away: read it again at the next approval.
          approvalNotices?.forgetSwitch();
          // A status the panel asked for while the socket was coming up was
          // answered "connecting"; this is its cue to ask again.
          pushServerConnected();
        },
      },
    });
    // Capture the start-time token_id for diagnostic consumers (the side
    // panel's diagnostic section, later). Not used by the resolver
    // (which always re-reads chrome.storage) but useful for the "what
    // token did we start with" surface.
    void initialTokenId;

    const envelopeRouter = buildEnvelopeRouter({
      ws,
      bridgeVersion: deps.bridgeVersion,
      now,
      executor: deps.actionExecutor,
      grants,
      getIdempotencyCache: () => idempotency,
      queue,
      onQueueReleased: () => activeEnvelopeRouter?.resumeCommands(),
      notificationDispatch: notificationDispatcher
        ? (n) => notificationDispatcher.dispatch(n)
        : () => { throw new Error('OS notifications are unavailable'); },
      notificationPermission: () => deps.chromeNotifications?.getPermissionLevel?.() ?? Promise.resolve('denied'),
      notificationClear: async id => { if (!deps.chromeNotifications) throw new Error('OS notifications are unavailable'); await deps.chromeNotifications.clear(id); },
      inflight,
    });
    activeEnvelopeRouter = envelopeRouter;

    // D-169 P0 Slice 3 — typed rpc conn over the WS. The conn's `send`
    // callback writes the serialised envelope through `ws.send`; the
    // WsClient is synchronous + throws when disconnected, and the conn
    // catches + rejects the matching pending entry with a typed
    // `RpcError('transport', …)` so callers see a coherent failure
    // shape instead of an unhandled throw. The conn does NOT subscribe
    // to the WsClient directly — the bootstrap is the multiplexer that
    // routes inbound frames between the rpc conn + the existing
    // `BridgeWireEnvelope` router (the bridge `WsClient.handlers.onMessage`
    // is a single-slot callback set at construction; widening it to a
    // subscribe-style API would be a larger refactor than Slice 3 needs).
    const rpcConn = createBridgeRpcConn({
      send: (envelope) => {
        ws.send(JSON.stringify(envelope));
      },
    });
    onRpcDisconnected = () => rpcConn.transportDisconnected();
    // D-169 P1 — expose the conn to the side-panel `fetch-status`
    // responder built at step 4. Assigned post-construction so the
    // responder remains a no-op (returns `bridge_not_paired`) until the
    // WS pipeline actually boots.
    rpcConnForSidePanel = rpcConn;
    owner.conn = rpcConn;
    isServerConnected = () => ws.isConnected();
    if (deps.chromeNotifications) {
      approvalNotices = createApprovalNotices({
        notifications: deps.chromeNotifications,
        storage: localStore,
        icon_url: deps.defaultNotificationIconUrl,
        readNotifySwitch: async () =>
          (await rpcConn.call('notifications.my_bridge_mode')).modes?.notification === true,
      });
    }

    // D-169 P2 Slice 1 — broadcast-bus wiring. The subscriber validates
    // each inbound `server_event.event` (kind ∈ BROADCAST_EVENT_KIND_SET)
    // + fans it to the bus buffer — the single accumulator the side-panel
    // `fetch-frames` poll reads. Same dispatcher shape the webclient uses
    // (I-6); a bridge-local replica, not a shared import (see
    // realtime/subscriber.ts for the duplication rationale + follow-on).
    const broadcastSubscriber = createBridgeBroadcastSubscriber();
    broadcastSubscriber.onAny((event) => {
      busBuffer.apply(event);
      // D-169 P2 Slice 4 — a per-bridge mode change isn't a renderable frame
      // (the buffer ignores it), so instead push the side panel to re-read
      // its own mode. Folded into the single accumulator listener (rather
      // than a second `onAny`) so the push can't race the buffer apply.
      if (event.kind === 'notification.bridge_mode_changed') {
        pushBridgeModeInvalidated();
        approvalNotices?.forgetSwitch();
      }
      // A pending approval, as an OS notification; cleared once it closes.
      if (event.kind === 'notification.ask') void approvalNotices?.asked(event);
      if (event.kind === 'notification.ask_closed') void approvalNotices?.closed(event.ask_id);
    });

    inboundDispatcher = buildInboundDispatcher({
      rpcConn,
      envelopeRouter: envelopeRouter.dispatch,
      dispatchServerEvent: (event) => broadcastSubscriber.dispatch(event),
    });

    // D-169 P2 Slice 1 — assign the bus-subscription firer now that the
    // conn exists. Fired from `onConnected` on every (re)connect; also
    // fired once here when the transport is already connected (covers a
    // synchronous-connect test fake whose first `onConnected` ran before
    // this assignment). `events.subscribe` is a filter-set on the server
    // (idempotent), and each reconnect is a fresh WS, so re-firing is
    // safe. Live-only — no `cursor_since`, so the server replays nothing
    // (A.5 / I-7); the historical slice is a follow-on (Slice 2).
    // A server at another version refuses (older) or leaves out (newer) a
    // kind it does not send; either way the rest still subscribe.
    fireBusSubscription = () => {
      void subscribeToKnownKinds(
        (req) => rpcConn.call('events.subscribe', req),
        { kinds: [...BRIDGE_DEFAULT_SUBSCRIPTIONS] },
      )
        .then(({ left_out }) => {
          if (left_out.length === 0) return;
          console.warn(
            `bridge.service-worker-bootstrap: this server does not send ${left_out.join(', ')}`,
          );
        })
        .catch((err) => {
          console.warn(
            'bridge.service-worker-bootstrap: events.subscribe failed',
            err,
          );
        });
    };
    if (ws.isConnected()) fireBusSubscription();

    // D-169 P2 Slice 2 — assign the historical-view seeder now that the conn
    // exists. Fires the three rpcs in parallel and REPLACES the bus buffer's
    // sections with the authoritative recent slice. Best-effort: on ANY rpc
    // failure the seed is skipped (Promise.all rejects → catch), so a
    // transient error leaves the live buffer intact and the next reconnect
    // retries — never wiping live rows with an empty/partial slice. The wire
    // shapes are projected to the side-panel store row shapes the buffer
    // holds: the run-anchor `status` collapses to the section's
    // `ok | error | paused` vocabulary, and `link_url` is dropped (section
    // #3 doesn't render notification links yet).
    fetchAndSeedHistory = async () => {
      // D-169 P2 Slice 2 Codex P2 fold — single-flight generation guard.
      // Three paths fire this (onConnected on every reconnect, the
      // already-connected boot cover, and the side-panel `fetch-history`
      // responder), so concurrent seeds can race. Each call claims a fresh
      // generation; only the newest applies its `seed()` — a slower stale
      // fetch that resolves later sees `gen !== seedGeneration` and drops
      // its result rather than clobbering the newer authoritative slice.
      const gen = ++seedGeneration;
      try {
        const [exec, notif, asks] = await Promise.all([
          rpcConn.call('execution.recent', { limit: BRIDGE_BUS_BUFFER_CAP }),
          rpcConn.call('notification.recent', { limit: BRIDGE_BUS_BUFFER_CAP }),
          rpcConn.call('notification.pending_asks'),
        ]);
        if (gen !== seedGeneration) return; // superseded by a newer seed
        busBuffer.seed({
          recipe_results: exec.executions.map((e) => ({
            run_id: e.run_id,
            recipe_id: e.recipe_id,
            status:
              e.status === 'succeeded'
                ? ('ok' as const)
                : e.status === 'awaiting_approval'
                  ? ('paused' as const)
                  : ('error' as const),
            started_at: e.started_at,
            duration_ms: e.duration_ms,
            ...(e.error_category !== undefined
              ? { error_category: e.error_category }
              : {}),
          })),
          notifications: notif.notifications.map((n) => ({
            id: n.id,
            ...(n.title !== undefined ? { title: n.title } : {}),
            text: n.text,
            fired_at: n.fired_at,
          })),
          approvals: asks.asks.map((a) => ({
            ask_id: a.ask_id,
            ...(a.title !== undefined ? { title: a.title } : {}),
            text: a.text,
            options: a.options.map((o) => ({ id: o.id, label: o.label })),
            created_at: a.created_at,
            // ⛔ AN ENUMERATING COPIER — a field not named here never reaches the
            // Bridge card. `link_url` had been missing since § 234.3 shipped.
            ...(a.link_url !== undefined ? { link_url: a.link_url } : {}),
            ...(a.note_prompt !== undefined ? { note_prompt: a.note_prompt } : {}),
            ...(a.body !== undefined ? { body: a.body } : {}),
            ...(a.resource_review ? { resource_review: a.resource_review } : {}),
          })),
        });
      } catch (err) {
        console.warn(
          'bridge.service-worker-bootstrap: historical-view fetch failed',
          err,
        );
      }
    };
    if (ws.isConnected()) void fetchAndSeedHistory();

    // D-169 P0 — capability profile monitor. Wires `chrome.permissions`
    // onAdded/onRemoved listeners so a fresh grant added during normal
    // browsing re-pushes the bridge's `BridgeCapabilityProfile` to the
    // server (TR-17 — without this, the dispatcher's eligibility filter
    // would stay on the boot-time grants until next pair). Both inputs
    // (the chrome adapter + the static-snapshot accessor) must be wired
    // for the monitor to construct — a profile without `software_version`
    // is malformed by contract, so a partial wiring silently no-ops
    // rather than emitting bogus pushes.
    if (deps.chromePermissions && deps.capabilityProfileSnapshot) {
      const snapshotFn = deps.capabilityProfileSnapshot;
      capabilityMonitor = createBridgeCapabilityProfileMonitor({
        chromePermissions: deps.chromePermissions,
        snapshot: snapshotFn,
        push: async (profile) => {
          await rpcConn.call('bridge.capabilityProfile.push', { profile });
        },
        onPushError: (err) => {
          // One console.warn per failed push. The monitor itself catches
          // + collapses; this sink exists so the bootstrap (which owns
          // logging conventions) does the actual reporting.
          console.warn(
            'bridge.service-worker-bootstrap: capability profile push failed',
            err,
          );
        },
      });
    }

    // 6. Keepalive alarm + start.
    const stopKeepalive = deps.chromeAlarms && deps.chromeRuntimeInfo
      ? installKeepaliveAlarm(
        deps.chromeAlarms,
        deps.chromeRuntimeInfo,
        async () => runKeepaliveTick({ ws, idempotency, now }),
      )
      : undefined;

    // 7. Start the connect loop. The WsClient returns as soon as the
    // loop is scheduled; the actual TCP/TLS handshake races in the
    // background — production tolerates this because the SW persists
    // across the handshake's microtask. Tests await an explicit settling
    // signal via the injected factory.
    await ws.start();
    currentSnapshot = snapshot;
    runtime = {
      ws,
      rpcConn,
      capabilityMonitor,
      async stop() {
        envelopeRouter.stop();
        if (activeEnvelopeRouter === envelopeRouter) activeEnvelopeRouter = null;
        pickerSessions.retire();
        // Retire queued alarm callbacks before they can restart this socket.
        stopKeepalive?.();
        // Stop the capability monitor BEFORE the rpc conn so a
        // chrome.permissions event firing concurrently with teardown
        // doesn't kick off a `pushNow` that races the dispose path.
        capabilityMonitor?.stop();
        // Dispose rpc conn FIRST so any in-flight callers reject with
        // `'transport_disposed'` before the WS shuts down (a teardown
        // that lets pending callers race the WS close would surface
        // `'timeout'` 30s later instead of the prompt typed error).
        rpcConn.dispose();
        for (const cancel of inflight.values()) cancel.signalled = true;
        queue.clear();
        await ws.stop();
        // The responders fall back to their unpaired answers.
        if (rpcConnForSidePanel === rpcConn) {
          rpcConnForSidePanel = null;
          isServerConnected = null;
          fetchAndSeedHistory = null;
        }
      },
    };
  };

  const startPairedOnce = (snapshot: BridgeStateInspection): Promise<void> => {
    if (runtime !== null) return Promise.resolve();
    if (runtimeStarting === null) {
      runtimeStarting = startPaired(snapshot).finally(() => {
        runtimeStarting = null;
      });
    }
    return runtimeStarting;
  };

  /** The pairing session's `onPaired`: start the paired runtime from what
   *  finalize just stored, in this worker. Reloading the extension instead
   *  would close the side panel the user paired from. If the runtime will
   *  not start here, reload anyway: a closed panel over a bridge that boots
   *  paired beats an open one over a bridge that never connects. */
  startPairedInPlace = async (): Promise<void> => {
    try {
      await selectStoredPairCache();
      const snapshot = await inspectState();
      if (!isStoredPaired(snapshot.local)) {
        throw new Error('the stored pair is incomplete');
      }
      await startPairedOnce(snapshot);
    } catch (err) {
      console.warn(
        'bridge.service-worker-bootstrap: the paired runtime did not start in place; reloading the extension',
        err,
      );
      deps.chromeRuntimeReload?.();
    }
  };

  if (isStoredPaired(bootSnapshot.local)) {
    await runPairWork(() => startPairedOnce(bootSnapshot));
  }

  return {
    get paired() {
      return runtime !== null;
    },
    get pairSnapshot() {
      return currentSnapshot;
    },
    get wsClient() {
      return runtime?.ws ?? null;
    },
    get rpcConn() {
      return runtime?.rpcConn ?? null;
    },
    get capabilityMonitor() {
      return runtime?.capabilityMonitor ?? null;
    },
    retirePickerForTab: tab_id => pickerSessions.retireTab(tab_id),
    async stop() {
      pickerSessions.retire();
      diagnosticChanges.stop();
      const running = runtime;
      runtime = null;
      await running?.stop();
    },
  };
};

/** Result envelope kind the bridge writes to the WS for inbound
 *  `command` envelopes. The server's inbound result router matches on
 *  this kind to correlate against the awaiting dispatch slot
 *  (`backend/server/src/bridges/dispatcher.ts` BridgeResultListener). */
export const BRIDGE_RESULT_ENVELOPE_KIND = 'result' as const;

/** Compile-time exhaustivity assertion for the wire envelope union.
 *  Adding a new `BridgeWireEnvelope` variant breaks this line until
 *  the router learns to handle it. */
type _EnsureKindsCovered = Exclude<
  BridgeWireEnvelope['kind'],
  'command' | 'cancel' | 'notification' | 'notification.probe' | 'notification.clear'
>;
const _kindCoverage: _EnsureKindsCovered extends never ? true : false = true;
void _kindCoverage;
