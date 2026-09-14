import type { CloudFileSelection, CloudFileSource, CollectionInstanceRow, CollectionRecord } from '@recued/contracts';

/** Presentation adapters only. Remote sources stay in file_meta_ref; these rows
 * never enter the retained collection or borrow its mutation authority. The
 * reserved prefix cannot collide with an enrolled collection's slug. */
export const cloudFileSourceSlug = (id: string): string => `remote:${id}`;
export const cloudFileSourceId = (slug: string): string | undefined =>
  slug.startsWith('remote:') ? slug.slice('remote:'.length) : undefined;

export const cloudFileInstance = (source: CloudFileSource): CollectionInstanceRow => ({
  platform: 'file', slug: cloudFileSourceSlug(source.source_id), adapter_type: source.provider,
  auth_state: 'healthy', last_synced_at: source.last_synced_at,
  caps: { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'disabled', auth: 'none', path_style: 'posix' },
});

export const cloudFileRecord = (file: CloudFileSelection, sourceId: string): CollectionRecord => ({
  record_id: file.record_id, source_id: sourceId, received_at: 0, modified_at: file.mtime ?? 0,
  size_bytes: file.size ?? 0,
  hot_fields: { posture: 'remote', filename: file.filename,
    ...(file.path !== undefined ? { path: file.path } : {}),
    ...(file.mime_type !== undefined ? { mime_type: file.mime_type } : {}),
    ...(file.size !== undefined && !file.export_as ? { size: file.size } : {}),
    ...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
    ...(file.export_as ? { saves_as: file.export_as.filename } : {}),
    ...(file.unavailable_reason ? { import_unavailable: file.unavailable_reason } : {}),
  },
});
