/** D-106 follow-up — a file in a folder Recued watches, brought into Chat.
 *
 *  Chat attaches retained files only (a sent message pins an immutable
 *  version), so a watched file goes in as a copy, as a connected source's file
 *  does (`cloud-file-attachments.ts`): read from its folder once, stored in the
 *  received files with `origin: 'watched_folder'`, and left alone by later
 *  edits in the folder. Idempotent per `import_id`: a retry after a lost reply
 *  returns the same copy, never a second one. */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  RpcError,
  type CloudFileImportRequest,
  type CloudFileSelection,
  type FileAttachmentSelection,
} from '@recued/contracts';
import { LOCAL_FILE_READ_MAX_BYTES, type FileReadDeps } from './collections/file/file-read-handler.js';
import { inboundFileRecordId, type InboundFileCollection } from './collections/file/inbound-file-collection.js';
import {
  isWatchedFolderCollection,
  parseWatchedFileRecordId,
  WatchedFileReadError,
} from './collections/file/watched-folder-collection.js';
import type { CollectionRegistry } from './collections/registry.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const changed = (): RpcError =>
  new RpcError('file_selection_changed', 'This file changed in its folder. Select it again.', 409);
const gone = (): RpcError => new RpcError('file_not_found', 'This file is no longer in its folder.', 404);

/** A watched file as a selection, from its record. The revision follows the
 *  file's modified time and size, so an edit the watch reports makes an earlier
 *  selection stale. The preview and the import both use it, so a revision one
 *  hands out the other accepts. `limit`: past it the file is offered with the
 *  limit's reason instead. */
