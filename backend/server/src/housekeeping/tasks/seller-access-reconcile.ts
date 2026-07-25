/** D-196 §6.3 — `seller-access-reconcile` housekeeping task: THE AUTHORITY.
 *
 *  D-196 §6.2 ships REACTIVE recipes for the provider's lifecycle events. §6.3
 *  is unambiguous about what those are worth on their own:
 *
 *      "The reconciler is the authority; the webhook is the accelerator. This is
 *       what makes a server that was down past Stripe's retry window self-heal."
 *
 *  Until this task, only the accelerator existed (`checkout.session.completed`
 *  and `invoice.paid` recipes). A server offline past Stripe's retry window kept
 *  a customer's access silently wrong forever, with nothing to converge it —
 *  exactly the failure §6.3 exists to remove.
 *
 *  ── v1 is LOCAL-DRIVEN, deliberately (owner-ruled 2026-07-17) ─────────────
 *  The sweep walks the LOCAL seller customers that carry an
 *  `external_subscription_id`, reads each subscription's PROVIDER truth, and
 *  converges local state to match. What that actually backstops is THREE of
 *  §6.2's rows, named exactly rather than generously:
 *    - a missed `invoice.paid` / dunning recovery → `extend` to the rolled
 *      period end (I-3: driven by the read-back, not payment direction);
 *    - a missed `customer.subscription.deleted`, or dunning the provider gave
 *      up on (`unpaid` / `incomplete_expired`) → `close`;
 *    - a missed `customer.subscription.updated` → `swap_tier`, resolved off the
 *      customer's ACTIVE ENTITLEMENTS (s2c — see `resolveProviderTierId`), which
 *      is the axis §6.2 names ("swap_tier when entitlement changes") and the
 *      only one that shares a vocabulary with `seller_tiers`. ⛔ Do NOT ever
 *      re-route this through the subscription's `items.data[].price.{id,product}`:
 *      a price id shares NO vocabulary with a tier, so every customer would look
 *      swapped every cycle and `swapCustomerTier` would throw `tier not found`
 *      into the per-customer catch — dead, and wrong about why.
 *
 *  ⚠ WHAT v1 DOES NOT CATCH — stated plainly rather than implied, because an
 *  overclaiming header is how the next reader inherits a false premise:
 *
 *  1. REFUND / DISPUTE (§6.2's `charge.refunded` / `charge.dispute.created`,
 *     whose close reasons `refunded` / `dispute` this module never emits) are
 *     charge-level events. A refund does not necessarily move the SUBSCRIPTION
 *     status, so a subscription read cannot see one. Those rows need their own
 *     signal; this sweep is not their backstop.
 *  2. A subscription that exists at the provider with NO local row — a checkout
 *     whose event was missed outright. §6.3's "issues missed grants" means
 *     exactly that case, and finding it needs a PROVIDER-driven list
 *     (`GET /v1/subscriptions`). The `seller-stripe` surface has
 *     `subscription.read` (one-by-id) and no list op, so v1 cannot reach it —
 *     and adding one is a real decision, not an oversight: an all-subscriptions
 *     list is UNSCOPED by construction, and every other read on that surface
 *     carries a required narrowing arg (`53baf9fdb`). Left to the owner.
 *
 *  v1 forecloses nothing: it is a strict subset.
 *
 *  ── The provider read: GATED, but carrying no housekeeping authority ───────
 *  This module defines the policy only; `seller/access-reconcile-deps.ts` owns
 *  the IO and documents it in full. The one thing to know here: the reader goes
 *  THROUGH the gateway (audited, reusing the pack's declared op) but passes NO
 *  `execution_source`, which takes the LOW `read` ceiling — reads admit, writes
 *  hold.
 *  ⛔ It must never pass `execution_source: { channel: 'housekeeping', … }`.
 *  THAT is the single input that arms `resolveTrustCeiling`'s `admin` branch
 *  (write + admin running silent); nothing dispatches that channel today, which
 *  is exactly why the branch is dead, and D-209 follow-on #2 says to build the
 *  housekeeping bypass WITH that surface as its own deliberate slice — never to
 *  summon it as a side effect of a reconciler.
 *
 *  Server-owned deterministic maintenance over the owner's OWN connection:
 *  `kind: 'core'` (no trust gate, no AI surface, no token estimate).
 *
 *  Cursor: `{ kind: 'complete' }` per sweep — every cycle re-reads provider
 *  truth for the whole known set. Convergence is idempotent (a customer already
 *  matching provider truth is skipped), so re-firing costs one read per
 *  customer and no writes.
 *
 *  Spec: D-196 §6.3 (+ §6.2's event table, whose rows this
 *  backstops) + D-123 (idle cadence). */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
  SellerCustomerCloseReason,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

