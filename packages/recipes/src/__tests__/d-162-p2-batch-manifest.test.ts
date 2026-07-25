import { describe, expect, it } from 'vitest';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { validateIngredientRefs, type IngredientIssue } from '../validate-ingredients.js';

const aiClassifyInput = {
  'llm.data': null,
  'llm.categories': null,
  'llm.context': null,
  'llm.model_hint': null,
  'llm.id_field': '',
};

const aiClassifyManifest = (
  input: Record<string, unknown> = aiClassifyInput,
): IngredientManifest => ({
  slug: 'ai-classify',
  name: 'AI Classifier',
  description: 'Picks one category from a provided list that best fits the input data.',
  author: 'recued-core',
  kind: 'ai',
  version: 1,
  category: 'ai',
  risk_tier: 'read',
  tags: ['ai', 'classification', 'labeling'],
  input,
  output: {
    category: 'category',
    confidence: 'confidence',
    reasoning: 'reasoning',
  },
});

const recipeWithAiClassifyInput = (input: Record<string, unknown>): RecipeDefinition => ({
  recipe_id: 'd-162-p2-ai-classify',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'D-162 P2 AI classify recipe',
    description: 'Batch ai-classify recipe exercising the D-162 P2 manifest declarations.',
    author: 'test',
    supported_platforms: [],
    tags: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'classify',
      ingredient: 'ai-classify',
      input,
    },
  ],
  output: { sidebar: [] },
} as RecipeDefinition);

const lookup = (manifest: IngredientManifest) =>
  async (slug: string): Promise<IngredientManifest | null> =>
    slug === manifest.slug ? manifest : null;

const codes = (issues: IngredientIssue[]): string[] =>
  issues.map((issue) => issue.code);

const issueFor = (issues: IngredientIssue[], code: string, field: string): IngredientIssue | undefined =>
  issues.find((issue) => issue.code === code && issue.field === field);

describe('D-162 P2 ai batch manifest validation', () => {
  it.each<[string, boolean]>([
    ['non-strict', false],
    ['strict', true],
  ])('accepts batch ai-classify llm.id_field as a declared key in %s mode', async (_label, strict) => {
    const recipe = recipeWithAiClassifyInput({
      'llm.data': [
        { record_id: 'a-1', text: 'Needs implementation help.' },
        { record_id: 'a-2', text: 'Asks about billing.' },
      ],
      'llm.categories': ['engineering', 'billing'],
      'llm.context': 'Classify inbound requests by owning team.',
      'llm.model_hint': 'fast',
      'llm.id_field': 'record_id',
    });

    const issues = await validateIngredientRefs(recipe, lookup(aiClassifyManifest()), { strict });

    expect(issues).toEqual([]);
  });

  it('does not require llm.id_field in single mode, but still requires llm.data', async () => {
    const manifest = aiClassifyManifest();
    const singleModeRecipe = recipeWithAiClassifyInput({
      'llm.data': { text: 'Needs implementation help.' },
      'llm.categories': ['engineering', 'billing'],
      'llm.context': 'Classify inbound requests by owning team.',
      'llm.model_hint': 'fast',
    });

    const singleModeIssues = await validateIngredientRefs(singleModeRecipe, lookup(manifest), { strict: true });

    expect(singleModeIssues).toEqual([]);
    expect(issueFor(singleModeIssues, 'input_required', 'llm.id_field')).toBeUndefined();

    const missingDataRecipe = recipeWithAiClassifyInput({
      'llm.categories': ['engineering', 'billing'],
      'llm.context': 'Classify inbound requests by owning team.',
      'llm.model_hint': 'fast',
    });

    const missingDataIssues = await validateIngredientRefs(missingDataRecipe, lookup(manifest), { strict: true });

    expect(issueFor(missingDataIssues, 'input_required', 'llm.data')).toMatchObject({
      severity: 'error',
      step_id: 'classify',
      ingredient: 'ai-classify',
      code: 'input_required',
      field: 'llm.data',
    });
    expect(issueFor(missingDataIssues, 'input_required', 'llm.id_field')).toBeUndefined();
  });

  it('reports llm.id_field as undeclared when the manifest does not declare it', async () => {
    const strippedInput = Object.fromEntries(
      Object.entries(aiClassifyInput).filter(([key]) => key !== 'llm.id_field'),
    );
    const manifest = aiClassifyManifest(strippedInput);
    const recipe = recipeWithAiClassifyInput({
      'llm.data': [
        { record_id: 'a-1', text: 'Needs implementation help.' },
      ],
      'llm.categories': ['engineering', 'billing'],
      'llm.context': 'Classify inbound requests by owning team.',
      'llm.model_hint': 'fast',
      'llm.id_field': 'record_id',
    });

    const permissiveIssues = await validateIngredientRefs(recipe, lookup(manifest), { strict: false });
    const strictIssues = await validateIngredientRefs(recipe, lookup(manifest), { strict: true });

    expect(codes(permissiveIssues)).toContain('undeclared_input_key_deprecated');
    expect(issueFor(permissiveIssues, 'undeclared_input_key_deprecated', 'llm.id_field')).toMatchObject({
      severity: 'warning',
      step_id: 'classify',
      ingredient: 'ai-classify',
      field: 'llm.id_field',
    });
    expect(codes(strictIssues)).toContain('undeclared_input_key');
    expect(issueFor(strictIssues, 'undeclared_input_key', 'llm.id_field')).toMatchObject({
      severity: 'error',
      step_id: 'classify',
      ingredient: 'ai-classify',
      field: 'llm.id_field',
    });
  });
});
