/** D-403 — the owner's storage view and purge over the pair rpc (`owner-storage.ts`).
 *
 *  Every method needs a registered paired client: the owner's own app. No AI app, recipe or webhook
 *  reaches them (`storage.` is reserved out of MCP, as `records.` is). */
import { RpcError, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import { OwnerStorageError, type OwnerStorage } from './owner-storage.js';
import type { WsClient } from './ws-server.js';

export interface OwnerStorageRpcDeps {
  storage: OwnerStorage;
}

type OwnerStorageRpcMethods = 'storage.kinds.read' | 'storage.purge.preview' | 'storage.purge.run';

const METHODS: readonly OwnerStorageRpcMethods[] = ['storage.kinds.read', 'storage.purge.preview', 'storage.purge.run'];

const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) throw new RpcError('unauthorized', 'storage rpc requires a registered paired client', 401);
};

const requireArgs = (args: unknown, method: string): { kind: string; before: number; token?: unknown } => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError('bad_request', `${method}: args must be an object`, 400);
  const raw = args as Record<string, unknown>;
  if (typeof raw.kind !== 'string' || !raw.kind.trim()) throw new RpcError('bad_request', `${method}: kind is required`, 400);
  if (typeof raw.before !== 'number' || !Number.isSafeInteger(raw.before)) throw new RpcError('bad_request', `${method}: before must be an epoch ms`, 400);
  return { kind: raw.kind, before: raw.before, token: raw.token };
};

const STATUS: Record<OwnerStorageError['code'], [code: string, status: number]> = {
  unknown_kind: ['not_found', 404],
  not_purgeable: ['bad_request', 400],
  bad_cutoff: ['bad_request', 400],
  stale_preview: ['conflict', 409],
};

const mapped = async <T>(method: string, work: () => T | Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OwnerStorageError) {
      const [code, status] = STATUS[error.code];
      throw new RpcError(code, error.message, status, method);
    }
    throw error;
  }
};

export const makeOwnerStorageRpcHandlers = (
  deps: OwnerStorageRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, OwnerStorageRpcMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [...METHODS],
    handlers: {
      'storage.kinds.read': async (_args, client) => {
        requireRegisteredClient(client);
        return deps.storage.read();
      },
      'storage.purge.preview': async (args, client) => {
        requireRegisteredClient(client);
        const { kind, before } = requireArgs(args, 'storage.purge.preview');
        return mapped('storage.purge.preview', () => deps.storage.preview(kind, before));
      },
      'storage.purge.run': async (args, client) => {
        requireRegisteredClient(client);
        const { kind, before, token } = requireArgs(args, 'storage.purge.run');
        if (typeof token !== 'string' || !token) throw new RpcError('bad_request', 'storage.purge.run: token from a preview is required', 400);
        return mapped('storage.purge.run', () => deps.storage.run(kind, before, token));
      },
    },
  };
};