export const SELLER_ACCESS_RECONCILE_TASK_ID = 'seller-access-reconcile';

/** One local seller customer the sweep can converge. Only the fields this task
 *  reads — the store's row is wider. */
export interface ReconcilableCustomer {
  readonly customer_id: string;
  /** The provider's subscription id (`seller_customers.external_subscription_id`).
   *  A customer without one is not subscription-backed (a one-time pass — its
   *  expiry does the work, §6.2) and is never swept. */
  readonly external_subscription_id: string;
  /** The tier the customer currently holds locally, for swap detection. */
  readonly tier_id?: string;
  /** Local access expiry, for extend detection. */
  readonly access_expires_at?: number;
}

/** Provider truth for one subscription, already narrowed to what convergence
 *  needs. The reader owns the API call + its auth (D-128 pattern). */
export interface ProviderSubscriptionTruth {
  /** The provider's own status string (`active` / `past_due` / `canceled` /
   *  `unpaid` / `incomplete_expired` / …). Kept as the RAW provider string —
   *  narrowing it here would be this module inventing a vocabulary the provider
   *  owns. The policy below maps it. */
  readonly status: string;
  /** Unix ms the paid period runs to (`current_period_end` × 1000). */
  readonly current_period_end_ms?: number;
  /** The entitlement/tier the subscription currently confers, if resolvable. */
  readonly tier_id?: string;
}

/** What the sweep decided for one customer. `'skip'` = already converged. */
export type ReconcileAction = 'skip' | 'extend' | 'swap_tier' | 'close';

export interface SellerAccessReconcileDeps {
  /** The local customers to sweep — subscription-backed only. */
  listSubscriptionCustomers(): Promise<ReadonlyArray<ReconcilableCustomer>>;
  /** Provider truth for ONE local customer. Takes the whole local row (not just
   *  the subscription id) because resolving `tier_id` needs the customer's local
   *  tier to compare against — and because the reader, which owns the IO cost,
   *  is the right place to decide that an ENDED subscription needs no second
   *  read at all.
   *
   *  Returns null when the provider has no such subscription (deleted at source)
   *  or the read failed in a way the caller already logged. ⛔ A null must NOT be
   *  read as "closed": an API blip would then revoke a paying customer's access.
   *  See `reconcileOne`. */
  readProviderTruth(local: ReconcilableCustomer): Promise<ProviderSubscriptionTruth | null>;
  /** `core.seller.customer-access.extend` — roll the paid period forward. */
  extend(input: { customer_id: string; access_expires_at: number }): Promise<void>;
  /** `core.seller.customer-access.swap-tier` — the provider moved the plan. */
  swapTier(input: { customer_id: string; tier_id: string }): Promise<void>;
  /** `core.seller.customer-access.close` — provider state says access ended.
   *
   *  Both vocabularies travel, because they are different facts and the row
   *  records both: `reason` is Recued's LOCAL closed vocabulary (the decision),
   *  `source_status` is the provider's RAW word (the evidence). ⛔ Do not drop
   *  `source_status` and reconstruct it from `reason` downstream — the mapping
   *  is many-to-one (`payment_failed` ← `unpaid` AND `incomplete_expired`), so
   *  the inverse is a guess, and the seller's status policy reads this field to
   *  choose grace vs. close. A fabricated status there is a money decision made
   *  on invented provenance.
   *  [[feedback_provenance_that_lies_is_worse_than_absent]] */
  close(input: {
    customer_id: string;
    reason: SellerCustomerCloseReason;
    source_status: string;
  }): Promise<void>;
  now(): number;
}

