/** D-261 retains the initiating principal. Owner responses decide an ask; they
 * never substitute their own source for the deferred execution's source. */
import {
  MESSENGER_PRINCIPAL_CONFIG_KEY, RpcError, executionSourceContractId, recipeGrantEntry,
  type ContractSnapshot, type PreapprovalActivation,
} from '@recued/contracts';
import { llmGatewayTokenId, type ApprovalResumeAuthorityResolver } from './approval-resume-authority.js';
import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { PreapprovalOrigin, PreapprovalResponder } from './preapproval-model.js';
import { preapprovalHash, preapprovalOriginKey } from './preapproval-invocations.js';
import { resolveTelegramRecipient } from './composition/bin/wire-telegram-channel.js';

export interface PreapprovalOriginAuthorityDeps {
  realm: string;
  resumeAuthority: ApprovalResumeAuthorityResolver;
  clientTokens: Pick<ClientTokenStore, 'get'>;
  opAdmissionGate: OpAdmissionGate;
  connections: Pick<ConnectionStoreSqlite, 'get'>;
}
function refuse(detail: string): never {
  throw new RpcError('preapproval_authority_changed', detail, 403);
}

export const createPreapprovalOriginAuthority = (deps: PreapprovalOriginAuthorityDeps) => {
  const hasRecipeGrant = (origin: PreapprovalOrigin, key: string): boolean => {
    if (deps.opAdmissionGate.isOwnerGoverned(origin.source)) {
      return deps.opAdmissionGate.isOwnerRecipeGranted(origin.source, key);
    }
    if (origin.source.channel !== 'mcp' && !llmGatewayTokenId(origin.source)) return false;
    const resolved = deps.resumeAuthority.resolve({ execution_source: origin.source,
      required_bearer_tool_names: [key] });
    return resolved.admitted && resolved.contract_snapshot !== undefined
      && executionSourceContractId(resolved.execution_source) === executionSourceContractId(origin.source);
  };
  const webclient = (id: string) => {
    const token = deps.clientTokens.get(id);
    return token?.revoked_at === null && token.client_kind === 'webclient'
      && typeof token.metadata?.instance_id === 'string' && token.metadata.instance_id.length > 0 ? token : null;
  };
  const resolve = (origin: PreapprovalOrigin, requestOp = 'core.preapproval.request'): { contract_snapshot?: ContractSnapshot } => {
    preapprovalOriginKey(origin); // Closed owner/explicit-contract identity check.
    if (origin.mode === 'owner' && origin.owner_id !== deps.realm) refuse('The original owner realm changed.');
    if (origin.entry === 'owner_ui') {
      if (origin.mode !== 'owner' || origin.source.channel !== 'user' || origin.source.actor !== 'user_self'
        || !origin.credential_id || origin.source.client_token_id !== origin.credential_id
        || !webclient(origin.credential_id)) refuse('The original paired webclient is no longer authorized.');
    }
    const resolved = deps.resumeAuthority.resolve({ execution_source: origin.source,
      required_bearer_tool_names: origin.entry_tool_grants,
      ...(origin.entry_raw_op_id ? { required_raw_op_id: origin.entry_raw_op_id } : {}) });
    if (!resolved.admitted) refuse(resolved.detail);
    if (executionSourceContractId(resolved.execution_source) !== executionSourceContractId(origin.source)) {
      refuse('The original governing contract changed.');
    }
    if (deps.opAdmissionGate.isFrozenByPause(origin.source)) refuse('The original execution authority is paused.');
    if (origin.entry === 'kernel' && !deps.opAdmissionGate.isOpGranted(origin.source, requestOp)) {
      refuse(`The original contract no longer permits ${requestOp}.`);
    }
    if (origin.recipe_grant_key && !hasRecipeGrant(origin, origin.recipe_grant_key)) {
      refuse('The original recipe grant was revoked.');
    }
    const targetGrant = origin.target_recipe_grant_key;
    if (targetGrant && !hasRecipeGrant(origin, targetGrant)) refuse('The reviewed recipe grant was revoked.');
    // Resume authority deliberately omits recipe names from its broad tool
    // snapshot. Restore ONLY this independently reverified root grant. The
    // same snapshot then drives preparation, the actual runner and its audit.
    return resolved.contract_snapshot ? { contract_snapshot: targetGrant
      ? buildVersionedContractSnapshot({ ...resolved.contract_snapshot,
        allowed_tools: [...resolved.contract_snapshot.allowed_tools, targetGrant] })
      : resolved.contract_snapshot } : {};
  };
  return {
    resolve,
    bindTargetRecipe(origin: PreapprovalOrigin, publisher: string, recipe: string): PreapprovalOrigin {
      resolve(origin);
      const key = deps.opAdmissionGate.isOwnerGoverned(origin.source)
        ? recipeGrantEntry(publisher, recipe) : `${publisher}/${recipe}`;
      return { ...origin, target_recipe_grant_key: hasRecipeGrant(origin, key) ? key : null };
    },
    /** Grant axis only. The activation resolver must also enforce ownership
     * of an existing target; an op grant does not confer that ownership. */
    validateActivationPermission(origin: PreapprovalOrigin, activation: PreapprovalActivation): void {
      resolve(origin);
      if (origin.mode === 'contract' && (activation.kind === 'next_auto_run' || activation.kind === 'next_trigger')) {
        throw new RpcError('preapproval_unsupported', 'This contract has no grantable Arm or Trigger operation.', 409);
      }
      if ((activation.kind === 'one_shot' || activation.kind === 'next_schedule')
        && !deps.opAdmissionGate.isOpGranted(origin.source, 'core.schedule.recipe')) {
        refuse('The original contract does not permit scheduling this execution.');
      }
    },
    validateResponder(responder: PreapprovalResponder): void {
      if (responder.channel === 'webclient') {
        if (webclient(responder.key)) return;
      } else if (responder.connection_id === 'telegram'
        && responder.key === preapprovalHash(['telegram', responder.connection_id, responder.owner_sender])) {
        const row = deps.connections.get('notification', 'telegram');
        let config: Record<string, unknown> | null = null;
        try {
          const value: unknown = row ? JSON.parse(row.config_json) : null;
          if (value && typeof value === 'object' && !Array.isArray(value)) config = value as Record<string, unknown>;
        } catch { /* Malformed enrollment has no owner authority. */ }
        const principal = config?.[MESSENGER_PRINCIPAL_CONFIG_KEY];
        if (typeof principal === 'string' && principal.trim() === responder.owner_sender
          && resolveTelegramRecipient(config) !== null) return;
      }
      throw new RpcError('preapproval_invalid_proof', 'This response is not from a currently enrolled owner surface.', 403);
    },
  };
};
