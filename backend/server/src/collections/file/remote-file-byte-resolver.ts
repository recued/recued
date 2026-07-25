/** D-192 remote byte-fetch — the `storage_ref.kind:'remote'` per-vendor
 *  resolver port + orchestrator that bridges a `file:remote:*` record id to
 *  fetched bytes.
 *
 *  File Source SYNC is metadata-only. A mirror row lives in the `FileMetaStore`
 *  (`file_meta_ref`), a
 *  DIFFERENT store from the `data.file.received` CAS collection `handleFileRead`
 *  reads; its remote-storage_ref shape is synthesized at read time by
 *  `FileViewResolver` under a reversible `file:remote:<b64 scope>:<b64 target>`
 *  id. Given a remote record id, this module recovers the `FileMetaRow` + the
 *  connection (from the Source scope) + dispatch to a per-vendor resolver that
 *  actually fetches the bytes — LAZILY, only for the files a consumer opens.
 *
 *  Production composes the complete declared-vendor registry; the exported
 *  empty registry remains a fail-closed test/default seam. Design + fork
 *  decisions: D-192. */

import { RpcError, type FileMetaProjection } from '@recued/contracts';

import type { FileConnectionCredential, FileConnectionResolver } from '../../file-source-adapters/index.js';
import { parseRemoteFileRecordId } from '../../file-view-resolver.js';
import type { FileMetaStore } from '../../storage/file-meta-store.js';

/** Fail-closed ceiling on a single remote read. The read path buffers the whole
 *  object + base64-encodes it in one shot (no streaming yet), so an unbounded
 *  fetch would balloon memory — cap it. Enforced twice: a preflight on the
 *  mirror's `size` (when the vendor reports one) and a hard stop on the actual
 *  fetched length (Notion carries no size → the hard stop is the only guard).
 *  25 MiB — the "attach / summarize a document" realm, well under a bulk sync. */
export const REMOTE_FILE_READ_MAX_BYTES = 25 * 1024 * 1024;

/** The remote-read error taxonomy (thrown as `RpcError` so the five read
 *  channels surface them uniformly, exactly like the CAS read's codes). */
export type RemoteFileReadErrorCode =
  /** No resolver registered for this provider (a vendor not yet wired). */
  | 'remote_provider_unsupported'
  /** The row's `remote_id` is not a re-fetchable vendor locator (e.g. a Notion
   *  data-source property file's synthetic `rowId:propId:disc` key — no API
   *  object to re-resolve). A permanent, per-row gap, not a transient failure. */
  | 'remote_unresolvable'
  /** The object exceeds {@link REMOTE_FILE_READ_MAX_BYTES}. */
  | 'remote_too_large'
  /** The vendor fetch failed (network / auth / vendor error) — transient. */
  | 'remote_fetch_failed';

/** What a per-vendor resolver receives — the SAME credential seam the list
 *  adapters use (`FileConnectionResolver`), the vendor `remote_id` locator, the
 *  mirror projection (path / mime / size / revision — to locate + validate), and
 *  the byte ceiling it must not exceed. */
export interface RemoteFileByteRequest {
  cred: FileConnectionCredential;
  remote_id: string;
  meta: FileMetaProjection;
  maxBytes: number;
}

/** What a resolver returns — the raw bytes plus any authoritative mime/filename
 *  it learned from the vendor (both optional; the orchestrator falls back to the
 *  mirror's `meta`). Returning BYTES (not a CAS hash) keeps the port independent
 *  of the cache strategy — whether to persist is the caller's decision (v1:
 *  stream-through, uncached; see the design note Fork C). */
export interface RemoteFileByteResult {
  bytes: Buffer;
  mime_type?: string;
  filename?: string;
}

/** A per-vendor "fetch bytes by remote id" resolver. Notion's re-resolves the
 *  ~1h-signed url on each call (`GET /v1/blocks/{id}` → fresh url → download);
 *  S3 does a SigV4 `GetObject`; etc. It MUST abort past `req.maxBytes`, and
 *  should throw an `RpcError` with a {@link RemoteFileReadErrorCode} for a
 *  structured failure (e.g. `remote_unresolvable`) — any other throw is wrapped
 *  as `remote_fetch_failed` by the orchestrator. */
export type RemoteFileByteResolver = (req: RemoteFileByteRequest) => Promise<RemoteFileByteResult>;

/** The provider → resolver registry (keyed on `FileMetaProjection.provider`). */
export type RemoteFileByteResolverRegistry = Readonly<Record<string, RemoteFileByteResolver>>;

/** Fail-closed empty registry for isolated tests or deliberately unwired
 *  runtimes. Production injects `buildRemoteFileByteResolvers()`. */
export const EMPTY_REMOTE_FILE_BYTE_RESOLVERS: RemoteFileByteResolverRegistry = {};

