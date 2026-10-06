import { describe, expect, it } from 'vitest';
import type { PiiPathProfile, PiiSourceClassifier, RecipeDefinition } from '@recued/contracts';

import { summarizeRecipePiiPosture } from '../summarize-pii.js';

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
  options: { recipe_id?: string; prefetch_steps?: Step[] } = {},
): RecipeDefinition => ({
  recipe_id: options.recipe_id ?? 'summarize-pii-test',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Summarize PII test',
    description: 'Fixture for PII posture summary tests.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['pii', 'test'],
  },
  variables: {},
  prefetch_steps: options.prefetch_steps ?? [],
  steps,
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const source = (id = 'profile', ingredient = 'profile-source'): Step => ({ id, ingredient });

const aiClassify = (
  id: string,
  input: Record<string, unknown>,
): Step => ({
  id,
  ingredient: 'ai-classify',
  input: {
    'llm.categories': ['review'],
    ...input,
  },
});

const injectableRecipe = (): RecipeDefinition => recipeWith([
  source(),
  aiClassify('ai', { 'llm.data': '{{step.profile}}' }),
]);

const injectableClassifier = classifierFrom({
  'profile-source': { email: ['email'], name: ['name'] },
});

describe('summarizeRecipePiiPosture', () => {
  it('replaces an injectable llm.pii_fields warning with an auto_protected line', () => {
    const summary = summarizeRecipePiiPosture(injectableRecipe(), injectableClassifier);

    expect(summary).toEqual({
      headline: 'Recued will auto-protect 1 AI step at run time.',
      auto_protected: [
        {
          step_id: 'ai',
          message:
            "AI step 'ai' (ai-classify): Recued injects llm.pii_fields at run time — "
            + 'email (email), name (name) aliased before egress.',
        },
      ],
      warnings: [],
      infos: [],
    });
  });

  it('keeps no-bracketable residual warnings with the decline suffix', () => {
    const recipe = recipeWith([
      source('email', 'email-source'),
      aiClassify('ai', { 'llm.prompt': '{{step.email}} text' }),
    ]);

    const summary = summarizeRecipePiiPosture(recipe, classifierFrom({
      'email-source': { '': ['email'] },
    }));

    expect(summary).toEqual({
      headline: '1 AI step sends unprotected PII to the model at run time — manual protection needed.',
      auto_protected: [],
      warnings: [
        {
          step_id: 'ai',
          message:
            "AI step 'ai' (ai-classify) receives unprotected PII: llm.prompt (email) — "
            + 'the payload is an interpolated string — protect the structured source fields upstream '
            + 'with a pii-protect / pii-restore bracket, then interpolate the aliased values '
            + '(auto-protection declined: no payload source offers a runtime-walkable tag set)',
        },
      ],
      infos: [],
    });
  });

  it('renders mixed auto/manual headline grammar for singular and plural manual counts', () => {
    const mixedOneManual = summarizeRecipePiiPosture(recipeWith([
      source('profile', 'profile-source'),
      aiClassify('auto', { 'llm.data': '{{step.profile}}' }),
      source('email', 'email-source'),
      aiClassify('manual', { 'llm.prompt': '{{step.email}} text' }),
    ]), classifierFrom({
      'profile-source': { email: ['email'] },
      'email-source': { '': ['email'] },
    }));

    expect(mixedOneManual.headline).toBe(
      'Recued will auto-protect 1 AI step at run time; 1 remains manual.',
    );

    const mixedTwoManual = summarizeRecipePiiPosture(recipeWith([
      source('profile', 'profile-source'),
      aiClassify('auto', { 'llm.data': '{{step.profile}}' }),
      source('email', 'email-source'),
      aiClassify('manual_one', { 'llm.prompt': '{{step.email}} text' }),
      source('phone', 'phone-source'),
      aiClassify('manual_two', { 'llm.prompt': '{{step.phone}} text' }),
    ]), classifierFrom({
      'profile-source': { email: ['email'] },
      'email-source': { '': ['email'] },
      'phone-source': { '': ['phone'] },
    }));

    expect(mixedTwoManual.headline).toBe(
      'Recued will auto-protect 1 AI step at run time; 2 remain manual.',
    );
  });

  it('keeps every pii_reaches_llm warning unsuffixed when autoProtection is false', () => {
    const recipe = recipeWith([
      source('profile', 'profile-source'),
      aiClassify('auto', { 'llm.data': '{{step.profile}}' }),
      source('email', 'email-source'),
      aiClassify('manual', { 'llm.prompt': '{{step.email}} text' }),
    ]);

    const summary = summarizeRecipePiiPosture(recipe, classifierFrom({
      'profile-source': { email: ['email'] },
      'email-source': { '': ['email'] },
    }), { autoProtection: false });

    expect(summary).toEqual({
      headline: '2 AI steps send unprotected PII to the model at run time — manual protection needed.',
      auto_protected: [],
      warnings: [
        {
          step_id: 'auto',
          message:
            "AI step 'auto' (ai-classify) receives unprotected PII: llm.data.email (email) — "
            + 'declaring llm.pii_fields on these paths (or letting auto-PII inject it) aliases them before egress',
        },
        {
          step_id: 'manual',
          message:
            "AI step 'manual' (ai-classify) receives unprotected PII: llm.prompt (email) — "
            + 'the payload is an interpolated string — protect the structured source fields upstream '
            + 'with a pii-protect / pii-restore bracket, then interpolate the aliased values',
        },
      ],
      infos: [],
    });
    expect(summary.warnings.map((w) => w.message).join('\n')).not.toContain(
      'auto-protection declined',
    );
  });

  // D-316 amendment (owner ruling 2026-10-05): auto-PII tags content-only
  // findings too, and the line says what a `content` tag hides — never that
  // the whole field is aliased.
  it('a content-only step is auto-protected, in words that say what a content tag hides', () => {
    const contentOnly = summarizeRecipePiiPosture(recipeWith([
      source('message', 'message-source'),
      aiClassify('ai', { 'llm.data': '{{step.message}}' }),
    ]), classifierFrom({
      'message-source': { body: ['content'] },
    }));

    expect(contentOnly).toEqual({
      headline: 'Recued will auto-protect 1 AI step at run time.',
      auto_protected: [
        {
          step_id: 'ai',
          message:
            "AI step 'ai' (ai-classify): Recued injects llm.pii_fields at run time — "
            + 'the contacts the server knows and every email in body aliased before egress.',
        },
      ],
      warnings: [],
      infos: [
        {
          step_id: 'ai',
          message:
            "AI step 'ai' (ai-classify) receives free-text content fields that may mention identifiers — "
            + 'Recued tags them `content` at run time, which hides the contacts the server knows and every '
            + 'email in them; tag the identifier fields they draw on (llm.pii_fields) to hide the rest',
        },
      ],
    });
  });

  it('an identifier and a content tag are each described for what they hide', () => {
    const mixed = summarizeRecipePiiPosture(recipeWith([
      source('message', 'message-source'),
      aiClassify('ai', { 'llm.data': '{{step.message}}' }),
    ]), classifierFrom({
      'message-source': { from: ['email'], body: ['content'] },
    }));

    expect(mixed.auto_protected).toEqual([
      {
        step_id: 'ai',
        message:
          "AI step 'ai' (ai-classify): Recued injects llm.pii_fields at run time — from (email) aliased; "
          + 'the contacts the server knows and every email in body aliased before egress.',
      },
    ]);
  });

  it('a content-only step auto-PII cannot tag is an info line, never a manual identifier leak', () => {
    const interpolated = summarizeRecipePiiPosture(recipeWith([
      source('message', 'message-source'),
      { id: 'ai', ingredient: 'ai-prompt', input: { 'llm.prompt': 'Summarize: {{step.message.body}}' } },
    ]), classifierFrom({
      'message-source': { body: ['content'] },
    }));

    expect(interpolated.headline).toBe('');
    expect(interpolated.auto_protected).toEqual([]);
    expect(interpolated.warnings).toEqual([]);
    expect(interpolated.infos.map((line) => line.step_id)).toEqual(['ai']);
  });

  it('keeps declaration-only findings out of the headline', () => {
    const declarationOnly = summarizeRecipePiiPosture(recipeWith([
      {
        id: 'legacy',
        transform: 'hash_replace',
        pii_fields: ['profile.email'],
      },
    ]));

    expect(declarationOnly).toEqual({
      headline: '',
      auto_protected: [],
      warnings: [
        {
          step_id: 'legacy',
          message:
            "step 'legacy' pii_fields entries [profile.email] are path-form — "
            + 'hash_replace matches bare field names at any depth, so these never match anything '
            + "and protect nothing; declare the bare names instead (e.g. 'email')",
        },
      ],
      infos: [],
    });
  });

  it('is deterministic for two calls with the same recipe and classifier', () => {
    const recipe = recipeWith([
      source('profile', 'profile-source'),
      aiClassify('auto', { 'llm.data': '{{step.profile}}' }),
      source('email', 'email-source'),
      aiClassify('manual', { 'llm.prompt': '{{step.email}} text' }),
    ]);
    const classifier = classifierFrom({
      'profile-source': { email: ['email'], name: ['name'] },
      'email-source': { '': ['email'] },
    });

    const first = summarizeRecipePiiPosture(recipe, classifier);
    const second = summarizeRecipePiiPosture(recipe, classifier);

    expect(first).toEqual(second);
  });

  it('redacts unrecognizable legacy pii_fields entries from declaration warnings', () => {
    const summary = summarizeRecipePiiPosture(recipeWith([
      {
        id: 'legacy',
        transform: 'hash_replace',
        pii_fields: [
          'alice@example.com',
          'customer.ssn.123-45-6789',
          'contacts[].email',
        ],
      },
    ]));

    const message = summary.warnings[0]?.message ?? '';
    expect(message).toContain('contacts[].email');
    expect(message).toContain('2 entries not shown (not a recognizable field path)');
    expect(message).not.toContain('alice@example.com');
    expect(message).not.toContain('123-45-6789');
  });
});
