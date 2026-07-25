/** D-165 P3.1 — install-inventory bookkeeping.
 *
 *  Core (`recordPackInventory` / `removePackInventory`) against a real
 *  in-memory `contract.*` store, plus the `packs.install` / `packs.uninstall`
 *  handler wiring (best-effort swallow + dbless skip). Exercises the three
 *  edge cases the adversarial review flagged:
 *    - shared-ingredient survival (an ingredient two packs declare lives
 *      until its LAST owner is uninstalled — `source_pack_slug` is provenance
 *      only, not the deletion signal);
 *    - atomic rollback (a mid-batch store failure leaves NO partial rows);
 *    - mixed / partial ingredient addressing refs are skipped, not written. */

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
  type PackContentRef,
  type RecipeDefinition,
} from '@recued/contracts';

import { handlePacksInstall } from '../pack-install-handler.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import {
  getInstalledPack,
  listInstalledPacks,
  recordPackInventory,
  removePackInventory,
} from '../pack-inventory.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

// ────────────────────────────────────────────────────────────────
// Content-ref builders
// ────────────────────────────────────────────────────────────────

const ingredientById = (id: string, ver: number): PackContentRef =>
  ({ type: 'ingredient', ingredient_id: id, ingredient_version: ver });
const ingredientBySlug = (slug: string, ver: number, role?: 'producer'): PackContentRef =>
  ({ type: 'ingredient', slug, version: ver, ...(role ? { role } : {}) });
const recipeContent = (slug: string, ver: number): PackContentRef =>
  ({ type: 'recipe', slug, version: ver });

// ════════════════════════════════════════════════════════════════
// Core — recordPackInventory
// ════════════════════════════════════════════════════════════════

