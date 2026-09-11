#!/usr/bin/env node
/**
 * Generate `backend/server/src/bundled-foundation.generated.ts` from the repo's
 * `community/` — the pre_install + bundled pack manifests + the recipes they
 * reference, embedded as frozen TS constants.
 *
 * WHY: `community/` is NOT shipped in either distribution (npm `files` excludes
 * it; the Docker runtime stage never COPYs it), and `findCommunityDir()`
 * mis-resolves for the bundled `dist/bin.js` layout — so on a fresh Docker/npm
 * deploy the foundation pack pre-installs NOTHING (empirically: 0 recipes). The
 * marketplace tail is fine (resolve-by-slug is online), but the foundation
 * pack is Day-1 substrate that must ship. Embedding it into the bundle (like
 * the kernel `RUN_INGREDIENT_RECIPE` constant) makes it survive the
 * distribution while keeping `community/` a repo-only marketplace-seed + test
 * source. `recipe-store` merges the embedded recipes into its bundled cache;
 * `foundation-pack-pre-install` unions the embedded packs into its scan — both
 * FS-wins-when-present, so a git-clone dev build is unchanged.
 *
 * Regenerate whenever a foundation pack or its recipes change:
 *   node backend/server/scripts/gen-bundled-foundation.mjs
 * `bundled-foundation-embed.test.ts` fails if this file is stale (drift guard).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Recursively collect *.json (packs nest one level under a publisher dir). */
const walkJson = (dir) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
};

/** Pure derivation — read `community/` under `repoRoot` and return the
 *  foundation embed shape. Exported so the drift test can regenerate-and-compare
 *  against the committed constants (catches ANY drift: slug set, pack body,
 *  recipe set, recipe body). Deterministic order (packs by slug, recipes by
 *  key) so the compare is stable. Throws on a missing referenced recipe file. */
/** Every recipe a foundation pack references, across BOTH manifest shapes.
 *
 *  ⛔ manifest_version 2 moved recipe references out of the top-level
 *  `recipes[]` into `contents[]` entries typed `recipe`. Reading only
 *  `recipes[]` does not throw on a v2 pack — it returns nothing, so the pack
 *  still bundles while its recipe BODIES silently stop being embedded. That is
 *  how the foundation pack's 10 recipes left this bundle after `81e73a6b8`,
 *  leaving a manifest that names them and no bodies to resolve. `missing` could
 *  not catch it either: it only reports refs that were walked, and none were.
 *
 *  The corpus is MIXED — `personal-organizer-foundation` is v2 with 10 refs in
 *  `contents[]`, `reception-scheduling` is v2 with 3 still in `recipes[]` — so
 *  this unions both and dedupes by slug.
 *
 *  ⚠ Keep this identical to `deriveFoundationClosure` in
 *  `release/lib/public-export.mjs`. The two are required to agree; drift means
 *  the public repo ships recipe JSON that disagrees with what the server
 *  bundles. */
export const foundationRecipeRefs = (manifest) => {
  const bySlug = new Map();
  for (const ref of manifest.recipes ?? []) {
    if (ref?.slug) bySlug.set(ref.slug, ref);
  }
  for (const entry of manifest.contents ?? []) {
    if (entry?.type === 'recipe' && entry.slug) bySlug.set(entry.slug, entry);
  }
  return [...bySlug.values()];
};

export const deriveFoundationBundle = (repoRoot) => {
  const packsDir = join(repoRoot, 'community', 'packs');
  const recipesDir = join(repoRoot, 'community', 'recipes');

  const packs = [];
  for (const file of walkJson(packsDir)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    // Owner ruling 2026-09-07 — TWO reasons to be in the binary, and they are
    // no longer the same flag. `pre_install` is a core feature the server
    // installs itself and never lists; `bundled` is an ordinary pack that must
    // EXIST on a distribution for the owner to find and install it. Selecting on
    // `pre_install` alone would drop every manageable pack out of the artifact
    // the moment it stopped auto-installing — invisible AND uninstallable, which
    // is the failure this whole area is made of.
    if (manifest?.pre_install === true || manifest?.bundled === true) packs.push(manifest);
  }
  packs.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));

  // Recipes referenced by a foundation pack, keyed by recipe_id (matching
  // `recipe-store`'s bundled-cache key + `getBundled(ref.slug)` lookup, where
  // slug === recipe_id for first-party foundation recipes).
  const recipesById = {};
  const missing = [];
  for (const pack of packs) {
    for (const ref of foundationRecipeRefs(pack)) {
      const path = join(recipesDir, `${ref.slug}.json`);
      if (!existsSync(path)) {
        missing.push(`${pack.slug}:${ref.slug}`);
        continue;
      }
      const recipe = JSON.parse(readFileSync(path, 'utf-8'));
      recipesById[recipe.recipe_id ?? ref.slug] = recipe;
    }
  }
  if (missing.length > 0) {
    throw new Error(`missing referenced recipe files: ${missing.join(', ')}`);
  }
  const recipes = {};
  for (const k of Object.keys(recipesById).sort()) recipes[k] = recipesById[k];
  return { packs, recipes };
};

/** Render the generated .ts source from a derived bundle. */
export const renderBundleModule = ({ packs, recipes }) =>
  `/* GENERATED by backend/server/scripts/gen-bundled-foundation.mjs — DO NOT EDIT.
 *
 * Embeds pre_install + bundled pack manifests + their recipes so a deployed
 * server pre-installs Day-1 content even though the distribution ships no
 * community/ dir. Regenerate: node backend/server/scripts/gen-bundled-foundation.mjs
 * (bundled-foundation-embed.test.ts fails if this drifts from community/). */
/* eslint-disable */
// prettier-ignore
import type { BulkPackManifest, RecipeDefinition } from '@recued/contracts';

// prettier-ignore
export const BUNDLED_FOUNDATION_PACKS: readonly BulkPackManifest[] =
  ${JSON.stringify(packs, null, 2)} as unknown as readonly BulkPackManifest[];

// prettier-ignore
export const BUNDLED_FOUNDATION_RECIPES: Readonly<Record<string, RecipeDefinition>> =
  ${JSON.stringify(recipes, null, 2)} as unknown as Readonly<Record<string, RecipeDefinition>>;
`;

// Run as a script → (re)write the generated module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const out = join(repoRoot, 'backend', 'server', 'src', 'bundled-foundation.generated.ts');
  const bundle = deriveFoundationBundle(repoRoot);
  writeFileSync(out, renderBundleModule(bundle));
  console.log(
    `[gen-bundled-foundation] wrote ${out}\n  packs: ${bundle.packs.map((p) => p.slug).join(', ')}\n  recipes: ${Object.keys(bundle.recipes).length}`,
  );
}
