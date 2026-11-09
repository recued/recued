/** D-148 § A.3.3 — WS connection lifecycle.
 *
 *  The bridge holds a single WS to the user's server. Lifecycle:
 *
 *    connect → authenticated → idle
 *           ← reconnect (exponential backoff, 1s → 2s → 4s → ... → 30s cap)
 *           ✕ the server refused this sign-in (close 4003 / 4401): no reconnect
 *
 *  ⛔ A CONNECTION THE SERVER NEVER SPOKE ON IS A FAILED ATTEMPT, NOT A DROPPED
 *  SESSION. The backoff resets, and a close reconnects at once, only for a
 *  connection that brought at least one frame from the server. It used to reset
 *  the moment a socket opened, and every close reconnected with no wait at all,
 *  so a server that completes the upgrade and closes without a word (which is
 *  how it refuses a sign-in, since v26.10.24) got a reconnect every ~40 ms,
 *  measured 2026-11-03. Behind a proxy or tunnel, where every client shares one
 *  address, those refusals put the server's per-address cooldown on everyone: a
 *  valid client was refused 19 times in 20. A frame, not time, is the test: a
 *  session the server accepted always hears from it, and one dropped seconds in
 *  should still come straight back.
 *
 *  Reconnect is best-effort. The bridge does not buffer commands
 *  beyond its idempotency cache (24h, IndexedDB). On reconnect, the
 *  bridge replays its idempotency cache so the server can correlate
 *  in-flight commands.
 *
 *  The transport is decoupled from the underlying WebSocket — tests
 *  inject an in-memory transport. The production client wires
 *  `chrome.offscreen` document → `WebSocket` → SW message bus.
 */

export interface WsTransport {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  /** Subscribe to inbound text frames. */
  onMessage(handler: (payload: string) => void): () => void;
  /** Subscribe to disconnect events. Reason is best-effort. */
  onClose(handler: (info: { code: number; reason: string }) => void): () => void;
  /** Subscribe to error events. */
  onError(handler: (err: Error) => void): () => void;
}

export interface WsTransportFactory {
  /** Construct a fresh transport. Returns the transport once the WS
   *  upgrade succeeds (caller awaits). Rejects on handshake failure. */
  open(opts: { url: string; auth_bearer: string }): Promise<WsTransport>;
}

export interface WsClientHandlers {
  /** Fires after every successful (re)connect — caller wires up
   *  re-subscribe + idempotency-cache replay here. */
  onConnected?(transport: WsTransport): void | Promise<void>;
  /** Fires on every disconnect. Reconnect logic is internal; the
   *  caller does not need to retry. */
  onDisconnected?(reason: string): void;
  /** Fires for every text frame from the server. */
  onMessage?(payload: string): void;
  /** The server refused this sign-in for good (a close code in
   *  `refused_close_codes`). Nothing reconnects after it, and `start()` does
   *  nothing more: pairing again builds a new client. */
  onSignInRefused?(info: { code: number; reason: string }): void;
}

/** The server's definite refusals of a sign-in: 4003, the device was revoked
 *  (`pair.revoke` closes its live socket with it), and 4401, the bearer was
 *  rejected at connect. The webclient also re-pairs on 1008 and 4001; the
 *  server sends neither, and a refusal recognised wrongly costs the owner a new
 *  pairing code, while one missed only backs off. */
export const BRIDGE_SIGN_IN_REFUSED_CLOSE_CODES: ReadonlySet<number> = new Set([4003, 4401]);

