/** D-196 Seller Economy - customer-token admission.
 *
 *  Inbound door tokens remain valid bearer rows, but seller-managed customer
 *  doors have an additional access lifecycle: the seller customer row, tier
 *  state, source status policy, period end, and grace window must all admit the
 *  call. The authoritative contract kind decides whether Seller pairing is
 *  required; ordinary standing doors remain neutral even when Seller storage is
 *  unavailable.
 */

import type {
  McpInboundTokenRecord,
  SellerCustomer,
  SellerSettings,
  SellerTier,
} from '@recued/contracts';

import type { SellerStore } from '../storage/seller-store.js';

export type SellerCustomerAccessAdmissionDenyReason =
  | 'customer_missing'
  | 'customer_ambiguous'
  | 'contract_kind_unresolved'
  | 'token_mismatch'
  | 'tier_missing'
  | 'tier_inactive'
  | 'access_closed'
  | 'source_status_closed'
  | 'period_deadline_missing'
  | 'grace_deadline_missing'
  | 'grace_expired'
  | 'period_expired'
  | 'admission_error';

export type SellerCustomerAccessAdmissionResult =
  | { readonly applies: false }
  | {
      readonly applies: true;
      readonly admitted: true;
      readonly effective_state: 'active' | 'grace';
      readonly customer: SellerCustomer;
      readonly tier: SellerTier;
    }
  | {
      readonly applies: true;
      readonly admitted: false;
      readonly reason: SellerCustomerAccessAdmissionDenyReason;
      readonly customer?: SellerCustomer;
    };

export type SellerCustomerAccessAdmissionStore = Pick<
  SellerStore,
  'getSettings' | 'getTier' | 'listCustomers'
>;

export interface SellerCustomerAccessAdmissionInput {
  /** Optional because legacy/dbless embeddings do not wire Seller storage.
   *  A classified customer instance fails closed when it is absent. */
  readonly sellerStore?: SellerCustomerAccessAdmissionStore;
  readonly token: Pick<McpInboundTokenRecord, 'token_id' | 'contract_id'>;
  readonly now: number;
  /** Authoritative live bound-contract classification.
   *
   *  - `'standing'` / `'customer_instance'`: resolved by production.
   *  - `null`: a present production resolver could not classify; deny.
   *  - `undefined`: no resolver surface (legacy test/embedding stub); preserve
   *    the old row-discovery behavior so ordinary unconfigured stubs need no
   *    new label. A discovered row still opts into the gate and cannot fail
   *    open. */
  readonly contractKind?: 'standing' | 'customer_instance' | null;
}

export type SourceStatusPolicyAction = 'close_now' | 'grace' | 'keep_active';

const CLOSE_NOW_STATUSES = new Set([
  'cancel',
  'canceled',
  'cancelled',
  'cancellation',
  'dispute',
  'disputed',
  'refund',
  'refunded',
  // Lemon Squeezy's terminal state: the cancelled subscription reached `ends_at`.
  'expired',
]);

const GRACE_STATUSES = new Set([
  'past_due',
  'payment_failed',
  'unpaid',
  // Paddle / Lemon Squeezy `paused`: not paying, may resume. Grace keeps the
  // row open so a resume can extend it; a close_now would revoke the token
  // and the extend path refuses a closed customer. A seller who wants pause to
  // cut access at once sets `<source>:paused` to `close_now` in the policy.
  'paused',
]);

const cleanStatus = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
};

const statusPolicyAction = (
  value: unknown,
): SourceStatusPolicyAction | undefined => {
  if (
    value === 'close_now'
    || value === 'grace'
    || value === 'keep_active'
  ) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return statusPolicyAction((value as { action?: unknown }).action);
  }
  return undefined;
};

export const resolveSellerSourceStatusPolicyAction = (
  settings: SellerSettings,
  customer: Pick<
    SellerCustomer,
    'lifecycle_source' | 'source_status' | 'current_period_end'
  >,
  fallbackStatus?: string | null,
): SourceStatusPolicyAction | undefined => {
  const status = cleanStatus(customer.source_status) ?? cleanStatus(fallbackStatus ?? null);
  if (status === null) return undefined;
  const policy = settings.status_policy_json;
  const explicit = statusPolicyAction(
    policy[`${customer.lifecycle_source}:${status}`]
      ?? policy[status],
  );
  if (explicit !== undefined) return explicit;

  // Manual open-ended customers are edited directly by the seller; without an
  // explicit policy override, their free-form source_status is descriptive only.
  if (customer.lifecycle_source === 'manual' && customer.current_period_end === null) {
    return undefined;
  }
  if (CLOSE_NOW_STATUSES.has(status)) return 'close_now';
  if (GRACE_STATUSES.has(status)) return 'grace';
  return undefined;
};

