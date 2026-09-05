/** D-196 — the incremental tier fold every provider synchronization shares.
 *
 *  Extracted from `stripe-entitlement-sync.ts` (2026-09-03) when Paddle and
 *  Lemon Squeezy joined: the provider half differs per vendor (what is read,
 *  through which catalog, what a "tier identity" is), the LOCAL half does not.
 *  Given one complete provider snapshot of entitlement records for one door:
 *
 *  - a record with no tier mints a zero-grant `customer_template` shell + tier;
 *  - an existing tier keeps its template and every authored grant/policy field,
 *    and is re-activated if it was orphaned;
 *  - a tier whose template is missing or inactive gets a fresh zero-grant shell;
 *  - a live tier whose record is gone upstream is marked inactive — never
 *    deleted, and already-stamped customer contracts are never touched.
 *
 *  Runs inside ONE contract-store transaction. Conflicts (a generated id in
 *  use, a tier pointing at a non-template contract) throw
 *  `SellerTierFoldConflictError`; the caller maps it to its own error kind. */
import { randomUUID } from 'node:crypto';

import {
  CONTRACT_DEFINITION_SCOPE,
  isContractActive,
  type DoorType,
  type SellerLifecycleSource,
} from '@recued/contracts';

import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import type { SellerStore } from '../storage/seller-store.js';

import { mintCustomerTemplateShell } from './customer-template-shell.js';

/** One provider-side identity a tier is keyed on. `key` becomes the tier's
 *  `entitlement_key` (Stripe: the feature `lookup_key`; Paddle / Lemon
 *  Squeezy: the product id), `external_id` its `external_entitlement_id`. */
export interface ProviderEntitlementRecord {
  readonly key: string;
  readonly name: string;
  readonly external_id: string;
}

export class SellerTierFoldConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'SellerTierFoldConflictError';
  }
}

export interface FoldProviderEntitlementTiersInput {
  readonly sellerStore: SellerStore;
  readonly contractStore: ContractStore;
  readonly lifecycle_source: SellerLifecycleSource;
  readonly door_id: string;
  readonly door_type: DoorType;
  /** The COMPLETE provider snapshot — the caller must have proven the walk. */
  readonly records: readonly ProviderEntitlementRecord[];
  readonly now: number;
  readonly mintedBy: string;
  readonly templateDisplayName: (record: ProviderEntitlementRecord) => string;
  readonly newTierId?: () => string;
  readonly newContractId?: () => string;
  /** The caller's request-string cleaner, so a generated id that comes back
   *  empty is refused in the caller's own error vocabulary. */
  readonly cleanId: (value: unknown, field: string) => string;
}

export interface FoldProviderEntitlementTiersOutcome {
  readonly created_tier_ids: readonly string[];
  readonly preserved_tier_ids: readonly string[];
  readonly recreated_template_tier_ids: readonly string[];
  readonly reactivated_tier_ids: readonly string[];
  readonly orphaned_tier_ids: readonly string[];
}

export const foldProviderEntitlementTiers = (
  input: FoldProviderEntitlementTiersInput,
): FoldProviderEntitlementTiersOutcome => {
  const { sellerStore, contractStore, lifecycle_source, door_id, now: syncNow } = input;
  const recordKeys = new Set(input.records.map((record) => record.key));
  const rawNewContractId = input.newContractId ?? (() => `ct_${randomUUID()}`);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const definitionStore = createContractDefinitionStore(contractStore, {
    now: () => syncNow,
    newId: () => {
      const contractId = input.cleanId(rawNewContractId(), 'generated contract_id');
      if (
        contractStore.get(CONTRACT_DEFINITION_SCOPE, [contractId])
        || grantEntryStore.listForContract(contractId).length > 0
        || sellerStore.listTiers().some(
          (tier) => tier.template_contract_id === contractId,
        )
        || sellerStore.listCustomers({ contract_id: contractId }).length > 0
      ) {
        throw new SellerTierFoldConflictError(
          `generated contract_id '${contractId}' is already in use`,
        );
      }
      return contractId;
    },
  });
  const newTierId = input.newTierId ?? (() => `seller_tier_${randomUUID()}`);
  const created_tier_ids: string[] = [];
  const preserved_tier_ids: string[] = [];
  const recreated_template_tier_ids: string[] = [];
  const reactivated_tier_ids: string[] = [];
  const orphaned_tier_ids: string[] = [];

  const mintTemplateShell = (record: ProviderEntitlementRecord) =>
    mintCustomerTemplateShell(definitionStore, {
      minted_by: input.mintedBy,
      display_name: input.templateDisplayName(record),
      door_type: input.door_type,
    });

  contractStore.transaction(() => {
    const existingTiers = sellerStore.listTiers({ lifecycle_source })
      .filter((tier) => tier.door_id === door_id);

    for (const record of input.records) {
      const existing = sellerStore.findTier({
        door_id,
        lifecycle_source,
        entitlement_key: record.key,
      });
      if (!existing) {
        const template = mintTemplateShell(record);
        const tier = sellerStore.upsertTier({
          tier_id: input.cleanId(newTierId(), 'generated tier_id'),
          door_id,
          lifecycle_source,
          entitlement_key: record.key,
          display_name: record.name,
          template_contract_id: template.contract_id,
          external_entitlement_id: record.external_id,
          usage_policy_json: {},
          customer_status_enabled_default: false,
          active: true,
          now: syncNow,
        });
        created_tier_ids.push(tier.tier_id);
        continue;
      }

      const template = definitionStore.get(existing.template_contract_id);
      if (template && template.grant_kind !== 'customer_template') {
        throw new SellerTierFoldConflictError(
          `tier '${existing.tier_id}' references non-template contract '${template.contract_id}'`,
        );
      }
      const needsTemplate = !template || !isContractActive(template, syncNow);
      const replacement = needsTemplate ? mintTemplateShell(record) : null;
      sellerStore.upsertTier({
        tier_id: existing.tier_id,
        door_id,
        lifecycle_source,
        entitlement_key: record.key,
        ...(replacement ? { template_contract_id: replacement.contract_id } : {}),
        external_entitlement_id: record.external_id,
        active: true,
        now: syncNow,
      });
      preserved_tier_ids.push(existing.tier_id);
      if (replacement) recreated_template_tier_ids.push(existing.tier_id);
      if (!existing.active) reactivated_tier_ids.push(existing.tier_id);
    }

    for (const tier of existingTiers) {
      if (recordKeys.has(tier.entitlement_key) || !tier.active) continue;
      sellerStore.upsertTier({
        tier_id: tier.tier_id,
        door_id,
        lifecycle_source,
        entitlement_key: tier.entitlement_key,
        active: false,
        now: syncNow,
      });
      orphaned_tier_ids.push(tier.tier_id);
    }
  });

  return {
    created_tier_ids,
    preserved_tier_ids,
    recreated_template_tier_ids,
    reactivated_tier_ids,
    orphaned_tier_ids,
  };
};
