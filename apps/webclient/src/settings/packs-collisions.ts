/** D-145 PA10 follow-on Slice C — cross-pack recipe collision detection.
 *
 *  A recipe slug ships uniquely per `RecipeStore` row: when two packs
 *  list the same slug in `manifest.recipes[]`, installing the second
 *  pack overwrites the first pack's stored row (the engine's
 *  `markInstalled` upserts by slug). The collision is silent — the user
 *  who installed both packs has no surface telling them which pack's
 *  recipe-version actually landed, and uninstalling either pack
 *  removes the shared slug from the store entirely.
 *
 *  This module computes per-pack collision facts off the `packs.list`
 *  rpc response (which already carries every pack's full manifest). The
 *  Settings → Packs panel consumes the result on each render to surface:
 *
 *    - a row-level badge ("Shares N recipes with [pack-X, pack-Y]")
 *    - a dialog-level warning callout listing collisions grouped by the
 *      OTHER pack shipping each slug
 *    - per-recipe inline markers in the dialog's recipe list ("also in
 *      pack-X") so the user can see which specific entries clash
 *
 *  Pure function — no DOM, no caller dependencies. Tested directly +
 *  through the panel's render assertions.
 *
 *  Scope decisions (READ before extending):
 *
 *  - Only `manifest.recipes[]` slugs are checked.
 *  - Body-content visibility grants are additive across packs by design
 *    (the engine's `grantBodyVisibility` is a set-union operation), so a
 *    "collision" there is informational at best — not surfaced by Slice C.
 *    Slice J (`packs-grant-overlap.ts`) surfaces the overlap as informational
 *    disclosure on both the install dialog and the uninstall delete strip
 *    so the user sees which other installed packs hold each shared grant.
 *  - The collision sign does NOT consider `installed` state. A pack
 *    sharing slugs with an uninstalled-but-bundled pack is still a
 *    collision the user should see, because installing the conflicting
 *    pack later would silently overwrite. The panel's badge / dialog
 *    copy frames the message as "shares" (not "conflicts with already-
 *    installed") so the wording is correct regardless of install order.
 *  - Self-collisions inside a single manifest (the same slug twice in
 *    one pack's `recipes[]`) are blocked by the pack-manifest validator
 *    (`pack_recipe_slug_duplicate`); this module assumes a parsed
 *    manifest and does not re-check intra-pack dedup. */

import type { PackListEntry } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** One colliding recipe entry inside a pack — the slug + version the
 *  pack ships, plus the slugs of OTHER packs that also ship the same
 *  recipe slug (in deterministic alphabetical order so render output
 *  is stable). */
export interface PackRecipeCollisionEntry {
  /** Recipe slug shared across packs. */
  slug: string;
  /** Version this pack pins for the slug. Other packs may pin a
   *  different version — the panel renders this pack's pinned version
   *  in the recipe list; the per-recipe marker reports which other
   *  packs share the slug but not the version mismatch (the install
   *  itself is what materialises the conflict, not the manifest pair). */
  version: number;
  /** Slugs of OTHER packs in the list that ship a recipe with the
   *  same `slug`. Excludes this pack itself. Alphabetically sorted. */
  otherPackSlugs: ReadonlyArray<string>;
}

/** Per-pack collision summary. Empty entries (`recipes.length === 0`)
 *  mean the pack has no cross-pack overlap. */
export interface PackRecipeCollision {
  /** Recipe entries on this pack that also appear in at least one
   *  other pack's manifest. Order matches `manifest.recipes[]`. */
  recipes: ReadonlyArray<PackRecipeCollisionEntry>;
  /** Union of every `otherPackSlugs` entry — the deduped set of other
   *  packs this pack shares any recipe with. Alphabetically sorted.
   *  Drives the row-level badge ("Shares N recipes with [...]"). */
  otherPackSlugs: ReadonlyArray<string>;
}

// ────────────────────────────────────────────────────────────────
// Detection
// ────────────────────────────────────────────────────────────────

