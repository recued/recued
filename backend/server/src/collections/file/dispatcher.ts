/** Phase 7 (D-110) — server-side file-mutation dispatcher.
 *
 *  Connects the kernel ingredients (file-read / file-write /
 *  file-delete / file-move / file-stat) to live adapter instances.
 *  Every entry point enforces the same gate:
 *
 *    1. Instance exists in collection_instances?
 *    2. Adapter live on CollectionRegistry (or via getAdapter)?
 *    3. auth_state === 'healthy'?
 *    4. caps permit the requested operation?
 *
 *  Failures throw `RpcError`; the kernel adapter rewrites these into
 *  `IngredientError` with codes the recipe surface expects. Two
 *  layers of errors:
 *
 *  Instance / access gate (pre-adapter):
 *    - FILE_INSTANCE_NOT_FOUND  (not_found)      slug not enrolled.
 *    - FILE_INSTANCE_DEGRADED   (unauthorized)   auth_state !=
 *                                                healthy.
 *    - FILE_CAPABILITY_DENIED   (forbidden)      caps don't permit
 *                                                the op.
 *    - FILE_ADAPTER_UNREACHABLE (server_not_reachable) adapter not
 *                                                running.
 *
 *  Adapter runtime (from FileAdapterError):
 *    - FILE_NOT_FOUND           (not_found)      record missing at
 *                                                the given path.
 *    - FILE_PERMISSION_DENIED   (forbidden)      ACL / permission
 *                                                drift since the
 *                                                enroll probe.
 *    - FILE_TOO_LARGE           (payload_too_large) body exceeds
 *                                                the adapter's v1
 *                                                ceiling.
 *    - FILE_IO_ERROR            (upstream_error) generic transport
 *                                                failure — network
 *                                                glitch, disk full,
 *                                                malformed response.
 *
 *  file-stat deliberately swallows NOT_FOUND into `{ exists: false }`
 *  so recipes can use it as the "does this exist?" probe without
 *  awkward try/catch. The other adapter errors still surface.
 */

import { Buffer } from 'node:buffer';
import { RpcError } from '@recued/contracts';
import type { FileCollectionCaps, FileRecordStat } from '@recued/contracts';
import type { CollectionInstanceStore } from '../instance-store.js';
import type {
  FileAdapterInstance,
  FileMutationCapable,
} from './adapter-registry.js';
import { isMutationCapable } from './adapter-registry.js';
import { effectiveCaps, hasCap } from './caps.js';
import {
  isFileAdapterError,
  type FileAdapterError,
  type FileAdapterErrorCode,
} from './errors.js';

export interface FileDispatcherDeps {
  instances: CollectionInstanceStore;
  /** Lookup a live adapter for `(platform='file', slug)` — returns
   *  `undefined` when the adapter isn't started yet (enroll-in-
   *  progress, crash-loop recovery, …). Caller supplies this
   *  (composition root owns adapter lifecycle). */
  getAdapter: (slug: string) => FileAdapterInstance | undefined;
}

// ────────────────────────────────────────────────────────────────
// Gate helpers
// ────────────────────────────────────────────────────────────────

const requireLiveMutation = (
  deps: FileDispatcherDeps,
  slug: string,
  requirement: 'write' | 'delete',
): FileMutationCapable => {
  const row = deps.instances.get('file', slug);
  if (!row) {
    throw new RpcError(
      'not_found',
      `FILE_INSTANCE_NOT_FOUND: no file instance '${slug}'`,
      404,
    );
  }
  // `row.platform === 'file'` here so caps narrows to FileCollectionCaps
  // — the union widening from D-117 doesn't reach this branch.
  const caps = effectiveCaps(row.caps as FileCollectionCaps, row.auth_state);
  if (!hasCap(caps, requirement)) {
    throw new RpcError(
      'forbidden',
      `FILE_CAPABILITY_DENIED: instance '${slug}' (${row.adapter_type}) lacks '${requirement}' (auth_state=${row.auth_state})`,
      403,
    );
  }
  const adapter = deps.getAdapter(slug);
  if (!adapter) {
    throw new RpcError(
      'server_not_reachable',
      `FILE_ADAPTER_UNREACHABLE: instance '${slug}' is not running`,
      503,
    );
  }
  if (!isMutationCapable(adapter)) {
    throw new RpcError(
      'forbidden',
      `FILE_CAPABILITY_DENIED: adapter for '${slug}' does not support mutation`,
      403,
    );
  }
  return adapter;
};

const requireLiveRead = (
  deps: FileDispatcherDeps,
  slug: string,
): FileMutationCapable => {
  const row = deps.instances.get('file', slug);
  if (!row) {
    throw new RpcError(
      'not_found',
      `FILE_INSTANCE_NOT_FOUND: no file instance '${slug}'`,
      404,
    );
  }
  if (row.auth_state !== 'healthy') {
    throw new RpcError(
      'unauthorized',
      `FILE_INSTANCE_DEGRADED: instance '${slug}' auth_state=${row.auth_state} — configuration or credential recovery required`,
      401,
    );
  }
  const adapter = deps.getAdapter(slug);
  if (!adapter || !isMutationCapable(adapter)) {
    throw new RpcError(
      'server_not_reachable',
      `FILE_ADAPTER_UNREACHABLE: instance '${slug}' is not running`,
      503,
    );
  }
  return adapter;
};

