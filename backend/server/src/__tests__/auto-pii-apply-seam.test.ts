import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { applyAutoPiiForExecution, configureAutoPiiProtection } from '../auto-pii-apply.js';

type Step = Record<string, unknown>;


beforeEach(() => {
  configureAutoPiiProtection(() => true); // protection ON (the default)
});

afterEach(() => {
  configureAutoPiiProtection(() => true); // restore the safe default
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
  it('passes recipes through unchanged when privacy.auto_pii_protection is off', () => {
    configureAutoPiiProtection(() => false);
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

  // D-316 amendment (owner ruling 2026-10-05): a content-only finding gets a
  // `content` tag too — on a server it hides the known contacts and every email.
  it('tags an AI step that reads only a mail subject `content`, through the canonical classifier', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = recipeWith([
      { id: 'mail', ingredient: 'mail-get' },
      { id: 'note', transform: 'pick', source: { subject: '{{step.mail.record.hot_fields.subject}}' } },
      {
        id: 'triage',
        ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.note}}', 'llm.categories': ['reply', 'fyi'] },
      },
    ], 'auto-pii-content');

    const result = applyAutoPiiForExecution(recipe);

    const triage = stepsOf(result).find((s) => s.id === 'triage')!;
    expect((triage.input as Record<string, unknown>)['llm.pii_fields']).toEqual({ subject: 'content' });
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
