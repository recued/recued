/** D-145 PA10 — Foundation pack pre-install boot wire.
 *
 *  First-party packs declared with `pre_install: true` in their bundled
 *  manifest auto-install on every server boot. The hook is idempotent:
 *  a pack whose recipes are already represented in the persistent
 *  recipe store (i.e. previous boot already installed it) skips the
 *  transaction without writing audit / cascading invalidation. New
 *  recipes added to an existing foundation pack land on the next boot
 *  cycle (the engine's bulk-install transaction treats unfamiliar slugs
 *  as fresh installs while leaving already-installed siblings alone).
 *
 *  Why server-boot rather than first-init only:
 *
 *  - **Robust to data loss.** A user who wipes their SQLite db or moves
 *    to a fresh server still gets the foundation packs without manual
 *    re-install. The marketplace UI install path stays available for
 *    user-driven packs; this is purely substrate-shipped Day-1 value.
 *  - **Robust to pack updates.** When a future build bumps a foundation
 *    pack's recipes, the boot wire re-runs and the install transaction
 *    upgrades affected recipes in place (`recipeStore.save()` is upsert-
 *    shaped; `installBulkPack`'s upgrade path recomputes hashes + emits
 *    the cascade hook). No end-user click required for first-party
 *    pack maintenance.
 *  - **Idempotent on no-op.** When every recipe in the pack matches its
 *    pinned version + hash, the install transaction lands the
 *    `markInstalled` upsert which RecipeStore turns into a no-op
 *    (recipe_hash unchanged → no upgrade hook, no cascade). The boot
 *    cost is N SELECTs against the recipes table.
 *
 *  The hook scans bundled `community/packs/*.json` files (read at boot,
 *  shipped on disk alongside the recipe bundle) and resolves every
 *  recipe slug against the `RecipeStore`'s bundled cache (recipes that
 *  ship in `community/recipes/*.json` are immediately resolvable;
 *  marketplace-only recipes would not resolve and the pack install
 *  would mark the pack `not_ready` — first-party foundation packs ship
 *  every recipe alongside the pack manifest by convention).
 *
 *  Spec: D-145 § Phase PA10 + § A.6.3.
 *
 *  Substrate layering:
 *  - Read manifests via `parseBulkPackManifest` (contracts validator).
 *  - Resolve recipes via `RecipeStore.get()` (no marketplace fetch).
 *  - Run install via `installBulkPackOnServer` (handler factory).
 *
 *  No new SQLite tables; no new rpc surface; no new event class. The
 *  hook is server-internal — never enters MCP, no cross-cloud sync
 *  (D-097 / D-168), never appears in user-facing chat.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  parseBulkPackManifest,
  type BulkPackManifest,
  type IngredientManifest,
  type PackContentRef,
} from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import type {
  BulkPackInstallInput,
  BulkPackInstallRecipe,
  BulkPackInstallResult,
} from '@recued/marketplace';

import {
  provisionPackCompositionForBulkInstall,
  recipesHaveCanonicalOpStep,
  resolvePackOpStepRecipes,
  type ProvisionAuthoredDeps,
} from './ingredient-authoring/install-composition.js';
import { BUNDLED_FOUNDATION_PACKS } from './bundled-foundation.generated.js';
import { installBulkPackOnServer } from './install-bulk-pack-handler.js';
import type { McpBodyVisibilityStore } from './storage/mcp-body-visibility-store.js';
import { createManifestRegistry, type ManifestRegistry } from './manifest-loader.js';
import type { RecipeStore } from './recipe-store.js';

/** Default community/packs directory resolution. Mirrors
 *  `recipe-store.ts:findCommunityDir`'s convention so test harnesses
 *  passing a custom community dir get the same shape regardless of
 *  which substrate's loader runs first. */
const findCommunityPackDir = (): string => {
  const projectRoot = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
  return join(projectRoot, 'community', 'packs');
};

