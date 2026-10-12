/** D-320 ruling 19 — a pack or a recipe can name the lowest Recued it runs on
 *  (`min_recued_version`, at a pack's root, in a recipe's metadata), and a server
 *  older than that refuses to install or update it, saying to update Recued.
 *
 *  The owner chose this over a `manifest_version` gate after weighing them
 *  (2026-10-11): a server older than the field ignores it (26.10.9's validators
 *  accept it, measured), so it gates installs only on servers from the release
 *  that adds it, which every server will run from launch.
 *
 *  Real throughout: the install handler, the stores, the validators, the
 *  marketplace fetch path; the packs and recipes are fixtures, so this file needs
 *  nothing from the shipped corpus (`recued-version-floor-corpus.test.ts` holds
 *  the shipped packs to the rule). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_PACK_INSTALL_PERMISSION,
  D165_CONTRACT_SCHEMA,
  RECUED_VERSION_RE,
  isRecuedVersion,
  parseBulkPackManifest,
  type BulkPackManifest,
  type InstallGrantSelection,
  type RecipeDefinition,
} from '@recued/contracts';
import type { MarketplaceRecipeResult } from '@recued/marketplace';
import { validateRecipe } from '@recued/recipes';
import { RELEASE_VERSION_RE } from '@recued/release';

import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { needsNewerRecued } from '../pack-host-capabilities.js';
import {
  handlePacksInstall,
  installPackBySlug,
  installRecipeBySlug,
  makePackInstallHandlers,
  type PackInstallRpcDeps,
} from '../pack-install-handler.js';
import { getInstalledPack } from '../pack-inventory.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { createRecordsStore } from '../records/store.js';
import { SERVER_VERSION } from '../server-version.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_900_000_000_000;
/** Far ahead of any real release, so the case does not age. */
const NEWER = '99.12.31';

const scope = (access: InstallGrantSelection['access']): InstallGrantSelection =>
  ({ access, audience: { owner: true, all_customers: false, all_other_contracts: false } });

/** A valid transform-only recipe, as `install-by-slug-5c.test.ts` builds one. */
const recipe = (recipe_id: string, floor?: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: `Recipe ${recipe_id}`,
    description: 'D-320 ruling 19 floor fixture',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'fixture', 'floor'],
    ...(floor !== undefined ? { min_recued_version: floor } : {}),
  },
  variables: { greeting: { type: 'string', default: '', label: 'Greeting' } },
  steps: [{ id: 'has_greeting', transform: 'compare', left: '{{config.greeting}}', operator: 'is_not_empty' }],
  output: { sidebar: [{ type: 'summary', source: 'step.has_greeting' }] },
}) as unknown as RecipeDefinition;

/** A recipe pack carrying one recipe, as the shipped recipe packs are shaped. */
const pack = (
  slug: string,
  name: string,
  recipeId: string,
  extra: { floor?: string; dependencies?: string[] } = {},
): BulkPackManifest => ({
  manifest_version: 2,
  slug,
  publisher: 'recued-core',
  name,
  description: `${name}, a D-320 ruling 19 floor fixture pack.`,
  version: 1,
  recipes: [],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['test'],
  pack_kind: 'recipe_pack',
  contents: [{ type: 'recipe', slug: recipeId, version: 1 }],
  ...(extra.floor !== undefined ? { min_recued_version: extra.floor } : {}),
  ...(extra.dependencies !== undefined
    ? { dependencies: extra.dependencies.map((dep) => ({ type: 'pack', slug: dep, min_version: 1 })) }
    : {}),
}) as unknown as BulkPackManifest;

