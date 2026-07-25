import { describe, expect, it } from 'vitest';
import { resolveDeep, type PiiPathProfile, type PiiSourceClassifier, type RecipeDefinition } from '@recued/contracts';

import { applyAutoPiiProtection } from '@recued/recipes';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

type Step = Record<string, unknown>;
type Call = { slug: string; input: Record<string, unknown> };

const RAW = {
  email: 'alice@example.test',
  name: 'Alice Smith',
  note: 'Email alice@example.test about Alice Smith.',
};

const EMAIL_ALIAS = 'm1@d1.invalid';
const NAME_ALIAS = 'pii.Person1';

const classifierFrom = (
  profiles: Record<string, PiiPathProfile>,
): PiiSourceClassifier => (step) => {
  if (typeof step.ingredient === 'string') return profiles[step.ingredient];
  return undefined;
};

const classifier = classifierFrom({
  'profile-reader': {
    email: ['email'],
    name: ['name'],
    note: ['content'],
  },
});

const recipeFor = (skipAi = false): RecipeDefinition => ({
  recipe_id: skipAi ? 'auto-pii-engine-skip' : 'auto-pii-engine',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Auto PII engine',
    description: 'Engine round-trip fixture for synthesized auto-PII brackets.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['pii', 'test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    { id: 'reader', ingredient: 'profile-reader' },
    {
      id: 'ai',
      ingredient: 'ai-prompt',
      input: { 'llm.prompt': '{{step.reader}}' },
      ...(skipAi ? { skip_when: '{{config.skip_ai}} equal true' } : {}),
    },
    { id: 'downstream', transform: 'template', template: '{{step.ai.answer}}' },
  ],
  output: { sidebar: [{ type: 'summary', source: 'step.downstream' }] },
} as unknown as RecipeDefinition);

const run = async (
  recipe: RecipeDefinition,
  config: Record<string, unknown> = {},
): Promise<{ ctx: ExecutionContext; calls: Call[] }> => {
  const calls: Call[] = [];
  const stores: ExecutionContext['stores'] = {
    vault: {},
    config,
    context: {},
    meta: {},
    step: {},
  };
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    const resolved = resolveDeep(input, stores) as Record<string, unknown>;
    calls.push({ slug, input: resolved });
    if (slug === 'profile-reader') return structuredClone(RAW);
    if (slug === 'ai-prompt') return { answer: JSON.stringify(resolved) };
    throw new Error(`unexpected ingredient: ${slug}`);
  };
  const ctx: ExecutionContext = { recipe, stores, ingredientExecutor };
  const result = await executeRecipe(ctx);
  expect(result.success).toBe(true);
  expect(result.errors).toEqual([]);
  return { ctx, calls };
};

const callInput = (calls: Call[], slug: string): Record<string, unknown> | undefined =>
  calls.find((c) => c.slug === slug)?.input;

const stepOutput = (ctx: ExecutionContext, id: string): unknown =>
  (ctx.stores.step as Record<string, unknown>)[id];

describe('auto-PII synthesized bracket engine round-trip', () => {
  it('aliases the rewritten AI input while preserving downstream output', async () => {
    const originalRecipe = recipeFor();
    const applied = applyAutoPiiProtection(originalRecipe, classifier);
    expect(applied.changed).toBe(true);

    const original = await run(originalRecipe);
    const rewritten = await run(applied.recipe);

    const rewrittenAiInput = JSON.stringify(callInput(rewritten.calls, 'ai-prompt'));
    expect(rewrittenAiInput).not.toContain(RAW.email);
    expect(rewrittenAiInput).not.toContain(RAW.name);
    expect(rewrittenAiInput).toContain(EMAIL_ALIAS);
    expect(rewrittenAiInput).toContain(NAME_ALIAS);
    expect(stepOutput(rewritten.ctx, 'downstream')).toEqual(stepOutput(original.ctx, 'downstream'));
  });

  it('restores aliases echoed by the mock executor before downstream steps read them', async () => {
    const applied = applyAutoPiiProtection(recipeFor(), classifier);
    const rewritten = await run(applied.recipe);

    const restored = stepOutput(rewritten.ctx, 'ai_pii_restore') as { restored: { answer: string } };
    expect(restored.restored.answer).toContain(RAW.email);
    expect(restored.restored.answer).toContain(RAW.name);
    expect(restored.restored.answer).not.toContain(EMAIL_ALIAS);
    expect(restored.restored.answer).not.toContain(NAME_ALIAS);
  });

  it('preserves null-degrade behavior when the bracketed AI step is skip_when skipped', async () => {
    const originalRecipe = recipeFor(true);
    const applied = applyAutoPiiProtection(originalRecipe, classifier);
    expect(applied.changed).toBe(true);

    const original = await run(originalRecipe, { skip_ai: true });
    const rewritten = await run(applied.recipe, { skip_ai: true });

    expect(stepOutput(original.ctx, 'ai')).toBeNull();
    expect(stepOutput(rewritten.ctx, 'ai')).toBeNull();
    expect(stepOutput(rewritten.ctx, 'ai_pii_restore')).toEqual({ restored: null });
    expect(stepOutput(rewritten.ctx, 'downstream')).toEqual(stepOutput(original.ctx, 'downstream'));
  });
});
