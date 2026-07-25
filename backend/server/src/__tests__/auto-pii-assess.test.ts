import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition, RecipePiiPostureSummary } from '@recued/contracts';

import { assessRecipePiiPosture } from '../auto-pii-apply.js';

type Step = Record<string, unknown>;

const recipeWith = (recipe_id: string, steps: Step[]): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: recipe_id,
    description: 'Fixture for auto-PII assessment tests.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['pii', 'test'],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const cleanRecipe = (): RecipeDefinition => recipeWith('clean-pii-recipe', []);

const canonicalInjectableLeak = (): RecipeDefinition => recipeWith('canonical-injectable-leak', [
  { id: 'contact', ingredient: 'contact-reader-hubspot', input: {} },
  {
    id: 'ai',
    ingredient: 'ai-classify',
    input: {
      'llm.data': '{{step.contact}}',
      'llm.categories': ['review'],
    },
  },
]);

const expectedAutoSummary = (): RecipePiiPostureSummary => ({
  headline: 'Recued will auto-protect 1 AI step at run time.',
  auto_protected: [
    {
      step_id: 'ai',
      message:
        "AI step 'ai' (ai-classify): Recued injects llm.pii_fields at run time — "
        + 'company (org), email (email), first_name (name), last_name (name), '
        + 'name (name), phone (phone) aliased before egress.',
    },
  ],
  warnings: [],
  infos: [],
});

const expectedManualSummary = (): RecipePiiPostureSummary => ({
  headline: '1 AI step sends unprotected PII to the model at run time — manual protection needed.',
  auto_protected: [],
  warnings: [
    {
      step_id: 'ai',
      message:
        "AI step 'ai' (ai-classify) receives unprotected PII: "
        + 'llm.data.email (email), llm.data.name (name), llm.data.first_name (name), '
        + 'llm.data.last_name (name), llm.data.phone (phone), llm.data.company (org) — '
        + 'declaring llm.pii_fields on these paths (or letting auto-PII inject it) aliases them before egress',
    },
  ],
  infos: [],
});

describe('assessRecipePiiPosture', () => {
  let priorAutoPii: string | undefined;

  beforeEach(() => {
    priorAutoPii = process.env.RECUED_AUTO_PII;
    delete process.env.RECUED_AUTO_PII;
  });

  afterEach(() => {
    if (priorAutoPii === undefined) delete process.env.RECUED_AUTO_PII;
    else process.env.RECUED_AUTO_PII = priorAutoPii;
  });

  it('returns null for a clean recipe', () => {
    expect(assessRecipePiiPosture(cleanRecipe())).toBeNull();
  });

  it('returns an auto_protected summary for a canonical leak the applicator covers', () => {
    expect(assessRecipePiiPosture(canonicalInjectableLeak())).toEqual(expectedAutoSummary());
  });

  it('does not claim auto protection when RECUED_AUTO_PII=off', () => {
    process.env.RECUED_AUTO_PII = 'off';

    expect(assessRecipePiiPosture(canonicalInjectableLeak())).toEqual(expectedManualSummary());
  });

  it('returns null when assessment throws', () => {
    const throwingRecipe = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'steps') throw new Error('steps unavailable');
        return undefined;
      },
    });

    expect(assessRecipePiiPosture(throwingRecipe)).toBeNull();
  });
});
