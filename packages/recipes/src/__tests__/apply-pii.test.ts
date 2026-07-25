import { describe, expect, it } from 'vitest';
import type { PiiPathProfile, PiiSourceClassifier, RecipeDefinition } from '@recued/contracts';

import { applyAutoPiiProtection } from '../apply-pii.js';

type Step = Record<string, unknown>;

const classifierFrom = (
  profiles: Record<string, PiiPathProfile>,
): PiiSourceClassifier => (step) => {
  if (typeof step.ingredient === 'string') return profiles[step.ingredient];
  if (typeof step.op === 'string') return profiles[step.op];
  return undefined;
};

const recipeWith = (
  steps: Step[],
  options: {
    recipe_id?: string;
    prefetch_steps?: Step[];
    output?: Record<string, unknown>;
  } = {},
): RecipeDefinition => ({
  recipe_id: options.recipe_id ?? 'auto-pii-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Auto PII test',
    description: 'Fixture for auto-PII application tests.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['pii', 'test'],
  },
  variables: {},
  prefetch_steps: options.prefetch_steps ?? [],
  steps,
  output: options.output ?? { sidebar: [] },
} as unknown as RecipeDefinition);

const source = (id = 'profile', ingredient = 'profile-source'): Step => ({ id, ingredient });

const aiPrompt = (
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Step => ({
  id: 'ai',
  ingredient: 'ai-prompt',
  input,
  ...extra,
});

const aiClassify = (
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Step => ({
  id: 'ai',
  ingredient: 'ai-classify',
  input: {
    'llm.categories': ['review'],
    ...input,
  },
  ...extra,
});

const stepsOf = (recipe: RecipeDefinition): Step[] => recipe.steps as unknown as Step[];
const stepById = (recipe: RecipeDefinition, id: string): Step =>
  stepsOf(recipe).find((s) => s.id === id) as Step;
const inputOf = (step: Step): Record<string, unknown> => step.input as Record<string, unknown>;
const residualOutcomes = (result: ReturnType<typeof applyAutoPiiProtection>): string[] =>
  result.residual.map((r) => r.outcome);

describe('applyAutoPiiProtection', () => {
  it('merges injected llm.pii_fields into a batch-capable AI step', () => {
    const recipe = recipeWith([
      source(),
      aiClassify({ 'llm.data': '{{step.profile}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'], name: ['name'] },
    }));

    expect(result.changed).toBe(true);
    expect(result.injections).toEqual([
      { step_id: 'ai', slug: 'ai-classify', fields: { email: 'email', name: 'name' } },
    ]);
    expect(inputOf(stepById(result.recipe, 'ai'))['llm.pii_fields']).toEqual({
      email: 'email',
      name: 'name',
    });
    expect(inputOf(stepById(recipe, 'ai'))['llm.pii_fields']).toBeUndefined();
  });

  it('lets authored llm.pii_fields win on injected path collisions', () => {
    const recipe = recipeWith([
      source(),
      aiClassify({
        'llm.data': '{{step.profile}}',
        'llm.pii_fields': { email: 'content', phone: 'phone' },
      }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'], name: ['name'] },
    }));

    expect(result.changed).toBe(true);
    expect(inputOf(stepById(result.recipe, 'ai'))['llm.pii_fields']).toEqual({
      email: 'content',
      name: 'name',
      phone: 'phone',
    });
  });

  it('leaves non-record authored llm.pii_fields untouched and records declaration_conflict', () => {
    const recipe = recipeWith([
      source(),
      aiClassify({
        'llm.data': '{{step.profile}}',
        'llm.pii_fields': '{{config.dynamic_tags}}',
      }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(result.recipe).toBe(recipe);
    expect(inputOf(stepById(result.recipe, 'ai'))['llm.pii_fields']).toBe('{{config.dynamic_tags}}');
    expect(result.residual).toEqual([
      { step_id: 'ai', slug: 'ai-classify', outcome: 'declaration_conflict' },
    ]);
  });

  it('returns the same recipe object when the trace has no applicable findings', () => {
    const recipe = recipeWith([
      source(),
      aiClassify({ 'llm.data': '{{step.profile}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': {},
    }));

    expect(result.changed).toBe(false);
    expect(result.recipe).toBe(recipe);
    expect(result.injections).toEqual([]);
    expect(result.brackets).toEqual([]);
  });

  it('synthesizes object-mode protect/restore steps and rewires downstream references', () => {
    const recipe = recipeWith([
      source(),
      aiPrompt({ 'llm.prompt': 'Review {{step.profile:currency}}' }),
      { id: 'format', transform: 'template', template: 'Result {{step.ai.answer}}' },
      { id: 'gate', transform: 'any', conditions: ['{{step.ai.answer}} is_empty'] },
      {
        id: 'object_gate',
        transform: 'template',
        template: 'object gate',
        skip_when: { field: '{{step.ai.answer}}', operator: 'is_empty' },
      },
    ], {
      output: {
        primary: '{{step.ai.answer}}',
        sidebar: [
          { type: 'summary', source: 'step.ai' },
          { type: 'summary', source: 'step.ai.answer' },
          { type: 'summary', source: 'step.other.answer' },
          { type: 'summary', source: 'step.aix.answer' },
        ],
      },
    });

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { name: ['name'], email: ['email'] },
    }));

    expect(result.changed).toBe(true);
    expect(result.brackets).toEqual([
      {
        step_id: 'ai',
        slug: 'ai-prompt',
        sources: [
          {
            ref: 'step.profile',
            protect_step_id: 'ai_pii_protect',
            fields: { email: 'email', name: 'name' },
          },
        ],
        restore_step_ids: ['ai_pii_restore'],
      },
    ]);
    expect(stepsOf(result.recipe).map((s) => s.id)).toEqual([
      'profile',
      'ai_pii_protect',
      'ai',
      'ai_pii_restore',
      'format',
      'gate',
      'object_gate',
    ]);
    expect(stepById(result.recipe, 'ai_pii_protect')).toEqual({
      id: 'ai_pii_protect',
      transform: 'pii-protect',
      data: '{{step.profile}}',
      fields: [
        { path: 'email', kind: 'email' },
        { path: 'name', kind: 'name' },
      ],
    });
    expect(inputOf(stepById(result.recipe, 'ai'))['llm.prompt'])
      .toBe('Review {{step.ai_pii_protect.aliased:currency}}');
    expect(stepById(result.recipe, 'ai_pii_restore')).toEqual({
      id: 'ai_pii_restore',
      transform: 'pii-restore',
      data: '{{step.ai}}',
      ledger_handle: '{{step.ai_pii_protect.ledger_handle}}',
    });
    expect(stepById(result.recipe, 'format').template)
      .toBe('Result {{step.ai_pii_restore.restored.answer}}');
    expect(stepById(result.recipe, 'gate').conditions)
      .toEqual(['{{step.ai_pii_restore.restored.answer}} is_empty']);
    expect(stepById(result.recipe, 'object_gate').skip_when)
      .toEqual({ field: '{{step.ai_pii_restore.restored.answer}}', operator: 'is_empty' });
    expect(result.recipe.output).toEqual({
      primary: '{{step.ai_pii_restore.restored.answer}}',
      sidebar: [
        { type: 'summary', source: 'step.ai_pii_restore.restored' },
        { type: 'summary', source: 'step.ai_pii_restore.restored.answer' },
        { type: 'summary', source: 'step.other.answer' },
        { type: 'summary', source: 'step.aix.answer' },
      ],
    });
  });

  it('synthesizes list-mode item-relative tags and carries compatible content paths', () => {
    const recipe = recipeWith([
      source('contacts', 'contacts-source'),
      aiPrompt({ 'llm.prompt': '{{step.contacts}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'contacts-source': {
        '[].email': ['email'],
        '[].body': ['content'],
      },
    }));

    expect(result.changed).toBe(true);
    expect(stepById(result.recipe, 'ai_pii_protect').fields).toEqual([
      { path: 'body', kind: 'content' },
      { path: 'email', kind: 'email' },
    ]);
    expect(result.brackets[0]?.sources[0]?.fields).toEqual({
      email: 'email',
      body: 'content',
    });
  });

  it('rejects mixed whole-value and list identifier profiles as no_bracketable_source', () => {
    const recipe = recipeWith([
      source('contacts', 'contacts-source'),
      aiPrompt({ 'llm.prompt': '{{step.contacts}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'contacts-source': {
        '': ['email'],
        '[].email': ['email'],
      },
    }));

    expect(result.changed).toBe(false);
    expect(result.recipe).toBe(recipe);
    expect(residualOutcomes(result)).toEqual(['no_bracketable_source']);
  });

  it('rejects profiles that cross an interior list boundary', () => {
    const recipe = recipeWith([
      source('account', 'account-source'),
      aiPrompt({ 'llm.prompt': '{{step.account}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'account-source': {
        'contacts.[].email': ['email'],
      },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['no_bracketable_source']);
  });

  it('rejects whole-value identifier sources because there is no tag path to walk', () => {
    const recipe = recipeWith([
      source('email', 'email-source'),
      aiPrompt({ 'llm.prompt': '{{step.email}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'email-source': { '': ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['no_bracketable_source']);
  });

  it('creates one protect per source and chained restores for multi-source brackets', () => {
    const recipe = recipeWith([
      source('contact', 'contact-source'),
      source('company', 'company-source'),
      aiPrompt({ 'llm.prompt': '{{step.contact}} for {{step.company}}' }),
      { id: 'downstream', transform: 'template', template: '{{step.ai.answer}}' },
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'contact-source': { email: ['email'] },
      'company-source': { domain: ['url'] },
    }));

    expect(result.changed).toBe(true);
    expect(stepById(result.recipe, 'ai_pii_protect')).toEqual({
      id: 'ai_pii_protect',
      transform: 'pii-protect',
      data: '{{step.contact}}',
      fields: [{ path: 'email', kind: 'email' }],
    });
    expect(stepById(result.recipe, 'ai_pii_protect_2')).toEqual({
      id: 'ai_pii_protect_2',
      transform: 'pii-protect',
      data: '{{step.company}}',
      fields: [{ path: 'domain', kind: 'url' }],
    });
    expect(stepById(result.recipe, 'ai_pii_restore')).toMatchObject({
      data: '{{step.ai}}',
      ledger_handle: '{{step.ai_pii_protect.ledger_handle}}',
    });
    expect(stepById(result.recipe, 'ai_pii_restore_2')).toMatchObject({
      data: '{{step.ai_pii_restore.restored}}',
      ledger_handle: '{{step.ai_pii_protect_2.ledger_handle}}',
    });
    expect(stepById(result.recipe, 'downstream').template)
      .toBe('{{step.ai_pii_restore_2.restored.answer}}');
    expect(result.brackets[0]?.restore_step_ids).toEqual(['ai_pii_restore', 'ai_pii_restore_2']);
  });

  it('records unsupported_position for AI steps outside the sequential steps array', () => {
    const recipe = recipeWith([], {
      prefetch_steps: [
        source(),
        aiPrompt({ 'llm.prompt': '{{step.profile}}' }),
      ],
    });

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['unsupported_position']);
  });

  it('records continuity_reference when context.recipe reads the target AI output', () => {
    const recipe = recipeWith([
      source(),
      aiPrompt({ 'llm.prompt': '{{step.profile}}' }),
    ], {
      output: {
        prior: '{{context.recipe.ai.answer}}',
        sidebar: [],
      },
    });

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['continuity_reference']);
  });

  it('records self_referential_fail_on for string fail_on conditions', () => {
    const recipe = recipeWith([
      source(),
      aiPrompt(
        { 'llm.prompt': '{{step.profile}}' },
        { fail_on: '{{step.ai.answer}} is_empty' },
      ),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['self_referential_fail_on']);
  });

  it('records self_referential_fail_on for object-form fail_on conditions', () => {
    const recipe = recipeWith([
      source(),
      aiPrompt(
        { 'llm.prompt': '{{step.profile}}' },
        { fail_on: { field: '{{step.ai.answer}}', operator: 'is_empty' } },
      ),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['self_referential_fail_on']);
  });

  it('records content_only for content findings that cannot seed an identifier ledger', () => {
    const recipe = recipeWith([
      source('message', 'message-source'),
      aiPrompt({ 'llm.prompt': '{{step.message}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'message-source': { body: ['content'] },
    }));

    expect(result.changed).toBe(false);
    expect(residualOutcomes(result)).toEqual(['content_only']);
  });

  it('records no_bracketable_source for untraced gaps', () => {
    const recipe = recipeWith([
      { id: 'opaque', transform: 'future_transform' },
      aiClassify({ 'llm.data': '{{step.opaque}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe);

    expect(result.changed).toBe(false);
    expect(result.residual).toEqual([
      {
        step_id: 'ai',
        slug: 'ai-classify',
        gap_reason: 'untraced',
        outcome: 'no_bracketable_source',
      },
    ]);
  });

  it('mints deterministic suffix ids when synthesized ids collide with existing steps', () => {
    const recipe = recipeWith([
      source(),
      { id: 'ai_pii_protect', transform: 'count', input: [] },
      aiPrompt({ 'llm.prompt': '{{step.profile}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
    }));

    expect(result.changed).toBe(true);
    expect(stepById(result.recipe, 'ai_pii_protect_2')).toEqual({
      id: 'ai_pii_protect_2',
      transform: 'pii-protect',
      data: '{{step.profile}}',
      fields: [{ path: 'email', kind: 'email' }],
    });
    expect(result.brackets[0]?.sources[0]?.protect_step_id).toBe('ai_pii_protect_2');
  });

  it('is deterministic for two applications of the same input', () => {
    const recipe = recipeWith([
      source(),
      aiPrompt({ 'llm.prompt': '{{step.profile}}' }),
    ]);
    const classifier = classifierFrom({
      'profile-source': { email: ['email'], name: ['name'] },
    });

    const first = applyAutoPiiProtection(recipe, classifier);
    const second = applyAutoPiiProtection(recipe, classifier);

    expect(first.recipe).toEqual(second.recipe);
    expect(first.brackets).toEqual(second.brackets);
    expect(first.residual).toEqual(second.residual);
  });

  it('is idempotent when run on an already-applied recipe', () => {
    const recipe = recipeWith([
      source(),
      aiPrompt({ 'llm.prompt': '{{step.profile}}' }),
    ]);
    const classifier = classifierFrom({
      'profile-source': { email: ['email'], name: ['name'] },
    });

    const first = applyAutoPiiProtection(recipe, classifier);
    const second = applyAutoPiiProtection(first.recipe, classifier);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.recipe).toBe(first.recipe);
    expect(second.brackets).toEqual([]);
  });

  it('rolls back a partially covering bracket that fails verification', () => {
    const recipe = recipeWith([
      source('contact', 'contact-source'),
      source('email', 'scalar-email-source'),
      aiPrompt({ 'llm.prompt': '{{step.contact}} {{step.email}}' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'contact-source': { email: ['email'] },
      'scalar-email-source': { '': ['email'] },
    }));

    expect(result.changed).toBe(false);
    expect(result.recipe).toBe(recipe);
    expect(residualOutcomes(result)).toEqual(['verification_failed']);
    expect(stepsOf(result.recipe).some((s) => s.transform === 'pii-protect')).toBe(false);
  });

  it('keeps per-input-key source provenance for interpolated prompts', () => {
    const recipe = recipeWith([
      source('contact', 'contact-source'),
      aiPrompt({ 'llm.prompt': 'Contact {{step.contact}} now' }),
    ]);

    const result = applyAutoPiiProtection(recipe, classifierFrom({
      'contact-source': { email: ['email'], name: ['name'] },
    }));

    expect(result.trace.findings[0]?.sources).toEqual([
      {
        input_key: 'llm.prompt',
        ref: 'step.contact',
        profile: { email: ['email'], name: ['name'] },
      },
    ]);
  });
});