/** Provider statuses that mean ACCESS HAS ENDED → the LOCAL close reason each
 *  one maps to.
 *
 *  ⛔ THE MAP IS THE CLOSED LIST — one const, never a status set here plus a
 *  translation somewhere downstream. The provider's status vocabulary and
 *  Recued's close-reason vocabulary (`SELLER_CUSTOMER_CLOSE_REASONS`) are two
 *  DIFFERENT closed lists, and this module is the seam between them. They do
 *  not even agree on spelling: Stripe says `canceled`, Recued records
 *  `cancelled`. Emitting the raw provider word as the reason would be rejected
 *  by `closeCustomer`'s `cleanCloseReason` at runtime and then SWALLOWED by the
 *  sweep's per-customer catch below — a close lane that silently never fires,
 *  which is the one lane this task exists for. Typing the value as
 *  `SellerCustomerCloseReason` is what makes tsc catch that at the wiring seam
 *  instead of production catching it never.
 *  [[feedback_a_subset_typechecks_so_derive_the_closed_list]]
 *
 *  ⛔ Still a CLOSED list, and deliberately not its inverse. Keying on "not
 *  active" would close a customer on any status this map has not met — a
 *  provider adding one new string (`paused`, a trial variant) would silently
 *  revoke paying customers. Unknown ⇒ leave alone and let the next cycle (or a
 *  human) decide. Closing is the only IRREVERSIBLE-feeling action here, so it
 *  is the one that must be opt-in.
 *  [[feedback_safety_by_narrowing_cannot_generalize]]
 *
 *  Why each mapping (§6.2's event table names the target reason):
 *  - `canceled` → `cancelled`: §6.2's `customer.subscription.deleted` row is
 *    literally "close(source='stripe', cancelled)". This sweep is that row's
 *    backstop, so it must land on the same reason the webhook would have.
 *  - `unpaid` → `payment_failed`: the provider's OWN dunning retries gave up.
 *    §6.2's `invoice.payment_failed` row is the accelerator for this same
 *    outcome; `past_due` (below) is the grace window on the way here.
 *  - `incomplete_expired` → `payment_failed`: the subscription's first invoice
 *    was never paid inside the provider's window. Access never really began.
 *
 *  Exported for the same reason `providerStatusIsLive` is, one step further out:
 *  the §6.2 webhook accelerators are JSON and CANNOT import anything, so they
 *  necessarily re-express this vocabulary as recipe literals. A corpus test
 *  (`d-196-seller-status-vocabulary-corpus.test.ts`) derives what those literals
 *  must be from THIS object, which is what keeps the JSON copy from rotting.
 *  [[feedback_a_subset_typechecks_so_derive_the_closed_list]] */
export const ACCESS_ENDED_STATUS_REASONS: Readonly<Record<string, SellerCustomerCloseReason>> = {
  canceled: 'cancelled',
  incomplete_expired: 'payment_failed',
  unpaid: 'payment_failed',
};

/** Statuses where the subscription is alive and the paid period governs.
 *  `past_due` is deliberately HERE, not in the ended set: dunning is a grace
 *  window, and §6.2's `invoice.payment_failed` row says "enter/refresh grace per
 *  status policy" — the provider closes to `unpaid`/`canceled` when its own
 *  retries give up, and THAT is what ends access. Closing at `past_due` would
 *  cut off a customer mid-dunning whose next retry succeeds.
 *
 *  Exported alongside `providerStatusIsLive` because a membership predicate
 *  cannot prove COMPLETENESS: a recipe listing a SUBSET of these would pass
 *  `providerStatusIsLive` on every element it happens to name. The corpus test
 *  needs the set itself to assert the JSON copy is exhaustive. */
export const ACCESS_LIVE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
]);

/** Is the provider saying this subscription is still alive?
 *
 *  Exported so the READER can skip its second provider call (the entitlement
 *  read) on a subscription that has ended — there is no plan to converge for a
 *  customer who is about to close. ⛔ It must import this rather than re-list the
 *  statuses: a copied vocabulary typechecks as a subset and rots silently, and
 *  the two would disagree about `past_due` first.
 *  [[feedback_a_subset_typechecks_so_derive_the_closed_list]] */
export const providerStatusIsLive = (status: string): boolean =>
  ACCESS_LIVE_STATUSES.has(status);

