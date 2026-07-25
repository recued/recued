/** D-145 PA10 follow-on Slice B — `packs.uninstall` rpc handler + composer.
 *
 *  Exercises the uninstall counterpart to `packs.install`:
 *    - bad_request when args missing / pack_slug not a string / pack_slug
 *      empty or whitespace-only (belt-and-suspenders for the substrate's
 *      empty-prefix guard that would otherwise raise an unrelated error).
 *    - not_found when the bundled manifest doesn't exist.
 *    - ok with empty `removed` counts when nothing was installed (idempotent
 *      uninstall of an already-uninstalled pack).
 *    - Recipes drop one per manifest entry via `recipeStore.delete()`;
 *      `removed.recipes` reports only IDs the store actually deleted
 *      (already-gone recipes do not appear).
 *    - Body-grants (D-139 P6.B): with a `mcpBodyVisibilityStore` wired,
 *      uninstall revokes the pack's body grants + reports them in
 *      `removed.body_grants`; absent store ⇒ `[]` (opt-in, symmetric with
 *      install).
 *    - unexpected when `recipeStore.delete` throws mid-loop (partial
 *      `removed.recipes` reflects the IDs already deleted before the
 *      throw).
 *    - Composer returns undefined-bundle when recipeStore absent.
 *    - `makePackUninstallHandlers(undefined)` returns undefined so the
 *      rpc surfaces `not_configured`.
 *    - Slice returns `packs.uninstall` when deps are wired.
 *
 *  Cross-cutting invariants exercised:
 *    - `packs.` reserved-prefix gate is asserted by the D-138 ratchet
 *      test (covers `packs.uninstall` automatically).
 *    - Recipe uninstall is the v1 limited form: re-reads the bundled
 *      manifest's recipes[] (drift caveat documented in the handler). */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';

import { composePackUninstallRpcDeps } from '../composition/bin/wire-pack-uninstall-rpc-deps.js';
import {
  handlePacksUninstall,
  makePackUninstallHandlers,
} from '../pack-uninstall-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import {
  createMcpBodyVisibilityStore,
  type McpBodyVisibilityStore,
} from '../storage/mcp-body-visibility-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
} from '../storage/chat-inbound-token-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding (mirrors d-145-pa10-pack-list-rpc.test.ts so the two
// rpcs' tests evolve in lock-step)
// ────────────────────────────────────────────────────────────────

let recipeDir: string;
let packDir: string;
let db: Database.Database;
let recipeStore: RecipeStore;
let bodyStore: McpBodyVisibilityStore;

