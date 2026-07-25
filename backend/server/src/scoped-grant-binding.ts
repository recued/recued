/** D-177 N.11 rule 5 (5.b/5.c, slice C) — the entity+action → catalog
 *  (ingredient × operation) resolution and the connection-candidate
 *  enumeration the scoped-grant proposal flow shares between the parse
 *  middleware (proposal time) and the accept rpc (mint time — re-validated
 *  LIVE).
 *
 *  Resolution is exact + closed (5.b: "anything off-vocabulary at any
 *  position is a NO-PARSE, not a guess"): the candidate operation key is the
 *  literal `<entity>.<action>` the catalog grammar already uses
 *  (`deal.create`, `contact.update`, …), looked up across installed
 *  CATALOG-FORM manifests. Exactly ONE manifest may declare it — a key two
 *  installed catalogs share is ambiguous and resolves to nothing (the
 *  per-action ask remains; friction, never admission). The op's declared
 *  tier must be session-grantable (`write`/`admin`): `read` ops never need
 *  grants and `destructive` never grants, so neither is proposable.
 *
 *  Connection candidates are the enrolled connections whose catalog resolves
 *  to the bound ingredient — registered vendors via `config.vendor` →
 *  `catalogSlugForVendor`, local composition catalogs via the D-170 gap-#2
 *  binding store. Same resolution the operation-profile seed + the grant
 *  gate use (`resolveConnectionVendor` — one vendor-resolution rule). */

import {
  SESSION_GRANT_RISK_TIERS,
  catalogSlugForVendor,
  isCatalogForm,
  type IngredientManifest,
  type RiskTier,
} from '@recued/contracts';

import {
  resolveConnectionVendor,
  type ConnectionStoreSqlite,
} from './storage/connection-store.js';
import type { ConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';

/** The resolved 5.b binding — the authority triple a scoped proposal names. */
export interface ScopedCatalogBinding {
  readonly ingredient_id: string;
  readonly operation_id: string;
  readonly risk_tier: RiskTier;
}

/** Resolve the parsed `entity` + `action` tokens to exactly one installed
 *  catalog operation, or `undefined` (no declaring catalog, more than one,
 *  or a tier outside the session-grantable set — all fail toward asking). */
export const resolveScopedCatalogBinding = (
  manifests: readonly IngredientManifest[],
  entity: string,
  action: string,
): ScopedCatalogBinding | undefined => {
  const operationKey = `${entity}.${action}`;
  const declaring = manifests.filter(
    (manifest) =>
      isCatalogForm(manifest)
      && Object.prototype.hasOwnProperty.call(manifest.operations ?? {}, operationKey),
  );
  if (declaring.length !== 1) return undefined;
  const op = declaring[0].operations?.[operationKey];
  if (op === undefined) return undefined;
  if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(op.risk_tier)) {
    return undefined;
  }
  return {
    ingredient_id: declaring[0].slug,
    // The SHORT operations-map key — exactly what the catalog gateway stamps
    // as the trusted `surface_operation_key` and what the N.4 matcher's
    // `ctx.operation_id` carries (real catalogs keep `op.operation_id`
    // equal to the map key; the map key is the binding's source of truth).
    operation_id: operationKey,
    risk_tier: op.risk_tier,
  };
};

/** Enumerate the enrolled connection names whose catalog resolves to
 *  `ingredient_id` — the card's candidate list (proposal time) and the
 *  accept rpc's validation set (mint time). Sorted for stable rendering. */
export const listScopedConnectionCandidates = (
  connectionStore: Pick<ConnectionStoreSqlite, 'list'>,
  bindingStore: Pick<ConnectionCatalogBindingStore, 'resolveCatalogSlug'> | undefined,
  ingredient_id: string,
): string[] =>
  connectionStore
    .list()
    .filter((row) => {
      const vendor = resolveConnectionVendor(row);
      const vendorSlug =
        vendor !== undefined ? catalogSlugForVendor(vendor) : undefined;
      const slug = vendorSlug ?? bindingStore?.resolveCatalogSlug(row.name);
      return slug === ingredient_id;
    })
    .map((row) => row.name)
    .sort();