/** D-196 §6.2 — resolve which tier the provider currently says a customer holds,
 *  from their ACTIVE ENTITLEMENTS. Pure; the reader supplies the data.
 *
 *  §6.2 is explicit that the swap axis is the ENTITLEMENT, not the price:
 *  "swap_tier when entitlement changes", with
 *  `entitlements.active_entitlement_summary.updated` the "preferred signal".
 *  The provider's entitlement `lookup_key`s ARE our `entitlement_key`
 *  vocabulary (`stripe-entitlement-sync.ts` mints one tier per feature, keyed on
 *  `feature.lookup_key`), so this is a real join — unlike price ids, which share
 *  no vocabulary with a tier at all.
 *
 *  🔑 THE CHECK IS MEMBERSHIP, NOT SELECTION — which is why the entitlement COUNT
 *  does not matter and no "which one is theirs" ambiguity arises. The provider's
 *  active-entitlement read is CUSTOMER-scoped, so it spans every subscription,
 *  product and door that customer has; and one product can carry many features.
 *  Asking "is THEIR key still live?" is well-defined against any of that.
 *  `issue-access-for-paid-order.json` already reads it exactly this way (`in`,
 *  never a count).
 *
 *  ⛔ ABSENCE OF THEIR KEY IS NOT, BY ITSELF, A SWAP. A seller detaching a
 *  feature in the provider console, or entitlement propagation lag, makes the key
 *  vanish for EVERY customer at once with no plan change having happened — and a
 *  swap fires a write. So a swap requires POSITIVE evidence: exactly one OTHER
 *  tier on this door is active. Absent that, leave the customer alone; a real
 *  ending arrives through the subscription STATUS lane, which needs none of this.
 *  [[feedback_absence_is_not_deletion_without_completeness_proof]]
 *
 *  Returns the tier the provider implies:
 *   - their own tier, when its key is still active ⇒ `reconcileOne` sees no
 *     change and skips (converged);
 *   - the single other active tier on this door ⇒ a swap;
 *   - `undefined` when unresolvable ⇒ the swap branch cannot fire at all. */
export const resolveProviderTierId = (input: {
  readonly local_tier_id: string | undefined;
  readonly local_entitlement_key: string | undefined;
  readonly active_entitlement_keys: readonly string[];
  /** Every tier on the customer's OWN door — the narrowing that makes a
   *  customer-scoped entitlement list answerable. A key belonging to another
   *  door (or to a product this seller does not gate) is not a candidate. */
  readonly door_tiers: ReadonlyArray<{ tier_id: string; entitlement_key: string }>;
}): string | undefined => {
  // Their local tier is unknown / unresolvable ⇒ nothing to compare against.
  if (input.local_tier_id === undefined || input.local_entitlement_key === undefined) {
    return undefined;
  }
  // Converged: their key is still live. Count-independent — extra entitlements
  // (another door, another product, a multi-feature product) are irrelevant.
  if (input.active_entitlement_keys.includes(input.local_entitlement_key)) {
    return input.local_tier_id;
  }
  // Their key is gone. Only a SINGLE unambiguous alternative on this door counts
  // as the plan having moved; 0 (a detached feature / propagation lag / a real
  // ending) and 2+ (genuinely ambiguous) both leave it alone.
  const active = input.door_tiers.filter((tier) =>
    input.active_entitlement_keys.includes(tier.entitlement_key));
  return active.length === 1 ? active[0]!.tier_id : undefined;
};

/** Decide ONE customer's convergence. Pure — no IO, no clock: the caller passes
 *  provider truth in and applies the verdict. Exported for the unit test, which
 *  is where the status policy is pinned. */
export const reconcileOne = (
  local: ReconcilableCustomer,
  provider: ProviderSubscriptionTruth | null,
): {
  action: ReconcileAction;
  tier_id?: string;
  access_expires_at?: number;
  reason?: SellerCustomerCloseReason;
  /** The provider's raw status that produced a `close` — the evidence behind
   *  `reason`. Present iff `action === 'close'`. */
  source_status?: string;
} => {
  // ⛔ UNREADABLE ≠ ENDED. A null is "we could not see provider truth" — a
  // network blip, a rotated key, a rate-limit. Treating it as `close` would
  // revoke a paying customer's access on a transient failure, and the next
  // cycle would not undo it (close is not self-healing). Skip; the sweep is
  // idempotent and the next cycle re-reads. [[feedback_complete_the_fence_dont_predict_the_default]]
  if (provider === null) return { action: 'skip' };

  // The provider's word for "ended", translated to Recued's. An absent entry is
  // NOT "not ended" by inference — it is "this map has never met that word", and
  // the unknown-vocabulary skip below is what handles it.
  const endedReason = ACCESS_ENDED_STATUS_REASONS[provider.status];
  if (endedReason !== undefined) {
    return { action: 'close', reason: endedReason, source_status: provider.status };
  }
  // Unknown vocabulary — not live, not known-ended. Leave it exactly alone.
  if (!ACCESS_LIVE_STATUSES.has(provider.status)) return { action: 'skip' };

  // Live. The tier moves first: a swap changes WHAT they have, an extend only
  // changes how long. Doing both in one cycle would be two writes racing the
  // same row; the next cycle converges the expiry, one read later.
  if (
    provider.tier_id !== undefined
    && local.tier_id !== undefined
    && provider.tier_id !== local.tier_id
  ) {
    return { action: 'swap_tier', tier_id: provider.tier_id };
  }

  // I-3: extend is driven by the READ-BACK's rolled period end, never by
  // payment direction — which is why licensed (prepaid) and metered (arrears)
  // need no separate rows (§6.2).
  //
  // ⚠ STRICTLY FORWARD. `>` not `!==`: an equal end is already converged, and a
  // provider end EARLIER than local must not drag access backwards — that would
  // let a stale/replayed read shorten a period the customer paid for. Shortening
  // access is what `close` is for, on an ENDED status, never a silent rewind.
  if (
    provider.current_period_end_ms !== undefined
    && (local.access_expires_at === undefined
      || provider.current_period_end_ms > local.access_expires_at)
  ) {
    return { action: 'extend', access_expires_at: provider.current_period_end_ms };
  }

  return { action: 'skip' };
};

