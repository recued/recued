/** D-148 P6 § A.6 — MCP port handler.
 *
 *  The MCP dispatch lives at `mcp-server.ts` (stdio transport). P6
 *  adds an HTTP transport on the dedicated MCP port (default 8444)
 *  with bearer auth + per-token rate limit (60 rpc/min — § P6
 *  acceptance line 2153). MCP carries a structurally different risk
 *  class (AI-agent ingress, prompt-injection surface) so the port
 *  is gated behind the explicit `public_mcp_acknowledged` sub-toggle
 *  per § A.7 — until then it stays LAN-bound.
 *
 *  Per-rpc dispatch shape: each request is a single JSON-RPC 2.0
 *  envelope `{ jsonrpc: '2.0', id, method, params? }`. The handler
 *  forwards the parsed message to the dispatcher, then writes the
 *  response.
 *
 *  Auth: `Authorization: Bearer <mcp_token>`. The mcp_token is
 *  per-pair (D-137 substrate). The verifier is injected so tests
 *  substitute a fixture store. */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearerToken } from '../common/bearer.js';
import { writeJson } from '../common/respond.js';
import { createRateLimiter, type RateLimiter } from '../common/rate-limit.js';

export const MCP_RATE_LIMIT_PER_MIN = 60;
export const MCP_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Pre-auth per-source-IP throttle. Sits BEFORE the bearer verifier so a
 *  flood of token-unknown requests can't force unbounded Argon2id hashing
 *  (the cli/client-token `verify` runs a full Argon2id on EVERY attempt,
 *  by design, for constant-time — CPU+RAM-bound at ~32 MiB/call).
 *
 *  Burst is capped SEPARATELY from the steady rate: a token bucket starts
 *  FULL, so a single fresh-IP bucket sized for "120/min" would let 120
 *  Argon2id calls fire in one instantaneous spike — exactly the spike this
 *  guards against. So the bucket is sized `MCP_PER_IP_BURST` (20) over a
 *  10 s window → 2/s steady (≈120/min) with the instantaneous burst capped
 *  at 20. Generous enough for legit multi-client-behind-NAT traffic (whose
 *  real quota is the per-token 60/min limit) yet bounds the amplification.
 *  Keyed on the raw source IP (not a secret) with a bounded Map so an
 *  IPv6-rotating flood can't grow memory without limit. */
export const MCP_PER_IP_BURST = 20;
export const MCP_PER_IP_REFILL_WINDOW_MS = 10 * 1000;
export const MCP_PER_IP_LIMITER_MAX_KEYS = 100_000;

/** Resolve the client IP for the pre-auth throttle. `X-Forwarded-For` is
 *  trusted ONLY when the operator opts in (`trust_forwarded_for`) — behind
 *  a trusted reverse proxy / Pro tunnel — because a direct listener lets any
 *  caller forge the header and sidestep the per-IP bucket. Default (no
 *  trust) keys on the real socket peer; behind an untrusted-by-config proxy
 *  the per-IP throttle degrades to a shared bucket (still fail-safe — it
 *  throttles, never grants extra). */
const clientIp = (req: IncomingMessage, trustForwardedFor: boolean): string => {
  if (trustForwardedFor) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
};

/** Hash a bearer for use as a rate-limit Map key, so the plaintext bearer
 *  is never retained in the limiter's in-memory bucket map (hygiene — a
 *  heap dump shouldn't surface every token that ever authenticated). The
 *  16-hex sha256 prefix is collision-resistant for keying. */
const limiterTokenKey = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);

/** Per-token verifier. Returns true iff the token is a currently-
 *  valid MCP token for this server. */
export type McpBearerVerifier = (token: string) => boolean | Promise<boolean>;

/** Dispatch a JSON-RPC envelope. The handler hands the validated bearer
 *  token to the closure so the dispatcher can derive a per-request
 *  `mcp_token_id` (D-137 channel-isolation invariant). Token is optional
 *  in the type so legacy fixtures that ignore it still type-check; the
 *  HTTP transport's gate guarantees a non-empty token at runtime. */
export type McpDispatch = (envelope: unknown, token?: string) => Promise<unknown | null>;

/** D-148 § A.6 line 820 — `GET /mcp/catalog` returns the topic +
 *  tool list visible to the calling token. The dispatcher resolves
 *  the per-token visibility set; the handler is a pure carrier. */
export type McpCatalogDispatch = (token: string) => Promise<unknown>;

