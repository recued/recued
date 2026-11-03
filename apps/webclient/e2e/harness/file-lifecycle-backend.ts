import { createHash } from 'node:crypto';
import { FILE_PREVIEW_MAX_BYTES, type FilePreviewConverter, type RunAnchorStatus, type RecipeDefinition, type FileLifecycleMutation } from '@recued/contracts';
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
import { handleFileRead } from '../../../../backend/server/src/collections/file/file-read-handler.js';
import { assertPreviewConversionInput, recordPreviewConversionRead } from '../../../../backend/server/src/file-preview-conversion-guard.js';
import { takeResumedRunFinisher } from '../../../../backend/server/src/resumed-run-finishers.js';
import { stampExecuteResponseAuditRun, type ExecuteRequest, type ExecuteResponse } from '../../../../backend/server/src/types.js';

export const createFileLifecycleFixture = async (broadcast: ChatBroadcastEmitter, messenger = false, cloud = false, options: Parameters<typeof createQueueFixture>[3] = {}) => {
  const f = createQueueFixture(broadcast, messenger, true, options);
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
  const readDeps = () => ({ registry, blobs: f.blobs!, ...(cloudSource ? { remote: cloudSource.remote } : {}) });
  let pendingConversion: { request: Pick<ExecuteRequest, 'recipe' | 'config'>; run: string } | undefined;
  const conversionControl = {
    readers: [] as FilePreviewConverter[], mode: 'ready' as 'ready' | 'hold' | 'failure', text: '# Converted workbook\nStored values',
    runs: 0, input: undefined as Buffer | undefined, state: 'awaiting_approval' as RunAnchorStatus,
    async approve() {
      if (!pendingConversion) throw new Error('No conversion is waiting.');
      const { request, run } = pendingConversion; pendingConversion = undefined;
      let response: ExecuteResponse;
      try { response = await completeConversion(request, run); conversionControl.state = 'succeeded'; }
      catch { response = conversionResult(run, false); conversionControl.state = 'failed'; }
      const finisher = takeResumedRunFinisher(run);
      if (!finisher) throw new Error('The conversion finisher was lost.');
      await finisher.finish(response);
    },
    refuse() { conversionControl.state = 'cancelled'; },
  };
  const conversionResult = (run: string, success = true, held = false): ExecuteResponse => stampExecuteResponseAuditRun({
    recipe_id: 'fixture-preview', recipe_hash: 'fixture', success, ...(held ? { awaiting_approval: true } : {}),
    output: { render: success ? [{ type: 'summary', data: { bytes_b64: Buffer.from(conversionControl.text).toString('base64'),
      size_bytes: Buffer.byteLength(conversionControl.text) } }] : [], sidebar: [] },
    steps: [], errors: success || held ? [] : [{ message: 'private-adapter-diagnostic' }], duration_ms: 1,
  }, run);
  const completeConversion = async (request: Pick<ExecuteRequest, 'recipe' | 'config'>, run: string): Promise<ExecuteResponse> => {
    const raw = request.config?.source;
    const id = typeof raw === 'string' ? raw : raw !== null && typeof raw === 'object' && 'record_id' in raw ? String(raw.record_id) : '';
    const recipe = request.recipe as RecipeDefinition;
    const maxBytes = assertPreviewConversionInput(recipe.recipe_id, id) ?? FILE_PREVIEW_MAX_BYTES;
    const source = await handleFileRead(readDeps(), { record_id: id }, undefined, { maxBytes });
    assertPreviewConversionInput(recipe.recipe_id, id);
    conversionControl.input = Buffer.from(source.bytes_b64, 'base64');
    recordPreviewConversionRead(recipe.recipe_id, id, createHash('sha256').update(conversionControl.input).digest('hex'));
    return conversionResult(run);
  };
  const handlers = makeFileReadRpcHandlers({ getFileReadDeps: readDeps,
    conversions: { readers: () => conversionControl.readers.map(converter => ({ converter, fingerprint: 'fixture-reader-v1' })),
      runStatus: async () => conversionControl.state,
      execute: async request => {
        const run = 'preview-fixture-' + (++conversionControl.runs);
        if (conversionControl.mode === 'failure') return conversionResult(run, false);
        if (conversionControl.mode === 'hold') { conversionControl.state = 'awaiting_approval'; pendingConversion = { request, run }; return conversionResult(run, false, true); }
        return completeConversion(request, run);
      },
    },
    ...(cloudSource ? { cloudAttachments: cloudSource.deps } : {}),
    changed: (session_id, file_id, deleted) => {
      broadcast.emit({ kind: 'chat.session_changed', session_id, field: 'attachments', value: { file_id, deleted } });
      broadcast.emit({ kind: 'chat.session_changed', session_id, field: 'queue', value: true });
    },
  })!.handlers;
  /** ⛔ NOT `{ instance_id } as WsClient`. `requireRegisteredClient` reads only
   *  `instance_id`, but the cast silenced FOUR missing required fields at the same
   *  time, so the compiler stopped checking this object at all — `check:object-casts`
   *  flags exactly that (TS1360). Declared in full instead: the fixture is
   *  in-process, so there is no socket to hold and the realm is nominal.
   *
   *  ⚠ `instance_id` is non-null ON PURPOSE, and this is NOT the live clients-map
   *  value. `ws-server.ts` keeps a webclient's map entry null — it is the registered-
   *  EXTENSION marker, and populating it there would mis-route bridge-only frames —
   *  and resolves `token_instance_id` into a shallow copy at rpc dispatch. So this is
   *  the shape a handler actually receives for a PAIRED webclient. */
  const client: WsClient = {
    ws: null,
    realm: 'e2e',
    instance_id: 'paired-test',
    display_name: 'file-lifecycle-e2e',
    connected_at: 0,
  };
  const fileId = f.files!.list({ platform: 'file', slug: 'received', limit: 10 })[0]!.record_id;
  return { ...f, fileId, cloudSource, previewConversion: conversionControl,
    close() {
      if (pendingConversion) {
        const finisher = takeResumedRunFinisher(pendingConversion.run);
        if (finisher) void finisher.finish(conversionResult(pendingConversion.run, false)).catch(() => {});
        pendingConversion = undefined;
      }
      f.close();
    },
    async rpc(method: string, args: Record<string, unknown>): Promise<unknown> {
      if (method === 'data.file.attachments.preview') return handlers[method]({ record_id: String(args.record_id),
        ...(typeof args.metadata_only === 'boolean' ? { metadata_only: args.metadata_only } : {}),
        ...(typeof args.selection_revision === 'string' ? { selection_revision: args.selection_revision } : {}) }, client);
      if (method === 'data.file.attachments.convert') return handlers[method](args as Parameters<typeof handlers[typeof method]>[0], client);
      if (method === 'data.file.attachments.sources') return handlers[method](undefined, client);
      if (method === 'data.file.attachments.remote.list') return handlers[method]({ ...args, source_id: String(args.source_id) }, client);
      if (method === 'data.file.attachments.remote.get') return handlers[method]({ record_id: String(args.record_id) }, client);
      if (method === 'data.file.attachments.import') return handlers[method]({ record_id: String(args.record_id),
        selection_revision: String(args.selection_revision), import_id: String(args.import_id) }, client);
      if (method === 'data.file.attachments.list') return handlers[method](args, client);
      if (method === 'data.file.attachments.conversation') return handlers[method]({ ...args, session_id: String(args.session_id) }, client);
      if (method === 'data.file.attachments.get') return handlers[method]({ record_id: String(args.record_id) }, client);
      if (method === 'data.file.read') return handlers[method]({ ...args, record_id: String(args.record_id) }, client);
      if (method === 'data.file.usage') return handlers[method](args as Parameters<typeof handlers[typeof method]>[0], client);
      if (method === 'data.file.rename') return handlers[method]({ record_id: String(args.record_id), revision: String(args.revision), filename: String(args.filename) }, client);
      if (method === 'data.file.mutate') return handlers[method]({ record_id: String(args.record_id), revision: String(args.revision),
        action: args.action as FileLifecycleMutation['action'] }, client);
      if (method === 'collection.listInstances') return { instances: [{ platform: 'file', slug: 'received', adapter_type: 'received',
        auth_state: 'healthy', last_synced_at: Date.now(), caps: { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'full', auth: 'none', path_style: 'posix' } }] };
      if (method === 'collection.list') return { records: f.files!.list({ platform: 'file', slug: 'received', limit: 100,
        ...(args.filters ? { filters: args.filters as Record<string, unknown> } : {}) }) };
      if (method === 'collection.get') return { record: f.files!.get(String(args.record_id)) };
      return f.rpc(method, args);
    },
  };
};
