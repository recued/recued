/** R2 build step 4c.3 + §1.6 follow-on — uninstall "this disables N recipes"
 *  disclosure tests.
 *
 *  `handlePacksUninstall` augments its success result with `would_disable` +
 *  `would_degrade`: the SURVIVING recipes that go BLOCKED / DEGRADED because
 *  uninstalling the pack removes their last provider (whole-connection vanish)
 *  or shrinks a surviving connection's grants (grant-only shrink). Computed
 *  BEFORE any mutation (the providers + grant rows must still be present).
 *
 *  The reverse-walk itself (`listRecipesWorsenedByPackUninstall` — binding
 *  derivation, registered-vendor survival, grant-shrink simulation) is
 *  unit-tested in `recipe-runnability-handler.test.ts`; THESE tests pin the
 *  HANDLER's own logic with a FAKE `computeWouldWorsen` thunk (so they're fast
 *  + deterministic):
 *    - the thunk is called ONCE with the uninstalling pack's slug, pre-mutation;
 *    - the result splits by `after` — blocked → `would_disable`, degraded →
 *      `would_degrade`;
 *    - the pack's OWN recipes (being deleted) are excluded from BOTH;
 *    - gating (absent thunk → both omitted); the disclosure does NOT require
 *      the contract store (the walk reads its own injected stores);
 *    - best-effort (a throwing thunk never aborts the uninstall);
 *    - non-empty-only (each field omitted when nothing lands in it).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  type BulkPackManifest,
  type RecipeDefinition,
  type RunnabilityTransition,
} from '@recued/contracts';

import { ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY } from '@recued/contracts';

import { handlePacksUninstall, type PackUninstallRpcDeps } from '../pack-uninstall-handler.js';
import { recordPackInventory } from '../pack-inventory.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createMcpBodyVisibilityStore } from '../storage/mcp-body-visibility-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const PACK_SLUG = 'acme-crm';

const recipeDef = (recipe_id: string): RecipeDefinition =>
  ({
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
  }) as unknown as RecipeDefinition;

const writeManifest = (packDir: string): void => {
  const manifest: BulkPackManifest = {
    manifest_version: BULK_INSTALL_PACK_VERSION,
    slug: PACK_SLUG,
    publisher: 'recued-core',
    name: 'Acme CRM',
    description: 'fixture',
    version: 1,
    recipes: [{ slug: 'acme-deal-report', version: 1 }],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: [],
  };
  writeFileSync(join(packDir, `${PACK_SLUG}.json`), JSON.stringify(manifest));
};

/** A capturing `computeWouldWorsen` fake — returns canned transitions + records
 *  the `pack_slug` it was handed (or that it was never called). */
const capturingThunk = (transitions: RunnabilityTransition[]) => {
  let received: string | 'never' = 'never';
  let calls = 0;
  return {
    fn: (pack_slug: string): RunnabilityTransition[] => {
      received = pack_slug;
      calls += 1;
      return transitions;
    },
    received: () => received,
    calls: () => calls,
  };
};

