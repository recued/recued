/** D-148 § A.4.2 — webclient typed rpc conn over the WS client.
 *
 *  The `WebclientWsClient` is fire-and-forget (`send(message)` only, no
 *  request/response correlation). Every consumer that needs typed rpc
 *  — `ReceptionPageShellDeps.call`, the future Connections page shell,
 *  every Settings → * route — needs a `Conn<R>` instead. This module
 *  builds that `Conn<R>` over the WS client: generates a fresh
 *  `request_id`, sends the `{ type: 'rpc', request_id, method, args }`
 *  envelope through the ws-client, registers a pending entry for the
 *  reply, and resolves / rejects when the matching
 *  `{ type: 'rpc_result', request_id, result|error }` lands via the
 *  ws-client's `onMessage` subscription.
 *
 *  ── Why this lives in apps/webclient, not packages/contracts ───────
 *  The pending-map primitive (`createPendingMap`) is in contracts —
 *  every transport reuses it. The WS-specific wiring (id minting,
 *  send-then-await pairing with the ws-client's queue, message
 *  filtering on `type === 'rpc_result'`, reauth-aware send) is
 *  webclient-shaped because it depends on `WebclientWsClient` +
 *  `WebclientReauthRequiredError`. A future bridge / server-runner
 *  conn can build its own equivalent over its own transport.
 *
 *  ── Send queue + reauth ─────────────────────────────────────────────
 *  `WebclientWsClient.send` already queues outbound while disconnected
 *  + drains on `connected` (Codex P2 #2 in `ws-client.ts`); we let it.
 *  When the user rotates a bearer + the client re-enters
 *  `reauth_required`, the ws-client clears its queue + throws
 *  `WebclientReauthRequiredError` on subsequent sends. We mirror that
 *  in the rpc layer: the matching pending entry is rejected with
 *  `RpcError('webclient_reauth_required', …)` so callers see a typed
 *  failure code rather than a hung promise.
 *
 *  ── Request id minting ──────────────────────────────────────────────
 *  Default `randomId` uses `crypto.randomUUID()` when available — every
 *  browser the webclient targets has it. Tests inject a deterministic
 *  sequence so the assertions can match exact ids.
 *
 *  ── Timeouts ───────────────────────────────────────────────────────
 *  `default_timeout_ms` (30s) applies when the caller passes no
 *  `RpcCallOptions.timeout`. Per-call `signal` aborts pre-empt the
 *  timeout. A timeout / abort rejects the caller's promise + drops the
 *  pending entry; a late-arriving response is dropped silently (the
 *  pending map's `delete` already cleared the timer, so no leak).
 *
 *  ── In-flight limit ────────────────────────────────────────────────
 *  The server runs at most `RPC_WS_MAX_IN_FLIGHT_PER_CLIENT` (64) calls per
 *  socket and refuses the next with `rpc_overloaded` before running it. A
 *  Settings page load alone sends more (88 in a live load), and a refused one showed the
 *  owner the server's raw "Too many RPC calls are already running" text. So
 *  the conn hands at most that many to the socket and holds the rest, in call
 *  order, until one settles. A refusal can still come (the server's limit
 *  across all clients, or a server with a lower limit). The call did not
 *  run, so it is sent again after a short wait, until its own timeout. Calls
 *  sent on a socket that has since been replaced no longer count: the server
 *  dropped them with that socket.
 *
 *  ── Lifecycle ──────────────────────────────────────────────────────
 *  `dispose()` rejects every in-flight pending entry with
 *  `'transport_disposed'`, then detaches the ws-client message
 *  subscription. Idempotent.
 *
 *  Spec: D-148 § A.4.2 + § A.4.4 (lifecycle). */

import {
  RPC_WS_MAX_IN_FLIGHT_PER_CLIENT,
  RpcError,
  createPendingMap,
  type Conn,
  type PendingEntry,
  type PendingMap,
  type RpcCallOptions,
  type RpcRegistry,
  type ServerRpcRegistry,
} from '@recued/contracts';

