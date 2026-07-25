/** D-196 S4 — owner-clicked Stripe entitlement Initialize/Synchronize.
 *
 * Provider discovery rides the installed Stripe catalog's gated, audited,
 * paginated `entitlements-list` operation. Mutation begins only after the
 * gateway proves a complete walk. The local fold is incremental:
 *
 * - missing entitlements mint a zero-grant `customer_template` shell + tier;
 * - existing live templates and every authored grant/policy field are preserved;
 * - missing/inactive templates are recreated as fresh zero-grant shells;
 * - upstream-absent entitlements mark their tier inactive, never deleting the
 *   template or touching already-stamped customer contracts.
 */

import { randomUUID } from 'node:crypto';

import {
  CONTRACT_DEFINITION_SCOPE,
  isContractActive,
  isDoorType,
  type DoorType,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type SellerStripeSynchronizeRequest,
  type SellerStripeSynchronizeResponse,
} from '@recued/contracts';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createGatewayAuditEmitter } from '../server-executor.js';
import {
  getByDotPath,
  runGatedCatalogOperation,
  type RunGatedCatalogOperationFn,
} from '../source-mirror/fetch.js';
import {
  createContractDefinitionStore,
} from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ContractStore } from '../storage/contract-store.js';
import {
  resolveConnectionVendor,
} from '../storage/connection-store.js';
import type { SellerStore } from '../storage/seller-store.js';

import { mintCustomerTemplateShell } from './customer-template-shell.js';

export const STRIPE_ENTITLEMENT_CATALOG_SLUG = 'stripe-billing';
export const STRIPE_ENTITLEMENT_LIST_OPERATION = 'entitlements-list';
export const STRIPE_ENTITLEMENT_LIST_OPERATION_ID =
  'recued-core/stripe-billing.entitlements-list';

