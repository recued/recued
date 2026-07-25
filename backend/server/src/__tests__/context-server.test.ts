/** Server-side `context.server` injection — when a recipe runs on
 *  the server, `handleExecute` populates `context.server` so recipes
 *  see `{available: true, name: <serverName>}` (or whatever the
 *  caller pre-set, which wins). Caller-supplied values always win.
 *
 *  `handleExecute`'s response shape strips per-step `result` for
 *  privacy/size, so we exercise the injection through `skip_when` —
 *  a step that runs vs. is skipped is the cleanest observable signal
 *  that `{{context.server.available}}` resolved to the expected value. */

import { describe, it, expect } from 'vitest';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type { RecipeDefinition } from '@recued/contracts';

/** Recipe with two transform steps:
 *    - `gated_on_server` runs only when `context.server.available` is true
 *    - `gated_off_server` runs only when `context.server.available` is false
 *  We then inspect each step's `skipped` flag to confirm what value
 *  the resolver saw. */
const PROBE_RECIPE: RecipeDefinition = {
  recipe_id: 'probe-context-server',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Probe context.server',
    description: 'Gates two transforms on context.server.available',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'gated_on_server',
      transform: 'template',
      template: 'ran',
      skip_when: '{{context.server.available}} equal false',
    },
    {
      id: 'gated_off_server',
      transform: 'template',
      template: 'ran',
      skip_when: '{{context.server.available}} equal true',
    },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

const makeDeps = (overrides: Partial<ExecuteHandlerDeps> = {}): ExecuteHandlerDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(PROBE_RECIPE);
  return {
    recipeStore,
    executorConfig: { manifests },
    baseVault: {},
    ...overrides,
  };
};

const wasSkipped = (
  result: Awaited<ReturnType<typeof handleExecute>>,
  id: string,
): boolean | undefined => result.steps.find((s) => s.id === id)?.skipped;

describe('handleExecute — context.server injection', () => {
  it('default injection makes context.server.available=true (server is calling itself)', async () => {
    const deps = makeDeps({ serverName: 'My Recued Server' });
    const result = await handleExecute(deps, { recipe_id: 'probe-context-server' });
    expect(result.success).toBe(true);
    // `available=true` → gated_on_server runs, gated_off_server skips.
    expect(wasSkipped(result, 'gated_on_server')).toBe(false);
    expect(wasSkipped(result, 'gated_off_server')).toBe(true);
  });

  it('caller-supplied context.server={available:false} wins (no overwrite)', async () => {
    const deps = makeDeps({ serverName: 'Should-Not-Win' });
    const result = await handleExecute(deps, {
      recipe_id: 'probe-context-server',
      context: { server: { available: false } },
    });
    expect(result.success).toBe(true);
    // `available=false` → gated_on_server skips, gated_off_server runs.
    expect(wasSkipped(result, 'gated_on_server')).toBe(true);
    expect(wasSkipped(result, 'gated_off_server')).toBe(false);
  });
});
