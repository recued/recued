/** D-196 §6.3 — the wiring that makes the reconciler-as-authority LIVE.
 *
 *  `housekeeping/tasks/seller-access-reconcile.ts` is the POLICY: pure, no IO,
 *  no clock. This module is its other half — the concrete
 *  `SellerAccessReconcileDeps` that policy runs on:
 *
 *    - `listSubscriptionCustomers` → the seller store's subscription-backed,
 *      still-open rows for ONE lifecycle source;
 *    - `readProviderTruth`         → the provider's truth, read through the
 *                                    installed `seller-stripe` catalog: the
 *                                    subscription's status/period, plus (s2c)
 *                                    the tier implied by the customer's ACTIVE
 *                                    ENTITLEMENTS;
 *    - `extend` / `swapTier` / `close` → `createSellerCustomerAccessLifecycle`,
 *                                    the same service the kernel ops are backed
 *                                    by.
 *
 *  ── s2c: why the swap lane reads ENTITLEMENTS, not the subscription ────────
 *  §6.2's swap axis is the entitlement ("swap_tier when entitlement changes",
 *  with `entitlements.active_entitlement_summary.updated` the "preferred
 *  signal"), and that is not a stylistic preference: the provider's entitlement
 *  `lookup_key`s ARE our `entitlement_key` vocabulary, because
 *  `stripe-entitlement-sync.ts` mints one tier per feature keyed on exactly that
 *  field. The subscription object's own plan identity
 *  (`items.data[].price.{id,product}`) shares NO vocabulary with a tier — there
 *  is no price→tier edge anywhere in the repo — so it cannot answer this
 *  question at all, and feeding it in would make every customer look swapped
 *  every cycle.
 *
 *  ⚠ The entitlement read is CUSTOMER-scoped (`query.customer` is its only arg),
 *  so its result spans every subscription, product and door that Stripe customer
 *  has — and one product can carry many features, so "one subscription" is not
 *  "one entitlement". That is why the resolution is a MEMBERSHIP test narrowed to
 *  the customer's own door, never a count. See `resolveProviderTierId`, which
 *  owns that judgment.
 *
 *  ── Why the provider read goes through the GATEWAY, and why that is safe ───
 *  The read rides `runGatedCatalogOperation` with **no `execution_source`**, and
 *  `trigger_source: 'housekeeping'`. Both halves of that are deliberate:
 *
 *  - NO `execution_source` ⇒ `resolveTrustCeiling` is never consulted, and the
 *    dispatch takes `CONTRACTED_DEFAULT_TRUST_CEILING` (`'read'`) — reads admit,
 *    writes HOLD (`catalog-gateway.ts`, D-209 §1.4). `subscription.read` is
 *    `risk: 'read'` / `approval: 'never'`, so it admits; this module performs no
 *    gated writes at all (access changes go through the lifecycle service, which
 *    is a plain server-side call and never touches the gate).
 *
 *  - ⛔ It must NOT pass `execution_source: { channel: 'housekeeping', … }`.
 *    That is the ONE input that arms `resolveTrustCeiling`'s last line
 *    (`source.channel === 'housekeeping' ? CONTRACT_LESS_TRUST_CEILING : …`),
 *    which resolves to `'admin'` — write- and admin-risk ops running silent.
 *    Nothing in the codebase dispatches that channel today, which is exactly why
 *    that branch is dead code, and D-209 follow-on #2 says to build the
 *    housekeeping bypass WITH that surface as its own deliberate slice — never
 *    to summon it as a side effect of a reconciler. (Destructive is unaffected
 *    either way: it is always-class and asks at every ceiling.) The `read`
 *    ceiling this module takes is strictly tighter than what it needs.
 *
 *  - `trigger_source` is a free-form label that does NOT feed the ceiling, so it
 *    carries the honest origin (`'housekeeping'`) into the audit row rather than
 *    letting it default to `'reactive'`. Honest provenance, no authority.
 *
 *  The alternative — a raw `ConnectionLookup` + a hand-rolled HTTP call — was
 *  rejected: it would fork the Stripe URL, auth, and request schema into a
 *  second place that drifts from the pack, and it would leave a MONEY path's
 *  provider reads out of the audit log entirely. `stripe-entitlement-sync.ts` —
 *  same feature, same vendor — already reads Stripe through this exact helper;
 *  this module mirrors its shape deliberately.
 *
 *  Spec: `docs/d-196-spec.md` §6.2 (the event table) + §6.3 (the reconciler). */