export interface SellerAccessReconcileOutcome {
  readonly swept: number;
  readonly extended: number;
  readonly swapped: number;
  readonly closed: number;
  readonly unreadable: number;
}

/** Run one full sweep. Exported so the task wrapper stays thin and the test can
 *  drive the loop without the housekeeping harness. */
export const runSellerAccessReconcile = async (
  deps: SellerAccessReconcileDeps,
): Promise<SellerAccessReconcileOutcome> => {
  const customers = await deps.listSubscriptionCustomers();
  let extended = 0;
  let swapped = 0;
  let closed = 0;
  let unreadable = 0;

  for (const local of customers) {
    // ⛔ One customer's failure must not abort the sweep — the whole point is
    // self-healing, and a single bad row would otherwise strand every customer
    // after it. Count it and move on; the next cycle retries.
    let provider: ProviderSubscriptionTruth | null = null;
    try {
      provider = await deps.readProviderTruth(local);
    } catch {
      provider = null;
    }
    if (provider === null) unreadable += 1;

    const verdict = reconcileOne(local, provider);
    try {
      if (verdict.action === 'extend' && verdict.access_expires_at !== undefined) {
        await deps.extend({
          customer_id: local.customer_id,
          access_expires_at: verdict.access_expires_at,
        });
        extended += 1;
      } else if (verdict.action === 'swap_tier' && verdict.tier_id !== undefined) {
        await deps.swapTier({ customer_id: local.customer_id, tier_id: verdict.tier_id });
        swapped += 1;
      } else if (
        verdict.action === 'close'
        && verdict.reason !== undefined
        && verdict.source_status !== undefined
      ) {
        // No `?? <default>` on either field, on purpose: a close verdict ALWAYS
        // carries both (`ACCESS_ENDED_STATUS_REASONS` is what produced it). Any
        // fallback literal would have to be a member of the local closed list —
        // i.e. a guess at WHY access ended, recorded as fact on the customer's
        // row. Provenance we do not have is not a default we get to invent.
        await deps.close({
          customer_id: local.customer_id,
          reason: verdict.reason,
          source_status: verdict.source_status,
        });
        closed += 1;
      }
    } catch {
      // Same posture: a failed converge is retried next cycle, never fatal.
    }
  }

  return { swept: customers.length, extended, swapped, closed, unreadable };
};

export interface BuildSellerAccessReconcileTaskOptions {
  deps: SellerAccessReconcileDeps;
}

/** Wrap the sweep as a `kind: 'core'` housekeeping task (D-123 idle cadence). */
export const buildSellerAccessReconcileTask = (
  opts: BuildSellerAccessReconcileTaskOptions,
): HousekeepingTaskInstance => ({
  meta: {
    id: SELLER_ACCESS_RECONCILE_TASK_ID,
    description:
      'Re-read each subscription customer\'s state from the payment provider '
      + 'and converge local access (extend / swap tier / close) — the authority '
      + 'behind the lifecycle webhooks.',
    // ⛔ NOT interruptible: `step()` runs ONE whole sweep and returns
    // `complete` — it keeps no partial cursor, so being called with a small
    // remaining budget would start a sweep it cannot resume. The engine must
    // only call it with a full cycle budget.
    interruptible: false,
    kind: 'core',
  },
  async step(
    _ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runSellerAccessReconcile(opts.deps);
    // One sweep per cycle — the known set is small (the seller's own customers)
    // and each row is one read. No partial cursor to preserve.
    return { cursor: { kind: 'complete' }, status: 'complete' };
  },
});
