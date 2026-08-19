/** D-247 D8 + D14 — the recipe grant SEED and PURGE, on one seam.
 *
 *  ## Why the store's mutation hook and not the install path
 *
 *  The spec's first draft seeded "at install". That is too narrow by five
 *  producers and one existing corpus. `RecipeStore.save` has SEVEN non-test
 *  callers and only two are a pack install — `recipe.save` (`'inline'`, the owner
 *  authoring in Kitchen), `element-watch-handler`, `mcp-server`'s
 *  `recued_saveRecipe`, `recipe.installBySlug`, `records/install-coordinator`,
 *  `ingredient-authoring/install-composition`. An owner who writes a recipe today
 *  gets it in the catalog; install-only seeding would be a REGRESSION on that
 *  path, not a tightening.
 *
 *  ⇒ One seam. A per-call-site sweep has no completion criterion: the eighth
 *  producer lands next month and nobody adds the seventh hook.
 *
 *  ## ⛔⛔ INSERT-IF-ABSENT, NEVER UPSERT
 *
 *  The grant store reads `granted:false` as an EXPLICIT REVOKE and absence as
 *  "apply the author default". Writing unconditionally would let a pack update, a
 *  pair sync, or a re-save reopen a recipe the owner turned off — and D14's
 *  "an owner's revoke survives every update" depends on exactly this.
 *
 *  ## ⛔ THE DELETE BRANCH IS THE PURGE (D14)
 *
 *  `fireOnMutated` fires on save, update AND delete. That is not an obstacle to
 *  route around, it is what makes this seam cover every way a recipe can LEAVE —
 *  including the two uninstall paths (`pack-uninstall-handler` and the bulk-pack
 *  engine's `markUninstalled`) and whichever is added next. A grant naming a
 *  recipe that is not installed refers to nothing.
 *
 *  ## No marker, and the reason is better than a marker
 *
 *  An earlier draft gated the corpus scan behind a one-time marker, to stop a
 *  boot re-grant undoing D14's purge. It cannot happen: a purge only ever
 *  accompanies the recipe LEAVING the store, so the scan (which walks
 *  `store.ids()`) never sees it again; and a revoke leaves a `granted:false` row,
 *  which insert-if-absent skips. The scan is idempotent by construction.
 *  ⇒ Pinned by test rather than hidden behind a flag — a marker would have made
 *  the property invisible instead of true. */

import { isRecipeChatExposed } from '@recued/recipes';
import type {
  IngredientManifest,
  InstallAccessTier,
  OperationRiskTier,
  RecipeDefinition,
} from '@recued/contracts';
import { recipeGrantEntry } from '@recued/contracts';

import { recipeTopRisk } from './pack-install-preview.js';

import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import { recipeGrantKeyFor } from './recipe-grant-identity.js';
import type { RecipeStore } from './recipe-store.js';
import { isRecipeGrantEntry, OWNER_CONTRACT_ID } from '@recued/contracts';

export interface RecipeGrantSeedDeps {
  store: RecipeStore;
  grants: ContractGrantEntryStore;
  now: () => number;
}

/** Seed one recipe's grant row if it has none, or PURGE it if the recipe is gone.
 *  Safe to call on any mutation; returns what it did, for tests and logging. */