import type {
  IngredientManifest,
  RecipeDefinition,
  SellerCustomerCloseReason,
  SellerLifecycleSource,
} from '@recued/contracts';

import {
  providerStatusIsLive,
  resolveProviderTierId,
  type ProviderSubscriptionTruth,
  type ReconcilableCustomer,
  type SellerAccessReconcileDeps,
} from '../housekeeping/tasks/seller-access-reconcile.js';
import {
  runGatedCatalogOperation,
  type RunGatedCatalogOperationFn,
} from '../source-mirror/fetch.js';
import { createGatewayAuditEmitter } from '../server-executor.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import { resolveConnectionVendor } from '../storage/connection-store.js';
import type { SellerClaimStore } from '../storage/seller-claim-store.js';
import type { SellerStore } from '../storage/seller-store.js';
import { createSellerCustomerAccessLifecycle } from './customer-access-lifecycle.js';

/** The lifecycle source v1 converges. A single-source constant rather than a
 *  parameter: the reader below speaks exactly one provider's API, and the pair
 *  must move together. */
export const SELLER_RECONCILE_LIFECYCLE_SOURCE: SellerLifecycleSource = 'stripe';

export const SELLER_STRIPE_CATALOG_SLUG = 'seller-stripe';
export const SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION = 'subscription.read';
/** The canonical operations the pack compiles to
 *  (`decomposer.ts`: `${author}/${slug}.${op}`). Pinned so a LOOK-ALIKE catalog
 *  installed under the same slug cannot silently become the authority for the
 *  seller's money. [[feedback_a_trusted_source_is_not_a_trusted_subject]] */
export const SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID =
  'recued-core/seller-stripe.subscription.read';

/** D-196 s2c — the entitlement read behind the swap lane. §6.2's swap axis is the
 *  ENTITLEMENT, and its `lookup_key`s are our `entitlement_key` vocabulary. */
export const SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION = 'active_entitlement.search';
export const SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION_ID =
  'recued-core/seller-stripe.active_entitlement.search';

/** Synthetic audit identity for the reconciler's provider reads — the same
 *  device `stripe-entitlement-sync.ts` uses for its owner-clicked read. This is
 *  an audit label, not an execution grant. */
