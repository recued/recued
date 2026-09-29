/** Read fresh before a write — through the real recipe runner.
 *
 *  `handleExecute` composes both cache tiers from `executorConfig.cacheStore`
 *  and hands the engine the server's step classifier (`step-effect.ts`). A
 *  check-then-mark recipe run twice must read its mark both times — cached, the
 *  second run was answered with the first run's "not found" and did the work
 *  again. A recipe that only reads keeps its cache. */

import { createInMemoryStore } from '@recued/cache';
import type { Commit, RecipeDefinition, RecipeStep } from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const MARK = 'drive.mark.meeting-1';

const recipe = (recipe_id: string, steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: recipe_id,
    description: 'Read fresh before a write, through the recipe runner.',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const readMark = { id: 'seen', ingredient: 'shared-read', input: { key: MARK } } as unknown as RecipeStep;
const writeMark = {
  id: 'mark', ingredient: 'shared-write', input: { key: MARK, value: { done: true } },
} as unknown as RecipeStep;

const CHECK_THEN_MARK = recipe('check-then-mark', [readMark, writeMark]);
const VIEW_MARK = recipe('view-mark', [readMark]);

const harness = () => {
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) {
    if (manifest.slug === 'shared-read' || manifest.slug === 'shared-write') manifests.register(manifest);
  }
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(CHECK_THEN_MARK);
  recipeStore.register(VIEW_MARK);
  const read = vi.fn(async ({ key }: { key: string }) => ({ found: false, key }));
  const write = vi.fn(async ({ key }: { key: string }) => ({ ok: true as const, key, bytes_written: 1 }));
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests,
      cacheStore: createInMemoryStore(),
      instanceId: 'pair-1',
      kernelDispatchers: { read, write },
    },
    baseVault: {},
    instanceId: 'pair-1',
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
  };
  const run = (recipe_id: string) => handleExecute(deps, {
    recipe_id,
    trigger_source: 'manual',
    execution_source: { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'token-1' },
  });
  return { run, read, write };
};

describe('read fresh before a write — the recipe runner composes it', () => {
  it('⛔ a check-then-mark recipe reads its mark on every run', async () => {
    const h = harness();
    const first = await h.run('check-then-mark');
    const second = await h.run('check-then-mark');
    expect(first.success, JSON.stringify(first.errors)).toBe(true);
    expect(second.success, JSON.stringify(second.errors)).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.write).toHaveBeenCalledTimes(2);
  });

  it('a recipe that only reads the mark keeps its cache', async () => {
    const h = harness();
    await h.run('view-mark');
    await h.run('view-mark');
    expect(h.read).toHaveBeenCalledTimes(1);
  });
});
