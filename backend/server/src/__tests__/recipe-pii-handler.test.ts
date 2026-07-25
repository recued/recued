import { describe, expect, it } from 'vitest';
import type { RecipeDefinition, RecipePiiPostureSummary } from '@recued/contracts';

import {
  listRecipePiiPostures,
  makeRecipePiiHandlers,
} from '../recipe-pii-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { StoredRecipe } from '../types.js';

type Step = Record<string, unknown>;

interface StoreStub extends Pick<RecipeStore, 'listStored' | 'ids' | 'get'> {
  getCalls: string[];
}

const recipeWith = (recipe_id: string, steps: Step[]): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: recipe_id,
    description: 'Fixture for recipe.pii handler tests.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: [],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const cleanRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, []);

const canonicalPromptLeak = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, [
    { id: 'fetch', ingredient: 'contact-reader-hubspot', input: {} },
    {
      id: 'ai',
      ingredient: 'ai-prompt',
      input: { 'llm.prompt': '{{step.fetch.email}} text' },
    },
  ]);

const storedRow = (recipe: RecipeDefinition): StoredRecipe => ({
  recipe_id: recipe.recipe_id,
  publisher_id: 'recued-core',
  version: recipe.version,
  recipe_hash: `hash-${recipe.recipe_id}`,
  recipe_json: JSON.stringify(recipe),
  source: 'pair-sync',
  installed_at: 1,
  pack_slug: null,
});

const storeOf = (options: {
  stored?: StoredRecipe[];
  bundled?: RecipeDefinition[];
  ids?: string[];
} = {}): StoreStub => {
  const stored = options.stored ?? [];
  const bundled = new Map((options.bundled ?? []).map((recipe) => [recipe.recipe_id, recipe]));
  const ids = options.ids ?? [
    ...new Set([...bundled.keys(), ...stored.map((row) => row.recipe_id)]),
  ];
  const getCalls: string[] = [];
  return {
    getCalls,
    listStored: () => stored,
    ids: () => ids,
    get: (id) => {
      getCalls.push(id);
      return bundled.get(id) ?? null;
    },
  };
};

const deps = (store: StoreStub): { store: RecipeStore } => ({
  store: store as unknown as RecipeStore,
});

const expectedCanonicalPromptLeakSummary = (): RecipePiiPostureSummary => ({
  headline: '1 AI step sends unprotected PII to the model at run time — manual protection needed.',
  auto_protected: [],
  warnings: [
    {
      step_id: 'ai',
      message:
        "AI step 'ai' (ai-prompt) receives unprotected PII: llm.prompt (email) — "
        + 'alias upstream with a pii-protect / pii-restore bracket '
        + '(llm.pii_fields is not defined for this payload shape) '
        + '(auto-protection declined: no payload source offers a runtime-walkable tag set)',
    },
  ],
  infos: [],
});

describe('listRecipePiiPostures', () => {
  it('assesses the stored row when a bundled recipe has the same recipe_id', () => {
    const store = storeOf({
      stored: [storedRow(cleanRecipe('shared-recipe'))],
      bundled: [canonicalPromptLeak('shared-recipe')],
      ids: ['shared-recipe'],
    });

    expect(listRecipePiiPostures(deps(store))).toEqual({ recipes: [] });
    expect(store.getCalls).toEqual([]);
  });

  it('omits clean recipes and returns non-clean entries sorted by recipe_id', () => {
    const store = storeOf({
      stored: [storedRow(canonicalPromptLeak('z-stored-leak'))],
      bundled: [
        cleanRecipe('m-clean'),
        canonicalPromptLeak('a-bundled-leak'),
      ],
      ids: ['m-clean', 'a-bundled-leak', 'z-stored-leak'],
    });

    expect(listRecipePiiPostures(deps(store))).toEqual({
      recipes: [
        {
          recipe_id: 'a-bundled-leak',
          summary: expectedCanonicalPromptLeakSummary(),
        },
        {
          recipe_id: 'z-stored-leak',
          summary: expectedCanonicalPromptLeakSummary(),
        },
      ],
    });
  });

  it('returns an empty recipes array when the store has no recipes', () => {
    expect(listRecipePiiPostures(deps(storeOf()))).toEqual({ recipes: [] });
  });
});

describe('makeRecipePiiHandlers', () => {
  it('returns undefined when deps are absent (rpc surfaces not_configured)', () => {
    expect(makeRecipePiiHandlers(undefined)).toBeUndefined();
  });
});