export interface WsClientOptions {
  /** Server WS endpoint URL. */
  url: string;
  /** D-169 P0 Slice 2B — bearer resolver invoked on every (re)connect
   *  attempt. The bridge wraps its bearer at rest as an AES-GCM
   *  `WebclientTokenRecord`; the resolver unwraps fresh on each call
   *  so plaintext never lives longer than one connect attempt. Returns
   *  the structured `<token_id>.<bearer>` shape the server's
   *  `parseStructuredBearer` expects (matches webclient's
   *  `resolveBearer` posture; see
   *  `apps/webclient/src/webclient-bootstrap.ts:668-690`). */
  resolveBearer: () => Promise<string>;
  factory: WsTransportFactory;
  handlers?: WsClientHandlers;
  /** Initial backoff in ms. Default 1000. */
  initial_backoff_ms?: number;
  /** Max backoff in ms. Default 30_000. */
  max_backoff_ms?: number;
  /** Backoff multiplier. Default 2. */
  backoff_multiplier?: number;
  /** Close codes after which nothing reconnects. Default
   *  {@link BRIDGE_SIGN_IN_REFUSED_CLOSE_CODES}. */
  refused_close_codes?: ReadonlySet<number>;
  /** Time source for tests. */
  now?: () => number;
  /** Sleep helper for tests. Default `setTimeout`-backed. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WsClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** True iff WS is currently open. */
  isConnected(): boolean;
  /** Current backoff in ms — useful for tests. */
  currentBackoff(): number;
  /** Reconnect attempt counter — increments on each attempt, resets
   *  on successful connect. */
  attempts(): number;
  /** True once the server refused this sign-in: it will not reconnect. */
  refused(): boolean;
  /** Send a text frame on the active transport. Throws if not
   *  connected. */
  send(payload: string): void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** D-148 § A.3.3 — exponential-backoff WS client.
 *
 *  Pure-logic client; tests inject the transport factory + sleep so
 *  the reconnect loop is fully deterministic. */
export const createWsClient = (options: WsClientOptions): WsClient => {
  const initial = options.initial_backoff_ms ?? DEFAULT_INITIAL_BACKOFF_MS;
  const max = options.max_backoff_ms ?? DEFAULT_MAX_BACKOFF_MS;
  const mult = options.backoff_multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const sleep = options.sleep ?? defaultSleep;
  const refusedCodes = options.refused_close_codes ?? BRIDGE_SIGN_IN_REFUSED_CLOSE_CODES;

  let stopped = false;
  let refused = false;
  let transport: WsTransport | null = null;
  let attempt_count = 0;
  let backoff = initial;
  let connect_loop_p: Promise<void> | null = null;
  /** Whether the server has sent a frame on the current connection. */
  let spoke = false;

  /** Wait the current backoff, then grow it: what a failed attempt costs. */
  const backOff = async (): Promise<void> => {
    await sleep(backoff);
    backoff = Math.min(backoff * mult, max);
  };

  const wireTransport = (next: WsTransport): void => {
    transport = next;
    spoke = false;
    next.onMessage((payload) => {
      spoke = true;
      options.handlers?.onMessage?.(payload);
    });
    next.onError(() => {
      // Errors are handled implicitly via subsequent close.
    });
    next.onClose((info) => {
      transport = null;
      options.handlers?.onDisconnected?.(info.reason || `code=${info.code}`);
      if (stopped) return;
      if (refusedCodes.has(info.code)) {
        refused = true;
        stopped = true;
        connect_loop_p = null;
        options.handlers?.onSignInRefused?.({ code: info.code, reason: info.reason });
        return;
      }
      if (spoke) {
        // A session the server accepted dropped: reconnect at once, from the start.
        backoff = initial;
        connect_loop_p = connectLoop();
      } else {
        // The server closed it without a word: that attempt failed.
        connect_loop_p = backOff().then(() => connectLoop());
      }
    });
  };

  const connectLoop = async (): Promise<void> => {
    while (!stopped) {
      attempt_count++;
      try {
        // D-169 P0 Slice 2B — unwrap-fresh-on-every-connect. Bearer
        // resolution failures fall into the same backoff loop as
        // network errors so a transient store / WebCrypto hiccup
        // doesn't crash the SW; persistent failures surface to the
        // user via the side panel's connection status.
        const bearer = await options.resolveBearer();
        const next = await options.factory.open({
          url: options.url,
          auth_bearer: bearer,
        });
        wireTransport(next);
        // The backoff is NOT reset here: only a connection the server spoke
        // on earns that (see the header).
        attempt_count = 0;
        await options.handlers?.onConnected?.(next);
        return;
      } catch {
        // Sleep for current backoff then increase, capping at max.
        await backOff();
      }
    }
  };

  return {
    async start() {
      // A refused sign-in stays refused: the keepalive nudges `start()` every
      // 30 s, and it must not bring the refusals back.
      if (refused || connect_loop_p) return;
      stopped = false;
      backoff = initial;
      attempt_count = 0;
      connect_loop_p = connectLoop();
      // Don't await — start returns as soon as the loop is scheduled.
      // Caller can await the connect via `onConnected` handler.
    },
    async stop() {
      stopped = true;
      if (transport) {
        try {
          transport.close(1000, 'bridge: shutdown');
        } catch {
          // ignore
        }
      }
      transport = null;
      connect_loop_p = null;
    },
    isConnected() {
      return transport !== null;
    },
    currentBackoff() {
      return backoff;
    },
    attempts() {
      return attempt_count;
    },
    refused() {
      return refused;
    },
    send(payload) {
      if (!transport) {
        throw new Error('bridge.ws-client: send called while disconnected');
      }
      transport.send(payload);
    },
  };
};
