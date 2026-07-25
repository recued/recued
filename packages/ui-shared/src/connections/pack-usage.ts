/** Connection-detail "Used by packs" — the INVERSE pivot of the pack-row
 *  readiness block. The pack row answers "does this pack have its connections?"
 *  (per pack → its connections); this answers "what packs use this connection,
 *  and are they scope-covered?" (per connection → its packs).
 *
 *  Composes the contracts-side scope-coverage primitives
 *  (`requiredScopesByConnection` + `scopeCoverage`); lives in ui-shared because
 *  the connection-detail renderer (`page.ts`) is the sole consumer. Vendor-match
 *  resolution (the connection slot IS the vendor), consistent with the pack-row
 *  readiness + the live runnability system. Pure — same inputs, same output.
 *
 *  Like the pack-row block, this is READINESS (does the connection cover its
 *  packs?), not authz — the gate stays the per-op contract grant. */

import {
  requiredScopesByConnection,
  scopeCoverage,
  type BulkPackManifest,
  type ScopeCoverage,
} from '@recued/contracts';

/** One installed pack's use of a connection. */
export interface PackConnectionUsage {
  /** The pack's manifest slug. */
  pack_slug: string;
  /** The scopes this pack needs on the connection (sorted, non-empty). */
  needed: string[];
  /** Coverage of `needed` against the connection's granted set. */
  coverage: ScopeCoverage;
}

/** The packs using a connection — for the connection-detail "Used by packs"
 *  view. Pass the INSTALLED packs' manifests + the connection's vendor + its
 *  `granted_scopes`; get one entry per installed pack that declares a
 *  scope-bearing op on that vendor, each with its needed scopes + coverage.
 *  Sorted by slug; empty when no installed pack uses the vendor. `granted`
 *  undefined → each entry's coverage is `known:false` (unknown, a soft hint).
 *
 *  D-194 #6 — `boundPackSlugs` (the SPECIFIC connection's granted pack set, from
 *  the grant store via `ConnectionView.bound_pack_slugs`) narrows the vendor-match
 *  to packs actually granted on THIS connection, so two accounts of one vendor
 *  (`onedrive_work` vs `onedrive_personal`) don't both list every vendor pack.
 *  Omitted (undefined) ⇒ the grant data is unavailable (dbless / legacy) → the
 *  original vendor-match (back-compat). A pack granted on the connection but
 *  declaring no scope-bearing op is still excluded (nothing to show coverage for),
 *  exactly as before. */
export const packsUsingConnection = (
  manifests: readonly BulkPackManifest[],
  vendor: string,
  granted: readonly string[] | undefined,
  boundPackSlugs?: readonly string[],
): PackConnectionUsage[] => {
  const bound = boundPackSlugs === undefined ? undefined : new Set(boundPackSlugs);
  const out: PackConnectionUsage[] = [];
  for (const manifest of manifests) {
    const needed = requiredScopesByConnection(manifest)[vendor];
    if (needed === undefined) continue; // this pack doesn't use the vendor
    if (bound !== undefined && !bound.has(manifest.slug)) continue; // not granted on THIS connection
    out.push({
      pack_slug: manifest.slug,
      needed,
      coverage: scopeCoverage(needed, granted),
    });
  }
  return out.sort((a, b) => a.pack_slug.localeCompare(b.pack_slug));
};
