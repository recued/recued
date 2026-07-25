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
 *  ── Lifecycle ──────────────────────────────────────────────────────
 *  `dispose()` rejects every in-flight pending entry with
 *  `'transport_disposed'`, then detaches the ws-client message
 *  subscription. Idempotent.
 *
 *  Spec: D-148 § A.4.2 + § A.4.4 (lifecycle). */

import {
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
  type WebclientWsClient,
} from './ws-client.js';
import type { WebclientConnectionStatusController } from './connection-status.js';

/** Default per-call timeout when `RpcCallOptions.timeout` is omitted.
 *  Same magnitude as the bridge's rpc — long enough for a CRM page
 *  read to round-trip, short enough that a hung server doesn't park
 *  the caller forever. */
export const WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS = 30_000;

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
   *  doubt → `connection_lost` (outcome unknown). */
  sent: boolean;
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
  const pending: PendingMap<WebclientPending> = createPendingMap<WebclientPending>();
  let disposed = false;

  // Subscribe to inbound rpc_result envelopes. Other message kinds
  // (broadcast bus events handled by the subscriber, etc.) flow through
  // untouched — the subscriber + this conn coexist on the same
  // ws-client.onMessage stream because they filter on disjoint
  // `type` / `kind` fields.
  const detach = options.ws.onMessage((message) => {
    if (!isRpcResultEnvelope(message)) return;
    const entry = pending.get(message.request_id);
    if (!entry) return; // late reply (timed out / aborted) — drop silently
    pending.delete(message.request_id); // clears the timer
    if (message.error) {
      entry.reject(buildRpcErrorFromEnvelope(message.error, entry.method));
      return;
    }
    entry.resolve(message.result);
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
  const failPendingOffline = (): void => {
    const stranded = [...pending.values()];
    if (stranded.length === 0) return;
    for (const entry of stranded) {
      pending.delete(entry.id); // clears the timer + removes from the map
      entry.reject(
        entry.sent
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

      const onTimeout = (): void => {
        cleanup();
        reject(
          new RpcError(
            'timeout',
            `webclient rpc: method '${method}' did not respond within ${timeoutMs}ms`,
            undefined,
            method,
          ),
        );
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

      // Capture delivery disposition synchronously, BEFORE `ws.send`:
      // `connected` now → the envelope dispatches to the transport;
      // otherwise it lands in the ws-client's offline queue. Read here so
      // it matches exactly what `ws.send` sees (no await in between), and
      // so the offline sweep can pick an honest error code per entry.
      const sent = options.ws.state() === 'connected';
      pending.set(requestId, {
        method,
        id: requestId,
        sent,
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

      const envelope: WebclientRpcRequestEnvelope = {
        type: 'rpc',
        request_id: requestId,
        method,
        args,
      };
      // ws-client.send already queues while disconnected + drains on
      // `connected`. A reauth-blocked send throws
      // `WebclientReauthRequiredError`; we catch + reject the pending
      // entry with a typed `RpcError` so callers can switch on
      // `code === 'webclient_reauth_required'`.
      void options.ws
        .send(envelope)
        .catch((err: unknown) => {
          const entry = pending.get(requestId);
          if (!entry) return; // already cleaned up (timeout / abort raced)
          pending.delete(requestId);
          if (err instanceof WebclientReauthRequiredError) {
            entry.reject(
              new RpcError(
                'webclient_reauth_required',
                err.message,
                undefined,
                method,
              ),
            );
            return;
          }
          entry.reject(
            new RpcError(
              'transport',
              err instanceof Error ? err.message : String(err),
              undefined,
              method,
            ),
          );
        });
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
      detach();
    },
  };
};