export const SELLER_STRIPE_SYNC_RECIPE: RecipeDefinition = {
  recipe_id: 'seller-stripe-entitlement-sync',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Seller Stripe entitlement synchronization',
    description:
      'Synthetic audit identity for the owner-clicked Stripe entitlement feature read.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

export interface SellerStripeConnectionOption {
  /** Connection that is enrolled, bound to the canonical Stripe catalog, and
   * currently grants the entitlement-list operation. */
  readonly name: string;
  readonly display_name: string;
}

export type SellerStripeDiscoveryFailureKind =
  | 'not_configured'
  | 'policy'
  | 'upstream';

export type SellerStripeFeatureDiscoveryOutcome =
  | { readonly ok: true; readonly records: readonly unknown[] }
  | {
      readonly ok: false;
      readonly kind: SellerStripeDiscoveryFailureKind;
      readonly reason: string;
    };

export interface SellerStripeEntitlementProvider {
  listConnections(): readonly SellerStripeConnectionOption[];
  listFeatures(input: {
    readonly connection_name: string;
    readonly execution_source: ExecutionSource;
  }): Promise<SellerStripeFeatureDiscoveryOutcome>;
}

export type SellerStripeSynchronizationErrorKind =
  | 'bad_request'
  | 'not_configured'
  | 'policy'
  | 'upstream'
  | 'conflict';

export class SellerStripeSynchronizationError extends Error {
  readonly kind: SellerStripeSynchronizationErrorKind;

  constructor(kind: SellerStripeSynchronizationErrorKind, detail: string) {
    super(`seller_stripe_sync_${kind}: ${detail}`);
    this.name = 'SellerStripeSynchronizationError';
    this.kind = kind;
  }
}

const providerFailure = (
  kind: SellerStripeDiscoveryFailureKind,
  reason: string,
): SellerStripeFeatureDiscoveryOutcome => ({ ok: false, kind, reason });

/** Build the production provider reader from the already-composed execute
 * gateway. Undefined means the server cannot honestly offer Stripe sync. */
export const createSellerStripeEntitlementProvider = (
  deps: Pick<
    ExecuteHandlerDeps,
    | 'executorConfig'
    | 'connectionOperationProfiles'
    | 'connectionStore'
    | 'auditLog'
    | 'contractScan'
  >,
  runOperation: RunGatedCatalogOperationFn = runGatedCatalogOperation,
): SellerStripeEntitlementProvider | undefined => {
  const profiles = deps.connectionOperationProfiles;
  const connectionStore = deps.connectionStore;
  if (!profiles || !connectionStore) return undefined;

  const canonicalManifest = (): IngredientManifest | null => {
    const manifest = deps.executorConfig.manifests.get(
      STRIPE_ENTITLEMENT_CATALOG_SLUG,
    ) as IngredientManifest | null | undefined;
    return manifest?.operations?.[STRIPE_ENTITLEMENT_LIST_OPERATION]?.operation_id
      === STRIPE_ENTITLEMENT_LIST_OPERATION_ID
      ? manifest
      : null;
  };
  const stripeConnections = (): SellerStripeConnectionOption[] => {
    if (!canonicalManifest()) return [];
    return connectionStore
      .list({ kind: 'api' })
      .filter((row) => {
        if (resolveConnectionVendor(row) !== 'stripe') return false;
        const profile = profiles.get(row.name);
        return profile?.catalog_slug === STRIPE_ENTITLEMENT_CATALOG_SLUG
          && profile.allowed_operations.includes(STRIPE_ENTITLEMENT_LIST_OPERATION);
      })
      .map((row) => ({ name: row.name, display_name: row.display_name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    listConnections: stripeConnections,
    async listFeatures(input) {
      const row = connectionStore.get('api', input.connection_name);
      if (!row || resolveConnectionVendor(row) !== 'stripe') {
        return providerFailure(
          'not_configured',
          `Stripe API connection '${input.connection_name}' is not enrolled`,
        );
      }

      const profile = profiles.get(input.connection_name);
      if (!profile || profile.catalog_slug !== STRIPE_ENTITLEMENT_CATALOG_SLUG) {
        return providerFailure(
          'not_configured',
          `connection '${input.connection_name}' is not bound to the installed Stripe catalog`,
        );
      }
      const manifest = canonicalManifest();
      if (!manifest) {
        return providerFailure(
          'not_configured',
          'the installed Stripe catalog does not expose the canonical entitlement-list operation',
        );
      }

      const invoked = await runOperation(
        {
          executorConfig: deps.executorConfig,
          profiles,
          getSubresourcePath: (connectionName) =>
            connectionStore.get('api', connectionName)?.subresource_path,
          ...(deps.auditLog
            ? { onGatewayAudit: createGatewayAuditEmitter(deps.auditLog) }
            : {}),
          ...(deps.contractScan ? { contractScan: deps.contractScan } : {}),
        },
        {
          connection_name: input.connection_name,
          manifest,
          catalogSlug: STRIPE_ENTITLEMENT_CATALOG_SLUG,
          operationKey: STRIPE_ENTITLEMENT_LIST_OPERATION,
          args: {},
          auditRecipe: SELLER_STRIPE_SYNC_RECIPE,
          stepId: 'entitlements_list',
          execution_source: input.execution_source,
          trigger_source: 'manual',
          askReason:
            'Stripe synchronization is owner-triggered, but the entitlement read is not granted on this connection',
        },
      );
      if (!invoked.ok) {
        return providerFailure(
          invoked.kind === 'policy'
            ? 'policy'
            : invoked.kind === 'config'
              ? 'not_configured'
              : 'upstream',
          invoked.reason,
        );
      }
      if (
        invoked.audit?.pages_fetched === undefined
        || invoked.audit.truncated === true
      ) {
        return providerFailure(
          'upstream',
          'Stripe entitlement discovery did not prove a complete paginated feature walk',
        );
      }
      const records = getByDotPath(invoked.raw, 'result.data');
      if (!Array.isArray(records)) {
        return providerFailure(
          'upstream',
          "Stripe entitlement discovery returned no feature array at 'result.data'",
        );
      }
      return { ok: true, records };
    },
  };
};

interface StripeEntitlementFeature {
  readonly id: string;
  readonly lookup_key: string;
  readonly name: string;
  readonly active: boolean;
  readonly livemode: boolean;
}

const requiredProviderString = (
  record: Record<string, unknown>,
  field: 'id' | 'lookup_key' | 'name',
  index: number,
): string => {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SellerStripeSynchronizationError(
      'upstream',
      `Stripe feature ${index} has no non-empty ${field}`,
    );
  }
  return value.trim();
};

const parseFeatures = (records: readonly unknown[]): StripeEntitlementFeature[] => {
  const features: StripeEntitlementFeature[] = [];
  const ids = new Set<string>();
  const lookupKeys = new Set<string>();
  for (const [index, value] of records.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SellerStripeSynchronizationError(
        'upstream',
        `Stripe feature ${index} is not an object`,
      );
    }
    const record = value as Record<string, unknown>;
    const id = requiredProviderString(record, 'id', index);
    const lookup_key = requiredProviderString(record, 'lookup_key', index);
    const name = requiredProviderString(record, 'name', index);
    if (typeof record.active !== 'boolean' || typeof record.livemode !== 'boolean') {
      throw new SellerStripeSynchronizationError(
        'upstream',
        `Stripe feature ${index} has invalid active/livemode flags`,
      );
    }
    if (ids.has(id) || lookupKeys.has(lookup_key)) {
      throw new SellerStripeSynchronizationError(
        'upstream',
        `Stripe returned a duplicate feature id or lookup_key at index ${index}`,
      );
    }
    ids.add(id);
    lookupKeys.add(lookup_key);
    if (record.active) {
      features.push({ id, lookup_key, name, active: true, livemode: record.livemode });
    }
  }
  return features.sort((a, b) => a.lookup_key.localeCompare(b.lookup_key));
};

const cleanRequestString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SellerStripeSynchronizationError(
      'bad_request',
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
};

const selectConnection = (
  provider: SellerStripeEntitlementProvider,
  requested: unknown,
): string => {
  const connections = provider.listConnections();
  if (connections.length === 0) {
    throw new SellerStripeSynchronizationError(
      'not_configured',
      'no synchronization-ready Stripe connection is available; install the pack, enroll the connection, and grant the entitlement read',
    );
  }
  if (requested !== undefined) {
    const connectionName = cleanRequestString(requested, 'connection_name');
    if (!connections.some((candidate) => candidate.name === connectionName)) {
      throw new SellerStripeSynchronizationError(
        'bad_request',
        `connection_name '${connectionName}' is not a synchronization-ready Stripe API connection`,
      );
    }
    return connectionName;
  }
  if (connections.length !== 1) {
      throw new SellerStripeSynchronizationError(
        'bad_request',
        'connection_name is required when more than one Stripe API connection is synchronization-ready',
      );
  }
  return connections[0]!.name;
};

export interface SynchronizeSellerStripeEntitlementsDeps {
  readonly sellerStore: SellerStore;
  readonly contractStore: ContractStore;
  readonly provider: SellerStripeEntitlementProvider;
  readonly now?: () => number;
  readonly newTierId?: () => string;
  readonly newContractId?: () => string;
  readonly mintedBy?: string;
}

/** Apply one complete provider snapshot atomically. */
export const synchronizeSellerStripeEntitlements = async (
  deps: SynchronizeSellerStripeEntitlementsDeps,
  request: SellerStripeSynchronizeRequest,
  execution_source: ExecutionSource,
): Promise<Omit<SellerStripeSynchronizeResponse, 'overview'>> => {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new SellerStripeSynchronizationError('bad_request', 'args must be an object');
  }
  const door_id = cleanRequestString(request.door_id, 'door_id');
  if (!isDoorType(request.door_type)) {
    throw new SellerStripeSynchronizationError(
      'bad_request',
      'door_type must be mcp, mcp_chat, or llm_gateway',
    );
  }
  const door_type: DoorType = request.door_type;
  const connection_name = selectConnection(deps.provider, request.connection_name);
  const discovered = await deps.provider.listFeatures({
    connection_name,
    execution_source,
  });
  if (!discovered.ok) {
    throw new SellerStripeSynchronizationError(discovered.kind, discovered.reason);
  }
  const features = parseFeatures(discovered.records);
  const featureKeys = new Set(features.map((feature) => feature.lookup_key));
  const syncNow = deps.now?.() ?? Date.now();
  const rawNewContractId = deps.newContractId
    ?? (() => `ct_${randomUUID()}`);
  const grantEntryStore = createContractGrantEntryStore(deps.contractStore);
  const definitionStore = createContractDefinitionStore(deps.contractStore, {
    now: () => syncNow,
    newId: () => {
      const contractId = cleanRequestString(
        rawNewContractId(),
        'generated contract_id',
      );
      if (
        deps.contractStore.get(CONTRACT_DEFINITION_SCOPE, [contractId])
        || grantEntryStore.listForContract(contractId).length > 0
        || deps.sellerStore.listTiers().some(
          (tier) => tier.template_contract_id === contractId,
        )
        || deps.sellerStore.listCustomers({ contract_id: contractId }).length > 0
      ) {
        throw new SellerStripeSynchronizationError(
          'conflict',
          `generated contract_id '${contractId}' is already in use`,
        );
      }
      return contractId;
    },
  });
  const newTierId = deps.newTierId ?? (() => `seller_tier_${randomUUID()}`);
  const created_tier_ids: string[] = [];
  const preserved_tier_ids: string[] = [];
  const recreated_template_tier_ids: string[] = [];
  const reactivated_tier_ids: string[] = [];
  const orphaned_tier_ids: string[] = [];

  const mintTemplateShell = (feature: StripeEntitlementFeature) =>
    mintCustomerTemplateShell(definitionStore, {
      minted_by: deps.mintedBy ?? 'server:seller:stripe-sync',
      display_name: `Stripe ${feature.name} customer template`,
      door_type,
    });

  try {
    deps.contractStore.transaction(() => {
      const existingTiers = deps.sellerStore.listTiers({ lifecycle_source: 'stripe' })
        .filter((tier) => tier.door_id === door_id);

      for (const feature of features) {
        const existing = deps.sellerStore.findTier({
          door_id,
          lifecycle_source: 'stripe',
          entitlement_key: feature.lookup_key,
        });
        if (!existing) {
          const template = mintTemplateShell(feature);
          const tier = deps.sellerStore.upsertTier({
            tier_id: cleanRequestString(newTierId(), 'generated tier_id'),
            door_id,
            lifecycle_source: 'stripe',
            entitlement_key: feature.lookup_key,
            display_name: feature.name,
            template_contract_id: template.contract_id,
            external_entitlement_id: feature.id,
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
          throw new SellerStripeSynchronizationError(
            'conflict',
            `tier '${existing.tier_id}' references non-template contract '${template.contract_id}'`,
          );
        }
        const needsTemplate = !template || !isContractActive(template, syncNow);
        const replacement = needsTemplate ? mintTemplateShell(feature) : null;
        deps.sellerStore.upsertTier({
          tier_id: existing.tier_id,
          door_id,
          lifecycle_source: 'stripe',
          entitlement_key: feature.lookup_key,
          ...(replacement ? { template_contract_id: replacement.contract_id } : {}),
          external_entitlement_id: feature.id,
          active: true,
          now: syncNow,
        });
        preserved_tier_ids.push(existing.tier_id);
        if (replacement) recreated_template_tier_ids.push(existing.tier_id);
        if (!existing.active) reactivated_tier_ids.push(existing.tier_id);
      }

      for (const tier of existingTiers) {
        if (featureKeys.has(tier.entitlement_key) || !tier.active) continue;
        deps.sellerStore.upsertTier({
          tier_id: tier.tier_id,
          door_id,
          lifecycle_source: 'stripe',
          entitlement_key: tier.entitlement_key,
          active: false,
          now: syncNow,
        });
        orphaned_tier_ids.push(tier.tier_id);
      }
    });
  } catch (error) {
    if (error instanceof SellerStripeSynchronizationError) throw error;
    throw new SellerStripeSynchronizationError(
      'conflict',
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    connection_name,
    features_seen: features.length,
    created_tier_ids,
    preserved_tier_ids,
    recreated_template_tier_ids,
    reactivated_tier_ids,
    orphaned_tier_ids,
  };
};
