/** D-196 Seller Economy - source-qualified customer access lifecycle core.
 *
 *  This is the reusable substrate behind the future `customer-access-*` kernel
 *  ops. It keeps D-196's one-contract-table invariant: a tier points at a
 *  `grant_kind: 'customer_template'` contract, while issue/swap stamps a
 *  self-contained `grant_kind: 'customer_instance'` contract and binds the
 *  existing inbound-token substrate to that instance.
 */

import {
  CONTRACT_DEFINITION_SCOPE,
  type ConvergentWriteResult,
  isContractActive,
  type ContractDefinition,
  type IssuedMcpInboundToken,
  SELLER_CUSTOMER_CLOSE_REASONS,
  type SellerCustomerCloseReason,
  type SellerCustomer,
  type SellerLifecycleSource,
  type SellerTier,
} from '@recued/contracts';
import { randomUUID } from 'node:crypto';

import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import type {
  SellerClaimPayload,
  SellerClaimStore,
  SellerIssuedClaim,
} from '../storage/seller-claim-store.js';
import { resolveSellerSourceStatusPolicyAction } from './customer-access-admission.js';
import {
  SellerStoreConflictError,
  type SellerStore,
} from '../storage/seller-store.js';

export class SellerCustomerAccessError extends Error {
  constructor(detail: string) {
    super(`seller_customer_access_invalid: ${detail}`);
    this.name = 'SellerCustomerAccessError';
  }
}

export interface SellerCustomerAccessLifecycleDeps {
  readonly sellerStore: SellerStore;
  readonly contractStore: ContractStore;
  readonly grantEntryStore: ContractGrantEntryStore;
  readonly inboundTokenStore: ChatInboundTokenStore;
  readonly mintedBy: string;
  readonly now?: () => number;
  readonly newContractId?: () => string;
  readonly newCustomerId?: () => string;
  /** Optional one-time delivery envelope. The store alone is enough to revoke
   *  outstanding claims on close. Token-issuing operations need both the store
   *  and payload builder; production seller RPCs require that pair. */
  readonly sellerClaimStore?: SellerClaimStore;
  readonly buildClaimPayload?: (input: {
    readonly bearer_plaintext: string;
    readonly contract: ContractDefinition;
  }) => SellerClaimPayload;
  readonly requireClaimOnTokenIssue?: boolean;
  /** Optional shared transaction wrapper. When every store is backed by the same
   *  better-sqlite3 connection, `ContractStore.transaction` makes the multi-row
   *  lifecycle change atomic across seller rows, contract rows, grant rows, and
   *  inbound-token rows. */
  readonly transaction?: (fn: () => void) => void;
}

export interface SellerCustomerAccessIssueInput {
  readonly lifecycle_source: SellerLifecycleSource;
  readonly door_id: string;
  readonly source_customer_id: string;
  readonly entitlement_key: string;
  readonly email?: string | null;
  readonly current_period_end?: number | null;
  readonly source_status?: string | null;
  readonly external_subscription_id?: string | null;
}

export interface SellerCustomerAccessIssueResult {
  /** The convergent-write branch — derived from the contracts type, NOT a
   *  second hand-kept copy of the union (a copied vocabulary rots: a subset
   *  typechecks). See `contracts/src/convergent-write.ts` for the pattern +
   *  the refuse-on-identity-change rule this op enforces below. */
  readonly result: ConvergentWriteResult;
  readonly customer: SellerCustomer;
  /** Present only when `result === 'created'`. */
  readonly issued_token: IssuedMcpInboundToken | null;
  /** Present only when a one-time claim store is wired. */
  readonly issued_claim: SellerIssuedClaim | null;
}

export interface SellerCustomerAccessTargetInput {
  readonly customer_id?: string;
  readonly lifecycle_source?: SellerLifecycleSource;
  readonly door_id?: string;
  readonly source_customer_id?: string;
}

export interface SellerCustomerAccessExtendInput extends SellerCustomerAccessTargetInput {
  readonly current_period_end?: number | null;
  readonly source_status?: string | null;
  readonly email?: string | null;
}

export interface SellerCustomerAccessSwapTierInput extends SellerCustomerAccessTargetInput {
  readonly entitlement_key: string;
  readonly current_period_end?: number | null;
  readonly source_status?: string | null;
}

export interface SellerCustomerAccessCloseInput extends SellerCustomerAccessTargetInput {
  readonly reason: SellerCustomerCloseReason;
  readonly source_status?: string | null;
}

export interface SellerCustomerAccessReissueTokenInput
  extends SellerCustomerAccessTargetInput {}

