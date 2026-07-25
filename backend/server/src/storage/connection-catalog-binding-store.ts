/** D-170 gap #2 — the `contract.connection_catalog_binding`-backed store binding a
 *  connection to the private/local composition catalog installed against it.
 *
 *  Registered vendors (HubSpot / Salesforce) resolve a connection → catalog via
 *  `config.vendor` → `CATALOG_VENDOR_SLUGS`. A private/local composition catalog has
 *  NO vendor, and the composition's `auth.connection` binding is LOST when the
 *  composition decomposes to a connection-agnostic catalog. So the install planner
 *  records the binding HERE (connection_name → catalog_slug, attributed to the owning
 *  `installed_pack_id`); the operation-profile seed (`connection-operation-profile-boot`)
 *  and the grant gate (`connection-handler` `ensureGrantableConnection`) resolve a
 *  local-catalog connection through this store, exactly where they resolve a
 *  registered vendor through `catalogSlugForVendor`. Uninstall drops the pack's rows.
 *
 *  Keyed by `connection_name` alone — ONE catalog per connection, matching the
 *  `ConnectionOperationProfile`'s single `catalog_slug` stamp + the gateway's
 *  `catalog_mismatch` guard (two local catalogs binding the same connection is the
 *  same unsupported case the profile model already rejects). A reinstall overwrites
 *  (the scope's `override` merge_rule). Local-only by construction — the contract
 *  store never syncs cloud (D-090/D-097/D-168).
 */

import type { ContractStore } from './contract-store.js';

/** The `connection_catalog_binding` scope name (a `composite_keys` entry in the
 *  contract schema). */
const BINDING_SCOPE = 'connection_catalog_binding';

/** Segment depth — the scope is keyed on `connection_name` alone. */
const BINDING_SEGMENT_COUNT = 1;
/** Index of the `connection_name` segment. */
const CONNECTION_NAME_SEGMENT = 0;

/** Typed view of the `catalog_binding_info` value_shape — kept in lock-step with
 *  the schema (a field added there must be added here). */
export interface CatalogBinding {
  catalog_slug: string;
  installed_pack_id: string;
}

export interface ConnectionCatalogBindingStore {
  /** The local composition catalog slug bound to `connection_name`, or undefined
   *  when the connection has no local-catalog binding (a registered-vendor or
   *  unbound connection). */
  resolveCatalogSlug(connection_name: string): string | undefined;
  /** Every binding (connection_name + its catalog + owning pack) — the boot seed
   *  iterates this to seed each local-catalog connection's operation profile,
   *  independent of the connection's kind. */
  list(): Array<{ connection_name: string } & CatalogBinding>;
  /** Record/replace the binding for `connection_name` (idempotent upsert under the
   *  `override` merge_rule). The install planner writes it inside the install
   *  transaction. */
  bind(connection_name: string, catalog_slug: string, installed_pack_id: string): void;
  /** Drop EVERY binding owned by `installed_pack_id` (the uninstall counterpart).
   *  The scope is keyed by `connection_name`, so this scans the (bounded) scope and
   *  filters on the value's `installed_pack_id` — another pack's bindings survive. */
  removeForPack(installed_pack_id: string): void;
}

/** Wrap a {@link ContractStore} as the `ConnectionCatalogBindingStore`. Stateless —
 *  every call forwards to the shared store handle; safe to construct more than once
 *  over the same store (so the install/uninstall paths build it ad-hoc over their
 *  existing `contractStore`, keeping the writes inside the surrounding transaction). */
export const createConnectionCatalogBindingStore = (
  contractStore: ContractStore,
): ConnectionCatalogBindingStore => {
  /** Defensive read of the `catalog_binding_info` value — both required string
   *  fields present, else undefined (a malformed row is ignored, never trusted). */
  const readBinding = (value: unknown): CatalogBinding | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const v = value as Partial<CatalogBinding>;
    return typeof v.catalog_slug === 'string' && typeof v.installed_pack_id === 'string'
      ? { catalog_slug: v.catalog_slug, installed_pack_id: v.installed_pack_id }
      : undefined;
  };

  return {
    resolveCatalogSlug(connection_name) {
      const row = contractStore.get(BINDING_SCOPE, [connection_name]);
      return readBinding(row?.value)?.catalog_slug;
    },

    list() {
      const out: Array<{ connection_name: string } & CatalogBinding> = [];
      for (const row of contractStore.scan(BINDING_SCOPE, [])) {
        if (row.segments.length !== BINDING_SEGMENT_COUNT) continue;
        const binding = readBinding(row.value);
        if (binding) out.push({ connection_name: row.segments[CONNECTION_NAME_SEGMENT], ...binding });
      }
      return out;
    },

    bind(connection_name, catalog_slug, installed_pack_id) {
      contractStore.put(BINDING_SCOPE, [connection_name], {
        catalog_slug,
        installed_pack_id,
      } satisfies CatalogBinding);
    },

    removeForPack(installed_pack_id) {
      // The scope is tiny (one row per local-catalog connection), so a full scan +
      // installed_pack_id filter is cheap (same shape as the grant store's
      // connection-delete cleanup).
      for (const row of contractStore.scan(BINDING_SCOPE, [])) {
        if (
          row.segments.length === BINDING_SEGMENT_COUNT &&
          readBinding(row.value)?.installed_pack_id === installed_pack_id
        ) {
          contractStore.delete(BINDING_SCOPE, row.segments);
        }
      }
    },
  };
};
