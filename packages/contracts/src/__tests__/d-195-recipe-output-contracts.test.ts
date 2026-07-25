import { describe, expect, it } from 'vitest';
import type {
  OutputSection,
  OutputType,
  RecipeOutput,
  RecipeOutputAction,
} from '../index.js';

describe('D-195 recipe output contracts', () => {
  it('exports button render sections and recipe.run output actions', () => {
    const outputType: OutputType = 'button';
    const action: RecipeOutputAction = {
      kind: 'recipe.run',
      label: 'Review',
      recipe_id: 'review-recipe',
      config: { status: 'timed_out' },
      context: { entity_id: 'deal-42' },
      variant: 'primary',
      confirm: 'Run review?',
    };
    const section: OutputSection = { type: outputType, source: 'step.actions' };
    const output: RecipeOutput = {
      render: [section],
    };
    const legacyOutput: RecipeOutput = { sidebar: [section] };

    expect(action.kind).toBe('recipe.run');
    expect(output.render?.[0]?.type).toBe('button');
    expect(legacyOutput.sidebar?.[0]?.source).toBe('step.actions');
  });

  it('exports the host-interactive file artifact render section', () => {
    const outputType: OutputType = 'file_artifact';
    const section: OutputSection = {
      type: outputType,
      source: 'step.exact_artifact_cards',
      label: 'Artifacts ready for review',
    };

    expect(section).toEqual({
      type: 'file_artifact',
      source: 'step.exact_artifact_cards',
      label: 'Artifacts ready for review',
    });
  });
});
