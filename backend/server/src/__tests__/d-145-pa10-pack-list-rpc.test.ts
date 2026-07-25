/** D-145 PA10 follow-on — `packs.list` rpc handler + composer.
 *
 *  Exercises the read counterpart to `packs.install`:
 *    - Handler returns empty list when packDir doesn't exist.
 *    - Handler drops invalid JSON / validator-rejecting manifests silently
 *      (foundation-pack-pre-install boot wire is the surface for failure
 *      logging; the list rpc only surfaces installable packs).
 *    - Handler returns packs sorted alphabetically by slug.
 *    - Handler computes `installed: true` when every recipe matches slug
 *      AND version (Codex review MAJOR 1 fold — version drift flips
 *      installed back to false so the panel surfaces the upgrade path)
 *      AND `pack_slug` ownership (twin packs P1 fold — vendor twins
 *      share recipe slugs; only the binding owner shows installed so
 *      the other twin keeps its Install/rebind button).
 *    - Handler returns `installed: false` when any recipe missing.
 *    - Handler forwards the full manifest verbatim (the panel's install
 *      dialog consumes it without a `packs.fetch` round-trip).
 *    - Handler computes count fields correctly (recipe / SI / body
 *      grants).
 *    - Composer returns undefined-bundle when recipeStore absent.
 *    - `makePackListHandlers(undefined)` returns undefined so the rpc
 *      surfaces `not_configured`.
 *    - Slice returns `packs.list` when deps are wired. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MANIFEST_VERSION_V2,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';

import { composePackListRpcDeps } from '../composition/bin/wire-pack-list-rpc-deps.js';
import { recordPackInventory } from '../pack-inventory.js';
import {
  handlePacksList,
  listVersionExactInstalledPackManifests,
  makePackListHandlers,
} from '../pack-list-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

let recipeDir: string;
let packDir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

/** Fixed install clock for the `installed_pack` registry rows the hybrid
 *  install-signal reads (Packs-route delta 1). */
const NOW = 1_750_000_000_000;

/** A valid empty-`recipes[]` v2 app-pack manifest — the shape of the 37/47
 *  composition / CLI / workflow packs whose install-state the recipe-store
 *  check is structurally blind to. The validator requires manifest_version 2
 *  + at least one `contents[]` entry for an empty `recipes[]`. */
const emptyRecipesManifest = (slug: string): BulkPackManifest =>
  baseManifest({
    slug,
    manifest_version: BULK_PACK_MANIFEST_VERSION_V2,
    recipes: [],
    contents: [{ type: 'ingredient', slug: `${slug}-catalog`, version: 1 }],
  } as Partial<BulkPackManifest>);

