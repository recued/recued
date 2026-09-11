/** D-196 R2 — fresh authority at the approval-resume effect boundary.
 *
 * A preflight checkpoint and its run anchor are durable evidence of what was
 * approved. They are not live authority: a bearer, Seller customer, tier,
 * contract, grant, route, or collection fence can change while the ask is
 * outstanding. This resolver re-reads those sources immediately before the
 * approved action is allowed to dispatch and returns a newly-built contract
 * snapshot. Any missing or unresolvable authority fails closed.
 */

import {
  KERNEL_OP_REGISTRY,
  MCP_INGREDIENT_TOOL_PREFIX,
  STDIO_MCP_TOKEN_ID,
  isGrantableKernelOp,
  executionSourceContractId,
  isCliIngredient,
  isMcpInboundTokenActive,
  isMcpInboundTokenToolAuthorized,
  type ContractSnapshot,
  type ExecutionSource,
  type McpInboundTokenRecord,
} from '@recued/contracts';

import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import type { ContractOverlayResolver } from './policy-contract-overlay.js';
import {
  evaluateSellerCustomerAccessAdmission,
  type SellerCustomerAccessAdmissionStore,
} from './seller/customer-access-admission.js';
import { resolveSellerCustomerUsagePolicy } from './seller/customer-usage-policy.js';
import type { ServerExecutorConfig } from './server-executor.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';

export type ApprovalResumeAuthorityDenyReason =
  | 'bearer_missing'
  | 'bearer_inactive'
  | 'bearer_kind_invalid'
  | 'bearer_binding_changed'
  | 'bearer_grant_revoked'
  | 'contract_grant_revoked'
  | 'contract_unavailable'
  | 'door_type_denied'
  | 'seller_access_denied'
  | 'seller_usage_policy_invalid'
  | 'route_unavailable'
  | 'unsupported_source'
  | 'authority_resolution_failed';

export interface ApprovalResumeAuthorityInput {
  readonly execution_source: ExecutionSource;
  /** One-of grant names that must still authorize the approved top-level call.
   * Raw-op resume passes exactly `recued_op_<op-id>`; recipe resume passes the
   * surface's current recipe grant name(s). Omission or an empty list denies
   * for a store-backed inbound bearer; owner stdio/CLI paths do not use it.
   * A Seller customer raw op uses `required_raw_op_id` + the live contract op
   * gate instead, matching the fresh MCP transport's authority split. */
  readonly required_bearer_tool_names?: ReadonlyArray<string>;
  /** Tier-P raw op id without the `recued_op_` prefix. Present only for a
   * recipe-less raw-op resume; customer-instance authority is keyed here. */
  readonly required_raw_op_id?: string;
}

export type ApprovalResumeAuthorityResult =
  | {
      readonly admitted: true;
      readonly execution_source: ExecutionSource;
      readonly contract_snapshot?: ContractSnapshot;
    }
  | {
      readonly admitted: false;
      readonly reason: ApprovalResumeAuthorityDenyReason;
      readonly detail: string;
    };

export interface ApprovalResumeAuthorityResolver {
  resolve(input: ApprovalResumeAuthorityInput): ApprovalResumeAuthorityResult;
}

export interface ApprovalResumeAuthorityResolverDeps {
  readonly manifests: ServerExecutorConfig['manifests'];
  readonly inboundTokenStore?: Pick<ChatInboundTokenStore, 'getTokenById'>;
  readonly clientTokens?: Pick<ClientTokenStore, 'get'>;
  readonly contractOverlay?: Pick<
    ContractOverlayResolver,
    | 'isContractLive'
    | 'permitsDoorType'
    | 'resolveBoundContractKind'
    | 'resolveContractScopeRestrictions'
  >;
  readonly sellerStore?: SellerCustomerAccessAdmissionStore;
  readonly opAdmissionGate?: Pick<OpAdmissionGate, 'isOpGranted'>;
  readonly cliReachableSlugsForPrincipal?: (
    principal: string,
  ) => ReadonlyArray<string>;
  /** Live Settings -> LLM route probe. Required for an llm_gateway source. */
  readonly isLlmGatewayRouteReady?: () => boolean;
  readonly now?: () => number;
}

const deny = (
  reason: ApprovalResumeAuthorityDenyReason,
  detail: string,
): ApprovalResumeAuthorityResult => ({ admitted: false, reason, detail });

