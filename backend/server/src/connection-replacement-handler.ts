import { RpcError, regressionObject, regressionText, regressionBytes,
  type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import { packUpdateOwner, type PackUpdateDeps } from './pack-update-handler.js';
import type { PackConnectionsDeps } from './pack-connections-handler.js';
import type { ConnectionRpcDeps } from './connection-handler.js';
import type { DishHandlerDeps } from './dish-handler.js';
import type { PackInstallRpcDeps } from './pack-install-handler.js';
import { createConnectionReplacementStore } from './storage/connection-replacement-store.js';
type Methods = 'packs.connections.replace.inspect' | 'packs.connections.replace.review' | 'packs.connections.replace.rollback' | 'packs.connections.replace.apply';
const identifier = (raw: unknown) => {
  const value = regressionText(raw, 'a local account-reference identifier', 200);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value) || value.startsWith('__')) throw new RpcError('bad_request', 'Invalid local account-reference identifier.', 400);
  return value;
};
const object = (raw: unknown, keys: string[]) => {
  if (regressionBytes(raw) > 32000) throw new RpcError('bad_request', 'Keep account-reference requests under 32 KB.', 400);
  return regressionObject(raw, keys);
};
const unique = <T>(value: unknown, maximum: number, read: (raw: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new RpcError('bad_request', `Provide at most ${maximum} selected references.`, 400);
  const result = value.map(read);
  if (new Set(result.map(item => JSON.stringify(item))).size !== result.length) throw new RpcError('bad_request', 'Select each reference once.', 400);
  return result;
};
export const makeConnectionReplacementHandlers = (packs: PackConnectionsDeps | undefined, connections: ConnectionRpcDeps | undefined,
  dishes: DishHandlerDeps | undefined, install: PackInstallRpcDeps | undefined, updates: PackUpdateDeps | undefined): HandlerSlice<ServerRpcRegistry, Methods, WsClient> => {
  const db = install?.recipeStore.realmDatabase;
  const store = db && packs?.contractStore.realmDatabase === db && connections?.store.realmDatabase === db && dishes?.store.realmDatabase === db && updates
    ? createConnectionReplacementStore(db, updates.store.codec, { packs, dishes: dishes.store, recipes: install!.recipeStore }, install?.now) : undefined;
  const owner = (client: WsClient) => {
    if (!store || !updates) throw new RpcError('not_configured', 'Reviewed connection replacement needs the local account and recipe stores in one realm.', 503);
    return { store, ...packUpdateOwner(updates, client) };
  };
  return { methods: ['packs.connections.replace.inspect', 'packs.connections.replace.review', 'packs.connections.replace.rollback', 'packs.connections.replace.apply'], handlers: {
    'packs.connections.replace.inspect': async (raw, client) => {
      const { store, actor, check } = owner(client), value = object(raw, ['from_connection', 'to_connection']);
      if (value.to_connection !== undefined && value.from_connection === undefined) throw new RpcError('bad_request', 'Choose a source connection first.', 400);
      return store.inspect({ ...(value.from_connection !== undefined ? { from_connection: identifier(value.from_connection) } : {}),
        ...(value.to_connection !== undefined ? { to_connection: identifier(value.to_connection) } : {}) }, actor, check);
    },
    'packs.connections.replace.review': async (raw, client) => {
      const { store, actor, check } = owner(client), value = object(raw, ['from_connection', 'to_connection', 'targets', 'dish_ids', 'request_id']);
      const targets = unique(value.targets, 100, raw => { const target = object(raw, ['pack_slug', 'slot']);return { pack_slug: identifier(target.pack_slug), slot: identifier(target.slot) }; });
      return store.review({ from_connection: identifier(value.from_connection), to_connection: identifier(value.to_connection), targets,
        dish_ids: unique(value.dish_ids, 200, identifier), request_id: identifier(value.request_id) }, actor, check);
    },
    'packs.connections.replace.rollback': async (raw, client) => {
      const { store, actor, check } = owner(client), value = object(raw, ['receipt_id', 'request_id']);
      return store.rollback({ receipt_id: identifier(value.receipt_id), request_id: identifier(value.request_id) }, actor, check);
    },
    'packs.connections.replace.apply': async (raw, client) => {
      const { store, actor, check } = owner(client), value = object(raw, ['review_id', 'request_id', 'acknowledge_account_change']);
      if (typeof value.acknowledge_account_change !== 'boolean') throw new RpcError('bad_request', 'Acknowledge the account change with a boolean.', 400);
      return store.apply({ review_id: identifier(value.review_id), request_id: identifier(value.request_id), acknowledge_account_change: value.acknowledge_account_change }, actor, check);
    },
  } };
};
