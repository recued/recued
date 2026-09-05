/** D-196 consolidation (2026-09-03) — the ONE owner-clicked tier seed:
 *  Initialize / Synchronize for every provider in `SELLER_PROVIDERS`.
 *
 *  Each provider has a durable TIER IDENTITY that a subscription carries and
 *  that prices do not: Stripe's entitlement FEATURE (`lookup_key`); Paddle's
 *  and Lemon Squeezy's PRODUCT (prices and variants hang off it and churn). A
 *  tier's `entitlement_key` is that identity, `external_entitlement_id` the
 *  provider's own id for it, and every lane that resolves a tier — fulfilment,
 *  the swap lane, the housekeeping sweep — compares the subscription's
 *  identity against that key. Sellers do not type keys: they press Synchronize
 *  and the provider's catalogue becomes tiers.
 *
 *  One seam, one fold, three provider rows. Discovery rides the provider's
 *  bounded seller catalog (`seller-stripe` / `seller-paddle` /
 *  `seller-lemonsqueezy`, never a vendor's full API pack) through the gated,
 *  audited `runGatedCatalogOperation` with the owner as execution source, and
 *  mutation begins only after the walk is proven complete. The local fold is
 *  `foldProviderEntitlementTiers`. Before this module there were two parallel
 *  stacks (a Stripe entitlement sync and a Paddle / Lemon Squeezy product
 *  sync) duplicating the seam, the request cleaning, the error class, and the
 *  rpc's error mapping; `stripe-entitlement-sync.ts` is now a thin adapter
 *  over this one for the shipped Stripe-only rpc.
 *
 *  Completeness is proven per provider row:
 *  - `gateway_walk`: the op declares cursor pagination, and the gateway's audit
 *    reports the walk (`pages_fetched`) and whether it was `truncated` (Stripe).
 *  - `page_ceiling`: the catalog returns `result_path: 'data'` with no page
 *    envelope, so the read asks for the provider's maximum page and REFUSES a
 *    result exactly at that size — a catalogue that large cannot be proven
 *    complete from one page, and an incomplete snapshot would orphan-flag every
 *    tier the second page held (Paddle, Lemon Squeezy). */
import {
  isDoorType,
  isSellerProviderSource,
  sellerProviderFor,
  type DoorType,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type SellerProviderSource,
  type SellerProviderSpec,
  type SellerProviderTierSynchronizeRequest,
  type SellerProviderTierSynchronizeResponse,
} from '@recued/contracts';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { createGatewayAuditEmitter } from '../server-executor.js';
import {
  runGatedCatalogOperation,
  type RunGatedCatalogOperationFn,
} from '../source-mirror/fetch.js';
import type { ContractStore } from '../storage/contract-store.js';
import { resolveConnectionVendor } from '../storage/connection-store.js';
import type { SellerStore } from '../storage/seller-store.js';

import {
  foldProviderEntitlementTiers,
  type ProviderEntitlementRecord,
} from './provider-tier-fold.js';

export type SellerProviderTierSynchronizationErrorKind =
  | 'bad_request'
  | 'not_configured'
  | 'policy'
  | 'upstream'
  | 'conflict';

export class SellerProviderTierSynchronizationError extends Error {
  readonly kind: SellerProviderTierSynchronizationErrorKind;

  constructor(kind: SellerProviderTierSynchronizationErrorKind, detail: string) {
    super(`seller_provider_tier_sync_${kind}: ${detail}`);
    this.name = 'SellerProviderTierSynchronizationError';
    this.kind = kind;
  }
}

type Completeness =
  | { readonly kind: 'gateway_walk' }
  | { readonly kind: 'page_ceiling'; readonly size: number };

/** The server-side half of a provider row; the identity half (label, vendor,
 *  catalog, operation, store scoping) is the contracts registry's. */
interface TierSyncReader {
  readonly completeness: Completeness;
  readonly args: (input: { store_id?: string }) => Record<string, unknown>;
  readonly parse: (records: readonly unknown[]) => ProviderEntitlementRecord[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const upstream = (detail: string): SellerProviderTierSynchronizationError =>
  new SellerProviderTierSynchronizationError('upstream', detail);

const requiredString = (
  label: string,
  record: Record<string, unknown> | null,
  field: string,
  index: number,
): string => {
  const value = record?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw upstream(`${label} record ${index} has no non-empty ${field}`);
  }
  return value.trim();
};

/** Sort by key and refuse a duplicate — two records claiming one tier key
 *  would fold into one tier with the other's name, silently. */
const dedupe = (label: string, records: ProviderEntitlementRecord[]): ProviderEntitlementRecord[] => {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const record of records) {
    if (keys.has(record.key) || ids.has(record.external_id)) {
      throw upstream(`${label} returned a duplicate tier identity '${record.key}' / '${record.external_id}'`);
    }
    keys.add(record.key);
    ids.add(record.external_id);
  }
  return records.sort((a, b) => a.key.localeCompare(b.key));
};