import {
  WebclientReauthRequiredError,
  WebclientNotConnectedError,
  type WebclientWsClient,
} from './ws-client.js';
import type { WebclientConnectionStatusController } from './connection-status.js';

/** Default per-call timeout when `RpcCallOptions.timeout` is omitted.
 *  Same magnitude as the bridge's rpc — long enough for a CRM page
 *  read to round-trip, short enough that a hung server doesn't park
 *  the caller forever. */
export const WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS = 30_000;

/** How long the webclient waits for a recipe run (`execute`).
 *
 *  ⛔ A run is not a page read. One AI step alone can take 20–40 s, so the 30 s
 *  default gave up on runs that went on to finish: the month-end drive
 *  (2026-09-24) saw its AI steps reported as timed out while the server
 *  completed them. The learning panel met the same loss at exactly 30 s and
 *  settled on 3 minutes (`LEARNING_DRAFT_RPC_TIMEOUT_MS`). A run can hold several
 *  such steps, hence 5.
 *
 *  ⚠ Still BOUNDED, and waiting longer never parks the page on a server that
 *  is gone: a dropped connection fails a waiting call at once
 *  (`failPendingOffline`), and the Run button says "Running..." throughout. */
export const WEBCLIENT_RUN_RPC_TIMEOUT_MS = 300_000;

/** How long a call the server refused `rpc_overloaded` waits before it is
 *  sent again. Doubles with each refusal, up to
 *  {@link WEBCLIENT_RPC_OVERLOAD_RETRY_MAX_MS}; the call's own timeout still
 *  bounds the whole wait. */
export const WEBCLIENT_RPC_OVERLOAD_RETRY_INITIAL_MS = 250;
export const WEBCLIENT_RPC_OVERLOAD_RETRY_MAX_MS = 4_000;

/** Outbound rpc envelope shape — mirrors the backend `ws-server.ts`
 *  contract (`Extension → Server: { type: 'rpc', request_id, method,
 *  args? }`). Exported for tests + future transports that need to
 *  recognise it. */
export interface WebclientRpcRequestEnvelope {
  type: 'rpc';
  request_id: string;
  method: string;
  args: Record<string, unknown>;
}

/** Inbound rpc envelope shape — mirrors the backend reply
 *  (`Server → Extension: { type: 'rpc_result', request_id,
 *  result|error }`). The `error` shape carries `{ code, message,
 *  status?, details? }` — the same fields `RpcError` projects. */
export interface WebclientRpcResultEnvelope {
  type: 'rpc_result';
  request_id: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    status?: number;
    details?: Record<string, unknown>;
  };
}

interface WebclientRpcConnOptions {
  ws: WebclientWsClient;
  /** These methods must neither queue offline nor reappear after a connected
   * send fails. Their callers resolve uncertain delivery through receipts. */
  nonReplayMethods?: ReadonlySet<string>;
  /** Optional connection-status seam (`realtime/connection-status.ts`).
   *  When supplied the conn fails calls fast instead of parking on the
   *  30s per-call timeout while the paired server is unusable. A NEW call
   *  rejects immediately when the status is:
   *    - `offline` (socket down) → `server_offline` (never sent, safe to
   *      retry), and
   *    - `stalled` (socket up but the server stopped answering — a
   *      half-open restart) → `server_unresponsive` ("isn't responding").
   *  Any call already pending / queued is rejected the instant the status
   *  crosses to `offline` — with `server_offline` if it was still queued
   *  (safe to retry) or `connection_lost` if it had already been dispatched
   *  (its outcome is unknown; a non-idempotent write must not blind-retry).
   *  A `stalled` crossing does NOT sweep pending calls: the socket is up so
   *  their frames are already out — they ride to a late reply (if the server
   *  un-stalls) or their own timeout. A brief `reconnecting` blip (a server
   *  restart, a flaky hop) is NOT failed — the controller's grace window
   *  rides it out, the ws-client's queue drains on reconnect, and the call
   *  proceeds. Omitting this seam preserves the legacy queue-and-30s-timeout
   *  behaviour verbatim. */
  connectionStatus?: Pick<
    WebclientConnectionStatusController,
    'status' | 'onStatus'
  >;
  /** Override the per-call default timeout (tests; long-haul recipes). */
  default_timeout_ms?: number;
  /** Override how many calls may be out on the socket at once (tests).
   *  Defaults to the server's per-socket limit,
   *  {@link RPC_WS_MAX_IN_FLIGHT_PER_CLIENT}. */
  max_in_flight?: number;
  /** Override request-id minting (tests). Default uses
   *  `crypto.randomUUID()`. */
  randomId?: () => string;
}

