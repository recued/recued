/** Shared resumable-upload engine + widget — types.
 *
 *  D-172 webclient file uploads. The binary chunk transport + the typed
 *  `upload.*` control plane already ship server-side; this module is the
 *  CLIENT that drives them. Three layers, separable for testability:
 *   - `engine.ts` — a pure network state machine (create/probe → open the
 *                   binary socket → chunk-loop → finalize, with resume +
 *                   reconnect). No DOM. Headless-testable with a fake
 *                   `connect` + fake callers.
 *   - `render.ts` — pure HTML-string renderers (the widget shell + the
 *                   progress region on its own, for surgical repaints).
 *   - `wire.ts`   — `wireUploadWidget`, the DOM-light glue: ATTACHES to the
 *                   shell the host already rendered, binds the file-input +
 *                   drop-zone, drives the engine, repaints the progress bar
 *                   on each engine event; `rewire()` re-attaches after a host
 *                   re-paint WITHOUT losing the in-flight upload (the engine
 *                   lives in the wire closure, not the DOM).
 *
 *  The wire format is owned by `@recued/contracts` (`upload-frame.ts`); this
 *  module imports it and never re-implements the framing.
 */

import type {
  UploadChunkAck,
  UploadCreateRpcRequest,
  UploadCreateRpcResponse,
  UploadDeleteRpcRequest,
  UploadDeleteRpcResponse,
  UploadFinalizeRpcRequest,
  UploadFinalizeRpcResponse,
  UploadProbeRpcRequest,
  UploadProbeRpcResponse,
} from '@recued/contracts';

/** The four control-plane rpc callers the host injects (each a thin
 *  `rpcConn.call('upload.<x>', args)` wrapper). `scope_key` is never passed —
 *  the server resolves it from the verified bearer. */
export interface UploadCallers {
  create(req: UploadCreateRpcRequest): Promise<UploadCreateRpcResponse>;
  probe(req: UploadProbeRpcRequest): Promise<UploadProbeRpcResponse>;
  finalize(req: UploadFinalizeRpcRequest): Promise<UploadFinalizeRpcResponse>;
  delete(req: UploadDeleteRpcRequest): Promise<UploadDeleteRpcResponse>;
}

/** The `upload_ack` variant of the server→client frame — what one chunk send
 *  resolves to (the engine switches on `.ok` / `.reason`). */
export type UploadAckMessage = Extract<UploadChunkAck, { type: 'upload_ack' }>;

/** Structural subset of `WebSocket` the engine drives. A real browser
 *  `WebSocket` satisfies it (the host casts when returning one); a test passes
 *  a fake that records sent frames + lets it push `message` events. The acks
 *  arrive as TEXT frames (`event.data` is a string) on this binary socket. */
export interface UploadSocket {
  send(data: ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Opens an authenticated binary `/ws/upload` socket. The host owns the URL +
 *  bearer (ui-shared can't reach the token store), so it injects this factory.
 *  Rejects if the socket fails to open. */
export type UploadConnectFactory = () => Promise<UploadSocket>;

// ── Transport seam (the DATA plane) ──────────────────────────────────
//
// The engine owns offset tracking, resume, the reconnect budget, finalize, and
// cancel; the TRANSPORT owns ONLY the one-chunk round-trip + its own connection
// lifecycle. Two ship: `createWsUploadTransport` (the webclient's binary
// `/ws/upload` socket) and `createHttpUploadTransport` (reception's
// fetch-per-chunk). The control plane (`UploadCallers`) is a SEPARATE seam.

/** One chunk to send: the session capability, the byte offset it appends at,
 *  the hex-SHA-256 of its bytes, and the bytes themselves. */
export interface UploadChunkSend {
  readonly uploadId: string;
  readonly offset: number;
  readonly checksum: string;
  readonly bytes: Uint8Array;
}

/** Transport-neutral chunk outcome — the WS `upload_ack` body and the HTTP
 *  chunk response both normalize to this; the engine switches on it.
 *  `offset_conflict` carries the server's real persisted offset so a stale
 *  client re-syncs; `checksum_mismatch` re-sends the slice in place; every other
 *  `ok:false` reason is terminal. */
export type UploadChunkOutcome =
  | { readonly ok: true; readonly offset: number; readonly complete: boolean }
  | { readonly ok: false; readonly reason: string; readonly offset?: number };

/** The DATA-plane seam. A server RESPONSE — even `ok:false` — is an OUTCOME the
 *  engine decides on; only a transport-level fault rejects (see
 *  `UploadTransportFault`). */
export interface UploadTransport {
  /** Ready the transport to send (open a socket, etc.). A connectionless
   *  transport (HTTP) no-ops. `aborted()` lets it bail + clean up if the run was
   *  cancelled mid-connect. Rejects with `UploadTransportFault` when it can't
   *  establish — the engine reconnect+reprobes (budgeted). */
  open(aborted: () => boolean): Promise<void>;
  /** Send one chunk; resolve to the server's outcome. Reject with
   *  `UploadTransportFault` for a TRANSIENT failure (timeout / dropped
   *  connection / network error) — the engine reconnect+reprobes. */
  send(chunk: UploadChunkSend): Promise<UploadChunkOutcome>;
  /** Drop any live connection so the next `open` re-establishes it. Called after
   *  a fault, on cancel, and on destroy. Idempotent. */
  reset(): void;
}

/** A transient transport failure (timeout, dropped connection, send/network
 *  error). The engine catches it → reconnect + reprobe the offset, bounded by
 *  the reconnect budget. Distinct from a terminal control-plane / chunk reject
 *  (which the engine surfaces as a fatal `error` phase). */
export class UploadTransportFault extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'UploadTransportFault';
  }
}

/** Options for `createWsUploadTransport` — the webclient's binary `/ws/upload`
 *  data plane. */
export interface WsUploadTransportOptions {
  readonly connect: UploadConnectFactory;
  /** No-ack window before the send rejects with a fault. Default 30 s. */
  readonly ackTimeoutMs?: number;
}

/** Minimal structural view of `fetch` the HTTP transport + reception callers
 *  drive — a real `fetch` satisfies it; tests inject a fake. */
export interface UploadFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
export interface UploadFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Abort the request — the HTTP transport wires this so `reset()` (cancel /
   *  destroy) tears down an in-flight chunk, matching the WS transport's
   *  socket-close. */
  signal?: AbortSignal;
}
export type UploadFetch = (
  url: string,
  init?: UploadFetchInit,
) => Promise<UploadFetchResponse>;

