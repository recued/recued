/** D-196 §6.3 — the reconciler-as-authority.
 *
 *  §6.3: "The reconciler is the authority; the webhook is the accelerator."
 *  Until this task only the accelerator existed, so a server offline past the
 *  provider's retry window kept a customer's access silently wrong forever.
 *
 *  What these tests pin is the STATUS POLICY, because that is where the money
 *  is: closing a paying customer is the one action here that does not self-heal
 *  on the next cycle. */

import { describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';
import { SELLER_CUSTOMER_CLOSE_REASONS } from '@recued/contracts';
import { resolveSellerSourceStatusPolicyAction } from '../seller/customer-access-admission.js';
import { createSellerStore } from '../storage/seller-store.js';

import {
  providerStatusIsLive,
  reconcileOne,
  resolveProviderTierId,
  runSellerAccessReconcile,
  type ProviderSubscriptionTruth,
  type ReconcilableCustomer,
  type SellerAccessReconcileDeps,
} from '../housekeeping/tasks/seller-access-reconcile.js';

const customer = (over: Partial<ReconcilableCustomer> = {}): ReconcilableCustomer => ({
  customer_id: 'cus_local_1',
  external_subscription_id: 'sub_1',
  tier_id: 'tier_basic',
  access_expires_at: 1_000,
  ...over,
});

const truth = (over: Partial<ProviderSubscriptionTruth> = {}): ProviderSubscriptionTruth => ({
  status: 'active',
  current_period_end_ms: 1_000,
  tier_id: 'tier_basic',
  ...over,
});

const makeDeps = (
  customers: ReadonlyArray<ReconcilableCustomer>,
  read: (id: string) => Promise<ProviderSubscriptionTruth | null>,
): SellerAccessReconcileDeps & {
  extend: ReturnType<typeof vi.fn>;
  swapTier: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} => {
  const extend = vi.fn(async () => undefined);
  const swapTier = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  return {
    listSubscriptionCustomers: async () => customers,
    readProviderTruth: (local) => read(local.external_subscription_id),
    extend,
    swapTier,
    close,
    now: () => 5_000,
  };
};

describe('D-196 §6.3 — seller access reconciler (the authority)', () => {
  describe('status policy — what ends access', () => {
    it('CLOSES only on the closed ended-list, never on "not active"', () => {
      for (const status of ['canceled', 'incomplete_expired', 'unpaid']) {
        expect(reconcileOne(customer(), truth({ status })).action).toBe('close');
      }
    });

    it('⛔ past_due is DUNNING, not ended — closing mid-grace cuts off a customer whose next retry succeeds', () => {
      // §6.2's `invoice.payment_failed` row: "enter/refresh grace per status
      // policy". The PROVIDER closes to unpaid/canceled when its retries give
      // up; that is what ends access.
      expect(reconcileOne(customer(), truth({ status: 'past_due' })).action).not.toBe('close');
      expect(reconcileOne(customer(), truth({ status: 'trialing' })).action).not.toBe('close');
    });

    it('⛔ an UNKNOWN provider status is left ALONE — a new vocabulary word must not revoke paying customers', () => {
      // The whole reason the ended-list is closed rather than `!== 'active'`.
      // A provider adding a status we have never seen must not silently close
      // everyone. (`paused` WAS the example here until Paddle and Lemon Squeezy
      // gave it a meaning — see the next case.)
      for (const status of ['incomplete', 'some_future_status', '']) {
        expect(reconcileOne(customer(), truth({ status })).action).toBe('skip');
      }
    });

    it('paused and expired (Paddle / Lemon Squeezy) END the paid period — and paused defaults to GRACE, never a revoking close', () => {
      for (const status of ['paused', 'expired']) {
        const verdict = reconcileOne(customer(), truth({ status }));
        expect(verdict.action).toBe('close');
        expect(verdict.reason).toBe('cancelled');
      }
      // The half that keeps a resume possible: a close with source_status
      // `paused` resolves to grace under the shipped default policy, so the row
      // stays open for `subscription.resumed` / `subscription_unpaused` to
      // extend. A revoked row cannot be re-opened by the extend path.
      const db = new Database(':memory:');
      try {
        const settings = createSellerStore(db).getSettings();
        for (const lifecycle_source of ['paddle', 'lemonsqueezy'] as const) {
          expect(resolveSellerSourceStatusPolicyAction(
            settings,
            { lifecycle_source, source_status: 'paused', current_period_end: Date.UTC(2030, 0, 1) },
            'cancelled',
          )).toBe('grace');
          expect(resolveSellerSourceStatusPolicyAction(
            settings,
            { lifecycle_source, source_status: 'expired', current_period_end: Date.UTC(2020, 0, 1) },
            'cancelled',
          )).toBe('close_now');
        }
      } finally {
        db.close();
      }
    });

    it('⛔ UNREADABLE is not ENDED — a blip must never revoke access (close does not self-heal)', () => {
      expect(reconcileOne(customer(), null).action).toBe('skip');
    });

    it('⛔ every reason it can emit is a MEMBER of the LOCAL closed vocabulary', () => {
      // Derived from the real const, never a copy of its members: a copy
      // type-checks as a subset forever while drifting from the list the
      // lifecycle actually enforces (`cleanCloseReason`). This is the pin that
      // would have caught the raw provider status being emitted as a reason —
      // rejected at runtime, then swallowed by the sweep's per-customer catch.
      // [[feedback_a_subset_typechecks_so_derive_the_closed_list]]
      for (const status of ['canceled', 'incomplete_expired', 'unpaid']) {
        const verdict = reconcileOne(customer(), truth({ status }));
        expect(verdict.action).toBe('close');
        expect(SELLER_CUSTOMER_CLOSE_REASONS).toContain(verdict.reason);
      }
    });

    it('translates the PROVIDER vocabulary into the LOCAL one, and keeps the raw word as evidence', () => {
      // Two different closed lists that do not even agree on spelling: Stripe
      // `canceled`, Recued `cancelled`. `source_status` carries the provider's
      // actual word so the seller's status policy decides grace-vs-close on
      // evidence rather than on a reason reverse-mapped back to a guess (the
      // map is many-to-one, so that inverse does not exist).
      expect(reconcileOne(customer(), truth({ status: 'canceled' }))).toMatchObject({
        action: 'close', reason: 'cancelled', source_status: 'canceled',
      });
      expect(reconcileOne(customer(), truth({ status: 'unpaid' }))).toMatchObject({
        action: 'close', reason: 'payment_failed', source_status: 'unpaid',
      });
      expect(
        reconcileOne(customer(), truth({ status: 'incomplete_expired' })),
      ).toMatchObject({
        action: 'close', reason: 'payment_failed', source_status: 'incomplete_expired',
      });
    });
  });

  describe('convergence', () => {
    it('EXTENDS to the provider period end (I-3: driven by the read-back, not payment direction)', () => {
      const v = reconcileOne(customer({ access_expires_at: 1_000 }), truth({ current_period_end_ms: 9_000 }));
      expect(v.action).toBe('extend');
      expect(v.access_expires_at).toBe(9_000);
    });

    it('⛔ NEVER drags access BACKWARDS — an earlier provider end is not an extend', () => {
      // A stale/replayed read must not shorten a period the customer paid for.
      // Shortening is what `close` is for, on an ENDED status.
      expect(
        reconcileOne(customer({ access_expires_at: 9_000 }), truth({ current_period_end_ms: 1_000 })).action,
      ).toBe('skip');
      // ...and an already-converged expiry is a no-op, not a redundant write.
      expect(
        reconcileOne(customer({ access_expires_at: 9_000 }), truth({ current_period_end_ms: 9_000 })).action,
      ).toBe('skip');
    });

    it('SWAPS the tier when the provider moved the plan, and takes priority over the expiry', () => {
      const v = reconcileOne(
        customer({ tier_id: 'tier_basic', access_expires_at: 1_000 }),
        truth({ tier_id: 'tier_pro', current_period_end_ms: 9_000 }),
      );
      expect(v.action).toBe('swap_tier');
      expect(v.tier_id).toBe('tier_pro');
    });

    it('a fully-converged customer is SKIPPED (idempotent re-run — the cycle costs one read, no writes)', () => {
      expect(reconcileOne(customer(), truth()).action).toBe('skip');
    });
  });

  // ── s2c: the swap axis is the ENTITLEMENT (§6.2), resolved by MEMBERSHIP ──
  describe('resolveProviderTierId — which tier the provider says they hold', () => {
    const DOOR_TIERS = [
      { tier_id: 'tier_basic', entitlement_key: 'basic' },
      { tier_id: 'tier_pro', entitlement_key: 'pro' },
    ];
    const resolve = (
      active_entitlement_keys: string[],
      over: Partial<Parameters<typeof resolveProviderTierId>[0]> = {},
    ) => resolveProviderTierId({
      local_tier_id: 'tier_basic',
      local_entitlement_key: 'basic',
      active_entitlement_keys,
      door_tiers: DOOR_TIERS,
      ...over,
    });

    it('🔑 THEIR key still active ⇒ converged, and the COUNT is irrelevant', () => {
      // The read is CUSTOMER-scoped: it spans every subscription, product and
      // door that Stripe customer has, and one product can carry many features.
      // Membership answers that; a count would not. Returning their own tier is
      // what makes `reconcileOne` see no change.
      expect(resolve(['basic'])).toBe('tier_basic');
      expect(resolve(['basic', 'pro'])).toBe('tier_basic');
      expect(resolve(['basic', 'some_other_door_key', 'a_second_feature'])).toBe('tier_basic');
    });

    it('key gone + exactly ONE other door tier active ⇒ that is the swap target', () => {
      expect(resolve(['pro'])).toBe('tier_pro');
    });

    it('⛔ ABSENCE ALONE IS NOT A SWAP — a detached feature / propagation lag must not fire a write', () => {
      // A seller detaching a feature in the provider console, or entitlement
      // propagation lag, makes the key vanish for EVERY customer at once with no
      // plan change having happened. A swap needs POSITIVE evidence.
      // [[feedback_absence_is_not_deletion_without_completeness_proof]]
      expect(resolve([])).toBeUndefined();
      // ...and keys that belong to no tier on this door are not evidence either.
      expect(resolve(['someone_elses_door', 'unrelated'])).toBeUndefined();
    });

    it('⛔ 2+ candidate tiers on this door ⇒ genuinely ambiguous ⇒ leave alone', () => {
      expect(resolve(['pro', 'enterprise'], {
        door_tiers: [...DOOR_TIERS, { tier_id: 'tier_ent', entitlement_key: 'enterprise' }],
      })).toBeUndefined();
    });

    it('⛔ an unresolvable local tier resolves to nothing — never a guess', () => {
      expect(resolve(['pro'], { local_tier_id: undefined })).toBeUndefined();
      expect(resolve(['pro'], { local_entitlement_key: undefined })).toBeUndefined();
    });

    it('the door narrowing is load-bearing: another door\'s key is never a swap target', () => {
      // The customer holds `pro` — but on a DIFFERENT door, whose tiers are not
      // in this door's list. Nothing on this door is active ⇒ no evidence.
      expect(resolve(['pro'], { door_tiers: [{ tier_id: 'tier_basic', entitlement_key: 'basic' }] }))
        .toBeUndefined();
    });
  });

  describe('providerStatusIsLive — the reader\'s gate on the second call', () => {
    it('is TRUE for exactly the live set, so a closing customer costs no entitlement read', () => {
      for (const s of ['active', 'trialing', 'past_due']) expect(providerStatusIsLive(s)).toBe(true);
      for (const s of ['canceled', 'unpaid', 'incomplete_expired', 'paused', '']) {
        expect(providerStatusIsLive(s)).toBe(false);
      }
    });
  });

  describe('the sweep', () => {
    it('converges the three missing §6.2 rows in one pass: dunning-to-cancel, plan-swap, and a live extend', async () => {
      const deps = makeDeps(
        [
          customer({ customer_id: 'c_cancel', external_subscription_id: 'sub_cancel' }),
          customer({ customer_id: 'c_swap', external_subscription_id: 'sub_swap' }),
          customer({ customer_id: 'c_extend', external_subscription_id: 'sub_extend' }),
        ],
        async (id) => {
          if (id === 'sub_cancel') return truth({ status: 'canceled' });
          if (id === 'sub_swap') return truth({ tier_id: 'tier_pro' });
          return truth({ current_period_end_ms: 9_000 });
        },
      );
      const out = await runSellerAccessReconcile(deps);
      expect(out).toMatchObject({ swept: 3, closed: 1, swapped: 1, extended: 1, unreadable: 0 });
      expect(deps.close).toHaveBeenCalledWith({
        customer_id: 'c_cancel', reason: 'cancelled', source_status: 'canceled',
      });
      expect(deps.swapTier).toHaveBeenCalledWith({ customer_id: 'c_swap', tier_id: 'tier_pro' });
      expect(deps.extend).toHaveBeenCalledWith({ customer_id: 'c_extend', access_expires_at: 9_000 });
    });

    it('⛔ ONE customer THROWING must not strand the rest — self-healing is the whole point', async () => {
      const deps = makeDeps(
        [
          customer({ customer_id: 'c_boom', external_subscription_id: 'sub_boom' }),
          customer({ customer_id: 'c_ok', external_subscription_id: 'sub_ok' }),
        ],
        async (id) => {
          if (id === 'sub_boom') throw new Error('stripe 500');
          return truth({ status: 'canceled' });
        },
      );
      const out = await runSellerAccessReconcile(deps);
      // The thrower is counted unreadable and NOT closed; the next customer
      // still converges.
      expect(out).toMatchObject({ swept: 2, unreadable: 1, closed: 1 });
      expect(deps.close).toHaveBeenCalledTimes(1);
      expect(deps.close).toHaveBeenCalledWith({
        customer_id: 'c_ok', reason: 'cancelled', source_status: 'canceled',
      });
    });

    it('⛔ a read that THROWS never closes the customer it threw on', async () => {
      const deps = makeDeps(
        [customer({ customer_id: 'c_boom', external_subscription_id: 'sub_boom' })],
        async () => {
          throw new Error('network');
        },
      );
      const out = await runSellerAccessReconcile(deps);
      expect(out).toMatchObject({ swept: 1, unreadable: 1, closed: 0 });
      expect(deps.close).not.toHaveBeenCalled();
    });

    it('a converge failure is retried next cycle, never fatal', async () => {
      const deps = makeDeps(
        [customer({ customer_id: 'c1', external_subscription_id: 'sub_1' })],
        async () => truth({ status: 'canceled' }),
      );
      deps.close.mockRejectedValueOnce(new Error('store busy'));
      await expect(runSellerAccessReconcile(deps)).resolves.toMatchObject({ swept: 1 });
    });
  });
});