export interface WebclientRpcConn<R extends RpcRegistry = ServerRpcRegistry> {
  call: Conn<R>;
  /** Reject every in-flight caller + detach the message listener.
   *  Idempotent. */
  dispose(): void;
  /** Snapshot of pending entries — diagnostics + tests. */
  pendingCount(): number;
}

interface WebclientPending extends PendingEntry {
  method: string;
  /** The request id — carried on the entry so the offline-fail sweep can
   *  `pending.delete(id)` (clears the timer) before rejecting, without a
   *  `keys()` on the pending map. */
  id: string;
  /** Delivery disposition — whether this envelope has (or may have) been
   *  handed to the transport. Seeded synchronously from `ws.state() ===
   *  'connected'` at the `ws.send` call (race-free: `ws.send` reads the same
   *  `cur_state` with no intervening code; conservative — a connected-then-
   *  mid-send-drop re-queues but stays flagged `sent`). Then PROMOTED to
   *  `true` for every still-pending entry on each `connected` transition,
   *  because the ws-client drains its offline queue to the transport then —
   *  so a call queued while disconnected becomes in-doubt the moment it can
   *  be drained, not safe-to-retry. Drives the offline sweep's code choice:
   *  never-delivered → `server_offline` (safe to retry), delivered-or-in-
   *  doubt → `connection_lost` (outcome unknown). Read only while
   *  `stage === 'out'`. */
  sent: boolean;
  /** `out`: handed to the ws-client. `waiting`: held for a free slot.
   *  `refused`: the server refused it `rpc_overloaded` and it waits to be sent
   *  again. Only an `out` call can have run. */
  stage: 'out' | 'waiting' | 'refused';
  /** The socket whose slot an `out` call holds, counted in `connected`
   *  transitions: the current one when it went straight to the transport, the
   *  next one when it went into the ws-client's offline queue. */
  slot: number;
  /** How many times the server refused it `rpc_overloaded`. */
  refusals: number;
  envelope: WebclientRpcRequestEnvelope;
}

