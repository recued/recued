/** D-170 gap #2 — the `contract.connection_catalog_binding`-backed store binding a
 *  connection to the private/local composition catalogs installed against it.
 *
 *  Registered vendors (HubSpot / Salesforce) resolve a connection → catalog via
 *  `config.vendor` → `CATALOG_VENDOR_SLUGS`. A private/local composition catalog has
 *  NO vendor, and the composition's `auth.connection` binding is LOST when the
 *  composition decomposes to a connection-agnostic catalog. So the install planner
 *  records the binding HERE (connection_name + catalog_slug, attributed to the owning
 *  `installed_pack_id`); the operation-profile seed (`connection-operation-profile-boot`)
 *  and the grant gate (`connection-handler` `ensureGrantableConnection`) resolve a
 *  local-catalog connection through this store, exactly where they resolve a
 *  registered vendor through `catalogSlugForVendor`. Uninstall drops the pack's rows.
 *
 *  ⛔ D-320 ruling 10 — KEYED BY `connection_name` AND `catalog_slug`: a connection
 *  serves several catalogs. It was keyed by `connection_name` alone, so the first pack
 *  to bind a connection kept it and every other catalog's operation on it was refused
 *  `catalog_mismatch` — the shipped Wise suite (seven packs, one sign-in) ran one pack.
 *  - Rows written under the old one-segment key are still READ, as the binding they
 *    always were. Nothing writes them any more; a reinstall replaces them.
 *  - A connection's FIRST catalog (earliest written, then slug) is what
 *    `resolveCatalogSlug` returns, for the readers that know one catalog per
 *    connection. Install rewrites only the rows that change, so a reinstall does not
 *    reorder them.
 *
 *  Local-only by construction — the contract store never syncs cloud
 *  (D-090/D-097/D-168).
 */

import type { ContractStore } from './contract-store.js';

/** The `connection_catalog_binding` scope name (a `composite_keys` entry in the
 *  contract schema). */
const BINDING_SCOPE = 'connection_catalog_binding';

/** Segment depth of a row: `[connection_name, catalog_slug]`. */
const BINDING_SEGMENT_COUNT = 2;
/** Segment depth of a row written before D-320 ruling 10: `[connection_name]`, its
 *  catalog in the value. Read, never written. */
const LEGACY_BINDING_SEGMENT_COUNT = 1;
/** Index of the `connection_name` segment (both shapes). */
const CONNECTION_NAME_SEGMENT = 0;
/** Index of the `catalog_slug` segment. */
const CATALOG_SLUG_SEGMENT = 1;

/** Typed view of the `catalog_binding_info` value_shape — kept in lock-step with
 *  the schema (a field added there must be added here). */
export interface CatalogBinding {
  catalog_slug: string;
  installed_pack_id: string;
  /** D-320 — the slot the binding serves (the connection name the pack's catalog
   *  declares). Absent on rows written before D-320 slice 2b. */
  slot?: string;
}

export interface ConnectionCatalogBindingStore {
  /** The FIRST local composition catalog bound to `connection_name`, or undefined
   *  when it has none (a registered-vendor or unbound connection). For a reader that
   *  knows one catalog per connection; `catalogsForConnection` lists them all. */
  resolveCatalogSlug(connection_name: string): string | undefined;
  /** D-320 ruling 10 — every catalog bound to `connection_name`, first-bound first. */
  catalogsForConnection(connection_name: string): string[];
  /** D-320 — every connection bound to `catalog_slug`, sorted. */
  connectionsForCatalog(catalog_slug: string): string[];
  /** Every binding (connection_name + its catalog + owning pack), first-bound first —
   *  the boot seed iterates this to seed each local-catalog connection's operation
   *  profile, independent of the connection's kind. */
  list(): Array<{ connection_name: string } & CatalogBinding>;
  /** Record the binding of `connection_name` to `catalog_slug`, for `slot` when the
   *  caller knows it. Re-binding the same pair for the same pack and slot writes
   *  nothing, so the row keeps its place in the order. The install planner writes it
   *  inside the install transaction. */
  bind(connection_name: string, catalog_slug: string, installed_pack_id: string, slot?: string): void;
  /** D-320 — drop the binding of `connection_name` to `catalog_slug` (both shapes). */
  unbind(connection_name: string, catalog_slug: string): void;
  /** Drop EVERY binding owned by `installed_pack_id` (the uninstall counterpart).
   *  Scans the (bounded) scope and filters on the value's `installed_pack_id` —
   *  another pack's bindings survive. */
  removeForPack(installed_pack_id: string): void;
}

