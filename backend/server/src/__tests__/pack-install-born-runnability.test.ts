/** Install "born blocked / degraded" disclosure tests — D-182 step 8 R1.
 *
 *  `handlePacksInstall` augments its result with `born_blocked` / `born_degraded`:
 *  the freshly-installed recipes partitioned by derived runnability, read from the
 *  injected `computeRunnability` thunk (the composer binds it to
 *  `listRecipeRunnability`, RE-GROUNDED on the R1 verb-split). These tests pin the
 *  install handler's PARTITION + this-pack SCOPING + best-effort plumbing — the
 *  piece that is independent of HOW a status is derived — by injecting a controlled
 *  runnability snapshot stub.
 *
 *  Why a stub and not the real service here: under R1 a non-`runnable` born status
 *  requires a recipe with an unbound `core.crm.*` / `core.acct.*` op-step, and such
 *  a canonical-op recipe is installable only inside a pack that BINDS a vendor
 *  catalog (a composition or a `hubspot-catalog` / `salesforce-catalog` reference) —
 *  orthogonal pack-authoring machinery that would swamp the partition plumbing under
 *  test. The R1 status DERIVATION itself (unbound write → blocked, unbound read →
 *  degraded, bound / no-canonical-op → runnable) is covered end-to-end against the
 *  REAL `listRecipeRunnability` in `recipe-runnability-handler.test.ts`; the composer
 *  binding `computeRunnability: () => listRecipeRunnability(...).recipes` is
 *  type-checked. So the recipes here stay empty-step (installable as plain pack
 *  recipes) and the snapshot is supplied directly.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTrustStateStore } from '@recued/approvals';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
  type CompositionIngredient,
  type RecipeRunnabilityEntry,
} from '@recued/contracts';

import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { handlePacksInstall, type PackInstallRpcDeps } from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createContractStore } from '../storage/contract-store.js';

// ──────────────── fixtures ────────────────

/** Write a bundled empty-step recipe JSON to `dir` (the install path resolves via
 *  `getBundled(slug)`, which keys on `recipe_id` → slug === recipe_id). Empty steps
 *  install as a plain pack recipe with no vendor-catalog binding; the born status
 *  comes from the injected `computeRunnability` stub, not from these steps. */
const writeRecipe = (dir: string, recipe_id: string): void => {
  writeFileSync(
    join(dir, `${recipe_id}.json`),
    JSON.stringify({
      recipe_id,
      version: 1,
      ttl: 60,
      metadata: {
        name: recipe_id,
        description: 'fixture',
        author: 'recued-core',
        supported_platforms: [],
        tags: [],
      },
      steps: [],
      output: { sidebar: [] },
    }),
  );
};

const manifestOf = (slug: string, recipeIds: string[]): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug,
  publisher: 'recued-core',
  name: `Pack ${slug}`,
  description: 'fixture',
  version: 1,
  recipes: recipeIds.map((id) => ({ slug: id, version: 1 })),
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
});

// ──────────────── runnability snapshot stub ────────────────
//
// The install handler reads `computeRunnability()` once and partitions THIS pack's
// installed recipes by status. The entry builders mirror what the R1 service emits
// (see recipe-runnability-handler.test.ts): an unbound canonical WRITE → blocked
// (hard, family-keyed detail), an unbound READ → degraded (optional), everything
// else → runnable (no detail).

const blocked = (recipe_id: string, verb = 'create'): RecipeRunnabilityEntry => ({
  recipe_id,
  status: 'blocked',
  dependencies: [
    { capability: 'crm', ops: [verb], optional: false, satisfied: false, providers: [], unprovided_ops: [verb] },
  ],
});
const degraded = (recipe_id: string, verb = 'search'): RecipeRunnabilityEntry => ({
  recipe_id,
  status: 'degraded',
  dependencies: [
    { capability: 'crm', ops: [verb], optional: true, satisfied: false, providers: [], unprovided_ops: [verb] },
  ],
});
const runnable = (recipe_id: string): RecipeRunnabilityEntry => ({
  recipe_id,
  status: 'runnable',
  dependencies: [],
});

/** A STORE-DEPENDENT `computeRunnability` thunk: at call time it reads the live
 *  recipe store and emits the mapped status for each recipe currently present
 *  (unmapped → runnable). Coupling the snapshot to `store.ids()` — rather than a
 *  static list — keeps the test honest that the handler reads runnability against
 *  the live post-install store + scopes to `result.installed`, not a decoupled set.
 *  (The R1 status DERIVATION over the real `listRecipeRunnability` is covered in
 *  recipe-runnability-handler.test.ts; this pins the install→partition→scope half.) */
