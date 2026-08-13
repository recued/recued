/** D-156 P5 — webclient `passport.fetch` invoker for first-pair.
 *
 *  Backs the success-path persistence in [[pair-code-success]]. After
 *  `/auth/pair` issues the realm bearer, we need `server_public_key` +
 *  `cert_fingerprint` + `cert_expires_at` BEFORE we can wrap the
 *  bearer through `tokenStore.wrap` (the AAD binds the ciphertext to
 *  the pair's identity triple — token_id + server_url +
 *  server_public_key). The WS handshake-and-rpc round-trip is the
 *  only way to learn the server's identity public key on the receive
 *  side; there's no HTTP introspection endpoint that exposes it.
 *
 *  Each call opens a one-shot authenticated WS against `server_url`,
 *  posts a single `{ type: 'rpc', request_id, method:
 *  'passport.fetch', args: undefined }` envelope, awaits the matching
 *  `rpc_result`, and tears the transport down. No ws-client wrap, no
 *  reconnect, no broadcast subscriber — a `passport.fetch` round-trip
 *  is the only thing this connection ever does.
 *
 *  ── Why we don't reuse `WebclientWsClient` ─────────────────────────
 *
 *  Identical rationale to `pair-consume-invoker`: the ws-client queues
 *  a timer-driven reconnect on any open failure. For a one-shot
 *  passport-fetch that's actively wrong — a transport drop should
 *  fail the rpc immediately so the success-path can surface a clear
 *  "couldn't finish pairing" copy + leave the bearer un-wrapped (the
 *  user can retry from the form). The minimal request/response
 *  wiring below is ~70 LOC of straight-line code.
 *
 *  ── Authenticated bearer ───────────────────────────────────────────
 *
 *  Unlike `pair-consume-invoker` (which uses a CSPRNG placeholder
 *  bearer because the consume handler is unauthenticated by
 *  construction), this invoker uses the FRESHLY-ISSUED realm bearer
 *  from `/auth/pair`. The server's `extractRealm` reads it from
 *  `Sec-WebSocket-Protocol`, which this invoker gets for free by going through
 *  the shared transport rather than building its own socket. (It used to ride
 *  `?token=` on the URL; retired — see `@recued/contracts`
 *  `ws-subprotocol.ts`.)
 *
 *  ── Timeout ────────────────────────────────────────────────────────
 *
 *  Default 30s matches `pair-consume-invoker` + `WEBCLIENT_RPC_DEFAULT
 *  _TIMEOUT_MS`. The server's passport-fetch path is fast (one
 *  in-memory provider walk + Ed25519 sign); a 30s budget is generous
 *  + lets the user see a real error rather than spin forever on a
 *  pathological network. */

import type { ServerPassportProjection } from '@recued/contracts';

import type {
  WebclientWsState,
  WebclientWsTransport,
} from '../realtime/ws-client.js';

/** Default per-call timeout. Matches
 *  `PAIR_CONSUME_INVOKER_DEFAULT_TIMEOUT_MS`. */
export const PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS = 30_000;

/** Rpc envelope shapes — mirrors `rpc-conn.ts` shapes without
 *  importing them. The invoker stays self-contained so the rpc layer
 *  can evolve independently. */
interface PassportFetchRpcRequest {
  type: 'rpc';
  request_id: string;
  method: 'passport.fetch';
  // The server handler's args parameter is `void`; we send an empty
  // object for wire compatibility (matches every other void-args rpc
  // the existing rpc-conn module ships).
  args: Record<string, never>;
}

interface PassportFetchRpcResult {
  type: 'rpc_result';
  request_id: string;
  result?: { passport: ServerPassportProjection };
  error?: {
    code: string;
    message: string;
    status?: number;
    details?: Record<string, unknown>;
  };
}

const isRpcResultEnvelope = (m: unknown): m is PassportFetchRpcResult => {
  if (!m || typeof m !== 'object') return false;
  const e = m as { type?: unknown; request_id?: unknown };
  return e.type === 'rpc_result' && typeof e.request_id === 'string';
};

/** Thrown when the server's rpc layer returns a typed error.
 *  Mirrors `PairConsumeRpcError` intentionally — the orchestrator
 *  reads `.code` to differentiate `not_configured` (substrate not
 *  composed) from `forbidden` (bearer not authenticated). */
