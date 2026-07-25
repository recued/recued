/** Connection-agnostic op dispatch (slice 3) — pure-workflow trust-tier wiring.
 *
 *  The op namespace is the D-170 N.18 trust-tier discriminator: a canonical
 *  entity op-step (`deal.search`) is a portable, gated catalog operation, so
 *  `classifyPureWorkflowStep` reports it as `'operation-invoke'` — a pure-workflow
 *  step kind. A recipe whose steps are all entity-ops (+ guards / foreach) is
 *  therefore pure-workflow. A transform step still drops a recipe out of the tier.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPureWorkflowStep,
  isPureWorkflowRecipe,
} from '../index.js';
import type { RecipeDefinition, RecipeStep } from '../index.js';

describe('classifyPureWorkflowStep — canonical op-step (slice 3)', () => {
  it('classifies a canonical entity op-step as operation-invoke', () => {
    expect(classifyPureWorkflowStep({ id: 'd', op: 'deal.search' } as RecipeStep))
      .toBe('operation-invoke');
  });

  it('a transform step is still not a pure-workflow step (null)', () => {
    expect(classifyPureWorkflowStep({ id: 't', transform: 'filter' } as RecipeStep)).toBeNull();
  });

  it('an op-step does not shadow a concrete ingredient step classification', () => {
    // a step with a concrete ingredient takes the ingredient branch, not op.
    expect(classifyPureWorkflowStep({ id: 'i', ingredient: 'deal-reader-hubspot' } as RecipeStep))
      .toBe('operation-invoke');
  });

  it('§5 — a core-* notify alias classifies as notify, same as its bare slug', () => {
    // Sibling to the core-ai-* strip below: the `core-` namespace breaks the
    // bare-slug notify-set lookup, so a core-notify step must `stripCorePrefix`
    // before the lookup or it falls through to `operation-invoke`.
    for (const bare of ['notification-send', 'mail-post', 'slack-post']) {
      expect(classifyPureWorkflowStep({ id: 'n', ingredient: bare } as RecipeStep)).toBe('notify');
      expect(classifyPureWorkflowStep({ id: 'n', ingredient: `core-${bare}` } as RecipeStep)).toBe('notify');
    }
  });
});

describe('isPureWorkflowRecipe — op-step recipes (slice 3)', () => {
  const base = (steps: RecipeStep[]): RecipeDefinition =>
    ({
      recipe_id: 'r',
      version: 1,
      ttl: 60,
      metadata: { name: 'r', description: 'x', author: 'a', supported_platforms: [] },
      steps,
      output: { sidebar: [] },
    }) as unknown as RecipeDefinition;

  it('an all-entity-op recipe is pure-workflow', () => {
    expect(isPureWorkflowRecipe(base([
      { id: 'deals', op: 'deal.search' } as RecipeStep,
      { id: 'contacts', op: 'contact.search' } as RecipeStep,
    ]))).toBe(true);
  });

  it('op-step + guard is pure-workflow', () => {
    expect(isPureWorkflowRecipe(base([
      { id: 'deals', op: 'deal.search' } as RecipeStep,
      { id: 'g', guard: '{{step.deals}} is_empty' } as RecipeStep,
    ]))).toBe(true);
  });

  it('op-step + transform is NOT pure-workflow (transform drops the tier)', () => {
    expect(isPureWorkflowRecipe(base([
      { id: 'deals', op: 'deal.search' } as RecipeStep,
      { id: 'open', transform: 'filter', array: '{{step.deals}}' } as RecipeStep,
    ]))).toBe(false);
  });

  it('§5 — a core-ai-* step is AI, NOT pure-workflow (no auto-trust, same as bare ai-*)', () => {
    // The whole point: `core-ai-classify` must not be mis-read as a pure-workflow
    // operation-invoke step and thereby earn write/admin auto-trust that the bare
    // `ai-classify` step would NOT get.
    const aiStep = { id: 'c', ingredient: 'ai-classify', input: { 'llm.data': 'x', 'llm.categories': ['a'] } } as RecipeStep;
    const coreAiStep = { id: 'c', ingredient: 'core-ai-classify', input: { 'llm.data': 'x', 'llm.categories': ['a'] } } as RecipeStep;
    expect(isPureWorkflowRecipe(base([aiStep]))).toBe(false);
    expect(isPureWorkflowRecipe(base([coreAiStep]))).toBe(false); // identical treatment
  });
});
