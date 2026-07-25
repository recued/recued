/** D-148 P6 § A.6 — WS port handler.
 *
 *  Wraps the existing WS dispatch (`ws-server.ts`) with the bearer-
 *  required + per-token rate-limit gate. Pre-existing pre-upgrade
 *  realm-token check stays where it is; this handler adds the WS-
 *  port-scoped rate-limit so a misbehaving client doesn't burn
 *  through the rpc dispatcher's scarce I/O budget.
 *
 *  P6 acceptance:
 *    - bearer required → 401 when missing or empty
 *    - rate limit 100 rpc/sec per token → 429 with `Retry-After` set
 *      to the bucket's refill ETA in seconds
 *
 *  This module is the *upgrade-time* gate. Per-rpc rate limit is
 *  enforced by `recordRpc(...)` which the WS dispatcher calls each
 *  time a `rpc` message arrives. The substrate keeps both: the
 *  upgrade gate denies the entire connection when the token is
 *  missing; the per-rpc gate denies individual calls during a
 *  steady-state burst.
 *
 *  Invariant: handlers are pure functions (no closure-captured
 *  network state); the rate limiter is injected so tests substitute
 *  a deterministic time source. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { extractBearerToken } from '../common/bearer.js';
import { writeJson } from '../common/respond.js';
import type { RateLimiter } from '../common/rate-limit.js';

export const WS_RATE_LIMIT_PER_SEC = 100;
export const WS_RATE_LIMIT_WINDOW_MS = 1_000;

/** Verifier for the inbound bearer token. Returns true iff the token
 *  is a valid realm token for this server. The substrate caller
 *  injects the verifier so the same handler can be tested without
 *  the realm store. */
export type WsBearerVerifier = (token: string) => boolean;