let scratch: string;
let db: Database.Database;
let contractStore: ContractStore;
let recipeStore: RecipeStore;
let deps: PackInstallRpcDeps;
let marketplacePacks: Map<string, BulkPackManifest>;
let marketplaceRecipes: Map<string, MarketplaceRecipeResult>;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'recued-version-floor-'));
  mkdirSync(join(scratch, 'packs'));
  mkdirSync(join(scratch, 'recipes'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  contractStore = createContractStore(db, { now: () => NOW });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  recipeStore = createRecipeStore(join(scratch, 'recipes'), db);
  marketplacePacks = new Map();
  marketplaceRecipes = new Map();
  let clock = NOW;
  deps = {
    recipeStore,
    contractStore,
    localManifestStore: createLocalManifestStore(db),
    registry: createManifestRegistry('/nonexistent-recued-version-floor-registry'),
    recordsStore: createRecordsStore(db, { now: () => clock++ }),
    packDir: join(scratch, 'packs'),
    // A marketplace that has exactly what a case gives it.
    marketplaceFetch: (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const packSlug = /^\/packs\/([^/]+)\.json$/.exec(path)?.[1];
      const recipeSlug = /^\/recipes\/([^/]+)\.json$/.exec(path)?.[1];
      const body = packSlug !== undefined
        ? marketplacePacks.get(decodeURIComponent(packSlug))
        : recipeSlug !== undefined ? marketplaceRecipes.get(decodeURIComponent(recipeSlug)) : undefined;
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    // The preview reads every incoming recipe only when one of its readers is
    // wired, as production wires them; an owner with no saved dishes.
    getSavedSettings: () => ({ dishes: { listByRecipe: () => [] } }),
    now: () => NOW,
  } as unknown as PackInstallRpcDeps;
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** The server's own copies — what a by-value install reads its packs and recipes from. */
const bundle = (packs: BulkPackManifest[], recipes: RecipeDefinition[]): void => {
  for (const manifest of packs) writeFileSync(join(scratch, 'packs', `${manifest.slug}.json`), JSON.stringify(manifest));
  for (const def of recipes) writeFileSync(join(scratch, 'recipes', `${def.recipe_id}.json`), JSON.stringify(def));
};
const install = async (manifest: BulkPackManifest) => (await handlePacksInstall(deps, {
  manifest,
  granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
  install_scope: scope('read'),
})).result;
const preview = async (manifest: BulkPackManifest): Promise<Record<string, unknown>> =>
  await makePackInstallHandlers(deps)!.handlers['packs.install_preview']!(
    { manifest } as never, {} as never,
  ) as Record<string, unknown>;
/** What the owner has afterwards, by pack and by recipe. */
const has = (packSlug: string, recipeId: string) => ({
  pack: getInstalledPack(contractStore, packSlug) !== null,
  recipe: recipeStore.getStored(recipeId) !== undefined && recipeStore.getStored(recipeId) !== null,
});
const newer = (what: string, floor: string, root: string): string =>
  `packs.install: ${what} needs Recued ${floor} or newer, and this server runs ${SERVER_VERSION}. `
    + `Update Recued, then install ${root} again.`;

describe('the field: a released Recued version, held to the update checker\'s grammar', () => {
  it('is the release feed\'s grammar, so a floor compares as the server\'s own version does', () => {
    expect(RECUED_VERSION_RE.source).toBe(RELEASE_VERSION_RE.source);
    expect(RECUED_VERSION_RE.flags).toBe(RELEASE_VERSION_RE.flags);
  });

  it('takes a release or a hotfix, and nothing a comparator would coerce', () => {
    for (const v of ['26.10.12', '26.10.12.1', '0.0.0']) expect(isRecuedVersion(v), v).toBe(true);
    for (const v of ['26.10', 'v26.10.12', '26.10.012', '26.10.12.0', '26.10.12-rc1', 26, undefined]) {
      expect(isRecuedVersion(v), String(v)).toBe(false);
    }
  });

  it('a pack naming a malformed one is refused; a well-formed one parses', () => {
    expect(parseBulkPackManifest(pack('parse-probe', 'Parse Probe', 'parse-probe-recipe', { floor: '26.10.12' })).ok).toBe(true);
    const bad = parseBulkPackManifest(pack('parse-probe', 'Parse Probe', 'parse-probe-recipe', { floor: 'next' }));
    expect(bad.ok).toBe(false);
    expect(bad.issues).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'pack_min_recued_version_invalid', path: 'min_recued_version',
    }));
  });

  it('a recipe naming a malformed one is refused; a well-formed one validates', () => {
    expect(validateRecipe(recipe('floor-probe', '26.10.12')).valid).toBe(true);
    const bad = validateRecipe(recipe('floor-probe', '26.10'));
    expect(bad.valid).toBe(false);
    expect(bad.issues).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'min_recued_version_invalid', path: 'metadata.min_recued_version',
    }));
  });

  it('a floor above the server is newer, at it or below is not, and a hotfix counts', () => {
    expect(needsNewerRecued('26.10.12', '26.10.11')).toBe(true);
    expect(needsNewerRecued('26.10.11', '26.10.11')).toBe(false);
    expect(needsNewerRecued('26.9.30', '26.10.11')).toBe(false);
    expect(needsNewerRecued('26.10.11.1', '26.10.11')).toBe(true);
    expect(needsNewerRecued(undefined, '26.10.11')).toBe(false);
  });
});

