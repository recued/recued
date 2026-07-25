// M4b.1 — the `server.archive.upload.*` control-plane rpc handlers.
//
// Four owner-only methods over the `ArchiveUploadService` (the no-SSH migrate
// upload → stage flow):
//   - server.archive.upload.create   — open a scratch session, return upload_id.
//   - server.archive.upload.probe    — resume probe (persisted offset, identity-gated).
//   - server.archive.upload.finalize — STAGE the assembled archive under exports/
//                                       + return the staged_name for import.
//   - server.archive.upload.delete   — explicit cancel (best-effort reap).
//
// The chunk BYTES do NOT come through here — they ride the dedicated binary
// `/ws/archive-upload` socket (`service.handleChunkFrame`). This slice is only
// the typed control plane.
//
// Auth mirrors `upload.*`: the verified `token_instance_id` IS the scope key
// (resolved from the bearer at WS upgrade, never client-supplied), so one paired
// client can never drive another's archive upload. Owner-facing like the sibling
// archive rpc; off MCP by catalog omission.

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { ArchiveUploadService } from './archive/archive-upload-service.js';

export interface ArchiveUploadHandlerDeps {
  /** The per-pair archive upload service (core + stage-to-path policy). */
  service: ArchiveUploadService;
}

type ArchiveUploadMethods =
  | 'server.archive.upload.create'
  | 'server.archive.upload.probe'
  | 'server.archive.upload.finalize'
  | 'server.archive.upload.delete';

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

export const makeArchiveUploadHandlers = (
  deps: ArchiveUploadHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ArchiveUploadMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const { service } = deps;
  return {
    methods: [
      'server.archive.upload.create',
      'server.archive.upload.probe',
      'server.archive.upload.finalize',
      'server.archive.upload.delete',
    ],
    handlers: {
      'server.archive.upload.create': async (args, ctx) =>
        service.create({
          scope_key: requireScopeKey(ctx),
          filename: args.filename,
          declared_size: args.declared_size,
          ...(args.fingerprint !== undefined ? { fingerprint: args.fingerprint } : {}),
        }),
      'server.archive.upload.probe': async (args, ctx) =>
        service.probe({
          scope_key: requireScopeKey(ctx),
          upload_id: args.upload_id,
          filename: args.filename,
          declared_size: args.declared_size,
          ...(args.fingerprint !== undefined ? { fingerprint: args.fingerprint } : {}),
        }),
      'server.archive.upload.finalize': async (args, ctx) =>
        service.finalize({
          scope_key: requireScopeKey(ctx),
          upload_id: args.upload_id,
        }),
      'server.archive.upload.delete': async (args, ctx) =>
        service.delete({
          scope_key: requireScopeKey(ctx),
          upload_id: args.upload_id,
        }),
    },
  };
};