export interface RemoteFileReadDeps {
  /** The remote mirror store — resolves `(scope, target_id)` → `FileMetaRow`. */
  fileMetaStore: FileMetaStore;
  /** The decrypted-connection resolver (the list adapters' seam) — authenticates
   *  the byte fetch the same way the mirror walk authenticated the list. */
  resolveConnection: FileConnectionResolver;
  /** Provider → byte resolver. */
  byteResolvers: RemoteFileByteResolverRegistry;
  /** Byte ceiling (defaults to {@link REMOTE_FILE_READ_MAX_BYTES}). */
  maxBytes?: number;
}

/** Recover the connection NAME from a file Source scope. The file Source id is
 *  minted `CONNECTION_SOURCE_ID(provider, name, 'file')` = `<provider>.<name>.file`
 *  — so strip the `<provider>.` prefix + `.file` suffix. `provider` and `file`
 *  carry no dots; the connection NAME may, so we strip the fixed ends rather than
 *  split on `.`. Returns `null` (fail-closed) when the scope doesn't match the
 *  expected shape or the name is empty (corruption / a non-connection scope). */
export const connectionNameFromSourceScope = (scope: string, provider: string): string | null => {
  const prefix = `${provider}.`;
  const suffix = '.file';
  if (!scope.startsWith(prefix) || !scope.endsWith(suffix)) return null;
  const name = scope.slice(prefix.length, scope.length - suffix.length);
  return name.length > 0 ? name : null;
};

/** The resolved bytes + the metadata a `FileReadResponse` needs. `blob_hash` is
 *  empty for a remote read (v1 is uncached — no CAS blob backs it). */
export interface RemoteFileReadResult {
  bytes: Buffer;
  mime_type: string;
  filename: string;
  size_bytes: number;
}

const isRemoteReadRpcError = (err: unknown): err is RpcError =>
  err instanceof RpcError;

/** Orchestrate a remote byte read for a `file:remote:*` record id:
 *  parse id → meta-store row → recover connection → dispatch to the provider's
 *  resolver → enforce the size ceiling. Throws `RpcError` with a
 *  {@link RemoteFileReadErrorCode} (or `file_not_found` / `file_storage_missing`
 *  / `bad_request`) on any failure; NEVER returns partial bytes. The caller
 *  (`handleFileRead`, later slice) routes CAS ids to the existing path and only
 *  reaches here for a remote id. */
export const resolveRemoteFileBytes = async (
  deps: RemoteFileReadDeps,
  record_id: string,
): Promise<RemoteFileReadResult> => {
  const parsed = parseRemoteFileRecordId(record_id);
  if (!parsed) {
    throw new RpcError('bad_request', `file.read: '${record_id}' is not a remote file id`, 400);
  }
  const row = deps.fileMetaStore.get(parsed.scope, parsed.target_id);
  if (!row) {
    throw new RpcError('file_not_found', `file.read: remote file '${record_id}' not found`, 404);
  }
  const { provider, remote_id } = row.meta;
  const connection_name = connectionNameFromSourceScope(parsed.scope, provider);
  if (connection_name === null) {
    throw new RpcError(
      'file_storage_missing',
      `file.read: cannot recover a connection from source scope '${parsed.scope}'`,
      500,
    );
  }
  const cred = await deps.resolveConnection(connection_name);
  if (cred === null) {
    throw new RpcError(
      'file_storage_missing',
      `file.read: connection '${connection_name}' for remote file is gone`,
      404,
    );
  }
  const resolver = deps.byteResolvers[provider];
  if (resolver === undefined) {
    throw new RpcError(
      'remote_provider_unsupported',
      `file.read: no remote byte resolver for provider '${provider}'`,
      501,
    );
  }
  const maxBytes = deps.maxBytes ?? REMOTE_FILE_READ_MAX_BYTES;
  // Preflight on the vendor-reported size (when present) — reject BEFORE the
  // fetch so an oversized object never buffers.
  if (typeof row.meta.size === 'number' && row.meta.size > maxBytes) {
    throw new RpcError(
      'remote_too_large',
      `file.read: remote file is ${row.meta.size} bytes (> ${maxBytes} ceiling)`,
      413,
    );
  }

  let result: RemoteFileByteResult;
  try {
    result = await resolver({ cred, remote_id, meta: row.meta, maxBytes });
  } catch (err) {
    // A resolver's own structured RpcError (remote_unresolvable / remote_too_large
    // / …) propagates as-is; any other throw is a transient fetch failure.
    if (isRemoteReadRpcError(err)) throw err;
    throw new RpcError(
      'remote_fetch_failed',
      `file.read: remote fetch failed for '${record_id}': ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  // Hard stop on the ACTUAL fetched length — the only guard when the vendor
  // reports no size (Notion), and a backstop against a resolver that ignored the
  // ceiling.
  if (result.bytes.length > maxBytes) {
    throw new RpcError(
      'remote_too_large',
      `file.read: remote file fetched ${result.bytes.length} bytes (> ${maxBytes} ceiling)`,
      413,
    );
  }
  const mime_type = result.mime_type ?? row.meta.mime_type ?? 'application/octet-stream';
  const filename = result.filename ?? row.meta.filename ?? 'file';
  return { bytes: result.bytes, mime_type, filename, size_bytes: result.bytes.length };
};
