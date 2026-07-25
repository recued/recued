/** D-179 P5b — derive the registered file slug(s) a recipe needs.
 *
 *  The queue-sweeper pattern (spec § 4) reads completion evidence out
 *  of a REGISTERED file collection slug (the drop dir), but nothing
 *  surfaced that need at install — the codex pipeline's setup text
 *  said "register the result directory as a file slug" in prose. This
 *  mirrors `required-connections.ts` (UX-review flow-10): a pure
 *  derivation the pack-install dialog aggregates for the pre-install
 *  disclosure, pointing at registration (Connections → Files /
 *  `collection.file.enroll`).
 *
 *  A recipe declares the need two ways, both surfaced:
 *
 *    - a `type: 'file_slug'` variable (the user picks/registers the
 *      slug at config time) → carries the variable key + label;
 *    - a LITERAL `input.slug` on a `file-*` step (the recipe pins a
 *      specific slug) → carries the slug name. Template refs
 *      (`{{config.*}}` etc.) are skipped here — those resolve to a
 *      variable-declared need or runtime state, not a static one.
 *
 *  Pure — same recipe → same list (sorted for stable rendering).
 */

import type { RecipeDefinition, ValueHint } from '@recued/contracts';

export interface RequiredFileSlug {
  /** Literal slug when a `file-*` step pins one inline; null when a
   *  `type:'file_slug'` variable defers the choice to install config. */
  slug: string | null;
  /** Variable key, for variable-declared needs. */
  variable: string | null;
  /** The variable hint's label, when present — the human description
   *  the disclosure renders ("Registered file slug of the result drop
   *  directory"). */
  label: string | null;
}

/** Every `file-*` ingredient whose `input.slug` names a registered
 *  file collection instance (D-172 unified file substrate). */
const FILE_SLUG_INGREDIENTS: ReadonlySet<string> = new Set([
  'file-list',
  'file-get',
  'file-read',
  'file-stat',
  'file-write',
  'file-delete',
  'file-move',
]);

const isTemplated = (value: string): boolean => value.includes('{{');

/** Collapse to the distinct set the dialog renders. Variable needs key
 *  on the variable name; literal needs on the slug. Sorted: variable
 *  needs first (the configurable ones), then literals, each
 *  alphabetically. */
export const dedupeRequiredFileSlugs = (
  needs: ReadonlyArray<RequiredFileSlug>,
): RequiredFileSlug[] => {
  const byVariable = new Map<string, RequiredFileSlug>();
  const bySlug = new Map<string, RequiredFileSlug>();
  for (const need of needs) {
    if (need.variable !== null) {
      // First label wins — packs reuse a variable key across recipes.
      if (!byVariable.has(need.variable)) byVariable.set(need.variable, need);
    } else if (need.slug !== null && need.slug.length > 0) {
      if (!bySlug.has(need.slug)) bySlug.set(need.slug, need);
    }
  }
  const variables = [...byVariable.values()].sort((a, b) =>
    (a.variable ?? '').localeCompare(b.variable ?? ''));
  const literals = [...bySlug.values()].sort((a, b) =>
    (a.slug ?? '').localeCompare(b.slug ?? ''));
  return [...variables, ...literals];
};

export const recipeRequiredFileSlugs = (
  recipe: RecipeDefinition,
): RequiredFileSlug[] => {
  const raw: RequiredFileSlug[] = [];

  // 1. `type: 'file_slug'` variables — the configurable drop dir.
  for (const [key, def] of Object.entries(recipe.variables ?? {})) {
    if (
      typeof def === 'object' && def !== null && !Array.isArray(def)
      && (def as ValueHint).type === 'file_slug'
    ) {
      const label = (def as ValueHint).label;
      raw.push({
        slug: null,
        variable: key,
        label: typeof label === 'string' && label.length > 0 ? label : null,
      });
    }
  }

  // 2. Literal `input.slug` on `file-*` steps — a pinned slug.
  for (const step of recipe.steps ?? []) {
    const ingredient = (step as { ingredient?: unknown }).ingredient;
    if (typeof ingredient !== 'string' || !FILE_SLUG_INGREDIENTS.has(ingredient)) continue;
    const input = (step as { input?: unknown }).input;
    if (typeof input !== 'object' || input === null) continue;
    const slug = (input as { slug?: unknown }).slug;
    if (typeof slug === 'string' && slug.length > 0 && !isTemplated(slug)) {
      raw.push({ slug, variable: null, label: null });
    }
  }

  return dedupeRequiredFileSlugs(raw);
};
