/** Recipes list→detail — the ONE pack-provenance derivation.
 *
 *  A recipe belongs to a pack through two independent, non-overlapping fields:
 *
 *  - `metadata.recipe_bundle` — `<publisher>/<pack_slug>`, the pack that OWNS
 *    the recipe. Set on every recipe a `packs.install` bulk manifest ships.
 *  - `depends_on: ["<publisher>.<pack>"[@N]]` — D-182 §3, the OTHER packs whose
 *    Tier-P ops the recipe calls, so the install-consent flow can co-install
 *    them.
 *
 *  They are not redundant and neither implies the other. A pack's own recipes
 *  call their own pack's ops, and `uncoveredOpDependencies` is advisory rather
 *  than a gate (`backend/server/src/op-step-save-check.ts` pushes a WARNING,
 *  never an error), so a pack-owned recipe that only uses its OWN ops declares
 *  no `depends_on` at all. That is the normal, correct authoring shape — it is
 *  what all four D-221 Records packs do, and 136 recipes in `community/` are
 *  in it.
 *
 *  Reading only `depends_on` — as the route did before this module — therefore
 *  reported those recipes as belonging to NO pack: no "from pack" label, absent
 *  from every pack filter chip, and matched by the "Standalone" chip, which is
 *  the one claim that is affirmatively false for a pack member. Records made
 *  that acute (a Records pack IS its recipes plus the state they share), but
 *  the gap predates it and this fixes both.
 *
 *  Both fields normalise onto ONE key space — the `depends_on` `pack_ref`
 *  (`<publisher>.<pack>`), because that is what `parseDependsOn` already
 *  produces and what the existing filter-chip values are — so a single chip
 *  value selects a pack's recipes whichever field named it.
 *
 *  Pure: same recipe → same list. Reads both fields defensively (they arrive
 *  from a network-fetched, possibly untrusted recipe body).
 */

import { parseDependsOn } from '@recued/contracts';

/** How a recipe is attached to a pack. `bundle` is strictly stronger: the pack
 *  owns and ships the recipe, so it wins when one pack is named by both. */
export type RecipePackRelation = 'bundle' | 'depends_on';

/** One pack a recipe is attached to, keyed in the `depends_on` key space. */
export interface RecipePackRef {
  /** `<publisher>.<pack>` — the filter-chip value and the card's pack attr. */
  pack_ref: string;
  publisher: string;
  /** Installable marketplace pack slug. */
  pack: string;
  relation: RecipePackRelation;
  /** Version floor, `depends_on` only (`…@N`). Absent on a bundle ref: the
   *  owning pack ships the recipe, so there is nothing to pin. */
  min_version?: number;
}

/** The loose recipe shape both fields are read off. A `RecipeDefinition`
 *  satisfies it; so does a raw catalog row. */
export interface PackProvenanceRecipe {
  metadata?: { recipe_bundle?: unknown } | undefined;
  depends_on?: unknown;
}

/** Parse `metadata.recipe_bundle` (`<publisher>/<pack_slug>`) into the shared
 *  `<publisher>.<pack>` key space. Returns null for a missing, non-string,
 *  empty, or malformed value — `validateRecipeBundleKey` enforces the exactly-
 *  one-`/` shape at publish time, but this reads an installed body, so a
 *  malformed one is dropped rather than thrown. */
export const parseRecipeBundle = (
  recipe: PackProvenanceRecipe,
): RecipePackRef | null => {
  const raw = recipe.metadata?.recipe_bundle;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [publisher, pack] = parts;
  if (publisher === undefined || pack === undefined) return null;
  // Re-use the `depends_on` parser as the single validator for the slug pair —
  // one SLUG_RE, so a bundle key and a dep entry can never disagree on what a
  // legal publisher/pack looks like.
  const parsed = parseDependsOn(`${publisher}.${pack}`);
  if (parsed === null) return null;
  return {
    pack_ref: parsed.pack_ref,
    publisher: parsed.publisher,
    pack: parsed.pack,
    relation: 'bundle',
  };
};

/** Every pack a recipe is attached to — owning bundle first, then the
 *  `depends_on` packs sorted by slug for a stable render. Deduped by
 *  `pack_ref`; a pack named by BOTH fields appears once as `bundle` (it owns
 *  the recipe — that it also supplies ops is not a second, weaker fact). */
export const recipePackRefs = (
  recipe: PackProvenanceRecipe,
): RecipePackRef[] => {
  const bundle = parseRecipeBundle(recipe);
  const byRef = new Map<string, RecipePackRef>();
  if (bundle !== null) byRef.set(bundle.pack_ref, bundle);

  const raw = Array.isArray(recipe.depends_on) ? recipe.depends_on : [];
  const deps = new Map<string, RecipePackRef>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const parsed = parseDependsOn(entry);
    if (parsed === null) continue; // malformed / not a <publisher>.<pack> ref
    if (byRef.has(parsed.pack_ref)) continue; // the owning bundle already won
    const prev = deps.get(parsed.pack_ref);
    // Same pack pinned twice → keep the stricter (higher) floor, matching
    // `recipeRequiredPacks`.
    if (prev !== undefined && (prev.min_version ?? 0) >= (parsed.min_version ?? 0)) {
      continue;
    }
    deps.set(parsed.pack_ref, {
      pack_ref: parsed.pack_ref,
      publisher: parsed.publisher,
      pack: parsed.pack,
      relation: 'depends_on',
      ...(parsed.min_version === undefined ? {} : { min_version: parsed.min_version }),
    });
  }

  return [
    ...byRef.values(),
    ...[...deps.values()].sort((a, b) => a.pack.localeCompare(b.pack)),
  ];
};

/** True when a recipe genuinely belongs to no pack — the only state the
 *  "Standalone" filter chip should match. */
export const recipeIsStandalone = (recipe: PackProvenanceRecipe): boolean =>
  recipePackRefs(recipe).length === 0;

/** Display label for a pack slug: `job-status-board` → "Job status board",
 *  `email-outbox-pack` → "Email outbox" (the redundant `-pack` suffix is
 *  dropped — every row in this UI is a pack). */
export const packSlugLabel = (pack: string): string => {
  const short = pack.replace(/-pack$/, '');
  const spaced = short.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
