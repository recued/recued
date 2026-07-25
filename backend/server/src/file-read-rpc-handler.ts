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

export interface FileReadRpcDeps {
  /** Lazy resolver for the shared file-read deps (collection registry + blob
   *  store + auditLog). Undefined when the inbound file collection isn't wired
   *  (dbless boot / no blob store) — the handler then returns `not_configured`. */
  getFileReadDeps: () => FileReadDeps | undefined;
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

type FileReadRpcMethods = 'data.file.read';

export const makeFileReadRpcHandlers = (
  deps: FileReadRpcDeps | undefined,
):
  | HandlerSlice<ServerRpcRegistry, FileReadRpcMethods, WsClient>
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['data.file.read'],
    handlers: {
      'data.file.read': async (args, client) => {
        requireRegisteredClient(client);
        return handleDataFileRead(deps, args as { record_id: string });
      },
    },
  };
};
