/** D-302 — a variable a recipe RETIRED: a value still saved for it is dropped before
 *  the run, not refused.
 *
 *  D-222 refuses any config key the recipe does not declare, from every contributor,
 *  including the install config the owner saved earlier. So an update that drops a
 *  variable stopped EVERY run of an owner who had ever saved it, and nothing prunes
 *  those overlays. The importers' thousands separator is the first variable dropped
 *  this way; `metadata.retired_variables` says the knob is gone on purpose.
 *
 *  Driven through `handleExecute` with a real dish store holding the install config
 *  (the `is_default` dish), exactly where a saved thousands separator lives. The
 *  engine is mocked only to capture what the run would have seen.
 *
 *  The shipped importers' half is `d-302-retired-variables-shipped-importers.test.ts`,
 *  apart because it reads `community/recipes`, and the public export drops any test
 *  file that does — these boundary tests need nothing from the corpus. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ExecutionResult } from '@recued/engine';
import {
  RpcError,
  UNDECLARED_CONFIG_ARGUMENT,
  type RecipeDefinition,
  type RecipeStep,
  type UndeclaredConfigArgumentDetails,
} from '@recued/contracts';

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

const RECIPE_ID = 'd-302-retired';

/** The shipped importers' carry: a saved thousands mark of "." means the comma. */
const CARRY = [{ variable: 'thousands_separator', when: '.', set: { decimal_mark: 'Comma: 1.234,56' } }];

const recipeWith = (retired: string[] | undefined, carries?: typeof CARRY): RecipeDefinition => ({
  recipe_id: RECIPE_ID,
  version: 6,
  ttl: 60,
  metadata: {
    name: RECIPE_ID,
    description: 'Fixture for D-302 retired variables.',
    author: 'test',
    supported_platforms: ['test'],
    ...(retired === undefined ? {} : { retired_variables: retired }),
    ...(carries === undefined ? {} : { retired_carries: carries }),
  },
  variables: { decimal_mark: 'Point: 1,234.56' },
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['a', 'b'] } as unknown as RecipeStep],
  output: { render: [] },
}) as RecipeDefinition;

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

/** The install config the owner saved under an earlier version: a thousands
 *  separator, beside a setting the recipe still declares. */
const depsWith = (
  retired: string[] | undefined,
  saved: Record<string, unknown> = { thousands_separator: ',', decimal_mark: 'Comma: 1.234,56' },
  carries?: typeof CARRY,
): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipeWith(retired, carries));
  const db = new Database(':memory:');
  dbs.push(db);
  const dishStore = createDishStore(db);
  dishStore.set({
    dish_id: 'dsh_install', recipe_id: RECIPE_ID, publisher_id: 'recued-core', name: '', is_default: true,
    config_overlay: saved, enabled: true, created_at: 1,
  });
  return {
    recipeStore,
    dishStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'd-302-retired-test',
  };
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

describe('D-302 — a retired variable\'s saved value is dropped, not refused', () => {
  it('⛔ the control: without the retirement, the saved thousands separator refuses every run', async () => {
    const thrown = await handleExecute(depsWith(undefined), { recipe_id: RECIPE_ID }).then(() => null, (e) => e);
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe(UNDECLARED_CONFIG_ARGUMENT);
    expect(((thrown as RpcError).details as unknown as UndeclaredConfigArgumentDetails).undeclared)
      .toEqual([{ key: 'thousands_separator', origin: 'overlay' }]);
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('retired, the run goes ahead: the saved value is dropped and the rest of the install config applies', async () => {
    const result = await handleExecute(depsWith(['thousands_separator']), { recipe_id: RECIPE_ID });
    expect(result.success).toBe(true);
    expect(seen).toEqual({ decimal_mark: 'Comma: 1.234,56' });
  });

  it('a stale client sending it on the wire is dropped the same way', async () => {
    await handleExecute(depsWith(['thousands_separator']), {
      recipe_id: RECIPE_ID, config: { thousands_separator: '.', decimal_mark: 'Point: 1,234.56' },
    });
    expect(seen).toEqual({ decimal_mark: 'Point: 1,234.56' });
  });

  it('⛔⛔ a retired value that still means something is carried: a saved "." thousands mark is the comma', async () => {
    // Integrity audit, 2026-09-24: an owner whose importer (v1) saved "." had it
    // dropped and the decimal mark defaulted to the point, so 1.200 read as 1.2.
    await handleExecute(depsWith(['thousands_separator'], { thousands_separator: '.' }, CARRY), { recipe_id: RECIPE_ID });
    expect(seen).toEqual({ decimal_mark: 'Comma: 1.234,56' });
    // The owner's own decimal mark always wins…
    await handleExecute(depsWith(['thousands_separator'], { thousands_separator: '.', decimal_mark: 'Point: 1,234.56' }, CARRY),
      { recipe_id: RECIPE_ID });
    expect(seen).toEqual({ decimal_mark: 'Point: 1,234.56' });
    // …and any other saved mark carries nothing.
    await handleExecute(depsWith(['thousands_separator'], { thousands_separator: ',' }, CARRY), { recipe_id: RECIPE_ID });
    expect(seen).toEqual({});
  });

  it('⛔ retiring one name is not a blanket pass: any other undeclared key is still refused', async () => {
    const thrown = await handleExecute(depsWith(['thousands_separator']), {
      recipe_id: RECIPE_ID, config: { thousand_separator: ',' },
    }).then(() => null, (e) => e);
    expect(((thrown as RpcError).details as unknown as UndeclaredConfigArgumentDetails).undeclared)
      .toEqual([{ key: 'thousand_separator', origin: 'wire' }]);
  });
});
