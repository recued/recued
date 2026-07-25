/** D-112 — Engine-locked ingredient input keys.
 *
 *  A fixed, engine-wide set of ingredient-input keys that recipes
 *  MUST NOT override. Closes a pre-existing security gap where the
 *  dispatch merge let any recipe rewrite the manifest's `url`,
 *  `method`, `header.authorization`, `header.cookie`, or
 *  `header.host` — which would allow URL hijacking + auth swap by
 *  a malicious (or buggy) recipe.
 *
 *  No per-ingredient opt-out, no recipe-side escape hatch — the
 *  locks are the engine's way of saying "the ingredient's network
 *  boundary is fixed, not suggested." Ingredients needing a
 *  different domain / protocol-level auth ship as separate
 *  ingredients.
 *
 *  Enforcement is two-layer:
 *    1. parseRecipe (install time, primary gate) — emits the
 *       `LOCKED_INPUT_KEY` validation error.
 *    2. Dispatch merge (runtime, belt-and-suspenders) — silently
 *       filters these keys from recipe step input before merge so
 *       bundled / hand-assembled recipes that bypass parseRecipe
 *       still can't reach the HTTP executor with a hijacked URL.
 *
 *  Lives in `@recued/contracts` because every downstream package
 *  (engine, recipes, ingredients, kitchen editor) needs the same
 *  canonical list. Contracts is already the source of truth for
 *  `ERR` / `OPS` / `NS` — the lock constant fits the same pattern.
 */

export const ENGINE_LOCKED_INPUT_KEYS = [
  'method',
  'url',
  'header.host',
  'header.authorization',
  'header.cookie',
  // D-116 — AI-prompt hardening. The engine inserts a long random
  // sentinel between instruction_block and data_block so embedded
  // user data can't reconstruct the trust boundary. Recipes
  // attempting to set this key fail with LOCKED_INPUT_KEY.
  'llm.delimiter',
] as const satisfies readonly string[];

export type LockedInputKey = (typeof ENGINE_LOCKED_INPUT_KEYS)[number];

const LOCKED_SET: ReadonlySet<string> = new Set(ENGINE_LOCKED_INPUT_KEYS);

/** Case-sensitive check. Keys are already normalised to lowercase
 *  in manifest input maps (HTTP convention) so a raw case-sensitive
 *  match is what every caller wants. Callers that get keys from
 *  untrusted sources should lowercase before calling. */
export const isLockedInputKey = (key: string): key is LockedInputKey =>
  LOCKED_SET.has(key);

/** Wildcard markers in ingredient manifests (D-112 §Contract).
 *
 *  A manifest key of form `prefix.*` with `null` value admits
 *  `prefix.X` children from recipes without enumerating every
 *  field. Single-level only — `prefix.*` does NOT admit
 *  `prefix.X.Y`; deep wildcards are explicit non-goal in v1.
 *
 *  Locked keys take precedence over wildcards: a manifest declaring
 *  `header.*: null` still cannot admit `header.authorization` from
 *  recipes — the engine lock wins. Enforcement lives in
 *  `validateIngredientRefs`; this helper is the shared shape check
 *  that parseRecipe + Kitchen both call. */
export const WILDCARD_SUFFIX = '.*';

export const isWildcardMarker = (
  key: string,
  value: unknown,
): boolean => value === null && key.endsWith(WILDCARD_SUFFIX);

/** Given a wildcard declaration like `body.properties.*`, return
 *  the prefix `body.properties`. Callers combine the prefix with a
 *  recipe key to decide whether it matches. */
export const wildcardPrefix = (declaration: string): string =>
  declaration.slice(0, -WILDCARD_SUFFIX.length);

/** Match a recipe key against a set of wildcard prefixes. Returns
 *  true when the recipe key has form `prefix.X` with X a non-empty
 *  single identifier (matches `[A-Za-z0-9_-]+`, no nested `.`).
 *
 *  Locked keys are NOT filtered here — that's the caller's job. A
 *  wildcard can never admit a locked key even when the recipe key
 *  structurally matches, because the caller runs the lock check
 *  first. */
export const matchesWildcard = (
  key: string,
  wildcardPrefixes: ReadonlySet<string>,
): boolean => {
  for (const prefix of wildcardPrefixes) {
    if (!key.startsWith(prefix + '.')) continue;
    const tail = key.slice(prefix.length + 1);
    if (tail.length === 0) continue;
    if (tail.includes('.')) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(tail)) continue;
    return true;
  }
  return false;
};
