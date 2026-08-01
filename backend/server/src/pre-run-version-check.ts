/** D-067 — pre-run ingredient compatibility check.
 *
 *  Walks every ingredient step (prefetch + sequential) BEFORE the executor is
 *  built and reports any whose pinned `ingredient_version` is below the
 *  installed manifest's `min_version` — i.e. the recipe was authored against a
 *  shape the ingredient no longer honours.
 *
 *  WHY THIS EXISTS (and why it did not, for a long time). D-067 declared this
 *  check in the decisions log and described it as running inside `runRecipe`
 *  via `validateIngredientRefs`. Neither existed: there is no `runRecipe` in
 *  production engine code, `validateIngredientRefs` has no production caller,
 *  and nothing read `pinned_version` at execution. What shipped instead was an
 *  exact-version-miss throw inside the STEP RUNNER — which fires per step,
 *  mid-run, so steps 1..n-1 have already executed and spent their API calls.
 *  That is precisely the partial-execution failure D-067 claimed to have
 *  removed. Amended in the log 2026-07-28; this module is the implementation.
 *
 *  DELIBERATELY NARROW. Only the condition D-067 names is fatal:
 *
 *    · a MISSING manifest is NOT rejected. The ingredient may not be installed
 *      yet, and a conditional step may never run. Rejecting here would refuse
 *      recipes that work today. The runtime still surfaces it at the step.
 *    · a pin merely BEHIND the current version is NOT rejected — that is the
 *      `ingredient_version_behind` info case, not a break.
 *    · a `{{ref}}` slug is skipped: it cannot be resolved before dispatch (the
 *      kernel `run-ingredient` recipe is the standing example).
 *
 *  COST. One pass over the step list plus a synchronous `manifests.get(slug)`
 *  per unique slug — the same in-memory store the policy gate one line above
 *  already consults. No I/O, no async. This runs on every dispatch including
 *  reactive and housekeeping fires, which is why it stays this cheap.
 *
 *  The "is this breaking" comparison itself lives in `@recued/recipes`
 *  (`isBreakingIngredientPin`), shared with the authoring-time validator so the
 *  two surfaces cannot drift into disagreeing about the same recipe. */

import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { isBreakingIngredientPin } from '@recued/recipes';

export interface BreakingIngredientPin {
  step_id: string;
  ingredient: string;
  /** The version the recipe pinned. */
  pinned_version: number;
  /** The installed manifest's current version. */
  current_version: number;
  /** The oldest pin the current ingredient still honours. */
  min_version: number;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const own = (value: Record<string, unknown>, key: string): unknown =>
  hasOwn(value, key) ? value[key] : undefined;

/** A slug we can resolve now. A `{{ref}}` is dispatched at runtime. Mirrors the
 *  authoring validator's rule so both skip the same steps. */
const isStaticSlug = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !(v.includes('{{') && v.includes('}}'));

/** Every ingredient step, prefetch first then sequential — the order the
 *  engine would run them, so the first reported break is the first a run would
 *  actually have hit. */
const ingredientSteps = (
  recipe: RecipeDefinition,
): Array<{ id: string; slug: string; pinned: number | undefined }> => {
  const out: Array<{ id: string; slug: string; pinned: number | undefined }> = [];
  const collect = (steps: readonly unknown[] | undefined): void => {
    for (const step of steps ?? []) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
      const s = step as Record<string, unknown>;
      const ingredient = own(s, 'ingredient');
      if (!isStaticSlug(ingredient)) continue;
      const pinned = own(s, 'ingredient_version');
      const id = own(s, 'id');
      out.push({
        id: typeof id === 'string' ? id : '',
        slug: ingredient,
        pinned: typeof pinned === 'number' ? pinned : undefined,
      });
    }
  };
  collect(recipe.prefetch_steps as readonly unknown[] | undefined);
  collect(recipe.steps as readonly unknown[] | undefined);
  return out;
};

/** The check. Returns every breaking pin, in step order — empty means admit.
 *
 *  Returns ALL of them rather than the first: an author fixing a stale recipe
 *  wants the whole list, not one re-run per broken step. */
export const findBreakingIngredientPins = (
  recipe: RecipeDefinition,
  getManifest: (slug: string) => IngredientManifest | undefined,
): BreakingIngredientPin[] => {
  const found: BreakingIngredientPin[] = [];
  const manifests = new Map<string, IngredientManifest | undefined>();
  for (const step of ingredientSteps(recipe)) {
    if (step.pinned === undefined) continue; // unpinned steps float with the install
    if (!manifests.has(step.slug)) manifests.set(step.slug, getManifest(step.slug));
    const manifest = manifests.get(step.slug);
    if (!isBreakingIngredientPin(step.pinned, manifest)) continue;
    found.push({
      step_id: step.id,
      ingredient: step.slug,
      pinned_version: step.pinned,
      // Both are non-null here — `isBreakingIngredientPin` returned true, which
      // requires each. Narrowed for the type checker, not re-checked.
      current_version: manifest!.version as number,
      min_version: manifest!.min_version as number,
    });
  }
  return found;
};

/** One operator-facing line per break. Mirrors the wording the authoring-time
 *  validator emits (`ingredient_breaking_change`) so a recipe rejected at
 *  dispatch reads the same as one flagged in the editor. */
export const describeBreakingIngredientPin = (
  pin: BreakingIngredientPin,
): string =>
  `Ingredient '${pin.ingredient}' has breaking changes: step '${pin.step_id}' `
  + `pins v${pin.pinned_version}, installed is v${pin.current_version} `
  + `(min compatible: v${pin.min_version}). Update the step's input/output `
  + `references and re-pin, or reinstall a compatible ingredient version.`;
