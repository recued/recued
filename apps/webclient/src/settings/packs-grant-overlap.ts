/** D-145 PA10 follow-on Slice J — cross-pack body-grant overlap detection.
 *
 *  Body-grant overlap is informational, not a conflict — the engine's
 *  grant store unions across packs by design (`grantBodyVisibility` is
 *  a set-union, see `packs-collisions.ts:31-33` for the rationale Slice C
 *  used to exclude grants from collision detection). But the user's
 *  mental model often assumes uninstall releases the grant: not true if
 *  another installed pack still declares it. Slice J surfaces the
 *  overlap so the user sees:
 *
 *    - Install dialog: "this body-content is already accessible via
 *      pack X" → reassures the user the install doesn't widen exposure
 *    - Uninstall delete strip: "this body-content remains accessible
 *      via pack X" → corrects the mental model that uninstall revokes
 *      the grant
 *
 *  Considers only INSTALLED packs as overlap counterparties. The engine's
 *  grant store reflects installed state: a bundled-but-uninstalled pack
 *  declaring the same key is not yet contributing to the live grant set,
 *  so disclosing it would confuse rather than clarify (the user would
 *  think "X grants this too" when X isn't installed). When the user
 *  later installs X, this same function recomputes and surfaces the new
 *  overlap from X's install dialog.
 *
 *  Pure function — no DOM, no caller dependencies. Tested directly +
 *  through the panel's render assertions.
 *
 *  Scope decisions (READ before extending):
 *
 *  - Pack-vs-self never registers — a pack does not overlap with itself
 *    even if it's installed. The overlap set excludes `pack.slug`.
 *  - The subject pack's own `installed` flag does NOT change the
 *    overlap. For pack A being installed (A.installed = false), the
 *    overlap is "other INSTALLED packs that already grant A's keys";
 *    for pack A being uninstalled (A.installed = true), the overlap is
 *    "other INSTALLED packs that ALSO grant A's keys". The math is the
 *    same: counterparties are filtered on `installed === true`, never
 *    the subject.
 *  - `mcp_body_visibility_grants` is a closed list bounded at
 *    `BULK_PACK_MAX_BODY_VISIBILITY_GRANTS` (currently 16); intra-pack
 *    duplicates are blocked by the manifest validator (`bulk-pack.ts`
 *    `pack_body_visibility_grant_duplicate`). The defensive `seenInPack`
 *    Set guards against any future malformed manifest. */

import type { PackListEntry } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** One overlapping body-grant entry on a subject pack — the grant key
 *  the pack declares, plus the slugs of OTHER INSTALLED packs that also
 *  declare the same key (in deterministic alphabetical order so render
 *  output is stable). */
export interface PackGrantOverlapEntry {
  /** Body-grant key shared across packs. */
  grantKey: string;
  /** Slugs of OTHER INSTALLED packs that also declare `grantKey`.
   *  Excludes this pack itself. Alphabetically sorted. Always
   *  non-empty by construction — entries with zero counterparties are
   *  omitted from the parent `PackGrantOverlap.grants` array. */
  otherPackSlugs: ReadonlyArray<string>;
}

/** Per-pack body-grant overlap summary. Empty entries
 *  (`grants.length === 0`) mean the pack has no overlap with any other
 *  INSTALLED pack — either no body-grants declared, or none shared. */
export interface PackGrantOverlap {
  /** Grant entries on this pack whose key is also declared by at least
   *  one other INSTALLED pack in the list. Order matches the subject
   *  pack's `manifest.mcp_body_visibility_grants` array. */
  grants: ReadonlyArray<PackGrantOverlapEntry>;
  /** Union of every `otherPackSlugs` entry — the deduped set of other
   *  packs this pack shares any body-grant with. Alphabetically sorted.
   *  Drives any future row-level badge ("Shares N body-grants with
   *  [...]"). */
  otherPackSlugs: ReadonlyArray<string>;
}

// ────────────────────────────────────────────────────────────────
// Detection
// ────────────────────────────────────────────────────────────────

/** Compute per-pack body-grant overlap facts across the panel's pack list.
 *
 *  Returns a `Map` keyed on each input pack's `slug`. Packs with no
 *  overlap still appear in the map with empty arrays — the panel reads
 *  `result.get(pack.slug)?.grants.length > 0` to decide whether to
 *  render the disclosure, so always-present entries simplify the lookup
 *  site (no `undefined` branch).
 *
 *  Algorithm:
 *    1. First pass: walk every INSTALLED pack's
 *       `manifest.mcp_body_visibility_grants` array and build a
 *       `Map<grantKey, Set<packSlug>>` of which installed packs ship
 *       which grant. Self-duplicates inside one manifest are dedup'd
 *       by the Set. Uninstalled packs are skipped — they don't
 *       contribute to the live grant set.
 *    2. Second pass: for each pack (installed OR not), iterate its
 *       grants preserving manifest order. For every grant whose
 *       installed-owner-set has any member other than this pack, emit
 *       a `PackGrantOverlapEntry` with the other pack slugs sorted.
 *       Accumulate the union for `otherPackSlugs`.
 *
 *  Complexity: O(N × G) where N = pack count + G = max grants/pack.
 *  Bounded at ~10 × 16 in practice; the panel calls this on every
 *  render, so the cheap bound matters. */
export const computePackGrantOverlaps = (
  packs: ReadonlyArray<PackListEntry>,
): Map<string, PackGrantOverlap> => {
  // First pass — grant-key → set of INSTALLED pack slugs that ship it.
  // Uninstalled packs are skipped: the engine's grant set only reflects
  // installed packs, so an uninstalled bundled pack declaring the same
  // key is not yet a counterparty (see scope decision #2 in the file
  // docstring).
  const installedOwnersByKey = new Map<string, Set<string>>();
  for (const pack of packs) {
    if (!pack.installed) continue;
    const grants = pack.body_visibility_grant_keys;
    for (const key of grants) {
      let owners = installedOwnersByKey.get(key);
      if (owners === undefined) {
        owners = new Set<string>();
        installedOwnersByKey.set(key, owners);
      }
      owners.add(pack.slug);
    }
  }

  // Second pass — per-pack overlap projection in manifest order.
  // Iterates over ALL packs (installed OR not) because the install
  // dialog renders for not-yet-installed packs and needs to know the
  // overlap before committing.
  const result = new Map<string, PackGrantOverlap>();
  for (const pack of packs) {
    const overlappingGrants: PackGrantOverlapEntry[] = [];
    const otherPacksUnion = new Set<string>();
    const seenInPack = new Set<string>();
    const grants = pack.body_visibility_grant_keys;
    for (const key of grants) {
      // Defensive intra-pack dedup. The manifest validator forbids
      // duplicate grant keys in one pack (`bulk-pack.ts`
      // `pack_body_visibility_grant_duplicate`); the skip guards a
      // future malformed manifest that bypassed validation.
      if (seenInPack.has(key)) continue;
      seenInPack.add(key);
      const owners = installedOwnersByKey.get(key);
      if (owners === undefined) continue;
      const others: string[] = [];
      for (const owner of owners) {
        if (owner !== pack.slug) others.push(owner);
      }
      if (others.length === 0) continue;
      others.sort();
      overlappingGrants.push({
        grantKey: key,
        otherPackSlugs: others,
      });
      for (const owner of others) otherPacksUnion.add(owner);
    }
    const otherPackSlugs = [...otherPacksUnion].sort();
    result.set(pack.slug, {
      grants: overlappingGrants,
      otherPackSlugs,
    });
  }

  return result;
};
