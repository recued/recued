/** D-320 ruling 20 — a pack carrying more than 50 recipes installs from the web app.
 *
 *  A v2 pack may carry up to 100 contents, and four shipped packs carry 53 to 91
 *  recipes. Parsing a v2 manifest lifts its recipe contents into `recipes`, and
 *  the web app's install parses the manifest it was handed again
 *  (`packs.resolveBySlug` → `packs.install`, and `packs.installBySlug` the same
 *  way). That second parse capped `recipes` at 50, so it refused every one of
 *  them although the first parse had accepted it.
 *
 *  Real throughout: the parser, the install handler, the stores, the marketplace
 *  fetch path; the pack and its recipes are fixtures, so this ships publicly. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MAX_CONTENTS,
  D165_CONTRACT_SCHEMA,
  parseBulkPackManifest,
  type BulkPackManifest,
  type InstallGrantSelection,
  type RecipeDefinition,
} from '@recued/contracts';
import type { MarketplaceRecipeResult } from '@recued/marketplace';

import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { handlePacksInstall, installPackBySlug, resolvePackBySlug, type PackInstallRpcDeps } from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createRecordsStore } from '../records/store.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_900_000_000_000;
const COUNT = 53;
const scope: InstallGrantSelection = { access: 'read', audience: { owner: true, all_customers: false, all_other_contracts: false } };

const recipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: `Recipe ${recipe_id}`,
    description: 'D-320 ruling 20 over-50 fixture',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'fixture', 'over-50'],
  },
  variables: { greeting: { type: 'string', default: '', label: 'Greeting' } },
  steps: [{ id: 'has_greeting', transform: 'compare', left: '{{config.greeting}}', operator: 'is_not_empty' }],
  output: { sidebar: [{ type: 'summary', source: 'step.has_greeting' }] },
}) as unknown as RecipeDefinition;

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `over-fifty-recipe-${i + 1}`);
const bigPack = (n: number): BulkPackManifest => ({
  manifest_version: 2,
  slug: 'over-fifty',
  publisher: 'recued-core',
  name: 'Over Fifty',
  description: 'A recipe pack carrying more recipes than the v1 limit.',
  version: 1,
  recipes: [],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['test'],
  pack_kind: 'recipe_pack',
  contents: ids(n).map((slug) => ({ type: 'recipe', slug, version: 1 })),
}) as unknown as BulkPackManifest;

let scratch: string;
let db: Database.Database;
let recipeStore: RecipeStore;
let deps: PackInstallRpcDeps;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'over-fifty-'));
  mkdirSync(join(scratch, 'packs'));
  mkdirSync(join(scratch, 'recipes'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  recipeStore = createRecipeStore(join(scratch, 'recipes'), db);
  let clock = NOW;
  const marketRecipes = new Map<string, MarketplaceRecipeResult>(ids(COUNT).map((id) => [id, {
    recipe_id: id, publisher_id: 'recued-core', version: 1, recipe_hash: 'sha256:fixture', recipe: recipe(id),
  }]));
  deps = {
    recipeStore,
    contractStore,
    localManifestStore: createLocalManifestStore(db),
    registry: createManifestRegistry('/nonexistent-over-fifty-registry'),
    recordsStore: createRecordsStore(db, { now: () => clock++ }),
    packDir: join(scratch, 'packs'),
    marketplaceFetch: (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const packSlug = /^\/packs\/([^/]+)\.json$/.exec(path)?.[1];
      const recipeSlug = /^\/recipes\/([^/]+)\.json$/.exec(path)?.[1];
      const body = packSlug === 'over-fifty' ? bigPack(COUNT)
        : recipeSlug !== undefined ? marketRecipes.get(decodeURIComponent(recipeSlug)) : undefined;
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    now: () => NOW,
  } as unknown as PackInstallRpcDeps;
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const stored = (): number => ids(COUNT).filter((id) => recipeStore.getStored(id)).length;

describe('a pack carrying more than 50 recipes', () => {
  it('parses, and the manifest a parse returns parses again', () => {
    const first = parseBulkPackManifest(bigPack(COUNT));
    expect(first.ok, JSON.stringify(first.issues)).toBe(true);
    if (!first.ok) return;
    expect(first.manifest.recipes).toHaveLength(COUNT);
    const second = parseBulkPackManifest(first.manifest);
    expect(second.ok, JSON.stringify(second.issues)).toBe(true);
  });

  it('a v2 recipes list is still capped, at the contents limit', () => {
    const over = { ...bigPack(1), recipes: ids(BULK_PACK_MAX_CONTENTS + 1).map((slug) => ({ slug, version: 1 })) };
    const parsed = parseBulkPackManifest(over);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'pack_recipes_too_many' }));
  });

  it('⛔ installs as the web app installs it: resolved by slug, then installed from the manifest it returned', async () => {
    for (const id of ids(COUNT)) writeFileSync(join(scratch, 'recipes', `${id}.json`), JSON.stringify(recipe(id)));
    const preview = await resolvePackBySlug(deps, { slug: 'over-fifty' });
    expect(preview.failure, JSON.stringify(preview.failure)).toBeUndefined();
    const { result } = await handlePacksInstall(deps, {
      manifest: preview.manifest!,
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      install_scope: scope,
    });
    expect(result.failure, JSON.stringify(result.failure)).toBeUndefined();
    expect(stored()).toBe(COUNT);
  });

  it('⛔ installs by slug from the marketplace', async () => {
    const { result } = await installPackBySlug(deps, {
      slug: 'over-fifty',
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      install_scope: scope,
    });
    expect(result.failure, JSON.stringify(result.failure)).toBeUndefined();
    expect(stored()).toBe(COUNT);
  });
});