/** Options for `createHttpUploadTransport` — reception's fetch-per-chunk data
 *  plane. The host injects the per-`upload_id` chunk URL (it owns the bearer +
 *  the endpoint path); the transport adds the offset/checksum headers + maps the
 *  response to an outcome. */
export interface HttpUploadTransportOptions {
  /** Build the absolute chunk URL for one `upload_id` (bearer included). */
  readonly chunkUrl: (uploadId: string) => string;
  /** `fetch` impl. Default: `globalThis.fetch` (bound). */
  readonly fetchImpl?: UploadFetch;
}

/** Hex-encoded SHA-256 of a chunk's bytes. Injectable so tests stay
 *  deterministic + node-runnable; production defaults to `crypto.subtle`. */
export type UploadDigest = (bytes: Uint8Array) => Promise<string>;

/** A sliceable byte source — a real `File`/`Blob` satisfies it (`slice`
 *  returns a `Blob` whose `arrayBuffer()` reads the range). Tests fake it over
 *  an in-memory `Uint8Array`. */
export interface UploadFileSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface UploadFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  slice(start: number, end: number): UploadFileSlice;
}

/** Persists `(file-identity → upload_id)` so re-picking the SAME file resumes
 *  via `upload.probe` instead of a fresh `upload.create`. The default is
 *  in-memory (per engine); a host may inject a `localStorage` shim to survive
 *  a reload. */
export interface UploadResumeStore {
  get(key: string): string | null;
  set(key: string, uploadId: string): void;
  delete(key: string): void;
}

export type UploadPhase = 'uploading' | 'finalizing' | 'done' | 'error';

/** One progress tick the widget renders. `sent`/`total` are byte counts;
 *  `error` is the failure reason (phase `error`); `recordId` is the ingested
 *  `data.file` record id (phase `done`). */
export interface UploadProgress {
  readonly filename: string;
  readonly sent: number;
  readonly total: number;
  readonly phase: UploadPhase;
  readonly error?: string;
  readonly recordId?: string;
}

export interface UploadEngineOptions {
  readonly callers: UploadCallers;
  /** The DATA-plane transport (`createWsUploadTransport` for the webclient,
   *  `createHttpUploadTransport` for reception). The engine is transport-
   *  agnostic — it sends chunks through this seam and tracks offsets itself. */
  readonly transport: UploadTransport;
  /** Hex-SHA-256 digest. Default: `crypto.subtle`. */
  readonly digest?: UploadDigest;
  /** Bytes per chunk. Default 4 MiB (server cap is 16 MiB). */
  readonly chunkBytes?: number;
  /** Reconnect budget before giving up. Default 5. Reset on any progress. */
  readonly maxReconnects?: number;
  /** Resume persistence. Default: in-memory per engine. */
  readonly store?: UploadResumeStore;
}

export type UploadProgressListener = (progress: UploadProgress) => void;

/** The headless engine. `start` drives one file at a time (a second call
 *  while busy is ignored); `cancel` aborts + reaps the server scratch;
 *  `on('progress')` returns an unsubscribe; `destroy` tears everything down. */
export interface UploadEngine {
  start(file: UploadFile): void;
  cancel(): void;
  on(event: 'progress', listener: UploadProgressListener): () => void;
  destroy(): void;
}

/** Static per-widget config the renderers share. */
export interface UploadWidgetConfig {
  /** Unique-per-widget marker. The shell carries `data-upload=<id>`;
   *  `wire.ts` finds its subtree by it. */
  widgetId: string;
  /** Drop-zone caption. Default "Drop a file here, or click to choose". */
  promptText?: string;
}

/** Options for `wireUploadWidget` — the engine deps + the widget config. */
export interface WireUploadWidgetOptions {
  callers: UploadCallers;
  connect: UploadConnectFactory;
  config: UploadWidgetConfig;
  digest?: UploadDigest;
  chunkBytes?: number;
  store?: UploadResumeStore;
  /** Fired once per file when the upload finalizes — the host refreshes the
   *  file list / timeline so the new record shows up. */
  onDone?: (progress: UploadProgress) => void;
}

/** Imperative handle returned by `wireUploadWidget`. */
export interface UploadHandle {
  /** Re-attach to a freshly-painted host (after the host overwrote the
   *  container's innerHTML). The engine + last progress survive in the wire
   *  closure, so an in-flight upload keeps running. Idempotent; a no-op when
   *  the shell is absent. */
  rewire(root: ParentNode): void;
  /** Cancel any in-flight upload, drop listeners, and tear down the engine.
   *  The host owns the container's DOM lifecycle. Idempotent. */
  destroy(): void;
}