export const watchedFileSelection = (
  registry: CollectionRegistry,
  record_id: string,
  limit?: ImportLimit,
): CloudFileSelection => {
  const parsed = parseWatchedFileRecordId(record_id);
  const folder = parsed ? registry.get('file', parsed.slug) : undefined;
  const record = folder && isWatchedFolderCollection(folder) ? folder.get(record_id) : null;
  if (!parsed || !record) throw gone();
  const h = record.hot_fields;
  const size = typeof h.size === 'number' ? h.size : undefined;
  return {
    record_id,
    source_id: parsed.slug,
    filename: typeof h.filename === 'string' ? h.filename : parsed.path,
    path: parsed.path,
    ...(typeof h.mime_type === 'string' ? { mime_type: h.mime_type } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(typeof h.mtime === 'number' ? { mtime: h.mtime } : {}),
    selection_revision: hash(`${record_id}\0${String(h.mtime)}\0${String(h.size)}`),
    ...(limit !== undefined && size !== undefined && size > limit.bytes ? { unavailable_reason: limit.reason } : {}),
  };
};

/** How much one import may bring in, and why that much. */
export interface ImportLimit { bytes: number; reason: string }

/** Imports in flight, per database: one import id is one import. */
const singleFlights = new WeakMap<Database.Database, Map<string, { key: string; promise: Promise<FileAttachmentSelection> }>>();

export const createFolderFileAttachments = (
  db: Database.Database,
  getReadDeps: () => FileReadDeps | undefined,
) => {
  db.exec(`CREATE TABLE IF NOT EXISTS file_folder_imports (
    import_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, folder_record_id TEXT NOT NULL,
    record_id TEXT NOT NULL, selection_revision TEXT, imported_at INTEGER
  )`);
  const flights = singleFlights.get(db) ?? new Map<string, { key: string; promise: Promise<FileAttachmentSelection> }>();
  singleFlights.set(db, flights);
  const reads = (): FileReadDeps => {
    const read = getReadDeps();
    if (!read) throw new RpcError('not_configured', 'Retained files are unavailable.', 503);
    return read;
  };
  const retained = (read: FileReadDeps): InboundFileCollection => {
    const files = read.registry.get('file', 'received') as InboundFileCollection | undefined;
    if (!files?.ingestStored || !files.attachmentLifecycle) throw new RpcError('not_configured', 'Retained files are unavailable.', 503);
    return files;
  };
  /** The read cap, and no more than the received files have room for. */
  const importLimit = (files: InboundFileCollection): ImportLimit => {
    const room = files.gate.info().available;
    return room < LOCAL_FILE_READ_MAX_BYTES
      ? { bytes: room, reason: 'There is not enough room left in your saved files for this file.' }
      : { bytes: LOCAL_FILE_READ_MAX_BYTES, reason: `This file exceeds the ${Math.floor(LOCAL_FILE_READ_MAX_BYTES / 1024 / 1024)} MB import limit.` };
  };

  const get = (args: { record_id: string }): CloudFileSelection => {
    if (!args || typeof args.record_id !== 'string' || args.record_id.length > 12000
      || parseWatchedFileRecordId(args.record_id) === null) {
      throw new RpcError('bad_request', 'Choose a file in a watched folder.', 400);
    }
    const read = reads();
    return watchedFileSelection(read.registry, args.record_id, importLimit(retained(read)));
  };

  const importFile = (args: CloudFileImportRequest): Promise<FileAttachmentSelection> => {
    if (!args || typeof args.record_id !== 'string' || args.record_id.length > 12000
      || parseWatchedFileRecordId(args.record_id) === null
      || typeof args.selection_revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.selection_revision)
      || typeof args.import_id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.import_id)) {
      return Promise.reject(new RpcError('bad_request', 'Select a file in a watched folder before importing.', 400));
    }
    const key = hash(JSON.stringify([args.record_id, args.selection_revision]));
    const active = flights.get(args.import_id);
    if (active) return active.key === key ? active.promise : Promise.reject(changed());
    if (flights.size >= 4) return Promise.reject(new RpcError('busy', 'Other files are importing. Try again shortly.', 429));
    const run = async (): Promise<FileAttachmentSelection> => {
      const read = reads();
      const files = retained(read);
      const lifecycle = files.attachmentLifecycle!;
      const sourceId = `folder-attachment:${args.import_id}`;
      const recordId = inboundFileRecordId('watched_folder', sourceId);
      /** A completed import answers a retry with its copy. */
      const receipt = (): FileAttachmentSelection | undefined => {
        const prior = db.prepare('SELECT request_hash,record_id,selection_revision FROM file_folder_imports WHERE import_id=?')
          .get(args.import_id) as { request_hash: string; record_id: string; selection_revision: string | null } | undefined;
        if (!prior) return undefined;
        if (prior.request_hash !== key) throw changed();
        if (!prior.selection_revision) return undefined;
        const current = lifecycle.selection(prior.record_id);
        if (current.selection_revision !== prior.selection_revision) throw changed();
        return current;
      };
      const replay = receipt();
      if (replay) return replay;
      const assertCurrent = (): void => {
        const selected = watchedFileSelection(read.registry, args.record_id, importLimit(files));
        if (selected.selection_revision !== args.selection_revision) throw changed();
        if (selected.unavailable_reason) throw new RpcError('file_too_large', selected.unavailable_reason, 413);
      };
      assertCurrent();
      db.prepare(`INSERT OR IGNORE INTO file_folder_imports (import_id,request_hash,folder_record_id,record_id)
        VALUES(?,?,?,?)`).run(args.import_id, key, args.record_id, recordId);
      const concurrent = receipt();
      if (concurrent) return concurrent;

      const parsed = parseWatchedFileRecordId(args.record_id)!;
      const folder = read.registry.get('file', parsed.slug);
      if (!folder || !isWatchedFolderCollection(folder)) throw gone();
      let file: Awaited<ReturnType<typeof folder.readFile>>;
      try {
        file = await folder.readFile(parsed.path, importLimit(files).bytes);
      } catch (err) {
        if (!(err instanceof WatchedFileReadError)) throw err;
        if (err.reason === 'not_found') throw gone();
        if (err.reason === 'too_large') throw new RpcError('file_too_large', 'This file is too large to import.', 413);
        throw new RpcError('file_local_unavailable', `${err.message}. Try again once the folder is back.`, 503);
      }
      // Edited while it was read: the watch has moved its record on.
      assertCurrent();
      const bytes = Buffer.from(file.bytes);
      const blobHash = createHash('sha256').update(bytes).digest('hex');
      const release = lifecycle.leaseBlob(recordId, blobHash);
      try {
        if (await read.blobs.put(bytes) !== blobHash) throw new Error('Folder import content hash mismatch.');
        let created = false;
        const stored = files.ingestStored({
          storage_ref: { kind: 'cas', blob_hash: blobHash }, content_hash: blobHash,
          size_bytes: bytes.length, filename: file.filename, mime_type: file.mime_type,
          origin: 'watched_folder', source_id: sourceId,
        }, (publish) => db.transaction(() => {
          const again = receipt();
          if (again) return files.get(again.file_id)!;
          assertCurrent();
          if (bytes.length > files.gate.info().available) {
            throw new RpcError('file_too_large', 'This file exceeds the current storage limit.', 413);
          }
          const record = publish();
          const selected = lifecycle.selection(record.record_id);
          db.prepare('UPDATE file_folder_imports SET selection_revision=?,imported_at=? WHERE import_id=?')
            .run(selected.selection_revision, Date.now(), args.import_id);
          created = true;
          return record;
        }).immediate());
        const selected = lifecycle.selection(stored.record_id);
        if (created) {
          await read.auditLog?.logActivity({
            activity_id: '', timestamp: Date.now(), action: 'collection_record_created', target: recordId,
            detail: JSON.stringify({ operation: 'folder_attachment_import', folder_record_id: args.record_id, content_hash: blobHash }),
          }).catch(() => { console.error('Folder attachment import audit write failed after commit.'); });
        }
        return selected;
      } finally { release(); }
    };
    const promise = run().finally(() => { flights.delete(args.import_id); });
    flights.set(args.import_id, { key, promise });
    return promise;
  };

  return { get, importFile };
};