/** Recursively collect every `*.json` under `dir` — matches the
 *  `packs.install` handler's `walkJsonFiles` so the boot pre-install scan and
 *  the rpc install resolver agree on the bundled root. First-party packs nest
 *  one level under a publisher dir (`community/packs/recued-core/*.json`, the
 *  reception core-packs); a non-recursive scan would silently miss them, which
 *  is exactly why a pre_install composition pack must be reachable here. */
const walkJsonFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
};

/** Outcome of one pack's pre-install attempt. Surfaces back through the
 *  boot wire so test harnesses + future boot-debug surfaces can render
 *  the per-pack status without re-parsing the manifest directory.
 *
 *  - `'installed'` — install transaction ran cleanly + persisted rows.
 *  - `'no_op'` — every recipe in the pack already matches the bundled
 *    version + hash; the install transaction is skipped to avoid the
 *    per-recipe `markInstalled` upsert pass on every boot. Idempotent
 *    by construction (no rows changed, no audit emission).
 *  - `'skipped_*'` — pack rejected at parse / resolution time; surfaces
 *    the reason for boot-log + future debug rendering.
 *  - `'failed'` — install transaction returned `ok: false` (bubbles
 *    failure code from the engine).
 *  - `'errored'` — Codex P2 fold — uncaught exception during
 *    resolution / install. Per-pack try/catch emits this so a
 *    pathological pack manifest doesn't reject the whole boot scan;
 *    the next pack still gets a chance to install. */
export type FoundationPackOutcome =
  | { slug: string; status: 'installed'; result: BulkPackInstallResult }
  | { slug: string; status: 'no_op' }
  // D-173 D1 — a composition-only pack (recipes: []; the reception core-packs)
  // whose by-value `composition` content was provisioned at boot (catalog +
  // compiled review-then-approve recipe + grants). Counted as installed.
  | { slug: string; status: 'composition_installed' }
  | { slug: string; status: 'skipped_third_party'; reason: string }
  | { slug: string; status: 'skipped_invalid_manifest'; reason: string }
  | { slug: string; status: 'skipped_missing_recipes'; missing: string[] }
  | { slug: string; status: 'failed'; failure: BulkPackInstallResult['failure'] }
  | { slug: string; status: 'errored'; error: string };

/** Composite result returned by `preInstallFoundationPacks`. Test
 *  harnesses inspect `outcomes[]` to assert per-pack behavior; the
 *  boot wire just needs to know whether any failure happened so the
 *  log line carries a non-fatal warning.
 *
 *  Counters split four ways post-fold:
 *  - `installedCount` — install transaction ran cleanly.
 *  - `noOpCount` — every recipe in the pack already matched (fast-
 *    path skip). Counted separately from `skipped*` because a
 *    re-boot on a stable pack should land here, not in `skipped`.
 *  - `skippedCount` — pack rejected at parse / resolution time
 *    (invalid manifest / missing recipes / third-party).
 *  - `failedCount` — install transaction returned `ok: false` OR
 *    threw an uncaught exception. Both paths are user-actionable
 *    failures the boot logger surfaces. */
export interface FoundationPackPreInstallResult {
  outcomes: FoundationPackOutcome[];
  installedCount: number;
  noOpCount: number;
  skippedCount: number;
  failedCount: number;
}

