import { RpcError, AUTOMATION_REHEARSAL_LIMITS, parseRehearsalTarget, parseRehearsalDocument, rehearsalObject, rehearsalText, rehearsalBytes,
  type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { WsClient } from './ws-server.js';
import type { AutomationRehearsalStore } from './storage/automation-rehearsal-store.js';

export interface AutomationRehearsalDeps { store: AutomationRehearsalStore; clientTokens: Pick<ClientTokenStore, 'get'> }
type Methods = 'automation.rehearsal.get' | 'automation.rehearsal.save' | 'automation.rehearsal.test'
  | 'automation.rehearsal.prepare' | 'automation.rehearsal.activate' | 'automation.rehearsal.delete';
const revision = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw >= Number.MAX_SAFE_INTEGER) throw new RpcError('bad_request', 'Provide a valid rehearsal revision.', 400); return raw;
};
const requestId = (raw: unknown): string => {
  const value = rehearsalText(raw, 'a request id', 100);
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new RpcError('bad_request', 'Invalid rehearsal request id.', 400); return value;
};
export const makeAutomationRehearsalHandlers = (deps: AutomationRehearsalDeps | undefined): HandlerSlice<ServerRpcRegistry, Methods, WsClient> => {
  const tests = new Set<string>();
  const owner = (client: WsClient) => {
    if (!deps) throw new RpcError('not_configured', 'Automation rehearsal is unavailable on this server.', 503);
    const token = client.client_token_id ? deps.clientTokens.get(client.client_token_id) : null, instance = client.token_instance_id ?? client.instance_id;
    if (!token || token.client_kind !== 'webclient' || client.client_kind !== 'webclient' || token.revoked_at !== null
      || !instance || token.metadata?.instance_id !== instance) throw new RpcError('unauthorized', 'Open rehearsal in your paired webclient.', 403);
    return { store: deps.store, actor: JSON.stringify([token.token_id, instance]), check: () => { owner(client); } };
  };
  const input = (raw: unknown, fields: string[]) => {
    if (rehearsalBytes(raw) > AUTOMATION_REHEARSAL_LIMITS.document_bytes + 4096) throw new RpcError('bad_request', 'Keep rehearsal requests below 256 KB.', 400);
    return rehearsalObject(raw, fields);
  };
  return { methods: ['automation.rehearsal.get', 'automation.rehearsal.save', 'automation.rehearsal.test', 'automation.rehearsal.prepare', 'automation.rehearsal.activate', 'automation.rehearsal.delete'], handlers: {
    'automation.rehearsal.get': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['target', 'draft_revision']);
      return store.read(parseRehearsalTarget(value.target), actor, check, value.draft_revision === undefined ? undefined : revision(value.draft_revision));
    },
    'automation.rehearsal.save': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['target', 'expected_revision', 'expected_live_digest', 'request_id', 'document']);
      return store.save({ target: parseRehearsalTarget(value.target), expected_revision: revision(value.expected_revision),
        expected_live_digest: rehearsalText(value.expected_live_digest, 'the current configuration digest'), request_id: requestId(value.request_id),
        document: parseRehearsalDocument(value.document) }, actor, check);
    },
    'automation.rehearsal.test': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['target', 'expected_revision', 'draft_revision']);
      if (tests.size >= 2 || tests.has(actor)) throw new RpcError('automation_rehearsal_limit', 'Wait for the current rehearsal to finish.', 409);
      tests.add(actor);
      try { return await store.test({ target: parseRehearsalTarget(value.target), expected_revision: revision(value.expected_revision), draft_revision: revision(value.draft_revision) }, actor, check); }
      finally { tests.delete(actor); }
    },
    'automation.rehearsal.prepare': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['target', 'expected_revision', 'draft_revision', 'receipt_id']);
      return store.prepare({ target: parseRehearsalTarget(value.target), expected_revision: revision(value.expected_revision),
        draft_revision: revision(value.draft_revision), receipt_id: requestId(value.receipt_id) }, actor, check);
    },
    'automation.rehearsal.activate': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['target', 'expected_revision', 'review_id', 'request_id']);
      return store.activate({ target: parseRehearsalTarget(value.target), expected_revision: revision(value.expected_revision),
        review_id: requestId(value.review_id), request_id: requestId(value.request_id) }, actor, check);
    },
    'automation.rehearsal.delete': async (raw, client) => {
      const { store, actor, check } = owner(client), value = input(raw, ['target', 'expected_revision', 'request_id']);
      return store.delete(parseRehearsalTarget(value.target), revision(value.expected_revision), requestId(value.request_id), actor, check);
    },
  } };
};