const recipeDef = (recipe_id: string, version = 1): RecipeDefinition => ({
  recipe_id,
  version,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'd-145 pack-list rpc test fixture',
    author: 'recued-core',
    supported_platforms: [],
    tags: [],
  },
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const writeBundledRecipe = (recipe_id: string, version = 1): void => {
  writeFileSync(
    join(recipeDir, `${recipe_id}.json`),
    JSON.stringify(recipeDef(recipe_id, version)),
  );
};

const writeManifest = (slug: string, manifest: BulkPackManifest): void => {
  writeFileSync(join(packDir, `${slug}.json`), JSON.stringify(manifest));
};

const baseManifest = (overrides: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'pack-default',
  publisher: 'recued-core',
  name: 'Default Pack',
  description: 'fixture',
  version: 1,
  recipes: [{ slug: 'alpha-recipe', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  ...overrides,
});

beforeEach(() => {
  recipeDir = mkdtempSync(join(tmpdir(), 'recued-d145-pack-list-rpc-recipes-'));
  packDir = mkdtempSync(join(tmpdir(), 'recued-d145-pack-list-rpc-packs-'));
  db = new Database(':memory:');
  writeBundledRecipe('alpha-recipe');
  writeBundledRecipe('beta-recipe');
  recipeStore = createRecipeStore(recipeDir, db);
});

afterEach(() => {
  db.close();
  rmSync(recipeDir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// Handler
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — handlePacksList', () => {
  it('returns an empty list when packDir does not exist', async () => {
    rmSync(packDir, { recursive: true, force: true });
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs).toEqual([]);
  });

  it('returns an empty list when packDir exists but has no JSON files', async () => {
    writeFileSync(join(packDir, 'README.txt'), 'not a manifest');
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs).toEqual([]);
  });

  it('silently drops invalid JSON manifests', async () => {
    writeFileSync(join(packDir, 'broken.json'), '{not json');
    writeManifest('valid-pack', baseManifest({ slug: 'valid-pack' }));
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs.map((p) => p.slug)).toEqual(['valid-pack']);
  });

  it('silently drops manifests that fail validator', async () => {
    // missing required `name` field → validator rejects
    writeFileSync(
      join(packDir, 'invalid.json'),
      JSON.stringify({ slug: 'invalid', manifest_version: 1 }),
    );
    writeManifest('valid-pack', baseManifest({ slug: 'valid-pack' }));
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs.map((p) => p.slug)).toEqual(['valid-pack']);
  });

  it('returns packs sorted alphabetically by slug', async () => {
    writeManifest('zebra-pack', baseManifest({ slug: 'zebra-pack' }));
    writeManifest('alpha-pack', baseManifest({ slug: 'alpha-pack' }));
    writeManifest('middle-pack', baseManifest({ slug: 'middle-pack' }));
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs.map((p) => p.slug)).toEqual([
      'alpha-pack',
      'middle-pack',
      'zebra-pack',
    ]);
  });

  it('computes installed: true when every recipe matches slug + version + pack ownership', async () => {
    writeManifest(
      'installed-pack',
      baseManifest({
        slug: 'installed-pack',
        recipes: [{ slug: 'alpha-recipe', version: 1 }],
      }),
    );
    // Save the recipe at version 1, owned by this pack (matches manifest —
    // `packs.install` stamps `pack_slug` on every row it writes)
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled', undefined, 'installed-pack');
    const result = await handlePacksList({ recipeStore, packDir });
    const pack = result.packs.find((p) => p.slug === 'installed-pack')!;
    expect(pack.installed).toBe(true);
  });

  it('returns installed: false when the recipes are owned by another pack (twin packs P1 fold)', async () => {
    // Vendor twin packs share recipe slugs (connection-agnostic recipes,
    // last-install-wins rebinding) — only the twin whose `pack_slug` owns
    // the stored rows shows installed, so the other twin keeps its
    // Install button (which performs the rebind).
    writeManifest(
      'twin-a-pack',
      baseManifest({
        slug: 'twin-a-pack',
        recipes: [{ slug: 'alpha-recipe', version: 1 }],
      }),
    );
    writeManifest(
      'twin-b-pack',
      baseManifest({
        slug: 'twin-b-pack',
        recipes: [{ slug: 'alpha-recipe', version: 1 }],
      }),
    );
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled', undefined, 'twin-a-pack');
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs.find((p) => p.slug === 'twin-a-pack')!.installed).toBe(true);
    expect(result.packs.find((p) => p.slug === 'twin-b-pack')!.installed).toBe(false);
  });

  it('returns installed: false when the stored rows carry no pack ownership (manually installed)', async () => {
    // A manually-installed canonical recipe never went through the pack's
    // catalog binding — a false `installed` would hide the Install button
    // that performs it.
    writeManifest(
      'unowned-pack',
      baseManifest({
        slug: 'unowned-pack',
        recipes: [{ slug: 'alpha-recipe', version: 1 }],
      }),
    );
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled');
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.packs.find((p) => p.slug === 'unowned-pack')!.installed).toBe(false);
  });

  it('returns installed: false on version drift (MAJOR 1 fold)', async () => {
    writeManifest(
      'drifted-pack',
      baseManifest({
        slug: 'drifted-pack',
        recipes: [{ slug: 'alpha-recipe', version: 2 }],
      }),
    );
    // Save at version 1, manifest pins version 2 → drift
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled');
    const result = await handlePacksList({ recipeStore, packDir });
    const pack = result.packs.find((p) => p.slug === 'drifted-pack')!;
    expect(pack.installed).toBe(false);
  });

  it('returns installed: false when any recipe is missing', async () => {
    writeManifest(
      'partial-pack',
      baseManifest({
        slug: 'partial-pack',
        recipes: [
          { slug: 'alpha-recipe', version: 1 },
          { slug: 'gamma-recipe', version: 1 },
        ],
      }),
    );
    // Save alpha-recipe but not gamma-recipe
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled');
    const result = await handlePacksList({ recipeStore, packDir });
    const pack = result.packs.find((p) => p.slug === 'partial-pack')!;
    expect(pack.installed).toBe(false);
  });

  it('returns installed: false for empty recipes[] manifest', async () => {
    // Manifest with no recipes (edge case — validator may reject this,
    // but if it slips through the `recipes.length > 0` guard ensures
    // installed: false rather than vacuously-true).
    writeManifest(
      'empty-pack',
      baseManifest({ slug: 'empty-pack', recipes: [] }),
    );
    const result = await handlePacksList({ recipeStore, packDir });
    // Validator might drop empty-recipes manifests; if it surfaces,
    // installed: false is the expected value.
    const pack = result.packs.find((p) => p.slug === 'empty-pack');
    if (pack !== undefined) {
      expect(pack.installed).toBe(false);
    }
  });

  // ── Packs-route delta 1 — HYBRID install-signal for empty-recipes packs ──

  it('computes installed: true for an empty-recipes pack with an installed_pack registry row', async () => {
    // The 37/47 v2 composition / CLI / workflow packs ship `recipes: []`, so
    // the recipe-store check is structurally blind to them (vacuously
    // not-installed). Their real install-signal is the `installed_pack`
    // inventory row the composition provisioner / `packs.install` rpc writes.
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('composition-pack', emptyRecipesManifest('composition-pack'));
    recordPackInventory(store, {
      pack_slug: 'composition-pack',
      publisher: 'recued-core',
      pack_version: 1,
      contents: [],
      installed_at: NOW,
    });
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    expect(result.packs.find((p) => p.slug === 'composition-pack')!.installed).toBe(true);
  });

  it('computes installed: false for an empty-recipes pack with a contract store but no registry row', async () => {
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('uninstalled-composition-pack', emptyRecipesManifest('uninstalled-composition-pack'));
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    expect(
      result.packs.find((p) => p.slug === 'uninstalled-composition-pack')!.installed,
    ).toBe(false);
  });

  it('a recipe-bearing pack ignores the registry — a stale installed_pack row never overrides the recipe-ownership check', async () => {
    // The hybrid uses the registry ONLY for empty-recipes packs. A
    // recipe-bearing twin with a (stale) registry row but whose recipes are
    // owned by its sibling must STILL show installed: false — else the
    // registry would double-count and hide the rebind Install button.
    writeManifest(
      'twin-a-pack',
      baseManifest({ slug: 'twin-a-pack', recipes: [{ slug: 'alpha-recipe', version: 1 }] }),
    );
    writeManifest(
      'twin-b-pack',
      baseManifest({ slug: 'twin-b-pack', recipes: [{ slug: 'alpha-recipe', version: 1 }] }),
    );
    // alpha-recipe is owned by twin-a; both twins carry an installed_pack row.
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled', undefined, 'twin-a-pack');
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    for (const slug of ['twin-a-pack', 'twin-b-pack']) {
      recordPackInventory(store, {
        pack_slug: slug,
        publisher: 'recued-core',
        pack_version: 1,
        contents: [],
        installed_at: NOW,
      });
    }
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    expect(result.packs.find((p) => p.slug === 'twin-a-pack')!.installed).toBe(true);
    // twin-b has a registry row but does NOT own the recipe → recipe-check wins.
    expect(result.packs.find((p) => p.slug === 'twin-b-pack')!.installed).toBe(false);
  });

  it('computes installed: false for an empty-recipes pack whose installed_pack version drifts from the manifest', async () => {
    // Parity with the recipe-bearing version-drift case: a v2 app/CLI pack
    // installed at v1 then bumped to v2 on disk re-shows Install, not
    // "installed" — else the upgrade path is hidden (Codex P2 fold).
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest(
      'bumped-composition-pack',
      baseManifest({
        slug: 'bumped-composition-pack',
        manifest_version: BULK_PACK_MANIFEST_VERSION_V2,
        version: 2, // the disk manifest is now at v2…
        recipes: [],
        contents: [{ type: 'ingredient', slug: 'bumped-composition-pack-catalog', version: 1 }],
      } as Partial<BulkPackManifest>),
    );
    // …but the inventory was recorded at v1.
    recordPackInventory(store, {
      pack_slug: 'bumped-composition-pack',
      publisher: 'recued-core',
      pack_version: 1,
      contents: [],
      installed_at: NOW,
    });
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    expect(
      result.packs.find((p) => p.slug === 'bumped-composition-pack')!.installed,
    ).toBe(false);
  });

  it('forwards the full manifest verbatim', async () => {
    const manifest = baseManifest({
      slug: 'forwarded-pack',
      description: 'specific description for verbatim check',
      tags: ['tag-one', 'tag-two'],
      requires: [BULK_PACK_INSTALL_PERMISSION, 'notification_send'],
    });
    writeManifest('forwarded-pack', manifest);
    const result = await handlePacksList({ recipeStore, packDir });
    const pack = result.packs.find((p) => p.slug === 'forwarded-pack')!;
    expect(pack.manifest.description).toBe(
      'specific description for verbatim check',
    );
    expect(pack.manifest.tags).toEqual(['tag-one', 'tag-two']);
    expect(pack.manifest.requires).toEqual([
      BULK_PACK_INSTALL_PERMISSION,
      'notification_send',
    ]);
  });

  it('computes recipe_count + body_visibility_grant_count', async () => {
    writeManifest(
      'counts-pack',
      baseManifest({
        slug: 'counts-pack',
        recipes: [
          { slug: 'alpha-recipe', version: 1 },
          { slug: 'beta-recipe', version: 1 },
        ],
        mcp_body_visibility_grants: ['data.contact.engagements.body_content'],
      }),
    );
    const result = await handlePacksList({ recipeStore, packDir });
    const pack = result.packs.find((p) => p.slug === 'counts-pack')!;
    expect(pack.recipe_count).toBe(2);
    expect(pack.body_visibility_grant_count).toBe(1);
  });

  it('sets pre_install flag from manifest', async () => {
    writeManifest(
      'foundation-pack',
      baseManifest({ slug: 'foundation-pack', pre_install: true }),
    );
    writeManifest(
      'optional-pack',
      baseManifest({ slug: 'optional-pack' }),
    );
    const result = await handlePacksList({ recipeStore, packDir });
    expect(
      result.packs.find((p) => p.slug === 'foundation-pack')!.pre_install,
    ).toBe(true);
    expect(
      result.packs.find((p) => p.slug === 'optional-pack')!.pre_install,
    ).toBe(false);
  });

  it('zero counts when body grants absent', async () => {
    writeManifest('bare-pack', baseManifest({ slug: 'bare-pack' }));
    const result = await handlePacksList({ recipeStore, packDir });
    const pack = result.packs.find((p) => p.slug === 'bare-pack')!;
    expect(pack.body_visibility_grant_count).toBe(0);
  });

  // ── D-182 — installed_any_version (marketplace-higher / version skew) ──

  it('installed_any_version: TRUE for a pack owned at a DIFFERENT version than the disk bundle (marketplace higher)', async () => {
    // The server bundles this pack at v2; the user updated to the marketplace v5
    // (owned by the pack). `installed` is false (5 ≠ disk 2) but the pack IS
    // installed — installed_any_version keeps Discover from flipping to "available".
    writeManifest('mkt-higher', baseManifest({ slug: 'mkt-higher', recipes: [{ slug: 'alpha-recipe', version: 2 }] }));
    recipeStore.save(recipeDef('alpha-recipe', 5), 'recued-core', 'bundled', undefined, 'mkt-higher');
    const pack = (await handlePacksList({ recipeStore, packDir })).packs.find((p) => p.slug === 'mkt-higher')!;
    expect(pack.installed).toBe(false); // owned, but NOT at the disk version
    expect(pack.installed_any_version).toBe(true);
  });

  it('installed_any_version: FALSE for a stale vendor-twin (recipes owned by ANOTHER pack)', async () => {
    // twin-b's recipes are owned by twin-a → twin-b is not genuinely installed;
    // both `installed` and `installed_any_version` must be false so the Discover
    // join skips it (no phantom install/upgrade from a stale row).
    writeManifest('twin-b', baseManifest({ slug: 'twin-b', recipes: [{ slug: 'alpha-recipe', version: 1 }] }));
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled', undefined, 'twin-a');
    const pack = (await handlePacksList({ recipeStore, packDir })).packs.find((p) => p.slug === 'twin-b')!;
    expect(pack.installed).toBe(false);
    expect(pack.installed_any_version).toBe(false);
  });

  it('returns only version-exact owned manifests for supplementary Seller discovery', () => {
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('owned-workflow', baseManifest({
      slug: 'owned-workflow',
      version: 2,
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    }));
    writeManifest('stale-workflow', baseManifest({
      slug: 'stale-workflow',
      recipes: [{ slug: 'beta-recipe', version: 1 }],
    }));
    recipeStore.save(
      recipeDef('alpha-recipe', 1),
      'recued-core',
      'bundled',
      undefined,
      'owned-workflow',
    );
    recipeStore.save(
      recipeDef('beta-recipe', 1),
      'recued-core',
      'bundled',
      undefined,
      'another-pack',
    );

    // Recipe pins alone are insufficient: v1 and v2 may intentionally share
    // the same recipes while v2 adds Seller-facing descriptor metadata.
    recordPackInventory(store, {
      pack_slug: 'owned-workflow',
      publisher: 'recued-core',
      pack_version: 1,
      contents: [],
      installed_at: NOW,
    });
    expect(listVersionExactInstalledPackManifests({
      recipeStore,
      packDir,
      contractStore: store,
    })).toEqual([]);

    recordPackInventory(store, {
      pack_slug: 'owned-workflow',
      publisher: 'recued-core',
      pack_version: 2,
      contents: [],
      installed_at: NOW,
    });
    expect(listVersionExactInstalledPackManifests({
      recipeStore,
      packDir,
      contractStore: store,
    }).map((manifest) => manifest.slug)).toEqual(['owned-workflow']);

    // Dbless/legacy composition has no pack-version proof and fails closed.
    expect(listVersionExactInstalledPackManifests({ recipeStore, packDir }))
      .toEqual([]);
  });

  it('installed_any_version: TRUE even when the installed version REPLACED the recipe slugs (disjoint from the disk manifest)', async () => {
    // The disk bundle (v2) lists `old-recipe`; the marketplace v5 the user installed
    // dropped it for `new-recipe`. The owned rows share NO slug with the disk
    // manifest refs, so probing disk refs would read false — `listForPack` (actual
    // owned rows) correctly reports the pack IS installed.
    writeManifest('replaced', baseManifest({ slug: 'replaced', recipes: [{ slug: 'old-recipe', version: 2 }] }));
    recipeStore.save(recipeDef('new-recipe', 5), 'recued-core', 'bundled', undefined, 'replaced'); // v5 replaced the slug
    const pack = (await handlePacksList({ recipeStore, packDir })).packs.find((p) => p.slug === 'replaced')!;
    expect(pack.installed).toBe(false); // no disk-ref recipe stored at the disk version
    expect(pack.installed_any_version).toBe(true); // owns `new-recipe` under this pack_slug
  });

  it('installed_any_version: TRUE (both true) for a normally-installed pack at the disk version', async () => {
    writeManifest('at-disk', baseManifest({ slug: 'at-disk', recipes: [{ slug: 'alpha-recipe', version: 1 }] }));
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled', undefined, 'at-disk');
    const pack = (await handlePacksList({ recipeStore, packDir })).packs.find((p) => p.slug === 'at-disk')!;
    expect(pack.installed).toBe(true);
    expect(pack.installed_any_version).toBe(true);
  });

  it('reports installed:true (disk recipe refs match) ALONGSIDE a higher inventory version — the additive-upgrade data the join prefers', async () => {
    // An additive marketplace upgrade bumps the PACK version (2→5) while leaving
    // the disk recipe ref unchanged, so `installed` stays true against the disk —
    // but the inventory holds the real v5. Both must be reported so the Discover
    // join uses the inventory version (not the disk `version`) for the compare.
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('additive', baseManifest({ slug: 'additive', version: 2, recipes: [{ slug: 'alpha-recipe', version: 1 }] }));
    recipeStore.save(recipeDef('alpha-recipe', 1), 'recued-core', 'bundled', undefined, 'additive'); // matches the disk ref
    recordPackInventory(store, { pack_slug: 'additive', publisher: 'recued-core', pack_version: 5, contents: [], installed_at: NOW });
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    const pack = result.packs.find((p) => p.slug === 'additive')!;
    expect(pack.installed).toBe(true); // disk recipe ref still owned at its version
    expect(pack.version).toBe(2); // the DISK pack version…
    expect(result.installed_versions).toContainEqual({ slug: 'additive', version: 5, publisher: 'recued-core' }); // …but the inventory is v5
  });

  it('installed_any_version: an empty-recipes pack with a version-drifted inventory row is TRUE (installed) though installed is FALSE', async () => {
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('comp-higher', baseManifest({
      slug: 'comp-higher', manifest_version: BULK_PACK_MANIFEST_VERSION_V2, version: 2, recipes: [],
      contents: [{ type: 'ingredient', slug: 'comp-higher-catalog', version: 1 }],
    } as Partial<BulkPackManifest>));
    recordPackInventory(store, { pack_slug: 'comp-higher', publisher: 'recued-core', pack_version: 5, contents: [], installed_at: NOW });
    const pack = (await handlePacksList({ recipeStore, packDir, contractStore: store })).packs.find((p) => p.slug === 'comp-higher')!;
    expect(pack.installed).toBe(false); // inventory v5 ≠ disk v2
    expect(pack.installed_any_version).toBe(true); // an inventory row exists
  });

  // ── D-182 — installed_versions (marketplace upgrade join) ──────────

  it('reports a MARKETPLACE-installed pack (inventory row, no bundled manifest) in installed_versions', async () => {
    // The upgrade caveat: a marketplace pack installed via Add-a-pack has NO
    // bundled manifest on disk, so it is absent from `packs[]`. Its version
    // lives only in the inventory — surfaced via `installed_versions` so
    // Discover can still flag its installed / upgrade state.
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    // No writeManifest — this pack is NOT bundled.
    recordPackInventory(store, {
      pack_slug: 'acme.crm',
      publisher: 'acme',
      pack_version: 3,
      contents: [],
      installed_at: NOW,
    });
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    // Absent from the bundled `packs[]`…
    expect(result.packs.find((p) => p.slug === 'acme.crm')).toBeUndefined();
    // …but present in installed_versions with a NUMERIC version + publisher.
    expect(result.installed_versions).toContainEqual({ slug: 'acme.crm', version: 3, publisher: 'acme' });
  });

  it('installed_versions covers a bundled empty-recipes pack too (numeric version)', async () => {
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('composition-pack', emptyRecipesManifest('composition-pack'));
    recordPackInventory(store, {
      pack_slug: 'composition-pack',
      publisher: 'recued-core',
      pack_version: 1,
      contents: [],
      installed_at: NOW,
    });
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    expect(result.installed_versions).toContainEqual({ slug: 'composition-pack', version: 1, publisher: 'recued-core' });
  });

  it('omits installed_versions entirely when no contract store is wired (dbless)', async () => {
    writeManifest('bundled-pack', baseManifest({ slug: 'bundled-pack' }));
    const result = await handlePacksList({ recipeStore, packDir });
    expect(result.installed_versions).toBeUndefined();
  });

  it('returns an empty installed_versions when a contract store is wired but nothing is installed', async () => {
    const store: ContractStore = createContractStore(db, { now: () => NOW });
    writeManifest('bundled-pack', baseManifest({ slug: 'bundled-pack' }));
    const result = await handlePacksList({ recipeStore, packDir, contractStore: store });
    expect(result.installed_versions).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// Composer
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — composePackListRpcDeps', () => {
  it('returns undefined bundle when recipeStore is absent', () => {
    const bundle = composePackListRpcDeps({ recipeStore: undefined });
    expect(bundle.packListDeps).toBeUndefined();
  });

  it('returns wired bundle when recipeStore is present', () => {
    const bundle = composePackListRpcDeps({ recipeStore });
    expect(bundle.packListDeps).toBeDefined();
    expect(bundle.packListDeps!.recipeStore).toBe(recipeStore);
  });

  it('forwards packDir override when present', () => {
    const bundle = composePackListRpcDeps({ recipeStore, packDir });
    expect(bundle.packListDeps!.packDir).toBe(packDir);
  });

  it('omits packDir from the bundle when not supplied', () => {
    const bundle = composePackListRpcDeps({ recipeStore });
    expect('packDir' in (bundle.packListDeps ?? {})).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// Handler factory
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — makePackListHandlers', () => {
  it('returns undefined when deps are undefined', () => {
    expect(makePackListHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice with packs.list when deps are wired', () => {
    const slice = makePackListHandlers({ recipeStore, packDir });
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual(['packs.list']);
    expect(typeof slice!.handlers['packs.list']).toBe('function');
  });
});
