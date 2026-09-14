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

import { RpcError, type FileMetaProjection, type FileExportRepresentation } from '@recued/contracts';

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
  | 'remote_fetch_failed'
  /** The owner revoked `core.storage.file.fetch-remote`. PERMANENT until they
   *  re-grant it — never retried, and deliberately distinct from
   *  `remote_provider_unsupported` (a vendor nobody wired) and
   *  `file_storage_missing` (a connection that is gone). A caller that cannot tell
   *  "you turned this off" from "this is broken" reports the wrong thing to the
   *  owner, and the owner then debugs a setting they chose. */
  | 'remote_fetch_not_granted';

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

/** Download availability and representation, known before fetching bytes. */
export interface RemoteFileDownload {
  /** Absent for an original byte download. Size metadata describes the source,
   * not an export; only the actual exported byte length can enforce its limit. */
  export_as?: FileExportRepresentation;
  unavailable_reason?: string;
}

/** A per-vendor "fetch bytes by remote id" resolver. Notion's re-resolves the
 *  ~1h-signed url on each call (`GET /v1/blocks/{id}` → fresh url → download);
 *  S3 does a SigV4 `GetObject`; etc. It MUST abort past `req.maxBytes`, and
 *  should throw an `RpcError` with a {@link RemoteFileReadErrorCode} for a
 *  structured failure (e.g. `remote_unresolvable`) — any other throw is wrapped
 *  as `remote_fetch_failed` by the orchestrator. */
export interface RemoteFileByteResolver {
  (req: RemoteFileByteRequest): Promise<RemoteFileByteResult>;
  /** Pure metadata inspection, shared by browsing, import and ordinary reads.
   * No credentials, network calls or retained bytes. Absent means direct download. */
  describe?: (meta: FileMetaProjection) => RemoteFileDownload;
}

/** The provider → resolver registry (keyed on `FileMetaProjection.provider`). */
export type RemoteFileByteResolverRegistry = Readonly<Record<string, RemoteFileByteResolver>>;

export const describeRemoteFileDownload = (
  resolvers: RemoteFileByteResolverRegistry, meta: FileMetaProjection,
): RemoteFileDownload => {
  const resolver = resolvers[meta.provider];
  return resolver ? resolver.describe?.(meta) ?? {} : { unavailable_reason: 'Downloads are not supported for this source.' };
};

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
  /** ⛔⛔ THE `core.storage.file.fetch-remote` GATE — the ONE place the "may bytes be
   *  fetched from a connected vendor" question is asked. Injected as a PREDICATE, not
   *  a grant store, so this module grows no contract dependency (the same shape
   *  `work-entity-read-tools.ts` uses for its collection fence, and for the same
   *  reason: a fence that each call site re-implements is a fence one call site
   *  forgets).
   *
   *  ⛔ ASKED HERE, NOT AT THE CALL SITES, BECAUSE THERE ARE TWO AND THEY LOOK
   *  NOTHING ALIKE — `handleFileRead`'s `file:remote:*` branch and the CLI executor's
   *  `input_materialize` reader. Gating either one alone leaves the other open, and
   *  the CLI one is the route the shipped corpus actually uses (45 of 46 call sites
   *  pass a dynamic `source`).
   *
   *  ⚠ ABSENT ⇒ ADMIT, matching every other grant seam here (`opAdmissionGate`:
   *  "Absent ⇒ no op gate (additive)"). Fail-closed would dark-boot remote reads on
   *  every composition that has not wired it yet, and a capability that silently
   *  stops working is the harm this whole gate exists to make legible. */
  admitRemoteFetch?: () => boolean;
}