export class PairPassportRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Signature of the invoker the success-path orchestrator calls. */
export interface PairPassportInvoker {
  (args: {
    server_url: string;
    bearer: string;
  }): Promise<{ passport: ServerPassportProjection }>;
}

export interface PairPassportInvokerOptions {
  /** Builds a fresh transport per call. Production wires a closure
   *  over `createBrowserWebclientTransport`; tests inject a fake. */
  transportFactory: () => WebclientWsTransport;
  /** Override the per-call timeout. Default
   *  `PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS`. */
  timeout_ms?: number;
  /** Override request-id minting (tests). Default uses
   *  `crypto.randomUUID()`. */
  randomId?: () => string;
}

const defaultRandomId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `pair-passport-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

/** Build the production invoker. Each call mints a request_id, opens
 *  a fresh transport against `server_url` (authenticated with the
 *  freshly-issued bearer), wires a one-shot pending promise that
 *  resolves on the matching `rpc_result`, sends the request, awaits
 *  response OR timeout OR transport drop, and closes the transport
 *  in `finally`. */
export const createWebclientPairPassportInvoker = (
  options: PairPassportInvokerOptions,
): PairPassportInvoker => {
  const timeoutMs = options.timeout_ms ?? PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS;
  const mintId = options.randomId ?? defaultRandomId;

  return async ({ server_url, bearer }) => {
    const requestId = mintId();

    let settled = false;
    let resolveOuter!: (response: { passport: ServerPassportProjection }) => void;
    let rejectOuter!: (err: unknown) => void;
    const pending = new Promise<{ passport: ServerPassportProjection }>(
      (resolve, reject) => {
        resolveOuter = resolve;
        rejectOuter = reject;
      },
    );
    // Eager .catch() guard. The timer below may reject `pending`
    // BEFORE the synchronous `try` block reaches `await pending`,
    // which Node's unhandled-rejection tracker would otherwise flag
    // (the rejection lands in the microtask queue before the await
    // attaches its own handler). The no-op `.catch()` marks the
    // rejection as handled at the engine level; the real consumer is
    // the `return await pending` calls below, which still re-extract
    // the rejection through `await`.
    pending.catch(() => undefined);

    // ── Codex 2026-05-28 HIGH #1 fold — timer FIRST, covers the
    //    handshake. ───────────────────────────────────────────────────
    //    Pre-fold the timer armed AFTER `await transport.open()`, so a
    //    stalled handshake (TLS hang, dead TCP, etc.) would never time
    //    out — the timer's `rejectOuter(pending)` call landed but the
    //    function sat on `await transport.open(...)` forever. Symmetric
    //    to the bridge's HIGH #1 fold in
    //    [[apps/bridge/src/popup/pair-passport-invoker]] (commit
    //    `bf7aab2a`). The race below uses a discriminated `HandshakeRaceArm`
    //    to make the winner explicit; `settled` is the single source of
    //    truth across both arms.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectOuter(
        new Error(
          `passport.fetch: server did not respond within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    // `localTransport` is captured outside the try so the `finally`
    // block can always close() it, regardless of which race arm wins.
    // Calling close() on a transport whose open() is still in flight
    // is contract-allowed (the implementation transitions an in-handshake
    // WebSocket to CLOSING). Doing it here keeps the timer-during-
    // handshake path symmetric with the success path — no late .then()
    // dance + no risk of double-close when open() eventually resolves.
    let localTransport: WebclientWsTransport | null = null;
    let detach: (() => void) | null = null;
    let detachState: (() => void) | null = null;
    try {
      // Race the handshake against the timer-rejected pending. The
      // pending arm settles via rejection only here (the resolve side
      // requires the receive listener, which we haven't attached yet);
      // either arm resolving + the loser quietly arriving later is
      // safe because `settled` is the single source of truth.
      localTransport = options.transportFactory();
      const openPromise = localTransport.open({ server_url, bearer });
      // Eager .catch() on openPromise so a rejection that lands BEFORE
      // the race-arm's `.catch` chain attaches isn't flagged as
      // unhandled. The race-arm's `.catch` re-derives a tagged
      // HandshakeRaceArm so the rejection is still observable via the
      // race winner.
      openPromise.catch(() => undefined);
      const arms: Array<Promise<HandshakeRaceArm>> = [
        openPromise
          .then<HandshakeRaceArm>(() => ({ kind: 'open' }))
          .catch<HandshakeRaceArm>((err) => ({ kind: 'open-error', err })),
        pending.then(
          (): HandshakeRaceArm => ({ kind: 'settled' }),
          (): HandshakeRaceArm => ({ kind: 'settled' }),
        ),
      ];
      const winner = await Promise.race(arms);

      if (winner.kind === 'open-error') {
        if (!settled) {
          settled = true;
          rejectOuter(winner.err);
        }
        return await pending;
      }
      if (winner.kind === 'settled') {
        // Timer expired during the handshake. `pending` is already
        // rejected with the timeout error; awaiting it re-throws to
        // the caller. The bearer stays usable for a retry from the
        // form (we never shipped the envelope, so the server hasn't
        // consumed anything). The finally block closes localTransport
        // whether open() eventually resolved or is still pending.
        return await pending;
      }

      // `winner.kind === 'open'` — handshake completed inside the
      // timer budget.
      //
      // Re-check settled. The race resolves on the first arm; the
      // timer arm may have fired immediately after (microtask ordering
      // means both promises can be settled by the time the await
      // unblocks). If the timer won the race-after-the-race, skip the
      // send + tear down through the finally block.
      if (settled) return await pending;

      detach = localTransport.onMessage((message) => {
        // Late inbound frames after the timer fired — drop. The
        // `settled` gate guards against spurious resolveOuter calls
        // that would otherwise race the timer-rejected pending.
        if (settled) return;
        if (!isRpcResultEnvelope(message)) return;
        if (message.request_id !== requestId) return;
        if (message.error) {
          settled = true;
          rejectOuter(
            new PairPassportRpcError(
              message.error.code,
              message.error.message,
              message.error.status,
              message.error.details,
            ),
          );
          return;
        }
        if (message.result === undefined) {
          settled = true;
          rejectOuter(
            new Error(
              `passport.fetch: rpc_result for ${requestId} carried neither result nor error`,
            ),
          );
          return;
        }
        settled = true;
        resolveOuter(message.result);
      });

      // ── Codex 2026-05-28 MEDIUM #9 fold — transport-drop signal. ──
      //    The bridge attaches `onClose` + `onError` to fail the rpc
      //    immediately when a post-handshake WS drop happens (the
      //    alternative is the user waiting the full 30s budget). The
      //    webclient's `WebclientWsTransport` exposes state transitions
      //    via `onState` instead of separate close/error hooks — a
      //    transition to `'closed'` or `'disconnected'` after open()
      //    resolved is the equivalent signal. `'reconnecting'` /
      //    `'reauth_required'` are reconnect intent (the ws-client
      //    layer's concern); this one-shot invoker treats either as a
      //    failed rpc.
      detachState = localTransport.onState((next: WebclientWsState) => {
        if (settled) return;
        if (next === 'closed' || next === 'disconnected') {
          settled = true;
          rejectOuter(
            new Error(
              `passport.fetch: WebSocket transitioned to '${next}' before rpc_result`,
            ),
          );
        }
      });

      // One more `settled` gate before send — the timer or a synchronous
      // state transition may have fired between the `winner.kind ===
      // 'open'` branch above and the listener attaches. Symmetric
      // belt-and-suspenders.
      if (settled) return await pending;

      const envelope: PassportFetchRpcRequest = {
        type: 'rpc',
        request_id: requestId,
        method: 'passport.fetch',
        args: {},
      };
      await localTransport.send(envelope);
      return await pending;
    } finally {
      clearTimeout(timer);
      if (detach) detach();
      if (detachState) detachState();
      if (localTransport) {
        try {
          await localTransport.close();
        } catch {
          /* close() failures don't matter once the rpc has resolved */
        }
      }
    }
  };
};

/** Discriminated race-arm shape — internal to the invoker. Surfaces the
 *  three outcomes of racing `transport.open()` against the timer-
 *  rejected `pending` promise so the orchestrator can branch on the
 *  winner without a tangle of nested awaits. `'open'` carries no payload
 *  because the transport handle lives in the enclosing scope (captured
 *  by the `localTransport` variable so the finally block can clean it
 *  up regardless of which arm wins). */
type HandshakeRaceArm =
  | { kind: 'open' }
  | { kind: 'open-error'; err: unknown }
  | { kind: 'settled' };
