import { createHash } from 'node:crypto';
import { RpcError, FILE_READ_CHUNK_MAX_BYTES, type FileContentReadRequest, type FileContentReadResponse } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { BlobStore } from '../../storage/blob-store.js';
import { parseRemoteFileRecordId } from '../../file-view-resolver.js';
import type { CollectionRegistry } from '../registry.js';
import type { FileStorageRef, InboundFileCollection } from './inbound-file-collection.js';
import {
  REMOTE_FILE_READ_MAX_BYTES,
  resolveRemoteFileBytes,
  type RemoteFileReadDeps,
} from './remote-file-byte-resolver.js';
import {
  isWatchedFolderCollection,
  parseWatchedFileRecordId,
  WatchedFileReadError,
} from './watched-folder-collection.js';
import { resolveReviewedFileAccess } from './file-snapshot.js';
import { assertPreapprovalOrdinaryRun, currentPreapprovalIo } from '../../preapproval-io-context.js';

export const DATA_FILE_READ_INGREDIENT_SLUG = 'data-file-read' as const;
export const DATA_FILE_RECEIVED_SLUG = 'received' as const;

export type FileReadErrorCode =
  | 'bad_request'
  | 'collection_not_found'
  | 'file_not_found'
  | 'file_storage_missing'
  | 'file_blob_missing'
  | 'file_blob_hash_mismatch'
  | 'file_remote_unsupported'
  | 'file_local_unavailable';

/** The most a watched folder's file is read for at once: the remote ceiling,
 *  the other read that does not come from the CAS. */
export const LOCAL_FILE_READ_MAX_BYTES = REMOTE_FILE_READ_MAX_BYTES;

export type FileReadRequest = FileContentReadRequest;
export type FileReadResponse = FileContentReadResponse;