describe('a pack that names a newer Recued is refused before anything installs', () => {
  it('control: a pack at this server\'s own version installs', async () => {
    const at = pack('floor-at', 'Floor At', 'floor-at-recipe', { floor: SERVER_VERSION });
    bundle([at], [recipe('floor-at-recipe')]);
    const result = await install(at);
    expect(result.failure).toBeUndefined();
    expect(has('floor-at', 'floor-at-recipe')).toEqual({ pack: true, recipe: true });
  });

  it('⛔ the pack itself: refused, in words an owner can act on, and nothing is written', async () => {
    const above = pack('floor-above', 'Floor Above', 'floor-above-recipe', { floor: NEWER });
    bundle([above], [recipe('floor-above-recipe')]);
    const result = await install(above);
    expect(result).toMatchObject({ ok: false, installed: [], failure: { code: 'version_mismatch' } });
    expect(result.failure!.message).toBe(newer('Floor Above', NEWER, 'Floor Above'));
    expect(has('floor-above', 'floor-above-recipe')).toEqual({ pack: false, recipe: false });
  });

  it('⛔ a pack it brings in: named, and neither it, the pack listed ahead of it, nor the root installs', async () => {
    const ok = pack('dep-ok', 'Dep Ok', 'dep-ok-recipe');
    const dep = pack('dep-above', 'Dep Above', 'dep-above-recipe', { floor: NEWER });
    const root = pack('floor-root', 'Floor Root', 'floor-root-recipe', { dependencies: ['dep-ok', 'dep-above'] });
    bundle([ok, dep], [recipe('dep-ok-recipe'), recipe('dep-above-recipe'), recipe('floor-root-recipe')]);
    const result = await install(root);
    expect(result).toMatchObject({ ok: false, installed: [], failure: { code: 'version_mismatch' } });
    expect(result.failure!.message).toBe(newer('Floor Root brings in Dep Above, which', NEWER, 'Floor Root'));
    expect([has('dep-ok', 'dep-ok-recipe'), has('dep-above', 'dep-above-recipe'), has('floor-root', 'floor-root-recipe')])
      .toEqual([{ pack: false, recipe: false }, { pack: false, recipe: false }, { pack: false, recipe: false }]);
  });

  it('names the highest floor among them, so one update is enough', async () => {
    const dep = pack('dep-highest', 'Dep Highest', 'dep-highest-recipe', { floor: '99.1.1' });
    const root = pack('root-lower', 'Root Lower', 'root-lower-recipe', { floor: '98.1.1', dependencies: ['dep-highest'] });
    bundle([dep], [recipe('dep-highest-recipe'), recipe('root-lower-recipe')]);
    expect((await install(root)).failure!.message).toBe(newer('Root Lower brings in Dep Highest, which', '99.1.1', 'Root Lower'));
    // And the other way round: the root's floor is the highest, the pack it brings in is checked first.
    const lower = pack('dep-lower', 'Dep Lower', 'dep-lower-recipe', { floor: '98.1.1' });
    const highest = pack('root-highest', 'Root Highest', 'root-highest-recipe', { floor: '99.1.1', dependencies: ['dep-lower'] });
    bundle([lower], [recipe('dep-lower-recipe'), recipe('root-highest-recipe')]);
    expect((await install(highest)).failure!.message).toBe(newer('Root Highest', '99.1.1', 'Root Highest'));
  });

  it('⛔ the same on the marketplace path, as an owner\'s install or update arrives', async () => {
    const above = pack('market-above', 'Market Above', 'market-above-recipe', { floor: NEWER });
    marketplacePacks.set(above.slug, above);
    marketplaceRecipes.set('market-above-recipe', {
      recipe_id: 'market-above-recipe', publisher_id: 'recued-core', version: 1, recipe_hash: 'sha256:fixture',
      recipe: recipe('market-above-recipe'),
    });
    const { result } = await installPackBySlug(deps, {
      slug: 'market-above',
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      install_scope: scope('read'),
    });
    expect(result).toMatchObject({ ok: false, installed: [], failure: { code: 'version_mismatch' } });
    expect(result.failure!.message).toBe(newer('Market Above', NEWER, 'Market Above'));
    expect(has('market-above', 'market-above-recipe')).toEqual({ pack: false, recipe: false });
  });

  it('⛔ the preview names the same refusal before Install, so the dialog can hold it', async () => {
    const above = pack('preview-above', 'Preview Above', 'preview-above-recipe', { floor: NEWER });
    bundle([above], [recipe('preview-above-recipe')]);
    expect((await preview(above)).install_refusal).toEqual({
      code: 'version_mismatch',
      message: newer('Preview Above', NEWER, 'Preview Above'),
    });
    expect(has('preview-above', 'preview-above-recipe')).toEqual({ pack: false, recipe: false });
  });
});

