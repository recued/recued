/** D-148 § A.4.2 + § A.4.4 — production browser WebSocket transport.
 *
 *  The factory wired into `bootstrapWebclient({ transport })` in
 *  production. Adapts a real browser `WebSocket` to the
 *  `WebclientWsTransport` contract the WS client owns. Until this
 *  module landed, `webclient-bootstrap.ts` DD#1 left the transport as
 *  a SEAM that tests filled with an in-memory loopback; this is its
 *  production counterpart.
 *
 *  ── Wire format ────────────────────────────────────────────────────
 *
 *  The server URL pinned at pair time is the full `wss://<host>/ws`
 *  endpoint (see `packages/contracts/src/webclient.ts`
 *  `WebclientLocalStorage.server_url` example). The transport adds the
 *  bearer to the URL via the `?token=<bearer>` query parameter — the
 *  one mechanism that works from a browser `WebSocket` constructor
 *  (the `Authorization` header isn't reachable from
 *  `new WebSocket(url, protocols)`). The server's `extractRealm`
 *  already accepts the same form (`backend/server/src/ws-server.ts`
 *  line 1499-1516), so the wire is symmetric without a server-side
 *  change.
 *
 *  The subprotocol slot carries `recued.v1` as a version marker —
 *  forward-compatible: a future server can negotiate a different
 *  subprotocol without breaking older clients.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Auth via query string, not subprotocol-encoded bearer. We
 *  considered packing the bearer into the `Sec-WebSocket-Protocol`
 *  field (`['recued.v1', 'bearer.<base64url>']`) so the secret never
 *  appears in URL-level access logs, but that needs a paired
 *  server-side change (the server currently only reads from
 *  `Authorization` + `?token=`). Until that ships, query string is
 *  the only browser-reachable path. The bearer ciphertext at rest is
 *  AES-GCM-wrapped (`storage/token-store.ts`); plaintext leakage risk
 *  is bounded by the TLS pin + the short bearer lifetime + the
 *  webclient's own audit trail.
 *
 *  DD#2 — Pre-upgrade 401 surfaces as a generic transport drop, NOT
 *  a `WebclientReauthRequiredError`. A browser `WebSocket` cannot
 *  distinguish HTTP 401 from other handshake failures: every
 *  pre-upgrade failure manifests as a `close` event with code 1006
 *  + an immediately-preceding `error` event. We treat all pre-upgrade
 *  failures as transient transport errors; the ws-client's
 *  exponential backoff handles them. Post-upgrade close codes ARE
 *  inspectable, so a `4001` (server-not-enrolled) or `4401`
 *  (bearer-rejected) close maps to `WebclientReauthRequiredError`
 *  via the `WEBCLIENT_AUTH_CLOSE_CODES` set below. A future server
 *  patch that synthesises a `register_error` typed reply before close
 *  could improve fidelity, but the close-code path is enough.
 *
 *  DD#3 — `open()` resolves only once the WS reaches the `open` event
 *  (not on `connecting`). The internal `state` listener fires
 *  'connecting' as soon as the `WebSocket` constructor returns so the
 *  ws-client can transition through state correctly; the promise stays
 *  pending until either:
 *    - `open` fires → state 'connected' → resolve
 *    - `close` fires before `open` → reject (reauth-mapped if applicable)
 *    - `error` fires before `open` → reject if no close yet (the close
 *      will follow but we surface the failure immediately so the
 *      ws-client's retry loop can advance).
 *
 *  DD#4 — `send()` JSON-stringifies the message. The ws-client always
 *  passes plain JS objects (`{ type: 'rpc', request_id, method, args }`
 *  or `{ type: 'subscribe', … }`), never binary, so a plain
 *  `JSON.stringify` is the correct encoder. A non-serialisable payload
 *  (cycles, BigInt) is a caller bug — we let the `TypeError` propagate
 *  so it shows up in tests rather than failing silently on the wire.
 *
 *  DD#5 — `onMessage` JSON-parses inbound text frames. Binary frames
 *  (Blob / ArrayBuffer) are dropped — the wire is text JSON in both
 *  directions per spec. A frame whose JSON fails to parse is dropped
 *  with no listener notification; the ws-client only ever inspects
 *  parsed envelopes (`type`, `kind`), and a malformed frame is
 *  indistinguishable from a server bug we can't reason about.
 *
 *  DD#6 — `close()` is idempotent + sync from the caller's perspective
 *  but the underlying socket's `close` event arrives asynchronously.
 *  We resolve the promise immediately after invoking `WebSocket.close(…)`
 *  so the ws-client's lifecycle doesn't park waiting for the OS-level
 *  TCP close. The state listener fires 'disconnected' on the actual
 *  close event, after the resolution.
 *
 *  DD#7 — One socket per transport instance. Reconnect creates a new
 *  socket; the ws-client orchestrates that. We do NOT internally
 *  re-open after a close — that would duplicate the ws-client's
 *  backoff loop. The transport only knows "currently open / not".
 *
 *  Spec: D-148 § A.4 + the WS-server contract in
 *  `backend/server/src/ws-server.ts`. */

