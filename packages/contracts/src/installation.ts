import type { ProcessRetireReason } from './reactive.js';

/** Status of an installed recipe. */
export type RecipeStatus = 'enabled' | 'disabled_by_user' | 'disabled_broken';

/** Local install record for a recipe. */
export interface InstalledRecipeRecord {
  recipe_id: string;
  version: number;
  installed_at: string;
  status: RecipeStatus;
  /** Recipe's pinned ingredient versions at install/update time. */
  ingredient_pins: Array<{ ingredient_id: string; version: number }>;
  /** Set when status is 'disabled_broken'. */
  broken_reason?: {
    blocking_ingredient: string;
    blocking_min_version: number;
    pinned_version: number;
    detected_at: string;
  };
  /** D-115 — UUID grouping every audit row of one reactive install.
   *  Issued the first time an `auto_run` recipe enters the roster;
   *  retired (a new id minted) on stop / pause / uninstall /
   *  version_bump / circuit_broken. Null/undefined for non-reactive
   *  installs — manual + cron runs leave the field unset and the
   *  audit rollup treats them as one-offs. */
  process_id?: string;
  /** D-115 — reason the previous `process_id` was retired. Set
   *  whenever the runtime mints a fresh id; cleared on the next
   *  retire. Useful for surfacing "Pause →  Stop" sequences in the
   *  rollup UI without mining the audit log. */
  process_retired_reason?: ProcessRetireReason;
}

/** Local install record for an ingredient. One copy per ingredient — always at marketplace's current version. */
export interface InstalledIngredientRecord {
  slug: string;
  /** Where this ingredient came from. Local-prefixed slugs are always 'local' or 'imported'. */
  source: 'marketplace' | 'local' | 'imported';
  current_version: number;
  min_version: number;
  installed_at: string;
  last_refreshed_at: string;
  /** Marketplace verification state for the ingredient's author claim.
   *  `true`  — marketplace confirmed this (slug, author) pair at install
   *            time. Vault scope uses the claimed author.
   *  `false` — marketplace said the claim doesn't match OR marketplace
   *            was unreachable. Vault scope is downgraded to 'local'
   *            (see `publisherForIngredient`). Prevents an attacker
   *            from impersonating a known publisher via hand-crafted
   *            ingredient JSON to reach that publisher's vault.
   *  `undefined` — pre-verification legacy records. Runtime treats as
   *                unverified for safety.
   *  Set once at install; never mutated at runtime. */
  verified?: boolean;
  /** When `verified: false`, preserves the ingredient manifest's raw
   *  claimed author so the UI can show "Installed as local (claimed X)"
   *  without the user losing track of what the ingredient said it was.
   *  Null/undefined when verification succeeded or wasn't applicable. */
  original_claim?: string | null;
}

/** Health status of an installed recipe vs current local ingredient versions. */
export type RecipeHealthStatus = 'current' | 'outdated' | 'broken';

export interface RecipeHealthCheck {
  recipe_id: string;
  status: RecipeHealthStatus;
  /** Human-readable reason when status is 'broken' or 'outdated'. */
  reason?: string;
  /** Ingredients causing 'broken' status (pin < min_version). */
  blocking_ingredients: string[];
}

/** Pre-update analysis: which other recipes will break if this update is applied. */
export interface UpdateImpact {
  recipe_id: string;
  to_version: number;
  /** Recipes that will be broken by this update. Empty array = safe to update. */
  collateral_breakage: Array<{
    recipe_id: string;
    blocking_ingredient: string;
    current_pin: number;
    required_min: number;
  }>;
}
