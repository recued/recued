/** The page watcher's memory settles with the run — through the real recipe
 *  runner (`handleExecute`), as an auto-run check runs it.
 *
 *  With `once_per_change` the watcher holds the page a fire reported until the
 *  run that reported it settles (`watchers/http-watcher-memory.ts`). The
 *  settling is `execute-handler.ts`'s, where it records the run: a completed
 *  run moves the memory on, a failed one leaves the change to the next check.
 *  The watcher's own tests call the settle by hand, so only a run through the
 *  handler shows it is actually called, and with the right outcome. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { createInMemoryStore } from '@recued/cache';
import type { Commit, RecipeDefinition, RecipeStep } from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createWatcherDispatcher } from '../watchers/index.js';

const URL_A = 'https://example.com/pricing';

/** A page watch whose one step stands for the comparison, and can fail as a
 *  model call does. */
const WATCH: RecipeDefinition = {
  recipe_id: 'page-watch',
  version: 1,
  ttl: 0,
  metadata: { name: 'Page watch', description: 'Watch one page.', author: 'test', supported_platforms: ['test'] },
  variables: {},
  auto_run: { interval_ms: 3_600_000, dynamic: false },
  trigger_steps: [
    { id: 'page', ingredient: 'http-watcher', input: { target_url: URL_A, once_per_change: true } } as unknown as RecipeStep,
  ],
  prefetch_steps: [],
  // Its input follows the page, as a comparison's does, so no cached answer stands in.
  steps: [{ id: 'compare', ingredient: 'shared-read', input: { key: 'compare.{{trigger.page.hash}}' } } as unknown as RecipeStep],
  output: { sidebar: [] },
} as RecipeDefinition;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const harness = () => {
  const dir = mkdtempSync(join(tmpdir(), 'http-watcher-memory-execute-'));
  const db = new Database(join(dir, 'recued.db'));
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const state = { page: '<p>Plan A $10</p>', compareFails: false };
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) {
    if (manifest.slug === 'http-watcher' || manifest.slug === 'shared-read') manifests.register(manifest);
  }
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(WATCH);
  const read = vi.fn(async ({ key }: { key: string }) => {
    if (state.compareFails) throw new Error('the model did not answer');
    return { found: false, key };
  });
  const fetchFn = (async () => new Response(state.page, { status: 200 })) as unknown as typeof fetch;
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests,
      cacheStore: createInMemoryStore(),
      instanceId: 'pair-1',
      kernelDispatchers: { read, watcher: createWatcherDispatcher({ db, fetchFn }) },
    },
    baseVault: {},
    instanceId: 'pair-1',
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    db,
  };
  const check = () => handleExecute(deps, {
    recipe_id: 'page-watch',
    trigger_source: 'auto_run',
    execution_source: { channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'page-watch' },
  });
  const memory = () => db.prepare(
    'SELECT body, pending_run_id FROM http_watcher_memory WHERE recipe_id = ? AND target_url = ?',
  ).get('page-watch', URL_A) as { body: string | null; pending_run_id: string | null } | undefined;
  return { state, check, memory, read };
};

describe('the page watcher’s memory settles with the run', () => {
  it('⛔ a run that fails after the fire leaves the change to be reported at the next check', async () => {
    const h = harness();
    const first = await h.check();
    expect(first.success, JSON.stringify(first.errors)).toBe(true);
    expect(first.trigger_skipped).toBeFalsy();
    expect(h.memory()).toEqual({ body: '<p>Plan A $10</p>', pending_run_id: null });

    expect((await h.check()).trigger_skipped).toBe(true);

    h.state.page = '<p>Plan A $12</p>';
    h.state.compareFails = true;
    const failed = await h.check();
    expect(failed.trigger_skipped).toBeFalsy();
    expect(failed.success).toBe(false);
    expect(h.memory()).toEqual({ body: '<p>Plan A $10</p>', pending_run_id: null });

    h.state.compareFails = false;
    const retried = await h.check();
    expect(retried.trigger_skipped).toBeFalsy();
    expect(retried.success, JSON.stringify(retried.errors)).toBe(true);
    expect(h.memory()).toEqual({ body: '<p>Plan A $12</p>', pending_run_id: null });

    expect((await h.check()).trigger_skipped).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(3);
  });
});
