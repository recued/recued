/** D-125 Phase 4.2 — `connection.mcp` per-kind handler.
 *
 *  Second per-kind handler under the `connection` adapter (after
 *  P4.1's api). Implements MCP tool invocation for `kind: 'connection'
 *  + connection_kind: 'mcp'` ingredients, replacing the P3.1
 *  placeholder that surfaces `INGREDIENT_ADAPTER_ALL_FAILED` with
 *  `kind: 'connection.mcp'`.
 *
 *  Wire shape (spec § 4.2):
 *
 *    Input — `params` after the shell strips `connection_kind` +
 *    `connection`. Exactly ONE operation selector (tool wins if present,
 *    backward-compat):
 *      - tool: MCP tool name → `tools/call` (string).
 *      - args: tool arguments object (optional, defaults to `{}`).
 *      - resource: MCP resource uri → `resources/read` (string). The
 *        read-only resource primitive the watch poll-source diffs.
 *      - resources_list: true → `resources/list` (enumerate resources).
 *      - timeout_ms: per-call timeout (optional, clamped via
 *        `resolveTimeoutMs`).
 *
 *    Output — spec § 4.2:
 *      `{ status: 'ok' | 'tool_error',
 *         result: <tool result | resource contents | resource list>,
 *         headers: undefined }`
 *      A JSON-RPC error envelope, or an MCP `tools/call` result carrying
 *      `isError: true`, maps to `tool_error` so wrapper recipes can branch
 *      without unwrapping either protocol error shape. Network failures and
 *      HTTP-level errors throw `IngredientError` (NETWORK_ERROR / STEP_TIMEOUT
 *      / ACTION_DELIVERY_UNCERTAIN).
 *
 *  Connection record shape (per spec § A.5 + § 2.4):
 *    - `record.config.transport`: 'sse' | 'websocket' | 'stdio'.
 *    - `record.config.endpoint`: URL (sse / ws). For stdio instead:
 *      `record.config.{command, args?, env?}` (the launch spec).
 *    - `record.auth`: typed `ConnectionAuth` (decoded by the boot site
 *      via `decodeAuth(record)`).
 *    - `record.health.tools`: cached tool list from the most recent
 *      probe (P2.4). When present, the handler validates `input.tool`
 *      against it and surfaces `MCP_TOOL_NOT_FOUND` early. When
 *      absent (probe not yet run), validation is skipped and the
 *      server's own JSON-RPC error envelope surfaces.
 *
 *  Transport status — ships all three: `sse` (Streamable HTTP — POST
 *  JSON-RPC to the endpoint), `websocket` (D-125 §920 — a long-lived
 *  JSON-RPC socket with the bearer in the upgrade handshake), and `stdio`
 *  (D-125 §921 — a spawned child process, newline-framed JSON-RPC over
 *  stdin/stdout). `websocket` + `stdio` open through injected capabilities
 *  (`wsConnect` / `spawnStdioMcp`) since `ws` + `child_process` are
 *  Node-only and `packages/` can't import `backend/`; both surface
 *  `MCP_TRANSPORT_NOT_IMPLEMENTED` in a runtime that supplies no such
 *  capability (the ext / dbless harnesses).
 *
 *  Idle teardown — an in-memory `Map<pk, McpClient>` with
 *  `last_used_at` bumped on every dispatch + a lazy reaper that prunes
 *  idle entries on the next access. SSE-as-HTTP-POST is stateless, so
 *  reaping is a metadata-only no-op; a `websocket` / `stdio` entry carries
 *  a live `McpStreamSession`, which the reaper (and mid-dispatch eviction)
 *  closes (the ws socket / the stdio child).
 *
 *  Bytes telemetry — populates `ctx.setBytes(in, out)` with the
 *  request envelope length + response envelope length. Audit shell
 *  threads these into the `bytes_in` / `bytes_out` emission fields. */

import {
  CONNECTION_API_TIMEOUT_MS,
  MCP_CLIENT_IDLE_TIMEOUT_MS,
  validateHeaderAuthEntries,
  describeHeaderAuthIssue,
  foldConnectionDispatchHealth,
} from '@recued/contracts';
import type {
  ConnectionAuth,
  ConnectionHealth,
  ConnectionRow,
  McpTransport,
  McpToolDescriptor,
  ConnectionDispatchOutcome,
} from '@recued/contracts';
import type { ConnectionHandlerCtx, ConnectionKindHandler } from './connection.js';
import { IngredientError, type ResolvedCall } from './types.js';
import { resolveTimeoutMs, isWriteRiskTier } from './timeout.js';
import { CrossOriginRedirectError, fetchOriginPinned } from './origin-pinned-fetch.js';
import {
  createEnsureFreshAuth,
  type EnsureFreshAuthDeps,
} from './connection-api.js';
import {
  DEFAULT_RESPONSE_BODY_MAX_BYTES,
  discardResponseBody,
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from './bounded-response-body.js';
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_NEGOTIATION_PROBE_TIMEOUT_MS,
  isModernMcpProtocolError,
  mcpHttpHeaderBindingsFromSchema,
  mcpProtocolEra,
  modernMcpHttpHeaders,
  modernMcpRequestMeta,
  modernMcpToolArgumentHeaders,
  selectMcpDiscoverVersion,
  selectMcpLegacyInitializeVersion,
  unsupportedMcpResultType,
  withModernMcpRequestMeta,
  type McpImplementationInfo,
  type McpHttpHeaderBinding,
  type RecuedMcpProtocolVersion,
} from './mcp-protocol.js';

const KNOWN_TRANSPORTS: ReadonlySet<McpTransport> = new Set<McpTransport>([
  'sse',
  'websocket',
  'stdio',
]);
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcErrorEnvelope {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcErrorEnvelope;
}

interface McpHttpEnvelopeRead {
  envelope: JsonRpcResponse;
  byteLength: number;
}

/** Consume an SSE response incrementally. The callback returns true once the
 * caller has its terminal event; the reader is then cancelled instead of
 * waiting for a server that keeps the HTTP response open. */
const consumeMcpSse = async (
  response: Response,
  onEvent: (event: { event?: string; data: string }) => boolean,
  limitTotal = true,
): Promise<number> => {
  const body = response.body;
  if (body === null) throw new Error('MCP SSE response had no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let bytesRead = 0;
  let eventBytes = 0;

  const dispatchEvent = (): boolean => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventBytes = 0;
      return false;
    }
    const done = onEvent({
      ...(eventName !== undefined ? { event: eventName } : {}),
      data: dataLines.join('\n'),
    });
    eventName = undefined;
    dataLines = [];
    eventBytes = 0;
    return done;
  };
  const consumeLine = (rawLine: string): boolean => {
    eventBytes += new TextEncoder().encode(rawLine).byteLength + 1;
    if (eventBytes > DEFAULT_RESPONSE_BODY_MAX_BYTES) {
      throw new ResponseBodyTooLargeError(
        DEFAULT_RESPONSE_BODY_MAX_BYTES,
        eventBytes,
      );
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return dispatchEvent();
    if (line.startsWith(':')) return false;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    return false;
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (limitTotal && bytesRead > DEFAULT_RESPONSE_BODY_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError(
          DEFAULT_RESPONSE_BODY_MAX_BYTES,
          bytesRead,
        );
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (consumeLine(line)) {
          void reader.cancel().catch(() => undefined);
          return bytesRead;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer !== '' && consumeLine(buffer)) return bytesRead;
    dispatchEvent();
    return bytesRead;
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation owns cleanup */ }
  }
};

/** Read either legal modern HTTP response representation: one JSON object or
 * a response-scoped SSE stream. Notifications on SSE are skipped until the
 * final response carrying `expectedId` arrives. */
export const readMcpHttpEnvelope = async (
  response: Response,
  expectedId: number,
): Promise<McpHttpEnvelopeRead> => {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) {
    const read = await readBoundedResponseText(response);
    return {
      envelope: JSON.parse(read.text) as JsonRpcResponse,
      byteLength: read.byteLength,
    };
  }
  // Server-side probes use a bounded, already-buffered Response-shaped
  // adapter. Preserve SSE decoding for that seam while native fetch takes the
  // incremental path below and can stop before EOF.
  if ((response as Response & { body?: ReadableStream<Uint8Array> | null }).body === undefined) {
    const read = await readBoundedResponseText(response);
    for (const block of read.text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data === '') continue;
      try {
        const candidate = JSON.parse(data) as JsonRpcResponse;
        if (candidate.jsonrpc === '2.0' && candidate.id === expectedId) {
          return { envelope: candidate, byteLength: read.byteLength };
        }
      } catch {
        // Ignore malformed/non-JSON events until a matching response appears.
      }
    }
    throw new Error(`MCP SSE response ended before JSON-RPC id ${expectedId}`);
  }
  let envelope: JsonRpcResponse | undefined;
  const byteLength = await consumeMcpSse(response, ({ data }) => {
    let candidate: JsonRpcResponse;
    try {
      candidate = JSON.parse(data) as JsonRpcResponse;
    } catch {
      return false;
    }
    if (candidate.jsonrpc === '2.0' && candidate.id === expectedId) {
      envelope = candidate;
      return true;
    }
    return false;
  });
  if (envelope === undefined) {
    throw new Error(`MCP SSE response ended before JSON-RPC id ${expectedId}`);
  }
  return { envelope, byteLength };
};

/** Pool entry per connection record. Modern HTTP holds metadata only; legacy
 * HTTP+SSE, websocket, and stdio carry a live `McpStreamSession`. */
interface McpClient {
  transport: McpTransport;
  /** Reuse-staleness key: the endpoint URL (`websocket`) or a stable
   *  command signature (`stdio`). A pooled session is reused only while
   *  this still matches the record's current config; a re-enrolled
   *  connection (same pk, changed target) forces a reopen. */
  endpoint: string;
  /** Wall-clock ms of the most recent successful dispatch. The reaper
   *  prunes entries whose `last_used_at` is older than
   *  `MCP_CLIENT_IDLE_TIMEOUT_MS`. */
  last_used_at: number;
  /** Live long-lived session for `transport: 'websocket' | 'stdio'`.
   *  Absent for `sse` (stateless). The reaper / eviction closes it. */
  session?: McpStreamSession;
  /** Negotiated wire revision for stateless HTTP. Stream sessions retain the
   * same selection on the session itself. */
  protocolVersion?: RecuedMcpProtocolVersion;
  /** `Mcp-Session-Id` minted by a handshake-era Streamable HTTP server during
   * `initialize`, echoed on every later POST. Absent for the modern era (which
   * removed sessions) and for servers that mint none. */
  httpSessionId?: string;
  /** Validated 2026-07-28 custom HTTP header bindings keyed by tool name. */
  toolHeaderBindings?: Map<string, McpHttpHeaderBinding[]>;
}

/** Map a JSON-RPC response envelope to the spec § 4.2 output shape —
 * shared by all transports. A server-returned error envelope, or the MCP
 * `CallToolResult.isError` form, maps to `tool_error`; otherwise `result`
 * carries the tool result / resource contents / resource list. */
