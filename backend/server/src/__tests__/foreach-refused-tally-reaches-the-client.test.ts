/** A `foreach`'s per-item failures must reach the CLIENT, not just the step log.
 *
 *  ⛔⛔ Why. A foreach is continue-on-error: a refused item lands in that item's
 *  `{ ok: false }` while the STEP returns `error: null`. So `errors[]` stays
 *  empty and `success` stays true — correct, because a partial write is not a
 *  failed run, and catastrophic, because "every item refused" then renders
 *  identically to "every item written". Three defects shipped in one pack that
 *  way, each reporting success having written nothing.
 *
 *  ⚠ The projection in `execute-handler.ts` is an ENUMERATING copier — it names
 *  the StepLog fields it forwards and drops `result` (which can be megabytes).
 *  A field added to `StepLog` therefore reaches NO client until it is listed
 *  there, and nothing type-checks that omission because the field is optional.
 *  This file is the pin for that one line.
 */
import { describe, expect, it } from 'vitest';

import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const SLUG = 'foreach-tally-http';

const manifest = (): IngredientManifest => ({
  slug: SLUG,
  name: 'Foreach tally probe',
  description: 'Posts one row.',
  author: 'test',
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  version: 1,
  input: { method: 'POST', url: 'https://example.test/{{item.id}}' },
  output: { ok: 'ok' },
} as unknown as IngredientManifest);

const recipe = (): RecipeDefinition => ({
  recipe_id: 'foreach-tally',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Foreach tally', description: 'Writes each row.',
    author: 'test', supported_platforms: ['test'], tags: ['test'],
  },
  variables: { rows: { label: 'Rows', type: 'array', default: [] } },
  prefetch_steps: [],
  steps: [{ id: 'write_each', ingredient: SLUG, input: {}, foreach: '{{config.rows}}' }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const deps = (): ExecuteHandlerDeps => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(manifest());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe());
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'foreach-tally-test',
  } as unknown as ExecuteHandlerDeps;
};

/** `bad` ids are refused by the endpoint; everything else succeeds. */
const run = async (ids: readonly string[]) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const refused = String(url).includes('bad');
    return {
      ok: !refused,
      status: refused ? 500 : 200,
      statusText: refused ? 'Server Error' : 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: !refused }),
      text: async () => JSON.stringify({ ok: !refused }),
    };
  }) as unknown as typeof fetch;
  try {
    return await handleExecute(deps(), {
      recipe_id: 'foreach-tally',
      trigger_source: 'manual',
      config: { rows: ids.map((id) => ({ id })) },
    } as never);
  } finally {
    globalThis.fetch = original;
  }
};

const tally = (result: Awaited<ReturnType<typeof run>>) =>
  (result.steps.find((s) => s.id === 'write_each') as
    { foreach?: { items: number; failed: number } } | undefined)?.foreach;

describe('the refused-item tally survives the wire projection', () => {
  it('carries the counts to the client', async () => {
    expect(tally(await run(['ok_1', 'bad_2', 'bad_3']))).toEqual({ items: 3, failed: 2 });
  });

  it('carries a TOTAL wipe-out — the run that used to look like success', async () => {
    const result = await run(['bad_1', 'bad_2']);
    // ⛔ Unchanged and deliberate: the step succeeded, so the RUN succeeded.
    // Everything a client had before this said the same thing about a run that
    // wrote both rows. The tally is the whole difference.
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(tally(result)).toEqual({ items: 2, failed: 2 });
  });

  it('carries a clean run as zero rather than omitting it', async () => {
    // A surface distinguishes "nothing failed" from "not a foreach"; collapsing
    // the first into the second would make a clean loop indistinguishable from
    // an ordinary step, and the count unreportable.
    expect(tally(await run(['ok_1', 'ok_2']))).toEqual({ items: 2, failed: 0 });
  });

  it('omits it entirely for a step that is not a foreach', async () => {
    const registry = createManifestRegistry('/nonexistent');
    registry.register(manifest());
    const store = createRecipeStore('/nonexistent');
    const plain = recipe() as unknown as { steps: Array<Record<string, unknown>>; recipe_id: string };
    delete plain.steps[0]!.foreach;
    plain.recipe_id = 'foreach-tally-plain';
    store.register(plain as unknown as RecipeDefinition);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }), text: async () => '{"ok":true}',
    })) as unknown as typeof fetch;
    try {
      const result = await handleExecute({
        recipeStore: store,
        executorConfig: { manifests: registry },
        baseVault: {},
        instanceId: 'foreach-tally-test',
      } as unknown as ExecuteHandlerDeps, {
        recipe_id: 'foreach-tally-plain', trigger_source: 'manual',
      } as never);
      expect((result.steps[0] as { foreach?: unknown }).foreach).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