const recipeDef = (recipe_id: string, version = 1): RecipeDefinition => ({
  recipe_id,
  version,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'd-145 pack-uninstall rpc test fixture',
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

/** Simulate a prior install by saving recipe rows the way the engine
 *  would have. The store handle is the same per-pair handle the live
 *  `installBulkPackOnServer` writes against, so the test exercises real
 *  persistence + the handler's delete loop together.
 *
 *  D-145 PA10 follow-on (pack-install-registry) — stamps `pack_slug`
 *  on each recipe row so the pack-aware uninstall path's
 *  `listForPack(slug)` resolves the right ids. Without this, the
 *  uninstall handler would correctly report `removed.recipes = []` —
 *  but that's the no-prior-install case, not the prior-install case
 *  the test is exercising. */
const simulateInstall = (manifest: BulkPackManifest): void => {
  for (const ref of manifest.recipes) {
    recipeStore.save(
      recipeDef(ref.slug, ref.version),
      manifest.publisher,
      'pair-sync',
      Date.now(),
      manifest.slug,
    );
  }
};

beforeEach(() => {
  recipeDir = mkdtempSync(join(tmpdir(), 'recued-d145-pack-uninstall-rpc-recipes-'));
  packDir = mkdtempSync(join(tmpdir(), 'recued-d145-pack-uninstall-rpc-packs-'));
  db = new Database(':memory:');
  writeBundledRecipe('alpha-recipe');
  writeBundledRecipe('beta-recipe');
  writeBundledRecipe('gamma-recipe');
  recipeStore = createRecipeStore(recipeDir, db);
  bodyStore = createMcpBodyVisibilityStore(db);
});

afterEach(() => {
  db.close();
  rmSync(recipeDir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
// Argument validation (bad_request branch)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — handlePacksUninstall args', () => {
  it('raises bad_request when args is null', async () => {
    await expect(
      handlePacksUninstall(
        { recipeStore, packDir },
        null as never,
      ),
    ).rejects.toThrow(/args required/);
  });

  it('raises bad_request when pack_slug is missing', async () => {
    await expect(
      handlePacksUninstall(
        { recipeStore, packDir },
        {} as never,
      ),
    ).rejects.toThrow(/pack_slug must be a string/);
  });

  it('raises bad_request when pack_slug is not a string', async () => {
    await expect(
      handlePacksUninstall(
        { recipeStore, packDir },
        { pack_slug: 42 as unknown as string },
      ),
    ).rejects.toThrow(/pack_slug must be a string/);
  });

  it('raises bad_request when pack_slug is empty', async () => {
    await expect(
      handlePacksUninstall(
        { recipeStore, packDir },
        { pack_slug: '' },
      ),
    ).rejects.toThrow(/non-empty/);
  });

  it('raises bad_request when pack_slug is whitespace-only', async () => {
    // Belt-and-suspenders: an empty / whitespace-only slug would
    // otherwise resolve to a confusing substrate error rather than the
    // clean `bad_request` users expect.
    await expect(
      handlePacksUninstall(
        { recipeStore, packDir },
        { pack_slug: '   ' },
      ),
    ).rejects.toThrow(/non-empty/);
  });
});

// ══════════════════════════════════════════════════════════════════
// not_found branch
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — handlePacksUninstall not_found', () => {
  it('returns ok=false with not_found when packDir is missing', async () => {
    rmSync(packDir, { recursive: true, force: true });
    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'nonexistent-pack' },
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.failure?.code).toBe('not_found');
    expect(result.result.removed).toEqual({
      recipes: [],
      body_grants: [],
    });
  });

  it('returns ok=false with not_found when slug matches no manifest', async () => {
    writeManifest('other-pack', baseManifest({ slug: 'other-pack' }));
    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'missing-pack' },
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.failure?.code).toBe('not_found');
    // Failure message echoes the queried slug so the UI can render
    // targeted copy without re-resolving server-side.
    expect(result.result.failure?.message).toContain('missing-pack');
  });

  it('drops invalid manifests during the scan + treats slug as not_found', async () => {
    // Codex review angle (correctness): a broken JSON file in the
    // pack dir must not prevent legitimate matches; the scan continues
    // past parse failures + validator rejections.
    writeFileSync(join(packDir, 'broken.json'), '{not json');
    writeFileSync(
      join(packDir, 'invalid.json'),
      JSON.stringify({ slug: 'invalid', manifest_version: 1 }), // missing fields
    );
    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'invalid' },
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.failure?.code).toBe('not_found');
  });
});