describe('a recipe that names a newer Recued is refused, inside a pack or on its own', () => {
  it('⛔ inside a pack that names none: the install refuses, naming the recipe, and writes nothing', async () => {
    const carrier = pack('carrier', 'Carrier', 'carried-above');
    bundle([carrier], [recipe('carried-above', NEWER)]);
    const result = await install(carrier);
    expect(result).toMatchObject({ ok: false, installed: [], failure: { code: 'version_mismatch' } });
    expect(result.failure!.message).toBe(newer('Carrier includes Recipe carried-above, which', NEWER, 'Carrier'));
    expect(has('carrier', 'carried-above')).toEqual({ pack: false, recipe: false });
  });

  it('⛔ and the preview names it before Install', async () => {
    const carrier = pack('carrier-preview', 'Carrier Preview', 'carried-preview-above');
    bundle([carrier], [recipe('carried-preview-above', NEWER)]);
    expect((await preview(carrier)).install_refusal).toEqual({
      code: 'version_mismatch',
      message: newer('Carrier Preview includes Recipe carried-preview-above, which', NEWER, 'Carrier Preview'),
    });
  });

  it('⛔ on its own: an install or update by slug refuses it and keeps nothing', async () => {
    marketplaceRecipes.set('alone-above', {
      recipe_id: 'alone-above', publisher_id: 'recued-core', version: 1, recipe_hash: 'sha256:fixture',
      recipe: recipe('alone-above', NEWER),
    });
    const { result } = await installRecipeBySlug(deps, { slug: 'alone-above' });
    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'version_mismatch',
        message: `recipe.installBySlug: Recipe alone-above needs Recued ${NEWER} or newer, and this server runs `
          + `${SERVER_VERSION}. Update Recued, then install it again.`,
      },
    });
    expect(recipeStore.getStored('alone-above') ?? null).toBeNull();
  });

  it('control: on its own at this server\'s version, it installs', async () => {
    marketplaceRecipes.set('alone-at', {
      recipe_id: 'alone-at', publisher_id: 'recued-core', version: 1, recipe_hash: 'sha256:fixture',
      recipe: recipe('alone-at', SERVER_VERSION),
    });
    const { result } = await installRecipeBySlug(deps, { slug: 'alone-at' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(recipeStore.getStored('alone-at')).toBeTruthy();
  });
});