interface BindingRow {
  connection_name: string;
  catalog_slug: string;
  installed_pack_id: string;
  slot?: string;
  written_at: number;
  segments: readonly string[];
  legacy: boolean;
}

/** Defensive read of the `catalog_binding_info` value — both required string
 *  fields present, else undefined (a malformed row is ignored, never trusted). */
const readBinding = (value: unknown): CatalogBinding | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Partial<CatalogBinding>;
  if (typeof v.catalog_slug !== 'string' || typeof v.installed_pack_id !== 'string') return undefined;
  return {
    catalog_slug: v.catalog_slug,
    installed_pack_id: v.installed_pack_id,
    ...(typeof v.slot === 'string' && v.slot.length > 0 ? { slot: v.slot } : {}),
  };
};

/** The catalog a well-formed row binds, from either shape: a current row's key
 *  (which its value must agree with) or a legacy row's value. */
const boundCatalogOf = (segments: readonly string[], value: unknown): string | undefined => {
  const binding = readBinding(value);
  if (binding === undefined) return undefined;
  if (segments.length === BINDING_SEGMENT_COUNT) {
    return binding.catalog_slug === segments[CATALOG_SLUG_SEGMENT] ? binding.catalog_slug : undefined;
  }
  return segments.length === LEGACY_BINDING_SEGMENT_COUNT ? binding.catalog_slug : undefined;
};

/** D-320 phase 1 — the connections installed packs bound to any of `catalog_slugs`:
 *  the pack's list of connections for the catalogs a step fetches from
 *  (D-320 §3.1). Sorted, deduped. Takes a contract-store scan so the
 *  execute handler reads it through the `contractScan` it already has.
 *
 *  ⛔ Bindings, not grants. Phase 1 first read pack-owned GRANT rows, which only
 *  packs declaring grant defaults write: HubSpot does, the Wise suite and most
 *  families do not, so the list came back empty for them. Since 2026-08-07 grants do
 *  not gate (`OPERATION_GROUP_GATE_ENABLED`); the binding is what serves a catalog on
 *  a connection, and every install with a connection writes one. A connection the
 *  owner granted by hand (Settings → Connections) has no binding, so it is capable
 *  but on no pack's list.
 *
 *  Not limited to the recipe's own pack: in 1,092 of the 1,821 connection settings
 *  shipped recipes declare, the recipe's pack has no catalog and calls a dependency's
 *  (`hetzner-cloud` → `hetzner-cloud-compute`, measured 2026-10-09). The pack that
 *  OWNS the catalog holds the binding. */
export const connectionsBoundToCatalogs = (
  scan: BindingScan,
  catalog_slugs: readonly string[],
): string[] =>
  [...new Set(bindingsForCatalogs(scan, catalog_slugs).map((b) => b.connection_name))].sort();

/** A contract-store scan, as the execute handler holds one (`contractScan`). */
export type BindingScan = (
  scope: string,
  prefixSegments: readonly string[],
) => readonly { segments: readonly string[]; value: unknown }[];

/** D-320 — every binding to any of `catalog_slugs`, with the pack that holds it, so
 *  a run can read those packs' stored defaults (`pack_connection_default`). Both
 *  row shapes. */
export const bindingsForCatalogs = (
  scan: BindingScan,
  catalog_slugs: readonly string[],
): Array<{ connection_name: string } & CatalogBinding> => {
  const wanted = new Set(catalog_slugs);
  if (wanted.size === 0) return [];
  return allCatalogBindings(scan).filter((binding) => wanted.has(binding.catalog_slug));
};

/** D-320 — every binding, both row shapes, in one scan: for a reader that looks at
 *  many catalogs at once (the recipe tools' `connections` argument). */
export const allCatalogBindings = (
  scan: BindingScan,
): Array<{ connection_name: string } & CatalogBinding> => {
  const out: Array<{ connection_name: string } & CatalogBinding> = [];
  for (const row of scan(BINDING_SCOPE, [])) {
    const catalog = boundCatalogOf(row.segments, row.value);
    if (catalog === undefined) continue;
    const binding = readBinding(row.value)!;
    out.push({
      connection_name: row.segments[CONNECTION_NAME_SEGMENT],
      catalog_slug: catalog,
      installed_pack_id: binding.installed_pack_id,
      ...(binding.slot !== undefined ? { slot: binding.slot } : {}),
    });
  }
  return out;
};

/** Wrap a {@link ContractStore} as the `ConnectionCatalogBindingStore`. Stateless —
 *  every call forwards to the shared store handle; safe to construct more than once
 *  over the same store (so the install/uninstall paths build it ad-hoc over their
 *  existing `contractStore`, keeping the writes inside the surrounding transaction). */
