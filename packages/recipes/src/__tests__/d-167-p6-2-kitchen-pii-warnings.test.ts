import { describe, expect, it } from 'vitest';
import { isBatchCapableAISlug } from '@recued/contracts';
import { validateRecipe, type ValidationIssue } from '../validate.js';
import { AI_FUNCTION_REQUIRED_INPUTS } from '../validate/constants.js';

type AiSlug = 'ai-classify' | 'ai-compare' | 'ai-prompt';

const baseInputFor = (slug: AiSlug): Record<string, unknown> => {
  switch (slug) {
    case 'ai-compare':
      return {
        'llm.data_a': { sender: 'ada@example.test' },
        'llm.data_b': { recipient: 'bea@example.test' },
      };
    case 'ai-prompt':
      return {
        'llm.system_prompt': 'You are a careful analyst. Produce concise, structured output and never invent missing facts from the provided payload.',
        'llm.prompt': 'Review the provided record.',
      };
    case 'ai-classify':
      return {
        'llm.data': { sender: 'ada@example.test' },
        'llm.categories': ['x'],
      };
  }
};

const recipeFor = (
  input: Record<string, unknown>,
  slug: AiSlug = 'ai-classify',
  variables: Record<string, unknown> = {},
) => ({
  recipe_id: 'x-y-hubspot',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'X',
    description: 'Design-time validation fixture for kitchen PII tags.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    variant_group: 'x-y',
    tags: ['ai', 'pii', 'validator'],
  },
  variables,
  steps: [
    {
      id: 'classify',
      ingredient: slug,
      input: { ...baseInputFor(slug), ...input },
      skip_when: '{{context.entity_id}} is_null',
      pii_fields: ['sender'],
    },
  ],
  output: { sidebar: [{ type: 'summary', source: 'step.classify' }] },
});

const piiIssuesOf = (
  input: Record<string, unknown>,
  slug: AiSlug = 'ai-classify',
  variables: Record<string, unknown> = {},
): ValidationIssue[] =>
  validateRecipe(recipeFor(input, slug, variables)).issues
    .filter((i) => i.code.startsWith('ai_pii_fields'));

const codesOf = (
  input: Record<string, unknown>,
  slug: AiSlug = 'ai-classify',
  variables: Record<string, unknown> = {},
): Array<Pick<ValidationIssue, 'code' | 'severity'>> =>
  piiIssuesOf(input, slug, variables).map(({ code, severity }) => ({ code, severity }));

const warn = (code: string): Pick<ValidationIssue, 'code' | 'severity'> => ({
  code,
  severity: 'warn',
});

