import { walkPath } from '@recued/contracts';
import { IngredientError, type ResolvedCall } from './types.js';
import { resolveTimeoutMs, isWriteRiskTier } from './timeout.js';
import { CrossOriginRedirectError, fetchOriginPinned } from './origin-pinned-fetch.js';
import {
  discardResponseBody,
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from './bounded-response-body.js';

const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** MCP request input shape. The recipe/ingredient passes these fields via input.
 *  - mcp.server_url: full URL to the MCP server endpoint
 *  - mcp.tool: the tool name to invoke
 *  - mcp.arguments: arguments object for the tool
 *  - mcp.timeout_ms: optional per-call timeout (default 30000)
 */
export interface MCPInput {
  'mcp.server_url': string;
  'mcp.tool': string;
  'mcp.arguments'?: Record<string, unknown>;
  'mcp.timeout_ms'?: number;
}

/** JSON-RPC 2.0 request envelope. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response envelope. */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

let nextRequestId = 1;

/** Execute an MCP ingredient call.
 *  Sends a JSON-RPC 2.0 `tools/call` request to the MCP server.
 *  Returns the parsed result, or throws IngredientError on failure.
 *
 *  Timeout semantics: the timer covers the full call including body parse,
 *  clamped to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] by `resolveTimeoutMs`. Non-
 *  numeric or out-of-range values fall back to the default rather than
 *  throwing — static validation catches bad manifest defaults separately.
 */
export const executeMCP = async (resolved: ResolvedCall): Promise<unknown> => {
  const { input, output, slug, risk_tier } = resolved;
  const serverUrl = input['mcp.server_url'] as string | undefined;
  const tool = input['mcp.tool'] as string | undefined;
  const args = (input['mcp.arguments'] as Record<string, unknown>) ?? {};
  const timeoutMs = resolveTimeoutMs(input['mcp.timeout_ms']);
  const isWrite = isWriteRiskTier(risk_tier);

  if (!serverUrl) {
    throw new IngredientError('INGREDIENT_NOT_FOUND', `MCP ingredient ${slug} missing mcp.server_url`);
  }
  if (!tool) {
    throw new IngredientError('INGREDIENT_NOT_FOUND', `MCP ingredient ${slug} missing mcp.tool`);
  }

  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: nextRequestId++,
    method: 'tools/call',
    params: {
      name: tool,
      arguments: args,
    },
  };

  const headers = extractHeaders(input);
  const response = await postJsonRpc(serverUrl, request, headers, timeoutMs, slug, isWrite);

  if (response.error) {
    throw new IngredientError(
      'NETWORK_ERROR',
      `MCP server error from ${slug}: ${response.error.message}`,
      { code: response.error.code, data: response.error.data },
    );
  }

  return mapOutput(response.result, output);
};

/** Extract `header.*` input keys into a header record. Skip null/undefined values (optional headers). */
const extractHeaders = (input: Record<string, unknown>): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  for (const [key, val] of Object.entries(input)) {
    if (key.startsWith('header.') && val != null) {
      const name = key.slice(7);
      if (PROTOTYPE_SENSITIVE_KEYS.has(name)) continue;
      headers[name] = String(val);
    }
  }
  return headers;
};

/** POST a JSON-RPC request and parse the response. Handles network errors and timeouts.
 *
 *  Delivery classification mirrors http.ts: for write-tier MCP tools, any
 *  in-flight network failure (timeout, non-2xx HTTP status, body abort)
 *  becomes ACTION_DELIVERY_UNCERTAIN because the tool invocation may have
 *  committed on the server side even though the client never received an
 *  acknowledgment. 2xx envelopes carrying JSON-RPC-level errors are handled
 *  in the caller as clean errors (the server definitely invoked and replied). */
const postJsonRpc = async (
  url: string,
  request: JsonRpcRequest,
  headers: Record<string, string>,
  timeoutMs: number,
  slug: string,
  isWrite: boolean,
): Promise<JsonRpcResponse> => {
  // Resolve the redirect-pin origin BEFORE the dispatch try, so a
  // malformed server_url fails as URL_REF_INVALID rather than being
  // misclassified as a write-tier ACTION_DELIVERY_UNCERTAIN (nothing sent).
  let requestOrigin: string;
  try {
    requestOrigin = new URL(url).origin;
  } catch {
    throw new IngredientError('URL_REF_INVALID', `MCP server ${slug}: '${url}' is not a valid URL`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // SSRF: follow redirects manually, pinned to the recipe-declared
    // server URL's own origin — a server-sent 3xx can't pivot the
    // JSON-RPC POST (with its headers) off that origin to an internal /
    // metadata host. The declared target (localhost MCP included —
    // deliberately allowed) is honored; same-origin redirects work.
    const response = await fetchOriginPinned(fetch, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    }, requestOrigin);

    if (!response.ok) {
      discardResponseBody(response);
      if (isWrite && response.status >= 500) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `MCP write to ${slug} returned ${response.status} ${response.statusText} — outcome cannot be confirmed, please verify state in the target system before retrying`,
          { status: response.status, cause: 'server_5xx' },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `MCP server ${slug} returned ${response.status} ${response.statusText}`,
      );
    }

    const { text } = await readBoundedResponseText(response);
    const json = JSON.parse(text) as JsonRpcResponse;
    if (json.jsonrpc !== '2.0') {
      throw new IngredientError('NETWORK_ERROR', `MCP server ${slug} returned non-JSON-RPC response`);
    }
    return json;
  } catch (e) {
    if (e instanceof ResponseBodyTooLargeError) {
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `MCP write to ${slug} returned an oversized response after invocation — outcome cannot be confirmed, please verify state in the target system before retrying`,
          { cause: 'response_too_large', max_bytes: e.maxBytes },
        );
      }
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `MCP server ${slug} response exceeded the ${e.maxBytes}-byte body limit`,
        { max_bytes: e.maxBytes },
      );
    }
    if (e instanceof IngredientError) throw e;
    if (e instanceof CrossOriginRedirectError) {
      throw new IngredientError(
        'URL_REF_INVALID',
        `MCP call to ${slug}: ${e.message} — cross-origin redirect refused`,
      );
    }
    const isAbort = (e as Error).name === 'AbortError';
    if (isWrite) {
      throw new IngredientError(
        'ACTION_DELIVERY_UNCERTAIN',
        `MCP write to ${slug} ${isAbort ? `timed out after ${timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
        { cause: isAbort ? 'timeout' : 'network' },
      );
    }
    if (isAbort) {
      throw new IngredientError('STEP_TIMEOUT', `MCP call to ${slug} timed out after ${timeoutMs}ms`);
    }
    throw new IngredientError('NETWORK_ERROR', `MCP call to ${slug} failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

/** Map MCP response paths to ingredient output field names. */
const mapOutput = (data: unknown, outputMapping: Record<string, string>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [responsePath, fieldName] of Object.entries(outputMapping)) {
    if (PROTOTYPE_SENSITIVE_KEYS.has(fieldName)) continue;
    result[fieldName] = walkPath(data, responsePath);
  }
  return result;
};
