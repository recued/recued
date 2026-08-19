/** D-247 — the ONE place a `recipe.*` grant key is formed.
 *
 *  ⛔⛔ TWO CALLERS FORMING THIS KEY DIFFERENTLY IS A GRANT THAT WRITES TO ONE
 *  ADDRESS AND READS FROM ANOTHER, and it fails SILENTLY: the seed writes
 *  `recipe.recued-core/x`, the predicate looks up `recipe.kitchen/x`, finds
 *  nothing, applies D7's deny-by-default, and the recipe is invisible with every
 *  test green. The seed (D8) and the coverage predicate (D5) therefore share this
 *  module rather than each calling `recipeGrantEntry` with their own idea of the
 *  publisher.
 *
 *  ## Where the publisher comes from, in order
 *
 *  1. The STORED row's `publisher_id` — authoritative for anything installed or
 *     saved, and the value the marketplace / pack install wrote.
 *  2. `metadata.author` — a BUNDLED recipe has no stored row at all
 *     (`getStored` is `getFromDb(id) ?? null`), so this is the only identity it
 *     has. Not a fallback for a missing row: it IS the bundled path.
 *  3. Absent ⇒ `undefined`, and the caller must treat that as "no grant key",
 *     never as a default publisher. Guessing one would mint a key that answers
 *     for a recipe nobody published. */

import type { RecipeDefinition } from '@recued/contracts';
import { recipeGrantEntry } from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';

/** The subset of `RecipeStore` this needs. A `Pick` so a caller cannot pass a
 *  half-wired store and have it silently resolve every publisher to undefined. */
export type RecipePublisherSource = Pick<RecipeStore, 'getStored' | 'get'>;

/** Resolve the publisher that owns `recipe_id`, or `undefined` when the recipe is
 *  unknown to this server. `recipe` short-circuits the store read when the caller
 *  already holds the definition (the gate does; the seed does not). */
export const resolveRecipePublisher = (
  store: RecipePublisherSource,
  recipe_id: string,
  recipe?: RecipeDefinition | null,
): string | undefined => {
  // ⚠ `typeof` guarded, matching `execute-handler.ts:1427`: dbless / partial test
  // doubles of `RecipeStore` omit `getStored`, and an unguarded call there would
  // throw inside a GATE — turning a missing test fixture into a run failure.
  const stored = typeof store.getStored === 'function' ? store.getStored(recipe_id) : null;
  if (stored?.publisher_id) return stored.publisher_id;
  const def = recipe ?? store.get(recipe_id);
  const author = def?.metadata?.author;
  return typeof author === 'string' && author.length > 0 ? author : undefined;
};

/** The `recipe.<publisher>/<recipe_id>` grant key, or `undefined` when no
 *  publisher resolves. ⛔ `undefined` means "this recipe has no grant address",
 *  which every caller must treat as NOT GRANTED — never as granted-by-absence. */
export const recipeGrantKeyFor = (
  store: RecipePublisherSource,
  recipe_id: string,
  recipe?: RecipeDefinition | null,
): string | undefined => {
  const publisher = resolveRecipePublisher(store, recipe_id, recipe);
  return publisher === undefined ? undefined : recipeGrantEntry(publisher, recipe_id);
};