export const llmGatewayTokenId = (source: ExecutionSource): string | null => {
  if (source.channel !== 'chat' || source.actor !== 'contracted_user') return null;
  const prefix = 'llm_gateway:';
  if (!source.chat_session_id.startsWith(prefix)) return null;
  const rest = source.chat_session_id.slice(prefix.length);
  const separator = rest.indexOf(':');
  const tokenId = separator < 0 ? rest : rest.slice(0, separator);
  return tokenId.length > 0 ? tokenId : null;
};

const currentAllowedTools = (
  deps: ApprovalResumeAuthorityResolverDeps,
  token: McpInboundTokenRecord,
  source: ExecutionSource,
  now: number,
): ReadonlyArray<string> => {
  const slugs = deps.manifests.slugs();
  const allowed = slugs.filter(
    (slug) =>
      isMcpInboundTokenToolAuthorized(token, slug, now)
      || isMcpInboundTokenToolAuthorized(
        token,
        `${MCP_INGREDIENT_TOOL_PREFIX}${slug}`,
        now,
      ),
  );
  // ── D-232 §§ 20.19 / 20.20 — PARITY WITH `buildMcpContractSnapshot` ──
  //
  // ⛔ THIS IS A SECOND, INDEPENDENT SNAPSHOT BUILDER. It rebuilds
  // `allowed_tools` from the token at RESUME time, so anything the dispatch-time
  // builder admits and this one does not becomes a rule that holds until the
  // owner approves and then stops holding — the worst shape a gate can have,
  // because the denial lands after the human said yes. Two unions were missing:
  //   § 20.20 — the backing slugs of granted kernel OPS, without which an
  //     approved `core.data.calendar.list` step resumes into
  //     `tool_not_in_contract`. Mirrors the dispatch-time union exactly,
  //     including its bound: inside the loaded manifest set, and only EXPLICIT
  //     token grants count (never author defaults).
  //
  // § 20.19's granted-recipe NAMES are deliberately NOT unioned here. That
  // coverage rides the resumed run directly (`ExecuteInternal.granted_by_recipe`,
  // re-threaded from the anchor), which is both more precise — it is the grant
  // that ACTUALLY applied, not every grant the door happens to hold — and
  // available for a host-dispatched carrier, whose own recipe name is
  // structurally ungrantable and so could never appear in any snapshot.
  // `requiredResumeBearerToolNames` re-verifies that exact name is still held
  // before this resolver is consulted, so the anchor is not trusted blindly.
  for (const entry of KERNEL_OP_REGISTRY) {
    const backing = entry.backing_slug;
    if (backing === undefined || !slugs.includes(backing)) continue;
    if (allowed.includes(backing)) continue;
    if (!isGrantableKernelOp(entry.op)) continue;
    if (isMcpInboundTokenToolAuthorized(token, entry.op, now)) allowed.push(backing);
  }
  const principal = executionSourceContractId(source);
  if (deps.cliReachableSlugsForPrincipal && principal && principal.length > 0) {
    let reachable: ReadonlyArray<string> = [];
    try {
      reachable = deps.cliReachableSlugsForPrincipal(principal);
    } catch {
      // A failed CLI grant read can only narrow the snapshot. The exact CLI op
      // gate will also fail closed later, so do not preserve stale CLI grants.
    }
    for (const slug of reachable) {
      if (
        !allowed.includes(slug)
        && slugs.includes(slug)
        && isCliIngredient(deps.manifests.get(slug))
      ) {
        allowed.push(slug);
      }
    }
  }
  return allowed;
};

const snapshot = (
  deps: ApprovalResumeAuthorityResolverDeps,
  source: ExecutionSource,
  allowedTools: ReadonlyArray<string>,
  now: number,
): ContractSnapshot => {
  const contractId = executionSourceContractId(source);
  if (contractId === undefined) {
    throw new Error('cannot build a contract snapshot for a contract-free source');
  }
  const scopeRestrictions =
    deps.contractOverlay?.resolveContractScopeRestrictions?.(source) ?? [];
  return buildVersionedContractSnapshot({
    contract_id: contractId,
    allowed_tools: allowedTools,
    approval_required: [],
    scope_restrictions: scopeRestrictions,
    resolved_at: now,
  });
};