describe('D-167 P6.2 kitchen llm.pii_fields warnings', () => {
  it('accepts a valid inline tag whose root exists in llm.data', () => {
    expect(codesOf({ 'llm.pii_fields': { sender: 'email' } })).toEqual([]);
  });

  it('accepts all 9 privacy kinds', () => {
    expect(codesOf({
      'llm.data': {
        email: 'a@example.test',
        name: 'Ada',
        org: 'Recued',
        phone: '555-0100',
        address: '1 Main',
        url: 'https://example.test',
        external_id: 'ext-1',
        account_id: 'acct-1',
        content: 'Free text.',
      },
      'llm.pii_fields': {
        email: 'email',
        name: 'name',
        org: 'org',
        phone: 'phone',
        address: 'address',
        url: 'url',
        external_id: 'external_id',
        account_id: 'account_id',
        content: 'content',
      },
    })).toEqual([]);
  });

  it('treats explicit null llm.pii_fields as a no-op', () => {
    expect(codesOf({ 'llm.pii_fields': null })).toEqual([]);
  });

  it('treats absent llm.pii_fields as a no-op', () => {
    expect(codesOf({})).toEqual([]);
  });

  it('skips a pure whole-value ref for the whole pii_fields map', () => {
    expect(codesOf({ 'llm.pii_fields': '{{config.m}}' }, 'ai-classify', { m: null })).toEqual([]);
  });

  it('skips a pure whole-value ref for an individual kind', () => {
    expect(codesOf({ 'llm.pii_fields': { sender: '{{config.k}}' } }, 'ai-classify', { k: 'email' })).toEqual([]);
  });

  it('warns when llm.pii_fields is an array', () => {
    expect(codesOf({ 'llm.pii_fields': ['sender'] })).toEqual([
      warn('ai_pii_fields_shape'),
    ]);
  });

  it('warns when llm.pii_fields is an interpolated string', () => {
    expect(codesOf({ 'llm.pii_fields': 'x {{config.m}}' }, 'ai-classify', { m: null })).toEqual([
      warn('ai_pii_fields_shape'),
    ]);
  });

  it('warns for ai-compare and suppresses per-entry checks', () => {
    expect(piiIssuesOf({ 'llm.pii_fields': { '': 'emial', recipient: 42 } }, 'ai-compare')).toEqual([
      expect.objectContaining({
        code: 'ai_pii_fields_unsupported_slug',
        severity: 'warn',
        message: expect.stringMatching(/pii-protect.*fails closed|fails closed.*pii-protect/),
      }),
    ]);
  });

  it('warns for ai-prompt even though it has llm.prompt', () => {
    expect(codesOf({ 'llm.pii_fields': { sender: 'email' } }, 'ai-prompt')).toEqual([
      warn('ai_pii_fields_unsupported_slug'),
    ]);
  });

  it('warns on an empty tag path', () => {
    expect(codesOf({ 'llm.pii_fields': { '': 'email' } })).toEqual([
      warn('ai_pii_fields_empty_path'),
    ]);
  });

  it('warns on an unknown string kind and echoes it', () => {
    expect(piiIssuesOf({ 'llm.pii_fields': { sender: 'emial' } })).toEqual([
      expect.objectContaining({
        code: 'ai_pii_fields_unknown_kind',
        severity: 'warn',
        message: expect.stringContaining('"emial"'),
      }),
    ]);
  });

  it('warns on a non-string kind', () => {
    expect(codesOf({ 'llm.pii_fields': { sender: 42 } })).toEqual([
      warn('ai_pii_fields_unknown_kind'),
    ]);
  });

  it('warns on an interpolated kind string', () => {
    expect(codesOf({ 'llm.pii_fields': { sender: 'x{{config.k}}' } }, 'ai-classify', { k: 'email' })).toEqual([
      warn('ai_pii_fields_unknown_kind'),
    ]);
  });

  it('warns when a tag root is absent from inline literal llm.data', () => {
    expect(codesOf({ 'llm.pii_fields': { recipient: 'email' } })).toEqual([
      warn('ai_pii_fields_unmatched_path'),
    ]);
  });

  it('does not force field existence when llm.data is a ref', () => {
    expect(codesOf({
      'llm.data': '{{config.data}}',
      'llm.pii_fields': { recipient: 'email' },
    }, 'ai-classify', { data: null })).toEqual([]);
  });

  it('skips unmatched-path checks for batch llm.data arrays', () => {
    expect(codesOf({
      'llm.data': [{ sender: 'ada@example.test' }],
      'llm.pii_fields': { recipient: 'email' },
    })).toEqual([]);
  });

  it('accepts nested paths when the inline root exists', () => {
    expect(codesOf({
      'llm.data': { owner: { email: 'ada@example.test' } },
      'llm.pii_fields': { 'owner.email': 'email' },
    })).toEqual([]);
  });

  it('keeps recipes with only ai_pii_fields warnings structurally valid', () => {
    const result = validateRecipe(recipeFor({
      'llm.pii_fields': {
        '': 'email',
        sender: 'emial',
        recipient: 'email',
      },
    }));

    expect({
      valid: result.valid,
      aiPiiErrors: result.issues.filter((i) =>
        i.severity === 'error' && i.code.startsWith('ai_pii_fields'),
      ),
      aiPiiWarnings: result.issues
        .filter((i) => i.code.startsWith('ai_pii_fields'))
        .map(({ code, severity }) => ({ code, severity })),
    }).toEqual({
      valid: true,
      aiPiiErrors: [],
      aiPiiWarnings: [
        warn('ai_pii_fields_empty_path'),
        warn('ai_pii_fields_unknown_kind'),
        warn('ai_pii_fields_unmatched_path'),
      ],
    });
  });
});

// ⛔ THE OP FORM WAS NEVER TESTED, AND IT IS HOW EVERY SHIPPED STEP IS WRITTEN. The
// unsupported-slug check read the raw slug, and an op step's is `core.ai.classify`,
// which the `core-` prefix rule does not strip: all 23 shipped steps with
// `llm.pii_fields` were warned they fail at run time, and none did (2026-10-11). The
// executor reads its manifest's `core-ai-classify`, which strips to `ai-classify`.
describe('D-167 P6.2 — the unsupported-slug warning agrees with the executor, in every form', () => {
  const unsupported = (step: Record<string, unknown>): boolean =>
    validateRecipe({ ...recipeFor({}), steps: [step] }).issues
      .some((issue) => issue.code === 'ai_pii_fields_unsupported_slug');

  const inputFor = (bare: string): Record<string, unknown> => ({
    ...Object.fromEntries(AI_FUNCTION_REQUIRED_INPUTS[bare]!.map((key) => [key, key === 'llm.prompt' ? 'Review it.' : ['x']])),
    'llm.pii_fields': { sender: 'email' },
  });

  it.each(Object.keys(AI_FUNCTION_REQUIRED_INPUTS))('%s: warned exactly when the executor refuses', (bare) => {
    // What `executeLLM` checks, on the kernel manifest a step of either form reaches.
    const refused = !isBatchCapableAISlug(`core-${bare}`);
    const op = `core.ai.${bare.slice('ai-'.length)}`;
    expect(unsupported({ id: 'step', op, args: inputFor(bare) }), op).toBe(refused);
    expect(unsupported({ id: 'step', ingredient: `core-${bare}`, input: inputFor(bare) }), `core-${bare}`).toBe(refused);
  });

  it('the shipped shape: core.ai.classify and core.ai.generate with llm.pii_fields are not warned', () => {
    expect(unsupported({ id: 'step', op: 'core.ai.classify', args: inputFor('ai-classify') })).toBe(false);
    expect(unsupported({ id: 'step', op: 'core.ai.generate', args: inputFor('ai-generate') })).toBe(false);
  });
});
