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

import { RpcError, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import { handleFileRead, type FileReadDeps } from './collections/file/file-read-handler.js';
import { createCloudFileAttachments, type CloudFileAttachmentDeps } from './cloud-file-attachments.js';
import type { InboundFileCollection } from './collections/file/inbound-file-collection.js';
import { previewFile } from './file-preview.js';

export interface FileReadRpcDeps {
  /** Lazy resolver for the shared file-read deps (collection registry + blob
   *  store + auditLog). Undefined when the inbound file collection isn't wired
   *  (dbless boot / no blob store) — the handler then returns `not_configured`. */
  getFileReadDeps: () => FileReadDeps | undefined;
  cloudAttachments?: CloudFileAttachmentDeps;
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
  args: { record_id: string },
): Promise<{
  record_id: string;
  bytes_b64: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
  blob_hash: string;
}> => {
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
  const file = await handleFileRead(fileReadDeps, { record_id: args.record_id });
  return {
    record_id: file.record_id,
    bytes_b64: file.bytes_b64,
    mime_type: file.mime_type,
    filename: file.filename,
    size_bytes: file.size_bytes,
    blob_hash: file.blob_hash,
  };
};

type FileReadRpcMethods = 'data.file.attachments.preview' | 'data.file.attachments.sources' | 'data.file.attachments.remote.list' | 'data.file.attachments.remote.get' | 'data.file.attachments.import' | 'data.file.read' | 'data.file.usage' | 'data.file.mutate' | 'data.file.attachments.list' | 'data.file.attachments.get' | 'data.file.attachments.conversation';

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
  const retainedFiles = (): InboundFileCollection => {
    const files = deps.getFileReadDeps()?.registry.get('file', 'received') as InboundFileCollection | undefined;
    if (!files?.attachmentLifecycle || !files.mutateLifecycle) throw new RpcError('not_configured', 'Retained file lifecycle is unavailable.', 503);
    return files;
  };
  const requireFileId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^file:[0-9a-f]{32}$/.test(id)) throw new RpcError('bad_request', 'Choose a retained file.', 400);
    return id;
  };
  return {
    methods: ['data.file.attachments.preview', 'data.file.attachments.sources', 'data.file.attachments.remote.list', 'data.file.attachments.remote.get', 'data.file.attachments.import', 'data.file.read', 'data.file.usage', 'data.file.mutate', 'data.file.attachments.list', 'data.file.attachments.get', 'data.file.attachments.conversation'],
    handlers: {
      'data.file.attachments.preview': async (args, client) => {
        requireRegisteredClient(client);
        const read = deps.getFileReadDeps();
        if (!read) throw new RpcError('not_configured', 'File previews are unavailable.', 503);
        return previewFile(read, args, id => id.startsWith('file:remote:')
          ? cloudFiles().get({ record_id: id })
          : retainedFiles().attachmentLifecycle!.selection(requireFileId(id)));
      },
      'data.file.attachments.sources': async (_args, client) => {
        requireRegisteredClient(client); return cloudFiles().sources();
      },
      'data.file.attachments.remote.list': async (args, client) => {
        requireRegisteredClient(client); return cloudFiles().list(args);
      },
      'data.file.attachments.remote.get': async (args, client) => {
        requireRegisteredClient(client); return cloudFiles().get(args);
      },
      'data.file.attachments.import': async (args, client) => {
        requireRegisteredClient(client); return cloudFiles().importFile(args);
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
      'data.file.mutate': async (args, client) => {
        requireRegisteredClient(client);
        requireFileId(args.record_id);
        if (!args.revision || typeof args.revision !== 'string' || !['archive', 'delete'].includes(args.action)) {
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
          action: args.action === 'archive' ? 'collection_record_updated' : 'collection_record_deleted', target: result.record_id,
          detail: JSON.stringify({ operation: args.action, message_count: result.message_count, queued_count: result.queued_count }) })
          .catch(() => { console.error('File lifecycle audit write failed after commit.'); });
        return result;
      },
      'data.file.read': async (args, client) => {
        requireRegisteredClient(client);
        return handleDataFileRead(deps, args as { record_id: string });
      },
    },
  };
};
