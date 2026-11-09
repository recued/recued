/** D-169 P0 Slice 1 — browser WebSocket → WsTransport adapter.
 *
 *  Production `WsTransportFactory` for the bridge's `WsClient`
 *  (apps/bridge/src/transport/ws-client.ts). Wraps the platform
 *  `WebSocket` constructor against the bridge's `WsTransport`
 *  contract. Tests inject a deterministic constructor; production
 *  reads `globalThis.WebSocket`.
 *
 *  ── Wire format ────────────────────────────────────────────────────
 *
 *  The bearer rides in the SUBPROTOCOL slot as
 *  `['recued.v1', 'bearer.<base64url>']`, because the browser `WebSocket`
 *  constructor doesn't expose the Authorization header and this is the one
 *  header it does reach. `@recued/contracts` `ws-subprotocol.ts` owns the
 *  encoding; the server's `extractRealm` decodes it. Identical to the
 *  webclient, so a future negotiated bump applies uniformly.
 *
 *  ⚠ ORDER IS LOAD-BEARING — `recued.v1` first. `ws` selects the client's first
 *  offered value by default and echoes the selection back in a response header,
 *  so bearer-first would write the secret into the response.
 *
 *  ── Lifecycle ──────────────────────────────────────────────────────
 *
 *  `open()` resolves once the WebSocket reaches `open`; rejects if
 *  `close` or `error` fires before `open`. The returned transport
 *  subscribes via `onMessage` / `onClose` / `onError` AFTER open — the
 *  factory holds an internal listener registry for each so multiple
 *  callers (e.g. the ws-client subscribes for inbound, the SW boot
 *  could subscribe for diagnostics) coexist. Listeners attached after
 *  `open` see future events; events that fired before subscription
 *  are NOT replayed.
 *
 *  One socket per transport instance (matches webclient's DD#7) —
 *  reconnect is the ws-client's responsibility via a fresh `open()`
 *  call; the transport never internally re-opens.
 */

import type { WsTransport, WsTransportFactory } from '../transport/ws-client.js';
import { WS_VERSION_SUBPROTOCOL, encodeBearerSubprotocol } from '@recued/contracts';

/** Subprotocol version marker. Forward-compatible: a future server
 *  can offer a higher version without breaking older bridges. */
export const BRIDGE_WS_SUBPROTOCOL = WS_VERSION_SUBPROTOCOL;

/** Minimal `WebSocket`-shape the factory binds against. Tests inject a
 *  deterministic fake; production uses the platform `WebSocket`. */
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

/** The `WebSocket` constructor shape. */
export type BrowserWebSocketConstructor = new (
  url: string,
  protocols?: string | ReadonlyArray<string>,
) => BrowserWebSocketLike;

export interface BrowserBridgeTransportFactoryOptions {
  /** Override the `WebSocket` constructor — tests inject a fake;
   *  production reads `globalThis.WebSocket`. */
  webSocket?: BrowserWebSocketConstructor;
  /** Override the subprotocol passed to `new WebSocket(url, …)`.
   *  Default `BRIDGE_WS_SUBPROTOCOL`. */
  subprotocol?: string;
  /** Override the URL builder — tests cover edge cases without
   *  depending on the default heuristics. */
  /** ⚠ Takes NO bearer — the secret rides in the subprotocol, not the URL. */
  buildConnectUrl?: (args: { url: string }) => string;
}

/** Default URL builder — the pinned server WS URL, UNCHANGED.
 *
 *  ⛔ CLOSES D-169 F4. This used to append `?token=<bearer>`, and the
 *  document-and-defer note here argued the residual was a deployment-trust
 *  assumption bounded by `wss://` enforcement and a non-terminating cloud. Both
 *  of those hold and neither was the whole problem: a URL is captured by
 *  reverse-proxy and access logs, crash reports and browser telemetry — at the
 *  ENDPOINT, where TLS has already been terminated legitimately — and
 *  `client_tokens` has no expiry column, so anything that leaked stayed valid
 *  until revoked by hand. The bearer now travels in a request header instead.
 *
 *  The builder is kept as a seam (the URL heuristics are tested through it), but
 *  `auth_bearer` is deliberately absent from the argument type so putting a
 *  secret back on the URL is a compile error rather than a decision nobody
 *  reviews. */
export const buildDefaultBridgeConnectUrl = (args: {
  url: string;
}): string => args.url;

