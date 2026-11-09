/** D-169 P1.5 — bridge `passport.fetch` invoker for first-pair.
 *
 *  Backs the post-`/auth/pair` finalize path in [[pair-completion]].
 *  After `/auth/pair` issues the realm bearer, we need
 *  `server_public_key` + `cert_fingerprint` + `cert_expires_at` BEFORE
 *  we can wrap the bearer through `tokenStore.wrap` (the AAD binds the
 *  ciphertext to the pair's identity triple). The WS handshake-and-rpc
 *  round-trip is the only way to learn the server's identity public
 *  key on the receive side; there's no HTTP introspection endpoint.
 *
 *  Each call opens a one-shot authenticated WS against the bridge's
 *  `WsTransportFactory`, posts a single `passport.fetch` rpc envelope,
 *  awaits the matching `rpc_result`, and tears the transport down. No
 *  ws-client wrap, no reconnect, no broadcast subscriber — a
 *  `passport.fetch` round-trip is the only thing this connection ever
 *  does.
 *
 *  ── Why we don't reuse the long-lived `WsClient` ───────────────────
 *
 *  Identical rationale to the webclient's pair-passport-invoker: the
 *  long-lived client queues a timer-driven reconnect on any open
 *  failure. For a one-shot passport-fetch that's actively wrong — a
 *  transport drop should fail the rpc immediately so the pairing
 *  session's finalize surfaces a clear "couldn't finish pairing" outcome
 *  + leaves the bearer un-wrapped (the user retries with "Finish
 *  pairing"). The minimal request/response wiring below is ~100 LOC.
 *
 *  ── Authenticated bearer ───────────────────────────────────────────
 *
 *  The freshly-issued realm bearer from `/auth/pair` rides in the
 *  `Sec-WebSocket-Protocol` slot, like every other authenticated connection —
 *  this invoker gets that for free by going through the shared
 *  `WsTransportFactory` rather than building its own socket. (It used to say
 *  `?token=<encoded>` on the URL; that carrier was retired because a URL is
 *  captured by proxy/access logs and crash reports, and `client_tokens` has no
 *  expiry column.)
 *
 *  ── Timeout covers the handshake (Codex 2026-05-28 HIGH #1 fold) ──
 *
 *  Codex flagged the original port as a no-ship: the bridge's
 *  `WsTransportFactory.open(...)` does NOT resolve until the WS
 *  `open` event lands, whereas the webclient's `WebclientWsTransport`
 *  splits construction (synchronous) from `open()` (async + cancellable).
 *  Awaiting the bridge factory's `open()` BEFORE starting the timer
 *  meant a stalled TLS handshake would never time out — the pair form
 *  would wait on "Pairing…" forever.
 *
 *  The fixed shape:
 *    1. Mint the pending promise + start the timer FIRST.
 *    2. Race the handshake (`wsTransportFactory.open(...)`) against
 *       the timer-rejected `pending` promise.
 *    3. If the timer wins, the `await pending` throws the timeout
 *       error. The eventually-opened transport (if any) leaks — we
 *       cannot cancel a pending `open()` without a contract surface
 *       on the factory; the SW lifetime is finite so the leak
 *       reclaims on the next sw-suspend. Same posture as the
 *       webclient's "do not ship the envelope" branch.
 *    4. If `open()` wins, attach the message listener, re-check
 *       `settled` (the timer may have fired between the race resolve
 *       + the attach), send the envelope, await the response. The
 *       receive listener also re-checks `settled` so a late `open`
 *       resolution after the timer fired never produces a spurious
 *       resolveOuter / rejectOuter call.
 *
 *  Default 30s budget matches the webclient. The server's
 *  passport-fetch path is fast (one in-memory provider walk +
 *  Ed25519 sign); a 30s budget lets the user see a real error rather
 *  than spin forever on a pathological network. */

import type { WsTransport, WsTransportFactory } from '../transport/ws-client.js';
import type { BridgePairPassportInvoker } from './pair-completion.js';