const future = (deadline: number | null, now: number): boolean =>
  deadline !== null && deadline > now;

const admitGrace = (
  customer: SellerCustomer,
  tier: SellerTier,
  now: number,
): SellerCustomerAccessAdmissionResult => {
  if (customer.grace_until === null) {
    return {
      applies: true,
      admitted: false,
      reason: 'grace_deadline_missing',
      customer,
    };
  }
  if (!future(customer.grace_until, now)) {
    return {
      applies: true,
      admitted: false,
      reason: 'grace_expired',
      customer,
    };
  }
  return {
    applies: true,
    admitted: true,
    effective_state: 'grace',
    customer,
    tier,
  };
};

export const evaluateSellerCustomerAccessAdmission = (
  input: SellerCustomerAccessAdmissionInput,
): SellerCustomerAccessAdmissionResult => {
  const { contract_id } = input.token;
  if (contract_id === undefined || contract_id.length === 0) {
    return { applies: false };
  }

  if (input.contractKind === null) {
    return {
      applies: true,
      admitted: false,
      reason: 'contract_kind_unresolved',
    };
  }
  if (input.contractKind === 'standing') return { applies: false };
  if (!input.sellerStore) {
    return input.contractKind === 'customer_instance'
      ? { applies: true, admitted: false, reason: 'customer_missing' }
      : { applies: false };
  }

  const customers = input.sellerStore.listCustomers({ contract_id });
  if (customers.length === 0) {
    return input.contractKind === 'customer_instance'
      ? { applies: true, admitted: false, reason: 'customer_missing' }
      : { applies: false };
  }
  if (customers.length !== 1) {
    return {
      applies: true,
      admitted: false,
      reason: 'customer_ambiguous',
    };
  }

  const customer = customers[0]!;
  if (
    customer.inbound_token_id !== input.token.token_id
    && customer.mcp_token_id !== input.token.token_id
  ) {
    return {
      applies: true,
      admitted: false,
      reason: 'token_mismatch',
      customer,
    };
  }

  const tier = input.sellerStore.getTier(customer.tier_id);
  if (!tier) {
    return {
      applies: true,
      admitted: false,
      reason: 'tier_missing',
      customer,
    };
  }
  if (!tier.active) {
    return {
      applies: true,
      admitted: false,
      reason: 'tier_inactive',
      customer,
    };
  }
  if (customer.access_state === 'closed') {
    return {
      applies: true,
      admitted: false,
      reason: 'access_closed',
      customer,
    };
  }
  if (customer.lifecycle_source !== 'manual' && customer.current_period_end === null) {
    return {
      applies: true,
      admitted: false,
      reason: 'period_deadline_missing',
      customer,
    };
  }

  const statusAction = resolveSellerSourceStatusPolicyAction(
    input.sellerStore.getSettings(),
    customer,
  );
  if (statusAction === 'close_now') {
    return {
      applies: true,
      admitted: false,
      reason: 'source_status_closed',
      customer,
    };
  }
  if (statusAction === 'keep_active') {
    return {
      applies: true,
      admitted: true,
      effective_state: 'active',
      customer,
      tier,
    };
  }
  if (customer.access_state === 'grace' || statusAction === 'grace') {
    return admitGrace(customer, tier, input.now);
  }

  if (customer.current_period_end === null || future(customer.current_period_end, input.now)) {
    return {
      applies: true,
      admitted: true,
      effective_state: 'active',
      customer,
      tier,
    };
  }
  if (future(customer.grace_until, input.now)) {
    return {
      applies: true,
      admitted: true,
      effective_state: 'grace',
      customer,
      tier,
    };
  }
  return {
    applies: true,
    admitted: false,
    reason: 'period_expired',
    customer,
  };
};