export interface FileReadDeps {
  registry: CollectionRegistry;
  blobs: BlobStore;
  auditLog?: AuditLogStore;
  now?: () => number;
  /** D-192 remote byte-fetch — the bundle that lazily fetches a mirrored vendor
   *  file's bytes for a `file:remote:*` id (meta-store + connection resolver +
   *  per-vendor resolvers). Absent → a remote id stays reserved-but-unreadable
   *  (`file_remote_unsupported`, the pre-byte-fetch posture). Wired at boot once
   *  a vendor resolver exists. */
  remote?: RemoteFileReadDeps;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStorageRef = (
  record: { storage_ref?: unknown; blob_hash?: unknown },
): FileStorageRef | null => {
  const ref = record.storage_ref;
  if (isObject(ref)) {
    if (ref.kind === 'cas' && typeof ref.blob_hash === 'string' && ref.blob_hash.length > 0) {
      return { kind: 'cas', blob_hash: ref.blob_hash };
    }
    if (
      ref.kind === 'remote'
      && typeof ref.provider === 'string'
      && ref.provider.length > 0
      && typeof ref.remote_id === 'string'
      && ref.remote_id.length > 0
    ) {
      return {
        kind: 'remote',
        provider: ref.provider,
        remote_id: ref.remote_id,
        ...(typeof ref.fetch_hint === 'string' && ref.fetch_hint.length > 0
          ? { fetch_hint: ref.fetch_hint }
          : {}),
      };
    }
  }
  if (typeof record.blob_hash === 'string' && record.blob_hash.length > 0) {
    return { kind: 'cas', blob_hash: record.blob_hash };
  }
  return null;
};

export const handleFileRead = async (
  deps: FileReadDeps,
  args: { record_id?: unknown; offset?: unknown; length?: unknown; expected_hash?: unknown },
  reviewedAccess?: object,
  limits?: { maxBytes: number },
): Promise<FileReadResponse> => {
  if (typeof args.record_id !== 'string' || args.record_id.length === 0) {
    throw new RpcError('bad_request', 'file.read: record_id is required', 400);
  }
  const ranged = args.offset !== undefined || args.length !== undefined || args.expected_hash !== undefined;
  if (ranged && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0
    || !Number.isSafeInteger(args.length) || Number(args.length) < 1 || Number(args.length) > FILE_READ_CHUNK_MAX_BYTES
    || (args.expected_hash !== undefined && (typeof args.expected_hash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expected_hash))))) {
    throw new RpcError('bad_request', 'file.read: chunks require a nonnegative offset, length 1..4194304 and an optional SHA-256 expected_hash', 400);
  }
  const respond = (meta: Omit<FileReadResponse, 'bytes_b64'>, bytes: Buffer): FileReadResponse => {
    if (!ranged) return { ...meta, bytes_b64: bytes.toString('base64') };
    const offset = Number(args.offset), content_hash = meta.blob_hash || createHash('sha256').update(bytes).digest('hex');
    if (args.expected_hash !== undefined && args.expected_hash !== content_hash) {
      throw new RpcError('file_changed', 'The file changed during download. Start again.', 409);
    }
    if (offset > bytes.length) throw new RpcError('bad_request', 'file.read: offset exceeds the file size', 400);
    const end = Math.min(bytes.length, offset + Number(args.length)), chunk = bytes.subarray(offset, end);
    return { ...meta, bytes_b64: chunk.toString('base64'), offset, next_offset: end < bytes.length ? end : null,
      content_hash, chunk_hash: createHash('sha256').update(chunk).digest('hex') };
  };
  const retained = deps.registry.get('file', DATA_FILE_RECEIVED_SLUG) as InboundFileCollection | undefined;
  const checkSize = (size: unknown): void => {
    if (limits && typeof size === 'number' && size > limits.maxBytes) {
      throw new RpcError('file_too_large', 'This file is too large to preview. Download it instead.', 413);
    }
  };
  let release: (() => void) | undefined;
  try {
    reviewedAccess ??= currentPreapprovalIo()?.fileAccess(args.record_id);
    if (reviewedAccess) {
      const access = resolveReviewedFileAccess(reviewedAccess);
      if (!access || access.snapshot.record_id !== args.record_id) {
        throw new RpcError('preapproval_stale', 'The file read has no matching private snapshot.', 409);
      }
      // This is the same audited byte-egress seam as the ordinary read below.
      // Authority and the child claim are checked immediately before CAS access.
      await access.validate();
      const snapshot = access.snapshot;
      checkSize(snapshot.size_bytes);
      // The reviewed snapshot owns its bytes independently of the source row.
      // Its private access handle was validated above; lease that exact blob
      // even when the library row has since been deleted or replaced.
      const lifecycle = retained?.attachmentLifecycle;
      release = lifecycle?.leaseBlob(lifecycle.rootId(args.record_id), snapshot.blob_hash);
      if (limits) checkSize(await deps.blobs.plaintextSizeOf?.(snapshot.blob_hash));
      const bytes = await deps.blobs.get(snapshot.blob_hash);
      checkSize(bytes?.length);
      if (!bytes || bytes.length !== snapshot.size_bytes
        || createHash('sha256').update(bytes).digest('hex') !== snapshot.blob_hash) {
        throw new RpcError('preapproval_stale', 'The reviewed file bytes are missing or changed.', 409);
      }
      await access.validate();
      await deps.auditLog?.logActivity({ activity_id: '', timestamp: deps.now?.() ?? Date.now(),
        action: 'file_content_read', target: args.record_id,
        detail: JSON.stringify({ collection: 'data.file.received', posture: 'reviewed_snapshot',
          blob_hash: snapshot.blob_hash, mime_type: snapshot.mime_type, size_bytes: bytes.length }) });
      return respond(snapshot, bytes);
    }

    // A `file:remote:*` id is a mirrored vendor file (the FileMetaStore posture) —
    // a DIFFERENT id space + store from the CAS `received` collection below (which
    // would 404 on it). When a remote byte-resolver bundle is wired, LAZILY fetch
    // its bytes from the vendor (the D-192 byte-fetch path); otherwise it stays
    // reserved-but-unreadable (the pre-byte-fetch posture). Every read channel that
    // calls this handler inherits the branch behind its own gating.
    if (parseRemoteFileRecordId(args.record_id)) {
      if (deps.remote === undefined) {
        throw new RpcError(
          'file_remote_unsupported',
          'file.read: remote file storage references are reserved but not readable (no resolver wired)',
          501,
        );
      }
      assertPreapprovalOrdinaryRun();
      const remote = await resolveRemoteFileBytes(limits ? { ...deps.remote,
        maxBytes: Math.min(limits.maxBytes, deps.remote.maxBytes ?? limits.maxBytes) } : deps.remote, args.record_id);
      assertPreapprovalOrdinaryRun();
      await deps.auditLog?.logActivity({
        activity_id: '',
        timestamp: deps.now?.() ?? Date.now(),
        action: 'file_content_read',
        target: args.record_id,
        detail: JSON.stringify({
          collection: 'file_meta_ref',
          posture: 'remote',
          mime_type: remote.mime_type,
          size_bytes: remote.size_bytes,
        }),
      });
      return respond({
        record_id: args.record_id,
        mime_type: remote.mime_type,
        filename: remote.filename,
        size_bytes: remote.size_bytes,
        // Uncached (stream-through, v1) — no CAS blob backs a remote read.
        blob_hash: '',
      }, Buffer.from(remote.bytes));
    }

    // D-106 follow-up — a `file:local:*` id is a watched folder's file: its bytes
    // are on the owner's disk, read through that folder's live adapter. The same
    // gating as a remote read: refused inside a reviewed run, audited here.
    const local = parseWatchedFileRecordId(args.record_id);
    if (local) {
      const folder = deps.registry.get('file', local.slug);
      if (!folder || !isWatchedFolderCollection(folder)) {
        throw new RpcError('file_not_found', `file.read: no watched folder '${local.slug}'`, 404);
      }
      assertPreapprovalOrdinaryRun();
      const maxBytes = Math.min(limits?.maxBytes ?? LOCAL_FILE_READ_MAX_BYTES, LOCAL_FILE_READ_MAX_BYTES);
      let file: Awaited<ReturnType<typeof folder.readFile>>;
      try {
        file = await folder.readFile(local.path, maxBytes);
      } catch (err) {
        if (err instanceof WatchedFileReadError) {
          if (err.reason === 'too_large') {
            throw new RpcError('file_too_large', `file.read: ${err.message}. Open it from the folder instead.`, 413);
          }
          if (err.reason === 'not_found') throw new RpcError('file_not_found', `file.read: ${err.message}`, 404);
          throw new RpcError('file_local_unavailable', `file.read: ${err.message}`, 503);
        }
        throw err;
      }
      assertPreapprovalOrdinaryRun();
      const bytes = Buffer.from(file.bytes);
      await deps.auditLog?.logActivity({
        activity_id: '',
        timestamp: deps.now?.() ?? Date.now(),
        action: 'file_content_read',
        target: args.record_id,
        detail: JSON.stringify({
          collection: `data.file.${local.slug}`,
          posture: 'local',
          mime_type: file.mime_type,
          size_bytes: bytes.length,
        }),
      });
      return respond({
        record_id: args.record_id,
        mime_type: file.mime_type,
        filename: file.filename,
        size_bytes: bytes.length,
        // Not in the CAS: the hash of what was read, for a caller that pins it.
        blob_hash: createHash('sha256').update(bytes).digest('hex'),
      }, bytes);
    }

    const collection = deps.registry.get('file', DATA_FILE_RECEIVED_SLUG);
    if (!collection) {
      throw new RpcError(
        'collection_not_found',
        'file.read: data.file.received collection is not registered',
        503,
      );
    }

    const record = collection.get(args.record_id);
    if (!record) {
      throw new RpcError(
        'file_not_found',
        `file.read: record '${args.record_id}' not found`,
        404,
      );
    }

    const storageRef = readStorageRef(record);
    if (!storageRef) {
      throw new RpcError(
        'file_storage_missing',
        `file.read: record '${args.record_id}' has no storage_ref`,
        500,
      );
    }
    if (storageRef.kind === 'remote') {
      throw new RpcError(
        'file_remote_unsupported',
        'file.read: a remote reference in the CAS collection cannot be resolved; use its file_meta_ref record id',
        501,
      );
    }

    assertPreapprovalOrdinaryRun();
    checkSize(record.size_bytes);
    release = retained?.attachmentLifecycle?.lease(args.record_id, storageRef.blob_hash);
    if (limits) checkSize(await deps.blobs.plaintextSizeOf?.(storageRef.blob_hash));
    const bytes = await deps.blobs.get(storageRef.blob_hash);
    checkSize(bytes?.length);
    assertPreapprovalOrdinaryRun();
    if (!bytes) {
      throw new RpcError(
        'file_blob_missing',
        `file.read: CAS blob '${storageRef.blob_hash}' not found`,
        404,
      );
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    if (contentHash !== storageRef.blob_hash) {
      throw new RpcError(
        'file_blob_hash_mismatch',
        `file.read: CAS blob '${storageRef.blob_hash}' does not match its content address`,
        500,
      );
    }

    const hot = record.hot_fields as Record<string, unknown>;
    const mime_type = typeof hot.mime_type === 'string' && hot.mime_type.length > 0
      ? hot.mime_type
      : 'application/octet-stream';
    const filename = typeof hot.filename === 'string' && hot.filename.length > 0
      ? hot.filename
      : 'file';

    await deps.auditLog?.logActivity({
      activity_id: '',
      timestamp: deps.now?.() ?? Date.now(),
      action: 'file_content_read',
      target: args.record_id,
      detail: JSON.stringify({
        collection: 'data.file.received',
        blob_hash: storageRef.blob_hash,
        mime_type,
        size_bytes: bytes.length,
      }),
    });

    return respond({
      record_id: args.record_id,
      mime_type,
      filename,
      size_bytes: bytes.length,
      blob_hash: storageRef.blob_hash,
    }, bytes);
  } finally { release?.(); }
};
