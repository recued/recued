import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CONNECTION_SOURCE_ID, getFileVendorDeclaration, RpcError,
  type CloudFileSource, type CloudFileListRequest, type CloudFileListResult,
  type CloudFileSelection, type CloudFileImportRequest, type FileAttachmentSelection,
  type FileCloudCapture,
} from '@recued/contracts';
import type { FileReadDeps } from './collections/file/file-read-handler.js';
import { inboundFileRecordId, sanitizeFileDisplayName, type InboundFileCollection } from './collections/file/inbound-file-collection.js';
import { REMOTE_FILE_READ_MAX_BYTES, resolveRemoteFileBytes, describeRemoteFileDownload } from './collections/file/remote-file-byte-resolver.js';
import { parseRemoteFileRecordId, remoteFileRecordId } from './file-view-resolver.js';
import { connectionVendorOf } from './work-entity-source-boot.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import type { FileMetaRow } from './storage/file-meta-store.js';
import { deriveFileSourceFreshness, type FileSourceSyncStateStore } from './storage/file-source-sync-state.js';
import { initializePreapprovalConnections, synchronizePreapprovalConnection } from './storage/preapproval-connections.js';

export interface CloudFileAttachmentDeps {
  db: Database.Database;
  connections: Pick<ConnectionStoreSqlite, 'get' | 'list'>;
  sources: Pick<WorkEntityStore, 'getSource'>;
  syncState?: FileSourceSyncStateStore;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const changed = (): RpcError => new RpcError('file_selection_changed', 'The cloud file or connection changed. Search again and select the file.', 409);
const singleFlights = new WeakMap<Database.Database, Map<string, { key: string; promise: Promise<FileAttachmentSelection> }>>();

/** Paired-owner import. Listings never fetch bytes; completed receipts never
 * redownload, including after disconnection, deletion, or a lost acknowledgement. */
export const createCloudFileAttachments = (deps: CloudFileAttachmentDeps, getReadDeps: () => FileReadDeps | undefined) => {
  const { db } = deps;
  initializePreapprovalConnections(db);
  db.exec(`CREATE TABLE IF NOT EXISTS file_cloud_imports (
    import_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, remote_record_id TEXT NOT NULL,
    source_revision TEXT NOT NULL, record_id TEXT NOT NULL, selection_revision TEXT,
    imported_at INTEGER
  )`);
  const flights = singleFlights.get(db) ?? new Map<string, { key: string; promise: Promise<FileAttachmentSelection> }>();
  singleFlights.set(db, flights);
  const reads = (): FileReadDeps & { remote: NonNullable<FileReadDeps['remote']> } => {
    const read = getReadDeps();
    if (!read?.remote) throw new RpcError('not_configured', 'Connected file sources are unavailable.', 503);
    return { ...read, remote: read.remote };
  };
  const retained = (read: FileReadDeps): InboundFileCollection => {
    const files = read.registry.get('file', 'received') as InboundFileCollection | undefined;
    if (!files?.ingestStored || !files.attachmentLifecycle) throw new RpcError('not_configured', 'Retained files are unavailable.', 503);
    return files;
  };
  const source = (id: string) => {
    const registration = deps.sources.getSource(id);
    if (!registration || registration.top_tier_kind !== 'file' || registration.source_kind !== 'connection') throw changed();
    const row = deps.connections.list({ kind: 'api' }).find(row => {
      const provider = connectionVendorOf(row);
      return provider !== null && CONNECTION_SOURCE_ID(provider, row.name, 'file') === id;
    });
    const provider = row ? connectionVendorOf(row) : null;
    if (!row || !provider || !getFileVendorDeclaration(provider)) throw changed();
    return { row, provider, registration };
  };
  const sourceRevision = (id: string): string => {
    const { row, registration } = source(id);
    const pins = db.transaction(() => synchronizePreapprovalConnection(db, 'api', row.name, row)).immediate();
    return hash(JSON.stringify([pins, registration.registered_at]));
  };
  const sources = (): { sources: CloudFileSource[] } => ({ sources: deps.connections.list({ kind: 'api' }).flatMap(row => {
    const provider = connectionVendorOf(row); const declaration = provider ? getFileVendorDeclaration(provider) : null;
    if (!provider || !declaration) return [];
    const source_id = CONNECTION_SOURCE_ID(provider, row.name, 'file');
    const registration = deps.sources.getSource(source_id);
    if (!registration || registration.top_tier_kind !== 'file') return [];
    const freshness = deriveFileSourceFreshness(deps.syncState?.get(source_id) ?? null, Date.now());
    return [{ source_id, provider, label: `${declaration.display_name} · ${row.display_name || row.name}`,
      last_synced_at: freshness.last_success_at, stale: freshness.stale }];
  }) });
  const selection = (row: FileMetaRow, revision: string): CloudFileSelection => {
    const meta = row.meta; const read = reads();
    const maxBytes = Math.min(REMOTE_FILE_READ_MAX_BYTES, read.remote.maxBytes ?? REMOTE_FILE_READ_MAX_BYTES,
      retained(read).gate.info().available);
    const download = describeRemoteFileDownload(read.remote.byteResolvers, meta);
    const exportAs = download.export_as ? { ...download.export_as, filename: sanitizeFileDisplayName(download.export_as.filename) } : undefined;
    const unavailable_reason = download.unavailable_reason
      ?? (!download.export_as && meta.size !== undefined && meta.size > maxBytes
        ? `This file exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB import limit.` : undefined);
    return { record_id: remoteFileRecordId(row.scope, row.target_id), source_id: row.scope, filename: meta.filename,
      ...(meta.path !== undefined ? { path: meta.path } : {}), ...(meta.mime_type !== undefined ? { mime_type: meta.mime_type } : {}),
      ...(meta.size !== undefined ? { size: meta.size } : {}),
      ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}),
      selection_revision: hash(JSON.stringify([row.scope, row.target_id, meta.snapshot_hash, revision,
        ...(exportAs ? [exportAs] : [])])),
      ...(exportAs ? { export_as: exportAs } : {}),
      ...(download.unavailable_reason ? { download_unavailable_reason: download.unavailable_reason } : {}),
      ...(unavailable_reason ? { unavailable_reason } : {}) };
  };
  const get = (args: { record_id: string }): CloudFileSelection => {
    const parsed = args && typeof args.record_id === 'string' && args.record_id.length <= 12000
      ? parseRemoteFileRecordId(args.record_id) : null;
    if (!parsed) throw new RpcError('bad_request', 'Choose a connected source file.', 400);
    const current = source(parsed.scope);
    const row = reads().remote.fileMetaStore.get(parsed.scope, parsed.target_id);
    if (!row || row.meta.provider !== current.provider || row.meta.remote_id !== parsed.target_id) throw changed();
    return selection(row, sourceRevision(parsed.scope));
  };
  const list = (args: CloudFileListRequest): CloudFileListResult => {
    if (!args || typeof args.source_id !== 'string' || args.source_id.length > 2048
      || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200))
      || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))) {
      throw new RpcError('bad_request', 'Invalid cloud file search.', 400);
    }
    source(args.source_id);
    const revision = sourceRevision(args.source_id); const query = (args.query ?? '').trim(); const limit = args.limit ?? 30;
    const scope = hash(JSON.stringify([args.source_id, revision, query])); let after: string | undefined;
    if (args.cursor !== undefined) {
      try {
        if (typeof args.cursor !== 'string' || args.cursor.length > 12000) throw new Error();
        const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()) as { scope: string; after: string };
        if (cursor.scope !== scope || typeof cursor.after !== 'string' || !cursor.after || cursor.after.length > 4096) throw new Error();
        after = cursor.after;
      } catch { throw new RpcError('bad_request', 'Cloud file search changed. Search again.', 400); }
    }
    const rows = reads().remote.fileMetaStore.browse(args.source_id, query, limit + 1, after);
    const page = rows.slice(0, limit); const last = page.at(-1);
    return { files: page.map(row => selection(row, revision)), ...(rows.length > limit && last
      ? { next_cursor: Buffer.from(JSON.stringify({ scope, after: last.target_id })).toString('base64url') } : {}) };
  };
  const importFile = (args: CloudFileImportRequest): Promise<FileAttachmentSelection> => {
    if (!args || typeof args.record_id !== 'string' || args.record_id.length > 12000 || !parseRemoteFileRecordId(args.record_id)
      || typeof args.selection_revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.selection_revision)
      || typeof args.import_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.import_id)) {
      return Promise.reject(new RpcError('bad_request', 'Select a cloud file before importing.', 400));
    }
    const key = hash(JSON.stringify([args.record_id, args.selection_revision])); const active = flights.get(args.import_id);
    if (active) return active.key === key ? active.promise : Promise.reject(changed());
    if (flights.size >= 4) return Promise.reject(new RpcError('busy', 'Other files are importing. Try again shortly.', 429));
    const run = async (): Promise<FileAttachmentSelection> => {
      const read = getReadDeps();
      if (!read) throw new RpcError('not_configured', 'Retained files are unavailable.', 503);
      const files = retained(read); const lifecycle = files.attachmentLifecycle!;
      const recordId = inboundFileRecordId('connection_download', `cloud-attachment:${args.import_id}`);
      const receipt = (): FileAttachmentSelection | undefined => {
        const prior = db.prepare('SELECT request_hash,record_id,selection_revision FROM file_cloud_imports WHERE import_id=?').get(args.import_id) as
          { request_hash: string; record_id: string; selection_revision: string | null } | undefined;
        if (!prior) return undefined;
        if (prior.request_hash !== key) throw changed();
        if (!prior.selection_revision) return undefined;
        const current = lifecycle.selection(prior.record_id);
        if (current.selection_revision !== prior.selection_revision) throw changed();
        return current;
      };
      const replay = receipt(); if (replay) return replay;
      const remote = reads().remote; const parsed = parseRemoteFileRecordId(args.record_id)!;
      const assertCurrent = () => {
        if (remote.admitRemoteFetch && !remote.admitRemoteFetch()) throw new RpcError('remote_fetch_not_granted', 'Downloading from connected sources is disabled in Contracts.', 403);
        const current = source(parsed.scope);
        const row = remote.fileMetaStore.get(parsed.scope, parsed.target_id);
        if (!row || row.meta.provider !== current.provider || row.meta.remote_id !== parsed.target_id) throw changed();
        const selected = selection(row, sourceRevision(parsed.scope));
        if (selected.selection_revision !== args.selection_revision) throw changed();
        if (selected.unavailable_reason) throw new RpcError('remote_unresolvable', selected.unavailable_reason, 422);
        return { current, row };
      };
      const observed = assertCurrent();
      db.prepare(`INSERT OR IGNORE INTO file_cloud_imports (import_id,request_hash,remote_record_id,source_revision,record_id)
        VALUES(?,?,?,?,?)`).run(args.import_id, key, args.record_id, args.selection_revision, recordId);
      const concurrent = receipt(); if (concurrent) return concurrent;
      const result = await resolveRemoteFileBytes({ ...remote,
        maxBytes: Math.min(REMOTE_FILE_READ_MAX_BYTES, remote.maxBytes ?? REMOTE_FILE_READ_MAX_BYTES, files.gate.info().available),
        resolveConnection: async name => {
          const credential = await remote.resolveConnection(name);
          assertCurrent(); // Refresh may await; a replaced connection must never authenticate this selection.
          return credential;
        },
      }, args.record_id);
      assertCurrent();
      const blobHash = createHash('sha256').update(result.bytes).digest('hex');
      const meta = observed.row.meta;
      const cloudCapture: FileCloudCapture = {
        remote_record_id: args.record_id, source_id: parsed.scope, provider: meta.provider,
        source_label: `${getFileVendorDeclaration(meta.provider)!.display_name} · ${observed.current.row.display_name || observed.current.row.name}`,
        remote_id: meta.remote_id, filename: meta.filename,
        ...(meta.path !== undefined ? { path: meta.path } : {}),
        ...(meta.revision !== undefined ? { observed_revision: meta.revision } : {}),
        captured_at: Date.now(), content_hash: blobHash,
        ...(result.export_as ? { export_as: { filename: sanitizeFileDisplayName(result.filename), mime_type: result.mime_type } } : {}),
      };
      const release = lifecycle.leaseBlob(recordId, blobHash);
      try {
        if (await read.blobs.put(result.bytes) !== blobHash) throw new Error('Cloud import content hash mismatch.');
        let created = false;
        const stored = files.ingestStored({ storage_ref: { kind: 'cas', blob_hash: blobHash }, content_hash: blobHash,
          size_bytes: result.size_bytes, filename: result.filename, mime_type: result.mime_type,
          origin: 'connection_download', source_id: `cloud-attachment:${args.import_id}`,
          cloud_capture: cloudCapture }, publish => db.transaction(() => {
            const replay = receipt(); if (replay) return files.get(replay.file_id)!;
            assertCurrent();
            if (result.size_bytes > files.gate.info().available) throw new RpcError('remote_too_large', 'This file exceeds the current storage limit.', 413);
            const record = publish(); const selected = lifecycle.selection(record.record_id);
            db.prepare('UPDATE file_cloud_imports SET selection_revision=?,imported_at=? WHERE import_id=?')
              .run(selected.selection_revision, cloudCapture.captured_at, args.import_id);
            created = true; return record;
          }).immediate());
        const selected = lifecycle.selection(stored.record_id);
        if (created) await read.auditLog?.logActivity({ activity_id: '', timestamp: Date.now(), action: 'collection_record_created',
          target: recordId, detail: JSON.stringify({ operation: 'cloud_attachment_import', remote_record_id: args.record_id, content_hash: blobHash }) })
          .catch(() => { console.error('Cloud attachment import audit write failed after commit.'); });
        return selected;
      } finally { release(); }
    };
    const promise = run().finally(() => { flights.delete(args.import_id); });
    flights.set(args.import_id, { key, promise }); return promise;
  };
  return { sources, list, get, importFile };
};