export const syncRecipeGrant = (
  deps: RecipeGrantSeedDeps,
  recipe_id: string,
  /** ⛔⛔ `from_mutation` DISTINGUISHES A CALLER, NOT A STATE, AND WITHOUT IT THE
   *  CORPUS SCAN REWRITES EVERY BUNDLED ROW ON EVERY BOOT.
   *
   *  "No stored row but the recipe still resolves" means two different things
   *  depending on who is asking. From the MUTATION HOOK it means a DB row was
   *  just removed and the bundled body resurfaced — the pack-era grant is stale
   *  and must be overwritten. From the CORPUS SCAN it means an ordinary bundled
   *  recipe that never had a row, and overwriting there clobbers the owner's
   *  revoke on every restart.
   *
   *  Measured before this existed: a real boot re-wrote all 2,264 rows, twice,
   *  in 1.7s then 3.4s — the pass was not idempotent at all, and every owner
   *  revoke of a bundled recipe was reopened on the next start. The unit test
   *  missed it because its fixture used `store.save` (SQLite rows) where
   *  production is overwhelmingly bundled. */
  opts?: { readonly from_mutation?: boolean },
): 'seeded' | 'purged' | 'kept' | 'no_identity' => {
  const recipe = deps.store.get(recipe_id);
  // ⛔⛔ THE STORED ROW, NOT `get`, DECIDES WHETHER THE SUBJECT WENT AWAY.
  // `store.get` falls back to the BUNDLED definition when the SQLite row is
  // gone, so a pack-installed recipe that shadowed a bundled one still resolves
  // after uninstall — and keying the purge on `get` took the keep branch and
  // left the pack-era grant live over a different body. Codex review finding 3.
  const storedRow = typeof deps.store.getStored === 'function'
    ? deps.store.getStored(recipe_id)
    : null;
  const bundledOnly = storedRow === null && recipe !== null;

  if (recipe === null || bundledOnly) {
    // ── D14 — THE SUBJECT IS GONE, SO THE GRANT REFERS TO NOTHING ──────────
    //
    // ⛔⛔ PURGE BY SUBJECT, NOT BY A RECONSTRUCTED ADDRESS. The hook fires
    // AFTER the row is deleted, so `recipeGrantKeyFor` has nothing left to read
    // — no stored `publisher_id`, no `metadata.author` — and returns undefined.
    // Forming the key here would silently purge NOTHING and leave exactly the
    // orphan this branch exists to remove. Found by the test below; the first
    // implementation did precisely that and reported success.
    //
    // ⚠ Scanning also fixes a case the key never could: a recipe re-saved under
    // a DIFFERENT publisher leaves a stale row at the old address, and only a
    // subject-keyed sweep can see it.
    //
    // The suffix match is exact — a `recipe_id` cannot contain `/`, the same
    // property `grantingRecipeEntry` relies on for `allowed_tools`.
    //
    // ⛔⛔⛔ THE SWEEP RUNS ONLY WHEN THE RECIPE IS ACTUALLY GONE. It used to run
    // for the bundled case too, and that CLEARED the row it was about to re-add
    // — so every boot wiped the owner's revoke of a bundled recipe and reseeded
    // the author default. Measured on the real corpus: 2,264 rows rewritten on
    // pass 1 AND pass 2, i.e. not idempotent at all. Two correct-looking pieces
    // (purge-by-subject, then re-seed) composed into a lie.
    const purgeStaleAddresses = (): boolean => {
      const suffix = `/${recipe_id}`;
      let removed = false;
      for (const entry of deps.grants.listForContract(OWNER_CONTRACT_ID)) {
        if (!isRecipeGrantEntry(entry.entry_key) || !entry.entry_key.endsWith(suffix)) continue;
        deps.grants.clear(OWNER_CONTRACT_ID, entry.entry_key);
        removed = true;
      }
      return removed;
    };

    // A recipe that still resolves from the BUNDLE is not gone — it reverted to
    // the shipped body.
    if (bundledOnly && recipe !== null) {
      const key = recipeGrantKeyFor(deps.store, recipe_id, recipe);
      if (key === undefined) return 'no_identity';
      const exposed = isRecipeChatExposed(recipe, { user_authored: false });
      if (opts?.from_mutation !== true) {
        // Corpus scan over an ordinary bundled recipe: insert-if-absent, like
        // every other seed. An overwrite here reopens the owner's revoke on
        // every boot.
        return deps.grants.setIfAbsent(OWNER_CONTRACT_ID, key, exposed, deps.now())
          ? 'seeded'
          : 'kept';
      }
      // A DB row was just deleted and the bundled body resurfaced. Drop any
      // stale address first (the pack may have used a different publisher), then
      // write the shipped body's default — which is what makes an uninstall land
      // where a never-installed server sits.
      purgeStaleAddresses();
      deps.grants.set(OWNER_CONTRACT_ID, key, exposed, deps.now());
      return 'seeded';
    }
    // Genuinely gone: no stored row and nothing resolves. The grant refers to
    // nothing, so every address for this subject goes.
    return purgeStaleAddresses() ? 'purged' : 'no_identity';
  }

  const key = recipeGrantKeyFor(deps.store, recipe_id, recipe);
  // No publisher ⇒ no grant address. Never invent one: a guessed publisher mints
  // a key that answers for a recipe nobody published.
  if (key === undefined) return 'no_identity';

  // ⛔ SWEEP ANY OTHER ADDRESS FOR THE SAME SUBJECT. A save can change a recipe's
  // `publisher_id` (`recipe-store.ts`'s upsert overwrites it), and the mutation
  // hook carries only the id — so the old `recipe.<oldPublisher>/<id>` row would
  // linger. Failure it prevents: R is granted under A, re-saved under B, the B
  // identity is revoked, R is saved under A again, and the stale `true`
  // reattaches with no owner decision. Codex review finding 5.
  for (const entry of deps.grants.listForContract(OWNER_CONTRACT_ID)) {
    if (entry.entry_key === key) continue;
    if (!isRecipeGrantEntry(entry.entry_key)) continue;
    if (!entry.entry_key.endsWith(`/${recipe_id}`)) continue;
    deps.grants.clear(OWNER_CONTRACT_ID, entry.entry_key);
  }

  // INSERT-IF-ABSENT, in ONE statement. A `get`-then-`set` pair is not atomic
  // across PROCESSES — the two boot paths share a WAL database — and the losing
  // interleaving overwrites an explicit revoke with the seed's value.
  if (deps.grants.get(OWNER_CONTRACT_ID, key) !== undefined) return 'kept';

  const stored = typeof deps.store.getStored === 'function'
    ? deps.store.getStored(recipe_id)
    : null;
  // ⛔ `user_authored` decides the DEFAULT and a bare `false` hides every recipe
  // the owner wrote in Kitchen — the exact regression this module exists to
  // prevent. `'inline'` is the authoring source; a bundled recipe has no stored
  // row at all, which is correctly NOT owner-authored rather than a lookup miss.
  const user_authored = stored?.source === 'inline';
  const wrote = deps.grants.setIfAbsent(
    OWNER_CONTRACT_ID,
    key,
    isRecipeChatExposed(recipe, { user_authored }),
    deps.now(),
  );
  return wrote ? 'seeded' : 'kept';
};

