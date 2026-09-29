import type { CloudFileSelection, CloudFileSource, CollectionInstanceRow, CollectionRecord } from '@recued/contracts';

/** Presentation adapters only. Remote sources stay in file_meta_ref; these rows
 * never enter the retained collection or borrow its mutation authority. The
 * reserved prefix cannot collide with an enrolled collection's slug. */
export const cloudFileSourceSlug = (id: string): string => `remote:${id}`;
export const cloudFileSourceId = (slug: string): string | undefined =>
  slug.startsWith('remote:') ? slug.slice('remote:'.length) : undefined;

/** ⛔ THE FILES SAVED IN RECUED ITSELF HAD NO SOURCE TO LIST THEM UNDER.
 *  Uploads (and what chat keeps) live in the `file/received` collection, which
 *  is registered at boot — never enrolled — so it has no `collection_instances`
 *  row. The Files tab's sources come from that table and from connected clouds
 *  only: an upload said "Uploaded ✓" and then the tab said "Nothing connected
 *  for file yet" (seen live, 2026-09-27). Everything past the source list —
 *  records, preview, download, delete, the "Saved files" label — already worked
 *  for `received`. It is a webclient row only: `collection.listInstances` also
 *  feeds the Connections lane, where a row for it would offer a resync and a
 *  delete that have nothing to act on. */
export const SAVED_FILES_SLUG = 'received';
export const savedFilesInstance: CollectionInstanceRow = {
  platform: 'file', slug: SAVED_FILES_SLUG, adapter_type: 'local',
  auth_state: 'healthy', last_synced_at: null,
  caps: { read: 'yes', write: 'no', delete: 'yes', watch: 'none', mirror: 'disabled', auth: 'none', path_style: 'posix' },
};

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
