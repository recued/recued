import { RpcError, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { KitchenDraftStore } from './kitchen-draft-store.js';

export const makeKitchenDraftHandlers = (store?: KitchenDraftStore): HandlerSlice<ServerRpcRegistry,
  'kitchen.draft.get' | 'kitchen.draft.update' | 'kitchen.draft.discard' | 'kitchen.draft.list' | 'kitchen.draft.create',
  WsClient> => {
  const requireStore = (client: WsClient): KitchenDraftStore => {
    if (!client.instance_id || client.client_kind !== 'webclient') throw new RpcError('unauthorized', 'Open Kitchen from a paired webclient.', 401);
    if (!store) throw new RpcError('not_configured', 'Kitchen storage is unavailable.', 503);
    return store;
  };
  return { methods: ['kitchen.draft.get', 'kitchen.draft.update', 'kitchen.draft.discard', 'kitchen.draft.list', 'kitchen.draft.create'], handlers: {
    'kitchen.draft.get': async (args, client) => {
      const active = requireStore(client);
      if (typeof args?.draft_id !== 'string') throw new RpcError('bad_request', 'Provide a draft_id.', 400);
      const result = active.get(args.draft_id);
      if (!result) throw new RpcError('not_found', 'This is no longer in progress in Kitchen.', 404);
      return result;
    },
    'kitchen.draft.update': async (args, client) => {
      const active = requireStore(client);
      if (typeof args?.draft_id !== 'string' || !Number.isInteger(args.expected_revision) || args.expected_revision < 1) {
        throw new RpcError('bad_request', 'Provide a draft id and its current revision.', 400);
      }
      return active.update(args.draft_id, args.expected_revision, args.source);
    },
    // D-332 — discarding is the owner's, in Kitchen. No MCP tool or kernel op can.
    'kitchen.draft.discard': async (args, client) => {
      const active = requireStore(client);
      if (typeof args?.draft_id !== 'string' || !Number.isInteger(args.expected_revision) || args.expected_revision < 1) {
        throw new RpcError('bad_request', 'Provide a draft id and its current revision.', 400);
      }
      return active.discard(args.draft_id, args.expected_revision);
    },
    // D-333 — In progress: the owner sees every origin's work; a connection sees only its own.
    'kitchen.draft.list': async (_args, client) => ({ items: requireStore(client).listAll() }),
    'kitchen.draft.create': async (args, client) => {
      const active = requireStore(client);
      if ((args?.kind !== 'recipe' && args?.kind !== 'pack') || typeof args.source !== 'string') {
        throw new RpcError('bad_request', 'Provide kind recipe or pack, and its source.', 400);
      }
      const base = args.base;
      if (base !== undefined && (typeof base?.recipe_id !== 'string' || !base.recipe_id.trim()
        || base.recipe_id.length > 256 || !Number.isSafeInteger(base.version) || base.version < 1)) {
        throw new RpcError('bad_request', 'Name the saved recipe by its recipe_id and version.', 400);
      }
      return active.create(args.kind, args.source, base === undefined ? undefined
        : { recipe_id: base.recipe_id, version: base.version });
    },
  } };
};