/** Inputs to `preInstallFoundationPacks`. */
export interface PreInstallFoundationPacksInput {
  recipeStore: RecipeStore;
  /** D-139 P6.B — optional per-pair MCP body-content visibility grant
   *  store. When present, foundation packs that ship
   *  `mcp_body_visibility_grants[]` persist their closed-list grant keys
   *  on boot; when absent the grants are skipped (manifest field stays
   *  contract-only). */
  mcpBodyVisibilityStore?: McpBodyVisibilityStore;
  /** Override the default community/packs directory. Tests pass a
   *  scratch dir; production callers leave undefined to use the
   *  bundled location. */
  packDir?: string;
  /** Connection-agnostic op dispatch — the live manifest registry's `get`,
   *  used to resolve a foundation CRM pack's BUNDLED vendor catalog (the
   *  catalog a by-ref `{type:'ingredient'}` content names) when rewriting its
   *  op-step recipes to concrete form before persist. The boot wire passes
   *  `manifests.get` (the live registry — also resolves locally-installed
   *  catalogs). When omitted, an op-step pack falls back to a lazily-built
   *  BUNDLED-ingredient registry (what's available at boot anyway), so the
   *  function is self-sufficient for tests / older harnesses; only the rare
   *  pack that references a non-bundled catalog needs the explicit live
   *  registry. A recipe-only foundation pack never consults either (fast
   *  path — the lazy registry is never built). */
  getCatalogManifest?: (slug: string) => IngredientManifest | null;
  /** D-173 D1 — composition-provisioning deps for a pre_install pack that
   *  carries its integration as a by-value `composition` content (the reception
   *  core-packs: `recipes: []` at the manifest top level, the review-then-approve
   *  recipe COMPILED from the composition at install per D-170 N.18). Mirrors the
   *  exact handles the `packs.install` rpc threads onto its composition branch
   *  (`compose-listeners.ts` → `provisionPackCompositionForBulkInstall`):
   *  `localManifestStore` (catalog body home, the SAME instance the inbox's
   *  arg_schema resolver + the gateway resolve through), `contractStore` (the
   *  `installed_pack` inventory + pack grants), `registry` (the live manifest
   *  registry the executor resolves operations through — N.16). `recipeStore`
   *  (this input's) is reused as the compiled-recipe store; `now` is the boot
   *  clock. Optional `recipeTrustStore` (pure-workflow recipes auto-trusted) +
   *  `reconcileConnectionProfile` (the composition's bound connection profile —
   *  at boot it's unwired and the profile seeds via the boot's own
   *  catalog-operation-profile pass instead). Absent (dbless / pre-store boot) →
   *  a composition pack's catalog is left UNPROVISIONED (honest deferral,
   *  mirroring the rpc's `canProvisionComposition` false branch). */
  compositionProvision?: Omit<ProvisionAuthoredDeps, 'now' | 'compiledRecipeStore'>;
  /** Fixed clock for tests. */
  now?: number;
}

/** Scan + filter bundled pack manifests for `pre_install: true`
 *  candidates. Malformed manifests are reported as `skipped_invalid_manifest`
 *  outcomes so silent disk corruption surfaces in the boot logs rather
 *  than silently dropping a pack. */