// ────────────────────────────────────────────────────────────────
// Adapter error → RpcError mapping.
// ────────────────────────────────────────────────────────────────

const ADAPTER_ERROR_MAP: Record<
  FileAdapterErrorCode,
  { rpcCode: string; userCode: string; status: number }
> = {
  not_found: { rpcCode: 'not_found', userCode: 'FILE_NOT_FOUND', status: 404 },
  permission_denied: {
    rpcCode: 'forbidden',
    userCode: 'FILE_PERMISSION_DENIED',
    status: 403,
  },
  too_large: {
    rpcCode: 'payload_too_large',
    userCode: 'FILE_TOO_LARGE',
    status: 413,
  },
  io_error: { rpcCode: 'upstream_error', userCode: 'FILE_IO_ERROR', status: 502 },
};

const toRpcError = (
  err: FileAdapterError,
  slug: string,
  path: string,
  verb: string,
): RpcError => {
  const mapped = ADAPTER_ERROR_MAP[err.code];
  return new RpcError(
    mapped.rpcCode,
    `${mapped.userCode}: ${verb} '${path}' on instance '${slug}' failed — ${err.message}`,
    mapped.status,
  );
};

/** Run an adapter call + catch typed FileAdapterError; rethrow as
 *  a classified RpcError. Non-FileAdapterError throws are unexpected
 *  (bugs) — rethrow unchanged so the outer RPC layer turns them into
 *  a 500. */
const callAdapter = async <T>(
  slug: string,
  path: string,
  verb: string,
  fn: () => Promise<T>,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (isFileAdapterError(err)) {
      throw toRpcError(err, slug, path, verb);
    }
    throw err;
  }
};

// ────────────────────────────────────────────────────────────────
// Public handlers
// ────────────────────────────────────────────────────────────────

export const handleFileWrite = async (
  deps: FileDispatcherDeps,
  input: { slug: string; path: string; body_b64: string; mime?: string },
): Promise<{ ok: true; bytes_written: number }> => {
  const adapter = requireLiveMutation(deps, input.slug, 'write');
  const body = Buffer.from(input.body_b64, 'base64');
  await callAdapter(input.slug, input.path, 'write', () =>
    adapter.writeRecord(input.path, body, input.mime),
  );
  return { ok: true, bytes_written: body.length };
};

export const handleFileDelete = async (
  deps: FileDispatcherDeps,
  input: { slug: string; path: string },
): Promise<{ ok: true }> => {
  const adapter = requireLiveMutation(deps, input.slug, 'delete');
  await callAdapter(input.slug, input.path, 'delete', () =>
    adapter.deleteRecord(input.path),
  );
  return { ok: true };
};

export const handleFileRead = async (
  deps: FileDispatcherDeps,
  input: { slug: string; path: string },
): Promise<{ body_b64: string; mime?: string }> => {
  const adapter = requireLiveRead(deps, input.slug);
  const body = await callAdapter(input.slug, input.path, 'read', () =>
    adapter.readRecord(input.path),
  );
  // Read stat too so the caller gets the mime — cheap, single
  // HEAD-equivalent call. Swallow stat errors silently; the body
  // is the primary return.
  let mime: string | undefined;
  try {
    const stat = await adapter.statRecord(input.path);
    mime = stat.mime;
  } catch {
    mime = undefined;
  }
  return {
    body_b64: Buffer.from(body).toString('base64'),
    mime,
  };
};

/** `file-stat` — exists / size / modified_at / mime lookup. NOT_FOUND
 *  is a normal `{ exists: false }` response, not an error. Other
 *  adapter errors (permission_denied, io_error) surface as typed
 *  RpcErrors so the recipe distinguishes missing from broken. */
export const handleFileStat = async (
  deps: FileDispatcherDeps,
  input: { slug: string; path: string },
): Promise<FileRecordStat> => {
  const adapter = requireLiveRead(deps, input.slug);
  return callAdapter(input.slug, input.path, 'stat', () =>
    adapter.statRecord(input.path),
  );
};

/** `file-move` — stage source → destination, delete source on
 *  success. Rollback on destination-write failure leaves the source
 *  intact; rollback after destination write but before source delete
 *  is NOT attempted (the destination file is the desired outcome). */
export const handleFileMove = async (
  deps: FileDispatcherDeps,
  input: { from_slug: string; from_path: string; to_slug: string; to_path: string },
): Promise<{ ok: true }> => {
  const source = requireLiveMutation(deps, input.from_slug, 'delete');
  const destination = requireLiveMutation(deps, input.to_slug, 'write');

  const body = await callAdapter(input.from_slug, input.from_path, 'read', () =>
    source.readRecord(input.from_path),
  );
  await callAdapter(input.to_slug, input.to_path, 'write', () =>
    destination.writeRecord(input.to_path, body),
  );
  await callAdapter(input.from_slug, input.from_path, 'delete', () =>
    source.deleteRecord(input.from_path),
  );
  return { ok: true };
};