/** Build a production browser-WebSocket-backed `WsTransportFactory`. */
export const createBrowserBridgeTransportFactory = (
  options: BrowserBridgeTransportFactoryOptions = {},
): WsTransportFactory => {
  const Ctor =
    options.webSocket ??
    (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket;
  if (!Ctor) {
    throw new Error(
      'bridge.ws-transport-factory: globalThis.WebSocket unavailable — pass options.webSocket',
    );
  }
  const subprotocol = options.subprotocol ?? BRIDGE_WS_SUBPROTOCOL;
  const buildUrl = options.buildConnectUrl ?? buildDefaultBridgeConnectUrl;

  return {
    async open({ url, auth_bearer }) {
      const finalUrl = buildUrl({ url });
      let socket: BrowserWebSocketLike;
      try {
        // `recued.v1` FIRST — see the ordering note in the header.
        socket = new Ctor(finalUrl, [subprotocol, encodeBearerSubprotocol(auth_bearer)]);
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error(`bridge.ws-transport-factory: WebSocket ctor threw — ${String(err)}`);
      }

      // Listener registries — the transport's onMessage/onClose/onError
      // forward to these. Subscribers attach AFTER open resolves.
      const messageListeners = new Set<(payload: string) => void>();
      const closeListeners = new Set<(info: { code: number; reason: string }) => void>();
      const errorListeners = new Set<(err: Error) => void>();

      // Wire socket listeners that fan out to registries. Installed
      // synchronously so the open Promise's settling listeners + the
      // post-open subscriber listeners share one set of socket
      // listeners (no duplicate registration on each subscribe).
      const onSocketMessage = (event: unknown): void => {
        const data = (event as { data?: unknown })?.data;
        if (typeof data !== 'string') return; // binary frames dropped (text wire only)
        for (const l of [...messageListeners]) {
          try {
            l(data);
          } catch {
            // listener errors isolated — ws-client uses the same posture
          }
        }
      };
      const onSocketClose = (event: unknown): void => {
        const e = event as { code?: number; reason?: string } | undefined;
        const info = { code: e?.code ?? 1006, reason: e?.reason ?? '' };
        for (const l of [...closeListeners]) {
          try {
            l(info);
          } catch {
            // ignore
          }
        }
      };
      const onSocketError = (): void => {
        const err = new Error('bridge.ws-transport-factory: WebSocket error event');
        for (const l of [...errorListeners]) {
          try {
            l(err);
          } catch {
            // ignore
          }
        }
      };

      socket.addEventListener('message', onSocketMessage);
      socket.addEventListener('close', onSocketClose);
      socket.addEventListener('error', onSocketError);

      // Wait for `open` event; reject if close/error wins.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        const onOpen = (): void => settle(() => resolve());
        const onPreOpenClose = (event: unknown): void => {
          const code = (event as { code?: number } | undefined)?.code;
          settle(() => {
            // Detach the wire-up listeners — the socket is dead and the
            // caller will never attach subscribers.
            socket.removeEventListener('message', onSocketMessage);
            socket.removeEventListener('close', onSocketClose);
            socket.removeEventListener('error', onSocketError);
            reject(
              new Error(
                `bridge.ws-transport-factory: WS closed before open (code=${code ?? 'unknown'})`,
              ),
            );
          });
        };
        const onPreOpenError = (): void => {
          settle(() => {
            socket.removeEventListener('message', onSocketMessage);
            socket.removeEventListener('close', onSocketClose);
            socket.removeEventListener('error', onSocketError);
            reject(new Error('bridge.ws-transport-factory: WebSocket error before open'));
          });
        };
        socket.addEventListener('open', onOpen);
        socket.addEventListener('close', onPreOpenClose);
        socket.addEventListener('error', onPreOpenError);
      });

      const transport: WsTransport = {
        send(payload) {
          socket.send(payload);
        },
        close(code, reason) {
          try {
            socket.close(code, reason);
          } catch {
            // ignore — repeat close calls or sockets already closed
            // shouldn't crash the SW.
          }
        },
        onMessage(handler) {
          messageListeners.add(handler);
          return () => {
            messageListeners.delete(handler);
          };
        },
        onClose(handler) {
          closeListeners.add(handler);
          return () => {
            closeListeners.delete(handler);
          };
        },
        onError(handler) {
          errorListeners.add(handler);
          return () => {
            errorListeners.delete(handler);
          };
        },
      };

      return transport;
    },
  };
};