export interface WsPortHandlerOptions {
  /** Realm-token validity check. */
  verifier: WsBearerVerifier;
  /** Per-token rate limiter (100 rpc/sec by default). The handler
   *  uses this gate at the upgrade-equivalent path; per-rpc usage is
   *  recorded via the `recordRpc` helper. */
  limiter: RateLimiter;
  /** Forward to the underlying WS upgrade path. Receives the request
   *  + raw socket equivalent. The substrate caller wires this into
   *  the existing `attachWebSocket` flow. */
  upgrade?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** Build the WS port HTTP handler. Per spec § A.6, WS lives behind
 *  HTTP `Upgrade: websocket`; non-upgrade GETs return 426. The
 *  handler also serves the `/health` liveness probe so port-level
 *  health checks don't need an Authorization header. */
export const createWsPortHandler = (
  options: WsPortHandlerOptions,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const { verifier, limiter, upgrade } = options;
  return async (req, res) => {
    const url = req.url ?? '/';
    const [pathname] = url.split('?');

    // Liveness probe stays open per § A.6 + matches the existing
    // server.ts /health surface.
    if (pathname === '/health' && req.method === 'GET') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    // Bearer required for everything else on the WS port.
    const token = extractBearerToken(req);
    if (!token) {
      // Also accept the `?token=<x>` query form per the legacy WS
      // upgrade. Pre-existing extension clients embed it that way.
      const queryToken = parseQueryToken(url);
      if (!queryToken) {
        writeJson(res, 401, {
          error: { code: 'unauthorized', message: 'bearer token required on WS port' },
        });
        return;
      }
      if (!verifier(queryToken)) {
        writeJson(res, 401, {
          error: { code: 'unauthorized', message: 'invalid token' },
        });
        return;
      }
      const decision = limiter.consume(`ws:${queryToken}`);
      if (!decision.allowed) {
        writeJson(
          res,
          429,
          {
            error: { code: 'rate_limited', message: 'WS port rate limit exceeded' },
            retry_after_ms: decision.retry_after_ms,
          },
          { 'retry-after': String(Math.ceil(decision.retry_after_ms / 1000)) },
        );
        return;
      }
      if (upgrade) await upgrade(req, res);
      else writeJson(res, 426, { error: { code: 'upgrade_required', message: 'WS port serves websocket upgrades' } });
      return;
    }

    if (!verifier(token)) {
      writeJson(res, 401, {
        error: { code: 'unauthorized', message: 'invalid token' },
      });
      return;
    }
    const decision = limiter.consume(`ws:${token}`);
    if (!decision.allowed) {
      writeJson(
        res,
        429,
        {
          error: { code: 'rate_limited', message: 'WS port rate limit exceeded' },
          retry_after_ms: decision.retry_after_ms,
        },
        { 'retry-after': String(Math.ceil(decision.retry_after_ms / 1000)) },
      );
      return;
    }
    if (upgrade) await upgrade(req, res);
    else writeJson(res, 426, { error: { code: 'upgrade_required', message: 'WS port serves websocket upgrades' } });
  };
};

/** Per-rpc rate-limit hook. The WS dispatcher calls this on every
 *  inbound `rpc` envelope; over-budget calls return a typed
 *  `rate_limited` error code in the rpc result rather than
 *  destroying the connection. */
export const recordWsRpc = (
  limiter: RateLimiter,
  token: string,
):
  | { allowed: true }
  | { allowed: false; retry_after_ms: number } => {
  const decision = limiter.consume(`ws:${token}`);
  if (decision.allowed) return { allowed: true };
  return { allowed: false, retry_after_ms: decision.retry_after_ms };
};

/** D-148 § A.6 — WebSocket-upgrade gate.
 *
 *  Real WS handshakes arrive on `server.on('upgrade')` with a raw
 *  socket + head buffer (NOT through the request/response pipeline).
 *  The HTTP handler `createWsPortHandler` enforces auth + rate-limit
 *  for plain HTTP probes (e.g. /health), but only the upgrade
 *  callback can authenticate the WS handshake itself.
 *
 *  Codex P1 #1 fold — without this hook, any client trying to
 *  upgrade `/ws` over the new WS port would hang the socket because
 *  the listener set never wires an `upgrade` listener of its own.
 *
 *  The gate verifies the bearer token (header or `?token=` query
 *  per legacy clients), consumes one token from the per-token
 *  bucket, and forwards the upgrade to the supplied callback when
 *  authorized. Auth failures + rate-limit denials respond with a
 *  raw HTTP/1.1 status line + close the socket — the upgrade
 *  request never enters the WebSocket protocol. */
export interface WsUpgradeHandlerOptions {
  verifier: WsBearerVerifier;
  limiter: RateLimiter;
  /** Forward the verified upgrade to the underlying WS server. The
   *  caller wires this to the existing `attachWebSocket` /
   *  `wss.handleUpgrade` plumbing. */
  forward: (req: IncomingMessage, socket: Socket, head: Buffer, token: string) => void;
}

export const createWsUpgradeHandler = (
  options: WsUpgradeHandlerOptions,
): ((req: IncomingMessage, socket: Socket, head: Buffer) => void) => {
  const { verifier, limiter, forward } = options;
  return (req, socket, head) => {
    const url = req.url ?? '/';
    const [pathname] = url.split('?');
    if (!pathname.startsWith('/ws')) {
      writeRawHttpResponse(socket, 404, 'Not Found');
      return;
    }
    const token = extractBearerToken(req) ?? parseQueryToken(url);
    if (!token) {
      writeRawHttpResponse(socket, 401, 'Unauthorized');
      return;
    }
    if (!verifier(token)) {
      writeRawHttpResponse(socket, 401, 'Unauthorized');
      return;
    }
    const decision = limiter.consume(`ws:${token}`);
    if (!decision.allowed) {
      writeRawHttpResponse(
        socket,
        429,
        'Too Many Requests',
        { 'Retry-After': String(Math.ceil(decision.retry_after_ms / 1000)) },
      );
      return;
    }
    forward(req, socket, head, token);
  };
};

/** Write a minimal HTTP/1.1 status response on the raw socket and
 *  close. Used for upgrade-time auth/rate-limit denials — the
 *  socket is still a TCP connection at this point, not a WebSocket. */
const writeRawHttpResponse = (
  socket: Socket,
  status: number,
  reason: string,
  headers: Record<string, string> = {},
): void => {
  const lines = [`HTTP/1.1 ${status} ${reason}`, 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('', '');
  try {
    socket.write(lines.join('\r\n'));
  } catch {
    // Socket already closed — nothing to do.
  } finally {
    try { socket.destroy(); } catch { /* already destroyed */ }
  }
};

const parseQueryToken = (url: string): string | null => {
  const idx = url.indexOf('?');
  if (idx === -1) return null;
  const params = new URLSearchParams(url.slice(idx + 1));
  const token = params.get('token');
  if (!token || token.length === 0) return null;
  return token;
};
