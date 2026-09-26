/** D-313 — the recipe code a server handler's refusal means.
 *
 *  A server handler behind a kernel op refuses with an `RpcError`: a code
 *  (`not_found`), a message, and most often an HTTP-like status (404). The
 *  step runner keeps a code the recipe vocabulary already has (`mail_draft_*`,
 *  `preapproval_*`). Before this module every other code was `NETWORK_ERROR`,
 *  "check your connection", which an MCP caller reads as "come back later" and
 *  an automation retries.
 *
 *  Measured 2026-09-25, reading every `RpcError(` call in `backend/server/src`,
 *  calls spread over several lines included: 144 codes in 1,550 calls, the
 *  CLI's own client aside; 122 of them unnamed. An earlier count read
 *  one line per call and found about 50, which is how "about 30 left" was
 *  reported before this. 1,140 of the throws carry a literal status.
 *
 *  So the answer is read in this order:
 *  1. `RPC_REFUSAL_RECIPE_CODES`, for a code with no status, or one a specific
 *     recipe code says better than its status can;
 *  2. the status (`recipeCodeForRpcStatus`);
 *  3. otherwise nothing, and the step runner's `NETWORK_ERROR` stands.
 *  `rpc-refusal-codes-are-named.ratchet.test.ts` fails on a server code that
 *  would reach 3, naming the file, unless `RPC_CODES_LEFT_UNNAMED` says why.
 *
 *  ⚠ Only a code written as an rpc code is read this way (lower-case words
 *  with underscores). A system error (`ECONNRESET`, `SQLITE_BUSY`) is not a
 *  handler's refusal, and a status on one would be read as something it is
 *  not. */

import type { RecipeErrorCode } from './errors.js';

/** A code whose meaning the status cannot carry. Each line says which. */
export const RPC_REFUSAL_RECIPE_CODES: Readonly<Record<string, RecipeErrorCode>> = {
  // ── The first mapped set (D-313 and its amendment) ──
  bad_request: 'BAD_INPUT',
  not_found: 'NOT_FOUND',
  file_not_found: 'NOT_FOUND',
  not_configured: 'NOT_CONFIGURED',
  unauthorized: 'NOT_AUTHORIZED',
  conflict: 'CONFLICT',
  internal_error: 'SERVER_ERROR',
  invalid_cron: 'BAD_INPUT',

  // ── Thrown at some sites with no status ──
  collection_not_found: 'NOT_FOUND', // mail/file instance or collection that is not there (404, 503, none)
  contract_write_loosens: 'NOT_AUTHORIZED',
  failed_precondition: 'NOT_CONFIGURED', // "set this server's timezone first"
  forbidden: 'NOT_AUTHORIZED',
  internal: 'SERVER_ERROR',
  invalid_argument: 'BAD_INPUT',
  invalid_request: 'BAD_INPUT',
  locked: 'SERVER_LOCKED', // "Server is locked — unlock to …"
  owner_operation_below_floor: 'NOT_AUTHORIZED',
  owner_operation_risk_downgrade_confirm: 'NOT_AUTHORIZED',
  permission_denied: 'NOT_AUTHORIZED',
  storage_pressure: 'STORAGE_PRESSURE',
  unavailable: 'SERVER_ERROR',
  unsupported: 'BAD_INPUT', // "only your own memory (user_self) is editable"; the rest are Settings
  webhook_registration_unconfirmed: 'ACTION_DELIVERY_UNCERTAIN', // status computed at the site

  // ── A specific recipe code says it better than the status ──
  ai_invalid_output: 'AI_OUTPUT_INVALID', // 502
  binding_exchange_failed: 'API_SERVER_ERROR', // the cloud's answer; status computed
  collection_source_unreachable: 'COLLECTION_SOURCE_UNREACHABLE', // 502
  connection_pick_required: 'NOT_CONFIGURED', // 400: the owner has to pick one
  connection_required: 'NOT_CONFIGURED', // 400
  connection_target_unpinned: 'NOT_CONFIGURED', // 400
  contract_use_exhausted: 'QUOTA_EXCEEDED', // 429, but it does not come back by waiting
  credential_rotation_outcome_unknown: 'ACTION_DELIVERY_UNCERTAIN', // 503: "check its status before trying again"
  ddns_pause_cloud_failed: 'API_SERVER_ERROR', // 502 from the cloud
  dish_disabled: 'NOT_AUTHORIZED', // 409, but the owner turned it off: running again cannot help
  file_storage_missing: 'NOT_CONFIGURED', // 500/404: the file's storage is not set up
  not_unlocked: 'SERVER_LOCKED', // 409
  pack_not_installed: 'NOT_CONFIGURED', // 400: "needs a pack that is not installed"
  payload_too_large: 'VALUE_TOO_LARGE', // 413, shared storage and annotations
  recipe_not_found: 'RECIPE_NOT_FOUND', // 404
  remote_fetch_failed: 'API_SERVER_ERROR', // 502/504: Google, S3, Notion or a URL answered badly
  server_not_reachable: 'COLLECTION_SOURCE_UNREACHABLE', // 503: "…_ADAPTER_UNREACHABLE: instance is not running"
  trigger_pattern_invalid: 'TRIGGER_PATTERN_INVALID', // 400
  usage_limit_exceeded: 'QUOTA_EXCEEDED', // 429, a use limit, not a rate
  webhook_not_ready: 'NOT_CONFIGURED', // 409: the webhook is not set up yet
};

/** Codes that stay `NETWORK_ERROR`, each with why. */
export const RPC_CODES_LEFT_UNNAMED: Readonly<Record<string, string>> = {
  cancelled: 'the Kitchen test run stopping itself (499); never a step\'s refusal',
};

/** The recipe code an rpc refusal's HTTP-like status means. */
export const recipeCodeForRpcStatus = (status: number): RecipeErrorCode | undefined => {
  if (!Number.isInteger(status)) return undefined;
  switch (status) {
    case 400: return 'BAD_INPUT';
    case 401: return 'NOT_AUTHORIZED';
    case 402: return 'NOT_CONFIGURED'; // a subscription the server does not have
    case 403: return 'NOT_AUTHORIZED';
    case 404: return 'NOT_FOUND';
    case 408: return 'STEP_TIMEOUT';
    case 409: return 'CONFLICT';
    case 410: return 'NOT_FOUND';
    case 413: return 'BAD_INPUT';
    case 422: return 'BAD_INPUT';
    case 423: return 'SERVER_LOCKED';
    case 429: return 'API_RATE_LIMITED';
    case 499: return undefined; // a request its caller stopped
    case 501: return 'BAD_INPUT'; // the server cannot do this for what was asked
    case 507: return 'STORAGE_PRESSURE';
    default:
      if (status >= 400 && status < 500) return 'BAD_INPUT';
      if (status >= 500 && status < 600) return 'SERVER_ERROR';
      return undefined;
  }
};

const RPC_CODE = /^[a-z][a-z0-9_]*$/u;

/** The recipe code for a server handler's refusal, or `undefined` when it is
 *  none this can name (the caller's fallback stands). */
export const recipeCodeForRpcRefusal = (code: string, status: unknown): RecipeErrorCode | undefined => {
  if (!RPC_CODE.test(code)) return undefined;
  if (Object.hasOwn(RPC_REFUSAL_RECIPE_CODES, code)) return RPC_REFUSAL_RECIPE_CODES[code];
  if (Object.hasOwn(RPC_CODES_LEFT_UNNAMED, code)) return undefined;
  return typeof status === 'number' ? recipeCodeForRpcStatus(status) : undefined;
};
