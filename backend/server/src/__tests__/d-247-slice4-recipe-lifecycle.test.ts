/** D-247 slice 4 — a pack-owned row is the pack's to change.
 *
 *  One rule, two sides: `save` may not strip pack ownership (D6), `recipe.delete`
 *  may not remove a pack-owned recipe (D14.1).
 *
 *  ⛔⛔ THE GUARD IS TESTED AT THE STORE, NOT AT A HANDLER, BECAUSE THE HANDLERS
 *  HAVE ALREADY DIVERGED TWICE. `recipe.save` refuses a pack-owned WEBHOOK
 *  recipe; `recued_saveRecipe` has no ownership check at all;
 *  `recipe.installBySlug` mirrors neither. A store-level test is the only one that
 *  covers the writer nobody remembered — including the next one. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecipeDefinition } from '@recued/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRecipeStore, RecipePackOwnershipError } from '../recipe-store.js';
import { deleteRecipe } from '../recipe-delete-handler.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_750_000_000_000;
const PACK = 'fleet-money';

const recipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: recipe_id, description: 'd-247 lifecycle fixture', author: 'recued-core',
    supported_platforms: ['test'], tags: ['test'],
  },
  variables: {}, prefetch_steps: [], steps: [], output: { sidebar: [] },
});

describe('D-247 D6 — save may not strip pack ownership', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createRecipeStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd247-lifecycle-'));
    db = new Database(':memory:');
    store = createRecipeStore(dir, db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('refuses an inline save over a pack-owned recipe, naming the pack', () => {
    store.save(recipe('chase'), 'recued-core', 'pair-sync', NOW, PACK);
    // The `'inline'` path passes NO pack_slug, which the store writes as null —
    // that is the silent ownership strip this guard exists to stop.
    let err: unknown;
    try { store.save(recipe('chase'), 'kitchen', 'inline', NOW); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RecipePackOwnershipError);
    // The pack must be NAMED: "no" is not an actionable refusal.
    expect((err as RecipePackOwnershipError).pack_slug).toBe(PACK);
  });

  it('leaves the row intact after the refusal — no partial write', () => {
    store.save(recipe('chase'), 'recued-core', 'pair-sync', NOW, PACK);
    try { store.save(recipe('chase'), 'kitchen', 'inline', NOW); } catch { /* expected */ }
    expect(store.getStored('chase')?.pack_slug).toBe(PACK);
    expect(store.getStored('chase')?.publisher_id).toBe('recued-core');
  });

  it('ALLOWS a pack UPDATE — non-null to non-null is not a strip', () => {
    // The path that must keep working: `packs.install` over an installed pack
    // re-records every ref with an explicit slug.
    store.save(recipe('chase'), 'recued-core', 'pair-sync', NOW, PACK);
    expect(() => store.save(recipe('chase'), 'recued-core', 'pair-sync', NOW, PACK)).not.toThrow();
  });

  it('ALLOWS a first save with no prior row, and a plain local re-save', () => {
    expect(() => store.save(recipe('mine'), 'kitchen', 'inline', NOW)).not.toThrow();
    expect(() => store.save(recipe('mine'), 'kitchen', 'inline', NOW)).not.toThrow();
    expect(store.getStored('mine')?.pack_slug ?? null).toBeNull();
  });
});

