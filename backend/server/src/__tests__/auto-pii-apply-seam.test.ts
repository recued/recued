import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { applyAutoPiiForExecution } from '../auto-pii-apply.js';

type Step = Record<string, unknown>;

let previousAutoPiiEnv: string | undefined;

beforeEach(() => {
  previousAutoPiiEnv = process.env.RECUED_AUTO_PII;
  delete process.env.RECUED_AUTO_PII;
});

afterEach(() => {
  if (previousAutoPiiEnv === undefined) delete process.env.RECUED_AUTO_PII;
  else process.env.RECUED_AUTO_PII = previousAutoPiiEnv;
  vi.restoreAllMocks();
});

const recipeWith = (steps: Step[], recipe_id = 'auto-pii-seam'): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Auto PII seam',
    description: 'Fixture for auto-PII dispatch seam tests.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['pii', 'test'],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const leakingRecipe = (): RecipeDefinition => recipeWith([
  { id: 'mail', ingredient: 'mail-get' },
  {
    id: 'prompt',
    ingredient: 'ai-prompt',
    input: { 'llm.prompt': '{{step.mail.record.hot_fields}}' },
  },
], 'auto-pii-leak');

const stepsOf = (recipe: RecipeDefinition): Step[] => recipe.steps as unknown as Step[];

describe('applyAutoPiiForExecution', () => {
  it('passes recipes through unchanged when RECUED_AUTO_PII is off', () => {
    process.env.RECUED_AUTO_PII = 'off';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = leakingRecipe();

    const result = applyAutoPiiForExecution(recipe);

    expect(result).toBe(recipe);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the same object reference for a recipe with no findings', () => {
    const recipe = recipeWith([
      { id: 'count', transform: 'count', input: [] },
    ]);

    const result = applyAutoPiiForExecution(recipe);

    expect(result).toBe(recipe);
  });

  it('rewrites a leaking canonical-classified recipe with synthesized protect steps', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = leakingRecipe();

    const result = applyAutoPiiForExecution(recipe);

    expect(result).not.toBe(recipe);
    expect(stepsOf(result).some((s) => s.transform === 'pii-protect')).toBe(true);
    expect(stepsOf(result).some((s) => s.transform === 'pii-restore')).toBe(true);
  });

  it('warns once with step ids and without raw PII values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = leakingRecipe();

    applyAutoPiiForExecution(recipe);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain("[auto-pii] 'auto-pii-leak'");
    expect(message).toContain("'prompt'");
    expect(message).not.toContain('alice@example.test');
    expect(message).not.toContain('Alice Smith');
  });

  it('fails open and returns the same recipe reference when application throws', () => {
    const recipe = {
      recipe_id: 'auto-pii-throwing',
      version: 1,
      ttl: 300,
      metadata: {
        name: 'Throwing',
        description: 'Throws while reading steps.',
        author: 'recued-core',
        supported_platforms: ['test'],
      },
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;
    Object.defineProperty(recipe, 'steps', {
      get() {
        throw new Error('steps unavailable');
      },
    });

    let result: RecipeDefinition | undefined;
    expect(() => {
      result = applyAutoPiiForExecution(recipe);
    }).not.toThrow();
    expect(result).toBe(recipe);
  });
});