import {
  WebclientReauthRequiredError,
  type WebclientWsState,
  type WebclientWsTransport,
} from './ws-client.js';

/** Subprotocol version marker. Forward-compatible: a future server
 *  can offer a higher version without breaking older clients. */
export const WEBCLIENT_WS_SUBPROTOCOL = 'recued.v1' as const;

/** Post-upgrade close codes that map to `WebclientReauthRequiredError`.
 *  4001 = server-not-enrolled (existing convention in
 *  `backend/server/src/ws-server.ts`); 4003 = `instance_revoked` (closed
 *  by `pair.revoke` or by `revokeAllConnectedInstances` after a
 *  `server_identity_key` rotation — bearer is no longer valid, client
 *  must re-pair); 4401 reserved for an explicit "bearer rejected"
 *  close. 1008 (policy violation) is the standard RFC code for auth
 *  failures and is included for forward-compatibility with
 *  intermediaries that map 401 → 1008.
 *
 *  D-156 P9 added 4003 here. Pre-P9 the rotation flow emitted a
 *  `pair_required` broadcast BEFORE the WS close so the webclient's
 *  banner handler ran while the socket was still alive; P9 retired
 *  that broadcast (spec § Q2 resolution), so the close-code path is
 *  now the sole reauth signal for rotation-driven revocation. Without
 *  4003 in this set the ws-client would treat the close as a generic
 *  disconnect, loop reconnect against the revoked bearer, and never
 *  surface the `onReauthRequired` funnel that drives the pair-form
 *  remount in `webclient-main.recoverFromReauthRequired`. */
export const WEBCLIENT_AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([
  1008, // RFC 6455 policy violation — covers server-side auth rejection
  4001, // recued: server not enrolled
  4003, // recued: instance_revoked — pair.revoke or identity-rotation fanout
  4401, // recued: bearer rejected (reserved)
]);

/** Minimal `WebSocket`-shape the transport binds against. Tests inject
 *  a deterministic fake; production wires the platform `WebSocket`. */
export interface BrowserWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
}

/** The `WebSocket` constructor shape — first arg is the URL, second is
 *  the subprotocol(s). The default factory uses the platform
 *  `globalThis.WebSocket`; tests inject a deterministic constructor. */
export type BrowserWebSocketConstructor = new (
  url: string,
  protocols?: string | ReadonlyArray<string>,
) => BrowserWebSocketLike;

export interface BrowserWebclientTransportOptions {
  /** Override the `WebSocket` constructor — tests inject a fake;
   *  production reads `globalThis.WebSocket`. */
  webSocket?: BrowserWebSocketConstructor;
  /** Override the subprotocol passed to `new WebSocket(url, …)`.
   *  Default `WEBCLIENT_WS_SUBPROTOCOL`. */
  subprotocol?: string;
  /** Override the URL builder — tests cover edge cases (server URL
   *  already has `?`, server URL missing `/ws`, …) without depending
   *  on the default heuristics. */
  buildConnectUrl?: (args: { server_url: string; bearer: string }) => string;
}

/** Default URL builder. Appends `?token=<bearer>` (URL-encoded) to the
 *  pinned `server_url`, preserving an existing query string if the
 *  server URL already has one. Exported for tests. */
export const buildDefaultConnectUrl = (args: {
  server_url: string;
  bearer: string;
}): string => {
  const separator = args.server_url.includes('?') ? '&' : '?';
  return `${args.server_url}${separator}token=${encodeURIComponent(args.bearer)}`;
};

