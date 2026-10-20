/** D-261 owner control plane. An instance id or caller-supplied actor is not
 * owner interaction evidence: the live token must belong to a webclient. */
import {
  RpcError, parsePreparePreapproval, parsePreapprovalDecision, parsePreapprovalList,
  parsePreapprovalLocator, parsePreapprovalRevoke, parsePreapprovalSelection, parsePreapprovalContinuation, parsePreapprovalReconcile,
  type HandlerSlice, type PreparePreapproval, type PreapprovalCapabilities,
  type PreapprovalResult, type ServerRpcRegistry,
} from '@recued/contracts';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { PreapprovalOrigin, PreapprovalResponder } from './preapproval-model.js';
import type { PreapprovalRepository } from './storage/preapproval-repository.js';
import type { WsClient } from './ws-server.js';
import type { MailDraftService, MailDraftMethod } from './mail-draft-service.js';
import { parseLocalUndoReceipt, parseLocalUndoDecision, type LocalUpdateUndo } from './local-update-undo.js';
import { parseLocalChangeSetLocator, parseLocalChangeSetPrepare, parseLocalChangeSetUndo,
  parseLocalChangeSetDecision, parseLocalChangeSetList, type LocalChangeSets } from './local-change-sets.js';

export interface PreapprovalHandlerDeps {
  /** Stable realm identity from server storage. WsClient.realm is the
   * transport's bearer carrier and must never be persisted as an identity. */
  ownerId: string;
  repository: PreapprovalRepository;
  clientTokens: Pick<ClientTokenStore, 'get'>;
  prepare(request: PreparePreapproval, origin: PreapprovalOrigin): Promise<PreapprovalResult>;
  continuePlan?(request: import('@recued/contracts').PreapprovalContinuationRequest,
    responder: PreapprovalResponder): Promise<PreapprovalResult>;
  reconcile?(request: import('@recued/contracts').PreapprovalReconcileRequest,
    responder: PreapprovalResponder): Promise<import('@recued/contracts').PreapprovalReconcileResult>;
  capabilities(): PreapprovalCapabilities;
  drafts?: MailDraftService;
  localUndo?: LocalUpdateUndo;
  localChanges?: LocalChangeSets;
}
type Methods = 'local_undo.get' | 'local_undo.review' | 'local_undo.decide' | 'preapproval.capabilities' | 'preapproval.prepare' | 'preapproval.select'
  | 'local_changes.prepare' | 'local_changes.get' | 'local_changes.list' | 'local_changes.decide' | 'local_changes.prepare_undo'
  | 'preapproval.continue' | 'preapproval.reconcile'
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
    methods: ['preapproval.capabilities', 'preapproval.prepare', 'preapproval.continue', 'preapproval.reconcile', 'preapproval.select',
      'preapproval.review', 'preapproval.decide', 'preapproval.get', 'preapproval.list', 'preapproval.revoke',
      'mail.drafts.create', 'mail.drafts.get', 'mail.drafts.list', 'mail.drafts.update', 'mail.drafts.delete',
      'local_undo.get', 'local_undo.review', 'local_undo.decide',
      'local_changes.prepare', 'local_changes.get', 'local_changes.list', 'local_changes.decide', 'local_changes.prepare_undo'],
    handlers: {
      'local_changes.prepare': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localChanges) throw new RpcError('local_changes_unavailable', 'Atomic local changes are unavailable.', 503);
        return deps.localChanges.prepare(parseLocalChangeSetPrepare(args),origin);
      },
      'local_changes.get': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localChanges) throw new RpcError('local_changes_unavailable', 'Atomic local changes are unavailable.', 503);
        return deps.localChanges.get(parseLocalChangeSetLocator(args),origin);
      },
      'local_changes.list': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localChanges) throw new RpcError('local_changes_unavailable', 'Atomic local changes are unavailable.', 503);
        return deps.localChanges.list(parseLocalChangeSetList(args),origin);
      },
      'local_changes.decide': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localChanges) throw new RpcError('local_changes_unavailable', 'Atomic local changes are unavailable.', 503);
        return deps.localChanges.decide(parseLocalChangeSetDecision(args),origin);
      },
      'local_changes.prepare_undo': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localChanges) throw new RpcError('local_changes_unavailable', 'Atomic local changes are unavailable.', 503);
        return deps.localChanges.prepareUndo(parseLocalChangeSetUndo(args),origin);
      },
      'local_undo.get': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localUndo) throw new RpcError('local_undo_unavailable', 'Reviewed undo is unavailable.', 503);
        return deps.localUndo.get(parseLocalUndoReceipt(args), origin);
      },
      'local_undo.review': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localUndo) throw new RpcError('local_undo_unavailable', 'Reviewed undo is unavailable.', 503);
        return deps.localUndo.review(parseLocalUndoReceipt(args), origin);
      },
      'local_undo.decide': async (args, client) => {
        const { origin } = owner(client);
        if (!deps.localUndo) throw new RpcError('local_undo_unavailable', 'Reviewed undo is unavailable.', 503);
        return deps.localUndo.decide(parseLocalUndoDecision(args), origin);
      },
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
      'preapproval.continue': async (args, client) => {
        const { responder } = owner(client);
        if (!deps.continuePlan) throw new RpcError('preapproval_unsupported', 'Continuation is unavailable on this server.', 503);
        return deps.continuePlan(parsePreapprovalContinuation(args), responder);
      },
      'preapproval.reconcile': async (args, client) => {
        const { responder } = owner(client);
        if (!deps.reconcile) throw new RpcError('preapproval_unsupported', 'Provider verification is unavailable on this server.', 503);
        return deps.reconcile(parsePreapprovalReconcile(args), responder);
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
