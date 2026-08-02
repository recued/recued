import { describe, expect, it } from 'vitest';

import type { RecipeDefinition } from '@recued/contracts';

import {
  RECEPTION_RECIPE_MAX_STEPS,
  analyzeReceptionRecipeCost,
  receptionDoorExecutionPolicy,
  receptionDoorPolicyAdmits,
} from '../reception-recipe-cost-policy.js';

const recipe = (input: {
  prefetch_steps?: Record<string, unknown>[];
  steps?: Record<string, unknown>[];
  trigger_steps?: Record<string, unknown>[];
}): RecipeDefinition => ({
  prefetch_steps: input.prefetch_steps ?? [],
  steps: input.steps ?? [],
  trigger_steps: input.trigger_steps ?? [],
} as unknown as RecipeDefinition);

const kinds = {
  resolveIngredientKind: (slug: string) => slug.startsWith('ai-') ? 'ai' : 'http',
  resolveOpKinds: () => new Map([
    ['vendor.ai.generate', 'ai'],
  ]),
};

describe('anonymous reception recipe cost profile', () => {
  it('counts every phase and recognizes kernel, pack-op, and ingredient AI', () => {
    const result = analyzeReceptionRecipeCost(recipe({
      prefetch_steps: [{ id: 'prefetch', ingredient: 'ai-extract' }],
      steps: [{ id: 'kernel', op: 'core.ai.summarize' }],
      trigger_steps: [{ id: 'pack', op: 'vendor.ai.generate' }],
    }), kinds);

    expect(result).toEqual({
      ok: true,
      profile: {
        step_count: 3,
        uses_ai: true,
        ai_steps: ['prefetch', 'kernel', 'pack'],
      },
    });
  });

  it('refuses an authored recipe above the per-run step ceiling', () => {
    const steps = Array.from({ length: RECEPTION_RECIPE_MAX_STEPS + 1 }, (_, index) => ({
      id: `s${index}`,
      transform: 'default',
    }));
    expect(analyzeReceptionRecipeCost(recipe({ steps }), kinds)).toMatchObject({
      ok: false,
      refusal: {
        reason: 'cost_step_limit',
        steps: RECEPTION_RECIPE_MAX_STEPS + 1,
        max_steps: RECEPTION_RECIPE_MAX_STEPS,
      },
    });
  });

  it('refuses foreach because one authored dispatch could spend once per resolved item', () => {
    expect(analyzeReceptionRecipeCost(recipe({
      steps: [{ id: 'fanout', ingredient: 'mail-send', foreach: '{{context.items}}' }],
    }), kinds)).toEqual({
      ok: false,
      refusal: { reason: 'cost_dynamic_fanout', step_id: 'fanout' },
    });
  });

  it('fails closed when a dispatch kind cannot be classified for AI cost', () => {
    expect(analyzeReceptionRecipeCost(recipe({
      steps: [{ id: 'mystery', ingredient: 'missing-manifest' }],
    }))).toEqual({
      ok: false,
      refusal: {
        reason: 'cost_unknown_dispatch_kind',
        step_id: 'mystery',
        target: 'missing-manifest',
      },
    });
  });

  it('takes one live pack-op inventory snapshot per analysis', () => {
    let scans = 0;
    const result = analyzeReceptionRecipeCost(recipe({
      steps: [
        { id: 'read', op: 'vendor.crm.read' },
        { id: 'search', op: 'vendor.crm.search' },
      ],
    }), {
      resolveOpKinds: () => {
        scans += 1;
        return new Map([
          ['vendor.crm.read', 'http'],
          ['vendor.crm.search', 'http'],
        ]);
      },
    });

    expect(result).toMatchObject({ ok: true, profile: { step_count: 2 } });
    expect(scans).toBe(1);
  });

  it('persists AI consent separately from scope and enforces it at runtime', () => {
    const analyzed = analyzeReceptionRecipeCost(recipe({
      steps: [{ id: 'ai', op: 'core.ai.generate' }],
    }), kinds);
    if (!analyzed.ok) throw new Error('expected analyzable recipe');

    const policy = receptionDoorExecutionPolicy(analyzed.profile);
    expect(policy).toEqual({ max_steps: RECEPTION_RECIPE_MAX_STEPS, allow_ai: true });
    expect(receptionDoorPolicyAdmits(policy, analyzed.profile)).toBe(true);
    expect(receptionDoorPolicyAdmits({ ...policy, allow_ai: false }, analyzed.profile)).toBe(false);
    expect(receptionDoorPolicyAdmits(undefined, analyzed.profile)).toBe(false);
    expect(receptionDoorPolicyAdmits({ ...policy, max_steps: 0 }, analyzed.profile)).toBe(false);
    expect(receptionDoorPolicyAdmits({
      ...policy,
      max_steps: RECEPTION_RECIPE_MAX_STEPS + 1,
    }, analyzed.profile)).toBe(false);
  });
});
