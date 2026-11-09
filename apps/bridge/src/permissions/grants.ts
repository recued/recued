/** D-148 § A.3.4.1 — per-ingredient per-domain grant store.
 *
 *  Persists `(publisher_id, slug, version) → granted_origins[]` so the
 *  bridge can enforce three-way intersection at every BridgeCommand
 *  dispatch:
 *
 *    1. The grant must match the ingredient's identity tuple.
 *    2. The pattern must be in the ingredient's signed `domain_allowlist`.
 *    3. The pattern must be a subset of the user's grant for that
 *       ingredient.
 *
 *  Re-installing a different version of the same ingredient with a
 *  wider domain list does NOT inherit the prior grant — the bridge
 *  re-prompts so the user can confirm.
 *
 *  Storage backend pluggable: in-memory in tests; IndexedDB in
 *  production. No chrome.* dependencies in this module so it can be
 *  unit tested in node.
 */

import {
  isCommandWithinIngredientGrant,
  type BridgeIngredientGrant,
  type BridgeIngredientRef,
} from '@recued/contracts';

const grantKey = (publisher_id: string, slug: string, version: string): string =>
  `${publisher_id}::${slug}::${version}`;

export interface BridgeGrantStore {
  /** Returns the current grant for an ingredient version, or null. */
  get(publisher_id: string, slug: string, version: string): Promise<BridgeIngredientGrant | null>;
  /** Persist a new grant. Overwrites prior grant for the same tuple
   *  (Chrome's per-origin grant is what carries forward — this store
   *  records the binding to the ingredient). */
  put(grant: BridgeIngredientGrant): Promise<void>;
  /** Revoke. Used by Settings → Bridge → Granted Domains → [Revoke]. */
  remove(publisher_id: string, slug: string, version: string): Promise<void>;
  /** All grants — used by Settings UI + the per-domain summary. */
  list(): Promise<BridgeIngredientGrant[]>;
  /** Wipe all grants (disconnect-bridge flow). */
  clear(): Promise<void>;
}

export const createInMemoryBridgeGrantStore = (): BridgeGrantStore => {
  const grants = new Map<string, BridgeIngredientGrant>();
  return {
    async get(publisher_id, slug, version) {
      return grants.get(grantKey(publisher_id, slug, version)) ?? null;
    },
    async put(grant) {
      grants.set(grantKey(grant.publisher_id, grant.slug, grant.version), grant);
    },
    async remove(publisher_id, slug, version) {
      grants.delete(grantKey(publisher_id, slug, version));
    },
    async list() {
      return [...grants.values()];
    },
    async clear() {
      grants.clear();
    },
  };
};

/** D-148 § A.3.4.1 — verify the bridge has a current grant covering
 *  the requested `domain_pattern` for the given ingredient.
 *
 *  Returns:
 *    - `'ok'` if all three axes hold (ingredient tuple match +
 *      pattern in signed allowlist + pattern in user grant).
 *    - `'missing_grant'` if no grant exists for the ingredient tuple.
 *    - `'pattern_outside_allowlist'` if the pattern is not in the
 *      ingredient's signed allowlist (signed signature failure is
 *      checked upstream by the authority verifier; this just guards
 *      the membership check).
 *    - `'pattern_outside_grant'` if the pattern is in the allowlist
 *      but not in the user's grant.
 *
 *  The pure function lets callers map outcomes to specific
 *  BridgeErrorCode values + remediation hints. */
export type GrantCheckOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing_grant' | 'pattern_outside_allowlist' | 'pattern_outside_grant' };

export const checkIngredientGrant = async (
  store: BridgeGrantStore,
  ingredient: BridgeIngredientRef,
  domain_pattern: string,
): Promise<GrantCheckOutcome> => {
  const grant = await store.get(ingredient.publisher_id, ingredient.slug, ingredient.version);
  if (!grant) {
    return { ok: false, reason: 'missing_grant' };
  }
  // Three-way intersection. The contracts helper does the full check
  // but to give callers granular reasons we split the check into
  // axis-specific predicates.
  const inAllowlist = ingredient.domain_allowlist.some((p) => p === domain_pattern);
  if (!inAllowlist) {
    // Fall back to pattern-subset semantics (handles wildcards).
    const ok = isCommandWithinIngredientGrant(domain_pattern, ingredient, grant);
    if (!ok) {
      // Use full helper to produce the most-precise failure reason —
      // tuple match is guaranteed here (we just looked it up), so any
      // failure must be allowlist or grant.
      const inGrant = grant.granted_origins.some((g) => g === domain_pattern);
      if (!inGrant) {
        // Pattern is in neither set — name the most specific cause.
        return { ok: false, reason: 'pattern_outside_allowlist' };
      }
      return { ok: false, reason: 'pattern_outside_allowlist' };
    }
    return { ok: true };
  }
  const inGrant = isCommandWithinIngredientGrant(domain_pattern, ingredient, grant);
  if (!inGrant) {
    return { ok: false, reason: 'pattern_outside_grant' };
  }
  return { ok: true };
};

/** Build a fresh grant from a Chrome `permissions.request` outcome.
 *  Caller passes the tuple + the origins Chrome confirmed (Chrome can
 *  return a subset of what was requested if the user only accepts
 *  some). The bridge persists the confirmed subset, not the requested
 *  set. */
export const buildGrant = (
  ingredient: Pick<BridgeIngredientRef, 'publisher_id' | 'slug' | 'version'>,
  granted_origins: string[],
  granted_at: number,
): BridgeIngredientGrant => ({
  publisher_id: ingredient.publisher_id,
  slug: ingredient.slug,
  version: ingredient.version,
  granted_origins: [...granted_origins],
  granted_at,
});
