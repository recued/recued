/** A recipe as Chat names it: `<publisher>/<recipe_id>` for a Tier 2 tool, or
 *  the bare recipe id. */

import type { ToolTier } from '@recued/contracts';
import { recipeActsInBrowser } from './bridges/browser-flow-record.js';
import type { RecipeStore } from './recipe-store.js';

/** Codex review P2 fold (2026-05-12) — resolve publisher-qualified
 *  recipe ids. The `recipe.run` descriptor (§ A.13) tells the model to
 *  invoke recipes by `<publisher>/<slug>`, but `RecipeStore.get()` is
 *  keyed by the bare recipe_id (publisher lives in a separate
 *  `StoredRecipe.publisher_id` column). The lookup tries the literal
 *  string first (works when a recipe_id happens to contain `/`); on
 *  miss + presence of a `/`, retries with the substring after the
 *  first slash. Returns the resolved id or the original on miss
 *  (handleExecute then surfaces `recipe_not_found` verbatim). */
export const resolveRecipeId = (
  raw: string,
  recipeStore: Pick<RecipeStore, 'get'>,
): string => {
  if (recipeStore.get(raw)) return raw;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return raw;
  const stripped = raw.slice(slash + 1);
  return recipeStore.get(stripped) ? stripped : raw;
};

/** A recipe tool's title as the owner sees it ("Send a composed email" for
 *  `recued-core/send-composed-mail`), or undefined when no installed recipe
 *  answers to the name or its title is empty. */
export const recipeToolTitle = (
  recipeStore: Pick<RecipeStore, 'get'>,
  tool_name: string,
): string | undefined => {
  const name: unknown = recipeStore.get(resolveRecipeId(tool_name, recipeStore))?.metadata?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
};

/** D-402 slice A4 — whether the installed recipe a chat names acts in a web page. */
export const recipeToolActsInBrowser = (
  recipeStore: Pick<RecipeStore, 'get'>,
  tool_name: string,
): boolean => {
  const recipe = recipeStore.get(resolveRecipeId(tool_name, recipeStore));
  return recipe !== undefined && recipe !== null && recipeActsInBrowser(recipe);
};

/** D-402 slice A4 — whether a chat call ran a recipe that acts in a web page
 *  (`ChatToolCall.browser`): a recipe's own tool (Tier 2), `recipe.run` naming an installed one, or
 *  `recipe.run` carrying one inline. False for scheduling or stopping one (that runs nothing then),
 *  for any other call, on a chat with no lookup wired (a peer's turn through the gateway), and when
 *  the lookup fails: a call's line is no reason to fail its call. */
export const calledRecipeActsInBrowser = (
  actsInBrowser: ((recipe_ref: string) => boolean) | undefined,
  call: { readonly tool_name: string; readonly tier: ToolTier; readonly args: unknown },
): boolean => {
  if (actsInBrowser === undefined) return false;
  const args = call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args)
    ? call.args as Record<string, unknown> : {};
  if (call.tool_name === 'recipe.run' && args.recipe !== null && typeof args.recipe === 'object'
    && !Array.isArray(args.recipe)) {
    return recipeActsInBrowser(args.recipe as { steps?: unknown; prefetch_steps?: unknown });
  }
  const ref = call.tool_name === 'recipe.run'
    ? args.recipe === undefined && typeof args.recipe_id === 'string' ? args.recipe_id : undefined
    : call.tier === 2 ? call.tool_name : undefined;
  if (ref === undefined || ref.trim() === '') return false;
  try { return actsInBrowser(ref); } catch { return false; }
};

/** A recipe's name has no length limit; the one kept with each call that ran it does. */
const CALLED_RECIPE_TITLE_MAX = 120;

/** The chat tools that name a recipe by `recipe_id`: running, scheduling and stopping one, and ending
 *  what it may do without asking (D-402 slice F4). */
const RECIPE_ID_TOOLS: ReadonlySet<string> = new Set(['recipe.run', 'recipe.schedule', 'recipe.stop', 'recipe.stop_allowing']);

/** The installed recipe a chat call names, by its title (`ChatToolCall.recipe_name`): a recipe's
 *  own tool (Tier 2), or `recipe.run`, `recipe.schedule` or `recipe.stop` naming one by
 *  `recipe_id`. On one line, and cut short past `CALLED_RECIPE_TITLE_MAX` characters. Undefined
 *  for any other call, for `recipe.run` with an inline recipe (the model wrote that name), for
 *  `recipe.stop` by `run_id` (an inline recipe's run keeps the id the model gave it, which can be
 *  an installed recipe's, so the call is named only by the recipe it names), when no recipe
 *  answers, and when the lookup fails: a call's line is no reason to fail its call. */
export const calledRecipeTitle = (
  recipeTitle: ((recipe_ref: string) => string | undefined) | undefined,
  call: { readonly tool_name: string; readonly tier: ToolTier; readonly args: unknown },
): string | undefined => {
  if (recipeTitle === undefined) return undefined;
  const args = call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args)
    ? call.args as Record<string, unknown> : {};
  const ref = RECIPE_ID_TOOLS.has(call.tool_name)
    ? args.recipe === undefined && typeof args.recipe_id === 'string' ? args.recipe_id : undefined
    : call.tier === 2 ? call.tool_name : undefined;
  if (ref === undefined || ref.trim() === '') return undefined;
  let title: string | undefined;
  try { title = recipeTitle(ref); } catch { return undefined; }
  const chars = Array.from(title?.replace(/\s+/gu, ' ').trim() ?? '');
  if (chars.length === 0) return undefined;
  return chars.length > CALLED_RECIPE_TITLE_MAX
    ? `${chars.slice(0, CALLED_RECIPE_TITLE_MAX - 1).join('').trimEnd()}…` : chars.join('');
};
