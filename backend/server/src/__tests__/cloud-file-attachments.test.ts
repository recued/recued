import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { isReservedLocalRpc, type ChatMessageAttachment } from '@recued/contracts';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import type { RemoteFileReadDeps } from '../collections/file/remote-file-byte-resolver.js';
import type { FileFetch } from '../file-source-adapters/index.js';
import { buildRemoteFileByteResolvers } from '../collections/file/remote-byte-resolvers/index.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createFileMetaStore, ensureFileMetaSchema, buildFileMetaSnapshot } from '../storage/file-meta-store.js';
import { wireFileSourceBoot } from '../file-source-boot.js';
import { makeFileReadRpcHandlers } from '../file-read-rpc-handler.js';
import { remoteFileRecordId } from '../file-view-resolver.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createMessengerAttachmentSource } from '../chat-messenger-attachments.js';
import type { WsClient } from '../ws-server.js';

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
const client = { instance_id: 'paired' } as WsClient;
const scope = 'google.work.file';
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-file-attachments-')); const db = new Database(':memory:');
  close.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  ensureWorkEntitySchema(db); ensureFileMetaSchema(db); ensureChatSchema(db);
  const connections = createConnectionStore(db); const sources = createWorkEntityStore(db); const meta = createFileMetaStore(db);
  const enroll = (name = 'work', vendor = 'google') => connections.upsert({ kind: 'api', name, display_name: name,
    config_json: JSON.stringify({ vendor }), auth_ciphertext: 'encrypted-secret', enrolled_at: 1, updated_at: 1 });
  enroll(); wireFileSourceBoot({ connectionStore: connections, store: sources });
  const blobs = createEncryptedBlobStore(join(dir, 'cas'), () => new Uint8Array(32).fill(31));
  const files = createInboundFileCollection({ db, blobs, slug: 'received', bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }) });
  const registry = createCollectionRegistry(); registry.register(files);
  const fetchImpl = vi.fn<FileFetch>(async () => new Response('%PDF-retained-cloud-copy', { headers: { 'Content-Type': 'application/pdf' } }));
  const resolveConnection = vi.fn(async () => ({ auth: { type: 'bearer' as const, token: 'download-secret' }, config: {} }));
  let granted = true;
  const remote: RemoteFileReadDeps = { fileMetaStore: meta, resolveConnection, byteResolvers: buildRemoteFileByteResolvers({ fetchImpl }), admitRemoteFetch: () => granted };
  const deps = { cloudAttachments: { db, connections, sources }, getFileReadDeps: () => ({ registry, blobs, remote }) };
  const makeHandlers = () => makeFileReadRpcHandlers(deps)!.handlers;
  const handlers = makeHandlers();
  const add = (id: string, filename = 'Report.pdf', extra = {}, source_id = scope) => meta.upsert({ scope: source_id, target_id: id,
    meta: buildFileMetaSnapshot({ filename, provider: source_id.split('.')[0]!, remote_id: id, mime_type: 'application/pdf',
      revision: 'v1', path: `/Clients/${filename}`, ...extra }, 10), now: 10 });
  add('one');
  const select = async () => (await handlers['data.file.attachments.remote.list']({ source_id: scope }, client)).files[0]!;
  const request = async () => { const selected = await select(); return { record_id: selected.record_id,
    selection_revision: selected.selection_revision, import_id: randomUUID() }; };
  const importFile = async () => handlers['data.file.attachments.import'](await request(), client);
  return { dir, db, meta, files, blobs, connections, sources, fetchImpl, resolveConnection, remote, handlers, makeHandlers,
    add, enroll, select, request, importFile, revoke: () => { granted = false; } };
};