/** Build a production browser-WebSocket-backed `WebclientWsTransport`.
 *  Each invocation returns a fresh transport whose lifecycle owns one
 *  underlying socket (DD#7); the ws-client's backoff loop creates new
 *  transports as needed via the bootstrap's seam. */
export const createBrowserWebclientTransport = (
  options: BrowserWebclientTransportOptions = {},
): WebclientWsTransport => {
  const Ctor =
    options.webSocket ??
    (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket;
  if (!Ctor) {
    throw new Error(
      'webclient.browser-transport: globalThis.WebSocket unavailable — pass options.webSocket',
    );
  }
  const subprotocol = options.subprotocol ?? WEBCLIENT_WS_SUBPROTOCOL;
  const buildUrl = options.buildConnectUrl ?? buildDefaultConnectUrl;

  // Transport-scoped listener sets. The ws-client re-registers per
  // `connect()` (Codex P3 #5 fold in `ws-client.ts`), so we do NOT
  // permanently retain listeners across the transport's lifetime; the
  // ws-client owns that contract.
  const messageListeners = new Set<(message: unknown) => void>();
  const stateListeners = new Set<(state: WebclientWsState) => void>();

  let socket: BrowserWebSocketLike | null = null;
  let cur_state: WebclientWsState = 'disconnected';
  // Detachers for the listeners we registered on the active socket.
  // Tracked so `close()` cleans up even if the socket never fires its
  // own close event in time.
  let detachers: Array<() => void> = [];
  // Codex P2 fold — sticky reauth flag. Set when a post-open close
  // arrives with an auth code; the very next `open()` call rejects
  // with `WebclientReauthRequiredError` so the ws-client routes the
  // failure through its `open()`-rejection reauth path (the only path
  // that halts the reconnect loop — see `ws-client.ts` line 196-204
  // + line 240-251). Cleared after one open()-rejection so a
  // subsequent `applyRotatedBearer()` + reconnect can succeed.
  let pendingReauthReason: string | null = null;

  const setState = (next: WebclientWsState): void => {
    if (cur_state === next) return;
    cur_state = next;
    for (const l of [...stateListeners]) {
      try {
        l(cur_state);
      } catch {
        // Listener errors isolated — same pattern as ws-client.ts.
      }
    }
  };

  const detachAll = (): void => {
    for (const d of detachers) d();
    detachers = [];
  };

  // Codex P2 #3 — close code handling. A post-upgrade close in an
  // auth code maps to a reauth error so the ws-client can transition
  // to `reauth_required` instead of looping reconnects.
  const isAuthCloseCode = (code: number | undefined): boolean =>
    code !== undefined && WEBCLIENT_AUTH_CLOSE_CODES.has(code);

  return {
    onMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    async open({ server_url, bearer }) {
      // Refuse a second concurrent open on the same transport — the
      // ws-client should have closed the previous socket first.
      if (socket) {
        throw new Error(
          'webclient.browser-transport: open() called while a socket is already attached',
        );
      }
      // Codex P2 fold — drain the sticky reauth flag set by a prior
      // post-open auth close so the ws-client's `open()`-rejection
      // path receives the typed error + halts the reconnect loop.
      if (pendingReauthReason !== null) {
        const reason = pendingReauthReason;
        pendingReauthReason = null;
        throw new WebclientReauthRequiredError(reason);
      }
      setState('connecting');

      const url = buildUrl({ server_url, bearer });
      let ws: BrowserWebSocketLike;
      try {
        ws = new Ctor(url, subprotocol);
      } catch (err) {
        setState('disconnected');
        throw err instanceof Error
          ? err
          : new Error(`webclient.browser-transport: WebSocket ctor threw — ${String(err)}`);
      }
      socket = ws;

      // DD#3 — the open promise resolves on `open` event OR rejects on
      // `close`/`error` before `open`. We track which event won.
      return new Promise<void>((resolve, reject) => {
        let settled = false;

        const settleResolve = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const settleReject = (err: Error): void => {
          if (settled) return;
          settled = true;
          // DD#7 — drop the socket reference + listeners so subsequent
          // open() calls work + idle listeners don't keep this WS alive.
          socket = null;
          detachAll();
          setState('disconnected');
          reject(err);
        };

        const onOpen = (): void => {
          setState('connected');
          settleResolve();
        };

        const onClose = (event: unknown): void => {
          const e = event as { code?: number; reason?: string } | undefined;
          const code = e?.code;
          if (!settled) {
            // Close before open — never made it through the upgrade.
            // DD#2: a pre-upgrade auth failure is indistinguishable
            // from a network drop; the ws-client retries with backoff.
            // The exception is a post-handshake close that arrives in
            // the same tick — we still inspect the code so a synthetic
            // close after `open` would map correctly. (Browsers
            // currently won't deliver `close` before `open` for a
            // successful upgrade, but the inspection is cheap.)
            if (isAuthCloseCode(code)) {
              settleReject(
                new WebclientReauthRequiredError(
                  `bearer rejected on connect (close ${code})`,
                ),
              );
              return;
            }
            settleReject(
              new Error(
                `webclient.browser-transport: WS closed before open (code=${code ?? 'unknown'})`,
              ),
            );
            return;
          }
          // Post-open close — propagate to the ws-client via state.
          socket = null;
          detachAll();
          if (isAuthCloseCode(code)) {
            // Codex P2 fold — defer the reauth signal to the next
            // `open()` call. The ws-client's `onState` handler only
            // knows 'connected' / 'connecting' specifically; every
            // other state (including a direct 'reauth_required' from
            // the transport) falls through to `queueReconnect()` and
            // spins. Routing through `open()` rejection (the path the
            // ws-client already wires to `WebclientReauthRequiredError`,
            // see `ws-client.ts` line 196-204 + line 240-251) is what
            // actually halts the reconnect loop + clears the queued
            // sends per spec § A.4.4 line 569.
            pendingReauthReason = `bearer rejected post-open (close ${code})`;
          }
          setState('disconnected');
        };

        const onError = (): void => {
          if (settled) return;
          // DD#3 — error before open is reported immediately so the
          // ws-client doesn't park forever; the paired `close` event
          // arrives next and is dropped by `settled === true`.
          settleReject(
            new Error('webclient.browser-transport: WS error before open'),
          );
        };

        const onMessage = (event: unknown): void => {
          const data = (event as { data?: unknown } | undefined)?.data;
          if (typeof data !== 'string') {
            // DD#5 — drop non-text frames. The wire is text JSON.
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            // DD#5 — drop unparseable frames. A typed envelope failure
            // is more informative than silently delivering garbage.
            return;
          }
          for (const l of [...messageListeners]) {
            try {
              l(parsed);
            } catch {
              // Listener errors isolated.
            }
          }
        };

        ws.addEventListener('open', onOpen);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', onError);
        ws.addEventListener('message', onMessage);

        detachers = [
          () => ws.removeEventListener('open', onOpen),
          () => ws.removeEventListener('close', onClose),
          () => ws.removeEventListener('error', onError),
          () => ws.removeEventListener('message', onMessage),
        ];
      });
    },
    async close() {
      // DD#6 — idempotent. The socket's actual close event will fire
      // asynchronously; we resolve immediately so the ws-client's
      // disconnect path doesn't block on the OS-level close.
      const ws = socket;
      if (!ws) {
        // Already closed (or never opened) — keep state stable.
        return;
      }
      socket = null;
      try {
        ws.close(1000, 'webclient: orderly shutdown');
      } catch {
        // Swallow — the socket may already be closing.
      }
      detachAll();
      setState('disconnected');
    },
    async send(message) {
      const ws = socket;
      if (!ws) {
        throw new Error(
          'webclient.browser-transport: send() called while disconnected',
        );
      }
      // DD#4 — JSON.stringify here so the wire is text. A
      // non-serialisable payload throws synchronously into the caller.
      ws.send(JSON.stringify(message));
    },
    clearAuthBlock() {
      // Codex P1 fold — called by `ws-client.applyRotatedBearer()` so a
      // freshly-persisted bearer isn't blocked by the OLD WS's auth-
      // close-deferred reauth signal. The sticky-flag defense is
      // correct when no fresh bearer is available; rotation flips that
      // assumption, so the rotation handler tells us to drop it.
      pendingReauthReason = null;
    },
  };
};
