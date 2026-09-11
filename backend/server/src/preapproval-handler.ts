/** D-261 owner control plane. An instance id or caller-supplied actor is not
 * owner interaction evidence: the live token must belong to a webclient. */
import {
  RpcError, parsePreparePreapproval, parsePreapprovalDecision, parsePreapprovalList,
  parsePreapprovalLocator, parsePreapprovalRevoke, parsePreapprovalSelection,
  type HandlerSlice, type PreparePreapproval, type PreapprovalCapabilities,
  type PreapprovalResult, type ServerRpcRegistry,
} from '@recued/contracts';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { PreapprovalOrigin, PreapprovalResponder } from './preapproval-model.js';
import type { PreapprovalRepository } from './storage/preapproval-repository.js';
import type { WsClient } from './ws-server.js';
import type { MailDraftService, MailDraftMethod } from './mail-draft-service.js';

export interface PreapprovalHandlerDeps {
  /** Stable realm identity from server storage. WsClient.realm is the
   * transport's bearer carrier and must never be persisted as an identity. */
  ownerId: string;
  repository: PreapprovalRepository;
  clientTokens: Pick<ClientTokenStore, 'get'>;
  prepare(request: PreparePreapproval, origin: PreapprovalOrigin): Promise<PreapprovalResult>;
  capabilities(): PreapprovalCapabilities;
  drafts?: MailDraftService;
}
type Methods = 'preapproval.capabilities' | 'preapproval.prepare' | 'preapproval.select'
  | 'preapproval.review' | 'preapproval.decide' | 'preapproval.get' | 'preapproval.list' | 'preapproval.revoke'
  | 'mail.drafts.create' | 'mail.drafts.get' | 'mail.drafts.list' | 'mail.drafts.update' | 'mail.drafts.delete';

export const requirePreapprovalOwner = (client: WsClient, tokens: Pick<ClientTokenStore, 'get'>, ownerId: string): {
  responder: PreapprovalResponder; origin: PreapprovalOrigin;
} => {
  const token = client.client_token_id ? tokens.get(client.client_token_id) : null;
  const instanceId = client.token_instance_id ?? client.instance_id;
  if (!token || token.client_kind !== 'webclient' || client.client_kind !== 'webclient'
    || token.revoked_at !== null || !instanceId || token.metadata?.instance_id !== instanceId) {
    throw new RpcError('preapproval_invalid_proof', 'Open pre-approval in your paired webclient.', 403);
  }
  return {
    responder: { channel: 'webclient', key: token.token_id },
    origin: { mode: 'owner', owner_id: ownerId, entry: 'owner_ui',
      credential_id: token.token_id, credential_label: token.client_label,
      entry_tool_grants: [], recipe_grant_key: null, display_name: 'You',
      source: { channel: 'user', actor: 'user_self', user_id: ownerId, client_token_id: token.token_id } },
  };
};

export const makePreapprovalHandlers = (
  deps: PreapprovalHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (!deps) return undefined;
  const owner = (client: WsClient) => requirePreapprovalOwner(client, deps.clientTokens, deps.ownerId);
  const draft = <M extends MailDraftMethod>(method: M, raw: unknown, client: WsClient) => {
    const { origin } = owner(client);
    if (!deps.drafts) throw new RpcError('preapproval_unsupported', 'Saved drafts are unavailable.', 503);
    return deps.drafts.owner(method, raw, origin);
  };
  return {
    methods: ['preapproval.capabilities', 'preapproval.prepare', 'preapproval.select',
      'preapproval.review', 'preapproval.decide', 'preapproval.get', 'preapproval.list', 'preapproval.revoke',
      'mail.drafts.create', 'mail.drafts.get', 'mail.drafts.list', 'mail.drafts.update', 'mail.drafts.delete'],
    handlers: {
      'mail.drafts.create': async (args, client) => draft('create', args, client),
      'mail.drafts.get': async (args, client) => draft('get', args, client),
      'mail.drafts.list': async (args, client) => draft('list', args, client),
      'mail.drafts.update': async (args, client) => draft('update', args, client),
      'mail.drafts.delete': async (args, client) => draft('delete', args, client),
      'preapproval.capabilities': async (_args, client) => {
        owner(client); return deps.capabilities();
      },
      'preapproval.prepare': async (args, client) => {
        const { origin } = owner(client);
        return deps.prepare(parsePreparePreapproval(args), origin);
      },
      'preapproval.select': async (args, client) => {
        const { responder } = owner(client);
        return deps.repository.select(parsePreapprovalSelection(args), responder);
      },
      'preapproval.review': async (args, client) => {
        const { responder } = owner(client);
        return deps.repository.review(parsePreapprovalLocator(args).proposal_id, responder);
      },
      'preapproval.decide': async (args, client) => {
        const { responder } = owner(client);
        return deps.repository.decide(parsePreapprovalDecision(args), responder);
      },
      'preapproval.get': async (args, client) => {
        owner(client); return deps.repository.inspect(parsePreapprovalLocator(args).proposal_id);
      },
      'preapproval.list': async (args, client) => {
        owner(client); const { cursor, limit } = parsePreapprovalList(args);
        return deps.repository.list(cursor, limit);
      },
      'preapproval.revoke': async (args, client) => {
        const { responder } = owner(client);
        return deps.repository.revoke(parsePreapprovalRevoke(args), responder);
      },
    },
  };
};
