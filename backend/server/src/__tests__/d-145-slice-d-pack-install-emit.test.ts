/** D-145 PA10 follow-on Slice D - packs.install broadcast emit tests. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';

import { composePackInstallRpcDeps } from '../composition/bin/wire-pack-install-rpc-deps.js';
import { createEventBus } from '../events/bus.js';
import {
  handlePacksInstall,
  type PackInstallBroadcastEmitter,
} from '../pack-install-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';

let dir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

const PACK_SLUG = 'slice-d-install-pack';

type PackInstallEventInput = Parameters<PackInstallBroadcastEmitter['emit']>[0];

const recipeDef = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'd-145 slice-d pack-install emit test fixture',
    author: 'recued-core',
    supported_platforms: [],
    tags: [],
  },
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const writeBundledRecipe = (recipe_id: string): void => {
  writeFileSync(join(dir, `${recipe_id}.json`), JSON.stringify(recipeDef(recipe_id)));
};

const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: PACK_SLUG,
  publisher: 'recued-core',
  name: 'Slice D Install Pack',
  description: 'fixture',
  version: 3,
  recipes: [{ slug: 'alpha-recipe', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  ...overrides,
});

const makeBroadcastCapture = (): {
  emitted: PackInstallEventInput[];
  broadcast: PackInstallBroadcastEmitter;
} => {
  const emitted: PackInstallEventInput[] = [];
  return {
    emitted,
    broadcast: {
      emit: (event) => {
        emitted.push(event);
      },
    },
  };
};

const makeFreshCountingRecipeStore = (): RecipeStore =>
  ({
    ...recipeStore,
    get: (recipe_id: string) => {
      if (recipeStore.getStored(recipe_id) === null) return null;
      return recipeStore.get(recipe_id);
    },
  }) as RecipeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recued-d145-slice-d-pack-install-'));
  db = new Database(':memory:');
  writeBundledRecipe('alpha-recipe');
  writeBundledRecipe('beta-recipe');
  recipeStore = createRecipeStore(dir, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-145 Slice D - handlePacksInstall broadcast emit', () => {
  it('emits pack_installed on success with manifest fields and fresh install count', async () => {
    const manifest = baseManifest({
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    const store = makeFreshCountingRecipeStore();
    const { emitted, broadcast } = makeBroadcastCapture();

    const { result } = await handlePacksInstall(
      { recipeStore: store, broadcast },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(true);
    const freshCount = result.installed.filter((entry) => entry.fresh_install).length;
    expect(freshCount).toBe(2);
    expect(emitted).toEqual([
      {
        kind: 'pack_installed',
        pack_slug: PACK_SLUG,
        pack_name: 'Slice D Install Pack',
        pack_version: 3,
        installed_recipe_count: freshCount,
      },
    ]);
  });

  it('completes a successful install when broadcast is absent', async () => {
    const { result } = await handlePacksInstall(
      {
        recipeStore: makeFreshCountingRecipeStore(),
      },
      {
        manifest: baseManifest(),
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      },
    );

    expect(result.ok).toBe(true);
  });

  it('does not emit when install returns ok=false for an unresolved recipe', async () => {
    const { emitted, broadcast } = makeBroadcastCapture();
    const manifest = baseManifest({
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'never-bundled', version: 1 },
      ],
    });

    const { result } = await handlePacksInstall(
      { recipeStore, broadcast },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unresolved');
    expect(emitted).toEqual([]);
  });

  it('emits installed_recipe_count 0 for an idempotent reinstall', async () => {
    const manifest = baseManifest();
    const store = makeFreshCountingRecipeStore();

    const first = await handlePacksInstall(
      { recipeStore: store },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );
    expect(first.result.ok).toBe(true);

    const { emitted, broadcast } = makeBroadcastCapture();
    const second = await handlePacksInstall(
      { recipeStore: store, broadcast },
      { manifest, granted_permissions: [BULK_PACK_INSTALL_PERMISSION] },
    );

    expect(second.result.ok).toBe(true);
    expect(second.result.installed.filter((entry) => entry.fresh_install)).toHaveLength(0);
    expect(emitted).toEqual([
      {
        kind: 'pack_installed',
        pack_slug: PACK_SLUG,
        pack_name: 'Slice D Install Pack',
        pack_version: 3,
        installed_recipe_count: 0,
      },
    ]);
  });

  it('isolates synchronous broadcast emit failures from the install result', async () => {
    const broadcast: PackInstallBroadcastEmitter = {
      emit: () => {
        throw new Error('bus unavailable');
      },
    };

    const { result } = await handlePacksInstall(
      {
        recipeStore: makeFreshCountingRecipeStore(),
        broadcast,
      },
      {
        manifest: baseManifest(),
        granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
      },
    );

    expect(result.ok).toBe(true);
  });
});

describe('D-145 Slice D - composePackInstallRpcDeps broadcast wiring', () => {
  it('forwards pack_installed through EventBus with a bus-stamped cursor', () => {
    const bus = createEventBus();
    const bundle = composePackInstallRpcDeps({
      recipeStore,
      eventBus: bus,
    });

    bundle.packInstallDeps!.broadcast!.emit({
      kind: 'pack_installed',
      pack_slug: PACK_SLUG,
      pack_name: 'Slice D Install Pack',
      pack_version: 3,
      installed_recipe_count: 4,
    });

    expect(bus.cursor()).toBe(1);
    expect(bus.replay(0)).toEqual([
      {
        kind: 'pack_installed',
        pack_slug: PACK_SLUG,
        pack_name: 'Slice D Install Pack',
        pack_version: 3,
        installed_recipe_count: 4,
        cursor: 1,
      },
    ]);
  });
});
