/** D-169 P0 Slice 3 — bridge typed rpc conn over the SW WS client.
 *
 *  Mirrors `apps/webclient/src/realtime/rpc-conn.ts` (D-148 § A.4.2 +
 *  § A.4.4) so the bridge speaks the same `Conn<ServerRpcRegistry>`
 *  surface the webclient does — same envelope shape, same
 *  request_id correlation, same `RpcError` taxonomy. The shared
 *  protocol is the invariant the side panel can mount the same
 *  ui-shared primitives against (D-169 I-6 / I-12).
 *
 *  ── Why bridge-local instead of a shared package ─────────────────
 *  The pending-map primitive (`createPendingMap`) is in
 *  `@recued/contracts`. The transport-specific wiring (request_id
 *  minting, dispatch-by-discriminator, abort handling) is bridge-
 *  shaped because the bridge `WsClient` differs from the webclient
 *  `WebclientWsClient`:
 *    - bridge `WsClient.send(payload: string)` is synchronous +
 *      throws when disconnected (no offline queue);
 *    - bridge `WsClient.handlers.onMessage(payload: string)` is a
 *      single-slot callback set at construction — there is no
 *      `onMessage(listener)` subscribe API the way the webclient
 *      exposes; the bridge SW's bootstrap is the multiplexer that
 *      routes inbound frames between the rpc conn + the existing
 *      `BridgeWireEnvelope` router.
 *  Both deltas push us to a slightly different conn API:
 *    - `dispatchInbound(message)` so the bootstrap (not the conn)
 *      owns the WS subscription + the parse-once dispatch;
 *    - `send(envelope)` is supplied by the caller as a callback that
 *      writes the serialised envelope to the bridge WsClient.
 *  Otherwise the shapes — pending map, RpcError mapping, timeout +
 *  abort handling, idempotent dispose — are deliberately identical
 *  to the webclient's conn so the wire protocol stays in lockstep.
 *
 *  Spec: D-169 § N.2 / A.4 / Test requirements "rpc
 *  identity (P0)".
 */

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

/** Default per-call timeout when `RpcCallOptions.timeout` is omitted.
 *  Same magnitude as the webclient's rpc + the server-side WS rpc
 *  timeout — long enough for a memory / mail-fetch round-trip, short
 *  enough that a hung server doesn't park a side-panel mount forever. */
export const BRIDGE_RPC_DEFAULT_TIMEOUT_MS = 30_000;

/** Outbound rpc envelope shape — mirrors the backend `ws-server.ts`
 *  contract (`Extension → Server: { type: 'rpc', request_id, method,
 *  args? }`) byte-for-byte with the webclient's
 *  `WebclientRpcRequestEnvelope`. Same wire frame; the server doesn't
 *  branch on `client_kind` at parse time. */
export interface BridgeRpcRequestEnvelope {
  type: 'rpc';
  request_id: string;
  method: string;
  args: Record<string, unknown>;
}

/** Inbound rpc envelope shape — mirrors the backend reply
 *  (`Server → Extension: { type: 'rpc_result', request_id,
 *  result|error }`). Identical to the webclient's
 *  `WebclientRpcResultEnvelope`. */
