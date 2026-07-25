/** D-125 P4.2 (B3a) — `ws`-backed connector for the `connection.mcp`
 *  websocket transport.
 *
 *  `packages/ingredients/src/connection-mcp.ts` is portable engine code
 *  (public boundary — it can't import the Node-only `ws` package), so it
 *  opens websockets through an injected `WsConnect` capability. This is
 *  the server's implementation: it sets the bearer / custom-auth headers
 *  in the upgrade handshake (D-125 §920 / §339) — something the WHATWG
 *  `WebSocket` global cannot do — and adapts `ws`'s EventEmitter API to
 *  the portable `WsClientHandle`.
 *
 *  SSRF — `followRedirects: false` (the `ws` default, set explicitly +
 *  load-bearing). A user-enrolled MCP endpoint MAY legitimately be a
 *  local / self-hosted host (`ws://localhost:…`) — the product talks to
 *  local servers by design, exactly like `connection.api` (see
 *  `origin-pinned-fetch.ts`: "the product intentionally talks to local
 *  LLMs + self-hosted APIs") — so the INITIAL host is deliberately NOT
 *  blocked. The SSRF surface is a malicious endpoint REDIRECTING the
 *  upgrade to an internal / metadata host; refusing to follow redirects
 *  closes it, mirroring the sse path's origin pinning (`fetchOriginPinned`
 *  pins redirects to the enrolled origin while allowing the local initial
 *  target). Do not flip `followRedirects` to true without re-pinning. */

import { WebSocket } from 'ws';
import type { WsClientHandle, WsConnect } from '@recued/ingredients';

/** Adapt an open `ws` socket to the portable `WsClientHandle`. */
const adaptSocket = (socket: WebSocket): WsClientHandle => ({
  send: (data) => socket.send(data),
  onMessage: (listener) => {
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      // `ws` delivers a single Buffer by default; ArrayBuffer / Buffer[]
      // (fragmented) are handled defensively so the JSON text is intact.
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : raw.toString('utf8');
      listener(text);
    });
  },
  onClose: (listener) => {
    socket.on('close', (code: number, reason: Buffer) => {
      listener({ code, reason: reason?.toString() || undefined });
    });
  },
  onError: (listener) => {
    socket.on('error', (err: Error) => listener(err));
  },
  close: () => {
    try { socket.close(); } catch { /* already closing/closed */ }
  },
});

/** Build the server-side `WsConnect`. One instance is shared by the
 *  executor + watch-poll mcp handlers (both read the same `connectionMcp`
 *  deps at the boot site). Resolves once the socket is OPEN; rejects (with
 *  an `AbortError`-named error on signal abort) otherwise. */
export const createWsConnect = (): WsConnect =>
  (url, opts) =>
    new Promise<WsClientHandle>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, {
          headers: opts.headers,
          // SSRF: never follow a redirect (see file header). The `ws`
          // default is already false; set explicitly so a future edit
          // can't silently reopen the hole.
          followRedirects: false,
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      function onAbort(): void {
        finish(() => {
          try { socket.terminate(); } catch { /* ignore */ }
          const err = new Error('websocket connect aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }

      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      socket.on('open', () => {
        finish(() => resolve(adaptSocket(socket)));
      });
      // Non-101 handshake response (incl. a 3xx we refuse to follow, or
      // a 401 from the auth gate). `ws` emits this instead of 'open'.
      socket.on('unexpected-response', (_req, res: { statusCode?: number }) => {
        finish(() => {
          try { socket.terminate(); } catch { /* ignore */ }
          reject(new Error(`websocket handshake rejected: HTTP ${res.statusCode ?? '?'}`));
        });
      });
      socket.on('error', (err: Error) => {
        finish(() => reject(err));
      });
      // A pre-open close without an 'error' (rare) — reject rather than
      // hang until the caller's connect timeout fires. Harmless after
      // 'open' (settled → no-op); the handler attaches its own 'close'
      // listener via the handle for the post-open lifecycle.
      socket.on('close', (code: number) => {
        finish(() => reject(new Error(`websocket closed before open (code ${code})`)));
      });
    });
