/** D-145 PA10 follow-on Slice D - packs.uninstall broadcast emit tests. */

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

import { composePackUninstallRpcDeps } from '../composition/bin/wire-pack-uninstall-rpc-deps.js';
import { createEventBus } from '../events/bus.js';
import {
  handlePacksUninstall,
  type PackUninstallBroadcastEmitter,
} from '../pack-uninstall-handler.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';

let recipeDir: string;
let packDir: string;
let db: Database.Database;
let recipeStore: RecipeStore;

type PackUninstallEventInput =
  Parameters<PackUninstallBroadcastEmitter['emit']>[0];

const recipeDef = (recipe_id: string, version = 1): RecipeDefinition => ({
  recipe_id,
  version,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'd-145 slice-d pack-uninstall emit test fixture',
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

const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'slice-d-uninstall-pack',
  publisher: 'recued-core',
  name: 'Slice D Uninstall Pack',
  description: 'fixture',
  version: 5,
  recipes: [{ slug: 'alpha-recipe', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
  ...overrides,
});

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

const makeBroadcastCapture = (): {
  emitted: PackUninstallEventInput[];
  broadcast: PackUninstallBroadcastEmitter;
} => {
  const emitted: PackUninstallEventInput[] = [];
  return {
    emitted,
    broadcast: {
      emit: (event) => {
        emitted.push(event);
      },
    },
  };
};

beforeEach(() => {
  recipeDir = mkdtempSync(join(tmpdir(), 'recued-d145-slice-d-pack-uninstall-recipes-'));
  packDir = mkdtempSync(join(tmpdir(), 'recued-d145-slice-d-pack-uninstall-packs-'));
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

describe('D-145 Slice D - handlePacksUninstall broadcast emit', () => {
  it('emits pack_uninstalled on full success with removed counts', async () => {
    const manifest = baseManifest({
      slug: 'full-success-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    writeManifest('full-success-pack', manifest);
    simulateInstall(manifest);
    const { emitted, broadcast } = makeBroadcastCapture();

    const { result } = await handlePacksUninstall(
      { recipeStore, packDir, broadcast },
      { pack_slug: 'full-success-pack' },
    );

    expect(result.ok).toBe(true);
    expect([...result.removed.recipes].sort()).toEqual([
      'alpha-recipe',
      'beta-recipe',
    ]);
    expect(emitted).toEqual([
      {
        kind: 'pack_uninstalled',
        pack_slug: 'full-success-pack',
        pack_name: 'Slice D Uninstall Pack',
        pack_version: 5,
        removed_recipe_count: 2,
      },
    ]);
  });

  it('does not emit on not_found failure', async () => {
    const { emitted, broadcast } = makeBroadcastCapture();

    const { result } = await handlePacksUninstall(
      { recipeStore, packDir, broadcast },
      { pack_slug: 'missing-pack' },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('not_found');
    expect(emitted).toEqual([]);
  });

  it('does not emit when recipeStore.delete throws mid-transaction', async () => {
    const manifest = baseManifest({
      slug: 'recipe-delete-throws-pack',
      recipes: [
        { slug: 'alpha-recipe', version: 1 },
        { slug: 'beta-recipe', version: 1 },
      ],
    });
    writeManifest('recipe-delete-throws-pack', manifest);
    simulateInstall(manifest);
    const { emitted, broadcast } = makeBroadcastCapture();
    const throwingRecipeStore = {
      ...recipeStore,
      delete: (recipe_id: string): boolean => {
        if (recipe_id === 'beta-recipe') {
          throw new Error('recipe delete boom');
        }
        return recipeStore.delete(recipe_id);
      },
    } as unknown as RecipeStore;

    const { result } = await handlePacksUninstall(
      {
        recipeStore: throwingRecipeStore,
        packDir,
        broadcast,
      },
      { pack_slug: 'recipe-delete-throws-pack' },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('unexpected');
    expect(result.removed.recipes).toEqual(['alpha-recipe']);
    expect(emitted).toEqual([]);
  });

  it('isolates synchronous broadcast emit failures from the uninstall result', async () => {
    const manifest = baseManifest({ slug: 'emit-throws-pack' });
    writeManifest('emit-throws-pack', manifest);
    simulateInstall(manifest);
    const broadcast: PackUninstallBroadcastEmitter = {
      emit: () => {
        throw new Error('bus unavailable');
      },
    };

    const { result } = await handlePacksUninstall(
      { recipeStore, packDir, broadcast },
      { pack_slug: 'emit-throws-pack' },
    );

    expect(result.ok).toBe(true);
    expect(result.removed.recipes).toEqual(['alpha-recipe']);
  });
});

describe('D-145 Slice D - composePackUninstallRpcDeps broadcast wiring', () => {
  it('forwards pack_uninstalled through EventBus with a bus-stamped cursor', () => {
    const bus = createEventBus();
    const bundle = composePackUninstallRpcDeps({
      recipeStore,
      eventBus: bus,
      packDir,
    });

    bundle.packUninstallDeps!.broadcast!.emit({
      kind: 'pack_uninstalled',
      pack_slug: 'slice-d-uninstall-pack',
      pack_name: 'Slice D Uninstall Pack',
      pack_version: 5,
      removed_recipe_count: 2,
    });

    expect(bus.cursor()).toBe(1);
    expect(bus.replay(0)).toEqual([
      {
        kind: 'pack_uninstalled',
        pack_slug: 'slice-d-uninstall-pack',
        pack_name: 'Slice D Uninstall Pack',
        pack_version: 5,
        removed_recipe_count: 2,
        cursor: 1,
      },
    ]);
  });
});