const loadFoundationPackManifests = (
  packDir: string,
  includeEmbedded: boolean,
): { ok: BulkPackManifest[]; outcomes: FoundationPackOutcome[] } => {
  const ok: BulkPackManifest[] = [];
  const outcomes: FoundationPackOutcome[] = [];
  // FS scan (dev/git-clone). Guarded — NOT an early return: a DEPLOYED server
  // ships no `community/packs` dir, and the embedded-manifest union below must
  // still run so the foundation packs pre-install there.
  // Recursive walk — first-party packs nest under a publisher dir
  // (`community/packs/recued-core/*.json`); the reception core-packs live there.
  for (const file of existsSync(packDir) ? walkJsonFiles(packDir) : []) {
    const fileSlug = basename(file).replace(/\.json$/, '');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch (e) {
      outcomes.push({
        slug: fileSlug,
        status: 'skipped_invalid_manifest',
        reason: `read error: ${(e as Error).message ?? String(e)}`,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      outcomes.push({
        slug: fileSlug,
        status: 'skipped_invalid_manifest',
        reason: `JSON parse error: ${(e as Error).message ?? String(e)}`,
      });
      continue;
    }
    const result = parseBulkPackManifest(parsed);
    if (!result.ok) {
      outcomes.push({
        slug: fileSlug,
        status: 'skipped_invalid_manifest',
        reason: result.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `${i.code}@${i.path}: ${i.message}`)
          .join('; '),
      });
      continue;
    }
    if (result.manifest.pre_install !== true) continue;
    if (result.manifest.publisher !== 'recued-core') {
      outcomes.push({
        slug: result.manifest.slug,
        status: 'skipped_third_party',
        reason: `pre_install: true is reserved for 'recued-core'; manifest declared ${JSON.stringify(result.manifest.publisher)}`,
      });
      continue;
    }
    ok.push(result.manifest);
  }
  // Union the embedded foundation manifests so a DEPLOYED server (which ships no
  // `community/packs` dir — the FS scan above finds nothing) still pre-installs
  // them. A git-clone dev build finds them on the FS first → those win (dedup by
  // slug); the embedded set fills only what the FS didn't provide. Clone so a
  // downstream in-place manifest rewrite (op-step resolution) can't corrupt the
  // shared module constant across boots.
  //
  // ONLY on the DEFAULT path — a test pinning an explicit `packDir` supplies its
  // own fixture and must not get the embedded foundation packs injected.
  if (includeEmbedded) {
    const seen = new Set(ok.map((m) => m.slug));
    for (const manifest of BUNDLED_FOUNDATION_PACKS) {
      if (!seen.has(manifest.slug)) ok.push(structuredClone(manifest) as BulkPackManifest);
    }
  }
  return { ok, outcomes };
};

/** Codex P2 fold — pre-install no-op pre-check.
 *
 *  Compare each pack recipe's stored row's `recipe_hash` against the
 *  bundled recipe's hash; when every entry already matches, return
 *  `no_op` to skip the install transaction's per-recipe `markInstalled`
 *  upsert pass entirely. Saves N upsert SQL statements + audit emission
 *  on every server boot once the pack has been installed once. The
 *  install transaction is still strictly idempotent (RecipeStore upserts
 *  short-circuit on hash match), but skipping the call avoids touching
 *  `installed_at` timestamps + future audit columns even on no-change
 *  boots.
 *
 *  Returns `false` on first run (no rows yet), on any version drift
 *  (one bundled recipe hash differs from the stored row), and on
 *  partial install state (some rows present + some missing). The
 *  caller falls through to the install transaction for any of those
 *  cases — the install is the source of truth, this is just a fast
 *  path. */
const allRecipesAlreadyInstalled = (
  resolved: BulkPackInstallRecipe[],
  recipeStore: RecipeStore,
): boolean => {
  for (const entry of resolved) {
    if (entry.recipe == null) return false;
    const stored = recipeStore.getStored(entry.recipe.recipe_id);
    if (stored == null) return false;
    if (stored.recipe_hash !== entry.recipe.recipe_hash) return false;
  }
  return true;
};

/** Resolve each recipe slug in a manifest against the recipe store's
 *  bundled cache. Foundation packs ship every recipe alongside the
 *  manifest in `community/recipes/`, so resolution is local; if a slug
 *  can't be found we surface the missing list rather than synthesizing
 *  a fake recipe (caller routes to `skipped_missing_recipes`).
 *
 *  Reads via `getBundled()` (NOT `get()`) so a previously-installed
 *  SQLite row doesn't shadow drift in the bundled disk file — the
 *  foundation-pack contract is "bundled disk file is the source of
 *  truth for first-party packs"; on every boot we re-install from disk
 *  if the disk content differs from the persisted row. */
const resolveBundledRecipes = (
  manifest: BulkPackManifest,
  recipeStore: RecipeStore,
): { resolved: BulkPackInstallRecipe[]; missing: string[] } => {
  const resolved: BulkPackInstallRecipe[] = [];
  const missing: string[] = [];
  for (const ref of manifest.recipes) {
    const recipe = recipeStore.getBundled(ref.slug);
    if (recipe == null) {
      missing.push(ref.slug);
      continue;
    }
    const recipe_version =
      typeof (recipe as { version?: number }).version === 'number'
        ? (recipe as { version: number }).version
        : ref.version;
    resolved.push({
      slug: ref.slug,
      pinned_version: ref.version,
      recipe: {
        recipe_id: recipe.recipe_id,
        publisher_id: manifest.publisher,
        version: recipe_version,
        recipe_hash: hashRecipe(recipe),
        recipe,
      },
    });
  }
  return { resolved, missing };
};

/** Connection-agnostic op dispatch — the boot-path counterpart to the
 *  `packs.install` handler's op-step resolution. A foundation CRM pack
 *  references a BUNDLED vendor catalog by-ref (`{type:'ingredient',
 *  ingredient_id:'hubspot-catalog'}`) + connection-agnostic op-step recipes;
 *  this rewrites each op-step recipe to its concrete vendor-bound form
 *  (`resolvePackOpStepRecipes`) BEFORE the install transaction persists it, so a
 *  foundation pack can't leave an unrunnable op-step in the recipe store at boot.
 *
 *  Runs BEFORE the no-op fast-path so the rewritten recipe's `recipe_hash` is the
 *  one compared against the stored row — the rewrite is deterministic, so a
 *  steady-state boot still lands `no_op` (resolved-hash matches resolved-hash).
 *  Each rewritten entry's hash is recomputed off the concrete def; untouched
 *  (non-op-step) entries keep their bundled hash.
 *
 *  Fast path: a pack with no op-step recipe returns `resolved` untouched (every
 *  existing recipe-only foundation pack — byte-identical behavior). Throws on a
 *  hard block (an unresolvable op-step — unknown catalog, no by-ref vendor
 *  catalog, missing connection variable, …) so the per-pack try/catch records
 *  `errored` and the broken pack is skipped without crashing the boot scan. */
const resolveFoundationOpSteps = (
  manifest: BulkPackManifest,
  resolved: BulkPackInstallRecipe[],
  getCatalogManifest: (slug: string) => IngredientManifest | null,
): BulkPackInstallRecipe[] => {
  // Every entry has a non-null recipe here (missing recipes routed to
  // `skipped_missing_recipes` before this runs), so the map is index-aligned
  // with `resolved` and with `dispatch.recipes`.
  const recipeDefs = resolved.map((entry) => entry.recipe!.recipe);
  if (!recipesHaveCanonicalOpStep(recipeDefs)) return resolved;

  const contents = manifest.contents ?? [];
  const composition = contents.find(
    (c): c is Extract<PackContentRef, { type: 'composition' }> => c.type === 'composition',
  )?.composition;
  const dispatch = resolvePackOpStepRecipes(
    composition,
    contents,
    manifest.slug,
    recipeDefs,
    getCatalogManifest,
    // The boot path installs recipes only — it never provisions a composition's
    // catalog, so a foundation pack carrying a composition + op-steps hard-blocks
    // (its catalog would be unregistered at runtime). A first-party CRM pack uses
    // a by-ref BUNDLED catalog instead (composition undefined → first-party path).
    false,
  );
  if (!dispatch.ok) {
    throw new Error(`op-step resolution failed: ${dispatch.message}`);
  }
  for (const w of dispatch.warnings) {
    console.warn(`[d-170.foundation] ${manifest.slug}: ${w.code} — ${w.message}`);
  }
  return resolved.map((entry, i) => {
    const def = dispatch.recipes[i];
    // Only an op-step recipe's def actually changed; a non-op-step entry keeps
    // its original object + bundled hash (so its no-op fast-path is unchanged).
    if (entry.recipe == null || def === entry.recipe.recipe) return entry;
    return { ...entry, recipe: { ...entry.recipe, recipe: def, recipe_hash: hashRecipe(def) } };
  });
};

/** Runs the pack-install transaction for one foundation pack. The
 *  install handler is upsert-shaped, so calling it on every boot with
 *  a no-change pack short-circuits to per-recipe `markInstalled` upserts
 *  that the RecipeStore turns into hash-unchanged no-ops. */
const installOneFoundationPack = async (
  manifest: BulkPackManifest,
  recipes: BulkPackInstallRecipe[],
  recipeStore: RecipeStore,
  now: number,
  mcpBodyVisibilityStore?: McpBodyVisibilityStore,
): Promise<BulkPackInstallResult> => {
  const input: BulkPackInstallInput = {
    manifest_version: BULK_INSTALL_PACK_VERSION,
    pack_slug: manifest.slug,
    publisher: manifest.publisher,
    requires: [...manifest.requires],
    recipes,
    ready: true,
    ...(manifest.webhook_requirements !== undefined
      ? { webhook_requirements: [...manifest.webhook_requirements] }
      : {}),
    ...(manifest.mcp_body_visibility_grants !== undefined
      ? { mcp_body_visibility_grants: [...manifest.mcp_body_visibility_grants] }
      : {}),
  };
  // Foundation packs grant themselves the install permission + every
  // permission they declared in `requires` — the user implicitly granted
  // every first-party Day-1 permission by running the recued-server.
  // Third-party packs continue to flow through the marketplace install
  // dialog (Settings → Packs → Install) which collects explicit user
  // consent.
  const granted = new Set<string>([BULK_PACK_INSTALL_PERMISSION, ...manifest.requires]);
  return installBulkPackOnServer(input, granted, {
    recipeStore,
    now,
    ...(mcpBodyVisibilityStore ? { mcpBodyVisibilityStore } : {}),
  });
};

/** D-173 D1 — outcome of provisioning a pre_install pack's by-value
 *  `composition` content at boot.
 *  - `'none'` — the pack carries no composition (every recipe-only
 *    foundation pack — byte-identical behavior; the field is never set).
 *  - `'deferred'` — a composition is present but the provisioning deps are
 *    unwired (dbless / pre-store boot). Honest deferral, mirroring the
 *    `packs.install` rpc's `canProvisionComposition` false branch.
 *  - `'provisioned'` — the catalog + compiled review-then-approve recipe +
 *    grants installed (upsert; re-run each boot from disk).
 *  - `'failed'` — the provisioner returned a typed error (logged; the
 *    per-pack try/catch records the pack `errored`). */
type CompositionProvisionOutcome = 'none' | 'deferred' | 'provisioned' | 'failed';

/** D-173 D1 — provision a pre_install pack's by-value `composition` content
 *  at boot, the boot counterpart of the `packs.install` rpc's composition
 *  branch (`provisionPackCompositionForBulkInstall`).
 *
 *  A composition pack (the reception core-packs) ships its catalog + compiled
 *  `review-then-approve` recipe + grants BY VALUE — `recipes: []` at the
 *  manifest top level, the recipe COMPILED from the composition at install
 *  (D-170 N.18). The recipe-only foundation install path (`resolveBundledRecipes`
 *  + `installOneFoundationPack`) never touches it, so without this a pre_install
 *  composition pack installs ZERO recipes and the reception review→inbox→approve
 *  path is a dead-end on a fresh boot (the `fireReceptionWorkflow` seam finds no
 *  compiled recipe → every submission sits `pending`, the inbox stays empty).
 *
 *  Idempotent across boots: the provisioner treats a re-provision as the pack's
 *  own prior install (its `priorIds`/commit path; `slugConflict` is false for a
 *  locally-authored catalog) and every write is an upsert + a `Map.set` into the
 *  live registry, so re-running each boot re-installs from disk (matching the
 *  recipe half's "disk is the source of truth" contract — also picks up a bundled
 *  composition update without a manual re-install). */
const provisionPackCompositionAtBoot = (
  manifest: BulkPackManifest,
  recipeStore: RecipeStore,
  deps: PreInstallFoundationPacksInput['compositionProvision'],
  now: number,
): CompositionProvisionOutcome => {
  const contents = manifest.contents ?? [];
  const compositionRefs = contents.filter((c) => c.type === 'composition');
  if (compositionRefs.length === 0) return 'none';
  // Deps unwired (dbless / pre-store boot) — leave the composition unprovisioned
  // (the rpc-install path can still provision it later). Honest deferral.
  if (deps === undefined) return 'deferred';
  if (compositionRefs.length > 1) {
    console.warn(
      `[d-173] pack ${JSON.stringify(manifest.slug)} carries more than one composition content — skipping composition provisioning`,
    );
    return 'failed';
  }
  // Only by-ref `ingredient` contents become marketplace inventory rows; the
  // composition catalog is recorded by the provisioner under its own kind.
  const byRefContents = contents.filter((c) => c.type === 'ingredient');
  const result = provisionPackCompositionForBulkInstall(
    {
      localManifestStore: deps.localManifestStore,
      contractStore: deps.contractStore,
      registry: deps.registry,
      now: () => now,
      compiledRecipeStore: recipeStore,
      ...(deps.recipeTrustStore ? { recipeTrustStore: deps.recipeTrustStore } : {}),
      ...(deps.reconcileConnectionProfile
        ? { reconcileConnectionProfile: deps.reconcileConnectionProfile }
        : {}),
      // D-192 — register the composition's bound connection's pack-declared
      // work-entity Sources post-commit (at boot this is unwired; the boot scan
      // registers them instead).
      ...(deps.reconcileWorkEntitySources
        ? { reconcileWorkEntitySources: deps.reconcileWorkEntitySources }
        : {}),
      ...(deps.vendorForCatalog ? { vendorForCatalog: deps.vendorForCatalog } : {}),
    },
    manifest,
    byRefContents,
  );
  if (!result.ok) {
    console.warn(
      `[d-173] composition provisioning failed for pack ${JSON.stringify(manifest.slug)}: ${result.code} — ${result.message}`,
    );
    return 'failed';
  }
  return 'provisioned';
};

/** Boot-time foundation-pack pre-install scan. Idempotent across boots:
 *  RecipeStore upserts hash-keyed; the install transaction's no-op path
 *  short-circuits when the recipe row matches the bundled definition. A
 *  pre_install pack carrying a by-value `composition` (the reception
 *  core-packs) additionally provisions that catalog + its compiled recipe
 *  via `provisionPackCompositionAtBoot` (D-173 D1), independent of the recipe
 *  no-op fast-path. Returns per-pack outcomes so the boot logger can render
 *  the count + the bin.ts caller can hand the audit emitter a structured
 *  payload. */
export const preInstallFoundationPacks = async (
  input: PreInstallFoundationPacksInput,
): Promise<FoundationPackPreInstallResult> => {
  // Union the embedded foundation manifests ONLY on the default path (production:
  // no `input.packDir`). A test pins `packDir` to its own fixture + must not get
  // the embedded packs injected.
  const usingDefaultPackDir = input.packDir === undefined;
  const packDir = input.packDir ?? findCommunityPackDir();
  const now = input.now ?? Date.now();
  const { ok: manifests, outcomes: manifestOutcomes } = loadFoundationPackManifests(
    packDir,
    usingDefaultPackDir,
  );
  const outcomes: FoundationPackOutcome[] = [...manifestOutcomes];

  // Catalog resolver for op-step packs — the caller's live registry, or a
  // lazily-built bundled-ingredient registry fallback (built once, only if an
  // op-step pack actually needs it; recipe-only packs never reach it).
  let bundledRegistry: ManifestRegistry | undefined;
  const getCatalogManifest: (slug: string) => IngredientManifest | null =
    input.getCatalogManifest
    ?? ((slug) => {
      bundledRegistry ??= createManifestRegistry();
      return bundledRegistry.get(slug);
    });

  for (const manifest of manifests) {
    // Codex P2 fold — per-pack try/catch isolates pathological packs
    // from rejecting the whole boot scan. An unexpected store / hash /
    // install exception lands as `errored` with the message; the next
    // pack still gets a chance to install. Pre-install is best-effort
    // by design — boot must continue even when one pack misbehaves.
    try {
      const { resolved, missing } = resolveBundledRecipes(manifest, input.recipeStore);
      if (missing.length > 0) {
        outcomes.push({ slug: manifest.slug, status: 'skipped_missing_recipes', missing });
        continue;
      }
      // Connection-agnostic op dispatch — rewrite any op-step recipe to its
      // concrete vendor-bound form (against a by-ref BUNDLED catalog via the
      // registry) BEFORE the no-op check + install. Throws on a hard block →
      // caught below as `errored`. Recipe-only packs pass through untouched.
      const installRecipes = resolveFoundationOpSteps(
        manifest,
        resolved,
        getCatalogManifest,
      );
      // Codex P2 fold — fast-path no-op when every recipe matches. The
      // install transaction is still idempotent on a hash-unchanged
      // pack, but skipping the call avoids the per-recipe upsert pass
      // + future audit emission on every steady-state boot.
      //
      // D-173 D1 — the recipe no-op no longer `continue`s the loop: a
      // composition-only pack (the reception core-packs; `recipes: []`) has an
      // EMPTY recipe set → `recipesNoOp` true, yet its by-value composition
      // still needs provisioning below. Fall through to the composition half.
      const recipesNoOp =
        allRecipesAlreadyInstalled(installRecipes, input.recipeStore);
      let recipeResult: BulkPackInstallResult | null = null;
      if (!recipesNoOp) {
        recipeResult = await installOneFoundationPack(
          manifest,
          installRecipes,
          input.recipeStore,
          now,
          input.mcpBodyVisibilityStore,
        );
        if (!recipeResult.ok) {
          outcomes.push({ slug: manifest.slug, status: 'failed', failure: recipeResult.failure });
          continue;
        }
      }

      // D-173 D1 — composition half. Provision any by-value `composition` the
      // pack carries (the reception core-packs), independent of the recipe
      // no-op above. A composition failure flips the pack to `errored` (the
      // recipes, if any, already committed — best-effort, like the rpc).
      const compositionOutcome = provisionPackCompositionAtBoot(
        manifest,
        input.recipeStore,
        input.compositionProvision,
        now,
      );
      if (compositionOutcome === 'failed') {
        outcomes.push({
          slug: manifest.slug,
          status: 'errored',
          error: `composition provisioning failed for ${manifest.slug} (see boot log)`,
        });
        continue;
      }

      // One combined outcome. A recipe install carries the engine result; a
      // composition-only provision lands `composition_installed`; a pack whose
      // recipes AND composition both already matched (or a recipe-only pack on a
      // steady-state boot) lands `no_op`.
      if (recipeResult !== null) {
        outcomes.push({ slug: manifest.slug, status: 'installed', result: recipeResult });
      } else if (compositionOutcome === 'provisioned') {
        outcomes.push({ slug: manifest.slug, status: 'composition_installed' });
      } else {
        outcomes.push({ slug: manifest.slug, status: 'no_op' });
      }
    } catch (e) {
      outcomes.push({
        slug: manifest.slug,
        status: 'errored',
        error: (e as Error).message ?? String(e),
      });
    }
  }

  let installedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let noOpCount = 0;
  for (const o of outcomes) {
    switch (o.status) {
      case 'installed':
      case 'composition_installed':
        installedCount += 1;
        break;
      case 'no_op':
        noOpCount += 1;
        break;
      case 'failed':
      case 'errored':
        failedCount += 1;
        break;
      default:
        skippedCount += 1;
    }
  }
  return { outcomes, installedCount, skippedCount, failedCount, noOpCount };
};
