import { isLocalIngredient } from './ingredient.js';

/** Compute the scoped storage key for a vault entry.
 *  All vault keys persist as `vault.{publisher_id}.{key}`.
 *  Used by the persister when reading/writing IndexedDB entries.
 */
export const scopedVaultKey = (publisher_id: string, key: string): string =>
  `vault.${publisher_id}.${key}`;

/** Determine the publisher_id for an ingredient.
 *  - Local ingredient (slug starts with 'local/'): always 'local'.
 *  - Ingredient with `verified === false`: 'local' — marketplace didn't
 *    confirm the claimed author, so the ingredient is treated as
 *    user-local to prevent vault scope impersonation via hand-crafted
 *    manifests.
 *  - Otherwise: uses the author field (e.g., 'recued-core').
 *
 *  The `verified` parameter is optional and defaults to `true` — identity
 *  behavior for callers that don't carry verification state. Three
 *  distinct call-site flavors rely on this default:
 *
 *   1. **Manifest-shape validation** (`packages/ingredients/validate.ts`).
 *      Checks that a manifest's own `{{vault.X.*}}` refs match its
 *      declared author. Validation is about claim self-consistency, not
 *      runtime scope — default `true` is correct.
 *   2. **Bundled manifests** (shipped with the extension). Trusted by
 *      construction; no `verified` field. Default `true` uses the
 *      author as-is.
 *   3. **Remote manifests fetched from marketplace at runtime** (extension
 *      fallback when the ingredient isn't installed locally). The
 *      marketplace DB is authoritative; manifests returned from it
 *      implicitly carry a verified claim. Default `true` is correct.
 *
 *  The ONLY path that must pass `verified: false` is the install-time
 *  `saveIngredient` flow when `lookupIngredient` said the claim didn't
 *  match. That writes `false` onto the stored manifest, which then
 *  flows through the vault resolver at runtime.
 */
export const publisherForIngredient = (slug: string, author: string, verified: boolean = true): string => {
  if (isLocalIngredient(slug)) return 'local';
  if (verified === false) return 'local';
  if (!author || author.trim() === '') return 'local';
  return author;
};

/** Defense-in-depth check: validate that a resolved vault path is in the expected publisher scope.
 *  The persister should never load cross-publisher data into stores.vault, so this is a
 *  belt-and-suspenders check for code paths that operate on raw paths.
 */
export const isValidVaultScope = (refPath: string, expected_publisher: string): boolean => {
  const parts = refPath.split('.');
  return parts.length >= 2 && parts[0] === 'vault' && parts[1] === expected_publisher;
};
