/**
 * D-195 recipe-bundle install resolution.
 *
 * `metadata.recipe_bundle` is the namespaced identity of the pack that owns
 * installation for a recipe: `<pack.publisher>/<pack.slug>`. The field stays
 * optional so recipes without one canonical carrier remain independently
 * installable. A declared bundle resolves only when the published catalog has
 * exactly one globally addressable pack at that identity and the pack pins
 * every current recipe that declares the same key. The pack may contain
 * additional recipes. Missing, duplicate, ambiguous, malformed, or
 * version-drifted carriers fail closed.
 */

import {
  parseRecipeBundleKey,
  validateRecipeBundleKey,
} from './content-policy.js';
import {
  BULK_PACK_MAX_CONTENTS,
  BULK_PACK_MAX_RECIPES,
} from './bulk-pack.js';

export interface RecipeBundleCatalogRecipe {
  recipe_id: string;
  publisher_id: string;
  version: number;
  recipe_bundle?: string;
}

export interface RecipeBundleRecipeRef {
  slug: string;
  version: number;
}

export interface RecipeBundleCatalogPack {
  slug: string;
  publisher_id: string;
  recipe_refs: ReadonlyArray<RecipeBundleRecipeRef>;
}

export type RecipeBundlePackResolution<
  Pack extends RecipeBundleCatalogPack = RecipeBundleCatalogPack,
> =
  | { status: 'none' }
  | {
      status: 'ambiguous';
      bundle_key: string;
      member_count: number;
      candidate_pack_ids: ReadonlyArray<string>;
    }
  | {
      status: 'resolved';
      bundle_key: string;
      members: ReadonlyArray<RecipeBundleRecipeRef>;
      pack: Pack;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isPositiveVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const addRecipeRef = (
  refs: Map<string, number>,
  value: unknown,
): boolean => {
  if (!isRecord(value)) return false;
  const { slug, version } = value;
  if (typeof slug !== 'string' || slug.length === 0 || !isPositiveVersion(version)) {
    return false;
  }
  const previous = refs.get(slug);
  if (previous !== undefined && previous !== version) return false;
  if (previous === undefined && refs.size >= BULK_PACK_MAX_RECIPES) return false;
  refs.set(slug, version);
  return true;
};

/**
 * Project the direct recipe membership from an untrusted v1/v2 bulk-pack
 * manifest. Exact duplicates across legacy `recipes[]` and v2 `contents[]`
 * are deduplicated; malformed/conflicting recipe refs reject the projection so
 * callers cannot accidentally offer a partial pack as a bundle carrier.
 */
export const extractBulkPackRecipeRefs = (
  manifest: unknown,
): RecipeBundleRecipeRef[] | null => {
  if (!isRecord(manifest)) return null;
  const refs = new Map<string, number>();

  if ('recipes' in manifest) {
    if (
      !Array.isArray(manifest.recipes)
      || manifest.recipes.length > BULK_PACK_MAX_RECIPES
    ) {
      return null;
    }
    for (const recipe of manifest.recipes) {
      if (!addRecipeRef(refs, recipe)) return null;
    }
  }

  if ('contents' in manifest) {
    if (
      !Array.isArray(manifest.contents)
      || manifest.contents.length > BULK_PACK_MAX_CONTENTS
    ) {
      return null;
    }
    for (const content of manifest.contents) {
      if (!isRecord(content)) return null;
      if (content.type !== 'recipe') continue;
      if (!addRecipeRef(refs, content)) return null;
    }
  }

  return [...refs.entries()]
    .map(([slug, version]) => ({ slug, version }))
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.version - b.version);
};

const containsRecipeSet = (
  refs: ReadonlyArray<RecipeBundleRecipeRef>,
  expected: ReadonlyMap<string, number>,
): boolean => {
  const seen = new Map<string, number>();
  for (const ref of refs) {
    if (
      typeof ref.slug !== 'string'
      || ref.slug.length === 0
      || !isPositiveVersion(ref.version)
    ) {
      return false;
    }
    const prior = seen.get(ref.slug);
    if (prior !== undefined) return false;
    seen.set(ref.slug, ref.version);
    const expectedVersion = expected.get(ref.slug);
    if (expectedVersion !== undefined && expectedVersion !== ref.version) return false;
  }
  for (const [slug, version] of expected) {
    if (seen.get(slug) !== version) return false;
  }
  return true;
};

/** Resolve the one BulkPackManifest named directly by `target.recipe_bundle`. */
export const resolveRecipeBundleInstallPack = <
  Pack extends RecipeBundleCatalogPack,
>(
  target: RecipeBundleCatalogRecipe,
  recipes: ReadonlyArray<RecipeBundleCatalogRecipe>,
  packs: ReadonlyArray<Pack>,
): RecipeBundlePackResolution<Pack> => {
  const bundleKey = target.recipe_bundle;
  if (
    typeof bundleKey !== 'string'
    || validateRecipeBundleKey(bundleKey).length > 0
  ) {
    return { status: 'none' };
  }
  const parsed = parseRecipeBundleKey(bundleKey);
  if (parsed === null || parsed.publisher !== target.publisher_id) {
    return { status: 'none' };
  }

  const membersBySlug = new Map<string, number>();
  for (const recipe of recipes) {
    if (recipe.recipe_bundle !== bundleKey) continue;
    if (
      recipe.publisher_id !== parsed.publisher
      || typeof recipe.recipe_id !== 'string'
      || recipe.recipe_id.length === 0
      || !isPositiveVersion(recipe.version)
      || membersBySlug.has(recipe.recipe_id)
    ) {
      return { status: 'none' };
    }
    membersBySlug.set(recipe.recipe_id, recipe.version);
  }

  if (membersBySlug.size === 0 || membersBySlug.get(target.recipe_id) !== target.version) {
    return { status: 'none' };
  }

  // Existing pack detail/install transport is slug-addressed. Until that
  // transport becomes publisher-addressed, a cross-publisher slug collision is
  // not safely installable even though recipe_bundle itself is namespaced.
  const candidates = packs.filter((pack) => pack.slug === parsed.bundle_slug);

  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      bundle_key: bundleKey,
      member_count: membersBySlug.size,
      candidate_pack_ids: candidates
        .map((pack) => `${pack.publisher_id}/${pack.slug}`)
        .sort(),
    };
  }

  const carrier = candidates[0]!;
  if (
    carrier.publisher_id !== parsed.publisher
    || !containsRecipeSet(carrier.recipe_refs, membersBySlug)
  ) {
    return { status: 'none' };
  }

  return {
    status: 'resolved',
    bundle_key: bundleKey,
    members: [...membersBySlug.entries()]
      .map(([slug, version]) => ({ slug, version }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.version - b.version),
    pack: carrier,
  };
};