describe('4c.3 uninstall would_disable / would_degrade disclosure', () => {
  let packDir: string;
  let recipeDir: string;
  let db: Database.Database;
  let recipeStore: RecipeStore;
  let contractStore: ContractStore;

  beforeEach(() => {
    packDir = mkdtempSync(join(tmpdir(), 'would-disable-pack-'));
    recipeDir = mkdtempSync(join(tmpdir(), 'would-disable-recipes-'));
    writeManifest(packDir);
    db = new Database(':memory:');
    recipeStore = createRecipeStore(recipeDir, db);
    contractStore = createContractStore(db, { now: () => 1 });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  });
  afterEach(() => {
    db.close();
    rmSync(packDir, { recursive: true, force: true });
    rmSync(recipeDir, { recursive: true, force: true });
  });

  const baseDeps = (
    thunk?: PackUninstallRpcDeps['computeWouldWorsen'],
  ): PackUninstallRpcDeps => ({
    recipeStore,
    contractStore,
    packDir,
    ...(thunk ? { computeWouldWorsen: thunk } : {}),
  });

  const uninstall = (deps: PackUninstallRpcDeps) =>
    handlePacksUninstall(deps, { pack_slug: PACK_SLUG });

  it('discloses a surviving recipe that goes blocked; the thunk receives the pack slug', async () => {
    const t = capturingThunk([{ recipe_id: 'survivor', before: 'runnable', after: 'blocked' }]);

    const { result } = await uninstall(baseDeps(t.fn));

    expect(result.ok).toBe(true);
    expect(result.would_disable).toEqual([
      { recipe_id: 'survivor', before: 'runnable', after: 'blocked' },
    ]);
    expect(result.would_degrade).toBeUndefined();
    expect(t.received()).toBe(PACK_SLUG);
    expect(t.calls()).toBe(1);
  });

  it('splits by after: degraded survivors land on would_degrade, blocked on would_disable', async () => {
    const t = capturingThunk([
      { recipe_id: 'degrades', before: 'runnable', after: 'degraded' },
      { recipe_id: 'blocks', before: 'degraded', after: 'blocked' },
    ]);

    const { result } = await uninstall(baseDeps(t.fn));

    expect(result.would_disable).toEqual([
      { recipe_id: 'blocks', before: 'degraded', after: 'blocked' },
    ]);
    expect(result.would_degrade).toEqual([
      { recipe_id: 'degrades', before: 'runnable', after: 'degraded' },
    ]);
  });

  it('a degraded-ONLY walk emits would_degrade alone — the two gates are independent', async () => {
    const t = capturingThunk([
      { recipe_id: 'degrades', before: 'runnable', after: 'degraded' },
    ]);

    const { result } = await uninstall(baseDeps(t.fn));

    expect(result.ok).toBe(true);
    expect(result.would_disable).toBeUndefined();
    expect(result.would_degrade).toEqual([
      { recipe_id: 'degrades', before: 'runnable', after: 'degraded' },
    ]);
  });

  it("excludes the pack's OWN recipes from BOTH fields (they're deleted, not disabled)", async () => {
    // Owned recipes carry this pack's slug → listForPack returns them → they must
    // be excluded even though the (fake) reverse-walk reports them.
    recipeStore.save(recipeDef('owned-blocks'), 'recued-core', 'pair-sync', 1, PACK_SLUG);
    recipeStore.save(recipeDef('owned-degrades'), 'recued-core', 'pair-sync', 1, PACK_SLUG);
    const t = capturingThunk([
      { recipe_id: 'owned-blocks', before: 'runnable', after: 'blocked' },
      { recipe_id: 'owned-degrades', before: 'runnable', after: 'degraded' },
      { recipe_id: 'survivor', before: 'runnable', after: 'blocked' },
    ]);

    const { result } = await uninstall(baseDeps(t.fn));

    expect(result.would_disable?.map((x) => x.recipe_id)).toEqual(['survivor']);
    expect(result.would_degrade).toBeUndefined();
  });

  it('ALL transitions filter out (owned only) → BOTH omitted, NOT empty arrays', async () => {
    // Guards against gating on the thunk RAW length / emitting `would_*: []`.
    recipeStore.save(recipeDef('owned-recipe'), 'recued-core', 'pair-sync', 1, PACK_SLUG);
    const t = capturingThunk([
      { recipe_id: 'owned-recipe', before: 'runnable', after: 'blocked' },
    ]);

    const { result } = await uninstall(baseDeps(t.fn));

    expect(result.ok).toBe(true);
    expect(result.would_disable).toBeUndefined();
    expect(result.would_degrade).toBeUndefined();
  });

  it('absent computeWouldWorsen thunk → both omitted, uninstall still ok', async () => {
    const { result } = await uninstall(baseDeps());

    expect(result.ok).toBe(true);
    expect(result.would_disable).toBeUndefined();
    expect(result.would_degrade).toBeUndefined();
  });

  it('the disclosure does NOT require the contract store (the walk reads its own stores)', async () => {
    const t = capturingThunk([{ recipe_id: 'survivor', before: 'runnable', after: 'blocked' }]);

    const { result } = await uninstall({
      recipeStore,
      packDir,
      computeWouldWorsen: t.fn,
    });

    expect(result.ok).toBe(true);
    expect(result.would_disable).toEqual([
      { recipe_id: 'survivor', before: 'runnable', after: 'blocked' },
    ]);
    expect(t.received()).toBe(PACK_SLUG);
  });

  it('best-effort: a THROWING thunk is swallowed — uninstall stays ok, both omitted', async () => {
    const { result } = await uninstall(
      baseDeps(() => {
        throw new Error('store gone');
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.would_disable).toBeUndefined();
    expect(result.would_degrade).toBeUndefined();
  });

  it('thunk returns nothing → both omitted (non-empty-only)', async () => {
    const t = capturingThunk([]);

    const { result } = await uninstall(baseDeps(t.fn));

    expect(result.ok).toBe(true);
    expect(result.would_disable).toBeUndefined();
    expect(result.would_degrade).toBeUndefined();
    // The thunk WAS consulted — it just found nothing.
    expect(t.received()).toBe(PACK_SLUG);
  });

  it('a not_found uninstall carries no disclosure', async () => {
    const t = capturingThunk([{ recipe_id: 'survivor', before: 'runnable', after: 'blocked' }]);

    const { result } = await handlePacksUninstall(baseDeps(t.fn), { pack_slug: 'no-such-pack' });

    expect(result.ok).toBe(false);
    expect(result.would_disable).toBeUndefined();
    expect(result.would_degrade).toBeUndefined();
    // Manifest resolution failed before the disclosure compute — thunk untouched.
    expect(t.received()).toBe('never');
  });

  // ── D-182 — marketplace pack uninstall (no bundled manifest) ────────

  it('uninstalls a MARKETPLACE pack (inventory row, NO bundled manifest): removes its recipe + inventory AND preserves the "will stop working" disclosure', async () => {
    // A marketplace pack installed via Add-a-pack has an `installed_pack`
    // inventory row but NO bundled manifest on disk. It must still uninstall —
    // removal is slug/ownership-driven (not manifest-driven) — AND still surface
    // the disclosure for surviving dependents (the user's key requirement).
    const MP = 'acme.marketplace-crm';
    recordPackInventory(contractStore, { pack_slug: MP, publisher: 'acme', pack_version: 2, contents: [], installed_at: 1 });
    recipeStore.save(recipeDef('acme-mp-recipe'), 'acme', 'pair-sync', 1, MP); // owned by the marketplace pack
    const t = capturingThunk([{ recipe_id: 'dependent', before: 'runnable', after: 'blocked' }]);

    const { result } = await handlePacksUninstall(baseDeps(t.fn), { pack_slug: MP });

    expect(result.ok).toBe(true); // NOT not_found — the inventory row is the existence proof
    expect(result.removed.recipes).toEqual(['acme-mp-recipe']); // ownership-driven removal works sans manifest
    expect(contractStore.get('installed_pack', [MP])).toBeNull(); // inventory GC'd
    // The "removing this will disable N recipes" warning is PRESERVED for the marketplace path.
    expect(result.would_disable).toEqual([{ recipe_id: 'dependent', before: 'runnable', after: 'blocked' }]);
    expect(t.received()).toBe(MP);
  });

  it('recovers an inventory-write-FAILED marketplace install via its owned recipes (orphan) + preserves the disclosure', async () => {
    // The install path records installed_pack best-effort AFTER recipes commit,
    // so a recordPackInventory hiccup can leave recipes owned by the slug but NO
    // inventory row (and no bundled manifest). Owned recipes are the fallback
    // existence proof → the orphan stays removable, the warning still fires.
    const MP = 'acme.orphaned';
    // NO recordPackInventory — simulating the swallowed inventory-write failure.
    recipeStore.save(recipeDef('acme-orphan-recipe'), 'acme', 'pair-sync', 1, MP);
    const t = capturingThunk([{ recipe_id: 'dependent', before: 'runnable', after: 'blocked' }]);

    const { result } = await handlePacksUninstall(baseDeps(t.fn), { pack_slug: MP });

    expect(result.ok).toBe(true); // owned recipes = existence proof, NOT not_found
    expect(result.removed.recipes).toEqual(['acme-orphan-recipe']);
    expect(result.would_disable).toEqual([{ recipe_id: 'dependent', before: 'runnable', after: 'blocked' }]);
  });

  it('an ORPHANED marketplace pack with body grants gets them REVOKED on uninstall (no lingering exposure)', async () => {
    // The security edge: install persisted a body-content grant, then
    // recordPackInventory failed (swallowed) → recipes owned, NO inventory row,
    // grant still live. Uninstall via the owned-recipes proof has no publisher,
    // so the revoke must go slug-wide — else body content stays MCP-readable.
    const bodyStore = createMcpBodyVisibilityStore(db);
    const MP = 'acme.orphaned-with-grants';
    bodyStore.grant({ pack_slug: MP, publisher: 'acme', grants: [ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY], granted_at: 1 });
    recipeStore.save(recipeDef('acme-orphan-recipe'), 'acme', 'pair-sync', 1, MP);
    expect(bodyStore.isGranted(ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY)).toBe(true);

    const { result } = await handlePacksUninstall(
      { ...baseDeps(), mcpBodyVisibilityStore: bodyStore },
      { pack_slug: MP },
    );

    expect(result.ok).toBe(true);
    expect(result.removed.recipes).toEqual(['acme-orphan-recipe']);
    // The grant is GONE — no publisher was needed to close the exposure.
    expect(bodyStore.isGranted(ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY)).toBe(false);
  });

  it('a RECIPE-FREE pack whose ONLY artifact is a body grant stays uninstallable (not not_found) + revoked', async () => {
    // The narrowest orphan: a v2 composition/cli pack ships body grants but NO
    // recipes, and its inventory write failed → the body grant is the ONLY
    // durable artifact. It must be a FOURTH existence proof so uninstall revokes
    // it rather than returning not_found and stranding the exposure.
    const bodyStore = createMcpBodyVisibilityStore(db);
    const MP = 'acme.grant-only';
    bodyStore.grant({ pack_slug: MP, publisher: 'acme', grants: [ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY], granted_at: 1 });
    // NO recipes, NO recordPackInventory, NO manifest.

    const { result } = await handlePacksUninstall(
      { ...baseDeps(), mcpBodyVisibilityStore: bodyStore },
      { pack_slug: MP },
    );

    expect(result.ok).toBe(true); // body grant = existence proof, NOT not_found
    expect(result.removed.recipes).toEqual([]); // nothing there to remove
    expect(bodyStore.isGranted(ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY)).toBe(false); // exposure closed
  });

  it('uninstalls a publisher-LESS marketplace pack (no publisher to revoke by) — still ok', async () => {
    const MP = 'nopub.pack';
    recordPackInventory(contractStore, { pack_slug: MP, pack_version: 1, contents: [], installed_at: 1 });
    const { result } = await handlePacksUninstall(baseDeps(), { pack_slug: MP });
    expect(result.ok).toBe(true);
    expect(contractStore.get('installed_pack', [MP])).toBeNull();
  });

  it('still not_found when NEITHER a bundled manifest NOR an inventory row exists', async () => {
    // The widened gate accepts an inventory row as the existence proof, but a
    // genuinely-absent pack (no manifest, no inventory) must still fail closed.
    const t = capturingThunk([{ recipe_id: 'x', before: 'runnable', after: 'blocked' }]);
    const { result } = await handlePacksUninstall(baseDeps(t.fn), { pack_slug: 'ghost.pack' });
    expect(result.ok).toBe(false);
    expect(result.would_disable).toBeUndefined();
    expect(t.received()).toBe('never'); // gated out before the disclosure compute
  });

  it('the walk runs BEFORE the uninstall transaction (bindings/grants still present at thunk time)', async () => {
    // The REAL walk reads this pack's binding + grant rows inside the thunk, so
    // the handler must invoke it while they still exist. A real-read thunk pins
    // the ordering: it reports a transition ONLY if the pack's binding rows are
    // still present when called — moving the disclosure compute after the
    // contract-store transaction would see zero bindings → empty disclosure.
    const bindings = createConnectionCatalogBindingStore(contractStore);
    bindings.bind('acme-conn', 'acme-cat', PACK_SLUG);
    const thunk = (slug: string): RunnabilityTransition[] =>
      bindings.list().some((b) => b.installed_pack_id === slug)
        ? [{ recipe_id: 'survivor', before: 'runnable', after: 'blocked' }]
        : [];

    const { result } = await uninstall(baseDeps(thunk));

    expect(result.ok).toBe(true);
    expect(result.would_disable).toEqual([
      { recipe_id: 'survivor', before: 'runnable', after: 'blocked' },
    ]);
    // …and the transaction DID drop the binding afterwards.
    expect(bindings.resolveCatalogSlug('acme-conn')).toBeUndefined();
  });
});
