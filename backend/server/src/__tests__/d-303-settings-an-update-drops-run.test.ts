/** D-303 — after an update drops a variable, a value the owner saved for it no longer
 *  refuses the run: it is dropped, and the rest of the saved settings apply.
 *
 *  Driven through `handleExecute`, where D-222's boundary lives. The recipe store is the
 *  real SQLite one, so the retired list comes from actual saves. The dish and group
 *  stores hold what the owner saved. The engine is mocked only to capture what the run
 *  would see. ⚠ Not a pack-harness drive: that harness calls the engine directly, past
 *  the boundary, so it could not fail here (D-302, mutation N32). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ExecutionResult } from '@recued/engine';
import {
  RpcError,
  UNDECLARED_CONFIG_ARGUMENT,
  type RecipeDefinition,
  type UndeclaredConfigArgumentDetails,
  type VariableDefault,
} from '@recued/contracts';

import { createDishGroupStore } from '../dish-group-store.js';
import { createDishStore } from '../dish-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const executeRecipeMock = vi.hoisted(() => vi.fn());
vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return { ...actual, executeRecipe: executeRecipeMock };
});

// Imported AFTER the hoisted `vi.mock` so the handler binds the mock.
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const RECIPE_ID = 'd-303-run';

const recipe = (version: number, variables: Record<string, VariableDefault>): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version,
  ttl: 0,
  metadata: { name: 'D-303 run', description: 'Fixture for D-303.', author: 'test', supported_platforms: [] },
  variables,
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['a', 'b'] } as never],
  output: { render: [] },
}) as RecipeDefinition;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A server whose recipe went through `versions`, with the owner's install config
 *  saved while the first one was current. */
const server = (versions: Array<Record<string, VariableDefault>>) => {
  const dir = mkdtempSync(join(tmpdir(), 'd-303-run-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const recipeStore = createRecipeStore(dir, db);
  const dishStore = createDishStore(db);
  const dishGroupStore = createDishGroupStore(db);
  versions.forEach((variables, index) => recipeStore.save(recipe(index + 1, variables), 'recued-core', 'pair-sync'));
  dishStore.set({
    dish_id: 'dsh_install', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: '', is_default: true,
    config_overlay: { status: 'closed', extra: 'x' }, enabled: true, created_at: 1,
  });
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    dishStore,
    dishGroupStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'd-303-run-test',
  };
  return { deps, recipeStore, dishStore, dishGroupStore };
};

let seen: Record<string, unknown> | undefined;
beforeEach(() => {
  seen = undefined;
  executeRecipeMock.mockReset();
  executeRecipeMock.mockImplementation(async (ctx: ExecutionContext): Promise<ExecutionResult> => {
    seen = (ctx as unknown as { stores?: { config?: Record<string, unknown> } }).stores?.config;
    return {
      recipe_id: RECIPE_ID, recipe_hash: 'h', success: true, output: { render: [], sidebar: [] },
      steps: [], errors: [], duration_ms: 0, validation_issues: [],
    };
  });
});

const refusal = async (deps: ExecuteHandlerDeps, config?: Record<string, unknown>) => {
  const thrown = await handleExecute(deps, { recipe_id: RECIPE_ID, ...(config ? { config } : {}) })
    .then(() => null, (error: unknown) => error);
  expect(thrown).toBeInstanceOf(RpcError);
  expect((thrown as RpcError).code).toBe(UNDECLARED_CONFIG_ARGUMENT);
  return ((thrown as RpcError).details as unknown as UndeclaredConfigArgumentDetails).undeclared;
};

describe('D-303 — a saved value for a variable an update dropped', () => {
  it('⛔ the control: a server that never saw the variable declared still refuses it', async () => {
    const { deps } = server([{ status: 'open' }]);
    expect(await refusal(deps)).toEqual([{ key: 'extra', origin: 'overlay' }]);
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('⛔ after the update that dropped it, the run goes ahead with the rest of the install config', async () => {
    const { deps } = server([{ status: 'open', extra: 'none' }, { status: 'open' }]);
    const result = await handleExecute(deps, { recipe_id: RECIPE_ID });
    expect(result.success).toBe(true);
    expect(seen).toEqual({ status: 'closed' });
  });

  it('a version that brings the setting back gets the saved value back', async () => {
    const { deps, recipeStore } = server([{ status: 'open', extra: 'none' }, { status: 'open' }]);
    recipeStore.save(recipe(3, { status: 'open', extra: 'none' }), 'recued-core', 'pair-sync');
    await handleExecute(deps, { recipe_id: RECIPE_ID });
    expect(seen).toEqual({ status: 'closed', extra: 'x' });
  });

  it('⛔ never a name the recipe being run declares: an inline body that reads it gets the saved value', async () => {
    const { deps } = server([{ status: 'open', extra: 'none' }, { status: 'open' }]);
    await handleExecute(deps, { recipe_id: RECIPE_ID, recipe: recipe(3, { status: 'open', extra: 'none' }) } as never);
    expect(seen).toEqual({ status: 'closed', extra: 'x' });
  });

  it('a standing dish and the group it shares are covered too', async () => {
    const { deps, dishStore, dishGroupStore } = server([{ status: 'open', extra: 'none', shared: 'none' }, { status: 'open' }]);
    dishGroupStore.set({ group_id: 'dgrp_team', name: 'Team', config_overlay: { shared: 'g' }, created_at: 1 });
    dishStore.set({
      dish_id: 'dsh_weekly', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: 'Weekly', is_default: false,
      config_overlay: { status: 'weekly', extra: 'w' }, enabled: true, created_at: 2, group_id: 'dgrp_team',
    });
    await handleExecute(deps, { recipe_id: RECIPE_ID, dish_id: 'dsh_weekly' });
    expect(seen).toEqual({ status: 'weekly' });
  });

  it('a stale client sending it is dropped the same way — and any other undeclared key is still refused', async () => {
    const { deps } = server([{ status: 'open', extra: 'none' }, { status: 'open' }]);
    await handleExecute(deps, { recipe_id: RECIPE_ID, config: { extra: 'wire' } });
    expect(seen).toEqual({ status: 'closed' });
    expect(await refusal(deps, { extra: 'wire', statsu: 'typo' })).toEqual([{ key: 'statsu', origin: 'wire' }]);
  });
});
