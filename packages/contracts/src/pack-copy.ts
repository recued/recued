/** D-333 — packs work as recipes do: editing another author's pack makes a copy of your own.
 *
 *  A copy takes the pack's composition (its operations and data fields) under new names, so
 *  installing it adds a pack beside the original rather than over it: a local install may not
 *  take a marketplace pack's slug, and the original keeps its updates. Only the names that
 *  identify the composition and its ingredients change. A tool, a connection or a URL that
 *  happens to share the name stays as it is, so a copy of a cli pack still runs that program
 *  and a copy of an api pack still signs in with the owner's connection.
 *
 *  The pack's recipes stay with the original: they name it. A recipe uses the copy only when
 *  its own source says so — `depends_on` and each step's `op` name the copy
 *  (`local-authoring.freshdesk-copy`) instead of the original (`recued-core.freshdesk`). */
import type { BulkPackManifest, CompositionIngredient } from './bulk-pack.js';
import type { RecipeDefinition } from './recipe.js';

/** The publisher of packs made in Kitchen — the pack builder's default. Recipes reach such a
 *  pack as `local-authoring.<slug>`. */
export const KITCHEN_PACK_PUBLISHER = 'local-authoring';

/** Appended to every renamed slug. */
export const PACK_COPY_SUFFIX = '-copy';

/** How a recipe names a pack: `<publisher>.<slug>`, as in `depends_on` and before each `op`. */
export const PACK_REF_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

export interface PackCopy {
  /** What the copy is called while it is in progress. */
  title: string;
  composition: CompositionIngredient;
  /** The pack the copy installs as: the original's details under the owner's publisher and
   *  a slug of its own, which recipes use to reach it. */
  pack: Record<string, unknown>;
  /** The original has recipes, which the copy does not take. */
  leavesRecipes: boolean;
}

/** The copy of a pack's composition, or null when the pack has none to edit. */
export const packCopyFor = (manifest: BulkPackManifest): PackCopy | null => {
  const content = manifest.contents?.find((entry) => entry.type === 'composition');
  if (content === undefined || content.type !== 'composition') return null;
  const original = content.composition;
  const renamed = new Map<string, string>([[original.slug, `${original.slug}${PACK_COPY_SUFFIX}`]]);
  for (const ingredient of original.ingredients) renamed.set(ingredient.slug, `${ingredient.slug}${PACK_COPY_SUFFIX}`);
  const composition: CompositionIngredient = {
    ...original,
    slug: renamed.get(original.slug)!,
    // Written by its owner now, not shipped by a publisher.
    catalog_kind: 'private_byo',
    ingredients: original.ingredients.map((ingredient) => ({ ...ingredient, slug: renamed.get(ingredient.slug)! })),
    operations: original.operations.map((operation) => ({
      ...operation,
      ingredient: renamed.get(operation.ingredient) ?? operation.ingredient,
    })),
  };
  const title = `Copy of ${manifest.name}`;
  return {
    title,
    composition,
    pack: {
      slug: `${manifest.slug}${PACK_COPY_SUFFIX}`,
      publisher: KITCHEN_PACK_PUBLISHER,
      // What it copies, so a recipe can be switched between the two with one button.
      copy_of: `${manifest.publisher}.${manifest.slug}`,
      name: title,
      description: manifest.description,
      tags: manifest.tags,
      ...(manifest.pack_kind !== undefined ? { pack_kind: manifest.pack_kind } : {}),
      ...(manifest.service_kind !== undefined ? { service_kind: manifest.service_kind } : {}),
      ...(manifest.dependencies !== undefined ? { dependencies: manifest.dependencies } : {}),
    },
    leavesRecipes: manifest.recipes.length > 0 || (manifest.contents ?? []).some((entry) => entry.type === 'recipe'),
  };
};

/** D-333 — a recipe switched from one pack to another (an original and its copy): every string
 *  in it that names `from` — the pack itself, or one of its operations (`from.` and more) —
 *  names `to` instead. That is its `depends_on`, each step's `op`, and the summary text and
 *  settings that repeat them. A name only containing it elsewhere in longer text is left. */
export const repointRecipePack = (recipe: RecipeDefinition, from: string, to: string): RecipeDefinition => {
  const repoint = (value: unknown): unknown => {
    if (typeof value === 'string') return value === from || value.startsWith(`${from}.`) ? `${to}${value.slice(from.length)}` : value;
    if (Array.isArray(value)) return value.map(repoint);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, repoint(inner)]));
    }
    return value;
  };
  return repoint(recipe) as RecipeDefinition;
};

