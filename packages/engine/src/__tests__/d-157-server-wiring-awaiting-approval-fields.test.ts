/** D-157 server-wiring - awaiting_approval structured field propagation. */

import { PreflightRequiredSignal } from '@recued/contracts';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';
import { executeRecipe, type ExecutionContext, type IngredientExecutor } from '@recued/engine';
import { describe, expect, it } from 'vitest';

const stores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

const recipe = (steps: RecipeStep[]): RecipeDefinition => ({
  recipe_id: 'd-157-server-wiring-awaiting-approval-fields',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'D-157 awaiting approval fields',
    description: 'Pins structured preflight signal forwarding.',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
});

const ctx = (
  ingredientExecutor: IngredientExecutor,
): ExecutionContext => ({
  recipe: recipe([
    { id: 'prepare', transform: 'concat', values: ['ready'] } as unknown as RecipeStep,
    { id: 'send', ingredient: 'mail.send' } as unknown as RecipeStep,
  ]),
  stores: stores(),
  ingredientExecutor,
});

describe('executeRecipe awaiting_approval structured fields', () => {
  it('propagates fields from a signal-throwing executor', async () => {
    const result = await executeRecipe(ctx(async (slug) => {
      if (slug === 'mail.send') {
        throw new PreflightRequiredSignal('approval required', {
          tool_slug: 'mail.send',
          risk_tier: 'write',
          reason: 'write tier requires user approval',
        });
      }
      return null;
    }));

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.awaiting_approval).toMatchObject({
      gated_step_id: 'send',
      tool_slug: 'mail.send',
      risk_tier: 'write',
      reason: 'write tier requires user approval',
    });
    expect(result.awaiting_approval!.step_state).toEqual({ prepare: 'ready' });
  });

  it('leaves fields undefined when a legacy signal has no details', async () => {
    const result = await executeRecipe(ctx(async (slug) => {
      if (slug === 'mail.send') {
        throw new PreflightRequiredSignal('legacy approval required');
      }
      return null;
    }));

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.awaiting_approval).toBeDefined();
    expect(result.awaiting_approval!.gated_step_id).toBe('send');
    expect(result.awaiting_approval!.tool_slug).toBeUndefined();
    expect(result.awaiting_approval!.risk_tier).toBeUndefined();
    expect(result.awaiting_approval!.reason).toBeUndefined();
    expect(result.awaiting_approval).not.toHaveProperty('tool_slug');
    expect(result.awaiting_approval).not.toHaveProperty('risk_tier');
    expect(result.awaiting_approval).not.toHaveProperty('reason');
  });
});
