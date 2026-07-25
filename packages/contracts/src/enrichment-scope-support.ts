/** D-192 S4b + the valid_scopes-widening follow-on — the ONE definition of
 *  "does a per_record enrichment topic support this scope", shared by the STORE
 *  (`isScopeWritable`, the write/persist gate) and the recipe VALIDATOR
 *  (`references.ts`, the static ref check). Before this they had DRIFTED: the
 *  store widened a pack CRM's mirror scope in (S4b) while the validator still
 *  rejected it off the static list — so a recipe referencing a pack-CRM
 *  enrichment topic failed validation even though it persists fine at runtime.
 *  One shared function keeps them in lock-step.
 *
 *  A per_record topic's `valid_scopes` is a STATIC per-topic list, deliberately
 *  NOT registry-derived (a topic's registry entry can't walk the vendor registry
 *  without an enrichment-registry ↔ connection-vendors import cycle). This helper
 *  is the seam: it takes the live merged `registry` as a parameter (the store
 *  passes its `resolveVendorRegistry`; the validator passes
 *  `activeVendorAliasRegistry()`), so the widening reflects installed packs
 *  without either caller importing the other's world.
 *
 *  ── The rule (byte-identical for built-ins) ──────────────────────────────
 *  A scope is supported iff it is STATICALLY declared OR it is a `registry`
 *  scope of the topic's `crm_alias` family (a contact-anchored topic admits
 *  contact-vendor scopes, …) whose vendor is a PACK (non-built-in) vendor. The
 *  `!isBuiltinVendor` clause is load-bearing: a built-in crm_alias scope a
 *  topic's static list deliberately OMITS (e.g. `pipedrive.person` absent from
 *  `champion_deal_count.valid_scopes`) stays REJECTED — the widening ONLY ever
 *  ADDS a pack CRM's mirror scope, never re-includes a built-in. Fail-safe: an
 *  unbound registry is the frozen builtin, every built-in vendor is filtered
 *  out, so the widening set is empty (no behaviour change). */

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
  type CrmAlias,
} from './connection-vendors.js';
import type { EnrichmentScope } from './enrichment-registry.js';

/** The frozen built-in vendor ids — a live-registry entry whose vendor is NOT
 *  one of these is a PACK vendor (the only ones the widening admits). Derived
 *  once from the frozen registry. */
const BUILTIN_VENDOR_IDS: ReadonlySet<string> = new Set(
  CONNECTION_VENDOR_ENTITIES.map((e) => e.vendor),
);

/** The topic's `crm_alias` family, DERIVED from its OWN static `valid_scopes`
 *  (a `hubspot.contact`-anchored topic → `{contact}`, …). Read off the FROZEN
 *  built-in registry — the static scopes ARE built-in scopes, so this needs no
 *  live registry. Empty for a non-CRM topic (`data.mail`, derived-entity) → no
 *  widening. */
const crmAliasFamilyOf = (
  validScopes: ReadonlyArray<EnrichmentScope>,
): ReadonlySet<CrmAlias> => {
  const family = new Set<CrmAlias>();
  for (const staticScope of validScopes) {
    for (const entry of CONNECTION_VENDOR_ENTITIES) {
      if (entry.scope === staticScope && entry.crm_alias !== undefined) {
        family.add(entry.crm_alias);
      }
    }
  }
  return family;
};

/** Whether a per_record enrichment topic (identified by its static
 *  `valid_scopes`) supports `scope`, given the live merged vendor `registry`.
 *  The single source of truth for the store's write gate + the validator's ref
 *  check (see the file header). Pure; never throws. */
export const isEnrichmentScopeSupported = (
  validScopes: ReadonlyArray<EnrichmentScope> | undefined,
  scope: EnrichmentScope,
  registry: ReadonlyArray<ConnectionVendorEntity>,
): boolean => {
  const scopes = validScopes ?? [];
  // Fast path — every built-in write / ref is a statically declared scope.
  if (scopes.includes(scope)) return true;
  const family = crmAliasFamilyOf(scopes);
  if (family.size === 0) return false;
  for (const entry of registry) {
    if (
      entry.scope === scope
      && entry.crm_alias !== undefined
      && family.has(entry.crm_alias)
      && !BUILTIN_VENDOR_IDS.has(entry.vendor)
    ) {
      return true;
    }
  }
  return false;
};
