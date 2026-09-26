/** D-309 — re-apply a manual package to its customers, with the owner choosing
 *  what and who.
 *
 *  What: the package's permissions (its template, re-stamped onto each
 *  agreement), its length (each end date, from the package's own rule), or both.
 *  Who:
 *  - everyone still active;
 *  - everyone whose end date and permissions nobody changed by hand;
 *  - the ones the owner picks.
 *  Closed customers are always left alone.
 *
 *  This is where the edges the D-308 repair could not decide go: an open-ended
 *  customer with no trace, or one on a package edited since. The repair cannot
 *  tell a bug from a choice; the owner can.
 *
 *  The length counts from when the customer got access: the later of when they
 *  joined, their last paid order for this package, and their last DeepTutor
 *  enrollment in it. ⚠ A pass still RUNNING whose length has run out ends NOW,
 *  never in the past (the owner's grace then runs from the re-apply), the D-308
 *  rule. One already past its end keeps the package's end, so it gets no fresh
 *  grace, and one whose access has ended is left alone unless picked. A package
 *  with no length re-applies as no end date.
 *
 *  "Changed by hand" is what the lifecycle records from D-309 on: a date someone
 *  chose, as opposed to the package's rule, and permissions that differ from the
 *  last stamp. A customer from before that record is compared with the package
 *  instead: an end date more than an hour from its start plus the package's
 *  length, or permissions that differ from the template as it is now. */

import {
  type SellerManualTierReapplyCustomer,
  type SellerReapplyWho,
  type SellerTier,
} from '@recued/contracts';

import type { RecordsStore } from '../records/store.js';
import type { SellerOrderStore } from '../storage/seller-order-store.js';
import type { SellerStore } from '../storage/seller-store.js';
import type { SellerCustomerAccessLifecycle } from './customer-access-lifecycle.js';
import { enrollmentFor, readEnrollments } from './pass-traces.js';

/** How far a pre-record end date may sit from the package's own before it
 *  counts as set by hand: the rule stamps "now + length" when the pass is issued,
 *  moments after the purchase or enrollment it counts from. */
const PACKAGE_END_TOLERANCE_MS = 60 * 60 * 1000;

export class SellerPackageReapplyError extends Error {
  constructor(detail: string) {
    super(`seller_package_reapply_invalid: ${detail}`);
    this.name = 'SellerPackageReapplyError';
  }
}

export interface PackageReapplyDeps {
  readonly sellerStore: Pick<SellerStore, 'getTier' | 'listCustomers' | 'customerStamps'>;
  /** Absent ⇒ no purchase is known, and a customer's length counts from when they joined. */
  readonly orderStore?: Pick<SellerOrderStore, 'paidOrderSpan'>;
  /** Absent ⇒ no enrollment is known, likewise. */
  readonly records?: Pick<RecordsStore, 'exportNamespace'>;
  readonly lifecycle: Pick<SellerCustomerAccessLifecycle, 'reapplyTierToCustomers' | 'permissionsChangedByHand'>;
  readonly now: () => number;
}

export interface PackageReapplyRequest {
  readonly tier_id: string;
  readonly apply: { readonly permissions: boolean; readonly length: boolean };
  readonly who: SellerReapplyWho;
  readonly customer_ids?: readonly string[];
  readonly preview: boolean;
}