/** Default per-call timeout — 30s, matching the webclient. */
export const BRIDGE_PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS = 30_000;

/** Rpc request envelope shape. */
interface PassportFetchRpcRequest {
  type: 'rpc';
  request_id: string;
  method: 'passport.fetch';
  /** Server handler args is `void`; we send an empty object for wire
   *  compatibility (matches every other void-args rpc the rpc-conn
   *  module ships). */
  args: Record<string, never>;
}

/** Rpc result envelope shape. */
interface PassportFetchRpcResult {
  type: 'rpc_result';
  request_id: string;
  result?: { passport: unknown };
  error?: {
    code: string;
    message: string;
    status?: number;
    details?: Record<string, unknown>;
  };
}

const isRpcResultEnvelope = (
  payload: unknown,
): payload is PassportFetchRpcResult => {
  if (!payload || typeof payload !== 'object') return false;
  const e = payload as { type?: unknown; request_id?: unknown };
  return e.type === 'rpc_result' && typeof e.request_id === 'string';
};

/** Thrown when the server's rpc layer returns a typed error. The
 *  finalize orchestrator wraps the `.message` into the `detail` field
 *  of the `pair_completion_passport_failed` response so the user sees
 *  the underlying code (e.g. `not_configured` when the passport block
 *  provider hasn't composed yet). */
export class BridgePairPassportRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface CreateBridgePairPassportInvokerOptions {
  /** The bridge's production `WsTransportFactory`
   *  (`createBrowserBridgeTransportFactory()`) or a test fake. */
  wsTransportFactory: WsTransportFactory;
  /** Override the per-call timeout. */
  timeout_ms?: number;
  /** Override request-id minting (tests). Defaults to
   *  `crypto.randomUUID()`. */
  randomId?: () => string;
}

const defaultRandomId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `bridge-passport-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e9,
  ).toString(36)}`;
};

/** Discriminated race-arm shape — internal to the invoker. */
type HandshakeRaceArm =
  | { kind: 'open'; transport: WsTransport }
  | { kind: 'open-error'; err: unknown }
  | { kind: 'settled' };

/** Build the production invoker. Each call mints a request_id, opens a
 *  fresh transport against `server_url` (authenticated with the
 *  freshly-issued bearer), wires a one-shot pending promise that
 *  resolves on the matching `rpc_result`, sends the request, awaits
 *  response OR timeout OR transport drop, and closes the transport in
 *  `finally`. */
