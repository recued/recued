import { createConnectionStore } from '../../../../backend/server/src/storage/connection-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createFileMetaStore, ensureFileMetaSchema, buildFileMetaSnapshot } from '../../../../backend/server/src/storage/file-meta-store.js';
import { buildRemoteFileByteResolvers } from '../../../../backend/server/src/collections/file/remote-byte-resolvers/index.js';
import { wireFileSourceBoot } from '../../../../backend/server/src/file-source-boot.js';
import type { ChatBroadcastEmitter } from '../../../../backend/server/src/chat-orchestrator.js';
import { createCollectionRegistry } from '../../../../backend/server/src/collections/registry.js';
import { makeFileReadRpcHandlers } from '../../../../backend/server/src/file-read-rpc-handler.js';
import type { WsClient } from '../../../../backend/server/src/ws-server.js';
import { createQueueFixture } from './chat-queue-backend.js';

export const createFileLifecycleFixture = async (broadcast: ChatBroadcastEmitter, messenger = false, cloud = false) => {
  const f = createQueueFixture(broadcast, messenger, true);
  await f.addBlockedAttachment(); f.allowAttachment();
  const registry = createCollectionRegistry(); registry.register(f.files!);
  const cloudSource = cloud ? (() => {
    ensureWorkEntitySchema(f.db); ensureFileMetaSchema(f.db);
    const connections = createConnectionStore(f.db); const sources = createWorkEntityStore(f.db); const meta = createFileMetaStore(f.db);
    connections.upsert({ kind: 'api', name: 'work', display_name: 'Work drive', config_json: '{"vendor":"google"}',
      auth_ciphertext: 'encrypted-test', enrolled_at: 1, updated_at: 1 });
    wireFileSourceBoot({ connectionStore: connections, store: sources });
    let downloads = 0; let beforeFetch: (() => Promise<void>) | undefined;
    let response: { bytes: string | Buffer; mime: string } | undefined;
    const add = (id: string, filename: string, extra = {}) => meta.upsert({ scope: 'google.work.file', target_id: id,
      meta: buildFileMetaSnapshot({ provider: 'google', remote_id: id, filename, path: `/Clients/${filename}`,
        revision: 'v1', mime_type: 'application/pdf', ...extra }, Date.now()), now: Date.now() });
    add('one', 'Cloud report.pdf');
    const remote = { fileMetaStore: meta, resolveConnection: async () => ({ auth: { type: 'bearer' as const, token: 'mock' }, config: {} }),
      byteResolvers: buildRemoteFileByteResolvers({ fetchImpl: async url => {
        downloads++; await beforeFetch?.();
        const exportMime = new URL(url).searchParams.get('mimeType');
        return new Response(response ? new Uint8Array(Buffer.from(response.bytes)) : exportMime ? 'native-document-export' : '%PDF-cloud-attachment',
          { headers: { 'Content-Type': response?.mime ?? exportMime ?? 'application/pdf' } });
      } }) };
    return { deps: { db: f.db, connections, sources }, remote, add, connections,
      downloads: () => downloads, beforeFetch: (fn: () => Promise<void>) => { beforeFetch = fn; },
      respond: (bytes: string | Buffer, mime: string) => { response = { bytes, mime }; } };
  })() : undefined;
  const handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => ({ registry, blobs: f.blobs!, ...(cloudSource ? { remote: cloudSource.remote } : {}) }),
    ...(cloudSource ? { cloudAttachments: cloudSource.deps } : {}),
    changed: (session_id, file_id, deleted) => {
      broadcast.emit({ kind: 'chat.session_changed', session_id, field: 'attachments', value: { file_id, deleted } });
      broadcast.emit({ kind: 'chat.session_changed', session_id, field: 'queue', value: true });
    },
  })!.handlers;
  const client = { instance_id: 'paired-test' } as WsClient;
  const fileId = f.files!.list({ platform: 'file', slug: 'received', limit: 10 })[0]!.record_id;
  return { ...f, fileId, cloudSource,
    async rpc(method: string, args: Record<string, unknown>): Promise<unknown> {
      if (method === 'data.file.attachments.preview') return handlers[method]({ record_id: String(args.record_id),
        ...(typeof args.selection_revision === 'string' ? { selection_revision: args.selection_revision } : {}) }, client);
      if (method === 'data.file.attachments.sources') return handlers[method](undefined, client);
      if (method === 'data.file.attachments.remote.list') return handlers[method]({ ...args, source_id: String(args.source_id) }, client);
      if (method === 'data.file.attachments.remote.get') return handlers[method]({ record_id: String(args.record_id) }, client);
      if (method === 'data.file.attachments.import') return handlers[method]({ record_id: String(args.record_id),
        selection_revision: String(args.selection_revision), import_id: String(args.import_id) }, client);
      if (method === 'data.file.attachments.list') return handlers[method](args, client);
      if (method === 'data.file.attachments.conversation') return handlers[method]({ ...args, session_id: String(args.session_id) }, client);
      if (method === 'data.file.attachments.get') return handlers[method]({ record_id: String(args.record_id) }, client);
      if (method === 'data.file.read') return handlers[method](args as Parameters<typeof handlers[typeof method]>[0], client);
      if (method === 'data.file.usage') return handlers[method](args as Parameters<typeof handlers[typeof method]>[0], client);
      if (method === 'data.file.mutate') return handlers[method]({ record_id: String(args.record_id), revision: String(args.revision),
        action: args.action as 'archive' | 'delete' }, client);
      if (method === 'collection.listInstances') return { instances: [{ platform: 'file', slug: 'received', adapter_type: 'received',
        auth_state: 'healthy', last_synced_at: Date.now(), caps: { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'full', auth: 'none', path_style: 'posix' } }] };
      if (method === 'collection.list') return { records: f.files!.list({ platform: 'file', slug: 'received', limit: 100,
        ...(args.filters ? { filters: args.filters as Record<string, unknown> } : {}) }) };
      if (method === 'collection.get') return { record: f.files!.get(String(args.record_id)) };
      return f.rpc(method, args);
    },
  };
};
