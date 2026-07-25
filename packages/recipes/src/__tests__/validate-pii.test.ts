import { describe, expect, it } from 'vitest';

import type { PiiPathProfile, PiiSourceClassifier } from '@recued/contracts';
import { validateRecipePii } from '@recued/recipes';

const classifierFrom = (
  profiles: Record<string, PiiPathProfile>,
): PiiSourceClassifier => (step) => {
  if (typeof step.ingredient === 'string' && profiles[step.ingredient]) {
    return profiles[step.ingredient];
  }
  if (typeof step.op === 'string' && profiles[step.op]) {
    return profiles[step.op];
  }
  return undefined;
};

const validate = (
  steps: unknown[],
  profiles: Record<string, PiiPathProfile> = {},
) => validateRecipePii({ steps }, classifierFrom(profiles));

describe('validateRecipePii', () => {
  it('warns on pii_reaches_llm with injectable and pii-protect hints', () => {
    const injectable = validate([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.contact}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    expect(injectable.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'pii_reaches_llm',
        step_id: 'ai',
      }),
    ]);
    expect(injectable.issues[0]?.message).toContain('auto-PII inject');

    const nonContracted = validate([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'prompt', ingredient: 'ai-prompt', input: { 'llm.data': '{{step.contact}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    expect(nonContracted.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'pii_reaches_llm',
        step_id: 'prompt',
      }),
    ]);
    expect(nonContracted.issues[0]?.message).toContain('pii-protect / pii-restore');
  });

  it('reports content-only leaks as info', () => {
    const result = validate([
      { id: 'message', ingredient: 'message-source' },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.message}}' } },
    ], {
      'message-source': { body: ['content'] },
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'info',
        code: 'pii_content_reaches_llm',
        step_id: 'ai',
      }),
    ]);
  });

  it('reports pii_untraced info with the upstream reason', () => {
    const result = validate([
      { id: 'opaque', transform: 'future_transform' },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.opaque}}' } },
    ]);

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'info',
        code: 'pii_untraced',
        step_id: 'ai',
      }),
    ]);
    expect(result.issues[0]?.message).toContain("transform 'future_transform' has no PII-flow rule");
  });

  it('warns on path-form legacy pii_fields on any step and suggests a bare name', () => {
    const result = validateRecipePii({
      prefetch_steps: [
        { id: 'prefetch', ingredient: 'contact-source', pii_fields: ['contacts[].email'] },
      ],
      steps: [
        { id: 'transform', transform: 'count', pii_fields: ['profile.phone'] },
        { id: 'ai', ingredient: 'ai-classify', pii_fields: ['email'], input: { 'llm.data': 'ok' } },
      ],
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'pii_declaration_ineffective',
        step_id: 'prefetch',
      }),
      expect.objectContaining({
        severity: 'warning',
        code: 'pii_declaration_ineffective',
        step_id: 'transform',
      }),
    ]);
    expect(result.issues[0]?.message).toContain("'email'");
    expect(result.issues[1]?.message).toContain("'phone'");
  });

  it('does not warn on bare-name legacy pii_fields entries', () => {
    const result = validateRecipePii({
      steps: [
        { id: 'source', ingredient: 'contact-source', pii_fields: ['email', 'phone'] },
        { id: 'ai', ingredient: 'ai-classify', pii_fields: ['email'], input: { 'llm.data': 'ok' } },
      ],
    });

    expect(result.issues).toEqual([]);
  });

  it('returns trace and injection plan for a clean recipe', () => {
    const result = validate([
      { id: 'source', ingredient: 'clean-source' },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.source}}' } },
    ], {
      'clean-source': {},
    });

    expect(result.issues).toEqual([]);
    expect(result.trace.findings).toEqual([
      expect.objectContaining({ step_id: 'ai', verdict: 'clean' }),
    ]);
    expect(result.injection_plan).toEqual({ injections: [], gaps: [] });
  });

  it('is classifier-optional and does not invent source findings', () => {
    const result = validateRecipePii({
      steps: [
        { id: 'contact', ingredient: 'contact-source' },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.contact}}' } },
      ],
    });

    expect(result.issues).toEqual([]);
    expect(result.trace.findings).toEqual([
      expect.objectContaining({ step_id: 'ai', verdict: 'clean' }),
    ]);
  });
});
