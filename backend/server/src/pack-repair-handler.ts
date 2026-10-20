import { RpcError, regressionObject, regressionBytes, regressionText, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import { packUpdateOwner, type PackUpdateDeps } from './pack-update-handler.js';
import type { PackUninstallRpcDeps } from './pack-uninstall-handler.js';
import { createPackRepairStore } from './storage/pack-repair-store.js';
type Methods = 'packs.repair.inspect' | 'packs.repair.review' | 'packs.repair.apply';
const id = (value: unknown): string => {
  const result = regressionText(value, 'a repair identifier', 200);
  if (!/^[a-zA-Z0-9_-]+$/.test(result) || result.startsWith('__')) throw new RpcError('bad_request', 'Invalid repair identifier.', 400);
  return result;
};
export const makePackRepairHandlers = (deps: PackUninstallRpcDeps | undefined, updates: PackUpdateDeps | undefined): HandlerSlice<ServerRpcRegistry, Methods, WsClient> => {
  const db = deps?.recipeStore.realmDatabase;
  const store = db && deps?.contractStore?.realmDatabase === db && updates ? createPackRepairStore(db, updates.store.codec, deps, deps.now) : undefined;
  const owner = (client: WsClient) => {
    if (!store || !updates) throw new RpcError('not_configured', 'Installation repair is unavailable on this server.', 503);
    return { store, ...packUpdateOwner(updates, client) };
  };
  const input = (raw: unknown, keys: string[]) => {
    if (regressionBytes(raw) > 4096) throw new RpcError('bad_request', 'Keep repair requests under 4 KB.', 400);
    return regressionObject(raw, keys);
  };
  return { methods: ['packs.repair.inspect', 'packs.repair.review', 'packs.repair.apply'], handlers: {
    'packs.repair.inspect': async (raw, client) => { const { store, actor, check } = owner(client);input(raw, []);return store.inspect(actor, check); },
    'packs.repair.review': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['inventory_key', 'request_id']);
      return store.review({ inventory_key: id(value.inventory_key), request_id: id(value.request_id) }, actor, check);
    },
    'packs.repair.apply': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['review_id', 'request_id', 'acknowledge_local_cleanup', 'acknowledge_unknown_dependencies']);
      if (typeof value.acknowledge_local_cleanup !== 'boolean' || value.acknowledge_unknown_dependencies !== undefined && typeof value.acknowledge_unknown_dependencies !== 'boolean') {
        throw new RpcError('bad_request', 'Acknowledge repair review with booleans.', 400);
      }
      return store.apply({ review_id: id(value.review_id), request_id: id(value.request_id), acknowledge_local_cleanup: value.acknowledge_local_cleanup,
        ...(typeof value.acknowledge_unknown_dependencies === 'boolean' ? { acknowledge_unknown_dependencies: value.acknowledge_unknown_dependencies } : {}) }, actor, check);
    },
  } };
};
