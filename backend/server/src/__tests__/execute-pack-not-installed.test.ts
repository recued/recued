/** `pack_not_installed` — the typed run failure an install offer can act on.
 *
 *  A recipe naming a pack that is not installed cannot lower:
 *  `lowerSequentialStep` throws `CanonicalOpResolutionError` for "a two-tier id
 *  that resolves to nothing" before step 1. That already fails fast, so the run
 *  was never the problem — the DIAGNOSTIC was. It arrived as a generic
 *  `bad_request` with the pack slug embedded in a sentence, and a surface that
 *  wants to offer "Install officecli" would have had to parse an error message
 *  to find out what to install.
 *
 *  `RpcError.details` exists for exactly this: "renderers can switch on typed
 *  fields instead of parsing the message text".
 *
 *  ⚠ THE LIST MUST BE COMPLETE. Lowering throws on whichever op-step it reaches
 *  first, so its own message names ONE pack; a caller who installs that and
 *  re-runs is then told about the next. `depends_on` carries the whole set up
 *  front, which is what makes a single offer — and a single install click —
 *  possible. That completeness is the property most worth pinning, because a
 *  one-pack-at-a-time offer would still look like it worked.
 */
import { describe, expect, it } from 'vitest';
import { RpcError, type RecipeDefinition } from '@recued/contracts';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

/** A recipe whose only step is a Tier-P op of `pack`, declared in `depends_on`. */
const packRecipe = (recipe_id: string, packs: string[]): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'calls a pack op',
    author: 'recued-core',
    supported_platforms: [],
  },
  depends_on: packs,
  variables: {},
  prefetch_steps: [],
  steps: packs.map((ref, i) => ({ id: `s${String(i)}`, op: `${ref}.document.to_markdown` })),
  output: { render: [] },
} as unknown as RecipeDefinition);

/** `installed` names the pack slugs whose inventory row + op-declaring manifest
 *  exist — the two halves `buildPackOpResolution` needs to mint a `pack_ref`. */
const makeDeps = (recipe: RecipeDefinition, installed: string[]): ExecuteHandlerDeps => {
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: {
      manifests: {
        ...manifests,
        get: (slug: string) => (installed.includes(slug)
          ? { slug, operations: { 'document.to_markdown': {} } }
          : undefined),
      },
    },
    baseVault: {},
    contractScan: ((scope: string) => (scope === 'installed_pack'
      ? installed.map((slug) => ({
          segments: [slug],
          value: { publisher: 'recued-core', ingredient_ids: [slug] },
        }))
      : [])),
  } as unknown as ExecuteHandlerDeps;
};

const runAndCatch = async (deps: ExecuteHandlerDeps, recipe_id: string): Promise<RpcError> => {
  try {
    await handleExecute(deps, { recipe_id } as never);
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected handleExecute to throw');
};

describe('handleExecute — pack_not_installed', () => {
  it('fails with a typed code and the pack as DATA, not prose', async () => {
    const recipe = packRecipe('parse-a-pdf', ['recued-core.docling']);
    const err = await runAndCatch(makeDeps(recipe, []), 'parse-a-pdf');

    expect(err.code).toBe('pack_not_installed');
    // The offer reads this, never the message.
    expect((err.details as { missing_packs?: string[] })?.missing_packs)
      .toEqual(['recued-core.docling']);
    // The message stays human-readable, but is not the contract.
    expect(err.message).toMatch(/recued-core\.docling/);
  });

  it('names EVERY missing pack in one failure', async () => {
    // ⛔ The property a one-at-a-time offer would fail: lowering itself would
    // have named only whichever op-step it reached first.
    const recipe = packRecipe('multi', [
      'recued-core.docling', 'recued-core.whisper', 'recued-core.ffmpeg',
    ]);
    const err = await runAndCatch(makeDeps(recipe, []), 'multi');
    expect((err.details as { missing_packs?: string[] })?.missing_packs).toEqual([
      'recued-core.docling', 'recued-core.whisper', 'recued-core.ffmpeg',
    ]);
  });

  it('lists only the packs actually missing', async () => {
    const recipe = packRecipe('partly', ['recued-core.docling', 'recued-core.whisper']);
    const err = await runAndCatch(makeDeps(recipe, ['docling']), 'partly');
    expect((err.details as { missing_packs?: string[] })?.missing_packs)
      .toEqual(['recued-core.whisper']);
  });

  it('does not claim pack_not_installed when the packs ARE installed', async () => {
    // Whatever else may fail downstream, it must not be this code — otherwise
    // the surface offers an install that would change nothing.
    const recipe = packRecipe('ok', ['recued-core.docling']);
    try {
      await handleExecute(makeDeps(recipe, ['docling']), { recipe_id: 'ok' } as never);
    } catch (e) {
      expect((e as RpcError).code).not.toBe('pack_not_installed');
    }
  });
});
