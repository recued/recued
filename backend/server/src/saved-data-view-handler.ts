/** Saved Data views belong to the paired owner UI, with no agent execution path. */
import { RpcError, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { SavedDataViewStore } from './saved-data-view-store.js';
import type { WsClient } from './ws-server.js';

type Methods = 'data_views.list' | 'data_views.get' | 'data_views.create' | 'data_views.update' | 'data_views.rename' | 'data_views.delete';
const requireClient = (client: WsClient): void => {
  if (!client.instance_id) throw new RpcError('unauthorized', 'Saved views require a registered paired client.', 401);
};

export const makeSavedDataViewHandlers = (
  store: SavedDataViewStore | undefined,
): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (store === undefined) return undefined;
  return {
    methods: ['data_views.list', 'data_views.get', 'data_views.create', 'data_views.update', 'data_views.rename', 'data_views.delete'],
    handlers: {
      'data_views.list': async (_args, client) => { requireClient(client); return { views: store.list() }; },
      'data_views.get': async (args, client) => { requireClient(client); return { view: store.get(args?.id) }; },
      'data_views.create': async (args, client) => { requireClient(client); return { view: store.create(args ?? {}) }; },
      'data_views.update': async (args, client) => { requireClient(client); return { view: store.update(args ?? {}) }; },
      'data_views.rename': async (args, client) => { requireClient(client); return { view: store.rename(args ?? {}) }; },
      'data_views.delete': async (args, client) => { requireClient(client); store.delete(args ?? {}); return { deleted: true }; },
    },
  };
};
