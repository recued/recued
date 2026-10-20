import { RpcError,regressionBytes,regressionObject,regressionText,type HandlerSlice,type ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { PackUpdateDeps } from './pack-update-handler.js';
import { packUpdateOwner } from './pack-update-handler.js';
import type { PackUninstallRpcDeps } from './pack-uninstall-handler.js';
import { handlePacksUninstall } from './pack-uninstall-handler.js';
import { createPackRemovalStore } from './storage/pack-removal-store.js';
type Methods = 'packs.removal.review' | 'packs.removal.apply';
const id = (value: unknown): string => {
  const text = regressionText(value,'a removal identifier',200);
  if (!/^[a-zA-Z0-9_-]+$/.test(text)) throw new RpcError('bad_request','Invalid removal identifier.',400);
  return text;
};
export const makePackRemovalHandlers = (deps: PackUninstallRpcDeps | undefined,updates: PackUpdateDeps | undefined): HandlerSlice<ServerRpcRegistry,Methods,WsClient> => {
  const db = deps?.recipeStore.realmDatabase;
  const store = deps && db && deps.contractStore?.realmDatabase === db && updates ? createPackRemovalStore(db,updates.store.codec,deps,deps.now) : undefined;
  const owner = (client: WsClient) => {
    if (!store || !updates || !deps) throw new RpcError('not_configured','Reviewed pack removal is unavailable on this server.',503);
    return { store,deps,...packUpdateOwner(updates,client) };
  };
  const input = (raw: unknown,keys: string[]) => {
    if (regressionBytes(raw) > 4096) throw new RpcError('bad_request','Keep removal requests under 4 KB.',400);
    return regressionObject(raw,keys);
  };
  return { methods: ['packs.removal.review','packs.removal.apply'],handlers: {
    'packs.removal.review': async (raw,client) => {
      const { store,actor,check } = owner(client),value = input(raw,['pack_slug','publisher','request_id']);
      return store.review({ pack_slug: id(value.pack_slug),request_id: id(value.request_id),
        ...(value.publisher !== undefined ? { publisher: regressionText(value.publisher,'the installed publisher',200) } : {}) },actor,check);
    },
    'packs.removal.apply': async (raw,client) => {
      const { store,deps,actor,check } = owner(client),value = input(raw,['review_id','request_id','acknowledge_unknown_dependencies','acknowledge_incomplete_attempt']);
      for (const field of ['acknowledge_unknown_dependencies','acknowledge_incomplete_attempt']) if (value[field] !== undefined && typeof value[field] !== 'boolean') {
        throw new RpcError('bad_request','Acknowledge removal review risks with a boolean.',400);
      }
      return store.apply({ review_id: id(value.review_id),request_id: id(value.request_id),
        ...(typeof value.acknowledge_unknown_dependencies === 'boolean' ? { acknowledge_unknown_dependencies: value.acknowledge_unknown_dependencies } : {}),
        ...(typeof value.acknowledge_incomplete_attempt === 'boolean' ? { acknowledge_incomplete_attempt: value.acknowledge_incomplete_attempt } : {}) },actor,check,
      async (target,controls) => {
        const result = await handlePacksUninstall(deps,target,controls);controls.check();
        if (result.result.ok) updates!.store.retire(controls.identity.inventory_key);
        return result.result;
      });
    },
  } };
};
