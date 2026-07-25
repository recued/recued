/** Install seam 5c — `packs.installBySlug` + `recipe.installBySlug` handlers.
 *
 *  The keystone both apex entry points need: install a marketplace pack /
 *  recipe BY SLUG. These tests exercise the marketplace-fetch path with an
 *  injected mock `marketplaceFetch` (no network) against a real in-memory
 *  `RecipeStore`:
 *
 *    - `installPackBySlug` fetches the manifest, resolves each constituent
 *      recipe from the marketplace (NOT bundled on disk), and reuses the
 *      EXISTING `handlePacksInstall` transaction verbatim.
 *    - The resolved recipe preserves the marketplace recipe row's authoritative
 *      `publisher_id`; a containing pack cannot relabel a cross-publisher recipe.
 *    - The by-VALUE `packs.install` stays bundled-only (no resolver) — a
 *      non-bundled recipe resolves as `not_found` (behaviour UNCHANGED).
 *    - Marketplace 404 / fetch-error / validation surface as `ok: false`
 *      result-body failures; only arg-shape problems throw `bad_request`.
 *    - `recipe.installBySlug` fetches one recipe, validates it, and persists
 *      it with the MARKETPLACE-authoritative publisher_id + `'pair-sync'`
 *      source. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  RpcError,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';
import type { MarketplaceRecipeResult } from '@recued/marketplace';

import {
  handlePacksInstall,
  installPackBySlug,
  installRecipeBySlug,
  resolvePackBySlug,
} from '../pack-install-handler.js';
import { recordPackInventory } from '../pack-inventory.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

/** A valid, transform-only recipe (parses with no error-severity issues —
 *  modelled on the recipe-save-handler `validRecipe`). */
const recipeDef = (recipe_id: string): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 300,
    metadata: {
      name: `Name of ${recipe_id}`,
      description: 'install-seam-5c fixture',
      author: 'recued-core',
      supported_platforms: ['test'],
      tags: ['test', 'fixture', 'transform'],
    },
    variables: {
      greeting: { type: 'string', default: '', label: 'Greeting' },
    },
    steps: [
      {
        id: 'has_greeting',
        transform: 'compare',
        left: '{{config.greeting}}',
        operator: 'is_not_empty',
      },
    ],
    output: { sidebar: [{ type: 'summary', source: 'step.has_greeting' }] },
  }) as unknown as RecipeDefinition;

/** An invalid recipe — a step missing the required `id` (parseRecipe surfaces
 *  an error-severity issue, so it never persists). */
const invalidRecipeDef = (recipe_id: string): RecipeDefinition =>
  ({
    ...(recipeDef(recipe_id) as unknown as Record<string, unknown>),
    steps: [{ transform: 'compare', left: '{{config.greeting}}', operator: 'is_not_empty' }],
  }) as unknown as RecipeDefinition;

/** Build the `{ recipe_id, publisher_id, version, recipe_hash, recipe }` row
 *  the marketplace returns. `publisher_id` is set distinct from the recipe's
 *  `metadata.author` so the publisher-stamping assertions can tell them apart
 *  (the fixture-value-coincidence lesson). */
const marketplaceRow = (
  recipe_id: string,
  publisher_id: string,
  recipe: RecipeDefinition = recipeDef(recipe_id),
): MarketplaceRecipeResult => ({
  recipe_id,
  publisher_id,
  version: recipe.version ?? 1,
  recipe_hash: 'sha256:fixture',
  recipe,
});

const baseManifest = (overrides: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'remote-pack',
  publisher: 'recued-core',
  name: 'install-seam-5c remote pack',
  description: 'fixture',
  version: 1,
  recipes: [{ slug: 'remote-recipe', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  ...overrides,
});

/** A JSON-ish Response stand-in (avoids depending on a global `Response`).
 *  Covers the fields `fetchBulkPackBySlug` / `fetchRecipeBySlug` read. */
const jsonResponse = (status: number, body: unknown): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 404 ? 'Not Found' : 'OK',
    json: async () => body,
  }) as unknown as Response;

interface MockRoutes {
  /** slug → manifest (omit / null ⇒ 404). */
  packs?: Record<string, BulkPackManifest | null>;
  /** slug → marketplace recipe row (omit / null ⇒ 404). */
  recipes?: Record<string, MarketplaceRecipeResult | null>;
  /** Throw a network error for any URL this matches. */
  errorOn?: (url: string) => boolean;
}

/** A `fetch` that routes the apex install artifacts `/packs/<slug>.json` +
 *  `/recipes/<slug>.json` to fixtures. Wraps each body in the legacy
 *  `{ data, meta }` envelope, which the fetchers still accept by shape-detection
 *  (the bare-manifest path is covered in the marketplace-package unit tests). */