// ══════════════════════════════════════════════════════════════════
// Successful uninstall — happy path + idempotency
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — handlePacksUninstall happy path', () => {
  it('returns ok=true with empty removed counts when nothing was installed', async () => {
    // Idempotent uninstall: bundled manifest exists but the install
    // transaction never ran. The handler still resolves the manifest
    // + walks the recipe list (each delete returns false because the
    // SQLite row never existed).
    writeManifest('idle-pack', baseManifest({ slug: 'idle-pack' }));
    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'idle-pack' },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.recipes).toEqual([]);
    expect(result.result.removed.body_grants).toEqual([]);
  });

  it('drops the recipes that were actually installed', async () => {
    const manifest = baseManifest({
      slug: 'full-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    writeManifest('full-pack', manifest);
    simulateInstall(manifest);

    // Pre-check: install actually landed.
    expect(recipeStore.getStored('alpha-recipe')).not.toBeNull();
    expect(recipeStore.getStored('beta-recipe')).not.toBeNull();

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'full-pack' },
    );
    expect(result.result.ok).toBe(true);
    expect([...result.result.removed.recipes].sort()).toEqual([
      'alpha-recipe',
      'beta-recipe',
    ]);
    expect(result.result.removed.body_grants).toEqual([]);

    // Post-check: substrate state actually changed.
    expect(recipeStore.getStored('alpha-recipe')).toBeNull();
    expect(recipeStore.getStored('beta-recipe')).toBeNull();
  });

  it('removes pack grants from an existing customer bearer snapshot', async () => {
    const now = 1_700_000_000_000;
    const manifest = baseManifest({ slug: 'customer-rollout-pack' });
    writeManifest(manifest.slug, manifest);
    simulateInstall(manifest);
    const contractStore = createContractStore(db, { now: () => now });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    const definitionStore = createContractDefinitionStore(contractStore, {
      now: () => now,
      newId: () => 'ct_customer_rollout',
    });
    const contractId = definitionStore.mint({
      minted_by: 'user:1',
      display_name: 'Customer rollout',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    }).contract_id;
    const definition = definitionStore.get(contractId);
    if (definition === null) throw new Error('missing customer rollout fixture');
    contractStore.put(CONTRACT_DEFINITION_SCOPE, [contractId], {
      ...definition,
      grant_kind: 'customer_instance',
    });
    const grantEntryStore = createContractGrantEntryStore(contractStore);
    grantEntryStore.set(contractId, 'core.existing', true, now);
    grantEntryStore.set(
      contractId,
      'recued-core/alpha-recipe',
      true,
      now,
      manifest.slug,
    );
    ensureChatInboundTokenSchema(db);
    const inboundTokenStore = createChatInboundTokenStore(db);
    const issued = inboundTokenStore.issueToken({
      value: {
        label: 'Customer rollout token',
        peer_handle: 'customer:rollout',
        grants: {
          'core.existing': true,
          'recued-core/alpha-recipe': true,
        },
        concurrency_tier: 3,
        expires_at: 0,
        chat_mode: null,
        contract_id: contractId,
      },
      now,
    });

    const result = await handlePacksUninstall(
      {
        recipeStore,
        packDir,
        contractStore,
        inboundTokenStore,
        sellerStore: {
          listCustomers: () => [{
            contract_id: contractId,
            tier_id: 'tier-pro',
            inbound_token_id: issued.record.token_id,
            mcp_token_id: issued.record.token_id,
          }],
        },
        now: () => now + 1,
      },
      { pack_slug: manifest.slug },
    );

    expect(result.result.ok).toBe(true);
    expect(grantEntryStore.listForContract(contractId)).toEqual([{
      entry_key: 'core.existing',
      granted: true,
      set_at: now,
    }]);
    expect(inboundTokenStore.getTokenById(issued.record.token_id)?.grants).toEqual({
      'core.existing': true,
    });
  });

  it('reports only IDs the store actually deleted (already-gone recipes skipped)', async () => {
    const manifest = baseManifest({
      slug: 'partial-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    writeManifest('partial-pack', manifest);
    simulateInstall(manifest);
    // Concurrent uninstall: another tab dropped beta-recipe between
    // install + this uninstall call. Handler must report only the
    // ID it actually removed.
    recipeStore.delete('beta-recipe');

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'partial-pack' },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.recipes).toEqual(['alpha-recipe']);
  });

  it('drops ONLY recipes from this pack — sibling pack recipes are untouched', async () => {
    // Codex MAJOR review angle (concurrent-tab semantics): the recipe
    // uninstall is keyed on `pack_slug` ownership. A second pack must
    // survive the uninstall.
    const packA = baseManifest({
      slug: 'pack-a',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    const packB = baseManifest({
      slug: 'pack-b',
      recipes: [{ slug: 'beta-recipe', version: 1 }],
    });
    writeManifest('pack-a', packA);
    writeManifest('pack-b', packB);
    simulateInstall(packA);
    simulateInstall(packB);

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'pack-a' },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.recipes).toEqual(['alpha-recipe']);

    // pack-b's recipe must survive.
    expect(recipeStore.getStored('beta-recipe')).not.toBeNull();
  });

  it('body_grants is always [] (forward-compat slot — server bin does not wire body grants today)', async () => {
    // The engine's `grantBodyVisibility` callback is unwired in
    // `install-bulk-pack-handler.ts`, so install never persists body
    // grants + uninstall has nothing to revoke. The result shape
    // reserves the field; this test pins the v1 behavior so a future
    // wiring lands behind a deliberate test update.
    const manifest = baseManifest({
      slug: 'body-grants-pack',
      mcp_body_visibility_grants: ['data.contact.engagements.body_content'],
    });
    writeManifest('body-grants-pack', manifest);
    simulateInstall(manifest);

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'body-grants-pack' },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.body_grants).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// Pack-install-registry — pack-aware uninstall (closes Slice B's
// Codex MAJOR 2 v1 limitation). Recipes are dropped by pack_slug
// column match, not by manifest reference — pre-existing rows +
// cross-pack rows + drift recipes are all handled correctly.
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on (pack-install-registry) — uninstall respects pack_slug ownership', () => {
  it('does NOT delete a pre-existing manually-saved recipe whose slug matches the manifest', async () => {
    // Recipe is saved WITHOUT a pack_slug (the mcp-server-style path or
    // a power-user manual install) — pack_slug column lands NULL. The
    // pack's manifest mentions the same slug, but the row was never
    // claimed by this pack. Uninstall must leave the manual row alone.
    const manifest = baseManifest({
      slug: 'preexisting-clash-pack',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    writeManifest('preexisting-clash-pack', manifest);
    // Manual save — no pack_slug parameter.
    recipeStore.save(
      recipeDef('alpha-recipe'),
      'manual-author',
      'pair-sync',
      Date.now(),
    );
    // Pre-check: the row exists with pack_slug NULL.
    const beforeRow = recipeStore.getStored('alpha-recipe');
    expect(beforeRow).not.toBeNull();
    expect(beforeRow?.pack_slug).toBeNull();

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'preexisting-clash-pack' },
    );
    expect(result.result.ok).toBe(true);
    // Pack didn't own the row, so removed.recipes is empty.
    expect(result.result.removed.recipes).toEqual([]);
    // Row survives intact.
    expect(recipeStore.getStored('alpha-recipe')).not.toBeNull();
  });

  it('does NOT delete a recipe whose slug collides with the manifest but is owned by a different pack', async () => {
    // Pack A installed `shared-recipe` originally. Pack B then
    // re-installed the same slug — the upsert overwrites the row +
    // the wrapper stamps `pack_slug = 'pack-b'`. Uninstalling pack A
    // walks `listForPack('pack-a')` which returns [] (no rows pack-A
    // owns anymore). `shared-recipe` survives, still owned by pack B.
    const packA = baseManifest({
      slug: 'pack-a',
      recipes: [{ slug: 'shared-recipe', version: 1 }],
    });
    const packB = baseManifest({
      slug: 'pack-b',
      recipes: [{ slug: 'shared-recipe', version: 1 }],
    });
    writeManifest('pack-a', packA);
    writeManifest('pack-b', packB);
    simulateInstall(packA);
    simulateInstall(packB); // overwrites: ownership now pack-b
    expect(recipeStore.getStored('shared-recipe')?.pack_slug).toBe('pack-b');

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'pack-a' },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.recipes).toEqual([]);
    // The row is still there, still owned by pack-b.
    const surviving = recipeStore.getStored('shared-recipe');
    expect(surviving).not.toBeNull();
    expect(surviving?.pack_slug).toBe('pack-b');
  });

  it('drops drift recipes — pack-owned at v1 but missing from v2 manifest still uninstall', async () => {
    // Pack ships `[alpha, legacy]` at v1. Manifest on disk is later
    // bumped to v2 with `[alpha, fresh]`. `simulateInstall(v1)` stamps
    // pack_slug on both alpha + legacy. The handler reads v2's
    // manifest (for the not_found gate + SI prefix) but the recipe
    // step uses `listForPack` so the orphaned `legacy` row also
    // drops — closing the cross-version-drift v1 limitation.
    const v1 = baseManifest({
      slug: 'drift-recipes-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    simulateInstall(v1);
    // Manifest on disk reflects v2 — only alpha-recipe is named.
    const v2 = baseManifest({
      slug: 'drift-recipes-pack',
      version: 2,
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    writeManifest('drift-recipes-pack', v2);

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'drift-recipes-pack' },
    );
    expect(result.result.ok).toBe(true);
    // Both ids in removed.recipes — even beta which v2's manifest
    // never declared. Order is deterministic per listForPack's
    // ORDER BY recipe_id ASC.
    expect(result.result.removed.recipes).toEqual([
      'alpha-recipe',
      'beta-recipe',
    ]);
    expect(recipeStore.getStored('alpha-recipe')).toBeNull();
    expect(recipeStore.getStored('beta-recipe')).toBeNull();
  });

  it('does NOT delete cross-pack recipes when their slug is unrelated to this pack', async () => {
    // Two packs with disjoint recipe sets. Uninstall pack-a; pack-b's
    // recipes must survive. This was already exercised in the
    // "drops ONLY rows from this pack" test (line ~367) but pinning
    // it here against the pack-aware path keeps the regression net
    // tight if the listForPack implementation drifts.
    const packA = baseManifest({
      slug: 'unrelated-a',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    const packB = baseManifest({
      slug: 'unrelated-b',
      recipes: [{ slug: 'beta-recipe', version: 1 }],
    });
    writeManifest('unrelated-a', packA);
    writeManifest('unrelated-b', packB);
    simulateInstall(packA);
    simulateInstall(packB);

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: 'unrelated-a' },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.recipes).toEqual(['alpha-recipe']);
    // Pack-b's row survives + its pack_slug stays intact.
    const survivor = recipeStore.getStored('beta-recipe');
    expect(survivor).not.toBeNull();
    expect(survivor?.pack_slug).toBe('unrelated-b');
  });

  it('surfaces unexpected when recipeStore.listForPack throws', async () => {
    // listForPack drives the recipe-delete loop — if it throws, the
    // handler surfaces `unexpected` and `removed.recipes` stays empty.
    const manifest = baseManifest({
      slug: 'listforpack-throws',
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
    });
    writeManifest('listforpack-throws', manifest);
    simulateInstall(manifest);

    const throwingStore = {
      ...recipeStore,
      listForPack: () => {
        throw new Error('listForPack boom');
      },
    } as unknown as RecipeStore;

    const result = await handlePacksUninstall(
      {
        recipeStore: throwingStore,
        packDir,
      },
      { pack_slug: 'listforpack-throws' },
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.failure?.code).toBe('unexpected');
    expect(result.result.failure?.message).toContain('listForPack boom');
    expect(result.result.removed.recipes).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// unexpected branch (substrate throws)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — handlePacksUninstall unexpected', () => {
  it('surfaces unexpected when recipeStore.delete throws + reports partial state', async () => {
    const manifest = baseManifest({
      slug: 'throwing-recipe-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
        { slug: 'gamma-recipe', version: 1 },
      ],
    });
    writeManifest('throwing-recipe-pack', manifest);
    simulateInstall(manifest);

    // Wrap the store so beta-recipe throws; alpha precedes (succeeds),
    // gamma follows (never reached). The result must report alpha as
    // removed but neither beta nor gamma.
    let calls = 0;
    const throwingStore = {
      ...recipeStore,
      delete: (id: string): boolean => {
        calls += 1;
        if (id === 'beta-recipe') throw new Error('recipe store boom');
        return recipeStore.delete(id);
      },
    } as unknown as RecipeStore;

    const result = await handlePacksUninstall(
      {
        recipeStore: throwingStore,
        packDir,
      },
      { pack_slug: 'throwing-recipe-pack' },
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.failure?.code).toBe('unexpected');
    expect(result.result.failure?.message).toContain('beta-recipe');
    expect(result.result.failure?.message).toContain('recipe store boom');
    // alpha-recipe was deleted before the throw; gamma never reached.
    expect(result.result.removed.recipes).toEqual(['alpha-recipe']);
    // Recipe loop stopped at beta — only two delete calls fired.
    expect(calls).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
// Composer
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — composePackUninstallRpcDeps', () => {
  it('returns undefined bundle when recipeStore is absent', () => {
    const bundle = composePackUninstallRpcDeps({
      recipeStore: undefined,
    });
    expect(bundle.packUninstallDeps).toBeUndefined();
  });

  it('returns wired bundle when recipeStore is present', () => {
    const bundle = composePackUninstallRpcDeps({
      recipeStore,
    });
    expect(bundle.packUninstallDeps).toBeDefined();
    expect(bundle.packUninstallDeps!.recipeStore).toBe(recipeStore);
  });

  it('threads customer grant-snapshot cleanup stores', () => {
    const sellerStore = { listCustomers: () => [] };
    const inboundTokenStore = {
      getTokenById: () => null,
      updateTokenGrants: () => null,
    };
    const bundle = composePackUninstallRpcDeps({
      recipeStore,
      sellerStore,
      inboundTokenStore,
    });
    expect(bundle.packUninstallDeps?.sellerStore).toBe(sellerStore);
    expect(bundle.packUninstallDeps?.inboundTokenStore).toBe(inboundTokenStore);
  });

  it('forwards packDir override when present', () => {
    const bundle = composePackUninstallRpcDeps({
      recipeStore,
      packDir,
    });
    expect(bundle.packUninstallDeps!.packDir).toBe(packDir);
  });

  it('omits packDir from the bundle when not supplied', () => {
    const bundle = composePackUninstallRpcDeps({
      recipeStore,
    });
    expect('packDir' in (bundle.packUninstallDeps ?? {})).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// Handler factory
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — makePackUninstallHandlers', () => {
  it('returns undefined when deps are undefined', () => {
    expect(makePackUninstallHandlers(undefined)).toBeUndefined();
  });

  it('returns a slice with packs.uninstall when deps are wired', () => {
    const slice = makePackUninstallHandlers({
      recipeStore,
      packDir,
    });
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual(['packs.uninstall']);
    expect(typeof slice!.handlers['packs.uninstall']).toBe('function');
  });

  it('factory handler delegates to handlePacksUninstall', async () => {
    writeManifest(
      'factory-test-pack',
      baseManifest({ slug: 'factory-test-pack' }),
    );
    const slice = makePackUninstallHandlers({
      recipeStore,
      packDir,
    });
    const result = await slice!.handlers['packs.uninstall'](
      { pack_slug: 'factory-test-pack' },
      // The wired dispatcher provides a client context; the handler
      // ignores it for this rpc (uninstall is per-pair-only with no
      // client-specific gating beyond the reserved-prefix channel
      // check). Pass a minimal stub.
      {} as never,
    );
    expect(result.result.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// D-139 P6.B — body-content visibility grant revoke on uninstall
// ══════════════════════════════════════════════════════════════════

describe('D-139 P6.B — handlePacksUninstall body-grant revoke', () => {
  const KEY = ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY;
  const slug = 'crm-commitment-tracker';

  it('revokes the pack body grants + reports them in removed.body_grants', async () => {
    const manifest = baseManifest({
      slug,
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
      mcp_body_visibility_grants: [KEY],
    });
    writeManifest(slug, manifest);
    simulateInstall(manifest);
    // Simulate the prior install having persisted the body grant.
    bodyStore.grant({ pack_slug: slug, publisher: manifest.publisher, grants: [KEY], granted_at: 1 });
    expect(bodyStore.isGranted(KEY)).toBe(true);

    const result = await handlePacksUninstall(
      { recipeStore, mcpBodyVisibilityStore: bodyStore, packDir },
      { pack_slug: slug },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.body_grants).toEqual([KEY]);
    expect(bodyStore.isGranted(KEY)).toBe(false);
  });

  it('absent body store ⇒ body_grants stays [] (symmetric with install opt-in)', async () => {
    const manifest = baseManifest({
      slug,
      recipes: [{ slug: 'alpha-recipe', version: 1 }],
      mcp_body_visibility_grants: [KEY],
    });
    writeManifest(slug, manifest);
    simulateInstall(manifest);

    const result = await handlePacksUninstall(
      { recipeStore, packDir },
      { pack_slug: slug },
    );
    expect(result.result.ok).toBe(true);
    expect(result.result.removed.body_grants).toEqual([]);
  });
});
