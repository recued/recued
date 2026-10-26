import { RpcError, permissionObject, permissionText, permissionBytes, parsePermissionDocument, PERMISSION_REGRESSION_LIMITS,
  type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { PermissionRegressionStore } from './storage/permission-regression-store.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { WsClient } from './ws-server.js';

export interface PermissionRegressionDeps { store: PermissionRegressionStore; clientTokens: Pick<ClientTokenStore, 'get'> }
type Methods = 'contract.regression.get' | 'contract.regression.save' | 'contract.regression.restore' | 'contract.regression.test'
  | 'contract.regression.prepare' | 'contract.regression.activate' | 'contract.regression.delete';
const revision = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw >= Number.MAX_SAFE_INTEGER) throw new RpcError('bad_request', 'Provide a valid permission revision.', 400);
  return raw;
};
const requestId = (raw: unknown) => {
  const value = permissionText(raw, 'a request id', 100);
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new RpcError('bad_request', 'Invalid permission request id.', 400);
  return value;
};
export const makePermissionRegressionHandlers = (deps: PermissionRegressionDeps | undefined): HandlerSlice<ServerRpcRegistry, Methods, WsClient> => {
  const active = new Set<string>();
  const owner = (client: WsClient) => {
    if (!deps) throw new RpcError('not_configured', 'Permission tests are unavailable on this server.', 503);
    const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null, instance = client.token_instance_id ?? client.instance_id;
    if (!token || token.client_kind !== 'webclient' || client.client_kind !== 'webclient' || token.revoked_at !== null
      || !instance || token.metadata?.instance_id !== instance) throw new RpcError('unauthorized', 'Open permission tests in your paired webclient.', 403);
    return { store: deps.store, actor: JSON.stringify([token.token_id, instance]) };
  };
  const input = (raw: unknown, fields: string[]) => {
    if (permissionBytes(raw) > PERMISSION_REGRESSION_LIMITS.document_bytes + 4096) throw new RpcError('bad_request', 'Keep permission requests below 256 KB.', 400);
    return permissionObject(raw, fields);
  };
  return { methods: ['contract.regression.get', 'contract.regression.save', 'contract.regression.restore', 'contract.regression.test',
    'contract.regression.prepare', 'contract.regression.activate', 'contract.regression.delete'], handlers: {
    'contract.regression.get': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'draft_revision']);
      return store.read(permissionText(value.contract_id, 'a contract id'), actor, () => { owner(client); }, value.draft_revision === undefined ? undefined : revision(value.draft_revision));
    },
    'contract.regression.save': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'expected_revision', 'expected_live_digest', 'request_id', 'document']);
      return store.save({ contract_id: permissionText(value.contract_id, 'a contract id'), expected_revision: revision(value.expected_revision),
        expected_live_digest: permissionText(value.expected_live_digest, 'the current grant digest'), request_id: requestId(value.request_id), document: parsePermissionDocument(value.document) }, actor, () => { owner(client); });
    },
    'contract.regression.restore': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'expected_revision', 'expected_live_digest', 'request_id', 'sequence']);
      return store.save({ contract_id: permissionText(value.contract_id, 'a contract id'), expected_revision: revision(value.expected_revision),
        expected_live_digest: permissionText(value.expected_live_digest, 'the current grant digest'), request_id: requestId(value.request_id), sequence: revision(value.sequence) }, actor, () => { owner(client); });
    },
    'contract.regression.test': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'expected_revision', 'draft_revision']);
      if (active.size >= 2 || active.has(actor)) throw new RpcError('permission_regression_limit', 'Wait for the current permission check to finish.', 409);
      active.add(actor);
      try { return await store.test({ contract_id: permissionText(value.contract_id, 'a contract id'), expected_revision: revision(value.expected_revision),
        draft_revision: revision(value.draft_revision) }, actor, () => { owner(client); }); }
      finally { active.delete(actor); }
    },
    'contract.regression.prepare': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'expected_revision', 'draft_revision', 'receipt_id']);
      return store.prepare({ contract_id: permissionText(value.contract_id, 'a contract id'), expected_revision: revision(value.expected_revision),
        draft_revision: revision(value.draft_revision), receipt_id: requestId(value.receipt_id) }, actor, () => { owner(client); });
    },
    'contract.regression.activate': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'expected_revision', 'review_id', 'request_id']);
      return store.activate({ contract_id: permissionText(value.contract_id, 'a contract id'), expected_revision: revision(value.expected_revision),
        review_id: requestId(value.review_id), request_id: requestId(value.request_id) }, actor, () => { owner(client); });
    },
    'contract.regression.delete': async (raw, client) => {
      const { store, actor } = owner(client), value = input(raw, ['contract_id', 'expected_revision', 'request_id']);
      return store.delete(permissionText(value.contract_id, 'a contract id'), revision(value.expected_revision), requestId(value.request_id), actor, () => { owner(client); });
    },
  } };
};