export const createBridgePairPassportInvoker = (
  options: CreateBridgePairPassportInvokerOptions,
): BridgePairPassportInvoker => {
  const timeoutMs =
    options.timeout_ms ?? BRIDGE_PAIR_PASSPORT_INVOKER_DEFAULT_TIMEOUT_MS;
  const mintId = options.randomId ?? defaultRandomId;

  return async ({ server_url, bearer }) => {
    const requestId = mintId();

    let settled = false;
    let resolveOuter!: (response: { passport: unknown }) => void;
    let rejectOuter!: (err: unknown) => void;
    const pending = new Promise<{ passport: unknown }>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    // Eager .catch() guard — the timer below may reject `pending`
    // BEFORE the synchronous `try` block reaches `await pending`,
    // which Node's unhandled-rejection tracker would otherwise flag.
    // Same pattern as the webclient's analogous invoker.
    pending.catch(() => undefined);

    // ── Timer FIRST — covers the handshake (Codex HIGH #1 fold). ─
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectOuter(
        new Error(
          `passport.fetch: server did not respond within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    let transport: WsTransport | null = null;
    let detach: (() => void) | null = null;
    let detachClose: (() => void) | null = null;
    let detachError: (() => void) | null = null;
    try {
      // Race the handshake against the timer-rejected pending. The
      // pending arm settles via rejection only (the resolve side
      // requires the receive listener, which we haven't attached yet);
      // either arm resolving + the loser quietly arrives later is
      // safe because `settled` is the single source of truth.
      const arms: Array<Promise<HandshakeRaceArm>> = [
        options.wsTransportFactory
          .open({ url: server_url, auth_bearer: bearer })
          .then<HandshakeRaceArm>((t) => ({ kind: 'open', transport: t }))
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
        // the caller. The factory's `open()` may still resolve later
        // — we cannot cancel an in-flight handshake without a
        // contract surface on the factory, so the eventually-opened
        // transport leaks (SW lifetime is finite; the leak reclaims
        // on the next sw-suspend). Best-effort late close: attach a
        // detached `.then` that runs once open settles.
        const leakedOpen = arms[0] as Promise<HandshakeRaceArm>;
        void leakedOpen
          .then((late) => {
            if (late.kind === 'open') {
              try {
                late.transport.close();
              } catch {
                /* ignore — pathological path */
              }
            }
          })
          .catch(() => undefined);
        return await pending;
      }

      // `winner.kind === 'open'` — the handshake completed inside
      // the timer budget. Capture the transport for cleanup.
      transport = winner.transport;

      // Re-check settled. The race resolves on the first arm; the
      // timer arm may have fired immediately after (microtask
      // ordering means both promises can be settled by the time the
      // await unblocks). If the timer won the race-after-the-race,
      // skip the send + tear down through the finally block.
      if (settled) return await pending;

      detach = transport.onMessage((payload) => {
        // Late inbound frames after the timer fired — drop. The
        // `settled` gate guards against spurious resolveOuter calls
        // that would otherwise race the timer-rejected pending.
        if (settled) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return; // not JSON — drop
        }
        if (!isRpcResultEnvelope(parsed)) return;
        if (parsed.request_id !== requestId) return;
        if (parsed.error) {
          settled = true;
          rejectOuter(
            new BridgePairPassportRpcError(
              parsed.error.code,
              parsed.error.message,
              parsed.error.status,
              parsed.error.details,
            ),
          );
          return;
        }
        if (parsed.result === undefined) {
          settled = true;
          rejectOuter(
            new Error(
              `passport.fetch: rpc_result for ${requestId} carried neither result nor error`,
            ),
          );
          return;
        }
        settled = true;
        resolveOuter(parsed.result);
      });

      // Codex 2026-05-28 MEDIUM #9 fold — subscribe to onClose +
      // onError so a post-handshake transport drop fails the rpc
      // immediately instead of letting the user wait the full 30s
      // budget. The bridge's `WsTransport` exposes these alongside
      // `onMessage`; without them, a server that opens the WS then
      // closes before sending `rpc_result` would look like a generic
      // server non-response. We accept the close/error inputs as
      // transport-specific terminations + reject `pending` with a
      // tagged Error so the orchestrator's `pair_completion_passport_
      // failed` detail line carries something diagnosable.
      detachClose = transport.onClose((info) => {
        if (settled) return;
        settled = true;
        rejectOuter(
          new Error(
            `passport.fetch: WebSocket closed before rpc_result (code=${info.code}${info.reason ? ` reason="${info.reason}"` : ''})`,
          ),
        );
      });
      detachError = transport.onError((err) => {
        if (settled) return;
        settled = true;
        rejectOuter(
          new Error(
            `passport.fetch: WebSocket error before rpc_result: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });

      // One more `settled` gate before send — the timer may have
      // fired between the `winner.kind === 'open'` branch above and
      // the listener attach (the detach call is sync but listener
      // registration is sync too). Symmetric belt-and-suspenders.
      if (settled) return await pending;

      const envelope: PassportFetchRpcRequest = {
        type: 'rpc',
        request_id: requestId,
        method: 'passport.fetch',
        args: {},
      };
      transport.send(JSON.stringify(envelope));
      return await pending;
    } finally {
      clearTimeout(timer);
      if (detach) detach();
      if (detachClose) detachClose();
      if (detachError) detachError();
      if (transport) {
        try {
          transport.close();
        } catch {
          // close() failures don't matter once the rpc has resolved
        }
      }
    }
  };
};