/** Walk every recipe the server already holds and seed what has no row.
 *
 *  ⚠ This is NOT the boot reconcile and must never become it. `reconcileOwnerGrants`
 *  materialises from COMPILED registries because "new ops arrive ONLY via a server
 *  source-code update … deterministic, never a runtime event". Recipes arrive at
 *  runtime, so they are seeded on the mutation seam; this covers only the corpus
 *  that predates the seam existing. Idempotent — a second run writes nothing. */
export const seedExistingRecipeCorpus = (deps: RecipeGrantSeedDeps): number => {
  let seeded = 0;
  for (const recipe_id of deps.store.ids()) {
    if (syncRecipeGrant(deps, recipe_id) === 'seeded') seeded += 1;
  }
  return seeded;
};

/** Wire the seam + run the corpus pass. ⛔ Registered UNCONDITIONALLY at boot: a
 *  conditional registration is how the trigger reconciler's hook ended up
 *  depending on `eventTriggersBundle || watchBundle`, and a grant seed that runs
 *  only on some installs is a catalog that is empty on the others. */
export const installRecipeGrantSeed = (deps: RecipeGrantSeedDeps): number => {
  deps.store.addOnMutated((recipe_id) => {
    syncRecipeGrant(deps, recipe_id, { from_mutation: true });
  });
  return seedExistingRecipeCorpus(deps);
};

// ════════════════════════════════════════════════════════════════
// D-247 D15.1 — the install's chosen ACCESS CEILING
// ════════════════════════════════════════════════════════════════

/** Does `access` cover a recipe whose closure tops out at `risk`?
 *
 *  `read` covers read; `write` covers read + write; `all` covers everything.
 *  ⛔ `null` (underivable closure) is NOT covered by anything below `all`: we
 *  cannot say what it reaches, and "unknown" must not resolve to "safe". The
 *  owner can still grant it afterwards from Contracts, where the decision is
 *  taken with the recipe in front of them. */
export const accessCoversRisk = (
  access: InstallAccessTier,
  risk: OperationRiskTier | null,
): boolean => {
  if (access === 'all') return true;
  if (risk === null) return false;
  if (access === 'write') return risk === 'read' || risk === 'write';
  return risk === 'read';
};

/** D-247 D15.1 — write each pack recipe's grant row with the owner's chosen
 *  ceiling applied, BEFORE the recipes are saved.
 *
 *  ⛔⛔ THE ORDERING IS THE MECHANISM, AND IT IS WHY THIS EXISTS AT ALL. The
 *  ordinary seed rides `RecipeStore`'s mutation hook, which knows only a
 *  `recipe_id` — the install dialog's answer is nowhere in scope there, so a pack
 *  recipe would be seeded on `chat_exposed` ALONE and the owner's "Read only"
 *  would mean nothing. Writing here, first, and letting the hook's
 *  INSERT-IF-ABSENT no-op afterwards, is what carries the answer across without
 *  threading ambient install state through the store.
 *
 *  ⚠ The hook is still the general seam and still covers every other producer.
 *  This is the one path that has an extra fact to contribute.
 *
 *  ⛔ Insert-if-absent HERE TOO. A reinstall over a recipe the owner revoked must
 *  not reopen it — D14's "an owner's revoke survives every update" does not stop
 *  applying because the install had an opinion. */
export const seedPackRecipeGrants = (
  deps: RecipeGrantSeedDeps & {
    readonly getManifest?: (slug: string) => IngredientManifest | undefined;
  },
  recipes: ReadonlyArray<{
    readonly recipe_id: string;
    readonly publisher_id: string;
    readonly recipe: RecipeDefinition;
  }>,
  access: InstallAccessTier,
): number => {
  let seeded = 0;
  const getManifest = deps.getManifest ?? (() => undefined);
  for (const entry of recipes) {
    // Pack content, so `user_authored` is false — the same call the hook makes.
    const exposed = isRecipeChatExposed(entry.recipe, { user_authored: false });
    const withinCeiling = accessCoversRisk(access, recipeTopRisk(entry.recipe, getManifest));
    const wrote = deps.grants.setIfAbsent(
      OWNER_CONTRACT_ID,
      recipeGrantEntry(entry.publisher_id, entry.recipe_id),
      exposed && withinCeiling,
      deps.now(),
    );
    if (wrote) seeded += 1;
  }
  return seeded;
};