export interface SellerCustomerAccessReissueTokenResult {
  readonly customer: SellerCustomer;
  readonly issued_token: IssuedMcpInboundToken;
  readonly issued_claim: SellerIssuedClaim | null;
}

export interface SellerCustomerAccessBulkAdjustTierInput {
  readonly lifecycle_source: SellerLifecycleSource;
  readonly tier_id: string;
  readonly customer_ids?: readonly string[];
}

export interface SellerCustomerAccessBulkAdjustTierResult {
  readonly tier: SellerTier;
  readonly adjusted_customers: readonly SellerCustomer[];
  readonly skipped_closed_customers: readonly SellerCustomer[];
}

export interface SellerCustomerAccessLifecycle {
  issueCustomer(input: SellerCustomerAccessIssueInput): SellerCustomerAccessIssueResult;
  extendCustomer(input: SellerCustomerAccessExtendInput): SellerCustomer;
  swapCustomerTier(input: SellerCustomerAccessSwapTierInput): SellerCustomer;
  closeCustomer(input: SellerCustomerAccessCloseInput): SellerCustomer;
  reissueCustomerToken(
    input: SellerCustomerAccessReissueTokenInput,
  ): SellerCustomerAccessReissueTokenResult;
  bulkAdjustTierCustomers(
    input: SellerCustomerAccessBulkAdjustTierInput,
  ): SellerCustomerAccessBulkAdjustTierResult;
}

const HOURS_TO_MS = 60 * 60 * 1000;

const clean = (value: string, field: string): string => {
  const out = value.trim();
  if (out.length === 0) {
    throw new SellerCustomerAccessError(`${field} must be a non-empty string`);
  }
  return out;
};

const ensurePeriod = (value: number | null | undefined, field: string): number | null | undefined => {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || value < 0) {
    throw new SellerCustomerAccessError(`${field} must be a non-negative integer`);
  }
  return value;
};

const cleanCloseReason = (value: string): SellerCustomerCloseReason => {
  const reason = clean(value, 'reason');
  if (!(SELLER_CUSTOMER_CLOSE_REASONS as readonly string[]).includes(reason)) {
    throw new SellerCustomerAccessError(`unknown close reason '${reason}'`);
  }
  return reason as SellerCustomerCloseReason;
};

const runAtomic = <T>(
  transaction: ((fn: () => void) => void) | undefined,
  fn: () => T,
): T => {
  let result: T | undefined;
  if (transaction) {
    transaction(() => {
      result = fn();
    });
  } else {
    result = fn();
  }
  return result as T;
};

const rejectCallerTokenAuthority = (
  input: object,
  operation: 'issue' | 'reissueCustomerToken',
): void => {
  for (const field of [
    'token_grants',
    'token_label',
    'token_expires_at',
    'token_concurrency_tier',
    'token_chat_mode',
  ]) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new SellerCustomerAccessError(
        `${operation} derives ${field} server-side and must not accept it from a caller`,
      );
    }
  }
};