export interface McpPortHandlerOptions {
  verifier: McpBearerVerifier;
  /** Per-token rate limiter (60 rpc/min by default). */
  limiter: RateLimiter;
  /** Forward to the MCP dispatcher. Returns the JSON-RPC response
   *  (or null for notifications). */
  dispatch: McpDispatch;
  /** Optional `GET /mcp/catalog` handler. When wired, the route
   *  goes through the same bearer + rate-limit gate as POST. When
   *  unwired, GET /mcp/catalog returns 404 (vendor-agnostic
   *  closed-list response). */
  catalog?: McpCatalogDispatch;
  /** Body cap. JSON-RPC envelopes are typically tiny; the default
   *  256 KB is generous. */
  max_body_bytes?: number;
  /** Pre-auth per-source-IP throttle. Consulted BEFORE the bearer
   *  verifier so a token-unknown flood can't drive unbounded Argon2id
   *  work. Defaults to an internal bounded limiter (`MCP_PER_IP_BURST`
   *  per `MCP_PER_IP_REFILL_WINDOW_MS`, over `MCP_PER_IP_LIMITER_MAX_KEYS`
   *  keys); tests inject one with a controlled clock. */
  per_ip_limiter?: RateLimiter;
  /** Trust `X-Forwarded-For` for the per-IP key. Default `false`
   *  (key on the socket peer). Operators behind a trusted reverse
   *  proxy / Pro tunnel flip this on at boot so per-IP attribution
   *  survives the hop. */
  trust_forwarded_for?: boolean;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

const readBody = async (req: IncomingMessage, cap: number): Promise<Buffer | null> => {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;
    const done = (b: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(b);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(overLimit ? null : Buffer.concat(chunks)));
    req.on('error', () => done(null));
    req.on('close', () => done(null));
  });
};

export const createMcpPortHandler = (
  options: McpPortHandlerOptions,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const { verifier, limiter, dispatch, catalog } = options;
  const cap = options.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const trustForwardedFor = options.trust_forwarded_for ?? false;
  // Pre-auth per-IP throttle (default: bounded internal limiter). Bounds
  // the Argon2id amplification surface before the verifier ever runs.
  const perIpLimiter = options.per_ip_limiter ?? createRateLimiter({
    capacity: MCP_PER_IP_BURST,
    refill_window_ms: MCP_PER_IP_REFILL_WINDOW_MS,
    max_keys: MCP_PER_IP_LIMITER_MAX_KEYS,
  });

  // Codex P2 #5 fold — bearer + rate-limit gate that both POST and
  // the catalog GET share. Returns the validated token, or null
  // when the response has already been written.
  const gate = async (req: IncomingMessage, res: ServerResponse): Promise<string | null> => {
    // Pre-auth per-IP throttle FIRST — before extracting / verifying the
    // bearer, so a token-unknown flood can't force unbounded Argon2id
    // hashing (the cli verifier hashes every attempt by design). 429 with
    // a generic message so it doesn't fingerprint the bearer state.
    const ipDecision = perIpLimiter.consume(`ip:${clientIp(req, trustForwardedFor)}`);
    if (!ipDecision.allowed) {
      writeJson(
        res,
        429,
        {
          error: { code: 'rate_limited', message: 'MCP port rate limit exceeded' },
          retry_after_ms: ipDecision.retry_after_ms,
        },
        { 'retry-after': String(Math.ceil(ipDecision.retry_after_ms / 1000)) },
      );
      return null;
    }
    const token = extractBearerToken(req);
    if (!token) {
      writeJson(res, 401, {
        error: { code: 'unauthorized', message: 'bearer token required on MCP port' },
      });
      return null;
    }
    if (!(await verifier(token))) {
      writeJson(res, 401, {
        error: { code: 'unauthorized', message: 'invalid token' },
      });
      return null;
    }
    const decision = limiter.consume(`mcp:${limiterTokenKey(token)}`);
    if (!decision.allowed) {
      writeJson(
        res,
        429,
        {
          error: { code: 'rate_limited', message: 'MCP port rate limit exceeded' },
          retry_after_ms: decision.retry_after_ms,
        },
        { 'retry-after': String(Math.ceil(decision.retry_after_ms / 1000)) },
      );
      return null;
    }
    return token;
  };

  return async (req, res) => {
    const url = req.url ?? '/';
    const [pathname] = url.split('?');

    if (pathname === '/health' && req.method === 'GET') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    // D-148 § A.6 line 820 — token-scoped catalog route. Same
    // bearer + rate-limit gate as POST so the per-token quota
    // applies uniformly across rpc + catalog discovery.
    if (pathname === '/mcp/catalog' && req.method === 'GET') {
      if (!catalog) {
        writeJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      const token = await gate(req, res);
      if (token === null) return;
      const result = await catalog(token);
      writeJson(res, 200, result);
      return;
    }

    // Codex P2 #1 fold — closed-list path discriminator. The path
    // router fans every `/mcp/*` URL into this role (per `network.ts`
    // `matchesPathRole`), so unknown subpaths like `/mcp/typo` would
    // otherwise reach the POST branch and authenticate / rate-limit
    // before 404-ing. Reject anything outside the closed list BEFORE
    // auth so probes can't fingerprint the role and the role handler
    // honours its sub-path 404 contract.
    if (pathname !== '/mcp') {
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, {
        error: { code: 'method_not_allowed', message: 'MCP port accepts POST only' },
      });
      return;
    }

    const token = await gate(req, res);
    if (token === null) return;

    const body = await readBody(req, cap);
    if (!body) {
      writeJson(res, 413, { error: { code: 'payload_too_large' } });
      return;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(body.toString('utf-8'));
    } catch {
      writeJson(res, 400, { error: { code: 'invalid_json' } });
      return;
    }

    const response = await dispatch(envelope, token);
    // JSON-RPC notifications (no `id`) return null — write 204.
    if (response === null || typeof response === 'undefined') {
      res.statusCode = 204;
      res.end();
      return;
    }
    writeJson(res, 200, response);
  };
};
