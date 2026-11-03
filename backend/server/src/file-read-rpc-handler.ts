/** D-172 Half-A "open" — `data.file.read` pair-RPC handler.
 *
 *  The webclient Files tab opens / downloads a `data.file` record's bytes. File
 *  CONTENT read is Gateway-gated ONLY for CONTRACTED channels — an AI could
 *  exfiltrate bytes via an `ai-*` `llm.data` file-ref, so THAT path composes the
 *  `(channel × actor × contract_id)` admission in front of the byte read
 *  (D-172 I-4 / A.8; `server-executor.ts` `fileRead`). The OWNER reading their
 *  OWN file over the bearer-gated paired WS is not egress, so this is an
 *  owner-trusted read: a registered-paired-client boundary, no contract / egress
 *  gate — the exact model `data.timeline` uses. Wraps the backend
 *  `handleFileRead` verbatim; the read stays audited (D-120) via its `auditLog`.
 *
 *  This is the FOURTH isolated channel over `handleFileRead`, alongside the
 *  recipe `data-file-read` ingredient, the ai-* multimodal overload, and the
 *  chat orchestrator — same read, separate dispatcher, no shared rpc envelope. */

import type Database from 'better-sqlite3';
import { RpcError, isFileCloudCapture, type HandlerSlice, type ServerRpcRegistry, type FileContentReadRequest, type FileContentReadResponse } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import { handleFileRead, type FileReadDeps } from './collections/file/file-read-handler.js';
import { createCloudFileAttachments, type CloudFileAttachmentDeps } from './cloud-file-attachments.js';
import type { InboundFileCollection } from './collections/file/inbound-file-collection.js';
import { parseWatchedFileRecordId } from './collections/file/watched-folder-collection.js';
import { createFolderFileAttachments, watchedFileSelection } from './folder-file-attachments.js';
import { previewFile, type PreviewSelection } from './file-preview.js';
import { createFilePreviewConversions, type FilePreviewConversionDeps } from './file-preview-conversion.js';

export interface FileReadRpcDeps {
  /** Lazy resolver for the shared file-read deps (collection registry + blob
   *  store + auditLog). Undefined when the inbound file collection isn't wired
   *  (dbless boot / no blob store) — the handler then returns `not_configured`. */
  getFileReadDeps: () => FileReadDeps | undefined;
  cloudAttachments?: CloudFileAttachmentDeps;
  /** D-106 follow-up — where a watched folder's file is brought into Chat as a
   *  copy; its import receipts live in this database. */
  folderAttachments?: { db: Database.Database };
  conversions?: FilePreviewConversionDeps;
  changed?: (session: string, file: string, deleted: boolean) => void;
  deleted?: (file: string) => void;
}

/** Require a registered paired client. The owner-trusted read runs WITHOUT the
 *  contract / egress gate, so that trust MUST be anchored to an actual
 *  registered-local-UI boundary — an unregistered / pre-register WS caller is
 *  rejected before any bytes are read. Mirrors `timeline-rpc-handler.ts`. */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'data.file.read requires a registered paired client',
      401,
    );
  }
};

export const handleDataFileRead = async (
  deps: FileReadRpcDeps,
  args: FileContentReadRequest,
): Promise<FileContentReadResponse> => {
  if (typeof args.record_id !== 'string' || args.record_id.length === 0) {
    throw new RpcError('bad_request', 'data.file.read: record_id is required');
  }
  const fileReadDeps = deps.getFileReadDeps();
  if (fileReadDeps === undefined) {
    throw new RpcError(
      'not_configured',
      'data.file.read: the inbound file collection is not wired',
      503,
    );
  }
  return handleFileRead(fileReadDeps, args);
};

type FileReadRpcMethods = 'data.file.attachments.preview' | 'data.file.attachments.convert' | 'data.file.attachments.sources' | 'data.file.attachments.remote.list' | 'data.file.attachments.remote.get' | 'data.file.attachments.import' | 'data.file.read' | 'data.file.usage' | 'data.file.rename' | 'data.file.mutate' | 'data.file.attachments.list' | 'data.file.attachments.get' | 'data.file.attachments.conversation';