export const createConnectionCatalogBindingStore = (
  contractStore: ContractStore,
): ConnectionCatalogBindingStore => {
  /** Every well-formed row under `prefix`, both shapes, one per (connection,
   *  catalog) — a current row wins over a legacy row naming the same pair — in
   *  bind order (earliest written, then catalog slug). A current row whose value
   *  names a different catalog than its key is malformed and ignored. */
  const rows = (prefix: readonly string[]): BindingRow[] => {
    const byPair = new Map<string, BindingRow>();
    for (const row of contractStore.scan(BINDING_SCOPE, prefix)) {
      const binding = readBinding(row.value);
      if (binding === undefined) continue;
      let parsed: BindingRow;
      if (row.segments.length === BINDING_SEGMENT_COUNT) {
        if (binding.catalog_slug !== row.segments[CATALOG_SLUG_SEGMENT]) continue;
        parsed = {
          connection_name: row.segments[CONNECTION_NAME_SEGMENT],
          ...binding,
          written_at: row.written_at,
          segments: row.segments,
          legacy: false,
        };
      } else if (row.segments.length === LEGACY_BINDING_SEGMENT_COUNT) {
        parsed = {
          connection_name: row.segments[CONNECTION_NAME_SEGMENT],
          ...binding,
          written_at: row.written_at,
          segments: row.segments,
          legacy: true,
        };
      } else {
        continue;
      }
      const key = `${parsed.connection_name}\u0000${parsed.catalog_slug}`;
      const prior = byPair.get(key);
      if (prior === undefined || (prior.legacy && !parsed.legacy)) byPair.set(key, parsed);
    }
    return [...byPair.values()].sort((a, b) =>
      a.written_at - b.written_at
      || a.connection_name.localeCompare(b.connection_name)
      || a.catalog_slug.localeCompare(b.catalog_slug));
  };

  const catalogsForConnection = (connection_name: string): string[] =>
    rows([connection_name])
      .filter((r) => r.connection_name === connection_name)
      .map((r) => r.catalog_slug);

  return {
    resolveCatalogSlug(connection_name) {
      return catalogsForConnection(connection_name)[0];
    },

    catalogsForConnection,

    connectionsForCatalog(catalog_slug) {
      const out = new Set<string>();
      for (const r of rows([])) if (r.catalog_slug === catalog_slug) out.add(r.connection_name);
      return [...out].sort();
    },

    list() {
      return rows([]).map((r) => ({
        connection_name: r.connection_name,
        catalog_slug: r.catalog_slug,
        installed_pack_id: r.installed_pack_id,
        ...(r.slot !== undefined ? { slot: r.slot } : {}),
      }));
    },

    bind(connection_name, catalog_slug, installed_pack_id, slot) {
      const existing = readBinding(contractStore.get(BINDING_SCOPE, [connection_name, catalog_slug])?.value);
      if (existing?.installed_pack_id === installed_pack_id
        && existing.catalog_slug === catalog_slug
        && (slot === undefined || existing.slot === slot)) {
        return;
      }
      contractStore.put(BINDING_SCOPE, [connection_name, catalog_slug], {
        catalog_slug,
        installed_pack_id,
        ...(slot !== undefined ? { slot } : existing?.slot !== undefined ? { slot: existing.slot } : {}),
      } satisfies CatalogBinding);
      // The legacy row for this pair is now superseded.
      const legacy = contractStore.get(BINDING_SCOPE, [connection_name]);
      if (readBinding(legacy?.value)?.catalog_slug === catalog_slug) {
        contractStore.delete(BINDING_SCOPE, [connection_name]);
      }
    },

    unbind(connection_name, catalog_slug) {
      contractStore.delete(BINDING_SCOPE, [connection_name, catalog_slug]);
      const legacy = contractStore.get(BINDING_SCOPE, [connection_name]);
      if (readBinding(legacy?.value)?.catalog_slug === catalog_slug) {
        contractStore.delete(BINDING_SCOPE, [connection_name]);
      }
    },

    removeForPack(installed_pack_id) {
      // The scope is small (one row per connection × local catalog), so a full scan +
      // installed_pack_id filter is cheap (same shape as the grant store's
      // connection-delete cleanup). Both shapes.
      for (const row of contractStore.scan(BINDING_SCOPE, [])) {
        const shape = row.segments.length;
        if (
          (shape === BINDING_SEGMENT_COUNT || shape === LEGACY_BINDING_SEGMENT_COUNT)
          && readBinding(row.value)?.installed_pack_id === installed_pack_id
        ) {
          contractStore.delete(BINDING_SCOPE, row.segments);
        }
      }
    },
  };
};
