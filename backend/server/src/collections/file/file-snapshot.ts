/** Metadata-only identity for an existing immutable CAS object. */
import type { CollectionRecord } from '@recued/contracts';

export interface FileContentSnapshot {
  record_id: string;
  blob_hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export const describeFileContent = (record: CollectionRecord & { storage_ref?: unknown }): FileContentSnapshot | null => {
  const storage = record.storage_ref;
  if (storage && typeof storage === 'object' && 'kind' in storage && storage.kind !== 'cas') return null;
  const hash = storage && typeof storage === 'object' && 'blob_hash' in storage ? storage.blob_hash : record.blob_hash;
  const hot = record.hot_fields as Record<string, unknown>;
  const size = typeof hot.size === 'number' ? hot.size : record.size_bytes;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size! < 0) return null;
  return { record_id: record.record_id, blob_hash: hash, size_bytes: size!,
    filename: typeof hot.filename === 'string' && hot.filename ? hot.filename : 'file',
    mime_type: typeof hot.mime_type === 'string' && hot.mime_type ? hot.mime_type : 'application/octet-stream' };
};

/** Include even unsupported/mutable references in lifecycle identity, so a
 * delete/recreate or change through an unreviewable state cannot resurrect it. */
export const filePreapprovalMaterial = (record: CollectionRecord & { storage_ref?: unknown }): unknown =>
  describeFileContent(record) ?? { record_id: record.record_id, hot_fields: record.hot_fields,
    blob_hash: record.blob_hash ?? null, storage_ref: record.storage_ref ?? null, size_bytes: record.size_bytes ?? null };

const accesses = new WeakMap<object, { snapshot: FileContentSnapshot; validate(): Promise<void> }>();
export const createReviewedFileAccess = (snapshot: FileContentSnapshot, validate: () => Promise<void>): object => {
  const handle = Object.freeze({}); accesses.set(handle, { snapshot: structuredClone(snapshot), validate }); return handle;
};
export const resolveReviewedFileAccess = (handle: object) => accesses.get(handle);
