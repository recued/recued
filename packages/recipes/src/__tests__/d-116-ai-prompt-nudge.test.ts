/** D-116 Phase 8 — ai_prompt_legacy_shape validator nudge. */

import { describe, it, expect } from 'vitest';
import { validateIngredientRefs } from '../validate-ingredients.js';
import type { RecipeDefinition, IngredientManifest } from '@recued/contracts';

const aiPromptManifest: IngredientManifest = {
  slug: 'ai-prompt',
  name: 'AI Custom Prompt',
  description: 'Uncontracted escape hatch.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {
    'llm.system_prompt': null,
    'llm.prompt': null,
    'llm.instruction_block': null,
    'llm.data_block': null,
    'llm.output_format': null,
    'llm.model_hint': null,
    'llm.allow_search': null,
  },
  output: { result: 'result' },
};

const lookup = async (slug: string): Promise<IngredientManifest | null> =>
  slug === 'ai-prompt' ? aiPromptManifest : null;

const baseRecipe = (stepInput: Record<string, unknown>): RecipeDefinition => ({
  recipe_id: 'd116-nudge-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-116 nudge test',
    description: 'Exercises the ai_prompt_legacy_shape warning.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'ai-prompt', 'nudge'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'ai', ingredient: 'ai-prompt', input: stepInput } as unknown as RecipeDefinition['steps'][number],
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

describe('validateIngredientRefs — ai_prompt_legacy_shape', () => {
  it('emits the warning when only legacy fields are set', async () => {
    const issues = await validateIngredientRefs(
      baseRecipe({
        'llm.system_prompt': 'You are a helper.',
        'llm.prompt': 'Say hi.',
      }),
      lookup,
    );
    expect(issues.some((i) => i.code === 'ai_prompt_legacy_shape')).toBe(true);
  });

  it('does NOT emit the warning when new fields are present', async () => {
    const issues = await validateIngredientRefs(
      baseRecipe({
        'llm.instruction_block': 'You are a helper.',
        'llm.data_block': 'Say hi.',
      }),
      lookup,
    );
    expect(issues.some((i) => i.code === 'ai_prompt_legacy_shape')).toBe(false);
  });

  it('does NOT emit the warning when recipe uses both new + legacy (migrating)', async () => {
    const issues = await validateIngredientRefs(
      baseRecipe({
        'llm.system_prompt': 'You are a helper.',
        'llm.instruction_block': 'You are a helper.',
        'llm.data_block': 'Say hi.',
      }),
      lookup,
    );
    expect(issues.some((i) => i.code === 'ai_prompt_legacy_shape')).toBe(false);
  });
});
