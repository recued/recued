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

import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearerToken } from '../common/bearer.js';
import { writeJson } from '../common/respond.js';
import { createRateLimiter, type RateLimiter } from '../common/rate-limit.js';
import {
  MCP_HEADER_MISMATCH,
  MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  decodeMcpHttpHeaderValue,
  hasModernMcpClientCapabilities,
  mcpNameHeaderSource,
  modernMcpHttpHeaders,
  readMcpRequestProtocolVersion,
} from '@recued/ingredients/mcp-protocol.js';

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

/** Argon2id verification is intentionally memory-hard (~32 MiB per canonical
 *  client-token attempt). The per-IP rate limiter bounds frequency but rotating
 *  sources can still arrive simultaneously, so bound the expensive operation
 *  independently of request rate. */
export const MCP_MAX_CONCURRENT_VERIFICATIONS = 8;

/** A rate limit cannot bound retained work when a tool call stalls across
 *  several refill windows. These caps bound authenticated body readers and
 *  dispatches globally, while keeping one bearer from occupying the whole
 *  port. */
export const MCP_MAX_IN_FLIGHT_GLOBAL = 64;
export const MCP_MAX_IN_FLIGHT_PER_TOKEN = 16;
export const MCP_MAX_LEGACY_SSE_SESSIONS = 64;
export const MCP_MAX_LEGACY_SSE_SESSIONS_PER_TOKEN = 4;

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

/** Resolve the authenticated token's authored concurrent-call ceiling. The
 *  D-137 inbound-token store carries a 3 / 5 / 10 tier; canonical owner CLI
 *  tokens have no authored tier and return `undefined`, retaining the port's
 *  conservative fixed ceiling. This seam runs only after bearer verification. */
