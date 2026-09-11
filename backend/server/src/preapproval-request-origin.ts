/** Original requester attribution from execution metadata and live stores.
 * Names are display data; only the source/credential/grant identities govern. */
import { RpcError, executionSourceContractId, type StepMeta } from '@recued/contracts';
import { llmGatewayTokenId } from './approval-resume-authority.js';
import type { RecipeStore } from './recipe-store.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import type { PreapprovalOrigin } from './preapproval-model.js';

export const createPreapprovalRequestOrigin = (deps: {
  ownerId: string; recipes: RecipeStore; definitions: ContractDefinitionStore;
  clientTokens: Pick<ClientTokenStore, 'get'>; inboundTokens?: ChatInboundTokenStore;
}, meta: StepMeta | undefined, operation = 'core.preapproval.request'): PreapprovalOrigin => {
  const source = meta?.execution_source;
  if (!source) throw new RpcError('preapproval_authority_changed', 'A future execution requires an authenticated requesting source.', 403);
  const contractId = executionSourceContractId(source);
  const gatewayToken = llmGatewayTokenId(source);
  const credentialId = source.channel === 'mcp' ? source.mcp_token_id
    : source.channel === 'user' ? source.client_token_id : gatewayToken;
  const credentialLabel = source.channel === 'user' && credentialId ? deps.clientTokens.get(credentialId)?.client_label
    : credentialId ? deps.inboundTokens?.getTokenById(credentialId)?.label : null;
  const raw = source.channel === 'mcp' && !meta.recipe_id && !meta.entry_tool_name;
  let entryToolGrants: string[] = [];
  if (source.channel === 'mcp' && !raw) entryToolGrants = meta.entry_tool_name ? [meta.entry_tool_name]
    : meta.governing_recipe_grant ? [meta.governing_recipe_grant] : ['recued_runRecipe', 'recipe.run'];
  if (gatewayToken) {
    const stored = meta.recipe_id ? deps.recipes.getStored(meta.recipe_id) : null;
    if (!stored) throw new RpcError('preapproval_authority_changed', 'The gateway request has no saved entry recipe.', 403);
    entryToolGrants = [`${stored.publisher_id}/${meta.recipe_id}`];
  }
  return { ...(contractId ? { mode: 'contract' as const, contract_id: contractId }
    : { mode: 'owner' as const, owner_id: deps.ownerId }), source, entry: 'kernel',
    credential_id: credentialId ?? null, credential_label: credentialLabel ?? null,
    entry_tool_grants: entryToolGrants, entry_raw_op_id: raw ? operation : null,
    recipe_grant_key: meta.governing_recipe_grant ?? null,
    display_name: contractId ? deps.definitions.get(contractId)?.display_name ?? contractId : 'You' };
};