export const makeFileReadRpcHandlers = (
  deps: FileReadRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, FileReadRpcMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  let cloud: ReturnType<typeof createCloudFileAttachments> | undefined;
  const cloudFiles = () => {
    if (!deps.cloudAttachments) throw new RpcError('not_configured', 'Connected file sources are unavailable.', 503);
    return cloud ??= createCloudFileAttachments(deps.cloudAttachments, deps.getFileReadDeps);
  };
  let folder: ReturnType<typeof createFolderFileAttachments> | undefined;
  const folderFiles = () => {
    if (!deps.folderAttachments) throw new RpcError('not_configured', 'Watched folders cannot be brought into Chat here.', 503);
    return folder ??= createFolderFileAttachments(deps.folderAttachments.db, deps.getFileReadDeps);
  };
  /** A file in a folder Recued watches is brought into Chat the way a connected
   *  source's file is, over the same two calls, by its own importer. */
  const watchedId = (args: unknown): boolean => {
    const id = (args as { record_id?: unknown } | null | undefined)?.record_id;
    return typeof id === 'string' && parseWatchedFileRecordId(id) !== null;
  };
  const retainedFiles = (): InboundFileCollection => {
    const files = deps.getFileReadDeps()?.registry.get('file', 'received') as InboundFileCollection | undefined;
    if (!files?.attachmentLifecycle || !files.mutateLifecycle) throw new RpcError('not_configured', 'Retained file lifecycle is unavailable.', 503);
    return files;
  };
  const requireFileId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^file:[0-9a-f]{32}$/.test(id)) throw new RpcError('bad_request', 'Choose a retained file.', 400);
    return id;
  };
  const select = (id: string): PreviewSelection => {
    if (id.startsWith('file:remote:')) {
      const selected = cloudFiles().get({ record_id: id });
      const source = cloudFiles().sources().sources.find(source => source.source_id === selected.source_id);
      return { ...selected, modified_at: selected.mtime,
        ...(source ? { origin: { label: source.label, ...(selected.path ? { path: selected.path } : {}) } } : {}) };
    }
    if (parseWatchedFileRecordId(id) !== null) {
      const selected = watchedFileSelection(deps.getFileReadDeps()!.registry, id);
      return { ...selected, modified_at: selected.mtime, origin: { label: 'Watched folder', path: selected.path } };
    }
    const files = retainedFiles();
    const selected = files.attachmentLifecycle!.selection(requireFileId(id));
    const record = files.attachmentLifecycle!.getVersion(id) ?? files.get(id);
    const capture = record?.hot_fields.cloud_capture;
    const origin = record?.hot_fields.origin;
    const labels: Record<string, string> = { webclient_upload: 'Uploaded to Recued', watched_folder: 'Copied from a watched folder',
      mail_attachment: 'Email attachment', connection_download: 'Downloaded from a connection', tool_output: 'Tool output',
      messenger_media: 'Messenger attachment', reception_drop: 'Received through Reception' };
    return { ...selected, ...(record ? { created_at: record.received_at, modified_at: record.modified_at,
      content_hash: record.hot_fields.content_hash } : {}),
      ...(isFileCloudCapture(capture) ? { origin: { label: capture.source_label, source_filename: capture.filename,
        ...(capture.path ? { path: capture.path } : {}), captured_at: capture.captured_at, saved_copy: true } }
        : typeof origin === 'string' && Object.hasOwn(labels, origin) ? { origin: { label: labels[origin]! } } : {}) };
  };
  const conversions = deps.conversions ? createFilePreviewConversions(deps.conversions, select) : undefined;
  return {
    methods: ['data.file.attachments.preview', 'data.file.attachments.convert', 'data.file.attachments.sources', 'data.file.attachments.remote.list', 'data.file.attachments.remote.get', 'data.file.attachments.import', 'data.file.read', 'data.file.usage', 'data.file.rename', 'data.file.mutate', 'data.file.attachments.list', 'data.file.attachments.get', 'data.file.attachments.conversation'],
    handlers: {
      'data.file.attachments.preview': async (args, client) => {
        requireRegisteredClient(client);
        const read = deps.getFileReadDeps();
        if (!read) throw new RpcError('not_configured', 'File previews are unavailable.', 503);
        const result = await previewFile(read, args, select);
        const conversion = conversions?.availability(select(args.record_id));
        return { ...result, ...(conversion ? { conversion } : {}) };
      },
      'data.file.attachments.convert': async (args, client) => {
        requireRegisteredClient(client);
        if (!conversions) throw new RpcError('not_configured', 'Preview conversion is unavailable on this server.', 503);
        return conversions.call(args, client);
      },
      'data.file.attachments.sources': async (_args, client) => {
        requireRegisteredClient(client); return cloudFiles().sources();
      },
      'data.file.attachments.remote.list': async (args, client) => {
        requireRegisteredClient(client); return cloudFiles().list(args);
      },
      'data.file.attachments.remote.get': async (args, client) => {
        requireRegisteredClient(client);
        return watchedId(args) ? folderFiles().get(args) : cloudFiles().get(args);
      },
      'data.file.attachments.import': async (args, client) => {
        requireRegisteredClient(client);
        return watchedId(args) ? folderFiles().importFile(args) : cloudFiles().importFile(args);
      },
      'data.file.attachments.conversation': async (args, client) => {
        requireRegisteredClient(client);
        return retainedFiles().attachmentLifecycle!.conversationFiles(args);
      },
      'data.file.attachments.list': async (args, client) => {
        requireRegisteredClient(client);
        return retainedFiles().attachmentLifecycle!.listSelections(args ?? {});
      },
      'data.file.attachments.get': async (args, client) => {
        requireRegisteredClient(client);
        return retainedFiles().attachmentLifecycle!.selection(requireFileId(args.record_id));
      },
      'data.file.usage': async (args, client) => {
        requireRegisteredClient(client);
        return retainedFiles().attachmentLifecycle!.preview(requireFileId(args.record_id));
      },
      'data.file.rename': async (args, client) => {
        requireRegisteredClient(client);
        requireFileId(args?.record_id);
        if (typeof args.filename !== 'string' || !args.revision || typeof args.revision !== 'string') {
          throw new RpcError('bad_request', 'Enter a filename and review the current saved file.', 400);
        }
        const files = retainedFiles();
        if (!files.renameLifecycle) throw new RpcError('not_configured', 'Saved file rename is unavailable.', 503);
        const { replayed, ...result } = files.renameLifecycle(args);
        // A retry acknowledges the current state, not an obsolete cached name.
        if (replayed) return files.attachmentLifecycle!.preview(args.record_id);
        await deps.getFileReadDeps()?.auditLog?.logActivity({ activity_id: '', timestamp: Date.now(),
          action: 'collection_record_updated', target: result.record_id,
          detail: JSON.stringify({ operation: 'rename' }) })
          .catch(() => { console.error('File rename audit write failed after commit.'); });
        return result;
      },
      'data.file.mutate': async (args, client) => {
        requireRegisteredClient(client);
        requireFileId(args.record_id);
        if (!args.revision || typeof args.revision !== 'string' || !['archive', 'restore', 'delete'].includes(args.action)) {
          throw new RpcError('bad_request', 'Review the file usage and choose an action.', 400);
        }
        const { replayed, ...result } = retainedFiles().mutateLifecycle!(args);
        if (replayed) return result;
        if (args.action === 'delete') {
          try { deps.deleted?.(result.record_id); } catch { console.error('File deletion cascade failed after commit.'); }
        }
        for (const session of retainedFiles().attachmentLifecycle!.sessions(result.record_id)) {
          try { deps.changed?.(session, result.record_id, args.action === 'delete'); }
          catch { console.error('File lifecycle notification failed after commit.'); }
        }
        await deps.getFileReadDeps()?.auditLog?.logActivity({ activity_id: '', timestamp: Date.now(),
          action: args.action === 'delete' ? 'collection_record_deleted' : 'collection_record_updated', target: result.record_id,
          detail: JSON.stringify({ operation: args.action, message_count: result.message_count, queued_count: result.queued_count }) })
          .catch(() => { console.error('File lifecycle audit write failed after commit.'); });
        return result;
      },
      'data.file.read': async (args, client) => {
        requireRegisteredClient(client);
        return handleDataFileRead(deps, args);
      },
    },
  };
};
