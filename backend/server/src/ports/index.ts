/** D-148 P6 § A.6 — port substrate index.
 *
 *  Per-port handlers + their shared primitives. The actual listener
 *  set / cert chain holder lives in `@recued/server-tls`; this
 *  module hands the per-role HTTP handlers to that orchestrator. */

export {
  createWsPortHandler,
  createWsUpgradeHandler,
  recordWsRpc,
  WS_RATE_LIMIT_PER_SEC,
  WS_RATE_LIMIT_WINDOW_MS,
} from './ws/handler.js';
export type {
  WsBearerVerifier,
  WsPortHandlerOptions,
  WsUpgradeHandlerOptions,
} from './ws/handler.js';

export { createWebhookPortHandler } from './webhook/handler.js';
export type {
  WebhookPortHandlerOptions,
  WebhookVendorDescriptor,
} from './webhook/handler.js';

export {
  createIdempotencyLedger,
  WEBHOOK_REPLAY_WINDOW_MS,
} from './webhook/idempotency-ledger.js';
export type {
  IdempotencyLedger,
  IdempotencyLedgerOptions,
} from './webhook/idempotency-ledger.js';

export {
  hmacSha256Hex,
  constantTimeEqualHex,
  verifySlackSignature,
} from './webhook/hmac.js';

export {
  createMcpPortHandler,
  MCP_RATE_LIMIT_PER_MIN,
  MCP_RATE_LIMIT_WINDOW_MS,
} from './mcp/handler.js';
export type {
  McpBearerVerifier,
  McpDispatch,
  McpCatalogDispatch,
  McpPortHandlerOptions,
} from './mcp/handler.js';

export { createReceptionPortHandler } from './reception/handler.js';

export {
  createRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
  type RateLimitDecision,
} from './common/rate-limit.js';

export { extractBearerToken } from './common/bearer.js';
export { writeJson } from './common/respond.js';