/** ⛔⛔ THE CONNECTION A `file:remote:*` READ WILL AUTHENTICATE WITH, recovered from
 *  the RECORD ID ALONE — no meta-store lookup, no connection resolve.
 *
 *  That property is the point: it lets the ADMISSION GATE know which connection a
 *  dispatch is about to use, at a layer that has the `ExecutionSource` but has not yet
 *  touched storage. Everything needed is already in the id — `file:remote:<b64
 *  scope>:<b64 target>` where scope is `<provider>.<connection>.file`, the same shape
 *  {@link connectionNameFromSourceScope} strips. The provider is the scope's leading
 *  segment, so the caller does not have to supply it.
 *
 *  `undefined` for a CAS id, a malformed id, or a scope that does not parse — never a
 *  guess. An undefined name reaching a restricted `connection_names` axis fails CLOSED
 *  at the gate, which is the correct direction: a dispatch that cannot say which
 *  connection it is about to use must not be admitted against a list that names some. */
export const remoteFileConnectionName = (record_id: unknown): string | undefined => {
  if (typeof record_id !== 'string' || record_id.length === 0) return undefined;
  const parsed = parseRemoteFileRecordId(record_id);
  if (!parsed) return undefined;
  const dot = parsed.scope.indexOf('.');
  if (dot <= 0) return undefined;
  return connectionNameFromSourceScope(parsed.scope, parsed.scope.slice(0, dot)) ?? undefined;
};

/** Every connection a dispatch's RESOLVED INPUT would authenticate with, by scanning
 *  its values for `file:remote:*` ids.
 *
 *  ⛔⛔ A SCAN, NOT A PER-OP ARG LOOKUP, AND THAT IS THE WHOLE VALUE. Two unrelated
 *  paths reach remote bytes: `core.storage.file.read` names the id in `record_id`, and
 *  the CLI executor's `input_materialize` ops name it in whatever arg their own
 *  `bind.input_materialize.arg` declares — `source` for all 101 shipped today, but
 *  that is a pack's choice, not a rule. Keying the fence on a slug or an arg name
 *  enumerates a set that grows without this file, and the miss is silent: a new
 *  materializing op would simply not be fenced. The id prefix is distinctive enough to
 *  find without asking anyone what it is called.
 *
 *  ⚠ One level deep, values only. A remote id nested inside an object or array is not
 *  found — inputs are flat by the time they reach the gate, and a recursive walk over
 *  arbitrary resolved input is a cost on every dispatch for a shape nothing produces.
 *  If that changes, this is the place. */
export const remoteFileConnectionNamesIn = (
  input: Record<string, unknown> | undefined,
): string[] => {
  if (input === undefined) return [];
  const out = new Set<string>();
  for (const value of Object.values(input)) {
    const name = remoteFileConnectionName(value);
    if (name !== undefined) out.add(name);
  }
  return [...out];
};

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
  export_as?: FileExportRepresentation;
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
  // ⛔ BEFORE ANYTHING ELSE — before the id is parsed, before the mirror row is read,
  // and long before a credential is decrypted. A revoked capability must not cause a
  // connection lookup, so the refusal cannot be distinguished from a miss by timing.
  if (deps.admitRemoteFetch !== undefined && !deps.admitRemoteFetch()) {
    throw new RpcError(
      'remote_fetch_not_granted',
      'file.read: fetching bytes from a connected file source is not granted '
        + '(core.storage.file.fetch-remote) — re-grant it in Contracts to allow this',
      403,
    );
  }
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
  const download = describeRemoteFileDownload(deps.byteResolvers, row.meta);
  if (download.unavailable_reason) throw new RpcError('remote_unresolvable', download.unavailable_reason, 422);
  // Preflight on the vendor-reported size (when present) — reject BEFORE the
  // fetch so an oversized object never buffers.
  if (!download.export_as && typeof row.meta.size === 'number' && row.meta.size > maxBytes) {
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
  if (download.export_as && (mime_type !== download.export_as.mime_type || filename !== download.export_as.filename)) {
    throw new RpcError('remote_fetch_failed', 'The exported file does not match the selected format.', 502);
  }
  return { bytes: result.bytes, mime_type, filename, size_bytes: result.bytes.length,
    ...(download.export_as ? { export_as: download.export_as } : {}) };
};
