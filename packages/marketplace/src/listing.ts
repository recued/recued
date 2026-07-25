/** Pure helpers for marketplace listings.
 *
 *  None of these touch the network or persistence. They operate on
 *  already-fetched data so they can be used in both the client (search,
 *  filter, update status) and the publisher tooling (build a listing
 *  from a recipe before uploading).
 */

import { hashRecipe } from '@recued/recipes';
import type { RecipeDefinition } from '@recued/contracts';
import type { InstalledRecipe, MarketplaceListing, UpdateStatus } from './types.js';

/** Convert a validated recipe into the metadata portion of a listing.
 *  Fields the marketplace server controls (published_at, updated_at,
 *  download_count, rating, signature) are left for the server to
 *  populate — this function only derives what can be read from the
 *  recipe body itself.
 *
 *  The recipe body is placed on `recipe` so callers can upload the full
 *  listing as one blob. Clients that only need metadata (search results)
 *  can null out the body before caching. */
export const buildListing = (
  recipe: RecipeDefinition,
  publisher_id: string,
  now: number = Date.now(),
): MarketplaceListing => {
  const meta = recipe.metadata;
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const platforms = Array.isArray(meta.supported_platforms) ? meta.supported_platforms : [];

  return {
    recipe_id: recipe.recipe_id,
    publisher_id,
    version: recipe.version,
    recipe_hash: hashRecipe(recipe),
    name: meta.name,
    description: meta.description,
    platforms,
    tags,
    author: meta.author,
    published_at: now,
    updated_at: now,
    download_count: 0,
    rating: { average: 0, count: 0 },
    variant_group: meta.variant_group ?? null,
    fork_of: meta.fork_of
      ? {
          recipe_id: meta.fork_of.recipe_id,
          // RecipeMetadata.fork_of.author maps to publisher_id in the
          // marketplace vocabulary — the recipe schema uses `author`,
          // the marketplace uses `publisher_id`, but they identify the
          // same scope (a publisher).
          publisher_id: meta.fork_of.author,
          version: meta.fork_of.version,
        }
      : null,
    recipe,
    signature: null,
  };
};

/** Compare an installed recipe against a fresh upstream listing (or a
 *  raw `{version, hash}` pair from a cheap checkUpdate call) and return
 *  the derived update status.
 *
 *  Logic:
 *    1. If the installed hash no longer matches the upstream hash for
 *       the version the user originally installed, the user has edited
 *       the recipe locally → `locally_forked`.
 *    2. Otherwise, if the upstream version is strictly higher than what's
 *       installed, `update_available`.
 *    3. Otherwise, `current`.
 *    4. If no upstream state is provided (never checked), `upstream_unknown`.
 */
export const computeUpdateStatus = (
  installed: InstalledRecipe,
  upstream: { version: number; hash: string } | null,
): UpdateStatus => {
  if (upstream === null) return { state: 'upstream_unknown' };

  // If the installed copy's hash differs from what we last observed
  // upstream at the SAME version, the local copy has been edited.
  // We check against the installed_version because later upstream
  // versions are legitimately different — that's `update_available`, not
  // a fork.
  const currentHashOfInstalled = hashRecipe(installed.recipe);
  const localEdited = currentHashOfInstalled !== installed.installed_hash;
  if (localEdited) {
    return {
      state: 'locally_forked',
      local_hash: currentHashOfInstalled,
      upstream_hash: upstream.hash,
    };
  }

  if (upstream.version > installed.installed_version) {
    return {
      state: 'update_available',
      from: { version: installed.installed_version, hash: installed.installed_hash },
      to: { version: upstream.version, hash: upstream.hash },
    };
  }

  return { state: 'current' };
};

/** True if the installed recipe has been locally edited since install. */
export const isLocallyForked = (installed: InstalledRecipe): boolean =>
  hashRecipe(installed.recipe) !== installed.installed_hash;
