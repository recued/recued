import type { RecipeDefinition } from '@recued/contracts';

/** Fill the optional list fields the editor reads as if they were required.
 *  ⛔ Only ADDS empty lists — never changes a value the recipe actually
 *  carries, so what the owner saves is what they wrote plus nothing.
 *  Exported so Kitchen can compare a recipe with the editor's copy (D-333).
 *
 *  D-201 Slice 10BD (10AY findings 12 and 13) — its own module, so the release
 *  panel reads a recipe as the editor holds it. */
export const adoptRecipe = (
  recipe: RecipeDefinition | undefined,
): RecipeDefinition | undefined => {
  if (recipe === undefined) return undefined;
  // D-201 Slice 10AW (10AS finding 30) — a recipe may leave its variables out,
  // as the validator allows: the editor holds them, so it saves them too.
  const withVariables = recipe.variables === undefined ? { ...recipe, variables: {} } : recipe;
  if (Array.isArray(withVariables.prefetch_steps)) return withVariables;
  return { ...withVariables, prefetch_steps: [] };
};

/** JSON with every object's keys in order: a field the adoption adds comes
 *  last, where the recipe that had it keeps it in its place. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** D-201 Slice 10BD (10AY finding 12) — whether two recipes are the same as the
 *  editor holds them, whatever the order of their fields. A release draft saved
 *  without `variables` is the draft the editor holds with `variables: {}`:
 *  compared as written, it could not be tested or activated until it was
 *  saved again. */
export const sameAdoptedRecipe = (left: RecipeDefinition, right: RecipeDefinition): boolean =>
  canonicalJson(adoptRecipe(left)) === canonicalJson(adoptRecipe(right));
