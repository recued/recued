// D-172 resumable uploads — the `upload.*` webclient control-plane rpc handlers.
//
// Four owner-only methods over the `WebclientUploadService`:
//   - `upload.create`   — open a scratch session, return the 256-bit upload_id.
//   - `upload.probe`    — resume probe (persisted offset, file-identity gated).
//   - `upload.finalize` — assemble -> CAS -> `data.file.received` ingest.
//   - `upload.delete`   — explicit cancel (best-effort reap).
//
// The chunk BYTES do NOT come through here — they ride the dedicated binary
// `/ws/upload` socket (`service.handleChunkFrame`). This slice is only the
// typed control plane.
//
// Auth: every method requires an authenticated paired caller whose verified
// `token_instance_id` IS the scope key (resolved from the bearer at WS upgrade,
// never client-supplied). The service scope-isolates each session by that key,
// so one paired client can never drive another's upload. `upload.` is reserved
// out of MCP (channel-isolation), so an MCP-channel agent never reaches here.

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { WebclientUploadService } from './upload/webclient-upload-service.js';

export interface UploadHandlerDeps {
  /** The per-pair webclient upload service (core + finalize policy). */
  service: WebclientUploadService;
}

type UploadMethods =
  | 'upload.create'
  | 'upload.probe'
  | 'upload.finalize'
  | 'upload.delete';

/** The scope key is the caller's verified paired-instance identity. A client
 *  with no `token_instance_id` (legacy raw-bearer / unverified) has no scope to
 *  isolate by — reject rather than fall back to a shared bucket. */
const requireScopeKey = (ctx: WsClient): string => {
  const scope = ctx.token_instance_id;
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new RpcError('unauthorized', 'a paired client identity is required to upload', 401);
  }
  return scope;
};

export const makeUploadHandlers = (
  deps: UploadHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, UploadMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const { service } = deps;
  return {
    methods: ['upload.create', 'upload.probe', 'upload.finalize', 'upload.delete'],
    handlers: {
      'upload.create': async (args, ctx) =>
        service.create({
          scope_key: requireScopeKey(ctx),
          filename: args.filename,
          declared_size: args.declared_size,
          mime_reported: args.mime_reported,
          ...(args.fingerprint !== undefined ? { fingerprint: args.fingerprint } : {}),
        }),
      'upload.probe': async (args, ctx) =>
        service.probe({
          scope_key: requireScopeKey(ctx),
          upload_id: args.upload_id,
          filename: args.filename,
          declared_size: args.declared_size,
          ...(args.fingerprint !== undefined ? { fingerprint: args.fingerprint } : {}),
        }),
      'upload.finalize': async (args, ctx) =>
        service.finalize({
          scope_key: requireScopeKey(ctx),
          upload_id: args.upload_id,
        }),
      'upload.delete': async (args, ctx) =>
        service.delete({
          scope_key: requireScopeKey(ctx),
          upload_id: args.upload_id,
        }),
    },
  };
};