/** Compute per-pack recipe collision facts across the panel's pack list.
 *
 *  Returns a `Map` keyed on each input pack's `slug`. Packs with no
 *  collisions still appear in the map with empty arrays — the panel
 *  reads `result.get(pack.slug)?.recipes.length > 0` to decide whether
 *  to render the badge / callout, so always-present entries simplify
 *  the lookup site (no `undefined` branch).
 *
 *  Algorithm:
 *    1. First pass: walk every pack's `manifest.recipes[]` and build a
 *       `Map<recipeSlug, Set<packSlug>>` of which packs ship which
 *       recipe slug. Self-duplicates inside one manifest are dedup'd by
 *       the Set (the pack validator already rejects intra-pack dupes).
 *    2. Second pass: for each pack, iterate its recipes preserving
 *       manifest order. For every recipe whose owner-set has size > 1,
 *       emit a `PackRecipeCollisionEntry` with the other pack slugs
 *       (set minus this pack, sorted). Accumulate the union for
 *       `otherPackSlugs`.
 *
 *  Complexity: O(N × R) where N = pack count + R = max recipes/pack.
 *  Bounded at ~10 × 50 in practice (`BULK_PACK_MAX_RECIPES = 50`); the
 *  panel calls this on every render, so the cheap bound matters. */
export const computePackRecipeCollisions = (
  packs: ReadonlyArray<PackListEntry>,
): Map<string, PackRecipeCollision> => {
  // First pass — recipe-slug → set of pack slugs that ship it.
  const ownersBySlug = new Map<string, Set<string>>();
  for (const pack of packs) {
    for (const ref of pack.recipe_refs) {
      let owners = ownersBySlug.get(ref.slug);
      if (owners === undefined) {
        owners = new Set<string>();
        ownersBySlug.set(ref.slug, owners);
      }
      owners.add(pack.slug);
    }
  }

  // Second pass — per-pack collision projection in manifest order.
  const result = new Map<string, PackRecipeCollision>();
  for (const pack of packs) {
    const collidingRecipes: PackRecipeCollisionEntry[] = [];
    const otherPacksUnion = new Set<string>();
    const seenInPack = new Set<string>();
    for (const ref of pack.recipe_refs) {
      // Skip if this manifest somehow lists the slug twice — the pack
      // validator forbids dupes, but the defensive guard keeps the
      // render list stable if a future malformed manifest slips
      // through (extremely defensive; the validator is the source of
      // truth, this is a belt-and-suspenders skip).
      if (seenInPack.has(ref.slug)) continue;
      seenInPack.add(ref.slug);
      const owners = ownersBySlug.get(ref.slug);
      if (owners === undefined || owners.size <= 1) continue;
      const others: string[] = [];
      for (const owner of owners) {
        if (owner !== pack.slug) others.push(owner);
      }
      others.sort();
      collidingRecipes.push({
        slug: ref.slug,
        version: ref.version,
        otherPackSlugs: others,
      });
      for (const owner of others) otherPacksUnion.add(owner);
    }
    const otherPackSlugs = [...otherPacksUnion].sort();
    result.set(pack.slug, {
      recipes: collidingRecipes,
      otherPackSlugs,
    });
  }

  return result;
};

/** Group a pack's `PackRecipeCollisionEntry[]` by other-pack slug for
 *  dialog rendering. The dialog's warning callout enumerates which
 *  recipes overlap with each other pack — the row-level badge sums them
 *  by other-pack count, but the dialog wants the per-other-pack
 *  breakdown so the user can see "crm-augmentation: bar, baz" rather
 *  than "bar (also in crm-augmentation, sales-aug-hubspot); baz (also
 *  in crm-augmentation)" twice.
 *
 *  Returned entries are sorted by other-pack slug; recipe slugs inside
 *  each group preserve the order they appeared in this pack's manifest
 *  (so the dialog's grouping line matches the recipe list above it). */
export interface PackRecipeCollisionGroup {
  otherPackSlug: string;
  recipeSlugs: ReadonlyArray<string>;
}

export const groupCollisionsByOtherPack = (
  collisions: ReadonlyArray<PackRecipeCollisionEntry>,
): ReadonlyArray<PackRecipeCollisionGroup> => {
  const groups = new Map<string, string[]>();
  for (const entry of collisions) {
    for (const otherPack of entry.otherPackSlugs) {
      let bucket = groups.get(otherPack);
      if (bucket === undefined) {
        bucket = [];
        groups.set(otherPack, bucket);
      }
      bucket.push(entry.slug);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([otherPackSlug, recipeSlugs]) => ({
      otherPackSlug,
      recipeSlugs,
    }));
};