const envelopeToShape = (
  envelope: JsonRpcResponse,
  isToolCall: boolean,
): { status: 'ok' | 'tool_error'; result: unknown; headers: undefined } => {
  if (envelope.error) {
    return { status: 'tool_error', result: envelope.error, headers: undefined };
  }
  // MCP tools/call reports an invoked-tool failure inside a successful
  // JSON-RPC result (`CallToolResult.isError`), not as a JSON-RPC error
  // envelope. Treating that as `ok` makes downstream result-path extraction
  // hide the real peer refusal behind a misleading "path missing" error.
  if (
    isToolCall
    && envelope.result !== null
    && typeof envelope.result === 'object'
    && !Array.isArray(envelope.result)
    && (envelope.result as { isError?: unknown }).isError === true
  ) {
    return { status: 'tool_error', result: envelope.result, headers: undefined };
  }
  // 2026-07-28 polymorphic results. Recued consumes only `complete`; anything
  // else (today, MRTR's `input_required`) is a request for more input, not an
  // answer, and MUST NOT reach the recipe as one.
  const unsupported = unsupportedMcpResultType(envelope.result);
  if (unsupported !== undefined) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.mcp: server returned an unsupported MCP resultType '${unsupported}' — Recued declares no client capabilities and cannot satisfy a multi-round-trip request`,
      { result_type: unsupported },
    );
  }
  return { status: 'ok', result: envelope.result, headers: undefined };
};

/** Per-dispatch params shared by the websocket + stdio paths (hoisted
 *  above the transport branch in the handler so both reuse one definition). */
interface StreamDispatchParams {
  method: string;
  jsonRpcParams: unknown;
  subject: string;
  subjectMeta: Record<string, string>;
  isWrite: boolean;
  timeoutMs: number;
}

/** Map a websocket / stdio dispatch failure to the ingredient error
 *  taxonomy — identical for both stream transports (the channel either
 *  delivers a JSON-RPC response or fails; there is no HTTP status). A
 *  `tools/call` write that may have committed before the channel died →
 *  ACTION_DELIVERY_UNCERTAIN; an `AbortError`-named cause (timeout) →
 *  STEP_TIMEOUT; otherwise NETWORK_ERROR. An already-classified
 *  IngredientError is rethrown by the caller before reaching here. */
const mapStreamDispatchError = (
  e: unknown,
  record: ConnectionRow,
  call: ResolvedCall,
  d: StreamDispatchParams,
): IngredientError => {
  const isAbort = (e as Error).name === 'AbortError';
  if (d.isWrite) {
    return new IngredientError(
      'ACTION_DELIVERY_UNCERTAIN',
      `MCP write to '${record.name}' ${d.subject} ${isAbort ? `timed out after ${d.timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
      { slug: call.slug, name: record.name, ...d.subjectMeta, cause: isAbort ? 'timeout' : 'network' },
    );
  }
  if (isAbort) {
    return new IngredientError(
      'STEP_TIMEOUT',
      `connection.mcp call to '${record.name}' ${d.subject} timed out after ${d.timeoutMs}ms`,
      { slug: call.slug, name: record.name, ...d.subjectMeta },
    );
  }
  return new IngredientError(
    'NETWORK_ERROR',
    `connection.mcp call to '${record.name}' ${d.subject} failed: ${(e as Error).message}`,
    { slug: call.slug, name: record.name, ...d.subjectMeta },
  );
};

// ────────────────────────────────────────────────────────────────
// Stream transports (websocket §920 / stdio §921) — injected channel
//   + one shared session (JSON-RPC id-correlation + initialize handshake)
// ────────────────────────────────────────────────────────────────

/** Identifies this client in the handshake's `clientInfo`. */
const MCP_CLIENT_INFO = { name: 'recued-connection-mcp', version: '1' } as const;

/** A live, opened bidirectional MCP message channel as the portable
 *  handler sees it — one framed JSON-RPC message per `send` / `onMessage`
 *  event. Both stateful transports satisfy it: a `ws` socket (the bearer
 *  rides the upgrade handshake, §920) and a spawned stdio child
 *  (newline-framed JSON-RPC over stdin/stdout, §921). Deliberately
 *  minimal + transport-agnostic — NOT `ws`'s / `child_process`'s type —
 *  so `packages/ingredients` stays free of those Node-only imports (the
 *  public boundary: nothing in `packages/` imports `backend/`). The boot
 *  site supplies the concrete implementations (`mcp-ws-connector.ts` /
 *  `mcp-stdio-spawner.ts`); tests inject mocks. */
export interface McpStreamHandle {
  /** Send one framed JSON-RPC message (already serialized to a string). */
  send: (data: string) => void;
  /** Register a per-frame text listener. The handler registers exactly
   *  one router that correlates responses by JSON-RPC id. */
  onMessage: (listener: (data: string) => void) => void;
  /** Fires once when the channel closes for any reason (clean or error). */
  onClose: (listener: (info: { code?: number; reason?: string }) => void) => void;
  /** Fires on a channel-level error (may precede / replace `onClose`). */
  onError: (listener: (err: Error) => void) => void;
  /** Close the channel. Idempotent. */
  close: () => void;
}

/** Back-compat alias — the ws connector implements this name. */
export type WsClientHandle = McpStreamHandle;
/** The stdio spawner implements this name (same shape; a spawned child). */
export type StdioClientHandle = McpStreamHandle;

/** Opens a WebSocket to `url`, resolving once the socket is OPEN — the
 *  bearer / custom-auth headers ride in the upgrade handshake per D-125
 *  §920/§339. Rejects on connect failure / non-101 response / abort (the
 *  caller maps the rejection to the ingredient error taxonomy; an
 *  `AbortError`-named rejection → STEP_TIMEOUT). The implementation MUST
 *  NOT follow cross-origin redirects — the WS equivalent of the sse
 *  path's `fetchOriginPinned` origin pinning. */
export type WsConnect = (
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<WsClientHandle>;

/** Spawns a stdio MCP child process (D-125 §921), resolving once the
 *  child has started (the MCP server reads the `initialize` request from
 *  stdin when ready; the OS pipe buffers it). Rejects on spawn failure
 *  (ENOENT, …) or abort. The implementation MUST use `shell: false` + an
 *  explicit args array (no shell parsing) and curate a minimal env
 *  (PATH/HOME + the record's `config.env`). The command is user-enrolled
 *  (Settings → Connections), never pack-injected — see the handler. */
export type StdioSpawn = (
  spec: { command: string; args: string[]; env?: Record<string, string> },
  opts: { signal?: AbortSignal },
) => Promise<StdioClientHandle>;

/** Open the two-endpoint HTTP+SSE transport defined by MCP 2024-11-05.
 * The GET stream announces the message endpoint and carries responses; each
 * outbound JSON-RPC message is POSTed to that same-origin endpoint. */
const openLegacyMcpSseHandle = async (
  fetchImpl: typeof fetch,
  endpointUrl: URL,
  baseHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<McpStreamHandle> => {
  const controller = new AbortController();
  const messageListeners: Array<(data: string) => void> = [];
  const closeListeners: Array<(info: { code?: number; reason?: string }) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  let closed = false;
  let messageEndpoint: URL | undefined;
  let endpointResolve: (() => void) | undefined;
  let endpointReject: ((error: Error) => void) | undefined;
  const endpointReady = new Promise<void>((resolve, reject) => {
    endpointResolve = resolve;
    endpointReject = reject;
  });
  const close = (reason = 'client closed'): void => {
    if (closed) return;
    closed = true;
    controller.abort();
    for (const listener of closeListeners) listener({ reason });
  };
  const fail = (error: Error): void => {
    if (closed) return;
    for (const listener of errorListeners) listener(error);
    endpointReject?.(error);
    close(error.message);
  };

  let streamResponse: Response;
  try {
    streamResponse = await fetchOriginPinned(fetchImpl, endpointUrl.toString(), {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    }, endpointUrl.origin);
  } catch (error) {
    controller.abort();
    throw error;
  }
  if (!streamResponse.ok) {
    discardResponseBody(streamResponse);
    controller.abort();
    throw new Error(
      `MCP legacy SSE endpoint returned ${streamResponse.status} ${streamResponse.statusText}`,
    );
  }
  if (!(streamResponse.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
    discardResponseBody(streamResponse);
    controller.abort();
    throw new Error('MCP legacy endpoint did not return text/event-stream');
  }

  void consumeMcpSse(streamResponse, ({ event, data }) => {
    if (event === 'endpoint') {
      try {
        const candidate = new URL(data, endpointUrl);
        if (candidate.origin !== endpointUrl.origin) {
          throw new Error('MCP legacy message endpoint changed origin');
        }
        // Query-auth credentials installed on the enrolled endpoint remain
        // client-owned even when the server announces a session-specific
        // message path. Never overwrite the server's own query keys.
        for (const [key, value] of endpointUrl.searchParams) {
          if (!candidate.searchParams.has(key)) candidate.searchParams.set(key, value);
        }
        messageEndpoint = candidate;
        endpointResolve?.();
      } catch (error) {
        fail(error as Error);
      }
      return false;
    }
    if (event === undefined || event === 'message') {
      for (const listener of messageListeners) listener(data);
    }
    return false;
  }, false).then(
    () => close('legacy SSE stream ended'),
    (error: unknown) => {
      if (!closed) fail(error as Error);
    },
  );

  const timer = setTimeout(() => {
    const error = new Error(`MCP legacy SSE endpoint event timed out after ${timeoutMs}ms`);
    error.name = 'AbortError';
    fail(error);
  }, timeoutMs);
  try {
    await endpointReady;
  } finally {
    clearTimeout(timer);
  }

  return {
    send(data) {
      if (closed || messageEndpoint === undefined) {
        throw new Error('MCP legacy SSE session is closed');
      }
      void fetchOriginPinned(fetchImpl, messageEndpoint.toString(), {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: data,
        signal: controller.signal,
      }, endpointUrl.origin).then(async (response) => {
        if (!response.ok) {
          discardResponseBody(response);
          throw new Error(
            `MCP legacy message endpoint returned ${response.status} ${response.statusText}`,
          );
        }
        // The 2024 transport returns 202 and delivers the response on the GET
        // stream. Preserve interoperability with lenient one-endpoint servers
        // that return a JSON-RPC response directly from POST.
        if (response.status !== 202 && response.status !== 204) {
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          if (contentType.includes('application/json')) {
            const read = await readBoundedResponseText(response);
            for (const listener of messageListeners) listener(read.text);
            return;
          }
        }
        discardResponseBody(response);
      }).catch((error: unknown) => {
        if (!closed) fail(error as Error);
      });
    },
    onMessage(listener) { messageListeners.push(listener); },
    onClose(listener) { closeListeners.push(listener); },
    onError(listener) { errorListeners.push(listener); },
    close: () => close(),
  };
};

/** A long-lived MCP session over one stream channel (a `ws` socket or a
 *  stdio child), bound to one pooled connection record. Owns the JSON-RPC
 *  request/response correlation (by `id`) over the multiplexed channel +
 *  the one-time `initialize` handshake. A closed / errored channel rejects
 *  every in-flight request and latches the session dead so the pool evicts
 *  + reopens it. Transport-agnostic — it touches only `McpStreamHandle`. */
class McpStreamSession {
  private readonly pending = new Map<number, {
    resolve: (v: JsonRpcResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private closed = false;
  private closeError: Error | null = null;
  private initFlight: Promise<void> | null = null;
  private initialized = false;
  private selectedProtocolVersion: RecuedMcpProtocolVersion | undefined;

  constructor(private readonly handle: McpStreamHandle) {
    handle.onMessage((data) => this.routeMessage(data));
    handle.onClose((info) => this.fail(
      `MCP session closed${info.reason ? `: ${info.reason}` : ''}`
      + `${typeof info.code === 'number' ? ` (code ${info.code})` : ''}`,
    ));
    handle.onError((err) => this.fail(`MCP session error: ${err.message}`));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True while ≥1 request is awaiting a response. The idle reaper skips
   *  a session with in-flight work so a long call isn't torn out from
   *  under itself (today MAX_TIMEOUT_MS 2 min < the 5-min idle window, so
   *  this is belt-and-suspenders — but it makes the invariant explicit
   *  + robust if either bound changes). */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get protocolVersion(): RecuedMcpProtocolVersion | undefined {
    return this.selectedProtocolVersion;
  }

  selectProtocolVersion(version: RecuedMcpProtocolVersion): void {
    if (
      this.selectedProtocolVersion !== undefined
      && this.selectedProtocolVersion !== version
    ) {
      throw new Error(
        `MCP session protocol changed from ${this.selectedProtocolVersion} to ${version}`,
      );
    }
    this.selectedProtocolVersion = version;
  }

  /** Route one inbound frame to its waiting request by JSON-RPC id.
   *  Unparseable frames, notifications (no numeric id), and responses to
   *  already-settled requests are ignored — a multiplexed socket sees
   *  all three legitimately. */
  private routeMessage(data: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = this.pending.get(msg.id);
    if (waiter === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  }

  /** Tear down on close / error: reject every in-flight request with a
   *  non-abort error (→ NETWORK_ERROR / ACTION_DELIVERY_UNCERTAIN at the
   *  handler) + latch the session dead. Idempotent. */
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = new Error(reason);
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.closeError);
    }
    this.pending.clear();
    // Close the underlying channel. ws emits 'close' AFTER 'error' (so
    // this is a no-op then); a stdio child's 'error' likewise precedes
    // 'exit'. But an 'error'-without-'close' would otherwise leak the
    // socket / child — the pool drops the entry on `isClosed`, so without
    // this the fd / process would dangle. Idempotent (the channel's
    // close() swallows already-closed).
    try { this.handle.close(); } catch { /* idempotent */ }
  }

  /** Send a JSON-RPC request + await the response correlated by `id`.
   *  Rejects with an `AbortError`-named error on timeout (→ STEP_TIMEOUT)
   *  or the close error if the channel dies first (→ NETWORK_ERROR). */
  request(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error('MCP session is closed'));
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`MCP request timed out after ${timeoutMs}ms`);
        err.name = 'AbortError';
        reject(err);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.handle.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  /** Dispatch one ordinary MCP request using the selected era's wire shape. */
  requestMcp(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    if (this.selectedProtocolVersion === undefined) {
      return Promise.reject(new Error('MCP request attempted before version negotiation'));
    }
    return this.request(
      id,
      method,
      this.selectedProtocolVersion === MCP_MODERN_PROTOCOL_VERSION
        ? withModernMcpRequestMeta(params, MCP_CLIENT_INFO)
        : params,
      timeoutMs,
    );
  }

  /** Run the MCP `initialize` handshake at most once per session;
   *  concurrent callers share the single in-flight handshake. After a
   *  successful initialize, fire the `notifications/initialized` message
   *  the spec requires for a stateful transport (best-effort — a lenient
   *  server services `tools/call` without it; the stateless sse probe
   *  skips it entirely). A failed handshake clears the flight so a fresh
   *  socket can retry. */
  ensureLegacyInitialized(allocId: () => number, timeoutMs: number): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initFlight !== null) return this.initFlight;
    const flight = (async () => {
      const resp = await this.request(allocId(), 'initialize', {
        protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      }, timeoutMs);
      if (resp.error) {
        throw new Error(`MCP initialize failed: ${resp.error.message}`);
      }
      const selected = selectMcpLegacyInitializeVersion(resp.result);
      if (selected === undefined) {
        const returned = resp.result !== null && typeof resp.result === 'object'
          ? (resp.result as { protocolVersion?: unknown }).protocolVersion
          : undefined;
        throw new Error(
          `MCP initialize selected unsupported protocol version '${String(returned)}'`,
        );
      }
      this.selectProtocolVersion(selected);
      try {
        this.handle.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      } catch {
        // best-effort notification — see JSDoc.
      }
      this.initialized = true;
    })();
    flight.catch(() => { this.initFlight = null; });
    this.initFlight = flight;
    return flight;
  }

  /** Close the channel + latch dead (`fail` closes the handle). */
  close(): void {
    this.fail('client closed');
  }
}

/** Modern-first stream negotiation. The discovery connection is disposable on
 * fallback because some legacy stdio servers exit when their first request is
 * not `initialize`, while others return a normal method-not-found response.
 * Opening a fresh legacy connection handles both behaviors and prevents a
 * partially observed modern probe from contaminating the legacy lifecycle. */
const openNegotiatedMcpStreamSession = async (
  open: () => Promise<McpStreamHandle>,
  allocId: () => number,
  timeoutMs: number,
  clientInfo: McpImplementationInfo = MCP_CLIENT_INFO,
): Promise<McpStreamSession> => {
  let modernSession: McpStreamSession | undefined;
  let modernProtocolError: Error | undefined;
  try {
    modernSession = new McpStreamSession(await open());
    const discover = await modernSession.request(
      allocId(),
      'server/discover',
      { _meta: modernMcpRequestMeta(clientInfo) },
      Math.min(timeoutMs, MCP_NEGOTIATION_PROBE_TIMEOUT_MS),
    );
    if (
      discover.jsonrpc === '2.0'
      && discover.error === undefined
      && selectMcpDiscoverVersion(discover.result) === MCP_MODERN_PROTOCOL_VERSION
    ) {
      modernSession.selectProtocolVersion(MCP_MODERN_PROTOCOL_VERSION);
      return modernSession;
    }
    if (isModernMcpProtocolError(discover)) {
      modernProtocolError = new Error(
        `MCP modern version negotiation failed: ${discover.error?.message ?? 'protocol error'}`,
      );
    }
  } catch {
    // No positive modern evidence: retry on a fresh connection using the
    // legacy lifecycle. Auth/server failures during ordinary calls still fail
    // normally; this catch is confined to the version probe.
  }
  modernSession?.close();
  if (modernProtocolError !== undefined) throw modernProtocolError;

  const legacySession = new McpStreamSession(await open());
  try {
    await legacySession.ensureLegacyInitialized(allocId, timeoutMs);
    return legacySession;
  } catch (error) {
    legacySession.close();
    throw error;
  }
};

/** Result of a short-lived MCP stream probe. JSON-RPC error envelopes are
 *  returned as data so the connection health layer can preserve its existing
 *  `auth_failed` classification; transport/open/request failures still throw
 *  and are classified as unreachable by that layer. */
export type McpStreamProbeResult =
  | { ok: true; tools: string[]; descriptors: McpToolDescriptor[] }
  | {
      ok: false;
      stage: 'initialize' | 'tools_list';
      reason:
        | 'jsonrpc_error'
        | 'invalid_response'
        | 'pagination_cycle'
        | 'pagination_limit';
    };

/** Hard ceiling for a malicious/broken server that emits an endless chain of
 *  unique cursors. The overall probe deadline is the primary bound; this cap
 *  also keeps a zero-latency in-process server from spinning forever. */
export const MCP_TOOL_LIST_PROBE_MAX_PAGES = 100;

export type McpToolListPageResult =
  | { ok: true; tools: string[]; descriptors: McpToolDescriptor[]; nextCursor?: string }
  | { ok: false };

/** Validate one MCP `tools/list` result page. Tool names form an enforcement
 *  cache, so a malformed/partial page must fail the probe rather than produce
 *  an incomplete allow-list that later rejects a valid tool. `nextCursor` is
 *  opaque; an empty string is valid when the property is present. */
export const parseMcpToolListPage = (
  result: unknown,
  options: { validateHttpHeaders?: boolean } = {},
): McpToolListPageResult => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false };
  }
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.tools)) return { ok: false };
  const tools: string[] = [];
  // D-225 Slice 2 — retain the DESCRIPTOR, not just the name. A generated pack
  // is minted from `{ name, input_schema }`, and the grant identity it derives
  // is a hash over that pair — so a probe that kept only names would leave the
  // generator unable to distinguish a tool from the same tool with a different
  // argument shape. `tools` is preserved verbatim alongside because it is
  // PERSISTED (`ConnectionHealth.tools`) and read by the dispatch-time
  // pre-validation; widening the stored element type would have made every
  // already-stored row unreadable.
  const descriptors: McpToolDescriptor[] = [];
  for (const tool of record.tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return { ok: false };
    const entry = tool as Record<string, unknown>;
    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0) return { ok: false };
    const descriptor: McpToolDescriptor = { name };
    if (typeof entry.description === 'string') descriptor.description = entry.description;
    // MCP publishes `inputSchema`; the stored shape is snake_case.
    if (entry.inputSchema !== undefined) descriptor.input_schema = entry.inputSchema;
    // Carried for DISPLAY only — never for tiering. It is the server's claim
    // about its own tool, so nothing that gates may read it (see
    // `GENERATED_RISK` in `@recued/ingredient-authoring`'s mcp-pack).
    const annotations = entry.annotations;
    if (annotations !== null && typeof annotations === 'object' && !Array.isArray(annotations)) {
      const hint = (annotations as Record<string, unknown>).destructiveHint;
      if (typeof hint === 'boolean') descriptor.destructive_hint = hint;
      const readOnly = (annotations as Record<string, unknown>).readOnlyHint;
      if (typeof readOnly === 'boolean') descriptor.read_only_hint = readOnly;
    }
    // The 2026-07-28 HTTP transport requires clients to exclude a tool whose
    // custom-header annotations are invalid. Stream transports may ignore the
    // extension, so HTTP probes opt into this check.
    if (options.validateHttpHeaders === true) {
      const headerSchema = mcpHttpHeaderBindingsFromSchema(entry.inputSchema);
      if (!headerSchema.ok) continue;
    }
    tools.push(name);
    descriptors.push(descriptor);
  }
  if (Object.prototype.hasOwnProperty.call(record, 'nextCursor')) {
    if (typeof record.nextCursor !== 'string') return { ok: false };
    return { ok: true, tools, descriptors, nextCursor: record.nextCursor };
  }
  return { ok: true, tools, descriptors };
};

const streamProbeTimeoutError = (timeoutMs: number): Error => {
  const err = new Error(`MCP stream probe timed out after ${timeoutMs}ms`);
  err.name = 'AbortError';
  return err;
};

/** Open disposable websocket / stdio MCP channels, negotiate modern-first with
 *  legacy initialization fallback, enumerate tools, then close. This deliberately
 *  shares `McpStreamSession` with live MCP execution so message framing,
 *  response-id correlation, timeout behavior, and close/error handling cannot
 *  drift between "Probe" and a real recipe run. The opener owns transport and
 *  auth details; the helper owns protocol lifecycle and leak-safe teardown. */
export const probeMcpStreamTools = async (
  open: (signal: AbortSignal) => Promise<McpStreamHandle>,
  timeoutMs: number,
): Promise<McpStreamProbeResult> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw streamProbeTimeoutError(timeoutMs);
  }
  const deadline = Date.now() + timeoutMs;
  const remainingMs = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw streamProbeTimeoutError(timeoutMs);
    return remaining;
  };
  const openBounded = async (): Promise<McpStreamHandle> => {
    const controller = new AbortController();
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const openPromise = open(controller.signal).then((handle) => {
      if (controller.signal.aborted) {
        try { handle.close(); } catch { /* already closed */ }
        throw streamProbeTimeoutError(timeoutMs);
      }
      return handle;
    });
    const openTimeout = new Promise<never>((_resolve, reject) => {
      openTimer = setTimeout(() => {
        controller.abort();
        reject(streamProbeTimeoutError(timeoutMs));
      }, remainingMs());
    });
    try {
      return await Promise.race([openPromise, openTimeout]);
    } finally {
      if (openTimer !== undefined) clearTimeout(openTimer);
    }
  };

  let nextProbeRequestId = 1;
  const allocProbeRequestId = (): number => nextProbeRequestId++;
  let session: McpStreamSession;
  try {
    session = await openNegotiatedMcpStreamSession(
      openBounded,
      allocProbeRequestId,
      remainingMs(),
      { name: 'recued-connection-probe', version: '1' },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('MCP initialize failed:')) {
      return { ok: false, stage: 'initialize', reason: 'jsonrpc_error' };
    }
    if (message.startsWith('MCP initialize selected unsupported')) {
      return { ok: false, stage: 'initialize', reason: 'invalid_response' };
    }
    throw error;
  }
  try {
    const tools = new Set<string>();
    // D-225 Slice 2 — carried beside the name set so a caller can derive
    // descriptor hashes (drift detection) without a second round trip. Deduped
    // on NAME, matching the name set: a server repeating a tool across pages
    // must not produce two descriptors that then look like drift.
    const descriptors = new Map<string, McpToolDescriptor>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MCP_TOOL_LIST_PROBE_MAX_PAGES; pageIndex += 1) {
      const toolsList = await session.requestMcp(
        allocProbeRequestId(),
        'tools/list',
        cursor === undefined ? {} : { cursor },
        remainingMs(),
      );
      if (toolsList.jsonrpc !== '2.0') {
        return { ok: false, stage: 'tools_list', reason: 'invalid_response' };
      }
      if (toolsList.error !== undefined) {
        return { ok: false, stage: 'tools_list', reason: 'jsonrpc_error' };
      }
      const page = parseMcpToolListPage(toolsList.result);
      if (!page.ok) {
        return { ok: false, stage: 'tools_list', reason: 'invalid_response' };
      }
      for (const name of page.tools) tools.add(name);
      for (const d of page.descriptors) if (!descriptors.has(d.name)) descriptors.set(d.name, d);
      if (page.nextCursor === undefined) {
        return { ok: true, tools: [...tools], descriptors: [...descriptors.values()] };
      }
      if (seenCursors.has(page.nextCursor)) {
        return { ok: false, stage: 'tools_list', reason: 'pagination_cycle' };
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return { ok: false, stage: 'tools_list', reason: 'pagination_limit' };
  } finally {
    session.close();
  }
};

/** Probe a conforming 2024-11-05 two-endpoint HTTP+SSE server. This is the
 * fallback used by the backend health probe after modern discovery fails. */
export const probeMcpLegacySseTools = async (
  fetchImpl: typeof fetch,
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<McpStreamProbeResult> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw streamProbeTimeoutError(timeoutMs);
  }
  const deadline = Date.now() + timeoutMs;
  const remainingMs = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw streamProbeTimeoutError(timeoutMs);
    return remaining;
  };
  let nextId = 1;
  const session = new McpStreamSession(await openLegacyMcpSseHandle(
    fetchImpl,
    new URL(endpoint),
    headers,
    remainingMs(),
  ));
  try {
    try {
      await session.ensureLegacyInitialized(() => nextId++, remainingMs());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        stage: 'initialize',
        reason: message.includes('unsupported protocol version')
          ? 'invalid_response'
          : 'jsonrpc_error',
      };
    }
    const tools = new Set<string>();
    const descriptors = new Map<string, McpToolDescriptor>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MCP_TOOL_LIST_PROBE_MAX_PAGES; pageIndex += 1) {
      const response = await session.requestMcp(
        nextId++,
        'tools/list',
        cursor === undefined ? {} : { cursor },
        remainingMs(),
      );
      if (response.jsonrpc !== '2.0') {
        return { ok: false, stage: 'tools_list', reason: 'invalid_response' };
      }
      if (response.error !== undefined) {
        return { ok: false, stage: 'tools_list', reason: 'jsonrpc_error' };
      }
      const page = parseMcpToolListPage(response.result);
      if (!page.ok) {
        return { ok: false, stage: 'tools_list', reason: 'invalid_response' };
      }
      for (const tool of page.tools) tools.add(tool);
      for (const descriptor of page.descriptors) {
        if (!descriptors.has(descriptor.name)) descriptors.set(descriptor.name, descriptor);
      }
      if (page.nextCursor === undefined) {
        return { ok: true, tools: [...tools], descriptors: [...descriptors.values()] };
      }
      if (seenCursors.has(page.nextCursor)) {
        return { ok: false, stage: 'tools_list', reason: 'pagination_cycle' };
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return { ok: false, stage: 'tools_list', reason: 'pagination_limit' };
  } finally {
    session.close();
  }
};

export interface ConnectionMcpHandlerDeps {
  /** Decrypt at-rest `auth_ciphertext` to a typed `ConnectionAuth`.
   *  Boot site closes over `decodeAuthFromStorage` from
   *  `backend/server/src/connection-handler.ts` + the connection
   *  sub-DEK; tests inject a stub returning a synthetic auth. */
  decodeAuth: (row: ConnectionRow) => Promise<ConnectionAuth>;

  /** Persist a refreshed OAuth2 auth back to the connection store — the same
   *  re-encode-and-upsert the api handler uses (D-125 P4.1). Optional ONLY for
   *  dbless harnesses / read-only previews: when absent the refresh still runs
   *  but the rotated auth isn't written back, so if the issuer ROTATED the
   *  `refresh_token` the next refresh can fail closed (the old token may be
   *  revoked). Production boot always supplies it. */
  persistAuth?: EnsureFreshAuthDeps['persistAuth'];

  /** D-232 § 22 — write the connection's health back after a dispatch.
   *
   *  ⚠ OPTIONAL FOR HARNESSES, LOAD-BEARING IN PRODUCTION. Omitting it means
   *  health is written only by the manual probe, which is the state this exists
   *  to end: a connection that fails every call still reading `ok` from whenever
   *  someone last pressed the button. Wired in `wire-executor-config`.
   *
   *  Never called for a `call_failed` outcome — see `foldConnectionDispatchHealth`,
   *  which returns null there so a refused call cannot refresh `last_probed_at`
   *  and make the connection look freshly verified. */
  persistHealth?: (name: string, health: ConnectionHealth) => Promise<void>;

  /** Advisory sink for a refreshed credential that could not be written back.
   * The in-flight MCP call still uses the fresh token; production records the
   * storage failure without exposing credential material. */
  onPersistFailure?: EnsureFreshAuthDeps['onPersistFailure'];

  /** fetch implementation. Defaults to `globalThis.fetch`. Tests
   *  inject a stub that returns canned responses to assert wire-shape
   *  construction + auth injection + JSON-RPC envelope handling. */
  fetchImpl?: typeof fetch;

  /** Wall-clock source. Defaults to `Date.now`. Tests inject a
   *  deterministic stub to pin idle-teardown semantics + per-call
   *  duration math. */
  now?: () => number;

  /** Idle timeout override (ms). Defaults to
   *  `MCP_CLIENT_IDLE_TIMEOUT_MS` (5 min). Tests use a small value
   *  to assert the reaper without slowing the suite. */
  idleTimeoutMs?: number;

  /** Open a WebSocket for `transport: 'websocket'` connections (D-125
   *  §920). The server boot site supplies a `ws`-backed connector that
   *  sets the bearer / custom-auth headers in the upgrade handshake — the
   *  WHATWG `WebSocket` global can't set request headers, so this can't be
   *  a portable default. Absent in runtimes that can't open raw
   *  header-bearing WebSockets (the ext, dbless harnesses): a `websocket`
   *  dispatch there surfaces `MCP_TRANSPORT_NOT_IMPLEMENTED`. */
  wsConnect?: WsConnect;

  /** Spawn a stdio MCP child process for `transport: 'stdio'` connections
   *  (D-125 §921). The server boot site supplies a `child_process`-backed
   *  spawner (`shell: false`, curated minimal env) — `child_process` is
   *  Node-only, so this can't be a portable default. Absent in runtimes
   *  that can't fork processes (the ext, dbless harnesses): a `stdio`
   *  dispatch there surfaces `MCP_TRANSPORT_NOT_IMPLEMENTED`. */
  spawnStdioMcp?: StdioSpawn;
}

const readEndpoint = (row: ConnectionRow, transport: McpTransport): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.mcp: malformed config_json for connection '${row.name}'`,
      { name: row.name },
    );
  }
  const config = parsed as Record<string, unknown> | null;
  const endpoint = config?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.mcp: connection '${row.name}' has no endpoint in config (re-enroll in Settings → Connections)`,
      { name: row.name, transport },
    );
  }
  return endpoint;
};

const STDIO_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface StdioMcpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type StdioMcpLaunchSpecResult =
  | { ok: true; spec: StdioMcpLaunchSpec }
  | {
      ok: false;
      code:
        | 'missing_command'
        | 'command_must_be_absolute_or_bare'
        | 'args_must_be_strings'
        | 'env_must_be_strings';
      message: string;
    };

/** Validate the user-enrolled stdio launch object once for both live execution
 *  and manual probing. Besides shape checks, this strips prototype-sensitive
 *  env keys before the object reaches the Node spawner. */
export const resolveStdioMcpLaunchSpec = (
  config: Record<string, unknown>,
): StdioMcpLaunchSpecResult => {
  const command = config.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      ok: false,
      code: 'missing_command',
      message: 'stdio transport requires a non-empty config.command (re-enroll in Settings → Connections)',
    };
  }
  const cmd = command.trim();
  if (cmd.includes('/') && !cmd.startsWith('/')) {
    return {
      ok: false,
      code: 'command_must_be_absolute_or_bare',
      message: `stdio config.command must be an absolute path or a bare executable name (got a relative path '${cmd}')`,
    };
  }

  let args: string[] = [];
  const rawArgs = config.args;
  if (rawArgs !== undefined && rawArgs !== null) {
    if (!Array.isArray(rawArgs) || !rawArgs.every((arg) => typeof arg === 'string')) {
      return {
        ok: false,
        code: 'args_must_be_strings',
        message: 'stdio config.args must be an array of strings',
      };
    }
    args = rawArgs as string[];
  }

  let env: Record<string, string> | undefined;
  const rawEnv = config.env;
  if (rawEnv !== undefined && rawEnv !== null) {
    if (
      typeof rawEnv !== 'object' ||
      Array.isArray(rawEnv) ||
      !Object.values(rawEnv as Record<string, unknown>)
        .every((value) => typeof value === 'string')
    ) {
      return {
        ok: false,
        code: 'env_must_be_strings',
        message: 'stdio config.env must be an object of string values',
      };
    }
    env = {};
    for (const [key, value] of Object.entries(rawEnv as Record<string, string>)) {
      if (!STDIO_PROTOTYPE_KEYS.has(key)) env[key] = value;
    }
  }

  return {
    ok: true,
    spec: env === undefined ? { command: cmd, args } : { command: cmd, args, env },
  };
};

/** Read + validate the stdio launch config (`config.command` / `config.args`
 *  / `config.env`). The command is user-enrolled (Settings → Connections) —
 *  never pack-injected (packs reference connections by name, they don't carry
 *  executable config) — so the surface is "the user chose to run this local
 *  MCP server"; the spawner keeps `shell: false` so there is no
 *  shell-injection. Accepts an absolute path (`/usr/local/bin/mcp-server`) OR
 *  a bare PATH-resolved name (`npx` / `uvx` / `node` — the common MCP launch
 *  pattern); rejects a relative-with-slash command (cwd-dependent, ambiguous). */
const readStdioCommand = (
  row: ConnectionRow,
  call: ResolvedCall,
): StdioMcpLaunchSpec => {
  const fail = (msg: string): never => {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.mcp: ${msg} for connection '${row.name}'`,
      { slug: call.slug, name: row.name },
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    return fail('malformed config_json');
  }
  const config = (parsed as Record<string, unknown> | null) ?? {};
  const resolved = resolveStdioMcpLaunchSpec(config);
  return resolved.ok ? resolved.spec : fail(resolved.message);
};

