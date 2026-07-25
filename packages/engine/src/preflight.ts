/** Pre-run preflight check.
 *
 *  Pure logic, no I/O. Checks:
 *  1. Recipe variables: required ones without defaults
 *  2. Ingredient vault_hints: required credentials not in the vault
 *
 *  Callers provide a manifest getter and a vault checker — the preflight
 *  module never touches storage directly.
 */

import type { RecipeDefinition, ValueHint, IngredientKind, IngredientManifest, RuntimeRole } from '@recued/contracts';
import { publisherForIngredient, ROLE } from '@recued/contracts';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type MissingKind = 'variable' | 'vault';

export interface MissingInput {
  kind: MissingKind;
  key: string;
  label: string;
  type: string;
  help?: string;
  link?: string;
  options?: string[];
  /** For vault: publisher scope (e.g., 'recued-core'). */
  publisher?: string;
  /** Which ingredient declared this vault requirement. */
  from_ingredient?: string;
  /** Dot path for setting in vault (e.g., 'recued-core.hubspot_token'). */
  vault_path?: string;
}

/** Synchronous manifest lookup. The server's ManifestRegistry
 *  provides this. */
export type ManifestGetter = (slug: string) => IngredientManifest | null;

/** Check whether a vault value exists. Callers provide their own
 *  implementation — the server walks a nested vault object. */
export type VaultChecker = (publisher: string, key: string) => boolean;

// ────────────────────────────────────────────────────────────────
// Variable checking
// ────────────────────────────────────────────────────────────────

/** Find recipe variables that are required but not provided in config.
 *
 *  Variable shapes:
 *    null                       → required, no default
 *    42 / "text" / true         → has default (not missing)
 *    ["a", "b"]                 → enum shorthand, first is default
 *    { label, type, default? }  → ValueHint; missing when no default and not optional
 */
export const findMissingVariables = (
  variables: Record<string, unknown>,
  config: Record<string, unknown>,
): MissingInput[] => {
  const missing: MissingInput[] = [];
  for (const [key, spec] of Object.entries(variables)) {
    if (hasOwn(config, key)) continue;

    if (spec === null) {
      missing.push({ kind: 'variable', key, label: key, type: 'text' });
      continue;
    }

    if (spec != null && typeof spec === 'object' && !Array.isArray(spec)) {
      const hint = spec as ValueHint;
      if (hint.optional) continue;
      if (hint.default !== undefined) continue;
      missing.push({
        kind: 'variable',
        key,
        label: hint.label ?? key,
        type: hint.type ?? 'text',
        help: hint.help,
        link: hint.link,
        options: hint.options,
      });
    }
  }
  return missing;
};

// ────────────────────────────────────────────────────────────────
// Vault checking
// ────────────────────────────────────────────────────────────────

/** Collect unique ingredient slugs from a recipe (prefetch + sequential). */
export const collectIngredientSlugs = (recipe: RecipeDefinition): string[] => {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const visit = (step: unknown): void => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return;
    const s = step as Record<string, unknown>;
    if (!hasOwn(s, 'ingredient')) return;
    const ingredient = s.ingredient;
    if (typeof ingredient === 'string' && ingredient && !seen.has(ingredient)) {
      seen.add(ingredient);
      slugs.push(ingredient);
    }
  };
  for (const step of recipe.prefetch_steps ?? []) visit(step);
  for (const step of recipe.steps ?? []) visit(step);
  return slugs;
};

/** Find vault entries that ingredients need but the vault doesn't have. */
export const findMissingVaultEntries = (
  recipe: RecipeDefinition,
  getManifest: ManifestGetter,
  hasVaultEntry: VaultChecker,
): MissingInput[] => {
  const missing: MissingInput[] = [];
  const seen = new Set<string>();
  const slugs = collectIngredientSlugs(recipe);

  for (const slug of slugs) {
    const manifest = getManifest(slug);
    if (!manifest?.vault_hints) continue;

    // Honor `verified` flag on the installed manifest — unverified
    // ingredients (author claim didn't match marketplace) get 'local'
    // scope regardless of what the author field claims.
    const publisher = publisherForIngredient(slug, manifest.author, manifest.verified);

    for (const [key, rawHint] of Object.entries(manifest.vault_hints)) {
      const hint = rawHint as ValueHint;
      const dedupKey = `${publisher}::${key}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const recipeRecord = recipe as unknown as Record<string, unknown>;
      const vaultHints = hasOwn(recipeRecord, 'vault_hints')
        && recipeRecord.vault_hints
        && typeof recipeRecord.vault_hints === 'object'
        && !Array.isArray(recipeRecord.vault_hints)
        ? recipeRecord.vault_hints as Record<string, unknown>
        : null;
      const recipeOverride = vaultHints && hasOwn(vaultHints, key)
        ? vaultHints[key] as ValueHint
        : undefined;
      const effectiveHint = recipeOverride ?? hint;

      if (effectiveHint.optional) continue;
      if (effectiveHint.default !== undefined) continue;
      if (hasVaultEntry(publisher, key)) continue;

      missing.push({
        kind: 'vault',
        key,
        label: effectiveHint.label ?? key,
        type: effectiveHint.type ?? 'secret',
        help: effectiveHint.help,
        link: effectiveHint.link,
        options: effectiveHint.options,
        publisher,
        from_ingredient: slug,
        vault_path: `${publisher}.${key}`,
      });
    }
  }

  return missing;
};

// ────────────────────────────────────────────────────────────────
// Role-based adapter restrictions
// ────────────────────────────────────────────────────────────────

/** Ingredient kinds that require a browser and CANNOT be delegated.
 *  Chat is excluded — unlike DOM, a web-chat ingredient can be
 *  delegated, so it is not hard-blocked here.
 *  D-126 P2.2 — keys on `IngredientKind` directly, no inference. */
const BROWSER_ONLY_KINDS = new Set<IngredientKind>(['dom']);

/** Check if a recipe has ingredients incompatible with the current role.
 *  On the server, DOM ingredients cannot execute (no browser).
 *  Returns the list of incompatible ingredient slugs + their adapter kind. */
export const findRoleRestrictions = (
  recipe: RecipeDefinition,
  getManifest: ManifestGetter,
  role?: RuntimeRole,
): Array<{ slug: string; adapter: string }> => {
  const effectiveRole = role ?? (ROLE.isServer ? 'server' : ROLE.isExtension ? 'extension' : null);
  if (effectiveRole !== 'server') return [];

  const restricted: Array<{ slug: string; adapter: string }> = [];
  for (const slug of collectIngredientSlugs(recipe)) {
    const manifest = getManifest(slug);
    if (!manifest) continue;
    if (BROWSER_ONLY_KINDS.has(manifest.kind)) {
      restricted.push({ slug, adapter: manifest.kind });
    }
  }
  return restricted;
};

// ────────────────────────────────────────────────────────────────
// Combined
// ────────────────────────────────────────────────────────────────

/** Run the full preflight check. Returns all missing inputs. */
export const preflight = (
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
  getManifest: ManifestGetter,
  hasVaultEntry: VaultChecker,
): MissingInput[] => [
  ...findMissingVariables(recipe.variables ?? {}, config),
  ...findMissingVaultEntries(recipe, getManifest, hasVaultEntry),
];