const defaultRandomId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  // Last-resort fallback — Date-prefixed counter. Real production
  // browsers always have crypto.randomUUID; this branch exists for the
  // vitest node env when a test forgets to inject `randomId`.
  return `rpc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

const isRpcResultEnvelope = (message: unknown): message is WebclientRpcResultEnvelope => {
  if (!message || typeof message !== 'object') return false;
  const m = message as { type?: unknown; request_id?: unknown };
  return m.type === 'rpc_result' && typeof m.request_id === 'string';
};

const buildRpcErrorFromEnvelope = (
  err: WebclientRpcResultEnvelope['error'],
  method: string,
): RpcError => {
  if (!err) return new RpcError('rpc_unknown', 'rpc reply carried no error envelope', undefined, method);
  return new RpcError(
    err.code,
    err.message,
    err.status,
    method,
    err.details,
  );
};

/** Build a typed `Conn<R>` over a `WebclientWsClient`. The conn owns:
 *
 *  - request_id correlation (`createPendingMap`),
 *  - timeout enforcement (`RpcCallOptions.timeout` || default),
 *  - `AbortSignal` plumbing,
 *  - reauth-aware error mapping (`WebclientReauthRequiredError` →
 *    `RpcError('webclient_reauth_required', …)`),
 *  - lifecycle teardown (`dispose` rejects in-flight callers). */
export const createWebclientRpcConn = <R extends RpcRegistry = ServerRpcRegistry>(
  options: WebclientRpcConnOptions,
): WebclientRpcConn<R> => {
  const defaultTimeoutMs =
    options.default_timeout_ms ?? WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS;
  const mintId = options.randomId ?? defaultRandomId;
  const maxInFlight = Math.max(1, options.max_in_flight ?? RPC_WS_MAX_IN_FLIGHT_PER_CLIENT);
  const pending: PendingMap<WebclientPending> = createPendingMap<WebclientPending>();
  let disposed = false;
  /** `connected` transitions so far — names the socket a call went out on. */
  let sockets = 0;
  /** Whether `sockets` already counts the socket the ws-client is on. */
  let counted = false;
  /** The socket a call handed over now reaches: the current one while
   *  connected, else the next. ⚠ Read on every hand-over, not only in the
   *  state listener below: a listener that runs before ours on a `connected`
   *  transition (the connection-status controller re-arming subscriptions)
   *  sends calls onto the new socket before we hear of it, and counting those
   *  against the old one let 70 calls out at once. */
  const socketNow = (): number => {
    if (options.ws.state() !== 'connected') {
      counted = false;
      return sockets + 1;
    }
    if (!counted) {
      sockets += 1;
      counted = true;
    }
    return sockets;
  };

  const sendFailure = (err: unknown, method: string): RpcError => {
    if (err instanceof WebclientNotConnectedError) {
      return new RpcError('server_offline', err.message, undefined, method);
    }
    if (err instanceof WebclientReauthRequiredError) {
      return new RpcError(
        'webclient_reauth_required',
        err.message,
        undefined,
        method,
      );
    }
    return new RpcError(
      'transport',
      err instanceof Error ? err.message : String(err),
      undefined,
      method,
    );
  };

  // Hand a call to the ws-client and take a slot on the socket it will reach.
  const handOff = (entry: WebclientPending): void => {
    // Capture delivery disposition synchronously, BEFORE `ws.send`:
    // `connected` now → the envelope dispatches to the transport;
    // otherwise it lands in the ws-client's offline queue and reaches the
    // NEXT socket. Read here so it matches exactly what `ws.send` sees (no
    // await in between), and so the offline sweep can pick an honest error
    // code per entry.
    entry.stage = 'out';
    entry.sent = options.ws.state() === 'connected';
    entry.slot = socketNow();
    // ws-client.send already queues while disconnected + drains on
    // `connected`. A reauth-blocked send throws
    // `WebclientReauthRequiredError`; we catch + reject the pending
    // entry with a typed `RpcError` so callers can switch on
    // `code === 'webclient_reauth_required'`.
    const dispatch = options.nonReplayMethods?.has(entry.method)
      ? options.ws.send(entry.envelope, { queue: false })
      : options.ws.send(entry.envelope);
    void dispatch.catch((err: unknown) => {
      if (pending.get(entry.id) !== entry) return; // already settled (timeout / abort raced)
      pending.delete(entry.id);
      entry.reject(sendFailure(err, entry.method));
      pump();
    });
  };

  // Send waiting calls, oldest first, while the socket they would reach has
  // a free slot.
  const pump = (): void => {
    const slot = socketNow();
    let out = 0;
    for (const entry of pending.values()) {
      if (entry.stage === 'out' && entry.slot === slot) out += 1;
    }
    for (const entry of pending.values()) {
      if (out >= maxInFlight) return;
      if (entry.stage !== 'waiting') continue;
      handOff(entry);
      out += 1;
    }
  };

  // Subscribe to inbound rpc_result envelopes. Other message kinds
  // (broadcast bus events handled by the subscriber, etc.) flow through
  // untouched — the subscriber + this conn coexist on the same
  // ws-client.onMessage stream because they filter on disjoint
  // `type` / `kind` fields.
  const detach = options.ws.onMessage((message) => {
    if (!isRpcResultEnvelope(message)) return;
    const entry = pending.get(message.request_id);
    if (!entry) return; // late reply (timed out / aborted) — drop silently
    if (message.error?.code === 'rpc_overloaded' && entry.stage === 'out') {
      // The server refused it before running it, so sending it again is safe
      // for any method, a write included. It waits, then takes its turn in
      // call order, ahead of calls made after it.
      // A call settled meanwhile (timeout, abort, offline, dispose) has left
      // the map, so `pump` never sends it.
      entry.stage = 'refused';
      entry.refusals += 1;
      setTimeout(() => {
        entry.stage = 'waiting';
        pump();
      }, Math.min(
        WEBCLIENT_RPC_OVERLOAD_RETRY_MAX_MS,
        WEBCLIENT_RPC_OVERLOAD_RETRY_INITIAL_MS * 2 ** (entry.refusals - 1),
      ));
      pump();
      return;
    }
    pending.delete(message.request_id); // clears the timer
    if (message.error) {
      entry.reject(buildRpcErrorFromEnvelope(message.error, entry.method));
    } else {
      entry.resolve(message.result);
    }
    pump();
  });

  // A new socket has no calls running on the server, so calls that went out
  // on the old one hold none of its slots: let waiting calls go.
  const detachSockets = options.ws.onState(() => {
    pump();
  });

  // Fail every in-flight + queued caller the instant the connection
  // status crosses to `offline`. Without this a call that was queued
  // during a `reconnecting` blip that turned into a real outage would
  // sit on its 30s per-call timeout; here it rejects at the grace
  // boundary (~6s).
  //
  // The error code is HONEST about delivery, because conflating the two
  // cases under one code would tell a write caller a possibly-committed
  // write was never sent (Codex HIGH):
  //   - `sent === false` — the envelope is still in the ws-client's
  //     offline queue, definitely never transmitted → `server_offline`.
  //     Safe to retry. We then drop the matching queued frames via
  //     `clearSendQueue` so they don't re-fire on the eventual reconnect.
  //   - `sent === true` — the envelope was handed to the socket before
  //     the drop; the server MAY have processed it and the reply was
  //     lost with the connection → `connection_lost`. Outcome unknown;
  //     the caller must not blind-retry a non-idempotent write.
  //   - not `out` — still waiting for a slot, or refused `rpc_overloaded`
  //     and waiting to be sent again: it did not run → `server_offline`.
  const failPendingOffline = (): void => {
    const stranded = [...pending.values()];
    if (stranded.length === 0) return;
    for (const entry of stranded) {
      pending.delete(entry.id); // clears the timer + removes from the map
      entry.reject(
        entry.stage === 'out' && entry.sent
          ? new RpcError(
              'connection_lost',
              `webclient rpc: connection lost — '${entry.method}' was sent but its reply was lost; its outcome is unknown`,
              undefined,
              entry.method,
            )
          : new RpcError(
              'server_offline',
              `webclient rpc: server offline — '${entry.method}' was not delivered`,
              undefined,
              entry.method,
            ),
      );
    }
    options.ws.clearSendQueue();
  };
  // Promote every still-pending entry to `sent` on a `connected` transition.
  // A call queued while disconnected (stamped `sent:false`) is drained to the
  // transport by the ws-client's `drainOutbound` on exactly this transition —
  // so by the time we're `connected` it may have been delivered. Marking it
  // in-doubt here keeps a LATER offline sweep from calling a possibly-
  // committed write "not delivered" (Codex HIGH, 2nd pass). The connection-
  // status controller emits `connected` 1:1 with the ws `connected`
  // transitions that drive the drain, so this fires exactly when a drain can
  // happen. Entries dispatched while already connected are `sent:true`
  // already; this only upgrades the queued ones — a queued call that goes
  // straight to `offline` WITHOUT an intervening `connected` is never drained
  // and correctly stays `server_offline`.
  const markPendingDelivered = (): void => {
    for (const entry of pending.values()) entry.sent = true;
  };
  const detachStatus =
    options.connectionStatus?.onStatus((status) => {
      if (status === 'offline') {
        failPendingOffline();
        return;
      }
      if (status === 'connected') markPendingDelivered();
    }) ?? null;

  const call = ((method: string, payload?: unknown, opts?: RpcCallOptions): Promise<unknown> => {
    if (disposed) {
      return Promise.reject(
        new RpcError('transport_disposed', 'webclient rpc conn is disposed', undefined, method),
      );
    }
    // Fast-fail a NEW call against an unusable server instead of queueing
    // it for the 30s timeout. A brief `reconnecting` blip is neither
    // `offline` nor `stalled` (the controller's grace window rides it out),
    // so this only trips on a sustained socket-down (`offline`) or a
    // half-open stalled server. The codes differ so the user sees the right
    // copy: "Can't reach…" for offline vs "isn't responding" for stalled.
    const connState = options.connectionStatus?.status();
    if (connState === 'offline') {
      return Promise.reject(
        new RpcError(
          'server_offline',
          `webclient rpc: server offline — '${method}' not sent`,
          undefined,
          method,
        ),
      );
    }
    if (connState === 'stalled') {
      return Promise.reject(
        new RpcError(
          'server_unresponsive',
          `webclient rpc: server not responding — '${method}' not sent`,
          undefined,
          method,
        ),
      );
    }
    const args = (payload as Record<string, unknown> | undefined) ?? {};
    const requestId = mintId();
    const timeoutMs = opts?.timeout ?? defaultTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        pending.delete(requestId);
      };

      // Honest about delivery: a call that never got out, or that the server
      // only ever refused, did not run.
      const timedOut = (entry: WebclientPending | undefined): RpcError => {
        if (entry !== undefined && entry.stage !== 'out' && entry.refusals > 0) {
          return new RpcError(
            'rpc_overloaded',
            `webclient rpc: the server was too busy to run '${method}' within ${timeoutMs}ms; it did not run`,
            undefined,
            method,
          );
        }
        if (entry !== undefined && entry.stage === 'waiting') {
          return new RpcError(
            'timeout',
            `webclient rpc: '${method}' waited ${timeoutMs}ms for a free call slot and was not sent`,
            undefined,
            method,
          );
        }
        return new RpcError(
          'timeout',
          `webclient rpc: method '${method}' did not respond within ${timeoutMs}ms`,
          undefined,
          method,
        );
      };

      const onTimeout = (): void => {
        const entry = pending.get(requestId);
        cleanup();
        reject(timedOut(entry));
        pump();
      };
      const timer = setTimeout(onTimeout, timeoutMs);

      const onAbort = (): void => {
        cleanup();
        // Match the bridge's abort behaviour: the `code` matches the
        // standard fetch/AbortController contract.
        reject(
          new RpcError(
            'aborted',
            `webclient rpc: method '${method}' aborted by caller`,
            undefined,
            method,
          ),
        );
        pump();
      };
      if (opts?.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          reject(
            new RpcError(
              'aborted',
              `webclient rpc: method '${method}' aborted before send`,
              undefined,
              method,
            ),
          );
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      pending.set(requestId, {
        method,
        id: requestId,
        sent: false,
        stage: 'waiting',
        slot: 0,
        refusals: 0,
        envelope: {
          type: 'rpc',
          request_id: requestId,
          method,
          args,
        },
        resolve: (value) => {
          if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (err) => {
          if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
          reject(err);
        },
        timeout: timer,
      });
      // Goes out at once when its socket has a free slot (the usual case),
      // else waits its turn behind earlier calls.
      pump();
    });
  }) as unknown as Conn<R>;

  return {
    call,
    pendingCount: () => pending.size(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pending.clear('webclient rpc conn disposed');
      if (detachStatus !== null) detachStatus();
      detachSockets();
      detach();
    },
  };
};