export type McpConcurrencyLimitResolver = (
  token: string,
) => number | undefined;

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
  /** Concurrency overrides for tests / constrained embeddings. Invalid values
   *  fall back to the exported defaults. */
  max_concurrent_verifications?: number;
  max_in_flight_global?: number;
  max_in_flight_per_token?: number;
  /** Late-bound authored limit for this verified bearer. The configured
   *  `max_in_flight_per_token` remains a hard upper bound. */
  resolve_concurrency_limit?: McpConcurrencyLimitResolver;
  /** Explicit browser origins allowed to reach the MCP door. When omitted,
   * an Origin header must name the request Host; non-browser clients normally
   * omit Origin and remain unaffected. */
  allowed_origins?: readonly string[];
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
  const positiveInteger = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    const integer = Math.floor(value);
    return integer >= 1 ? integer : fallback;
  };
  const maxConcurrentVerifications = positiveInteger(
    options.max_concurrent_verifications,
    MCP_MAX_CONCURRENT_VERIFICATIONS,
  );
  const maxInFlightGlobal = positiveInteger(
    options.max_in_flight_global,
    MCP_MAX_IN_FLIGHT_GLOBAL,
  );
  const maxInFlightPerToken = Math.min(
    maxInFlightGlobal,
    positiveInteger(options.max_in_flight_per_token, MCP_MAX_IN_FLIGHT_PER_TOKEN),
  );
  let activeVerifications = 0;
  let activeDispatches = 0;
  const activeDispatchesByToken = new Map<string, number>();
  const allowedOrigins = options.allowed_origins === undefined
    ? undefined
    : new Set(options.allowed_origins.map((origin) => new URL(origin).origin));
  const legacySseSessions = new Map<string, {
    tokenKey: string;
    response: ServerResponse;
  }>();

  const originAllowed = (req: IncomingMessage): boolean => {
    const rawOrigin = req.headers.origin;
    if (rawOrigin === undefined) return true;
    if (Array.isArray(rawOrigin)) return false;
    let origin: URL;
    try {
      origin = new URL(rawOrigin);
    } catch {
      return false;
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if (allowedOrigins !== undefined) return allowedOrigins.has(origin.origin);
    const rawHost = req.headers.host;
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    return typeof host === 'string' && origin.host.toLowerCase() === host.toLowerCase();
  };

  const writeOverloaded = (res: ServerResponse, message: string): void => {
    writeJson(
      res,
      503,
      { error: { code: 'mcp_overloaded', message } },
      { 'retry-after': '1' },
    );
  };

  /** Reserve one authenticated request slot. The returned release is
   *  idempotent so a future branch cannot underflow the counters. */
  const admitDispatch = (token: string, res: ServerResponse): (() => void) | null => {
    const tokenKey = limiterTokenKey(token);
    const tokenActive = activeDispatchesByToken.get(tokenKey) ?? 0;
    let tokenLimit = maxInFlightPerToken;
    try {
      const authoredLimit = options.resolve_concurrency_limit?.(token);
      if (authoredLimit !== undefined) {
        tokenLimit = Math.min(
          tokenLimit,
          positiveInteger(authoredLimit, 1),
        );
      }
    } catch {
      // A limit resolver reads security-relevant token state. A failed read
      // must not silently widen the caller back to the transport default.
      writeOverloaded(res, 'MCP concurrency policy is temporarily unavailable.');
      return null;
    }
    if (activeDispatches >= maxInFlightGlobal || tokenActive >= tokenLimit) {
      writeOverloaded(res, 'Too many MCP calls are already running; retry shortly.');
      return null;
    }
    activeDispatches += 1;
    activeDispatchesByToken.set(tokenKey, tokenActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeDispatches -= 1;
      const remaining = (activeDispatchesByToken.get(tokenKey) ?? 1) - 1;
      if (remaining > 0) activeDispatchesByToken.set(tokenKey, remaining);
      else activeDispatchesByToken.delete(tokenKey);
    };
  };

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
    if (activeVerifications >= maxConcurrentVerifications) {
      writeOverloaded(res, 'MCP authentication is busy; retry shortly.');
      return null;
    }
    activeVerifications += 1;
    let verified = false;
    try {
      verified = await verifier(token);
    } finally {
      activeVerifications -= 1;
    }
    if (!verified) {
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

    // MCP 2026-07-28 requires this check on every incoming connection and
    // requires it to happen before credentials or dispatch are consulted.
    if (!originAllowed(req)) {
      writeJson(res, 403, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Invalid Origin for MCP endpoint.' },
      });
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
      const release = admitDispatch(token, res);
      if (!release) return;
      try {
        const result = await catalog(token);
        writeJson(res, 200, result);
      } finally {
        release();
      }
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

    if (req.method === 'GET') {
      const token = await gate(req, res);
      if (token === null) return;
      const tokenKey = limiterTokenKey(token);
      let tokenSessions = 0;
      for (const session of legacySseSessions.values()) {
        if (session.tokenKey === tokenKey) tokenSessions += 1;
      }
      if (
        legacySseSessions.size >= MCP_MAX_LEGACY_SSE_SESSIONS
        || tokenSessions >= MCP_MAX_LEGACY_SSE_SESSIONS_PER_TOKEN
      ) {
        writeOverloaded(res, 'Too many legacy MCP SSE sessions are already open.');
        return;
      }
      const sessionId = randomUUID();
      legacySseSessions.set(sessionId, {
        tokenKey,
        response: res,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();
      res.write(`event: endpoint\ndata: /mcp?sessionId=${encodeURIComponent(sessionId)}\n\n`);
      const forget = (): void => {
        if (legacySseSessions.get(sessionId)?.response === res) {
          legacySseSessions.delete(sessionId);
        }
      };
      res.once('close', forget);
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
    const sessionId = new URL(url, 'http://mcp.invalid').searchParams.get('sessionId');
    const legacySession = sessionId === null ? undefined : legacySseSessions.get(sessionId);
    if (
      sessionId !== null
      && (
        legacySession === undefined
        || legacySession.tokenKey !== limiterTokenKey(token)
        || legacySession.response.writableEnded
        || legacySession.response.destroyed
      )
    ) {
      writeJson(res, 404, { error: { code: 'not_found' } });
      return;
    }
    const release = admitDispatch(token, res);
    if (!release) return;
    try {
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

      // MCP 2026-07-28 requires the HTTP protocol header to match the
      // per-request `_meta` declaration. Validate this at the transport
      // boundary so spec-defined header failures carry HTTP 400 instead of a
      // successful HTTP status containing only a JSON-RPC error.
      const bodyProtocolVersion = envelope !== null
        && typeof envelope === 'object'
        && !Array.isArray(envelope)
        ? readMcpRequestProtocolVersion(
            (envelope as { params?: unknown }).params,
          )
        : undefined;
      const rawProtocolHeader = req.headers['mcp-protocol-version'];
      const headerProtocolVersion = Array.isArray(rawProtocolHeader)
        ? rawProtocolHeader[0]
        : rawProtocolHeader;
      if (
        bodyProtocolVersion !== undefined
        || headerProtocolVersion !== undefined
      ) {
        const responseId = envelope !== null
          && typeof envelope === 'object'
          && !Array.isArray(envelope)
          && ('id' in envelope)
          ? ((envelope as { id?: unknown }).id ?? null)
          : null;
        if (
          typeof bodyProtocolVersion !== 'string'
          || headerProtocolVersion !== bodyProtocolVersion
        ) {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            id: responseId,
            error: {
              code: MCP_HEADER_MISMATCH,
              message: 'MCP-Protocol-Version header must match params._meta protocolVersion.',
            },
          });
          return;
        }
        if (bodyProtocolVersion !== MCP_MODERN_PROTOCOL_VERSION) {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            id: responseId,
            error: {
              code: MCP_UNSUPPORTED_PROTOCOL_VERSION,
              message: `Unsupported MCP protocol version: ${bodyProtocolVersion}`,
              data: {
                supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
                requested: bodyProtocolVersion,
              },
            },
          });
          return;
        }
        const request = envelope as { method?: unknown; params?: unknown };
        const requestMethod = typeof request.method === 'string' ? request.method : '';
        const expectedHeaders = modernMcpHttpHeaders(requestMethod, request.params);
        const rawMethodHeader = req.headers['mcp-method'];
        const rawNameHeader = req.headers['mcp-name'];
        const methodHeader = typeof rawMethodHeader === 'string' ? rawMethodHeader : undefined;
        const nameHeader = typeof rawNameHeader === 'string' ? rawNameHeader : undefined;
        // Compare the DECODED header against the raw body value. Whether to
        // base64 a header is the client's call — only some values force it —
        // so matching our own re-encoded form would reject a conforming client
        // that encodes more eagerly than Recued does.
        const expectedName = mcpNameHeaderSource(requestMethod, request.params);
        const presentedName = nameHeader === undefined
          ? undefined
          : decodeMcpHttpHeaderValue(nameHeader);
        if (
          methodHeader !== expectedHeaders['Mcp-Method']
          || presentedName !== expectedName
        ) {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            id: responseId,
            error: {
              code: MCP_HEADER_MISMATCH,
              message: 'MCP method/name headers must match the JSON-RPC request body.',
            },
          });
          return;
        }
        // `clientCapabilities` is a REQUIRED per-request field; a request
        // missing it is malformed. The dispatcher checks this too (it serves
        // stdio, which has no status line), but only this door can attach the
        // 400 the HTTP binding requires — and -32602 is too overloaded to map
        // by code alone after the fact.
        if (!hasModernMcpClientCapabilities(request.params)) {
          writeJson(res, 400, {
            jsonrpc: '2.0',
            id: responseId,
            error: {
              code: -32602,
              message: 'Modern MCP requests require clientCapabilities in params._meta.',
            },
          });
          return;
        }
      }

      const response = await dispatch(envelope, token);
      // Accepted notification POSTs have no body in both supported HTTP eras.
      if (response === null || typeof response === 'undefined') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (legacySession !== undefined) {
        legacySession.response.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        res.statusCode = 202;
        res.end();
        return;
      }
      // The dispatcher is transport-agnostic (it also serves stdio), so the
      // HTTP status for a protocol-defined error is this door's obligation.
      // Returning 200 beside one is not cosmetic: a dual-era client discovers
      // the server's era by inspecting the body of a 4xx, so a modern error
      // delivered as 200 is a modern error that client never looks for.
      const responseError = response !== null
        && typeof response === 'object'
        && !Array.isArray(response)
        ? (response as { error?: { code?: unknown } }).error
        : undefined;
      const errorCode = responseError?.code;
      const protocolErrorStatus =
        errorCode === MCP_HEADER_MISMATCH
        || errorCode === MCP_MISSING_REQUIRED_CLIENT_CAPABILITY
        || errorCode === MCP_UNSUPPORTED_PROTOCOL_VERSION
          ? 400
          // 404 belongs to the modern transport; the deprecated 2024-11-05
          // transport answers an unknown method with a plain JSON-RPC error.
          : errorCode === -32601 && bodyProtocolVersion === MCP_MODERN_PROTOCOL_VERSION
            ? 404
            : 200;
      writeJson(res, protocolErrorStatus, response);
    } finally {
      release();
    }
  };
};
