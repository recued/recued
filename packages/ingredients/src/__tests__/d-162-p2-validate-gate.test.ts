import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import { validateIngredient } from '../validate.js';

const AI_COMPARE_ID_FIELD_FORBIDDEN = 'ai_compare_id_field_forbidden';

const aiCompareManifest = (
  input: Record<string, unknown> = {
    'llm.data_a': null,
    'llm.data_b': null,
    'llm.dimensions': null,
    'llm.model_hint': null,
  },
): IngredientManifest => ({
  slug: 'ai-compare',
  name: 'AI Comparator',
  description: 'Compares two pieces of data and produces a structured diff.',
  author: 'recued-core',
  kind: 'ai',
  version: 1,
  category: 'ai',
  risk_tier: 'read',
  tags: ['ai', 'comparison', 'analysis'],
  input,
  output: {
    differences: 'differences',
    similarities: 'similarities',
    recommendation: 'recommendation',
  },
});

const aiClassifyManifest = (): IngredientManifest => ({
  slug: 'ai-classify',
  name: 'AI Classifier',
  description: 'Picks one category from a provided list that best fits the input data.',
  author: 'recued-core',
  kind: 'ai',
  version: 1,
  category: 'ai',
  risk_tier: 'read',
  tags: ['ai', 'classification', 'labeling'],
  input: {
    'llm.data': null,
    'llm.categories': null,
    'llm.context': null,
    'llm.model_hint': null,
    'llm.id_field': '',
  },
  output: {
    category: 'category',
    confidence: 'confidence',
    reasoning: 'reasoning',
  },
});

const codesOf = (manifest: unknown): string[] =>
  validateIngredient(manifest).issues.map((issue) => issue.code);

const aiCompareManifestWithoutInput = (): Omit<IngredientManifest, 'input'> => {
  const manifest: Partial<IngredientManifest> = { ...aiCompareManifest() };
  delete manifest.input;
  return manifest as Omit<IngredientManifest, 'input'>;
};

describe('D-162 P2 validateAiBatch gate', () => {
  it('rejects ai-compare when llm.id_field is declared with an empty string default', () => {
    const result = validateIngredient(aiCompareManifest({
      'llm.data_a': null,
      'llm.data_b': null,
      'llm.dimensions': null,
      'llm.model_hint': null,
      'llm.id_field': '',
    }));

    expect(result.valid).toBe(false);
    expect(result.issues.find((issue) => issue.code === AI_COMPARE_ID_FIELD_FORBIDDEN)).toMatchObject({
      severity: 'error',
      code: AI_COMPARE_ID_FIELD_FORBIDDEN,
      path: 'input.llm.id_field',
    });
  });

  it('rejects ai-compare when llm.id_field is declared with a null default', () => {
    const result = validateIngredient(aiCompareManifest({
      'llm.data_a': null,
      'llm.data_b': null,
      'llm.dimensions': null,
      'llm.model_hint': null,
      'llm.id_field': null,
    }));

    expect(result.valid).toBe(false);
    expect(result.issues.find((issue) => issue.code === AI_COMPARE_ID_FIELD_FORBIDDEN)).toMatchObject({
      severity: 'error',
      code: AI_COMPARE_ID_FIELD_FORBIDDEN,
      path: 'input.llm.id_field',
    });
  });

  it('allows ai-compare when llm.id_field is not declared', () => {
    const result = validateIngredient(aiCompareManifest());

    expect(result.valid).toBe(true);
    expect(result.issues.map((issue) => issue.code)).not.toContain(AI_COMPARE_ID_FIELD_FORBIDDEN);
  });

  it('allows batch-capable ai-classify to declare llm.id_field', () => {
    const result = validateIngredient(aiClassifyManifest());

    expect(result.valid).toBe(true);
    expect(result.issues.map((issue) => issue.code)).not.toContain(AI_COMPARE_ID_FIELD_FORBIDDEN);
  });

  it.each([
    ['missing input', aiCompareManifestWithoutInput()],
    ['array input', { ...aiCompareManifest(), input: [] }],
    ['string input', { ...aiCompareManifest(), input: 'not-an-object' }],
  ])('does not throw or emit the ai-compare batch gate when %s', (_label, manifest) => {
    expect(codesOf(manifest)).not.toContain(AI_COMPARE_ID_FIELD_FORBIDDEN);
  });
});