describe('D-247 D14.1 — recipe.delete', () => {
  let dir: string;
  let db: Database.Database;
  let store: ReturnType<typeof createRecipeStore>;
  let contractStore: ReturnType<typeof createContractStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd247-delete-'));
    db = new Database(':memory:');
    store = createRecipeStore(dir, db);
    contractStore = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  /** Write the `installed_pack` row directly, in the exact shape
   *  `getInstalledPack` reads. Going through `recordPackInventory` would drag in
   *  the ingredient-inventory fan-out this test says nothing about. */
  const installPack = () =>
    contractStore.put('installed_pack', [PACK], {
      pack_slug: PACK, publisher: 'recued-core', version: '1',
      installed_at: NOW, ingredient_ids: [],
    });

  it('deletes an owner-authored recipe', () => {
    store.save(recipe('mine'), 'kitchen', 'inline', NOW);
    expect(deleteRecipe({ store, contractStore }, 'mine')).toEqual({ deleted: true });
    expect(store.get('mine')).toBeNull();
  });

  it('REFUSES a pack-owned recipe while its pack is installed, naming the pack', () => {
    installPack();
    store.save(recipe('chase'), 'recued-core', 'pair-sync', NOW, PACK);
    expect(deleteRecipe({ store, contractStore }, 'chase'))
      .toEqual({ deleted: false, reason: 'pack_owned', pack_slug: PACK });
    expect(store.get('chase')).not.toBeNull();
  });

  it('⛔ THE ESCAPE: deletes when the pack_slug names a pack that is NOT installed', () => {
    // The case a `pack_slug`-only guard strands FOREVER — there is no second
    // path, because you cannot uninstall a pack that is not installed. Every
    // test anyone would naturally write passes without this one.
    store.save(recipe('orphan'), 'recued-core', 'pair-sync', NOW, PACK);
    expect(deleteRecipe({ store, contractStore }, 'orphan')).toEqual({ deleted: true });
    expect(store.get('orphan')).toBeNull();
  });

  it('⛔ refuses a stored row that SHADOWS a bundled recipe (Codex finding 6)', () => {
    // Dropping the row would leave `store.get` resolving the bundled copy, so the
    // recipe stays reachable while the caller was told it was deleted — and no
    // later call can remove it, because the next attempt sees no row and answers
    // `bundled` anyway. Same principle as the pack refusal: a control that does
    // not durably do what the owner asked is worse than an absent one.
    // ⚠ A REAL bundled recipe (a file the store loads from its community dir),
    // not `register` — that writes `memoryOverrides`, which has NO production
    // caller, so a fixture built on it would prove nothing about the shipped
    // path. `getBundled` is the predicate production actually has.
    const bundleDir = mkdtempSync(join(tmpdir(), 'd247-bundle-'));
    writeFileSync(join(bundleDir, 'shadowed.json'), JSON.stringify(recipe('shadowed')));
    const bdb = new Database(':memory:');
    const shadowStore = createRecipeStore(bundleDir, bdb);
    expect(shadowStore.getBundled('shadowed')).not.toBeNull();
    shadowStore.save(recipe('shadowed'), 'kitchen', 'inline', NOW);
    expect(deleteRecipe({ store: shadowStore, contractStore }, 'shadowed'))
      .toEqual({ deleted: false, reason: 'bundled' });
    expect(shadowStore.get('shadowed')).not.toBeNull();
    bdb.close();
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it('distinguishes BUNDLED from NOT_FOUND — a boolean cannot', () => {
    store.register(recipe('bundled-one'));   // resolves, but has no SQLite row
    expect(deleteRecipe({ store, contractStore }, 'bundled-one'))
      .toEqual({ deleted: false, reason: 'bundled' });
    expect(deleteRecipe({ store, contractStore }, 'never-existed'))
      .toEqual({ deleted: false, reason: 'not_found' });
    // …and the bundled recipe is still resolvable, which is why `false` alone lies.
    expect(store.get('bundled-one')).not.toBeNull();
  });

  it('fails CLOSED on a pack-owned recipe when the pack inventory is unavailable', () => {
    store.save(recipe('chase'), 'recued-core', 'pair-sync', NOW, PACK);
    expect(deleteRecipe({ store }, 'chase'))
      .toEqual({ deleted: false, reason: 'pack_owned', pack_slug: PACK });
  });

  it('tears down the webhook consumer BEFORE dropping the row', () => {
    // A delete is the uninstall teardown for one recipe. Without this the
    // consumer stays bound to a recipe that no longer exists — the same orphan
    // class as the grant row this decision is about.
    const replaceConsumer = vi.fn();
    store.save(recipe('hooked'), 'kitchen', 'inline', NOW);
    const r = deleteRecipe(
      { store, contractStore, webhookConsumerStore: { replaceConsumer } as never },
      'hooked',
    );
    expect(r).toEqual({ deleted: true });
    expect(replaceConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ consumer_kind: 'local_recipe', consumer_id: 'hooked', enabled: false }),
    );
  });
});