const requiredGrantAdmitted = (
  token: McpInboundTokenRecord,
  names: ReadonlyArray<string> | undefined,
  now: number,
): boolean => {
  return names !== undefined
    && names.length > 0
    && names.some((name) => isMcpInboundTokenToolAuthorized(token, name, now));
};

const admitBoundInboundToken = (
  deps: ApprovalResumeAuthorityResolverDeps,
  input: ApprovalResumeAuthorityInput,
  token: McpInboundTokenRecord,
  doorType: 'mcp' | 'llm_gateway',
  now: number,
): ApprovalResumeAuthorityResult => {
  const source = input.execution_source;
  const sourceContractId = executionSourceContractId(source);
  const contractId = token.contract_id;
  let boundContractKind: 'standing' | 'customer_instance' | undefined;
  const expectedContractId = contractId ?? token.token_id;
  if (sourceContractId !== expectedContractId) {
    return deny(
      'bearer_binding_changed',
      `bearer '${token.token_id}' now binds '${expectedContractId}', not the approved '${sourceContractId ?? '<none>'}'`,
    );
  }
  if (contractId !== undefined) {
    const overlay = deps.contractOverlay;
    if (!overlay || overlay.isContractLive(contractId) !== true) {
      return deny(
        'contract_unavailable',
        `bound contract '${contractId}' is missing, inactive, expired, exhausted, or unreadable`,
      );
    }
    if ((overlay.permitsDoorType?.(contractId, doorType) ?? true) !== true) {
      return deny(
        'door_type_denied',
        `bound contract '${contractId}' no longer permits the '${doorType}' door`,
      );
    }
    const kind = overlay.resolveBoundContractKind
      ? overlay.resolveBoundContractKind(contractId) ?? null
      : null;
    if (kind !== null) boundContractKind = kind;
    const sellerAdmission = evaluateSellerCustomerAccessAdmission({
      ...(deps.sellerStore ? { sellerStore: deps.sellerStore } : {}),
      token,
      now,
      contractKind: kind,
    });
    if (sellerAdmission.applies && !sellerAdmission.admitted) {
      return deny(
        'seller_access_denied',
        `Seller customer access denied (${sellerAdmission.reason})`,
      );
    }
    if (sellerAdmission.applies && sellerAdmission.admitted) {
      const usagePolicy = resolveSellerCustomerUsagePolicy(
        sellerAdmission.tier,
        'tool_call',
      );
      if (!usagePolicy.ok) {
        return deny(
          'seller_usage_policy_invalid',
          `Seller tool_call usage policy is invalid (${usagePolicy.message})`,
        );
      }
    }
  }

  // Fresh MCP dispatch deliberately has two raw-op grant authorities:
  // customer instances use their self-contained contract op matrix, while
  // ordinary/unbound doors use the inbound-token checklist. Reproduce that
  // split exactly. The raw dispatcher still applies its declared-operation
  // gate later, so both the Tier-P wire op and backing catalog op stay live.
  // § 234.4p.16e — a RAW OP re-presents against the CONTRACT at every door, not
  // only a D-196 customer instance.
  //
  // ⛔⛔ THIS WAS THE FOURTH ENFORCEMENT POINT AND ONLY A DRIVE FOUND IT. The
  // enumeration and both dispatch gates were widened in `mcp-server.ts`; reading
  // their call sites found three. This one lives in another file under another
  // predicate, so an ordinary door's resume still fell to
  // `requiredGrantAdmitted` — the per-token CHECKLIST, which can never contain a
  // `recued_op_*` name because `chat.inbound_token.issue` refuses to write one.
  // The visible effect was a held call the owner APPROVED and that then failed
  // terminal with "bearer no longer grants the approved top-level tool": a
  // denial phrased as revocation for a grant that was never expressible.
  // ⇒ Count enforcement points by driving PAST an approval, never by reading.
  //
  // ⚠ The owner is unaffected: `isOpGranted` returns true when no governing
  // contract gates the op, so a contract-free / unbound resume still admits.
  if (input.required_raw_op_id !== undefined) {
    if (
      input.required_raw_op_id.length === 0
      || deps.opAdmissionGate?.isOpGranted(source, input.required_raw_op_id) !== true
    ) {
      return deny(
        'contract_grant_revoked',
        boundContractKind === 'customer_instance'
          ? `customer contract '${contractId}' no longer grants raw op '${input.required_raw_op_id}'`
          : `contract '${contractId}' no longer grants raw op '${input.required_raw_op_id}'`,
      );
    }
  } else if (!requiredGrantAdmitted(token, input.required_bearer_tool_names, now)) {
    return deny(
      'bearer_grant_revoked',
      `bearer '${token.token_id}' no longer grants the approved top-level tool`,
    );
  }

  if (
    doorType === 'llm_gateway'
    && (() => {
      try {
        return deps.isLlmGatewayRouteReady?.() === true;
      } catch {
        return false;
      }
    })() !== true
  ) {
    return deny(
      'route_unavailable',
      'the current Settings -> LLM gateway route is missing or unavailable',
    );
  }

  return {
    admitted: true,
    execution_source: source,
    contract_snapshot: snapshot(
      deps,
      source,
      currentAllowedTools(deps, token, source, now),
      now,
    ),
  };
};