export const createSellerCustomerAccessLifecycle = (
  deps: SellerCustomerAccessLifecycleDeps,
): SellerCustomerAccessLifecycle => {
  const now = deps.now ?? (() => Date.now());
  const newContractId = deps.newContractId ?? (() => `ct_customer_${randomUUID()}`);
  const newCustomerId = deps.newCustomerId ?? (() => `seller_customer_${randomUUID()}`);

  const issueClaim = (input: {
    readonly customer: SellerCustomer;
    readonly contract: ContractDefinition;
    readonly issued_token: IssuedMcpInboundToken;
    readonly now: number;
  }): SellerIssuedClaim | null => {
    if (!deps.sellerClaimStore || !deps.buildClaimPayload) {
      if (deps.requireClaimOnTokenIssue === true) {
        throw new SellerCustomerAccessError(
          'one-time customer claim delivery is not configured',
        );
      }
      return null;
    }
    const issuedClaim = deps.sellerClaimStore.issue({
      customer_id: input.customer.customer_id,
      contract_id: input.contract.contract_id,
      payload: deps.buildClaimPayload({
        bearer_plaintext: input.issued_token.bearer_plaintext,
        contract: input.contract,
      }),
      now: input.now,
    });
    // Keep this invariant inside the lifecycle transaction. A faulty/out-of-
    // tree store that violates its non-null return contract must roll back the
    // customer contract, bearer, and seller row instead of surfacing a failure
    // after those effects have committed.
    if (issuedClaim === null || issuedClaim === undefined) {
      if (deps.requireClaimOnTokenIssue === true) {
        throw new SellerCustomerAccessError(
          'one-time customer claim delivery is not configured',
        );
      }
      return null;
    }
    return issuedClaim;
  };

  const contractDefinition = (contract_id: string): ContractDefinition | null => {
    const row = deps.contractStore.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
    return row ? (row.value as ContractDefinition) : null;
  };

  const requireTier = (
    lifecycle_source: SellerLifecycleSource,
    door_id: string,
    entitlement_key: string,
    opts?: { readonly requireActive?: boolean },
  ) => {
    const tier = deps.sellerStore.findTier({ lifecycle_source, door_id, entitlement_key });
    if (!tier) {
      throw new SellerCustomerAccessError(
        `tier not found for ${lifecycle_source}/${door_id}/${entitlement_key}`,
      );
    }
    if ((opts?.requireActive ?? true) && !tier.active) {
      throw new SellerCustomerAccessError(`tier '${tier.tier_id}' is inactive`);
    }
    return tier;
  };

  const requireTemplate = (template_contract_id: string): ContractDefinition => {
    const template = contractDefinition(template_contract_id);
    if (!template) {
      throw new SellerCustomerAccessError(
        `template_contract_id '${template_contract_id}' was not found`,
      );
    }
    if (template.grant_kind !== 'customer_template') {
      throw new SellerCustomerAccessError(
        `template_contract_id '${template_contract_id}' must be a customer_template`,
      );
    }
    if (!isContractActive(template, now())) {
      throw new SellerCustomerAccessError(
        `template_contract_id '${template_contract_id}' is not active`,
      );
    }
    return template;
  };

  const requireTierById = (
    tier_id: string,
    lifecycle_source: SellerLifecycleSource,
  ): SellerTier => {
    const tier = deps.sellerStore.getTier(clean(tier_id, 'tier_id'));
    if (!tier) {
      throw new SellerCustomerAccessError(`tier '${tier_id}' was not found`);
    }
    if (tier.lifecycle_source !== lifecycle_source) {
      throw new SellerCustomerAccessError(
        `tier '${tier.tier_id}' does not match lifecycle_source '${lifecycle_source}'`,
      );
    }
    return tier;
  };

  const requireCustomerContract = (contract_id: string): ContractDefinition => {
    const contract = contractDefinition(contract_id);
    if (!contract) {
      throw new SellerCustomerAccessError(
        `customer contract_id '${contract_id}' was not found`,
      );
    }
    if (contract.grant_kind !== 'customer_instance') {
      throw new SellerCustomerAccessError(
        `customer contract_id '${contract_id}' must be a customer_instance`,
      );
    }
    if (!isContractActive(contract, now())) {
      throw new SellerCustomerAccessError(
        `customer contract_id '${contract_id}' is not active`,
      );
    }
    return contract;
  };

  const stampCustomerContract = (
    template: ContractDefinition,
    input: {
      readonly contract_id: string;
      readonly display_name: string;
      readonly existing?: ContractDefinition | null;
    },
  ): ContractDefinition => {
    const existing = input.existing ?? contractDefinition(input.contract_id);
    const def: ContractDefinition = {
      contract_id: input.contract_id,
      minted_at: existing?.minted_at ?? now(),
      minted_by: existing?.minted_by ?? deps.mintedBy,
      display_name: input.display_name,
      scope: template.scope,
      grant_kind: 'customer_instance',
      ...(template.door_types !== undefined ? { door_types: [...template.door_types] } : {}),
      ...(template.approved_actions_template !== undefined
        ? { approved_actions_template: template.approved_actions_template }
        : {}),
    };
    deps.contractStore.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], def);

    for (const row of deps.grantEntryStore.listForContract(def.contract_id)) {
      deps.grantEntryStore.clear(def.contract_id, row.entry_key);
    }
    for (const row of deps.grantEntryStore.listForContract(template.contract_id)) {
      deps.grantEntryStore.set(def.contract_id, row.entry_key, row.granted, now());
    }

    return def;
  };

  const grantMapForContract = (contract_id: string): Readonly<Record<string, boolean>> => {
    const out: Record<string, boolean> = {};
    for (const row of deps.grantEntryStore.listForContract(contract_id)) {
      out[row.entry_key] = row.granted;
    }
    return out;
  };

  const grantMapForTemplate = (
    template: ContractDefinition,
  ): Readonly<Record<string, boolean>> => grantMapForContract(template.contract_id);

  const revokeContract = (contract_id: string, reason: string): void => {
    const def = contractDefinition(contract_id);
    if (!def) return;
    if (def.revoked_at !== undefined && def.revoked_at !== null) return;
    deps.contractStore.put(CONTRACT_DEFINITION_SCOPE, [contract_id], {
      ...def,
      revoked_at: now(),
      revocation_reason: reason,
    } satisfies ContractDefinition);
  };

  const peerHandle = (
    lifecycle_source: SellerLifecycleSource,
    source_customer_id: string,
    door_id: string,
  ): string => `seller:${lifecycle_source}:${door_id}:${source_customer_id}`;

  const graceUntil = (period_end: number | null): number | null => {
    if (period_end === null) return null;
    const settings = deps.sellerStore.getSettings();
    return period_end + settings.default_grace_hours * HOURS_TO_MS;
  };

  const periodForIssue = (
    lifecycle_source: SellerLifecycleSource,
    current_period_end: number | null | undefined,
    pass_duration_seconds: number | null,
  ): number | null => {
    const explicit = ensurePeriod(current_period_end, 'current_period_end');
    const period_end = explicit !== undefined
      ? explicit
      : pass_duration_seconds !== null
        ? now() + pass_duration_seconds * 1000
        : null;
    if (lifecycle_source !== 'manual' && period_end === null) {
      throw new SellerCustomerAccessError(
        `current_period_end must be finite for non-manual lifecycle_source '${lifecycle_source}'`,
      );
    }
    return period_end;
  };

  const periodForUpdate = (
    existing: SellerCustomer,
    current_period_end: number | null | undefined,
  ): { current_period_end: number | null; grace_until: number | null } => {
    const explicit = ensurePeriod(current_period_end, 'current_period_end');
    if (explicit === undefined) {
      if (existing.lifecycle_source !== 'manual' && existing.current_period_end === null) {
        throw new SellerCustomerAccessError(
          `current_period_end must be finite for non-manual lifecycle_source '${existing.lifecycle_source}'`,
        );
      }
      return {
        current_period_end: existing.current_period_end,
        grace_until: existing.grace_until,
      };
    }
    if (explicit === null) {
      if (existing.lifecycle_source !== 'manual') {
        throw new SellerCustomerAccessError(
          `current_period_end must be finite for non-manual lifecycle_source '${existing.lifecycle_source}'`,
        );
      }
      return { current_period_end: null, grace_until: null };
    }
    if (existing.current_period_end !== null && existing.current_period_end >= explicit) {
      return {
        current_period_end: existing.current_period_end,
        grace_until: existing.grace_until,
      };
    }
    return { current_period_end: explicit, grace_until: graceUntil(explicit) };
  };

  const assertTargetMatchesCustomer = (
    input: SellerCustomerAccessTargetInput,
    customer: SellerCustomer,
  ): void => {
    if (
      input.lifecycle_source !== undefined
      && input.lifecycle_source !== customer.lifecycle_source
    ) {
      throw new SellerCustomerAccessError(
        `customer_id '${customer.customer_id}' does not match lifecycle_source '${input.lifecycle_source}'`,
      );
    }
    if (
      input.source_customer_id !== undefined
      && clean(input.source_customer_id, 'source_customer_id') !== customer.source_customer_id
    ) {
      throw new SellerCustomerAccessError(
        `customer_id '${customer.customer_id}' does not match source_customer_id '${input.source_customer_id}'`,
      );
    }
    if (input.door_id !== undefined && clean(input.door_id, 'door_id') !== customer.door_id) {
      throw new SellerCustomerAccessError(
        `customer_id '${customer.customer_id}' does not match door_id '${input.door_id}'`,
      );
    }
  };

  const findCustomer = (input: SellerCustomerAccessTargetInput): SellerCustomer => {
    if (input.customer_id !== undefined) {
      const customer_id = clean(input.customer_id, 'customer_id');
      const customer = deps.sellerStore.getCustomer(customer_id);
      if (!customer) {
        throw new SellerCustomerAccessError(`customer not found for customer_id '${customer_id}'`);
      }
      assertTargetMatchesCustomer(input, customer);
      return customer;
    }
    if (
      input.lifecycle_source === undefined
      || input.source_customer_id === undefined
      || input.door_id === undefined
    ) {
      throw new SellerCustomerAccessError(
        'customer target requires customer_id or lifecycle_source/source_customer_id/door_id',
      );
    }
    const customer = deps.sellerStore.findCustomerBySource({
      lifecycle_source: input.lifecycle_source,
      source_customer_id: clean(input.source_customer_id, 'source_customer_id'),
      door_id: clean(input.door_id, 'door_id'),
    });
    if (!customer) {
      throw new SellerCustomerAccessError(
        `customer not found for ${input.lifecycle_source}/${input.door_id}/${input.source_customer_id}`,
      );
    }
    return customer;
  };

  const requireOpenCustomer = (customer: SellerCustomer, operation: string): void => {
    if (customer.access_state === 'closed') {
      throw new SellerCustomerAccessError(
        `${operation} cannot modify closed customer '${customer.customer_id}'`,
      );
    }
  };

  const extendExistingCustomer = (input: SellerCustomerAccessExtendInput): SellerCustomer => {
    const existing = findCustomer(input);
    requireOpenCustomer(existing, 'extend');
    const period = periodForUpdate(existing, input.current_period_end);
    return runAtomic(deps.transaction, () =>
      deps.sellerStore.upsertCustomer({
        customer_id: existing.customer_id,
        lifecycle_source: existing.lifecycle_source,
        source_customer_id: existing.source_customer_id,
        door_id: existing.door_id,
        email: input.email,
        tier_id: existing.tier_id,
        contract_id: existing.contract_id,
        source_status: input.source_status,
        current_period_end: period.current_period_end,
        grace_until: period.grace_until,
        access_state: 'active',
        now: now(),
      }));
  };

  const restampCustomerFromTierTemplate = (
    existing: SellerCustomer,
    tier: SellerTier,
    template: ContractDefinition,
  ): SellerCustomer => {
    requireCustomerContract(existing.contract_id);
    stampCustomerContract(template, {
      contract_id: existing.contract_id,
      display_name: `${tier.display_name} customer ${existing.source_customer_id}`,
    });
    const grants = grantMapForTemplate(template);
    const tokenIds = new Set(
      [existing.inbound_token_id, existing.mcp_token_id].filter(
        (token_id): token_id is string => token_id !== null,
      ),
    );
    for (const token_id of tokenIds) {
      const updated = deps.inboundTokenStore.updateTokenGrants({
        token_id,
        grants,
        now: now(),
      });
      if (!updated) {
        throw new SellerCustomerAccessError(
          `inbound token '${token_id}' was not found`,
        );
      }
    }
    return deps.sellerStore.upsertCustomer({
      customer_id: existing.customer_id,
      lifecycle_source: existing.lifecycle_source,
      source_customer_id: existing.source_customer_id,
      door_id: existing.door_id,
      tier_id: existing.tier_id,
      contract_id: existing.contract_id,
      access_state: existing.access_state,
      now: now(),
    });
  };

  return {
    issueCustomer(input) {
      rejectCallerTokenAuthority(input, 'issue');
      if (Object.prototype.hasOwnProperty.call(input, 'customer_id')) {
        throw new SellerCustomerAccessError(
          'customer_id is server-generated and must not be supplied on issue',
        );
      }
      const lifecycle_source = input.lifecycle_source;
      const door_id = clean(input.door_id, 'door_id');
      const source_customer_id = clean(input.source_customer_id, 'source_customer_id');
      const entitlement_key = clean(input.entitlement_key, 'entitlement_key');
      const tier = requireTier(lifecycle_source, door_id, entitlement_key, {
        requireActive: false,
      });
      const existing = deps.sellerStore.findCustomerBySource({
        lifecycle_source,
        source_customer_id,
        door_id,
      });

      if (existing) {
        if (existing.tier_id !== tier.tier_id) {
          throw new SellerCustomerAccessError(
            'issue cannot change an existing customer tier; use swapCustomerTier',
          );
        }
        const period_end = periodForIssue(
          lifecycle_source,
          input.current_period_end,
          tier.pass_duration_seconds,
        );
        return {
          result: 'extended',
          customer: extendExistingCustomer({
            lifecycle_source,
            source_customer_id,
            door_id,
            current_period_end: period_end,
            source_status: input.source_status,
            email: input.email,
          }),
          issued_token: null,
          issued_claim: null,
        };
      }

      if (!tier.active) {
        throw new SellerCustomerAccessError(`tier '${tier.tier_id}' is inactive`);
      }
      const template = requireTemplate(tier.template_contract_id);
      const period_end = periodForIssue(
        lifecycle_source,
        input.current_period_end,
        tier.pass_duration_seconds,
      );
      return runAtomic(deps.transaction, () => {
        const customer_id = clean(newCustomerId(), 'generated customer_id');
        const idConflict = deps.sellerStore.getCustomer(customer_id);
        if (idConflict) {
          throw new SellerStoreConflictError(
            `generated customer_id '${customer_id}' is already bound to `
              + `${idConflict.lifecycle_source}/${idConflict.door_id}`
              + `/${idConflict.source_customer_id}`,
          );
        }
        const contract_id = clean(newContractId(), 'generated contract_id');
        if (
          contractDefinition(contract_id)
          || deps.sellerStore.listCustomers({ contract_id }).length > 0
        ) {
          throw new SellerStoreConflictError(
            `generated contract_id '${contract_id}' is already in use`,
          );
        }
        const contract = stampCustomerContract(template, {
          contract_id,
          display_name: `${tier.display_name} customer ${source_customer_id}`,
        });
        const issued_token = deps.inboundTokenStore.issueToken({
          value: {
            label: `${tier.display_name} customer token`,
            peer_handle: peerHandle(lifecycle_source, source_customer_id, door_id),
            grants: grantMapForContract(contract.contract_id),
            concurrency_tier: 3,
            chat_mode: null,
            contract_id: contract.contract_id,
          },
          now: now(),
        });
        const customer = deps.sellerStore.upsertCustomer({
          customer_id,
          lifecycle_source,
          source_customer_id,
          door_id,
          email: input.email,
          tier_id: tier.tier_id,
          contract_id: contract.contract_id,
          inbound_token_id: issued_token.record.token_id,
          mcp_token_id: issued_token.record.token_id,
          external_subscription_id: input.external_subscription_id,
          source_status: input.source_status,
          current_period_end: period_end,
          grace_until: graceUntil(period_end),
          access_state: 'active',
          now: now(),
        });
        const issued_claim = issueClaim({
          customer,
          contract,
          issued_token,
          now: now(),
        });
        return { result: 'created', customer, issued_token, issued_claim };
      });
    },

    extendCustomer(input) {
      return extendExistingCustomer(input);
    },

    swapCustomerTier(input) {
      const existing = findCustomer(input);
      requireOpenCustomer(existing, 'swapCustomerTier');
      requireCustomerContract(existing.contract_id);
      const tier = requireTier(
        existing.lifecycle_source,
        existing.door_id,
        clean(input.entitlement_key, 'entitlement_key'),
      );
      // A swap to the tier already held is not a tier move, and re-stamping for
      // one is destructive: it clears the customer contract's grant entries back
      // to the template (dropping per-customer `contract.grant.write` edits) and
      // forces `access_state: 'active'`, which would silently cancel a grace
      // period a payment-failure close had just opened. The reconciler never
      // reaches here — it guards on `provider.tier_id !== local.tier_id` before
      // dispatching — but an event-driven caller cannot read local tier state to
      // make that comparison itself, so the op owns it. Period and status moves
      // are `extendCustomer`'s job, not a no-op swap's.
      // Guards above stay armed: a closed customer, a revoked contract, or a
      // tier that is not on this door still throws.
      if (tier.tier_id === existing.tier_id) return existing;
      const template = requireTemplate(tier.template_contract_id);
      const period = periodForUpdate(existing, input.current_period_end);
      return runAtomic(deps.transaction, () => {
        stampCustomerContract(template, {
          contract_id: existing.contract_id,
          display_name: `${tier.display_name} customer ${existing.source_customer_id}`,
        });
        const tokenIds = new Set(
          [existing.inbound_token_id, existing.mcp_token_id].filter(
            (token_id): token_id is string => token_id !== null,
          ),
        );
        for (const token_id of tokenIds) {
          const updated = deps.inboundTokenStore.updateTokenGrants({
            token_id,
            grants: grantMapForTemplate(template),
            now: now(),
          });
          if (!updated) {
            throw new SellerCustomerAccessError(
              `inbound token '${token_id}' was not found`,
            );
          }
        }
        return deps.sellerStore.upsertCustomer({
          customer_id: existing.customer_id,
          lifecycle_source: existing.lifecycle_source,
          source_customer_id: existing.source_customer_id,
          door_id: existing.door_id,
          tier_id: tier.tier_id,
          contract_id: existing.contract_id,
          source_status: input.source_status,
          current_period_end: period.current_period_end,
          grace_until: period.grace_until,
          access_state: 'active',
          now: now(),
        });
      });
    },

    closeCustomer(input) {
      const existing = findCustomer(input);
      const reason = cleanCloseReason(input.reason);
      const source_status = input.source_status?.trim() ? input.source_status : reason;
      // A status policy can prevent a not-yet-closed transition from revoking
      // authority; it cannot resurrect a bearer/contract already revoked by a
      // prior close. Preserve the old idempotent-close behavior in that case.
      const policyAction = existing.access_state === 'closed'
        || existing.lifecycle_source === 'manual'
        ? 'close_now'
        : resolveSellerSourceStatusPolicyAction(
          deps.sellerStore.getSettings(),
          {
            lifecycle_source: existing.lifecycle_source,
            source_status: input.source_status?.trim() ? input.source_status : null,
            current_period_end: existing.current_period_end,
          },
          reason,
        ) ?? 'close_now';
      return runAtomic(deps.transaction, () => {
        if (policyAction === 'keep_active') {
          return deps.sellerStore.upsertCustomer({
            customer_id: existing.customer_id,
            lifecycle_source: existing.lifecycle_source,
            source_customer_id: existing.source_customer_id,
            door_id: existing.door_id,
            tier_id: existing.tier_id,
            contract_id: existing.contract_id,
            source_status,
            grace_until: null,
            access_state: 'active',
            now: now(),
          });
        }
        if (policyAction === 'grace') {
          const settings = deps.sellerStore.getSettings();
          const graceBase = Math.max(existing.current_period_end ?? now(), now());
          return deps.sellerStore.upsertCustomer({
            customer_id: existing.customer_id,
            lifecycle_source: existing.lifecycle_source,
            source_customer_id: existing.source_customer_id,
            door_id: existing.door_id,
            tier_id: existing.tier_id,
            contract_id: existing.contract_id,
            source_status,
            grace_until: graceBase + settings.default_grace_hours * HOURS_TO_MS,
            access_state: 'grace',
            now: now(),
          });
        }
        const tokenIds = new Set(
          [existing.inbound_token_id, existing.mcp_token_id].filter(
            (token_id): token_id is string => token_id !== null,
          ),
        );
        for (const token_id of tokenIds) {
          deps.inboundTokenStore.revokeToken({
            token_id,
            now: now(),
          });
        }
        deps.sellerClaimStore?.revokeCustomerClaims(existing.customer_id, now());
        revokeContract(existing.contract_id, reason);
        return deps.sellerStore.upsertCustomer({
          customer_id: existing.customer_id,
          lifecycle_source: existing.lifecycle_source,
          source_customer_id: existing.source_customer_id,
          door_id: existing.door_id,
          tier_id: existing.tier_id,
          contract_id: existing.contract_id,
          source_status,
          access_state: 'closed',
          now: now(),
        });
      });
    },

    reissueCustomerToken(input) {
      rejectCallerTokenAuthority(input, 'reissueCustomerToken');
      if (Object.prototype.hasOwnProperty.call(input, 'source_status')) {
        throw new SellerCustomerAccessError(
          'reissueCustomerToken is bearer rotation only and must not change source_status',
        );
      }
      const existing = findCustomer(input);
      requireOpenCustomer(existing, 'reissueCustomerToken');
      requireCustomerContract(existing.contract_id);
      const tier = deps.sellerStore.getTier(existing.tier_id);
      if (!tier) {
        throw new SellerCustomerAccessError(
          `tier '${existing.tier_id}' was not found`,
        );
      }
      // ⛔⛔ ROTATION MINTS A FRESH CONTRACT. It used to bind the replacement to
      // `existing.contract_id`, which made contract:token 1:many and left
      // per-token `revoked_at` as the only thing that could kill the OLD bearer
      // without killing the contract the NEW one needs. A fresh contract per
      // rotation restores 1:1, so revoking a contract revokes exactly one
      // bearer — which is what lets the token stop carrying its own revocation.
      //
      // ⚠ The customer's `contract_id` therefore ROTATES. It was previously
      // stable identity; the owner ruled it may move. Grants are re-seeded from
      // the TIER TEMPLATE (`stampCustomerContract` copies them), not carried
      // across from the old contract — so a rotation lands the tier's current
      // grants rather than a snapshot taken whenever the customer was opened.
      const template = requireTemplate(tier.template_contract_id);
      const rotated_contract_id = clean(newContractId(), 'generated contract_id');
      if (
        contractDefinition(rotated_contract_id)
        || deps.sellerStore.listCustomers({ contract_id: rotated_contract_id }).length > 0
      ) {
        throw new SellerStoreConflictError(
          `generated contract_id '${rotated_contract_id}' is already in use`,
        );
      }
      const oldTokenIds = new Set(
        [existing.inbound_token_id, existing.mcp_token_id].filter(
          (token_id): token_id is string => token_id !== null,
        ),
      );
      const previousToken = [...oldTokenIds]
        .map((token_id) => deps.inboundTokenStore.getTokenById(token_id))
        .find((record) => record !== null) ?? null;

      return runAtomic(deps.transaction, () => {
        const issuedAt = now();
        // ⛔⛔ THE OLD TOKENS ARE STILL REVOKED PER TOKEN, and that is not
        // belt-and-braces — it is REQUIRED. The partial unique index
        // `uq_chat_inbound_tokens_peer_active` is
        // `(peer_handle) WHERE peer_handle IS NOT NULL AND revoked_at IS NULL`,
        // so "one ACTIVE token per peer" is enforced by the token row's own
        // `revoked_at`. Drop this and issuing the replacement under the same
        // peer_handle throws `peer_handle_conflict`.
        //
        // 🔑 This is why `revoked_at` cannot follow `expires_at` onto the
        // contract: a SQLite partial index cannot consult another table's
        // liveness. Found by driving the rotation, not by reading.
        for (const token_id of oldTokenIds) {
          deps.inboundTokenStore.revokeToken({ token_id, now: issuedAt });
        }
        const rotated = stampCustomerContract(template, {
          contract_id: rotated_contract_id,
          display_name: `${tier.display_name} customer ${existing.source_customer_id}`,
        });
        const issued_token = deps.inboundTokenStore.issueToken({
          value: {
            label: previousToken?.label ?? `${tier.display_name} customer token`,
            peer_handle: peerHandle(
              existing.lifecycle_source,
              existing.source_customer_id,
              existing.door_id,
            ),
            grants: grantMapForContract(rotated.contract_id),
            concurrency_tier: previousToken?.concurrency_tier ?? 3,
            chat_mode: previousToken?.chat_mode ?? null,
            contract_id: rotated.contract_id,
          },
          now: issuedAt,
        });
        // ⛔ THE OLD CONTRACT DIES AFTER the replacement exists, never before —
        // the same retire-after-mint ordering the reception door bind uses, so
        // there is no instant with no live credential. Revoking it is what kills
        // the old bearers; they are no longer revoked one by one.
        revokeContract(existing.contract_id, 'rotated by reissueCustomerToken');
        const customer = deps.sellerStore.upsertCustomer({
          customer_id: existing.customer_id,
          lifecycle_source: existing.lifecycle_source,
          source_customer_id: existing.source_customer_id,
          door_id: existing.door_id,
          tier_id: existing.tier_id,
          contract_id: rotated.contract_id,
          inbound_token_id: issued_token.record.token_id,
          mcp_token_id: issued_token.record.token_id,
          claim_email_sent_at: null,
          claim_email_marker: null,
          access_state: existing.access_state,
          now: issuedAt,
        });
        const issued_claim = issueClaim({
          customer,
          // ⛔ THE ROTATED contract, not `existing` — which is now revoked, and
          // `requireCustomerContract` refuses a dead one. The claim describes
          // what the customer is being handed, and that is the new credential.
          contract: rotated,
          issued_token,
          now: issuedAt,
        });
        return { customer, issued_token, issued_claim };
      });
    },

    bulkAdjustTierCustomers(input) {
      const tier = requireTierById(input.tier_id, input.lifecycle_source);
      const selectedIds = input.customer_ids?.map((id) =>
        clean(id, 'customer_id'));
      if (selectedIds !== undefined && selectedIds.length === 0) {
        throw new SellerCustomerAccessError('customer_ids must not be empty');
      }
      if (
        selectedIds !== undefined
        && new Set(selectedIds).size !== selectedIds.length
      ) {
        throw new SellerCustomerAccessError('customer_ids must not contain duplicates');
      }
      const template = requireTemplate(tier.template_contract_id);

      const customers =
        selectedIds === undefined
          ? deps.sellerStore.listCustomers({
              lifecycle_source: tier.lifecycle_source,
              tier_id: tier.tier_id,
            })
          : selectedIds.map((customer_id) => {
              const customer = deps.sellerStore.getCustomer(customer_id);
              if (!customer) {
                throw new SellerCustomerAccessError(
                  `customer not found for customer_id '${customer_id}'`,
                );
              }
              if (
                customer.lifecycle_source !== tier.lifecycle_source
                || customer.tier_id !== tier.tier_id
              ) {
                throw new SellerCustomerAccessError(
                  `customer_id '${customer.customer_id}' does not belong to tier '${tier.tier_id}'`,
                );
              }
              return customer;
            });
      const openCustomers = customers.filter(
        (customer) => customer.access_state !== 'closed',
      );
      const skipped_closed_customers = customers.filter(
        (customer) => customer.access_state === 'closed',
      );

      return runAtomic(deps.transaction, () => ({
        tier,
        adjusted_customers: openCustomers.map((customer) =>
          restampCustomerFromTierTemplate(customer, tier, template),
        ),
        skipped_closed_customers,
      }));
    },
  };
};