const TIER_SYNC_READERS: Readonly<Record<SellerProviderSource, TierSyncReader>> = {
  stripe: {
    completeness: { kind: 'gateway_walk' },
    args: () => ({}),
    /** Stripe entitlement features: `{ id: 'feat_…', lookup_key, name, active, livemode }`.
     *  Every record must carry sane flags — a feature with a non-boolean
     *  `active` is a shape we cannot vouch for, not one to skip. */
    parse: (records) => dedupe('Stripe', records.flatMap((raw, index) => {
      const record = asRecord(raw);
      if (record === null) throw upstream(`Stripe feature ${index} is not an object`);
      const id = requiredString('Stripe', record, 'id', index);
      const lookup_key = requiredString('Stripe', record, 'lookup_key', index);
      const name = requiredString('Stripe', record, 'name', index);
      if (typeof record.active !== 'boolean' || typeof record.livemode !== 'boolean') {
        throw upstream(`Stripe feature ${index} has invalid active/livemode flags`);
      }
      return record.active ? [{ key: lookup_key, name, external_id: id }] : [];
    })),
  },
  paddle: {
    completeness: { kind: 'page_ceiling', size: 200 },
    // A comma-list STRING: the executor sends an array as repeated keys, and
    // Paddle reads one comma-separated `status` list.
    args: () => ({ 'query.status': 'active', 'query.per_page': 200 }),
    /** Paddle products: `{ id: 'pro_…', name, status: 'active' | 'archived' }`. */
    parse: (records) => dedupe('Paddle', records.flatMap((raw, index) => {
      const record = asRecord(raw);
      if (record === null) throw upstream(`Paddle product ${index} is not an object`);
      if (record.status !== 'active') return [];
      const id = requiredString('Paddle', record, 'id', index);
      if (!/^pro_[a-z0-9]+$/.test(id)) throw upstream(`Paddle product ${index} id '${id}' is not a product id`);
      return [{ key: id, name: requiredString('Paddle', record, 'name', index), external_id: id }];
    })),
  },
  lemonsqueezy: {
    completeness: { kind: 'page_ceiling', size: 100 },
    args: ({ store_id }) => ({ 'query.filter[store_id]': store_id, 'query.page[size]': 100 }),
    /** JSON:API products: `{ type: 'products', id: '123', attributes: { name, status: 'published' | 'draft' } }`. */
    parse: (records) => dedupe('Lemon Squeezy', records.flatMap((raw, index) => {
      const record = asRecord(raw);
      if (record === null || record.type !== 'products') {
        throw upstream(`Lemon Squeezy product ${index} is not a products resource`);
      }
      const attributes = asRecord(record.attributes);
      if (attributes?.status !== 'published') return [];
      const id = String(record.id ?? '').trim();
      if (!/^[0-9]+$/.test(id)) throw upstream(`Lemon Squeezy product ${index} id '${id}' is not a product id`);
      return [{ key: id, name: requiredString('Lemon Squeezy', attributes, 'name', index), external_id: id }];
    })),
  },
};

/** The op id the bounded catalog compiles to (`decomposer.ts`:
 *  `${author}/${slug}.${op}`) — the look-alike pin: a catalog installed under
 *  the same slug but compiling to a different id is not the authority. */
export const tierSeedOperationId = (spec: SellerProviderSpec): string =>
  `recued-core/${spec.catalog_slug}.${spec.tier_seed_operation}`;

/** Synthetic audit identity for the owner-clicked provider read — the same
 *  device the reconciler uses. A label, not a grant. */