const liveSnapshot = (
  store: Pick<RecipeStore, 'ids'>,
  status: Record<string, RecipeRunnabilityEntry>,
) => () => store.ids().map((id) => status[id] ?? runnable(id));

const install = (deps: PackInstallRpcDeps, manifest: BulkPackManifest) =>
  handlePacksInstall(deps, {
    manifest,
    granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
  });

describe('install born-blocked / born-degraded disclosure', () => {
  let dir: string;
  let db: Database.Database;
  let recipeStore: RecipeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'born-runnability-'));
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseDeps = (computeRunnability: () => readonly RecipeRunnabilityEntry[]): PackInstallRpcDeps => ({
    recipeStore,
    computeRunnability,
  });

  it('a blocked recipe → born_blocked carries the recipe + its synthesized R1 detail', async () => {
    writeRecipe(dir, 'blocked-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      baseDeps(liveSnapshot(recipeStore, { 'blocked-recipe': blocked('blocked-recipe') })),
      manifestOf('born-pack', ['blocked-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked).toEqual([blocked('blocked-recipe')]);
    expect(result.born_degraded).toBeUndefined();
  });

  it('a degraded recipe → born_degraded (not blocked)', async () => {
    writeRecipe(dir, 'degraded-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      baseDeps(liveSnapshot(recipeStore, { 'degraded-recipe': degraded('degraded-recipe') })),
      manifestOf('born-pack', ['degraded-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked).toBeUndefined();
    expect(result.born_degraded?.map((e) => e.recipe_id)).toEqual(['degraded-recipe']);
    expect(result.born_degraded?.[0].status).toBe('degraded');
  });

  it('a runnable recipe → both fields omitted', async () => {
    writeRecipe(dir, 'runnable-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      baseDeps(liveSnapshot(recipeStore, { 'runnable-recipe': runnable('runnable-recipe') })),
      manifestOf('born-pack', ['runnable-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked).toBeUndefined();
    expect(result.born_degraded).toBeUndefined();
  });

  it('partitions a mixed pack: one blocked, one degraded, one runnable', async () => {
    writeRecipe(dir, 'recipe-b');
    writeRecipe(dir, 'recipe-d');
    writeRecipe(dir, 'recipe-r');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      baseDeps(
        liveSnapshot(recipeStore, {
          'recipe-b': blocked('recipe-b', 'update'),
          'recipe-d': degraded('recipe-d'),
          'recipe-r': runnable('recipe-r'),
        }),
      ),
      manifestOf('born-pack', ['recipe-b', 'recipe-d', 'recipe-r']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked?.map((e) => e.recipe_id)).toEqual(['recipe-b']);
    expect(result.born_degraded?.map((e) => e.recipe_id)).toEqual(['recipe-d']);
    // The runnable recipe appears in NEITHER disclosure list.
    const disclosed = [
      ...(result.born_blocked ?? []),
      ...(result.born_degraded ?? []),
    ].map((e) => e.recipe_id);
    expect(disclosed).not.toContain('recipe-r');
  });

  it('absent computeRunnability (dbless / no connection store) → fields omitted, install still ok', async () => {
    writeRecipe(dir, 'blocked-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      { recipeStore },
      manifestOf('born-pack', ['blocked-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked).toBeUndefined();
    expect(result.born_degraded).toBeUndefined();
  });

  it('best-effort: a THROWING computeRunnability is swallowed — install stays ok, fields omitted', async () => {
    writeRecipe(dir, 'blocked-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      {
        recipeStore,
        computeRunnability: () => {
          throw new Error('store gone');
        },
      },
      manifestOf('born-pack', ['blocked-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked).toBeUndefined();
    expect(result.born_degraded).toBeUndefined();
  });

  it('scopes to THIS pack — an unrelated blocked recipe in the snapshot is NOT disclosed', async () => {
    // The snapshot reports two blocked recipes (it spans the whole store), but the
    // pack installs only one. The disclosure must name only the installed recipe.
    writeRecipe(dir, 'pack-recipe');
    writeRecipe(dir, 'other-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      baseDeps(
        liveSnapshot(recipeStore, {
          'pack-recipe': blocked('pack-recipe'),
          'other-recipe': blocked('other-recipe'),
        }),
      ),
      manifestOf('born-pack', ['pack-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.born_blocked?.map((e) => e.recipe_id)).toEqual(['pack-recipe']);
    expect(result.born_degraded).toBeUndefined();
  });

  it('pack recipes are bundled (fresh_install:false) yet STILL disclosed — not fresh-scoped', async () => {
    // Regression guard for the bundled-recipe `fresh_install:false` trap: pack
    // recipes resolve via getBundled, so the engine reports fresh_install:false; the
    // disclosure must track "what this install resolved", NOT fresh rows only (a
    // fresh-only filter would leave born_blocked permanently empty in production).
    writeRecipe(dir, 'blocked-recipe');
    recipeStore = createRecipeStore(dir, db);

    const { result } = await install(
      baseDeps(liveSnapshot(recipeStore, { 'blocked-recipe': blocked('blocked-recipe') })),
      manifestOf('born-pack', ['blocked-recipe']),
    );

    expect(result.ok).toBe(true);
    expect(result.installed.every((e) => !e.fresh_install)).toBe(true); // bundled ⇒ never fresh
    expect(result.born_blocked?.map((e) => e.recipe_id)).toEqual(['blocked-recipe']);
  });
});

// ────────────────────────────────────────────────────────────────
// The handler has a SECOND return path: a v2 app_pack whose `composition`
// content is provisioned reconstructs the result object (to drop the composition
// from `deferred_contents`). That branch must ALSO carry the born disclosure —
// dropping its `...bornDisclosure` spread would slip past every test above.
// ────────────────────────────────────────────────────────────────
describe('born disclosure on the composition-provisioned return path', () => {
  let dir: string;
  let db: Database.Database;
  let recipeStore: RecipeStore;

  /** A minimal valid composition (one read op, no entity fields) → decomposes to a
   *  standalone private_byo catalog, so `compositionProvisioned` becomes true. */
  const composition = (): CompositionIngredient => ({
    schema_version: 1,
    slug: 'acme',
    catalog_kind: 'private_byo',
    ingredients: [
      {
        slug: 'acme',
        kind: 'http',
        http: { base: 'https://api.thing.example', connection: 'acme' },
      },
    ],
    operations: [
      {
        op: 'thing.read',
        ingredient: 'acme',
        risk: 'read',
        approval: 'never',
        bind: { kind: 'rest', method: 'GET', path_template: '/v1/things/{id}' },
        description: 'Read a thing.',
      },
    ],
  });

  /** An app_pack carrying the composition by value + one bundled recipe (N.17). */
  const appPack = (recipeId: string): BulkPackManifest =>
    ({
      manifest_version: 2,
      slug: 'acme-crm',
      publisher: 'recued-core',
      name: 'Acme CRM',
      description: 'fixture',
      version: 1,
      recipes: [],
      requires: [BULK_PACK_INSTALL_PERMISSION],
      tags: [],
      pack_kind: 'app_pack',
      contents: [
        { type: 'composition', composition: composition() },
        { type: 'recipe', slug: recipeId, version: 1 },
      ],
    }) as unknown as BulkPackManifest;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'born-runnability-comp-'));
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('provisions the composition AND still discloses the blocked recipe', async () => {
    // The app_pack recipe is born blocked (the injected snapshot reports it so). The
    // composition provisions (no connection ⇒ no provider), so the handler takes the
    // composition-provisioned return path — which must carry born_blocked.
    writeRecipe(dir, 'acme-deal-report');
    recipeStore = createRecipeStore(dir, db);

    const contractStore = createContractStore(db, { now: () => 1 });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);

    const deps: PackInstallRpcDeps = {
      recipeStore,
      contractStore,
      recipeTrustStore: createTrustStateStore(createSQLiteCollection(db, 'recipe_trust')),
      localManifestStore: createLocalManifestStore(db),
      registry: createManifestRegistry('/nonexistent-born-comp-test-dir'),
      computeRunnability: liveSnapshot(recipeStore, { 'acme-deal-report': blocked('acme-deal-report') }),
      now: () => 1,
    };

    const { result } = await handlePacksInstall(deps, {
      manifest: appPack('acme-deal-report'),
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
    });

    expect(result.ok).toBe(true);
    // We are on the composition-provisioned branch: the composition is no longer
    // deferred (the branch reconstructs the result to drop it).
    expect(result.deferred_contents).toBeUndefined();
    // …and the born disclosure survived the reconstruction.
    expect(result.born_blocked?.map((e) => e.recipe_id)).toEqual(['acme-deal-report']);
  });
});