describe('connected cloud attachments', () => {
  it('previews through the production download adapter without retaining bytes or changing remote metadata', async () => {
    const f = fixture(); const id = remoteFileRecordId(scope, 'one'); const before = f.meta.get(scope, 'one');
    const put = vi.spyOn(f.blobs, 'put'); const selection = await f.select();
    expect(await f.handlers['data.file.attachments.preview']({ record_id: id, selection_revision: selection.selection_revision }, client))
      .toMatchObject({ record_id: id, transient: true, can_download: true, filename: 'Report.pdf',
        content: { kind: 'pdf', bytes_b64: Buffer.from('%PDF-retained-cloud-copy').toString('base64') } });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled();
    expect(f.files.totalBytes()).toBe(0); expect(f.meta.get(scope, 'one')).toEqual(before);
    f.revoke(); await expect(f.handlers['data.file.attachments.preview']({ record_id: id }, client))
      .rejects.toMatchObject({ code: 'remote_fetch_not_granted' });
  });

  it('keeps unsupported and native exports metadata-only until Download is chosen', async () => {
    const f = fixture(); const id = remoteFileRecordId(scope, 'one');
    f.add('one', 'Planning', { mime_type: 'application/vnd.google-apps.document' });
    expect(await f.handlers['data.file.attachments.preview']({ record_id: id }, client)).toMatchObject({
      filename: 'Planning.docx', can_download: true, unavailable_reason: expect.stringContaining('no preview') });
    f.add('one', 'Form', { mime_type: 'application/vnd.google-apps.form' });
    expect(await f.handlers['data.file.attachments.preview']({ record_id: id }, client)).toMatchObject({
      can_download: false, unavailable_reason: expect.stringContaining('cannot be exported') });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds remote preview reads and ignores import storage capacity', async () => {
    const f = fixture(); const id = remoteFileRecordId(scope, 'one');
    const info = f.files.gate.info.bind(f.files.gate);
    vi.spyOn(f.files.gate, 'info').mockImplementation(() => ({ ...info(), available: 0 }));
    f.add('one', 'Report.pdf', { size: 23 });
    expect((await f.select()).unavailable_reason).toContain('limit');
    expect(await f.handlers['data.file.attachments.preview']({ record_id: id }, client)).toHaveProperty('content.kind', 'pdf');
    f.remote.maxBytes = 5;
    expect(await f.handlers['data.file.attachments.preview']({ record_id: id }, client)).toMatchObject({
      can_download: true, unavailable_reason: expect.stringContaining('limit') });
    expect(f.files.totalBytes()).toBe(0);
  });

  it('retires remote metadata changes and disconnection during download', async () => {
    const f = fixture(); const id = remoteFileRecordId(scope, 'one'); const selected = await f.select();
    f.add('one', 'New name.pdf');
    await expect(f.handlers['data.file.attachments.preview']({ record_id: id, selection_revision: selected.selection_revision }, client))
      .rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    f.fetchImpl.mockImplementationOnce(async () => {
      f.add('one', 'Changed during read.pdf'); return new Response('%PDF-changed', { headers: { 'Content-Type': 'application/pdf' } });
    });
    await expect(f.handlers['data.file.attachments.preview']({ record_id: id }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    f.fetchImpl.mockImplementationOnce(async () => {
      f.connections.delete('api', 'work'); return new Response('%PDF-disconnected', { headers: { 'Content-Type': 'application/pdf' } });
    });
    await expect(f.handlers['data.file.attachments.preview']({ record_id: id }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.files.totalBytes()).toBe(0);
  });

  it('gets the exact remote selection without searching, credentials or bytes and rejects invalid identities', async () => {
    const f = fixture(); const id = remoteFileRecordId(scope, 'one');
    expect(await f.handlers['data.file.attachments.remote.get']({ record_id: id }, client)).toEqual(await f.select());
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.resolveConnection).not.toHaveBeenCalled();
    await expect(f.handlers['data.file.attachments.remote.get']({ record_id: 'file:bad' }, client)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.handlers['data.file.attachments.remote.get']({ record_id: remoteFileRecordId(scope, 'missing') }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    f.add('one', 'Forged source', { provider: 'dropbox' });
    await expect(f.handlers['data.file.attachments.remote.get']({ record_id: id }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    f.add('one'); f.connections.delete('api', 'work');
    await expect(f.handlers['data.file.attachments.remote.get']({ record_id: id }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
  });

  it.each(['google', 'dropbox', 'onedrive', 'sharepoint', 'box', 's3', 'notion'])(
    '%s follows the same source, selection and retained-import protocol', async provider => {
      const f = fixture(); const sourceId = `${provider}.library.file`; f.enroll('library', provider);
      f.add('same-id', 'Library file.txt', {}, sourceId);
      f.remote.byteResolvers = { ...f.remote.byteResolvers, [provider]: async () => ({ bytes: Buffer.from('unified file'), mime_type: 'text/plain' }) };
      const sources = await f.handlers['data.file.attachments.sources'](undefined, client);
      expect(sources.sources.some(source => source.source_id === sourceId)).toBe(true);
      const listing = await f.handlers['data.file.attachments.remote.list']({ source_id: sourceId }, client);
      const selected = await f.handlers['data.file.attachments.remote.get']({ record_id: remoteFileRecordId(sourceId, 'same-id') }, client);
      expect(selected).toEqual(listing.files[0]); expect(selected.unavailable_reason).toBeUndefined();
      expect(await f.handlers['data.file.attachments.preview']({ record_id: selected.record_id, selection_revision: selected.selection_revision }, client))
        .toMatchObject({ transient: true, content: { kind: 'text', bytes_b64: Buffer.from('unified file').toString('base64') } });
      expect(f.files.totalBytes()).toBe(0);
      const saved = await f.handlers['data.file.attachments.import']({ record_id: selected.record_id,
        selection_revision: selected.selection_revision, import_id: randomUUID() }, client);
      expect((await f.files.readBytes(saved.file_id)).bytes.toString()).toBe('unified file');
      expect(f.files.get(saved.file_id)!.hot_fields.cloud_capture).toMatchObject({ source_id: sourceId, provider });
    },
  );

  it.each([
    ['document', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['spreadsheet', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['presentation', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('exports a Google %s through ordinary reads and retained import with matching provenance', async (kind, extension, mime) => {
    const f = fixture(); f.add('one', 'Native file', { mime_type: `application/vnd.google-apps.${kind}`, size: 50 * 1024 * 1024 });
    f.fetchImpl.mockImplementation(async () => new Response('portable export', { headers: { 'Content-Type': mime! } }));
    const selected = await f.select();
    expect(selected.unavailable_reason).toBeUndefined();
    expect(selected.export_as).toEqual({ filename: `Native file.${extension}`, mime_type: mime });
    const before = f.meta.get(scope, 'one');
    const transient = await f.handlers['data.file.read']({ record_id: selected.record_id }, client);
    expect(transient).toMatchObject({ filename: `Native file.${extension}`, mime_type: mime, blob_hash: '' });
    expect(f.files.list({ platform: 'file', slug: 'received' })).toHaveLength(0);
    expect(f.meta.get(scope, 'one')).toEqual(before);
    const request = { record_id: selected.record_id, selection_revision: selected.selection_revision, import_id: randomUUID() };
    const saved = await f.handlers['data.file.attachments.import'](request, client);
    expect(saved).toMatchObject({ filename: `Native file.${extension}`, mime_type: mime, size: 15 });
    expect(f.files.get(saved.file_id)!.hot_fields.cloud_capture).toMatchObject({
      filename: 'Native file', observed_revision: 'v1', export_as: selected.export_as,
      content_hash: createHash('sha256').update('portable export').digest('hex'),
    });
    f.add('one', 'Mutated', { revision: 'v2' }); f.connections.delete('api', 'work'); f.revoke();
    expect(await f.handlers['data.file.attachments.import'](request, client)).toEqual(saved);
    expect((await f.files.readBytes(saved.file_id)).bytes.toString()).toBe('portable export');
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pins the advertised export format and refuses an adapter change after selection', async () => {
    const f = fixture(); const request = await f.request();
    f.remote.byteResolvers = { ...f.remote.byteResolvers, google: Object.assign(async () => ({ bytes: Buffer.from('changed') }),
      { describe: () => ({ export_as: { filename: 'Changed.txt', mime_type: 'text/plain' } }) }) };
    await expect(f.handlers['data.file.attachments.import'](request, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.files.totalBytes()).toBe(0);
  });

  it('advertises and captures the actual retained export filename after file-name normalization', async () => {
    const f = fixture(); const original = 'folder/Plan\n reviewed';
    f.add('one', original, { mime_type: 'application/vnd.google-apps.document' });
    f.fetchImpl.mockImplementation(async () => new Response('export', { headers: { 'content-type': 'application/octet-stream' } }));
    const selected = await f.select(); const saved = await f.importFile();
    expect(selected.export_as!.filename).toBe(saved.filename);
    expect(saved.filename).toBe('Plan reviewed.docx');
    expect(f.files.get(saved.file_id)!.hot_fields.cloud_capture).toMatchObject({ filename: original, export_as: selected.export_as });
  });

  it('requires a paired owner for every method before reading sources or fetching bytes', async () => {
    const f = fixture(); const unpaired = {} as WsClient;
    await expect(f.handlers['data.file.attachments.sources'](undefined, unpaired)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.handlers['data.file.attachments.remote.list']({ source_id: scope }, unpaired)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.handlers['data.file.attachments.remote.get']({ record_id: remoteFileRecordId(scope, 'one') }, unpaired)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(f.handlers['data.file.attachments.import'](await f.request(), unpaired)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.resolveConnection).not.toHaveBeenCalled();
    // These paired-only mutations must remain outside the MCP tool surface.
    expect(isReservedLocalRpc('data.file.attachments.import')).toBe(true);
    expect(isReservedLocalRpc('data.file.attachments.remote.get')).toBe(true);
  });

  it('browses names and paths before pagination, hides disconnected sources, and reads no bytes or credentials', async () => {
    const f = fixture(); f.enroll('other', 'dropbox');
    for (let i = 0; i < 36; i++) f.add(`item-${String(i).padStart(2, '0')}`, `Invoice ${i}.pdf`);
    f.add('foreign', 'Invoice elsewhere.pdf', {}, 'dropbox.other.file');
    const args = { source_id: scope, query: 'clients invoice', limit: 30 };
    const first = await f.handlers['data.file.attachments.remote.list'](args, client);
    const second = await f.handlers['data.file.attachments.remote.list']({ ...args, cursor: first.next_cursor }, client);
    expect(first.files).toHaveLength(30); expect(second.files).toHaveLength(6); expect(second.next_cursor).toBeUndefined();
    expect(new Set([...first.files, ...second.files].map(f => f.record_id)).size).toBe(36);
    await expect(f.handlers['data.file.attachments.remote.list']({ ...args, query: 'changed', cursor: first.next_cursor }, client)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.handlers['data.file.attachments.remote.list']({ ...args, source_id: 'dropbox.other.file', cursor: first.next_cursor }, client)).rejects.toMatchObject({ code: 'bad_request' });
    f.connections.delete('api', 'other');
    expect((await f.handlers['data.file.attachments.sources'](undefined, client)).sources).toHaveLength(1);
    await expect(f.handlers['data.file.attachments.remote.list']({ source_id: 'dropbox.other.file' }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.files.totalBytes()).toBe(0); expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.resolveConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toContain('encrypted-secret');
  });

  it('uses the production Google byte resolver, retains a CAS copy, and replays a lost ACK after disconnect', async () => {
    const f = fixture(); const args = await f.request();
    const result = await f.handlers['data.file.attachments.import'](args, client);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.fetchImpl.mock.calls[0]).toEqual(expect.arrayContaining(['https://www.googleapis.com/drive/v3/files/one?alt=media&supportsAllDrives=true']));
    expect(result).toMatchObject({ filename: 'Report.pdf', mime_type: 'application/pdf', size: 24, selection_revision: expect.any(String) });
    const record = f.files.get(result.file_id)!;
    expect(record.storage_ref.kind).toBe('cas'); expect(record.hot_fields.origin).toBe('connection_download');
    expect((await f.files.readBytes(result.file_id)).bytes.toString()).toBe('%PDF-retained-cloud-copy');
    f.connections.delete('api', 'work'); f.revoke();
    expect(await f.makeHandlers()['data.file.attachments.import'](args, client)).toEqual(result);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.files.list({ platform: 'file', slug: 'received' })).toHaveLength(1);
    expect(f.db.prepare('SELECT remote_record_id FROM file_cloud_imports').get()).toEqual({ remote_record_id: args.record_id });
  });

  it('coalesces concurrent retries and never reuses an import ID for a different selection', async () => {
    const f = fixture(); const args = await f.request(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    f.fetchImpl.mockImplementationOnce(async () => { await waiting; return new Response('one'); });
    const a = f.handlers['data.file.attachments.import'](args, client); const b = f.makeHandlers()['data.file.attachments.import'](args, client);
    await expect(f.handlers['data.file.attachments.import']({ ...args, record_id: remoteFileRecordId(scope, 'other') }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    release(); expect(await a).toEqual(await b); expect(f.fetchImpl).toHaveBeenCalledOnce();
    await expect(f.handlers['data.file.attachments.import']({ ...args, selection_revision: '0'.repeat(64) }, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
  });

  it('ordinary remote reads leave the metadata mirror unchanged and retain no file or CAS copy', async () => {
    const f = fixture(); const before = f.meta.get(scope, 'one'); const put = vi.spyOn(f.blobs, 'put');
    const read = await f.handlers['data.file.read']({ record_id: remoteFileRecordId(scope, 'one') }, client);
    expect(Buffer.from(read.bytes_b64, 'base64').toString()).toBe('%PDF-retained-cloud-copy');
    expect(read.blob_hash).toBe(''); expect(put).not.toHaveBeenCalled();
    expect(f.files.list({ platform: 'file', slug: 'received' })).toEqual([]);
    expect(f.meta.get(scope, 'one')).toEqual(before);
  });

  it('rejects capture metadata whose fingerprint does not match the retained content', async () => {
    const f = fixture(); const imported = await f.importFile(); const record = f.files.get(imported.file_id)!;
    expect(() => f.files.ingestStored({ storage_ref: record.storage_ref, size_bytes: record.size_bytes,
      filename: 'Forged.pdf', mime_type: 'application/pdf', origin: 'connection_download', source_id: 'forged',
      cloud_capture: { ...record.hot_fields.cloud_capture!, content_hash: '0'.repeat(64) },
    })).toThrow('cloud_capture_content_mismatch');
    expect(() => f.files.ingestStored({ storage_ref: record.storage_ref, size_bytes: record.size_bytes,
      filename: record.hot_fields.filename, mime_type: record.hot_fields.mime_type, origin: 'connection_download', source_id: 'forged-export',
      cloud_capture: { ...record.hot_fields.cloud_capture!, export_as: { filename: 'Different.docx', mime_type: 'text/plain' } },
    })).toThrow('cloud_capture_content_mismatch');
    expect(f.files.list({ platform: 'file', slug: 'received' })).toHaveLength(1);
  });

  it('reopens older imports without capture metadata or reconstructing it from the current mirror', async () => {
    const f = fixture(); const args = await f.request();
    const imported = await f.handlers['data.file.attachments.import'](args, client);
    const record = f.files.get(imported.file_id)!;
    // The pre-upgrade ingest shape and receipt have no cloud_capture.
    f.files.ingestStored({ storage_ref: record.storage_ref, size_bytes: record.size_bytes,
      filename: record.hot_fields.filename, mime_type: record.hot_fields.mime_type,
      origin: 'connection_download', source_id: record.source_id });
    f.add('one', 'A different name.pdf', { revision: 'v9' }); f.connections.delete('api', 'work');
    expect(await f.makeHandlers()['data.file.attachments.import'](args, client)).toEqual(imported);
    expect((await f.handlers['data.file.usage']({ record_id: imported.file_id }, client)).cloud_capture).toBeUndefined();
    const chat = createChatStore(f.db, () => new Uint8Array(32).fill(15));
    chat.createSession({ id: 'legacy', title: 'Older import' });
    await chat.appendMessage({ id: 'old-import', session_id: 'legacy', role: 'user', content: 'Read this older copy',
      target_server: 'self', attachments: [imported], picker_at_send: { display_name: 'Self', signature: {
        server_kind: 'recued', version: '1', instance_id: 'cloud-test' } }, model_used: { provider: 'test', model_id: 'test' } });
    const conversation = await f.handlers['data.file.attachments.conversation']({ session_id: 'legacy' }, client);
    expect(conversation.files[0]).toMatchObject({ filename: 'Report.pdf', availability: 'available' });
    expect(conversation.files[0]!.cloud_capture).toBeUndefined();
    expect((await f.files.readBytes(conversation.files[0]!.file_id)).bytes.toString()).toBe('%PDF-retained-cloud-copy');
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not resurrect a deleted copy when an import acknowledgement is retried', async () => {
    const f = fixture(); const args = await f.request(); const imported = await f.handlers['data.file.attachments.import'](args, client);
    const preview = f.files.attachmentLifecycle!.preview(imported.file_id);
    f.files.mutateLifecycle!({ record_id: imported.file_id, action: 'delete', revision: preview.revision });
    await expect(f.makeHandlers()['data.file.attachments.import'](args, client)).rejects.toMatchObject({ code: 'file_not_found' });
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.files.get(imported.file_id)).toBeNull();
  });

  it.each(['metadata', 'credential', 'disconnection', 'grant'] as const)('rejects a %s change while downloading without publishing a file', async change => {
    const f = fixture(); const args = await f.request();
    f.fetchImpl.mockImplementationOnce(async () => {
      if (change === 'metadata') f.add('one', 'Replacement.pdf', { revision: 'v2' });
      if (change === 'credential') f.connections.upsert({ ...f.connections.get('api', 'work')!, auth_ciphertext: 'replacement-secret' });
      if (change === 'disconnection') f.connections.delete('api', 'work');
      if (change === 'grant') f.revoke();
      return new Response('changed');
    });
    await expect(f.handlers['data.file.attachments.import'](args, client)).rejects.toBeDefined();
    expect(f.files.list({ platform: 'file', slug: 'received' })).toEqual([]);
  });

  it('rejects changed selections before fetching, but permits derived OAuth refresh', async () => {
    const f = fixture(); const stale = await f.request(); f.add('one', 'Changed.pdf', { revision: 'v2' });
    await expect(f.handlers['data.file.attachments.import'](stale, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    f.resolveConnection.mockImplementationOnce(async () => {
      const current = f.connections.get('api', 'work')!;
      expect(f.connections.persistRefreshedAuth!(current, 'derived-refresh', Date.now())).toBe(true);
      return { auth: { type: 'bearer', token: 'fresh' }, config: {} };
    });
    expect((await f.importFile()).filename).toBe('Changed.pdf');
  });

  it('checks a changed connection after async credential resolution and before sending credentials to a provider', async () => {
    const f = fixture(); const args = await f.request();
    f.resolveConnection.mockImplementationOnce(async () => {
      f.connections.delete('api', 'work'); f.enroll();
      return { auth: { type: 'bearer', token: 'stale' }, config: {} };
    });
    await expect(f.handlers['data.file.attachments.import'](args, client)).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('shows unsupported and oversized files and enforces size and capability checks on import', async () => {
    const f = fixture(); f.add('one', 'Google Form', { mime_type: 'application/vnd.google-apps.form' });
    expect((await f.select()).unavailable_reason).toContain('cannot be exported');
    await expect(f.importFile()).rejects.toMatchObject({ code: 'remote_unresolvable' }); expect(f.fetchImpl).not.toHaveBeenCalled();
    f.add('one', 'Huge.pdf', { size: 30 * 1024 * 1024 });
    expect((await f.select()).unavailable_reason).toContain('limit');
    await expect(f.importFile()).rejects.toMatchObject({ code: 'remote_unresolvable' });
    f.add('one'); f.remote.maxBytes = 5;
    await expect(f.importFile()).rejects.toMatchObject({ code: 'remote_too_large' });
    f.revoke(); await expect(f.importFile()).rejects.toMatchObject({ code: 'remote_fetch_not_granted' });
    expect(f.files.totalBytes()).toBe(0);
  });

  it('rolls back file publication and accounting if the completion receipt cannot be saved', async () => {
    const f = fixture(); const args = await f.request();
    f.db.exec("CREATE TRIGGER fail_cloud_receipt BEFORE UPDATE ON file_cloud_imports BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
    await expect(f.handlers['data.file.attachments.import'](args, client)).rejects.toThrow('receipt unavailable');
    expect(f.files.totalBytes()).toBe(0); expect(f.files.gate.info().used).toBe(0);
    expect(f.db.prepare('SELECT selection_revision FROM file_cloud_imports').get()).toEqual({ selection_revision: null });
    f.db.exec('DROP TRIGGER fail_cloud_receipt');
    expect((await f.handlers['data.file.attachments.import'](args, client)).filename).toBe('Report.pdf');
    expect(f.files.list({ platform: 'file', slug: 'received' })).toHaveLength(1);
  });

  it('preserves a completed import when a cleanup uses a snapshot from before the import', async () => {
    const f = fixture(); const staleKeepSet = new Set<string>();
    const imported = await f.importFile();
    expect(await f.blobs.sweepOrphans(staleKeepSet)).toBe(0);
    expect((await f.files.readBytes(imported.file_id)).bytes.toString()).toBe('%PDF-retained-cloud-copy');
  });

  it('holds a CAS lease during storage and rechecks the source after encryption', async () => {
    const f = fixture(); const originalPut = f.blobs.put;
    f.blobs.put = async bytes => {
      const hash = await originalPut(bytes); await f.blobs.sweepOrphans(new Set());
      expect(await f.blobs.has(hash)).toBe(true);
      f.add('one', 'Renamed during encryption.pdf'); return hash;
    };
    await expect(f.importFile()).rejects.toMatchObject({ code: 'file_selection_changed' });
    expect(f.files.totalBytes()).toBe(0);
    expect(f.db.prepare('SELECT * FROM collection_file_attachment_leases').all()).toEqual([]);
    expect((await f.files.sweepOrphanCasBlobs()).deleted_count).toBe(1);
  });

  it('pins actual downloaded bytes and observed source details across remote mutation, queue, Messenger and deletion', async () => {
    const f = fixture(); const args = await f.request(); const started = Date.now();
    // The provider changes before its metadata sync: observed v1 is not proof of
    // the downloaded version. Capture the actual v2 bytes without inventing a version.
    f.fetchImpl.mockImplementation(async () => new Response('%PDF-version-two'));
    const imported = await f.handlers['data.file.attachments.import'](args, client);
    const capture = f.files.get(imported.file_id)!.hot_fields.cloud_capture!;
    expect(capture).toEqual({ remote_record_id: args.record_id, source_id: scope, provider: 'google',
      source_label: 'Google Drive · work', remote_id: 'one', filename: 'Report.pdf', path: '/Clients/Report.pdf',
      observed_revision: 'v1', captured_at: expect.any(Number),
      content_hash: createHash('sha256').update('%PDF-version-two').digest('hex') });
    expect(capture.captured_at).toBeGreaterThanOrEqual(started);
    expect(capture.captured_at).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(capture)).not.toMatch(/download-secret|encrypted-secret|https:/);
    expect(f.db.prepare('SELECT imported_at FROM file_cloud_imports WHERE import_id=?').get(args.import_id))
      .toEqual({ imported_at: capture.captured_at });
    f.fetchImpl.mockImplementation(async () => new Response('%PDF-version-three'));
    f.add('one', 'Renamed.pdf', { revision: 'v3', path: '/Moved/Renamed.pdf' });
    const latest = await f.handlers['data.file.read']({ record_id: args.record_id }, client);
    expect(Buffer.from(latest.bytes_b64, 'base64').toString()).toBe('%PDF-version-three');
    const key = () => new Uint8Array(32).fill(15);
    const chat = createChatStore(f.db, key); chat.createSession({ id: 's', title: 'Cloud conversation' });
    const queue = createChatTurnQueueStore(f.db, key);
    const ack = await queue.admit({ family: 'chat', session_id: 's', message: 'Read the copy', input: {
      session_id: 's', message: 'Read the copy', picker_state: { current: 'self' }, attachments: [imported],
    } }, 'cloud-command');
    const command = await queue.read(queue.get(ack.turn_id)!); const attachment = (command.input.attachments as ChatMessageAttachment[])[0]!;
    expect(attachment.file_id).not.toBe(imported.file_id);
    f.meta.deleteForSource(scope, 'one'); f.connections.delete('api', 'work'); f.revoke();
    // Reconstructed handlers and deleted remote metadata must still report the capture.
    expect(await f.makeHandlers()['data.file.attachments.import'](args, client)).toEqual(imported);
    expect((await f.makeHandlers()['data.file.usage']({ record_id: imported.file_id }, client)).cloud_capture).toEqual(capture);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const message = await chat.appendMessage({ id: 'cloud-message', session_id: 's', role: 'user', content: 'Read the copy',
      target_server: 'self', attachments: [attachment], picker_at_send: { display_name: 'Self', signature: {
        server_kind: 'recued', version: '1', instance_id: 'cloud-test' } }, model_used: { provider: 'test', model_id: 'test' } });
    const conversation = await f.handlers['data.file.attachments.conversation']({ session_id: 's' }, client);
    expect(conversation.files[0]).toMatchObject({ filename: 'Report.pdf', last_message_id: message.id,
      source_file_id: imported.file_id, cloud_capture: capture });
    expect(f.files.get(attachment.file_id)!.hot_fields.cloud_capture).toEqual(capture);
    const source = createMessengerAttachmentSource(f.files, f.dir);
    const materialized = await source.open(source.snapshot(attachment.file_id));
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(materialized.path)).toString()).toBe('%PDF-version-two');
    await materialized.dispose();
    const before = f.files.attachmentLifecycle!.preview(imported.file_id); expect(before.queued_count).toBe(1); expect(before.message_count).toBe(1);
    f.files.mutateLifecycle!({ record_id: imported.file_id, action: 'delete', revision: before.revision });
    expect(queue.get(ack.turn_id)!.status).toBe('failed');
    expect((await f.handlers['data.file.attachments.conversation']({ session_id: 's' }, client)).files[0])
      .toMatchObject({ availability: 'deleted', cloud_capture: capture });
    expect((await f.handlers['data.file.usage']({ record_id: attachment.file_id }, client)).cloud_capture).toEqual(capture);
  });
});