export interface BridgeRpcResultEnvelope {
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

export interface BridgeRpcConnOptions {
  /** Outbound send callback. The bootstrap supplies this as
   *  `(envelope) => ws.send(JSON.stringify(envelope))` against the
   *  bridge `WsClient`. The conn delegates the serialisation +
   *  connect-state check to the caller; a throw here surfaces as a
   *  typed `RpcError('transport', …)` on the in-flight caller. */
  send(envelope: BridgeRpcRequestEnvelope): void;
  /** Override the per-call default timeout (tests; long-haul recipes). */
  default_timeout_ms?: number;
  /** Override request-id minting (tests). Default uses
   *  `crypto.randomUUID()` with a Date-prefixed fallback for
   *  non-crypto runtimes (e.g. vitest node env when a test forgets
   *  to inject `randomId`). */
  randomId?: () => string;
}

export interface BridgeRpcConn<R extends RpcRegistry = ServerRpcRegistry> {
  /** Typed rpc call surface — `Conn<R>` from `@recued/contracts`. */
  call: Conn<R>;
  /** Bootstrap dispatches `{ type: 'rpc_result', … }` frames here.
   *  Non-rpc-result shapes are ignored, so the bootstrap can safely
   *  fan every inbound frame through this method when its discriminator
   *  is uncertain. A late reply (timed out / aborted) is dropped
   *  silently — the pending map's `delete` already cleared the timer,
   *  so no leak. */
  dispatchInbound(message: unknown): void;
  /** Reject every in-flight caller. Idempotent. Bootstrap calls this
   *  from `stop()` so a teardown doesn't strand callers waiting on
   *  replies that will never arrive. */
  dispose(): void;
  /** Snapshot of pending entries — diagnostics + tests. */
  pendingCount(): number;
}

interface BridgePending extends PendingEntry {
  method: string;
  /** Stored so `dispose()` can iterate `pending.values()` + delete by
   *  id without re-deriving the key. Codex 2026-05-27 MAJOR (Angle 2)
   *  fold — `pending.clear(reason)` uses `new Error(reason)`, which
   *  loses the typed `RpcError('transport_disposed', …)` code that
   *  callers switch on; iterating manually keeps the typed error. */
  request_id: string;
}

const defaultRandomId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  // Last-resort fallback — Date-prefixed counter. Real production SW
  // runtimes always have crypto.randomUUID; this branch exists for
  // the vitest node env when a test forgets to inject `randomId`.
  return `rpc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

const isRpcResultEnvelope = (message: unknown): message is BridgeRpcResultEnvelope => {
  if (!message || typeof message !== 'object') return false;
  const m = message as { type?: unknown; request_id?: unknown };
  return m.type === 'rpc_result' && typeof m.request_id === 'string';
};

const buildRpcErrorFromEnvelope = (
  err: BridgeRpcResultEnvelope['error'],
  method: string,
): RpcError => {
  if (!err) {
    return new RpcError(
      'rpc_unknown',
      'rpc reply carried no error envelope',
      undefined,
      method,
    );
  }
  // Codex 2026-05-27 MINOR (Angle 7) fold — defend against a
  // malformed `error` envelope (missing / non-string `code` or
  // `message`). The wire shape is well-defined but a server-side
  // serialisation bug could land us here; collapsing to a typed
  // `rpc_unknown` keeps callers' switch-on-code branches well-defined.
  if (typeof err.code !== 'string' || typeof err.message !== 'string') {
    return new RpcError(
      'rpc_unknown',
      'rpc reply carried malformed error envelope',
      undefined,
      method,
    );
  }
  return new RpcError(err.code, err.message, err.status, method, err.details);
};

/** Build a typed `Conn<R>` over the bridge `WsClient`. The conn owns:
 *
 *  - request_id correlation (`createPendingMap`),
 *  - timeout enforcement (`RpcCallOptions.timeout` || default),
 *  - `AbortSignal` plumbing (pre-aborted + mid-flight),
 *  - send-throw → `RpcError('transport', …)` mapping (bridge WsClient
 *    throws synchronously when disconnected; the conn surfaces this
 *    as a typed failure rather than an unhandled exception),
 *  - idempotent lifecycle teardown (`dispose` rejects in-flight
 *    callers with `'transport_disposed'`). */
export const createBridgeRpcConn = <R extends RpcRegistry = ServerRpcRegistry>(
  options: BridgeRpcConnOptions,
): BridgeRpcConn<R> => {
  const defaultTimeoutMs =
    options.default_timeout_ms ?? BRIDGE_RPC_DEFAULT_TIMEOUT_MS;
  const mintId = options.randomId ?? defaultRandomId;
  const pending: PendingMap<BridgePending> = createPendingMap<BridgePending>();
  let disposed = false;

  const dispatchInbound = (message: unknown): void => {
    if (!isRpcResultEnvelope(message)) return;
    const entry = pending.get(message.request_id);
    if (!entry) return; // late reply (timed out / aborted) — drop silently
    pending.delete(message.request_id); // clears the timer
    if (message.error) {
      entry.reject(buildRpcErrorFromEnvelope(message.error, entry.method));
      return;
    }
    entry.resolve(message.result);
  };

  const call = ((method: string, payload?: unknown, opts?: RpcCallOptions): Promise<unknown> => {
    if (disposed) {
      return Promise.reject(
        new RpcError('transport_disposed', 'bridge rpc conn is disposed', undefined, method),
      );
    }
    const args = (payload as Record<string, unknown> | undefined) ?? {};
    const requestId = mintId();
    const timeoutMs = opts?.timeout ?? defaultTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      // Settle the pending entry through its wrapped reject so the
      // abort listener (if any) is removed centrally — Codex 2026-05-27
      // MAJOR (Angle 2) fold. Previously the onTimeout path called the
      // raw `reject(...)` directly, leaving the `'abort'` listener
      // attached to the user-supplied AbortSignal even after the call
      // settled; over a long-lived SW lifetime that leaks listeners
      // proportional to the rpc-call count.
      const settleReject = (err: RpcError): void => {
        const entry = pending.get(requestId);
        if (!entry) return; // already settled (resolve / abort race)
        pending.delete(requestId);
        entry.reject(err);
      };

      const onTimeout = (): void => {
        settleReject(
          new RpcError(
            'timeout',
            `bridge rpc: method '${method}' did not respond within ${timeoutMs}ms`,
            undefined,
            method,
          ),
        );
      };
      const timer = setTimeout(onTimeout, timeoutMs);

      const onAbort = (): void => {
        settleReject(
          new RpcError(
            'aborted',
            `bridge rpc: method '${method}' aborted by caller`,
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
              `bridge rpc: method '${method}' aborted before send`,
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
        request_id: requestId,
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

      const envelope: BridgeRpcRequestEnvelope = {
        type: 'rpc',
        request_id: requestId,
        method,
        args,
      };
      // The bridge WsClient's `send` is synchronous + throws when
      // disconnected (it has no offline queue, unlike the webclient
      // which queues + drains on `connected`). Catch + reject the
      // matching pending entry so callers see a typed `RpcError`
      // rather than an unhandled exception bubbling out of the
      // promise constructor's synchronous body. The pending entry was
      // already inserted above, so any concurrent `dispatchInbound`
      // / timeout / abort that races the catch sees a consistent map.
      try {
        options.send(envelope);
      } catch (err) {
        const entry = pending.get(requestId);
        if (!entry) return; // already cleaned up (timeout / abort raced)
        pending.delete(requestId);
        entry.reject(
          new RpcError(
            'transport',
            err instanceof Error ? err.message : String(err),
            undefined,
            method,
          ),
        );
      }
    });
  }) as unknown as Conn<R>;

  return {
    call,
    dispatchInbound,
    pendingCount: () => pending.size(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Codex 2026-05-27 MAJOR (Angle 2) fold — iterate pending entries
      // and reject each via the entry's wrapped reject. `pending.clear`
      // uses `new Error(reason)`, which destroys the typed code that
      // callers documentation-ally switch on (this module's JSDoc
      // promises `'transport_disposed'`). Iterating manually preserves
      // the typed code AND the abort-listener removal in the entry's
      // reject wrapper. The spread copy guards against the wrapped
      // reject mutating `pending` mid-iteration via `pending.delete`.
      for (const entry of [...pending.values()]) {
        pending.delete(entry.request_id); // clears the timer
        entry.reject(
          new RpcError(
            'transport_disposed',
            'bridge rpc conn is disposed',
            undefined,
            entry.method,
          ),
        );
      }
    },
  };
};