const readHealth = (row: ConnectionRow): ConnectionHealth | undefined => {
  if (row.health_json === undefined) return undefined;
  try {
    const parsed = JSON.parse(row.health_json) as ConnectionHealth;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Malformed health JSON — treat as absent. The probe will
    // overwrite on next run, and the handler proceeds without
    // pre-validation rather than failing the call.
  }
  return undefined;
};

const isMcpTransport = (v: unknown): v is McpTransport =>
  typeof v === 'string' && KNOWN_TRANSPORTS.has(v as McpTransport);

const getTransport = (row: ConnectionRow): McpTransport => {
  if (isMcpTransport(row.subtype)) return row.subtype;
  // Fall back to config.transport for legacy enrollments where
  // subtype wasn't stamped at row time. New enrollments always set
  // subtype on the connection row (P2.1 enroll handler).
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    parsed = null;
  }
  const fromConfig = (parsed as Record<string, unknown> | null)?.transport;
  if (isMcpTransport(fromConfig)) return fromConfig;
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.mcp: connection '${row.name}' has no transport (expected sse / websocket / stdio)`,
    { name: row.name },
  );
};

/** Inject auth into request headers per spec § A.5. For HTTP-based
 *  transports (sse, the streamable-HTTP variant we ship today): bearer
 *  token in `Authorization`, custom header for type=header, query
 *  param for type=query (mounted on the URL by the caller).
 *
 *  `oauth2_refresh` auth reaches here ALREADY refreshed — the dispatch runs
 *  `ensureFreshAuth` (the `createEnsureFreshAuth` gate shared with
 *  connection.api) before injection, so `current_access_token` is live (or the
 *  refresh threw `TOKEN_REFRESH_FAILED` and never reached this point). The
 *  `OAUTH_EXPIRED` throw below is now only a defensive fallback for the
 *  never-acquired-and-not-refreshable case. */
const authTypeOf = (auth: ConnectionAuth): string => {
  const raw = (auth as { type?: unknown }).type;
  return typeof raw === 'string' ? raw : String(raw);
};

const requireAuthString = (
  auth: ConnectionAuth,
  field: string,
): string => {
  const value = (auth as unknown as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.mcp: auth.${field} is required for auth.type='${authTypeOf(auth)}'`,
      { auth_type: authTypeOf(auth), field },
    );
  }
  return value;
};