describe('recordPackInventory', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it('writes installed_pack + one installed_ingredient per ingredient content (both addressing modes)', () => {
    const res = recordPackInventory(store, {
      pack_slug: 'sales-pack',
      pack_version: 3,
      installed_at: NOW,
      contents: [
        recipeContent('alpha-recipe', 1),
        ingredientById('recued-core/github', 2),
        ingredientBySlug('exa-search', 5, 'producer'),
      ],
    });

    expect(res.ingredient_ids).toEqual(['recued-core/github', 'exa-search']);

    const pack = store.get('installed_pack', ['sales-pack']);
    expect(pack?.value).toEqual({
      pack_slug: 'sales-pack',
      version: '3', // stringified per installed_pack_info.version: 'string'
      installed_at: NOW,
      ingredient_ids: ['recued-core/github', 'exa-search'],
    });

    // id-mode ingredient
    expect(store.get('installed_ingredient', ['recued-core/github'])?.value).toEqual({
      ingredient_id: 'recued-core/github',
      version: '2',
      installed_at: NOW,
      source_pack_slug: 'sales-pack',
    });
    // slug-mode ingredient (role is NOT persisted — not an installed_ingredient_info field)
    expect(store.get('installed_ingredient', ['exa-search'])?.value).toEqual({
      ingredient_id: 'exa-search',
      version: '5',
      installed_at: NOW,
      source_pack_slug: 'sales-pack',
    });
  });

  it('writes an installed_pack row with empty ingredient_ids for a recipe-only (v1) pack', () => {
    const res = recordPackInventory(store, {
      pack_slug: 'foundation',
      pack_version: 1,
      installed_at: NOW,
      contents: [recipeContent('a', 1), recipeContent('b', 1)],
    });
    expect(res.ingredient_ids).toEqual([]);
    expect(store.get('installed_pack', ['foundation'])?.value).toEqual({
      pack_slug: 'foundation',
      version: '1',
      installed_at: NOW,
      ingredient_ids: [],
    });
    expect(store.scan('installed_ingredient')).toHaveLength(0);
  });

  it('dedups repeated ingredient ids in ingredient_ids (single installed_ingredient row)', () => {
    const res = recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('dup', 1), ingredientById('dup', 1)],
    });
    expect(res.ingredient_ids).toEqual(['dup']);
    expect(store.scan('installed_ingredient')).toHaveLength(1);
  });

  it('skips mixed / partial / empty ingredient addressing refs (validator-bypassed)', () => {
    const res = recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 1,
      installed_at: NOW,
      contents: [
        { type: 'ingredient', ingredient_id: 'mixed', version: 1 } as PackContentRef, // cross-mode
        { type: 'ingredient', ingredient_id: 'partial-id' } as PackContentRef, // no version
        { type: 'ingredient', slug: 'partial-slug' } as PackContentRef, // no version
        { type: 'ingredient' } as PackContentRef, // empty
        ingredientById('ok', 4), // the one valid ref
      ],
    });
    expect(res.ingredient_ids).toEqual(['ok']);
    expect(store.scan('installed_ingredient').map((r) => r.segments[0])).toEqual(['ok']);
  });

  it('is an idempotent upsert — a re-install at a higher version overwrites in place', () => {
    recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('x', 1)],
    });
    recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 2,
      installed_at: NOW + 10,
      contents: [ingredientById('x', 9)],
    });
    expect(store.scan('installed_pack')).toHaveLength(1);
    expect(store.get('installed_pack', ['p'])?.value).toMatchObject({ version: '2', installed_at: NOW + 10 });
    expect(store.get('installed_ingredient', ['x'])?.value).toMatchObject({ version: '9', installed_at: NOW + 10 });
  });

  it('GCs an ingredient a re-install dropped (no orphan left behind)', () => {
    // p@1 declares [a, b]; p@2 drops b.
    recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('a', 1), ingredientById('b', 1)],
    });
    recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 2,
      installed_at: NOW + 5,
      contents: [ingredientById('a', 1)],
    });
    // b is gone (no installed_pack lists it); a + the pack row remain.
    expect(store.get('installed_ingredient', ['b'])).toBeNull();
    expect(store.get('installed_ingredient', ['a'])).not.toBeNull();
    expect(store.get('installed_pack', ['p'])?.value).toMatchObject({ ingredient_ids: ['a'] });
    // And a later uninstall leaves nothing behind.
    removePackInventory(store, 'p');
    expect(store.scan('installed_ingredient')).toHaveLength(0);
    expect(store.scan('installed_pack')).toHaveLength(0);
  });

  it('keeps a dropped ingredient that another installed pack still lists', () => {
    recordPackInventory(store, {
      pack_slug: 'p1',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('a', 1), ingredientById('shared', 1)],
    });
    recordPackInventory(store, {
      pack_slug: 'p2',
      pack_version: 1,
      installed_at: NOW + 1,
      contents: [ingredientById('shared', 1)],
    });
    // p1 re-installs dropping `shared` — but p2 still lists it, so it survives.
    recordPackInventory(store, {
      pack_slug: 'p1',
      pack_version: 2,
      installed_at: NOW + 2,
      contents: [ingredientById('a', 1)],
    });
    expect(store.get('installed_ingredient', ['shared'])).not.toBeNull();
    expect(store.get('installed_ingredient', ['a'])).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// Core — removePackInventory (incl. shared-ingredient survival)
// ════════════════════════════════════════════════════════════════

describe('removePackInventory', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it('removes the pack row + its owned ingredient rows', () => {
    recordPackInventory(store, {
      pack_slug: 'p',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('x', 1), ingredientById('y', 1)],
    });
    const res = removePackInventory(store, 'p');
    expect(res).toEqual({ removed_ingredients: 2, removed_pack: true });
    expect(store.get('installed_pack', ['p'])).toBeNull();
    expect(store.scan('installed_ingredient')).toHaveLength(0);
  });

  it('is idempotent for an absent pack (no throw, zero counts)', () => {
    expect(removePackInventory(store, 'never-installed')).toEqual({
      removed_ingredients: 0,
      removed_pack: false,
    });
  });

  it('keeps a shared ingredient until its LAST owner is uninstalled (install order independent)', () => {
    // Pack A installs X; pack B re-installs X (upserts the row, stamps B).
    recordPackInventory(store, {
      pack_slug: 'pack-a',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('shared', 1)],
    });
    recordPackInventory(store, {
      pack_slug: 'pack-b',
      pack_version: 1,
      installed_at: NOW + 1,
      contents: [ingredientById('shared', 1)],
    });
    // source_pack_slug now names the last writer (B) — provenance only.
    expect(store.get('installed_ingredient', ['shared'])?.value).toMatchObject({
      source_pack_slug: 'pack-b',
    });

    // Uninstall B — `shared` MUST survive because A still lists it.
    const rb = removePackInventory(store, 'pack-b');
    expect(rb).toEqual({ removed_ingredients: 0, removed_pack: true });
    expect(store.get('installed_pack', ['pack-b'])).toBeNull();
    expect(store.get('installed_ingredient', ['shared'])).not.toBeNull();

    // Uninstall A — now no pack lists `shared`, so it drops.
    const ra = removePackInventory(store, 'pack-a');
    expect(ra).toEqual({ removed_ingredients: 1, removed_pack: true });
    expect(store.get('installed_ingredient', ['shared'])).toBeNull();
  });

  it('removing the FIRST owner of a shared ingredient still leaves it (other owner remains)', () => {
    recordPackInventory(store, {
      pack_slug: 'pack-a',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('shared', 1)],
    });
    recordPackInventory(store, {
      pack_slug: 'pack-b',
      pack_version: 1,
      installed_at: NOW + 1,
      contents: [ingredientById('shared', 1)],
    });
    // Uninstall A (NOT the last writer) — shared survives (B still lists it).
    const ra = removePackInventory(store, 'pack-a');
    expect(ra.removed_ingredients).toBe(0);
    expect(store.get('installed_ingredient', ['shared'])).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// Atomicity — a mid-batch store failure leaves no partial rows
// ════════════════════════════════════════════════════════════════

describe('pack-inventory atomicity', () => {
  let db: Database.Database;
  let real: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    real = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  /** Wrap a real store so the Nth `put` throws — `transaction` still
   *  delegates to the real db so the throw rolls the batch back. */
  const failOnPut = (target: number): ContractStore => {
    let n = 0;
    return {
      ...real,
      put: (scope, segments, value) => {
        n += 1;
        if (n === target) throw new Error('simulated store failure');
        real.put(scope, segments, value);
      },
    };
  };

  it('rolls back every row when a later ingredient write throws', () => {
    const store = failOnPut(2); // first ingredient ok, second throws
    expect(() =>
      recordPackInventory(store, {
        pack_slug: 'p',
        pack_version: 1,
        installed_at: NOW,
        contents: [ingredientById('a', 1), ingredientById('b', 1)],
      }),
    ).toThrow(/simulated store failure/);
    // Nothing persisted — not even the first (successful) ingredient put.
    expect(real.scan('installed_ingredient')).toHaveLength(0);
    expect(real.scan('installed_pack')).toHaveLength(0);
  });

  it('rolls back when the final installed_pack write throws (no orphan ingredient rows)', () => {
    const store = failOnPut(2); // single ingredient ok, the pack write throws
    expect(() =>
      recordPackInventory(store, {
        pack_slug: 'p',
        pack_version: 1,
        installed_at: NOW,
        contents: [ingredientById('a', 1)],
      }),
    ).toThrow();
    expect(real.scan('installed_ingredient')).toHaveLength(0);
    expect(real.scan('installed_pack')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// Handler wiring — packs.install records inventory (best-effort + dbless)
// ════════════════════════════════════════════════════════════════

describe('handlePacksInstall — inventory wiring', () => {
  let dir: string;
  let db: Database.Database;
  let recipeStore: RecipeStore;
  let contractStore: ContractStore;

  const recipeDef = (recipe_id: string): RecipeDefinition => ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'd-165 p3.1 inventory fixture',
      author: 'recued-core',
      supported_platforms: [],
      tags: [],
    },
    steps: [],
    output: { sidebar: [] },
  } as unknown as RecipeDefinition);

  const v2Manifest = (): BulkPackManifest => ({
    manifest_version: BULK_PACK_MANIFEST_VERSION_V2,
    slug: 'app-pack',
    publisher: 'recued-core',
    name: 'App pack',
    description: 'fixture',
    version: 4,
    recipes: [{ slug: 'alpha-recipe', version: 1 }],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
    contents: [
      recipeContent('alpha-recipe', 1),
      ingredientById('recued-core/github', 2),
    ],
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-d165-p31-'));
    db = new Database(':memory:');
    writeFileSync(join(dir, 'alpha-recipe.json'), JSON.stringify(recipeDef('alpha-recipe')));
    recipeStore = createRecipeStore(dir, db);
    contractStore = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records installed_pack + installed_ingredient on a successful v2 install', async () => {
    const { result } = await handlePacksInstall(
      { recipeStore, contractStore, now: () => NOW },
      { manifest: v2Manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true);
    expect(contractStore.get('installed_pack', ['app-pack'])?.value).toMatchObject({
      pack_slug: 'app-pack',
      version: '4',
      ingredient_ids: ['recued-core/github'],
    });
    expect(contractStore.get('installed_ingredient', ['recued-core/github'])?.value).toMatchObject({
      ingredient_id: 'recued-core/github',
      version: '2',
      source_pack_slug: 'app-pack',
    });
  });

  it('skips inventory cleanly when no contractStore is wired (dbless path)', async () => {
    const { result } = await handlePacksInstall(
      { recipeStore, now: () => NOW },
      { manifest: v2Manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true); // install succeeds; nothing to assert in contract store
  });

  it('does NOT record inventory for a failed install (permission denied)', async () => {
    // The handler auto-adds BULK_PACK_INSTALL_PERMISSION, so require an extra
    // permission the dialog must grant; withholding it → engine ok:false.
    const manifest = { ...v2Manifest(), requires: [BULK_PACK_INSTALL_PERMISSION, 'read_memory'] };
    const { result } = await handlePacksInstall(
      { recipeStore, contractStore, now: () => NOW },
      { manifest, granted_permissions: [] },
    );
    expect(result.ok).toBe(false);
    expect(contractStore.get('installed_pack', ['app-pack'])).toBeNull();
  });

  it('best-effort: a throwing contract store does not flip the successful install to failure', async () => {
    const throwing: ContractStore = {
      ...contractStore,
      transaction: () => {
        throw new Error('contract store down');
      },
    };
    const { result } = await handlePacksInstall(
      { recipeStore, contractStore: throwing, now: () => NOW },
      { manifest: v2Manifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(true);
    // recipe still landed despite the inventory write throwing
    expect(recipeStore.listStored().map((r) => r.recipe_id)).toContain('alpha-recipe');
  });
});

// ════════════════════════════════════════════════════════════════
// Handler wiring — packs.uninstall removes inventory (best-effort)
// ════════════════════════════════════════════════════════════════

describe('handlePacksUninstall — inventory wiring', () => {
  let packDir: string;
  let db: Database.Database;
  let recipeStore: RecipeStore;
  let contractStore: ContractStore;

  const manifest: BulkPackManifest = {
    manifest_version: BULK_INSTALL_PACK_VERSION,
    slug: 'app-pack',
    publisher: 'recued-core',
    name: 'App pack',
    description: 'fixture',
    version: 1,
    recipes: [{ slug: 'alpha-recipe', version: 1 }],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
  };

  beforeEach(() => {
    packDir = mkdtempSync(join(tmpdir(), 'recued-d165-p31-uninstall-'));
    writeFileSync(join(packDir, 'app-pack.json'), JSON.stringify(manifest));
    db = new Database(':memory:');
    recipeStore = createRecipeStore(packDir, db);
    contractStore = createContractStore(db, { now: () => NOW });
    // Seed inventory as if the pack had been installed.
    recordPackInventory(contractStore, {
      pack_slug: 'app-pack',
      pack_version: 1,
      installed_at: NOW,
      contents: [ingredientById('recued-core/github', 2)],
    });
  });
  afterEach(() => {
    db.close();
    rmSync(packDir, { recursive: true, force: true });
  });

  it('drops the pack + ingredient inventory on a successful uninstall', async () => {
    const { result } = await handlePacksUninstall(
      { recipeStore, contractStore, packDir },
      { pack_slug: 'app-pack' },
    );
    expect(result.ok).toBe(true);
    expect(contractStore.get('installed_pack', ['app-pack'])).toBeNull();
    expect(contractStore.get('installed_ingredient', ['recued-core/github'])).toBeNull();
  });

  it('best-effort: a throwing contract store does not flip the successful uninstall to failure', async () => {
    const throwing: ContractStore = {
      ...contractStore,
      transaction: () => {
        throw new Error('contract store down');
      },
    };
    const { result } = await handlePacksUninstall(
      { recipeStore, contractStore: throwing, packDir },
      { pack_slug: 'app-pack' },
    );
    expect(result.ok).toBe(true);
  });

  it('leaves inventory untouched + still succeeds when no contractStore is wired', async () => {
    const { result } = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'app-pack' },
    );
    expect(result.ok).toBe(true);
    // inventory remains (no store wired to clean it) — proves the dbless path is a no-op
    expect(contractStore.get('installed_pack', ['app-pack'])).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// D-182 — listInstalledPacks (Discover marketplace upgrade join)
// ────────────────────────────────────────────────────────────────

describe('listInstalledPacks', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });

  afterEach(() => {
    db.close();
  });

  it('enumerates every installed_pack row with a numeric version + optional publisher', () => {
    recordPackInventory(store, { pack_slug: 'acme.crm', publisher: 'acme', pack_version: 3, contents: [], installed_at: NOW });
    recordPackInventory(store, { pack_slug: 'recued-core.hubspot', publisher: 'recued-core', pack_version: 7, contents: [], installed_at: NOW });
    const rows = listInstalledPacks(store);
    expect(rows).toContainEqual({ pack_slug: 'acme.crm', version: 3, publisher: 'acme' });
    expect(rows).toContainEqual({ pack_slug: 'recued-core.hubspot', version: 7, publisher: 'recued-core' });
    // Version is a NUMBER (the inventory stores it as a string).
    expect(typeof rows.find((r) => r.pack_slug === 'acme.crm')!.version).toBe('number');
  });

  it('returns [] when nothing is installed', () => {
    expect(listInstalledPacks(store)).toEqual([]);
  });

  it('omits publisher when the inventory row recorded none', () => {
    recordPackInventory(store, { pack_slug: 'no-pub-pack', pack_version: 2, contents: [], installed_at: NOW });
    const row = listInstalledPacks(store).find((r) => r.pack_slug === 'no-pub-pack')!;
    expect(row).toEqual({ pack_slug: 'no-pub-pack', version: 2 });
    expect('publisher' in row).toBe(false);
  });

  it('skips a row whose stored version is not a canonical positive integer (defensive)', () => {
    recordPackInventory(store, { pack_slug: 'good-pack', pack_version: 1, contents: [], installed_at: NOW });
    // Every one of these coerces to a "valid-looking" or NaN number under a bare
    // Number()/isFinite check but is NOT a real pack version — each must be
    // skipped, never drive an upgrade compare.
    const badVersions: Record<string, string> = {
      'bad-nan': 'not-a-number', // NaN
      'bad-empty': '', // Number('') === 0 (finite!)
      'bad-space': '  ', // Number('  ') === 0
      'bad-zero': '0', // a v0 pack isn't a published version
      'bad-neg': '-1', // Number('-1') === -1 (finite)
      'bad-float': '1.5', // Number('1.5') === 1.5 (finite)
      'bad-hex': '0x10', // Number('0x10') === 16 (finite)
      'bad-pad': '03', // leading-zero non-canonical (Number('03') === 3) — not what the writer emits
    };
    for (const [slug, version] of Object.entries(badVersions)) {
      store.put('installed_pack', [slug], { pack_slug: slug, version, installed_at: NOW, ingredient_ids: [] });
    }
    const slugs = listInstalledPacks(store).map((r) => r.pack_slug);
    expect(slugs).toContain('good-pack');
    for (const bad of Object.keys(badVersions)) expect(slugs).not.toContain(bad);
  });
});

// ────────────────────────────────────────────────────────────────
// D-182 — getInstalledPack (uninstall existence proof, marketplace path)
// ────────────────────────────────────────────────────────────────

describe('getInstalledPack', () => {
  let db: Database.Database;
  let store: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  it('returns slug + version + publisher for an installed pack', () => {
    recordPackInventory(store, { pack_slug: 'acme.crm', publisher: 'acme', pack_version: 3, contents: [], installed_at: NOW });
    expect(getInstalledPack(store, 'acme.crm')).toEqual({ pack_slug: 'acme.crm', version: 3, publisher: 'acme' });
  });

  it('returns null when the pack is not installed (no inventory row)', () => {
    expect(getInstalledPack(store, 'ghost')).toBeNull();
  });

  it('omits publisher when the row recorded none', () => {
    recordPackInventory(store, { pack_slug: 'no-pub', pack_version: 1, contents: [], installed_at: NOW });
    const row = getInstalledPack(store, 'no-pub')!;
    expect(row).toEqual({ pack_slug: 'no-pub', version: 1 });
  });

  it('is LENIENT on a corrupt version — the row still EXISTS (removable), version left undefined', () => {
    // Unlike listInstalledPacks (which drops it), the uninstall existence proof
    // must survive a corrupt version so the row stays removable.
    store.put('installed_pack', ['corrupt'], { pack_slug: 'corrupt', version: '0x10', installed_at: NOW, ingredient_ids: [] });
    const row = getInstalledPack(store, 'corrupt')!;
    expect(row).not.toBeNull();
    expect(row.pack_slug).toBe('corrupt');
    expect(row.version).toBeUndefined();
  });
});