const makeMockFetch = (routes: MockRoutes): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (routes.errorOn?.(url)) throw new Error('marketplace network down');
    const packMatch = url.match(/\/packs\/([^/?]+)\.json(?:$|\?)/);
    if (packMatch) {
      const slug = decodeURIComponent(packMatch[1]);
      const manifest = routes.packs?.[slug];
      if (manifest == null) return jsonResponse(404, null);
      return jsonResponse(200, { data: manifest, meta: {} });
    }
    const recipeMatch = url.match(/\/recipes\/([^/?]+)\.json(?:$|\?)/);
    if (recipeMatch) {
      const slug = decodeURIComponent(recipeMatch[1]);
      const row = routes.recipes?.[slug];
      if (row == null) return jsonResponse(404, null);
      return jsonResponse(200, { data: row, meta: {} });
    }
    return jsonResponse(404, null);
  }) as typeof globalThis.fetch;

beforeEach(() => {
  // Empty bundled dir — the by-slug path must resolve recipes from the
  // marketplace, NOT from disk.
  dir = mkdtempSync(join(tmpdir(), 'recued-install-5c-'));
  db = new Database(':memory:');
  recipeStore = createRecipeStore(dir, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// installPackBySlug — happy path + publisher stamping
// ────────────────────────────────────────────────────────────────

describe('installPackBySlug — marketplace-fetch path', () => {
  it('fetches the manifest + resolves a NON-bundled recipe from the marketplace', async () => {
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest() },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'recued-core') },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    expect(result.installed.map((e) => e.slug)).toEqual(['remote-recipe']);
    // The recipe was NOT bundled on disk — it only landed via the resolver.
    expect(recipeStore.listStored().map((r) => r.recipe_id)).toEqual(['remote-recipe']);
  });

  it('preserves a cross-publisher constituent recipe row publisher_id', async () => {
    // Manifest publisher ≠ constituent publisher. The pack reference does not
    // transfer authority over the recipe's identity or vault scope.
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest({ publisher: 'recued-core' }) },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'other-publisher') },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    const stored = recipeStore.getStored('remote-recipe');
    expect(stored?.publisher_id).toBe('other-publisher');
    expect(stored?.publisher_id).not.toBe('recued-core');
  });

  it('requires the exact resolved manifest review hash for a marketplace update', async () => {
    const incoming = baseManifest({ version: 2 });
    const routes: MockRoutes = {
      packs: { 'remote-pack': incoming },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'recued-core') },
    };
    const marketplaceFetch = makeMockFetch(routes);
    const contractStore = createContractStore(db);
    recordPackInventory(contractStore, {
      pack_slug: 'remote-pack',
      pack_version: 1,
      contents: [],
      installed_at: 1,
    });

    const missing = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir, contractStore },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(missing.result.failure?.code).toBe('review_stale');
    expect(recipeStore.listStored()).toEqual([]);

    const preview = await resolvePackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir, contractStore },
      { slug: 'remote-pack' },
    );
    expect(preview.manifest_review_hash).toMatch(/^[0-9a-f]{64}$/);
    const accepted = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir, contractStore },
      {
        slug: 'remote-pack',
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        expected_manifest_hash: preview.manifest_review_hash,
      },
    );
    expect(accepted.result.ok).toBe(true);
  });

  it('rejects an update when latest changed after the manifest review', async () => {
    const routes: MockRoutes = {
      packs: { 'remote-pack': baseManifest({ version: 2 }) },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'recued-core') },
    };
    const marketplaceFetch = makeMockFetch(routes);
    const contractStore = createContractStore(db);
    recordPackInventory(contractStore, {
      pack_slug: 'remote-pack',
      pack_version: 1,
      contents: [],
      installed_at: 1,
    });
    const preview = await resolvePackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir, contractStore },
      { slug: 'remote-pack' },
    );
    routes.packs!['remote-pack'] = baseManifest({
      version: 2,
      description: 'Changed after the consent surface rendered.',
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir, contractStore },
      {
        slug: 'remote-pack',
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
        expected_manifest_hash: preview.manifest_review_hash,
      },
    );
    expect(result.failure?.code).toBe('review_stale');
    expect(recipeStore.listStored()).toEqual([]);
  });

  it('does not let a same-slug local bundled recipe shadow marketplace authority', async () => {
    const bundled = recipeDef('remote-recipe');
    bundled.metadata.name = 'Local bundled collision';
    writeFileSync(join(dir, 'remote-recipe.json'), JSON.stringify(bundled));
    recipeStore = createRecipeStore(dir, db);

    const marketplaceRecipe = recipeDef('remote-recipe');
    marketplaceRecipe.metadata.name = 'Marketplace authoritative body';
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest({ publisher: 'pack-publisher' }) },
      recipes: {
        'remote-recipe': marketplaceRow(
          'remote-recipe',
          'recipe-publisher',
          marketplaceRecipe,
        ),
      },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    const stored = recipeStore.getStored('remote-recipe');
    expect(stored?.publisher_id).toBe('recipe-publisher');
    expect((JSON.parse(stored!.recipe_json) as RecipeDefinition).metadata.name)
      .toBe('Marketplace authoritative body');
  });

  it('does not fall back to a same-slug bundled recipe when the marketplace row is missing', async () => {
    writeFileSync(
      join(dir, 'remote-recipe.json'),
      JSON.stringify(recipeDef('remote-recipe')),
    );
    recipeStore = createRecipeStore(dir, db);
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest({ publisher: 'pack-publisher' }) },
      recipes: {},
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('rejects a marketplace constituent whose version drifted from the pack pin', async () => {
    const drifted = recipeDef('remote-recipe');
    drifted.version = 2;
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest() },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'recued-core', drifted) },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('accepts a constituent bundle matching the recipe row publisher when the pack publisher differs', async () => {
    const recipe = recipeDef('remote-recipe');
    recipe.metadata.recipe_bundle = 'other-publisher/outbound-follow-up-response';
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest({ publisher: 'recued-core' }) },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'other-publisher', recipe) },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    expect(recipeStore.getStored('remote-recipe')?.publisher_id).toBe('other-publisher');
  });

  it('rejects a constituent bundle matching the pack publisher but not the recipe row publisher', async () => {
    const recipe = recipeDef('remote-recipe');
    recipe.metadata.recipe_bundle = 'recued-core/outbound-follow-up-response';
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest({ publisher: 'recued-core' }) },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'other-publisher', recipe) },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validator_rejected');
    expect(result.failure?.message).toContain("must match publisher_id 'other-publisher'");
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns ok:false / unresolved when the pack is not on the marketplace (404)', async () => {
    const marketplaceFetch = makeMockFetch({ packs: {} });
    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'no-such-pack', granted_permissions: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('maps a manifest fetch error to ok:false / unexpected (no rpc throw)', async () => {
    const marketplaceFetch = makeMockFetch({ errorOn: (u) => u.includes('/packs/') });
    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unexpected');
  });

  it('a constituent-recipe fetch error becomes ok:false / unexpected (not a raw throw)', async () => {
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest() },
      errorOn: (u) => u.includes('/recipes/'),
    });
    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unexpected');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('a missing constituent recipe (404) fails the install as unresolved', async () => {
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest() },
      recipes: {}, // remote-recipe → 404 → resolver returns null → not_found
    });
    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
  });

  it('a constituent recipe whose id mismatches the pinned slug fails as unresolved (slug-confusion guard)', async () => {
    // fetchRecipeBySlug('remote-recipe') returns a row whose recipe_id is
    // 'wrong-id' — the resolver must reject it (return null → not_found).
    const marketplaceFetch = makeMockFetch({
      packs: { 'remote-pack': baseManifest() },
      recipes: { 'remote-recipe': marketplaceRow('wrong-id', 'recued-core') },
    });
    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('throws bad_request on a missing slug (arg-shape error stays on the error channel)', async () => {
    await expect(
      installPackBySlug(
        { recipeStore, marketplaceFetch: makeMockFetch({}), packDir: dir },
        { granted_permissions: [] } as unknown as { slug: string; granted_permissions: string[] },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// By-value packs.install stays bundled-only (the safe default)
// ────────────────────────────────────────────────────────────────

describe('by-value packs.install — bundled-only is UNCHANGED', () => {
  it('a non-bundled recipe resolves as not_found (no resolver injected)', async () => {
    // No `resolveMarketplaceRecipe` / `marketplaceFetch` → the by-value path
    // never reaches the marketplace; a non-bundled slug stays not_found.
    const { result } = await handlePacksInstall(
      { recipeStore, packDir: dir },
      { manifest: baseManifest(), granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(recipeStore.listStored()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// installRecipeBySlug — single-recipe install
// ────────────────────────────────────────────────────────────────

describe('installRecipeBySlug — marketplace-fetch path', () => {
  it('fetches + persists a recipe with the marketplace-authoritative publisher_id', async () => {
    const marketplaceFetch = makeMockFetch({
      recipes: { 'solo-recipe': marketplaceRow('solo-recipe', 'trusted-publisher') },
    });

    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch },
      { slug: 'solo-recipe' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.recipe_id).toBe('solo-recipe');
    expect(result.version).toBe(1);
    expect(result.name).toBe('Name of solo-recipe');
    expect(result.publisher_id).toBe('trusted-publisher');

    const stored = recipeStore.getStored('solo-recipe');
    expect(stored).not.toBeNull();
    // publisher_id is the marketplace row's, NOT the recipe's metadata.author.
    expect(stored?.publisher_id).toBe('trusted-publisher');
    expect(stored?.publisher_id).not.toBe('recued-core');
    expect(stored?.source).toBe('pair-sync');
  });

  it('rejects direct installation of a bundled recipe and returns its pack slug', async () => {
    const recipe = recipeDef('solo-recipe');
    recipe.metadata.recipe_bundle = 'trusted-publisher/sales-assist';
    const marketplaceFetch = makeMockFetch({
      recipes: { 'solo-recipe': marketplaceRow('solo-recipe', 'trusted-publisher', recipe) },
    });

    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch },
      { slug: 'solo-recipe' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toEqual({
      code: 'bundle_pack_required',
      message: 'recipe.installBySlug: recipe "solo-recipe" must be installed through pack "sales-assist"',
      pack_slug: 'sales-assist',
    });
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns ok:false / not_found when the recipe is not on the marketplace (404)', async () => {
    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch: makeMockFetch({ recipes: {} }) },
      { slug: 'no-such-recipe' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('not_found');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns ok:false / fetch_error on a network failure (no rpc throw)', async () => {
    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch: makeMockFetch({ errorOn: () => true }) },
      { slug: 'solo-recipe' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('fetch_error');
  });

  it('returns ok:false / validator_rejected for an invalid recipe (never persists)', async () => {
    const marketplaceFetch = makeMockFetch({
      recipes: {
        'bad-recipe': marketplaceRow('bad-recipe', 'recued-core', invalidRecipeDef('bad-recipe')),
      },
    });
    const { result } = await installRecipeBySlug({ recipeStore, marketplaceFetch }, { slug: 'bad-recipe' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('validator_rejected');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('D-201 rejects direct installation of a standalone webhook recipe without an owner ingress selection', async () => {
    const recipe = recipeDef('webhook-recipe');
    recipe.webhook_requirements = [{
      binding: 'generic_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      registration_modes: ['manual'],
      environment_policy: 'any',
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    recipe.webhook_triggers = [{ binding: 'generic_delivery', event_types: ['delivery'] }];
    const marketplaceFetch = makeMockFetch({
      recipes: { 'webhook-recipe': marketplaceRow('webhook-recipe', 'trusted-publisher', recipe) },
    });

    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch },
      { slug: 'webhook-recipe' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('validator_rejected');
    expect(result.failure.message).toContain('owner-selected ingress binding');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('D-201 does not let direct install shadow an existing Kitchen webhook recipe', async () => {
    const existing = recipeDef('webhook-shadow-guard');
    existing.webhook_requirements = [{
      binding: 'generic_delivery',
      profile_ids: ['generic.static-header-token.v1'],
      required_event_types: ['delivery'],
      decoded_payload_access: 'metadata_only',
      source_truth_policy: 'delivery_payload_allowed',
    }];
    existing.webhook_triggers = [{ binding: 'generic_delivery', event_types: ['delivery'] }];
    recipeStore.save(existing, 'kitchen', 'inline');
    const marketplaceFetch = makeMockFetch({
      recipes: {
        'webhook-shadow-guard': marketplaceRow(
          'webhook-shadow-guard',
          'trusted-publisher',
          recipeDef('webhook-shadow-guard'),
        ),
      },
    });

    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch },
      { slug: 'webhook-shadow-guard' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('validator_rejected');
    expect(recipeStore.get('webhook-shadow-guard')?.webhook_triggers).toHaveLength(1);
  });

  it('returns ok:false / validator_rejected when recipe_bundle publisher does not match the row publisher_id', async () => {
    const recipe = recipeDef('solo-recipe');
    recipe.metadata.recipe_bundle = 'other-publisher/sales-assist';
    const marketplaceFetch = makeMockFetch({
      recipes: { 'solo-recipe': marketplaceRow('solo-recipe', 'trusted-publisher', recipe) },
    });

    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch },
      { slug: 'solo-recipe' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('validator_rejected');
    expect(result.failure.message).toContain("must match publisher_id 'trusted-publisher'");
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('returns ok:false / validator_rejected when the row id mismatches the requested slug (slug-confusion guard)', async () => {
    const marketplaceFetch = makeMockFetch({
      recipes: { 'requested-slug': marketplaceRow('other-id', 'recued-core') },
    });
    const { result } = await installRecipeBySlug(
      { recipeStore, marketplaceFetch },
      { slug: 'requested-slug' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('validator_rejected');
    expect(recipeStore.listStored()).toHaveLength(0);
  });

  it('throws bad_request on a missing slug', async () => {
    await expect(
      installRecipeBySlug(
        { recipeStore, marketplaceFetch: makeMockFetch({}) },
        {} as unknown as { slug: string },
      ),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// Add-a-pack (2026-07-01) — resolvePackBySlug (manifest-only consent preview)
// ────────────────────────────────────────────────────────────────

describe('resolvePackBySlug — manifest-only preview', () => {
  it('returns the fetched manifest WITHOUT installing anything', async () => {
    const marketplaceFetch = makeMockFetch({ packs: { 'remote-pack': baseManifest() } });
    const res = await resolvePackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack' },
    );
    expect(res.manifest?.slug).toBe('remote-pack');
    expect(res.manifest_review_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.failure).toBeUndefined();
    // No install side effects — nothing persisted.
    expect(recipeStore.listStored()).toEqual([]);
  });

  it('maps a clean 404 to { manifest: null, failure: unresolved }', async () => {
    const marketplaceFetch = makeMockFetch({ packs: {} });
    const res = await resolvePackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'ghost-pack' },
    );
    expect(res.manifest).toBeNull();
    expect(res.failure?.code).toBe('unresolved');
  });

  it('maps a marketplace network error to failure: fetch_error (does not throw)', async () => {
    const marketplaceFetch = makeMockFetch({ errorOn: () => true });
    const res = await resolvePackBySlug(
      { recipeStore, marketplaceFetch, packDir: dir },
      { slug: 'remote-pack' },
    );
    expect(res.manifest).toBeNull();
    expect(res.failure?.code).toBe('fetch_error');
  });

  it('throws bad_request on a missing / non-string slug', async () => {
    await expect(
      resolvePackBySlug({ recipeStore, packDir: dir }, {} as { slug: string }),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// Install-vs-browse marker — the POLICY, asserted at the real call sites.
//
// The mechanism (does the fetcher set a header) is covered in the marketplace
// package. What matters here is WHICH call sites opt in: the browse/preview
// path shares the same route and the same fetcher, so a marker leaking onto it
// silently turns the install count back into a view count.
// ────────────────────────────────────────────────────────────────

const capturingFetch = (routes: MockRoutes) => {
  const inner = makeMockFetch(routes);
  const calls: Array<{ url: string; marked: boolean }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, marked: headers['x-recued-install'] === '1' });
    return inner(input, init);
  }) as typeof globalThis.fetch;
  return { calls, fetchFn };
};

describe('install-manifest marker — which call sites opt in', () => {
  it('installPackBySlug marks the pack fetch AND every constituent recipe fetch', async () => {
    const { calls, fetchFn } = capturingFetch({
      packs: { 'remote-pack': baseManifest() },
      recipes: { 'remote-recipe': marketplaceRow('remote-recipe', 'recued-core') },
    });

    const { result } = await installPackBySlug(
      { recipeStore, marketplaceFetch: fetchFn, packDir: dir },
      { slug: 'remote-pack', granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    // A pack install DOES install its recipes, so each ref is a real recipe
    // install — 1 for the pack + 1 per recipe is intended, not double counting.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.marked)).toBe(true);
    expect(calls.some((c) => c.url.includes('/packs/remote-pack.json'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/recipes/remote-recipe.json'))).toBe(true);
  });

  it('resolvePackBySlug (preview) NEVER marks — it fires on every detail render', async () => {
    const { calls, fetchFn } = capturingFetch({ packs: { 'remote-pack': baseManifest() } });

    const preview = await resolvePackBySlug(
      { recipeStore, marketplaceFetch: fetchFn, packDir: dir },
      { slug: 'remote-pack' },
    );

    expect(preview.manifest).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].marked).toBe(false);
  });

  it('installRecipeBySlug marks the standalone recipe install', async () => {
    const { calls, fetchFn } = capturingFetch({
      recipes: { 'solo-recipe': marketplaceRow('solo-recipe', 'recued-core') },
    });

    await installRecipeBySlug(
      { recipeStore, marketplaceFetch: fetchFn, packDir: dir },
      { slug: 'solo-recipe' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].marked).toBe(true);
  });
});