const requireAuthNameString = (
  auth: ConnectionAuth,
  field: string,
): string => {
  const value = requireAuthString(auth, field);
  if (PROTOTYPE_SENSITIVE_KEYS.has(value)) {
    throw new IngredientError(
      'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      `connection.mcp: auth.${field} cannot be a reserved object key`,
      { auth_type: authTypeOf(auth), field },
    );
  }
  return value;
};

const injectAuthHeaders = (
  auth: ConnectionAuth,
  headers: Record<string, string>,
  url: URL,
): void => {
  switch (auth.type) {
    case 'none':
      return;
    case 'bearer':
      headers['Authorization'] = `Bearer ${requireAuthString(auth, 'token')}`;
      return;
    case 'basic': {
      const b64 = btoa(
        `${requireAuthString(auth, 'username')}:${requireAuthString(auth, 'password')}`,
      );
      headers['Authorization'] = `Basic ${b64}`;
      return;
    }
    case 'header': {
      const res = validateHeaderAuthEntries(auth.headers);
      if (!res.ok) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.mcp: auth.headers ${describeHeaderAuthIssue(res.issue)}`,
          { auth_type: 'header' },
        );
      }
      // `res.entries` header names are proto-safe (validated), so the plain-object
      // assignment below cannot pollute the prototype.
      for (const h of res.entries) headers[h.header_name] = h.value;
      return;
    }
    case 'query':
      url.searchParams.set(requireAuthNameString(auth, 'param_name'), requireAuthString(auth, 'value'));
      return;
    case 'oauth2_refresh':
    case 'oauth2_client_credentials':
      if (
        typeof auth.current_access_token !== 'string' ||
        auth.current_access_token.trim() === ''
      ) {
        throw new IngredientError(
          'OAUTH_EXPIRED',
          'connection.mcp: OAuth2 access token unavailable after refresh — reconnect the account',
          { auth_type: auth.type },
        );
      }
      headers['Authorization'] = `Bearer ${auth.current_access_token}`;
      return;
  }
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.mcp: unsupported auth.type '${authTypeOf(auth)}'`,
    { auth_type: authTypeOf(auth) },
  );
};

/** The MCP operation a dispatch resolves to. `tool` is the founding op
 *  (`tools/call`); `resource_read` / `resource_list` are the read-only
 *  resource primitives (`resources/read` by uri, `resources/list`) — the
 *  poll-source's fetch reads a resource and diffs it. Exactly one is
 *  selected by the input params; `tool` wins if present (backward-compat
 *  with every existing caller). */
type McpOperation =
  | { mode: 'tool'; tool: string; args: Record<string, unknown> }
  | { mode: 'resource_read'; uri: string }
  | { mode: 'resource_list' };

const resolveMcpOperation = (
  params: Record<string, unknown>,
  record: ConnectionRow,
  call: ResolvedCall,
): McpOperation => {
  const meta = { slug: call.slug, name: record.name };
  // Tool call — presence of `tool` selects it. Validated exactly as
  // before so every existing caller's diagnostics are unchanged.
  if (params.tool !== undefined) {
    const tool = params.tool;
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.mcp: 'tool' is required (got ${typeof tool})`,
        meta,
      );
    }
    const args = params.args;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.mcp: 'args' must be an object when present (got ${typeof args})`,
        meta,
      );
    }
    return { mode: 'tool', tool, args: (args as Record<string, unknown>) ?? {} };
  }
  // Resource read — by uri. Read-only; the wrapper recipe declares the
  // read risk tier, so the adapter's write-uncertainty path stays off.
  if (params.resource !== undefined) {
    const uri = params.resource;
    if (typeof uri !== 'string' || uri.trim() === '') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.mcp: 'resource' must be a non-empty URI string (got ${typeof uri})`,
        meta,
      );
    }
    return { mode: 'resource_read', uri };
  }
  // Resource enumeration — `resources_list: true`.
  if (params.resources_list === true) {
    return { mode: 'resource_list' };
  }
  throw new IngredientError(
    'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    `connection.mcp: one of 'tool', 'resource', or 'resources_list' is required`,
    meta,
  );
};

/** The JSON-RPC method + params + a human subject label for an op. */
const wireForOperation = (
  op: McpOperation,
): { method: string; jsonRpcParams: unknown; subject: string } => {
  switch (op.mode) {
    case 'tool':
      return {
        method: 'tools/call',
        jsonRpcParams: { name: op.tool, arguments: op.args },
        subject: `tool '${op.tool}'`,
      };
    case 'resource_read':
      return {
        method: 'resources/read',
        jsonRpcParams: { uri: op.uri },
        subject: `resource '${op.uri}'`,
      };
    case 'resource_list':
      return { method: 'resources/list', jsonRpcParams: {}, subject: 'resources/list' };
  }
};

let nextRequestId = 1;

/** Build the mcp handler bound to per-runtime deps. The returned
 *  `ConnectionKindHandler` is registered at the boot site:
 *
 *    createConnectionAdapter({
 *      store,
 *      handlers: {
 *        api: createConnectionApiHandler({...}),
 *        mcp: createConnectionMcpHandler({...}),
 *      },
 *      ...
 *    })
 *
 *  The pool map is closed over the factory call — one map per handler
 *  instance, scoped to one runtime. Server + ext get separate pools;
 *  that's correct: each runtime maintains its own client lifecycle.
 *  Idle teardown runs lazily at every dispatch entry — no setInterval,
 *  so a quiet handler doesn't keep the event loop alive. */
export const createConnectionMcpHandler = (
  deps: ConnectionMcpHandlerDeps,
): ConnectionKindHandler => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const idleTimeoutMs = deps.idleTimeoutMs ?? MCP_CLIENT_IDLE_TIMEOUT_MS;
  // Shared OAuth2 refresh gate (same single-flight impl as connection.api).
  // The no-op persist runs only when the boot site supplies none (dbless
  // harnesses / previews); a real refresh there would lose an issuer-rotated
  // `refresh_token`. Production boot (wire-executor-config) always supplies
  // persistAuth, so the no-op never runs on a live refresh path.
  const ensureFreshAuth = createEnsureFreshAuth({
    persistAuth: deps.persistAuth ?? (async () => {}),
    fetchImpl,
    now,
    ...(deps.onPersistFailure ? { onPersistFailure: deps.onPersistFailure } : {}),
  });

  // Per-record client state. Modern HTTP entries are bookkeeping; legacy
  // HTTP+SSE, websocket, and stdio entries carry a live stream session.
  const clientPool = new Map<string, McpClient>();
  // Single-flight session open per record — two concurrent dispatches to
  // the same record share one ws-connect / stdio-spawn + initialize rather
  // than racing two channels. Keyed by record.pk; the entry carries the
  // `targetKey` (endpoint / command signature) so a join only happens for
  // the SAME target — a concurrent re-enrollment that changed the target
  // must NOT receive a session pointed at the old one. Shared across
  // transports (a record is one transport at a time).
  const openFlight = new Map<string, { targetKey: string; flight: Promise<McpStreamSession> }>();

  const reapIdleClients = (): void => {
    const cutoff = now() - idleTimeoutMs;
    for (const [pk, client] of clientPool.entries()) {
      // Never reap a session with an in-flight request — closing it would
      // reject a legitimate long call (`last_used_at` only bumps on
      // success, so a slow request looks "idle" mid-flight).
      if (client.session?.hasPending) continue;
      if (client.last_used_at < cutoff) {
        clientPool.delete(pk);
        // Close any long-lived legacy SSE / websocket / stdio channel.
        client.session?.close();
      }
    }
  };

  /** Evict a pooled session that died mid-dispatch so the next call reopens
   *  (shared by the ws + stdio dispatch catch blocks). */
  const evictIfDead = (pk: string): void => {
    const entry = clientPool.get(pk);
    if (entry?.session && entry.session.isClosed) clientPool.delete(pk);
  };

  /** Reuse a live pooled session for `record` (same target, not closed), or
   *  run `open()` to make a fresh one — with a target-aware single-flight so
   *  concurrent dispatches to the SAME target share one open, while a
   *  concurrent re-enrollment (different target) gets its own. Leak-safe:
   *  the pool-write closes any session it would overwrite (a superseded
   *  concurrent open can't orphan an un-pooled, never-reaped channel).
   *  `open()` returns an already-initialized session (or throws). */
  const openSession = async (
    pk: string,
    targetKey: string,
    transport: McpTransport,
    open: () => Promise<McpStreamSession>,
  ): Promise<McpStreamSession> => {
    const existing = clientPool.get(pk);
    // Reuse only a LIVE session still pointed at the SAME target. A
    // re-enrolled connection (same pk, new endpoint / command) must not keep
    // talking to the old target — close + reopen.
    if (existing?.session && !existing.session.isClosed && existing.endpoint === targetKey) {
      return existing.session;
    }
    if (existing) {
      existing.session?.close();
      clientPool.delete(pk);
    }
    // Join a concurrent open ONLY when it targets the same key.
    const inflight = openFlight.get(pk);
    if (inflight && inflight.targetKey === targetKey) return inflight.flight;

    const flight = (async (): Promise<McpStreamSession> => {
      const session = await open();
      // Close any session this open overwrites (a superseding concurrent
      // open of a different target) so it isn't orphaned out of the pool.
      const prior = clientPool.get(pk);
      if (prior?.session && prior.session !== session) prior.session.close();
      clientPool.set(pk, { transport, endpoint: targetKey, last_used_at: now(), session });
      return session;
    })();

    openFlight.set(pk, { targetKey, flight });
    try {
      return await flight;
    } finally {
      // Only clear the slot if it's still OURS (a superseding open may have
      // replaced it with a different-target flight).
      if (openFlight.get(pk)?.flight === flight) openFlight.delete(pk);
    }
  };

  /** Reuse / open a ws session for `record`. On a fresh open the OAuth2 token
   *  is refreshed + injected into the handshake headers (a reused socket
   *  keeps its handshake-time credentials — see `dispatchWebsocket`). */
  const openWsSession = (
    record: ConnectionRow,
    wsConnect: WsConnect,
    endpointUrl: URL,
    timeoutMs: number,
  ): Promise<McpStreamSession> => {
    const endpointStr = endpointUrl.toString();
    return openSession(record.pk, endpointStr, 'websocket', async () => {
      const openHandle = async (): Promise<WsClientHandle> => {
        // Decode + refresh auth for every physical connection. Legacy fallback
        // deliberately opens a fresh connection after the modern probe.
        const auth = await deps.decodeAuth(record);
        const liveAuth = await ensureFreshAuth(record, auth);
        const url = new URL(endpointStr);
        const headers: Record<string, string> = {};
        injectAuthHeaders(liveAuth, headers, url);
        const connectController = new AbortController();
        const connectTimer = setTimeout(() => connectController.abort(), timeoutMs);
        try {
          return await wsConnect(url.toString(), {
            headers,
            signal: connectController.signal,
          });
        } finally {
          clearTimeout(connectTimer);
        }
      };
      return openNegotiatedMcpStreamSession(
        openHandle,
        () => nextRequestId++,
        timeoutMs,
      );
    });
  };

  /** Dispatch one MCP op over a long-lived WebSocket (D-125 §920). The
   *  socket is pooled per connection record + reused across runs; the
   *  bearer / custom-auth rides in the upgrade handshake (set by the
   *  injected `wsConnect`), so a reused socket keeps its handshake-time
   *  token — a refreshed token applies only when the next socket opens
   *  (after idle teardown, an endpoint change, or a server-side close on
   *  expiry; `openWsSession` forces a reopen on an endpoint change). SSRF: the
   *  injected connector refuses cross-origin redirects, the WS equivalent
   *  of the sse path's origin pinning; a user-enrolled local / self-hosted
   *  `ws://` endpoint stays allowed by design (same as connection.api). */
  const dispatchWebsocket = async (
    record: ConnectionRow,
    call: ResolvedCall,
    ctx: ConnectionHandlerCtx | undefined,
    d: StreamDispatchParams,
  ): Promise<unknown> => {
    if (deps.wsConnect === undefined) {
      // This runtime can't open header-bearing WebSockets (ext / dbless).
      throw new IngredientError(
        'MCP_TRANSPORT_NOT_IMPLEMENTED',
        `connection.mcp: transport 'websocket' is not available in this runtime (no ws connector)`,
        { slug: call.slug, name: record.name, transport: 'websocket' },
      );
    }
    const wsConnect = deps.wsConnect;
    const endpoint = readEndpoint(record, 'websocket');
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(endpoint);
    } catch (e) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.mcp: malformed endpoint '${endpoint}' for connection '${record.name}': ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    }
    if (endpointUrl.protocol !== 'ws:' && endpointUrl.protocol !== 'wss:') {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.mcp: websocket transport requires a ws:// or wss:// endpoint, got '${endpointUrl.protocol}' for connection '${record.name}'`,
        { slug: call.slug, name: record.name },
      );
    }

    try {
      const session = await openWsSession(record, wsConnect, endpointUrl, d.timeoutMs);
      const reqId = nextRequestId++;
      const envelope = await session.requestMcp(reqId, d.method, d.jsonRpcParams, d.timeoutMs);
      if (envelope.jsonrpc !== '2.0') {
        throw new IngredientError(
          'NETWORK_ERROR',
          `connection.mcp: ${record.name} returned non-JSON-RPC response`,
          { name: record.name },
        );
      }
      // Bytes telemetry — request + response envelope sizes (mirrors sse).
      const wireParams = session.protocolVersion === MCP_MODERN_PROTOCOL_VERSION
        ? withModernMcpRequestMeta(d.jsonRpcParams, MCP_CLIENT_INFO)
        : d.jsonRpcParams;
      const requestBody = JSON.stringify({
        jsonrpc: '2.0', id: reqId, method: d.method, params: wireParams,
      });
      const bytesOut = new TextEncoder().encode(requestBody).byteLength;
      const bytesIn = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
      ctx?.setBytes(bytesIn, bytesOut);
      // Pool bump after a successful wire.
      const entry = clientPool.get(record.pk);
      if (entry) entry.last_used_at = now();
      return envelopeToShape(envelope, d.method === 'tools/call');
    } catch (e) {
      evictIfDead(record.pk);
      if (e instanceof IngredientError) throw e;
      throw mapStreamDispatchError(e, record, call, d);
    }
  };

  // ── stdio transport (D-125 §921) — spawn + pump JSON-RPC over stdio ──

  /** Reuse / spawn a stdio session for `record` (target-aware single-flight
   *  shared with ws; a changed command signature or a dead child respawns). */
  const spawnStdioSession = (
    record: ConnectionRow,
    spawnStdio: StdioSpawn,
    spec: { command: string; args: string[]; env?: Record<string, string> },
    targetKey: string,
    timeoutMs: number,
  ): Promise<McpStreamSession> =>
    openSession(record.pk, targetKey, 'stdio', async () => {
      const openHandle = async (): Promise<StdioClientHandle> => {
        const spawnController = new AbortController();
        const spawnTimer = setTimeout(() => spawnController.abort(), timeoutMs);
        try {
          return await spawnStdio(spec, { signal: spawnController.signal });
        } finally {
          clearTimeout(spawnTimer);
        }
      };
      return openNegotiatedMcpStreamSession(
        openHandle,
        () => nextRequestId++,
        timeoutMs,
      );
    });

  /** Dispatch one MCP op over a long-lived stdio child (D-125 §921). The
   *  child is pooled per connection record + reused across runs (a reactive
   *  recipe firing every minute reuses the warm child without re-spawn
   *  cost). The command is user-enrolled (Settings → Connections) — never
   *  pack-injected — and spawned with `shell: false` + an explicit args
   *  array, so there is no shell-injection surface. */
  const dispatchStdio = async (
    record: ConnectionRow,
    call: ResolvedCall,
    ctx: ConnectionHandlerCtx | undefined,
    d: StreamDispatchParams,
  ): Promise<unknown> => {
    if (deps.spawnStdioMcp === undefined) {
      // This runtime can't fork processes (ext / dbless harnesses).
      throw new IngredientError(
        'MCP_TRANSPORT_NOT_IMPLEMENTED',
        `connection.mcp: transport 'stdio' is not available in this runtime (no process spawner)`,
        { slug: call.slug, name: record.name, transport: 'stdio' },
      );
    }
    const spawnStdio = deps.spawnStdioMcp;
    const spec = readStdioCommand(record, call);
    // Stable reuse-key: command + args + env. A re-enrollment that changes
    // any of these respawns rather than reusing the stale child.
    const targetKey = JSON.stringify([spec.command, spec.args, spec.env ?? null]);

    try {
      const session = await spawnStdioSession(record, spawnStdio, spec, targetKey, d.timeoutMs);
      const reqId = nextRequestId++;
      const envelope = await session.requestMcp(reqId, d.method, d.jsonRpcParams, d.timeoutMs);
      if (envelope.jsonrpc !== '2.0') {
        throw new IngredientError(
          'NETWORK_ERROR',
          `connection.mcp: ${record.name} returned non-JSON-RPC response`,
          { name: record.name },
        );
      }
      const wireParams = session.protocolVersion === MCP_MODERN_PROTOCOL_VERSION
        ? withModernMcpRequestMeta(d.jsonRpcParams, MCP_CLIENT_INFO)
        : d.jsonRpcParams;
      const requestBody = JSON.stringify({
        jsonrpc: '2.0', id: reqId, method: d.method, params: wireParams,
      });
      const bytesOut = new TextEncoder().encode(requestBody).byteLength;
      const bytesIn = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
      ctx?.setBytes(bytesIn, bytesOut);
      const entry = clientPool.get(record.pk);
      if (entry) entry.last_used_at = now();
      return envelopeToShape(envelope, d.method === 'tools/call');
    } catch (e) {
      evictIfDead(record.pk);
      if (e instanceof IngredientError) throw e;
      throw mapStreamDispatchError(e, record, call, d);
    }
  };

  /** Negotiate the stateless HTTP era once per pooled connection. Modern
   * discovery is authoritative only on a well-formed success; an unrecognized
   * 4xx or method-not-found response falls back to the validated legacy
   * lifecycle. Recognized modern protocol errors, auth failures, rate limits,
   * and 5xx responses fail without downgrading. */
  const negotiateHttpProtocol = async (
    client: McpClient,
    record: ConnectionRow,
    url: URL,
    baseHeaders: Record<string, string>,
    timeoutMs: number,
  ): Promise<RecuedMcpProtocolVersion> => {
    if (client.protocolVersion !== undefined) return client.protocolVersion;

    const postNegotiationRequest = async (
      request: JsonRpcRequest,
      modernHeaders?: Record<string, string>,
      options: { tolerateTimeout?: boolean } = {},
    ): Promise<{
      status: number;
      envelope?: JsonRpcResponse;
      timedOut?: boolean;
      sessionId?: string;
    }> => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(timeoutMs, MCP_NEGOTIATION_PROBE_TIMEOUT_MS),
      );
      let response: Response;
      try {
        response = await fetchOriginPinned(fetchImpl, url.toString(), {
          method: 'POST',
          headers: {
            ...baseHeaders,
            ...modernHeaders,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        }, url.origin);
      } catch (error) {
        // A probe that times out means "not a modern server" — the spec names a
        // non-response as a fallback trigger, not a fatal condition. Reporting
        // it as NETWORK_ERROR here would strand every legacy server that
        // black-holes an unknown method instead of refusing it.
        if (options.tolerateTimeout === true && (error as Error).name === 'AbortError') {
          return { status: 0, timedOut: true };
        }
        if (error instanceof CrossOriginRedirectError) {
          throw new IngredientError(
            'URL_REF_INVALID',
            `connection.mcp: ${error.message} — cross-origin redirect refused`,
            { name: record.name },
          );
        }
        throw new IngredientError(
          'NETWORK_ERROR',
          `connection.mcp version negotiation with '${record.name}' failed: ${(error as Error).message}`,
          { name: record.name },
        );
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) {
        discardResponseBody(response);
        throw new IngredientError(
          'OAUTH_EXPIRED',
          `connection.mcp: ${record.name} returned ${response.status} ${response.statusText}`,
          { status: response.status, name: record.name },
        );
      }
      if (response.status === 429) {
        discardResponseBody(response);
        throw new IngredientError(
          'API_RATE_LIMITED',
          `connection.mcp: ${record.name} rate limited during version negotiation (429)`,
          { status: response.status, name: record.name },
        );
      }
      if (response.status >= 500) {
        discardResponseBody(response);
        throw new IngredientError(
          'NETWORK_ERROR',
          `connection.mcp version negotiation with '${record.name}' returned ${response.status} ${response.statusText}`,
          { status: response.status, name: record.name },
        );
      }
      const sessionId = response.headers.get('mcp-session-id') ?? undefined;
      try {
        const read = await readMcpHttpEnvelope(response, request.id);
        return {
          status: response.status,
          envelope: read.envelope,
          ...(sessionId !== undefined ? { sessionId } : {}),
        };
      } catch {
        discardResponseBody(response);
        return { status: response.status };
      }
    };

    const discoverRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: nextRequestId++,
      method: 'server/discover',
      params: { _meta: modernMcpRequestMeta(MCP_CLIENT_INFO) },
    };
    const discover = await postNegotiationRequest(discoverRequest, modernMcpHttpHeaders('server/discover', {
      _meta: modernMcpRequestMeta(MCP_CLIENT_INFO),
    }), { tolerateTimeout: true });
    if (
      discover.status >= 200
      && discover.status < 300
      && discover.envelope?.jsonrpc === '2.0'
      && discover.envelope.error === undefined
      && selectMcpDiscoverVersion(discover.envelope.result) === MCP_MODERN_PROTOCOL_VERSION
    ) {
      client.protocolVersion = MCP_MODERN_PROTOCOL_VERSION;
      return client.protocolVersion;
    }
    if (isModernMcpProtocolError(discover.envelope)) {
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.mcp modern version negotiation with '${record.name}' failed: ${discover.envelope?.error?.message ?? 'protocol error'}`,
        { name: record.name },
      );
    }

    // ── Streamable HTTP, handshake era (2025-03-26 … 2025-11-25) ──
    // One POST endpoint, an `initialize` handshake, and — unlike 2024-11-05 —
    // no GET stream to announce a message endpoint. This is the shape most
    // deployed remote MCP servers still speak, and it answers the SAME url we
    // just probed, so it costs one request to rule in before falling all the
    // way back to the two-endpoint transport (whose opening GET such a server
    // answers with 405).
    const initializeRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: nextRequestId++,
      method: 'initialize',
      params: {
        protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    };
    const initialized = await postNegotiationRequest(
      initializeRequest,
      { Accept: 'application/json, text/event-stream' },
      { tolerateTimeout: true },
    );
    if (
      initialized.status >= 200
      && initialized.status < 300
      && initialized.envelope?.jsonrpc === '2.0'
      && initialized.envelope.error === undefined
    ) {
      const selected = selectMcpLegacyInitializeVersion(initialized.envelope.result);
      if (selected !== undefined) {
        // Sessions were removed in 2026-07-28 but are how these revisions bind
        // a handshake to its follow-up calls; echo the id back when the server
        // minted one, and stay stateless when it did not.
        client.httpSessionId = initialized.sessionId;
        client.protocolVersion = selected;
        // These revisions require the notification to complete the lifecycle.
        // Best-effort: a lenient server serves `tools/call` without it, and a
        // strict one has already recorded the handshake.
        try {
          const ack = await fetchOriginPinned(fetchImpl, url.toString(), {
            method: 'POST',
            headers: {
              ...baseHeaders,
              Accept: 'application/json, text/event-stream',
              ...(initialized.sessionId !== undefined
                ? { 'Mcp-Session-Id': initialized.sessionId }
                : {}),
            },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            signal: AbortSignal.timeout(
              Math.min(timeoutMs, MCP_NEGOTIATION_PROBE_TIMEOUT_MS),
            ),
          }, url.origin);
          discardResponseBody(ack);
        } catch {
          // see above — the handshake itself already succeeded.
        }
        return client.protocolVersion;
      }
    }

    let legacySession: McpStreamSession | undefined;
    try {
      legacySession = new McpStreamSession(await openLegacyMcpSseHandle(
        fetchImpl,
        url,
        baseHeaders,
        timeoutMs,
      ));
      await legacySession.ensureLegacyInitialized(() => nextRequestId++, timeoutMs);
      client.session?.close();
      client.session = legacySession;
      client.protocolVersion = MCP_LEGACY_PROTOCOL_VERSION;
      return client.protocolVersion;
    } catch (error) {
      legacySession?.close();
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.mcp legacy HTTP+SSE negotiation with '${record.name}' failed: ${(error as Error).message}`,
        { name: record.name },
      );
    }
  };

  const dispatch = async (
    record: ConnectionRow,
    params: Record<string, unknown>,
    call: ResolvedCall,
    ctx?: ConnectionHandlerCtx,
  ): Promise<unknown> => {
    // Lazy reaper — every dispatch entry prunes idle clients before
    // taking its own slot. Cheap when the pool is small; correct.
    reapIdleClients();

    // ────────────── input validation + op resolution ──────────────
    const op = resolveMcpOperation(params, record, call);
    const { method, jsonRpcParams, subject } = wireForOperation(op);

    // ────────────── tool list pre-validation ──────────────
    // When the connection record has a cached tool list (probe ran +
    // populated it), validate eagerly so an authoring mistake surfaces
    // a clean diagnostic instead of a JSON-RPC -32601. Absent cache →
    // skip; let the server respond with whatever shape it uses. Resource
    // ops have no equivalent cache gate (the server validates the uri).
    if (op.mode === 'tool') {
      const health = readHealth(record);
      if (Array.isArray(health?.tools) && health.tools.length > 0
          && !health.tools.includes(op.tool)) {
        throw new IngredientError(
          'MCP_TOOL_NOT_FOUND',
          `connection.mcp: tool '${op.tool}' not in cached tool list for connection '${record.name}' (re-probe to refresh)`,
          { slug: call.slug, name: record.name, tool: op.tool, available: health.tools },
        );
      }
    }

    // ────────────── shared dispatch params (both transports) ──────────────
    // Hoisted above the transport branch so sse + websocket share one
    // definition. `subjectMeta` preserves the tool-call `tool` key for
    // backward-compat with error consumers + adds `resource` for the
    // resource ops. Write-uncertainty applies ONLY to tool calls —
    // `resources/read` / `resources/list` are read-only MCP primitives,
    // so a network failure on them is a plain read failure even if the
    // wrapper mis-declares a write tier.
    const subjectMeta: Record<string, string> =
      op.mode === 'tool'
        ? { subject, tool: op.tool }
        : op.mode === 'resource_read'
          ? { subject, resource: op.uri }
          : { subject };
    const isWrite = op.mode === 'tool' && isWriteRiskTier(call.risk_tier);
    const timeoutMs = resolveTimeoutMs(
      params.timeout_ms ?? CONNECTION_API_TIMEOUT_MS,
    );

    // ────────────── transport dispatch ──────────────
    const streamParams: StreamDispatchParams = {
      method, jsonRpcParams, subject, subjectMeta, isWrite, timeoutMs,
    };
    const transport = getTransport(record);
    if (transport === 'websocket') {
      return await dispatchWebsocket(record, call, ctx, streamParams);
    }
    if (transport === 'stdio') {
      return await dispatchStdio(record, call, ctx, streamParams);
    }
    if (transport !== 'sse') {
      // any future transport — not wired.
      throw new IngredientError(
        'MCP_TRANSPORT_NOT_IMPLEMENTED',
        `connection.mcp: transport '${transport}' not yet wired in this runtime (sse + websocket + stdio supported)`,
        { slug: call.slug, name: record.name, transport },
      );
    }

    const endpoint = readEndpoint(record, transport);

    // ────────────── pool entry ──────────────
    const existing = clientPool.get(record.pk);
    const client: McpClient = existing?.transport === transport && existing.endpoint === endpoint
      ? existing
      : { transport, endpoint, last_used_at: now() };
    if (client !== existing) {
      existing?.session?.close();
      clientPool.set(record.pk, client);
    }

    // ────────────── auth + URL ──────────────
    const auth = await deps.decodeAuth(record);
    // Refresh a missing/stale OAuth2 access token before header injection
    // (no-op for non-oauth2 auth). For `oauth2_refresh` this turns an expired
    // token into a live one rather than failing the dispatch with OAUTH_EXPIRED.
    const liveAuth = await ensureFreshAuth(record, auth);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch (e) {
      throw new IngredientError(
        'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        `connection.mcp: malformed endpoint '${endpoint}' for connection '${record.name}': ${(e as Error).message}`,
        { slug: call.slug, name: record.name },
      );
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    injectAuthHeaders(liveAuth, headers, url);

    const protocolVersion = await negotiateHttpProtocol(
      client,
      record,
      url,
      headers,
      timeoutMs,
    );

    const requestId = nextRequestId++;
    const isLegacyEra = mcpProtocolEra(protocolVersion) === 'legacy';
    // Only the 2024-11-05 two-endpoint transport holds a live channel. A
    // handshake-era Streamable HTTP connection is legacy but SESSIONLESS, and
    // takes the POST path below.
    if (isLegacyEra && client.session !== undefined) {
      const session = client.session;
      if (session.isClosed) {
        clientPool.delete(record.pk);
        throw new IngredientError(
          'NETWORK_ERROR',
          `connection.mcp: legacy HTTP+SSE session for '${record.name}' is closed`,
          { name: record.name },
        );
      }
      try {
        const envelope = await session.requestMcp(
          requestId,
          method,
          jsonRpcParams,
          timeoutMs,
        );
        const requestBody = JSON.stringify({
          jsonrpc: '2.0', id: requestId, method, params: jsonRpcParams,
        });
        ctx?.setBytes(
          new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
          new TextEncoder().encode(requestBody).byteLength,
        );
        client.last_used_at = now();
        return envelopeToShape(envelope, method === 'tools/call');
      } catch (error) {
        evictIfDead(record.pk);
        if (error instanceof IngredientError) throw error;
        throw mapStreamDispatchError(error, record, call, streamParams);
      }
    }

    // ────────────── JSON-RPC envelope ──────────────
    // Per-request metadata and the mirrored headers are 2026-07-28 constructs.
    // A handshake-era server established its version once, at `initialize`;
    // sending them there would be an unrecognized `_meta` block plus headers
    // that revision never defined.
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: isLegacyEra
        ? jsonRpcParams
        : withModernMcpRequestMeta(jsonRpcParams, MCP_CLIENT_INFO),
    };
    if (isLegacyEra) {
      headers.Accept = 'application/json, text/event-stream';
      if (client.httpSessionId !== undefined) {
        headers['Mcp-Session-Id'] = client.httpSessionId;
      }
    } else {
      Object.assign(headers, modernMcpHttpHeaders(method, jsonRpcParams));
    }
    if (!isLegacyEra && op.mode === 'tool') {
      const health = readHealth(record);
      const schemas = health?.mcp_tool_schemas;
      if (
        schemas !== undefined
        && !Object.prototype.hasOwnProperty.call(schemas, op.tool)
      ) {
        throw new IngredientError(
          'MCP_TOOL_NOT_FOUND',
          `connection.mcp: modern HTTP schema for tool '${op.tool}' is not cached for '${record.name}' (re-probe the connection before calling it)`,
          { slug: call.slug, name: record.name, tool: op.tool },
        );
      }
      const bindingResult = mcpHttpHeaderBindingsFromSchema(schemas?.[op.tool]);
      if (!bindingResult.ok) {
        throw new IngredientError(
          'MCP_TOOL_NOT_FOUND',
          `connection.mcp: tool '${op.tool}' has invalid x-mcp-header annotations and was rejected: ${bindingResult.reason}`,
          { slug: call.slug, name: record.name, tool: op.tool },
        );
      }
      try {
        Object.assign(
          headers,
          modernMcpToolArgumentHeaders(bindingResult.bindings, op.args),
        );
      } catch (error) {
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.mcp: tool '${op.tool}' custom-header argument is invalid: ${(error as Error).message}`,
          { slug: call.slug, name: record.name, tool: op.tool },
        );
      }
    }
    const requestBody = JSON.stringify(request);
    const bytesOut = new TextEncoder().encode(requestBody).byteLength;

    // ────────────── fetch with timeout ──────────────
    // `timeoutMs`, `subjectMeta`, `isWrite` are hoisted above the
    // transport branch (shared with the websocket path).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      // SSRF: follow redirects manually, pinned to the enrolled MCP
      // endpoint's origin. A cross-origin 3xx from a compromised /
      // malicious endpoint would otherwise be followed (carrying the
      // injected auth headers) and its JSON-RPC body returned to the
      // recipe. Same-origin redirects still work.
      response = await fetchOriginPinned(fetchImpl, url.toString(), {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      }, url.origin);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof IngredientError) throw e;
      if (e instanceof CrossOriginRedirectError) {
        throw new IngredientError(
          'URL_REF_INVALID',
          `connection.mcp (${call.slug}): ${e.message} — cross-origin redirect refused`,
          { slug: call.slug, name: record.name, ...subjectMeta },
        );
      }
      const isAbort = (e as Error).name === 'AbortError';
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `MCP write to '${record.name}' ${subject} ${isAbort ? `timed out after ${timeoutMs}ms` : `failed: ${(e as Error).message}`} — outcome cannot be confirmed, please verify state in the target system before retrying`,
          {
            slug: call.slug,
            name: record.name,
            ...subjectMeta,
            cause: isAbort ? 'timeout' : 'network',
          },
        );
      }
      if (isAbort) {
        throw new IngredientError(
          'STEP_TIMEOUT',
          `connection.mcp call to '${record.name}' ${subject} timed out after ${timeoutMs}ms`,
          { slug: call.slug, name: record.name, ...subjectMeta },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.mcp call to '${record.name}' ${subject} failed: ${(e as Error).message}`,
        { slug: call.slug, name: record.name, ...subjectMeta },
      );
    }
    const finishResponse = (): void => {
      discardResponseBody(response);
      clearTimeout(timer);
    };

    // ────────────── HTTP status classification ──────────────
    if (!response.ok) {
      finishResponse();
      if (response.status === 401 || response.status === 403) {
        throw new IngredientError(
          'OAUTH_EXPIRED',
          `connection.mcp: ${record.name} returned ${response.status} ${response.statusText}`,
          { status: response.status, name: record.name },
        );
      }
      if (response.status === 429) {
        throw new IngredientError(
          'API_RATE_LIMITED',
          `connection.mcp: ${record.name} rate limited (429)`,
          { status: response.status, name: record.name },
        );
      }
      if (response.status >= 500 && isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `MCP write to '${record.name}' returned ${response.status} ${response.statusText} — outcome cannot be confirmed, please verify state in the target system before retrying`,
          { status: response.status, name: record.name, ...subjectMeta, cause: 'server_5xx' },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.mcp: ${record.name} returned ${response.status} ${response.statusText}`,
        { status: response.status, name: record.name },
      );
    }

    // ────────────── parse JSON-RPC envelope ──────────────
    let envelope: JsonRpcResponse;
    let measuredBytes: number;
    try {
      const read = await readMcpHttpEnvelope(response, requestId);
      measuredBytes = read.byteLength;
      envelope = read.envelope;
    } catch (e) {
      finishResponse();
      if (e instanceof ResponseBodyTooLargeError) {
        if (isWrite) {
          throw new IngredientError(
            'ACTION_DELIVERY_UNCERTAIN',
            `MCP write to '${record.name}' returned an oversized response after invocation — outcome cannot be confirmed, please verify state in the target system before retrying`,
            { name: record.name, ...subjectMeta, cause: 'response_too_large', max_bytes: e.maxBytes },
          );
        }
        throw new IngredientError(
          'INGREDIENT_OUTPUT_VALIDATION_FAILED',
          `connection.mcp: ${record.name} response exceeded the ${e.maxBytes}-byte body limit`,
          { name: record.name, max_bytes: e.maxBytes },
        );
      }
      const isAbort = (e as Error).name === 'AbortError';
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `MCP write to '${record.name}' ${isAbort ? `timed out after ${timeoutMs}ms while reading the response` : 'returned an unreadable response'} — outcome cannot be confirmed, please verify state in the target system before retrying`,
          { name: record.name, ...subjectMeta, cause: isAbort ? 'timeout' : 'malformed_response' },
        );
      }
      if (isAbort) {
        throw new IngredientError(
          'STEP_TIMEOUT',
          `connection.mcp call to '${record.name}' ${subject} timed out after ${timeoutMs}ms while reading the response`,
          { slug: call.slug, name: record.name, ...subjectMeta },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.mcp: ${record.name} returned malformed JSON: ${(e as Error).message}`,
        { name: record.name },
      );
    }
    finishResponse();
    if (envelope.jsonrpc !== '2.0') {
      if (isWrite) {
        throw new IngredientError(
          'ACTION_DELIVERY_UNCERTAIN',
          `MCP write to '${record.name}' returned a non-JSON-RPC response after invocation — outcome cannot be confirmed, please verify state in the target system before retrying`,
          { name: record.name, ...subjectMeta, cause: 'invalid_response_envelope' },
        );
      }
      throw new IngredientError(
        'NETWORK_ERROR',
        `connection.mcp: ${record.name} returned non-JSON-RPC response`,
        { name: record.name },
      );
    }

    // ────────────── bytes telemetry ──────────────
    const declaredLen = response.headers.get('content-length');
    const bytesIn = declaredLen !== null && Number.isFinite(Number(declaredLen))
      ? Number(declaredLen)
      : measuredBytes;
    ctx?.setBytes(bytesIn, bytesOut);

    // ────────────── pool bump (after successful wire) ──────────────
    client.last_used_at = now();

    // ────────────── shape ──────────────
    // Spec § 4.2 — shared `envelopeToShape` (see its JSDoc); identical
    // mapping for the websocket path.
    return envelopeToShape(envelope, method === 'tools/call');
  };

  // ── D-232 § 22 — EVERY DISPATCH IS A HEALTH PROBE, AND THE HONEST ONE ──
  //
  // ⛔⛔ HEALTH WAS WRITTEN ONLY BY THE MANUAL PROBE. This handler read
  // `health.tools` for tool pre-validation and never wrote anything back, so a
  // connection that failed every call for a week still reported `ok` from
  // whenever someone last pressed the button. Anything consulting that field —
  // a retry policy, a fail-fast gate, the Connections panel — was consulting
  // nobody's opinion.
  //
  // 🔑 THE CLASSIFICATION IS THE SAME REACHED/NOT-REACHED LINE AS § 21, so one
  // rule serves both consumers and they cannot disagree: a call the asker is
  // told to treat as `error` can never simultaneously be evidence that the
  // connection is down.
  //   · returned `ok`          → the peer answered            → 'ok'
  //   · returned `tool_error`  → answered and refused the CALL → 'call_failed'
  //     (⛔ health MUST NOT move — a correctly-enforced refusal is not an outage)
  //   · OAUTH_EXPIRED / 401,403 → reached, credential rejected → 'auth_failed'
  //   · NETWORK_ERROR / timeout → never reached                → 'unreachable'
  //   · anything else           → reached far enough to fail   → 'call_failed'
  //
  // ⚠ REPORTING IS BEST-EFFORT AND NEVER CHANGES THE CALL'S OUTCOME. A health
  // write that throws must not turn a successful dispatch into a failure, nor
  // replace the real error with a bookkeeping one.
  const reportHealth = async (
    record: ConnectionRow,
    outcome: ConnectionDispatchOutcome,
    detail?: string,
  ): Promise<void> => {
    if (deps.persistHealth === undefined) return;
    const folded = foldConnectionDispatchHealth(readHealth(record), outcome, now(), detail);
    if (folded === null) return; // 'call_failed' — deliberately no write at all
    try {
      await deps.persistHealth(record.name, folded);
    } catch {
      // Swallowed on purpose; see the note above.
    }
  };

  const outcomeForThrow = (e: unknown): ConnectionDispatchOutcome => {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'OAUTH_EXPIRED' || code === 'OAUTH_REVOKED') return 'auth_failed';
    if (code === 'NETWORK_ERROR' || code === 'STEP_TIMEOUT') return 'unreachable';
    // ⚠ `ACTION_DELIVERY_UNCERTAIN` and `API_RATE_LIMITED` land here: the peer
    // was REACHED in both (a 5xx and a 429 are answers), so neither is evidence
    // the connection is down.
    return 'call_failed';
  };

  return async (
    record: ConnectionRow,
    params: Record<string, unknown>,
    call: ResolvedCall,
    ctx?: ConnectionHandlerCtx,
  ): Promise<unknown> => {
    try {
      const out = await dispatch(record, params, call, ctx);
      const status = (out as { status?: unknown } | null)?.status;
      await reportHealth(record, status === 'tool_error' ? 'call_failed' : 'ok');
      return out;
    } catch (e) {
      await reportHealth(record, outcomeForThrow(e), (e as Error)?.message);
      throw e;
    }
  };
};