export const SELLER_PROVIDER_TIER_SYNC_RECIPE: RecipeDefinition = {
  recipe_id: 'seller-provider-tier-sync',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Seller provider tier synchronization',
    description:
      'Synthetic audit identity for the owner-clicked read of a payment '
      + "provider's tier identities that seeds seller access tiers.",
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

export interface SellerProviderConnectionOption {
  readonly name: string;
  readonly display_name: string;
}

export type SellerProviderTierDiscoveryFailureKind =
  | 'not_configured'
  | 'policy'
  | 'upstream';

export type SellerProviderTierDiscoveryOutcome =
  | { readonly ok: true; readonly records: readonly unknown[] }
  | {
      readonly ok: false;
      readonly kind: SellerProviderTierDiscoveryFailureKind;
      readonly reason: string;
    };

/** The provider seam: which connections are synchronization-ready for a
 *  provider, and the gated read of its tier identities. Production builds it
 *  from the execute gateway; tests hand-roll it. */
export interface SellerProviderTierProvider {
  listConnections(provider: SellerProviderSource): SellerProviderConnectionOption[];
  listRecords(input: {
    readonly provider: SellerProviderSource;
    readonly connection_name: string;
    readonly store_id?: string;
    readonly execution_source: ExecutionSource;
  }): Promise<SellerProviderTierDiscoveryOutcome>;
}

const failure = (
  kind: SellerProviderTierDiscoveryFailureKind,
  reason: string,
): SellerProviderTierDiscoveryOutcome => ({ ok: false, kind, reason });

/** Build the production provider seam from the already-composed execute
 *  gateway. Undefined means the server cannot honestly offer a tier seed. */
export const createSellerProviderTierProvider = (
  deps: Pick<
    ExecuteHandlerDeps,
    | 'executorConfig'
    | 'connectionOperationProfiles'
    | 'connectionStore'
    | 'auditLog'
    | 'contractScan'
  >,
  runOperation: RunGatedCatalogOperationFn = runGatedCatalogOperation,
): SellerProviderTierProvider | undefined => {
  const profiles = deps.connectionOperationProfiles;
  const connectionStore = deps.connectionStore;
  if (!profiles || !connectionStore) return undefined;

  const canonicalManifest = (spec: SellerProviderSpec): IngredientManifest | null => {
    const manifest = deps.executorConfig.manifests.get(
      spec.catalog_slug,
    ) as IngredientManifest | null | undefined;
    return manifest?.operations?.[spec.tier_seed_operation]?.operation_id
      === tierSeedOperationId(spec)
      ? manifest
      : null;
  };
  const readyConnections = (spec: SellerProviderSpec): SellerProviderConnectionOption[] => {
    if (!canonicalManifest(spec)) return [];
    return connectionStore
      .list({ kind: 'api' })
      .filter((row) => {
        if (resolveConnectionVendor(row) !== spec.vendor) return false;
        const profile = profiles.get(row.name);
        return profile?.catalog_slug === spec.catalog_slug
          && profile.allowed_operations.includes(spec.tier_seed_operation);
      })
      .map((row) => ({ name: row.name, display_name: row.display_name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    listConnections: (provider) => readyConnections(sellerProviderFor(provider)),
    async listRecords(input) {
      const spec = sellerProviderFor(input.provider);
      const reader = TIER_SYNC_READERS[input.provider];
      const row = connectionStore.get('api', input.connection_name);
      if (!row || resolveConnectionVendor(row) !== spec.vendor) {
        return failure('not_configured', `${spec.label} API connection '${input.connection_name}' is not enrolled`);
      }
      const profile = profiles.get(input.connection_name);
      if (!profile || profile.catalog_slug !== spec.catalog_slug) {
        return failure('not_configured', `connection '${input.connection_name}' is not bound to the installed ${spec.label} seller catalog`);
      }
      const manifest = canonicalManifest(spec);
      if (!manifest) {
        return failure('not_configured', `the installed ${spec.label} seller catalog does not expose the canonical tier-identity read`);
      }
      const invoked = await runOperation(
        {
          executorConfig: deps.executorConfig,
          profiles,
          getSubresourcePath: (connectionName) =>
            connectionStore.get('api', connectionName)?.subresource_path,
          ...(deps.auditLog ? { onGatewayAudit: createGatewayAuditEmitter(deps.auditLog) } : {}),
          ...(deps.contractScan ? { contractScan: deps.contractScan } : {}),
        },
        {
          connection_name: input.connection_name,
          manifest,
          catalogSlug: spec.catalog_slug,
          operationKey: spec.tier_seed_operation,
          args: reader.args({ ...(input.store_id !== undefined ? { store_id: input.store_id } : {}) }),
          auditRecipe: SELLER_PROVIDER_TIER_SYNC_RECIPE,
          stepId: 'tier_identity_read',
          execution_source: input.execution_source,
          trigger_source: 'manual',
          askReason:
            `${spec.label} synchronization is owner-triggered, but the tier-identity read is not granted on this connection`,
        },
      );
      if (!invoked.ok) {
        return failure(
          invoked.kind === 'policy' ? 'policy' : invoked.kind === 'config' ? 'not_configured' : 'upstream',
          invoked.reason,
        );
      }
      // The gateway hands back `{ result }`; a paginated op's merged result may
      // still be the provider's `{ data: [...] }` envelope.
      const envelope = asRecord(invoked.raw);
      const result = envelope?.result ?? invoked.raw;
      const records = Array.isArray(result) ? result : asRecord(result)?.data;
      if (!Array.isArray(records)) {
        return failure('upstream', `${spec.label} discovery returned no tier-identity array`);
      }
      const completeness = reader.completeness;
      if (completeness.kind === 'gateway_walk') {
        if (invoked.audit?.pages_fetched === undefined || invoked.audit.truncated === true) {
          return failure('upstream', `${spec.label} discovery did not prove a complete paginated walk`);
        }
      } else if (records.length >= completeness.size) {
        return failure(
          'upstream',
          `${spec.label} returned ${records.length} records, the read's page ceiling — the catalogue cannot be proven complete from one page`,
        );
      }
      return { ok: true, records };
    },
  };
};

const cleanRequestString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SellerProviderTierSynchronizationError('bad_request', `${field} must be a non-empty string`);
  }
  return value.trim();
};

const selectConnection = (
  provider: SellerProviderTierProvider,
  spec: SellerProviderSpec,
  requested: unknown,
): string => {
  const connections = provider.listConnections(spec.source);
  if (connections.length === 0) {
    throw new SellerProviderTierSynchronizationError(
      'not_configured',
      `no synchronization-ready ${spec.label} connection is available; install the ${spec.catalog_slug} pack, enroll the connection, and grant its tier-identity read`,
    );
  }
  if (requested !== undefined) {
    const connectionName = cleanRequestString(requested, 'connection_name');
    if (!connections.some((candidate) => candidate.name === connectionName)) {
      throw new SellerProviderTierSynchronizationError(
        'bad_request',
        `connection_name '${connectionName}' is not a synchronization-ready ${spec.label} API connection`,
      );
    }
    return connectionName;
  }
  if (connections.length !== 1) {
    throw new SellerProviderTierSynchronizationError(
      'bad_request',
      `connection_name is required when more than one ${spec.label} API connection is synchronization-ready`,
    );
  }
  return connections[0]!.name;
};

export interface SynchronizeSellerProviderTiersDeps {
  readonly sellerStore: SellerStore;
  readonly contractStore: ContractStore;
  readonly provider: SellerProviderTierProvider;
  readonly now?: () => number;
  readonly newTierId?: () => string;
  readonly newContractId?: () => string;
  readonly mintedBy?: string;
}

/** Apply one complete provider snapshot atomically. */
export const synchronizeSellerProviderTiers = async (
  deps: SynchronizeSellerProviderTiersDeps,
  request: SellerProviderTierSynchronizeRequest,
  execution_source: ExecutionSource,
): Promise<Omit<SellerProviderTierSynchronizeResponse, 'overview'>> => {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new SellerProviderTierSynchronizationError('bad_request', 'args must be an object');
  }
  if (!isSellerProviderSource(request.provider)) {
    throw new SellerProviderTierSynchronizationError('bad_request', 'provider must be stripe, paddle, or lemonsqueezy');
  }
  const spec = sellerProviderFor(request.provider);
  const reader = TIER_SYNC_READERS[request.provider];
  const door_id = cleanRequestString(request.door_id, 'door_id');
  if (!isDoorType(request.door_type)) {
    throw new SellerProviderTierSynchronizationError('bad_request', 'door_type must be mcp, mcp_chat, or llm_gateway');
  }
  const door_type: DoorType = request.door_type;
  let store_id: string | undefined;
  if (spec.tier_seed_requires_store_id) {
    store_id = cleanRequestString(request.store_id, 'store_id');
    if (!/^[0-9]+$/.test(store_id)) {
      throw new SellerProviderTierSynchronizationError('bad_request', `store_id must be the numeric ${spec.label} store id`);
    }
  } else if (request.store_id !== undefined) {
    throw new SellerProviderTierSynchronizationError('bad_request', `store_id is not a ${spec.label} concept`);
  }
  const connection_name = selectConnection(deps.provider, spec, request.connection_name);
  const discovered = await deps.provider.listRecords({
    provider: spec.source,
    connection_name,
    ...(store_id !== undefined ? { store_id } : {}),
    execution_source,
  });
  if (!discovered.ok) {
    throw new SellerProviderTierSynchronizationError(discovered.kind, discovered.reason);
  }
  const records = reader.parse(discovered.records);

  try {
    const folded = foldProviderEntitlementTiers({
      sellerStore: deps.sellerStore,
      contractStore: deps.contractStore,
      lifecycle_source: spec.source,
      door_id,
      door_type,
      records,
      now: deps.now?.() ?? Date.now(),
      mintedBy: deps.mintedBy ?? 'server:seller:provider-tier-sync',
      templateDisplayName: (record) => `${spec.label} ${record.name} customer template`,
      ...(deps.newTierId ? { newTierId: deps.newTierId } : {}),
      ...(deps.newContractId ? { newContractId: deps.newContractId } : {}),
      cleanId: cleanRequestString,
    });
    return {
      provider: spec.source,
      connection_name,
      records_seen: records.length,
      ...folded,
    };
  } catch (error) {
    if (error instanceof SellerProviderTierSynchronizationError) throw error;
    throw new SellerProviderTierSynchronizationError(
      'conflict',
      error instanceof Error ? error.message : String(error),
    );
  }
};