export const reapplyPackage = (
  deps: PackageReapplyDeps,
  request: PackageReapplyRequest,
): { readonly tier: SellerTier; readonly customers: readonly SellerManualTierReapplyCustomer[] } => {
  if (!request.apply.permissions && !request.apply.length) {
    throw new SellerPackageReapplyError('choose its permissions, its length, or both');
  }
  if ((request.who === 'picked') !== (request.customer_ids !== undefined)) {
    throw new SellerPackageReapplyError(request.who === 'picked'
      ? 'picked needs customer_ids'
      : 'customer_ids are only for picked');
  }
  const tier = deps.sellerStore.getTier(request.tier_id);
  if (tier === null || tier.lifecycle_source !== 'manual') {
    throw new SellerPackageReapplyError(`manual tier '${request.tier_id}' was not found`);
  }
  const customers = deps.sellerStore.listCustomers({ lifecycle_source: 'manual', tier_id: tier.tier_id })
    .slice()
    .sort((a, b) => a.created_at - b.created_at || a.customer_id.localeCompare(b.customer_id));
  const picked = new Set(request.customer_ids ?? []);
  for (const id of picked) {
    if (!customers.some((customer) => customer.customer_id === id)) {
      throw new SellerPackageReapplyError(`customer_id '${id}' is not a customer of this package`);
    }
  }
  const now = deps.now();
  const enrollments = readEnrollments(deps.records);
  const lengthMs = tier.pass_duration_seconds === null ? null : tier.pass_duration_seconds * 1000;

  const rows = customers.map((customer): SellerManualTierReapplyCustomer => {
    const paid = deps.orderStore?.paidOrderSpan({
      customer_id: customer.customer_id,
      entitlement_key: tier.entitlement_key,
    }) ?? null;
    const enrollment = enrollmentFor(enrollments, customer, tier.entitlement_key);
    const started_at = Math.max(customer.created_at, paid?.last_paid_at ?? 0, enrollment?.last_at ?? 0);
    const packageEnd = lengthMs === null ? null : started_at + lengthMs;
    const stamps = deps.sellerStore.customerStamps(customer.customer_id);
    const open = customer.access_state !== 'closed';
    // The admission check's own period rule (`customer-access-admission.ts`): a
    // pass RUNS while its end is ahead, then has access through its grace.
    // ⛔ Whether it still runs decides how a length that has run out lands
    // (integrity audit, 2026-09-24). Ending every such pass "now" granted the
    // owner's grace from now: 72 more hours for a pass that lapsed weeks ago, and
    // a fresh 72 for one already in its grace. Only a running pass gets the D-308
    // soft landing; one past its end keeps the package's end, grace and all.
    const running = customer.current_period_end === null || customer.current_period_end > now;
    const hasAccess = running || (customer.grace_until !== null && customer.grace_until > now);
    const changed_by_hand = {
      end_date: stamps?.period_set_by === 'hand'
        || (stamps?.period_set_by == null && endDiffers(customer.current_period_end, packageEnd)),
      permissions: open && deps.lifecycle.permissionsChangedByHand(customer.customer_id),
    };
    // A customer whose access has ended is not "still active": only a pick
    // re-applies to them.
    const skipped: SellerManualTierReapplyCustomer['skipped'] = !open
      ? 'closed'
      : request.who === 'picked'
        ? (picked.has(customer.customer_id) ? null : 'not_picked')
        : !hasAccess
          ? 'lapsed'
          : request.who === 'unchanged' && (changed_by_hand.end_date || changed_by_hand.permissions)
            ? 'changed_by_hand'
            : null;
    const included = skipped === null;
    return {
      customer_id: customer.customer_id,
      label: customer.email ?? customer.source_customer_id,
      access_state: customer.access_state,
      changed_by_hand,
      started_at,
      end_before: customer.current_period_end,
      end_after: included && request.apply.length
        ? (packageEnd === null ? null : running ? Math.max(packageEnd, now) : packageEnd)
        : customer.current_period_end,
      included,
      skipped,
    };
  });

  const targets = rows.filter((row) => row.included);
  if (!request.preview && targets.length > 0) {
    deps.lifecycle.reapplyTierToCustomers({
      tier_id: tier.tier_id,
      customer_ids: targets.map((row) => row.customer_id),
      permissions: request.apply.permissions,
      ...(request.apply.length
        ? { period_ends: new Map(targets.map((row) => [row.customer_id, row.end_after])) }
        : {}),
    });
  }
  return { tier, customers: rows };
};

/** A pre-record end date against the package's own: both open-ended agree, one
 *  open-ended does not, and two dates agree within the tolerance. */
const endDiffers = (end: number | null, packageEnd: number | null): boolean =>
  end === null || packageEnd === null
    ? end !== packageEnd
    : Math.abs(end - packageEnd) > PACKAGE_END_TOLERANCE_MS;