export const SELLER_ACCESS_RECONCILE_RECIPE: RecipeDefinition = {
  recipe_id: 'seller-access-reconcile',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Seller access reconciliation',
    description:
      'Synthetic audit identity for the housekeeping re-read of a seller '
      + "customer's subscription state from the payment provider.",
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

export interface SellerAccessReconcileWiringDeps {
  readonly sellerStore: SellerStore;
  readonly contractStore: ContractStore;
  readonly inboundTokenStore: ChatInboundTokenStore;
  /** ⛔ NOT optional in production, despite `createSellerCustomerAccessLifecycle`
   *  treating it as such. `closeCustomer` revokes outstanding one-time claims via
   *  `sellerClaimStore?.revokeCustomerClaims(...)` — an OPTIONAL call. Omit the
   *  store and a close still revokes the bearer and the contract, but leaves the
   *  customer's outstanding claim link redeemable: a close that does not fully
   *  close. [[feedback_complete_the_fence_dont_predict_the_default]] */
  readonly sellerClaimStore: SellerClaimStore;
  readonly executorConfig: SourceMirrorDeps['executorConfig'];
  readonly connectionOperationProfiles: SourceMirrorDeps['profiles'];
  readonly connectionStore: {
    get(kind: 'api', name: string): ConnectionRow | null | undefined;
    list(query: { kind: 'api' }): readonly ConnectionRow[];
  };
  readonly auditLog?: Parameters<typeof createGatewayAuditEmitter>[0];
  readonly contractScan?: SourceMirrorDeps['contractScan'];
  readonly now?: () => number;
  /** Test seam — substitute the gated invoke. Production omits it. */
  readonly runOperation?: RunGatedCatalogOperationFn;
}

type SourceMirrorDeps = Parameters<RunGatedCatalogOperationFn>[0];

interface ConnectionRow {
  readonly name: string;
  readonly display_name: string;
  readonly config_json: string;
  readonly subtype?: string | null;
  readonly subresource_path?: string | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Stripe timestamps arrive as unix SECONDS, and the pack pins
 *  `response_json.unsafe_integers: 'string'`, so a numeric field can legitimately
 *  land as a string. Coerce explicitly and reject anything not finite — a NaN
 *  multiplied by 1000 is still NaN, and `reconcileOne`'s `>` against it is
 *  `false`, which would read as "already converged" rather than "unreadable". */
const secondsToMs = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.trunc(seconds * 1000);
};

/** Narrow the provider's raw subscription object to the truth convergence needs.
 *  Returns null for anything we cannot vouch for — and per `reconcileOne`, null
 *  means "unreadable", i.e. leave the customer ALONE. That is the whole reason
 *  this returns null rather than a partial: an unverified shape must never be
 *  able to close a paying customer. */
export const parseSubscriptionTruth = (
  raw: unknown,
  expected_subscription_id: string,
): ProviderSubscriptionTruth | null => {
  const envelope = asRecord(raw);
  const result = asRecord(envelope?.result) ?? envelope;
  if (!result) return null;

  // Object-kind + id proof, mirroring the `subscription_proof_exact` gate in
  // `issue-access-for-paid-order.json`. A response for a DIFFERENT subscription
  // must never converge this customer.
  if (result.object !== 'subscription') return null;
  if (result.id !== expected_subscription_id) return null;
  if (typeof result.status !== 'string' || result.status.length === 0) return null;

  // ⚠ `current_period_end` lives on the subscription ITEM, not the subscription
  // (Stripe moved it), which is why the recipes read
  // `items.data.0.current_period_end` and gate on there being exactly ONE item.
  // With 0 or 2+ items there is no single period that governs, so the period is
  // UNKNOWN — not zero, not the first one's. We still return the status, so an
  // ended multi-item subscription can still close; only `extend` goes quiet.
  const items = asRecord(result.items);
  const data = Array.isArray(items?.data) ? items.data : undefined;
  const current_period_end_ms = data?.length === 1
    ? secondsToMs(asRecord(data[0])?.current_period_end)
    : undefined;

  return {
    status: result.status,
    ...(current_period_end_ms !== undefined ? { current_period_end_ms } : {}),
    // `tier_id` is NOT resolved here: it comes from the customer's ACTIVE
    // ENTITLEMENTS (a separate, customer-scoped read), never from this
    // subscription object. ⛔ In particular NOT from `items.data[].price.{id,
    // product}` — a price id shares no vocabulary with a local tier.
  };
};

/** The Stripe customer this subscription belongs to (`result.customer`) — the
 *  arg the entitlement read needs. Taken from the SAME read that proved the
 *  subscription's identity, so it needs no extra call and cannot drift from it.
 *  `renew-subscription-access-order.json` sources `source_customer_id` the same
 *  way. */
export const parseSubscriptionCustomerId = (raw: unknown): string | undefined => {
  const envelope = asRecord(raw);
  const result = asRecord(envelope?.result) ?? envelope;
  const customer = result?.customer;
  // Stripe returns either the id or an expanded object; the pack expands
  // nothing, so anything but a `cus_…` string is not something to guess at.
  return typeof customer === 'string' && customer.startsWith('cus_')
    ? customer
    : undefined;
};

/** Pluck the active entitlement `lookup_key`s. The op declares
 *  `result_path: 'data'` + cursor pagination, so the gateway hands back the
 *  merged array. Mirrors `issue-access-for-paid-order.json`'s
 *  `pluck lookup_key` — the same field, read the same way. */
export const parseActiveEntitlementKeys = (raw: unknown): string[] => {
  const envelope = asRecord(raw);
  const result = (envelope?.result ?? envelope) as unknown;
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(asRecord(result)?.data)
      ? (asRecord(result)!.data as unknown[])
      : [];
  return rows.flatMap((row) => {
    const key = asRecord(row)?.lookup_key;
    return typeof key === 'string' && key.length > 0 ? [key] : [];
  });
};

/** Resolve the ONE Stripe connection this sweep reads through.
 *
 *  Mirrors `stripe-entitlement-sync.ts`'s `selectConnection`, with the one
 *  difference that matters: there, >1 candidate asks the OWNER to name it. A
 *  housekeeping cycle has nobody to ask, and picking one would mean converging a
 *  seller's customers against an arbitrary Stripe account. So ambiguity yields
 *  NOTHING — the same posture the policy takes for an unknown status.
 *  [[feedback_substrate_enforces_humans_judge]] */
export const selectReconcileConnection = (
  candidates: readonly { name: string }[],
): string | null => (candidates.length === 1 ? candidates[0]!.name : null);

export const createSellerAccessReconcileDeps = (
  deps: SellerAccessReconcileWiringDeps,
): SellerAccessReconcileDeps => {
  const now = deps.now ?? (() => Date.now());
  const runOperation = deps.runOperation ?? runGatedCatalogOperation;

  // No `buildClaimPayload` / `requireClaimOnTokenIssue`: those exist for the
  // token-ISSUING paths (`issueCustomer` / `reissueCustomerToken`), and this
  // sweep calls neither. `sellerClaimStore` is still required — `closeCustomer`
  // uses it to revoke outstanding claims (see the dep's comment).
  const lifecycle = createSellerCustomerAccessLifecycle({
    sellerStore: deps.sellerStore,
    contractStore: deps.contractStore,
    grantEntryStore: createContractGrantEntryStore(deps.contractStore),
    inboundTokenStore: deps.inboundTokenStore,
    sellerClaimStore: deps.sellerClaimStore,
    mintedBy: 'server:seller:reconcile',
    now,
    transaction: (fn) => deps.contractStore.transaction(fn),
  });

  /** The installed catalog, only if it is really the pack we mean. */
  const canonicalManifest = (): IngredientManifest | null => {
    const manifest = deps.executorConfig.manifests.get(
      SELLER_STRIPE_CATALOG_SLUG,
    ) as IngredientManifest | null | undefined;
    return manifest?.operations?.[SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]
      ?.operation_id === SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID
      ? manifest
      : null;
  };

  /** Connections enrolled against that catalog WITH the read granted. The grant
   *  filter is not decoration: the gate would refuse an ungranted op anyway, so
   *  including one here would only manufacture a per-cycle denial.
   *
   *  ⛔ Gates on `subscription.read` ALONE — the sweep's floor. The s2c
   *  entitlement read is checked separately (`entitlementReadAvailable`) so its
   *  absence costs only the swap lane, never the whole sweep. */
  const readyConnections = (): { name: string }[] => {
    if (!canonicalManifest()) return [];
    return deps.connectionStore
      .list({ kind: 'api' })
      .filter((row) => {
        if (resolveConnectionVendor(row) !== 'stripe') return false;
        const profile = deps.connectionOperationProfiles.get(row.name);
        return profile?.catalog_slug === SELLER_STRIPE_CATALOG_SLUG
          && profile.allowed_operations.includes(
            SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION,
          );
      })
      .map((row) => ({ name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  /** Is the s2c swap lane's read both DECLARED by the installed pack and GRANTED
   *  on the connection? Same look-alike pin as the subscription read. */
  const entitlementReadAvailable = (): boolean => {
    const manifest = canonicalManifest();
    if (
      manifest?.operations?.[SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION]
        ?.operation_id !== SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION_ID
    ) {
      return false;
    }
    const connection_name = selectReconcileConnection(readyConnections());
    if (connection_name === null) return false;
    return deps.connectionOperationProfiles
      .get(connection_name)
      ?.allowed_operations
      .includes(SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION) ?? false;
  };

  /** One gated provider read. The gateway-call shape lives here once so the two
   *  reads cannot drift on the part that matters — see this module's header for
   *  why there is no `execution_source`. */
  const gatedRead = (input: {
    connection_name: string;
    manifest: IngredientManifest;
    operationKey: string;
    stepId: string;
    args: Record<string, unknown>;
  }) =>
    runOperation(
      {
        executorConfig: deps.executorConfig,
        profiles: deps.connectionOperationProfiles,
        getSubresourcePath: (name: string) =>
          deps.connectionStore.get('api', name)?.subresource_path,
        ...(deps.auditLog
          ? { onGatewayAudit: createGatewayAuditEmitter(deps.auditLog) }
          : {}),
        ...(deps.contractScan ? { contractScan: deps.contractScan } : {}),
      },
      {
        connection_name: input.connection_name,
        manifest: input.manifest,
        catalogSlug: SELLER_STRIPE_CATALOG_SLUG,
        operationKey: input.operationKey,
        args: input.args,
        auditRecipe: SELLER_ACCESS_RECONCILE_RECIPE,
        stepId: input.stepId,
        // ⛔ NO `execution_source` — see this module's header. Absent ⇒ the LOW
        // `read` ceiling, and the `housekeeping → admin` branch stays dead.
        trigger_source: 'housekeeping',
      },
    );

  return {
    async listSubscriptionCustomers(): Promise<ReadonlyArray<ReconcilableCustomer>> {
      // No connection ⇒ no truth to converge against, so do not even enumerate.
      // A sweep that lists customers it can never read would count every one of
      // them `unreadable` forever, which reads as breakage rather than as
      // "this server does not sell through Stripe".
      if (selectReconcileConnection(readyConnections()) === null) return [];
      return deps.sellerStore
        .listOpenSubscriptionCustomers({
          lifecycle_source: SELLER_RECONCILE_LIFECYCLE_SOURCE,
        })
        .flatMap((row) =>
          row.external_subscription_id === null
            ? []
            : [{
                customer_id: row.customer_id,
                external_subscription_id: row.external_subscription_id,
                tier_id: row.tier_id,
                ...(row.current_period_end !== null
                  ? { access_expires_at: row.current_period_end }
                  : {}),
              }],
        );
    },

    async readProviderTruth(
      local: ReconcilableCustomer,
    ): Promise<ProviderSubscriptionTruth | null> {
      const manifest = canonicalManifest();
      const connection_name = selectReconcileConnection(readyConnections());
      if (!manifest || connection_name === null) return null;

      const invoked = await gatedRead({
        connection_name,
        manifest,
        operationKey: SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION,
        stepId: 'subscription_read',
        args: { subscription_id: local.external_subscription_id },
      });
      // ⛔ Every failure — policy, config, transport — collapses to null, i.e.
      // UNREADABLE, i.e. leave the customer alone. A gateway `deny` is emphatically
      // not evidence that a subscription ended.
      if (!invoked.ok) return null;
      const truth = parseSubscriptionTruth(invoked.raw, local.external_subscription_id);
      if (truth === null) return null;

      // ── s2c: the swap axis. Only for a LIVE subscription: a customer about to
      // close has no plan to converge, so spending a second provider call per
      // cycle on them buys nothing. `providerStatusIsLive` is imported from the
      // policy rather than re-listed here — one status vocabulary, one owner.
      if (!providerStatusIsLive(truth.status)) return truth;
      // The swap lane degrades on its own: an ungranted / undeclared entitlement
      // read leaves `tier_id` absent, so the swap branch cannot fire while extend
      // and close keep working. ⛔ Do NOT hoist this into `readyConnections()` —
      // that would make a seller who granted only `subscription.read` lose the
      // WHOLE sweep rather than just its newest lane.
      if (!entitlementReadAvailable()) return truth;
      const stripe_customer_id = parseSubscriptionCustomerId(invoked.raw);
      if (stripe_customer_id === undefined) return truth;

      const entitlements = await gatedRead({
        connection_name,
        manifest,
        operationKey: SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION,
        stepId: 'active_entitlement_search',
        args: { 'query.customer': stripe_customer_id },
      });
      // Same posture: an unreadable entitlement list is not evidence of anything.
      // Keep the status/period truth we DID prove and leave the tier unresolved.
      if (!entitlements.ok) return truth;

      const tier = local.tier_id !== undefined
        ? deps.sellerStore.getTier(local.tier_id)
        : null;
      if (!tier) return truth;
      const tier_id = resolveProviderTierId({
        local_tier_id: local.tier_id,
        local_entitlement_key: tier.entitlement_key,
        active_entitlement_keys: parseActiveEntitlementKeys(entitlements.raw),
        // Narrow to the customer's OWN door: the entitlement read is
        // CUSTOMER-scoped, so it spans every door this Stripe customer is on.
        door_tiers: deps.sellerStore.listTiers({
          door_id: tier.door_id,
          lifecycle_source: SELLER_RECONCILE_LIFECYCLE_SOURCE,
        }),
      });
      return tier_id !== undefined ? { ...truth, tier_id } : truth;
    },

    async extend(input: { customer_id: string; access_expires_at: number }): Promise<void> {
      lifecycle.extendCustomer({
        customer_id: input.customer_id,
        current_period_end: input.access_expires_at,
      });
    },

    async swapTier(input: { customer_id: string; tier_id: string }): Promise<void> {
      // ⚠ The verdict names a `tier_id` (that is the vocabulary `reconcileOne`
      // compares in), but `swapCustomerTier` addresses tiers by
      // `entitlement_key` — the recipe-facing identity that survives a re-sync
      // while row ids do not. Translate at the seam, and refuse rather than
      // guess if the row has vanished between the read and the write.
      const tier = deps.sellerStore.getTier(input.tier_id);
      if (!tier) {
        throw new Error(
          `seller-access-reconcile: tier '${input.tier_id}' vanished before the `
          + `swap for customer '${input.customer_id}'`,
        );
      }
      lifecycle.swapCustomerTier({
        customer_id: input.customer_id,
        entitlement_key: tier.entitlement_key,
      });
    },

    async close(input: {
      customer_id: string;
      reason: SellerCustomerCloseReason;
      source_status: string;
    }): Promise<void> {
      lifecycle.closeCustomer({
        customer_id: input.customer_id,
        reason: input.reason,
        // The provider's own word travels verbatim from the read that produced
        // the verdict — never reconstructed from `reason`. `closeCustomer` hands
        // it to the seller's status policy, which may still choose grace over an
        // immediate close (§6.2): that policy is the seller's to set, and this
        // sweep's job is to give it true evidence, not to pre-empt it.
        source_status: input.source_status,
      });
    },

    now,
  };
};

/** D-196 §6.3 (s2b) — build the reconciler deps from the two substrates the boot
 *  wire holds, or return `undefined` when the seller half is not composed.
 *
 *  Split from `createSellerAccessReconcileDeps` so the ONE place with both the
 *  seller stores and the gateway spine (`start-post-listener-runtime`) does not
 *  have to know the constructor's full shape, and so the "is the seller
 *  substrate present?" question is answered in ONE place rather than at the call
 *  site. Returns `undefined` — not a throw — because a boot without the seller
 *  substrate (a dbless harness, a server that does not sell) is a normal state,
 *  and the composer simply does not register the task then.
 *
 *  ⛔ The gateway-spine fields are checked, not assumed present: on
 *  `ExecuteHandlerDeps` only `executorConfig` is required; the profiles and
 *  connection store are optional, and the reader dereferences BOTH. A missing
 *  one is not "degrade the swap lane" — it is "there is no gated read at all",
 *  so the whole reconciler stays unregistered rather than registering a task
 *  that can only ever count every customer unreadable.
 *  [[feedback_complete_the_fence_dont_predict_the_default]] */
export interface SellerAccessReconcileGatewayDeps {
  readonly executorConfig: SellerAccessReconcileWiringDeps['executorConfig'];
  readonly connectionOperationProfiles?: SellerAccessReconcileWiringDeps['connectionOperationProfiles'];
  readonly connectionStore?: SellerAccessReconcileWiringDeps['connectionStore'];
  readonly auditLog?: SellerAccessReconcileWiringDeps['auditLog'];
  readonly contractScan?: SellerAccessReconcileWiringDeps['contractScan'];
}

export interface SellerAccessReconcileSellerDeps {
  readonly sellerStore?: SellerStore;
  readonly contractStore?: ContractStore;
  readonly inboundTokenStore?: ChatInboundTokenStore;
  readonly sellerClaimStore?: SellerClaimStore;
}

export const buildSellerAccessReconcileDepsIfReady = (input: {
  readonly gateway: SellerAccessReconcileGatewayDeps;
  readonly seller: SellerAccessReconcileSellerDeps;
}): SellerAccessReconcileDeps | undefined => {
  const { seller, gateway } = input;
  if (
    !seller.sellerStore
    || !seller.contractStore
    || !seller.inboundTokenStore
    // ⛔ Required in production even though the lifecycle types it optional — a
    // close must fully close (revoke the outstanding claim), so no claim store
    // means no reconciler rather than a reconciler that half-closes.
    || !seller.sellerClaimStore
    // The gated read cannot run without both of these; see this function's note.
    || !gateway.connectionOperationProfiles
    || !gateway.connectionStore
  ) {
    return undefined;
  }
  return createSellerAccessReconcileDeps({
    sellerStore: seller.sellerStore,
    contractStore: seller.contractStore,
    inboundTokenStore: seller.inboundTokenStore,
    sellerClaimStore: seller.sellerClaimStore,
    executorConfig: gateway.executorConfig,
    connectionOperationProfiles: gateway.connectionOperationProfiles,
    connectionStore: gateway.connectionStore,
    ...(gateway.auditLog ? { auditLog: gateway.auditLog } : {}),
    ...(gateway.contractScan ? { contractScan: gateway.contractScan } : {}),
  });
};