/** Build the production resume resolver. Store and overlay reads are sync today;
 * the outer catch deliberately converts every unexpected read/shape failure to
 * a denial so an approval can never turn an authority outage into a dispatch. */
export const createApprovalResumeAuthorityResolver = (
  deps: ApprovalResumeAuthorityResolverDeps,
): ApprovalResumeAuthorityResolver => ({
  resolve(input) {
    try {
      const source = input.execution_source;
      const now = (deps.now ?? Date.now)();

      if (source.channel === 'mcp') {
        if (source.mcp_token_id === STDIO_MCP_TOKEN_ID) {
          return {
            admitted: true,
            execution_source: source,
            contract_snapshot: snapshot(deps, source, deps.manifests.slugs(), now),
          };
        }

        const inbound = deps.inboundTokenStore?.getTokenById(source.mcp_token_id) ?? null;
        if (inbound) {
          if (!isMcpInboundTokenActive(inbound, now)) {
            return deny(
              'bearer_inactive',
              `inbound bearer '${source.mcp_token_id}' is revoked or expired`,
            );
          }
          return admitBoundInboundToken(deps, input, inbound, 'mcp', now);
        }

        const client = deps.clientTokens?.get(source.mcp_token_id) ?? null;
        if (!client) {
          return deny(
            'bearer_missing',
            `bearer '${source.mcp_token_id}' no longer exists`,
          );
        }
        if (client.revoked_at !== null) {
          return deny(
            'bearer_inactive',
            `client bearer '${source.mcp_token_id}' is revoked`,
          );
        }
        if (client.client_kind !== 'cli') {
          return deny(
            'bearer_kind_invalid',
            `client bearer '${source.mcp_token_id}' is '${client.client_kind}', not 'cli'`,
          );
        }
        if (source.contract_id !== client.token_id) {
          return deny(
            'bearer_binding_changed',
            `CLI bearer '${client.token_id}' does not match approved contract '${source.contract_id}'`,
          );
        }
        return {
          admitted: true,
          execution_source: source,
          contract_snapshot: snapshot(deps, source, deps.manifests.slugs(), now),
        };
      }

      const llmTokenId = llmGatewayTokenId(source);
      if (llmTokenId !== null) {
        const inbound = deps.inboundTokenStore?.getTokenById(llmTokenId) ?? null;
        if (!inbound) {
          return deny('bearer_missing', `llm_gateway bearer '${llmTokenId}' no longer exists`);
        }
        if (!isMcpInboundTokenActive(inbound, now)) {
          return deny(
            'bearer_inactive',
            `llm_gateway bearer '${llmTokenId}' is revoked or expired`,
          );
        }
        if (inbound.contract_id === undefined) {
          return deny(
            'bearer_binding_changed',
            `llm_gateway bearer '${llmTokenId}' is no longer contract-bound`,
          );
        }
        return admitBoundInboundToken(deps, input, inbound, 'llm_gateway', now);
      }

      if (executionSourceContractId(source) !== undefined) {
        return deny(
          'unsupported_source',
          `no live bearer resolver exists for approval source '${source.channel}/${source.actor}'`,
        );
      }
      return { admitted: true, execution_source: source };
    } catch (error) {
      return deny(
        'authority_resolution_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});
