import { describe, expect, it } from 'vitest';

import { PII_LIST_SEGMENT } from '@recued/contracts';
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

  // The step-level hash swaps a text value for one token (the model reads nothing)
  // and sends a list or object under the name as it is: it hides nothing INSIDE
  // text. The `content` tag does, so the warning points there.
  describe('pii_declaration_names_content — a legacy entry over free text', () => {
    const mailProfiles: Record<string, PiiPathProfile> = {
      'mail-source': { subject: ['content'], body: ['content'], from: ['email'] },
      'mail-list': { [`${PII_LIST_SEGMENT}.subject`]: ['content'], [`${PII_LIST_SEGMENT}.from`]: ['email'] },
    };
    const namesContent = (steps: unknown[]) =>
      validate(steps, mailProfiles).issues.filter((i) => i.code === 'pii_declaration_names_content');

    it('warns on the text entry, not the identifier, and names the llm.pii_fields tag that replaces it', () => {
      const issues = namesContent([
        { id: 'mail', ingredient: 'mail-source' },
        { id: 'ai', ingredient: 'ai-classify', pii_fields: ['subject', 'from'], input: { 'llm.data': '{{step.mail}}' } },
      ]);
      expect(issues).toEqual([expect.objectContaining({ severity: 'warning', step_id: 'ai' })]);
      expect(issues[0]!.message).toBe(
        "AI step 'ai' (ai-classify): pii_fields entry 'subject' covers free text (llm.data.subject) — "
        + 'step-level pii_fields swaps every value under the name for a token, so the model gets a token in '
        + "place of the text; keep pii_fields to identifier fields and tag 'subject' `content` in "
        + 'llm.pii_fields instead, which hides the contacts the server knows and every email in the text '
        + 'while the model still reads it',
      );
    });

    it('a batch call is tagged item-relative; several entries are listed once', () => {
      const issues = namesContent([
        { id: 'mails', ingredient: 'mail-list' },
        { id: 'mail', ingredient: 'mail-source' },
        {
          id: 'ai',
          ingredient: 'ai-classify',
          pii_fields: ['subject', 'body'],
          input: { 'llm.data': '{{step.mails}}', 'llm.id_field': 'message_id' },
        },
        {
          id: 'ai_two',
          ingredient: 'ai-summarize',
          pii_fields: ['subject', 'body'],
          input: { 'llm.data': '{{step.mail}}' },
        },
      ]);
      expect(issues.map((i) => i.step_id)).toEqual(['ai', 'ai_two']);
      expect(issues[0]!.message).toContain(`free text (llm.data.${PII_LIST_SEGMENT}.subject)`);
      expect(issues[0]!.message).toContain("tag 'subject' `content` in llm.pii_fields");
      expect(issues[1]!.message).toContain("entries 'body', 'subject' cover free text (llm.data.body, llm.data.subject)");
      expect(issues[1]!.message).toContain("tag 'body', 'subject' `content` in llm.pii_fields instead");
    });

    it('an entry naming a field ABOVE the text covers it too, and the tag names the text', () => {
      const issues = namesContent([
        { id: 'mail', ingredient: 'mail-source' },
        { id: 'ai', ingredient: 'ai-classify', pii_fields: ['mail'], input: { 'llm.data': { mail: '{{step.mail}}' } } },
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain("entry 'mail' covers free text (llm.data.mail.body, llm.data.mail.subject)");
      expect(issues[0]!.message).toContain("tag 'mail.body', 'mail.subject' `content` in llm.pii_fields instead");
    });

    it('points at a pii-protect bracket where llm.pii_fields cannot reach the text', () => {
      const issues = namesContent([
        { id: 'mail', ingredient: 'mail-source' },
        { id: 'mails', ingredient: 'mail-list' },
        // ai-prompt has no llm.pii_fields.
        { id: 'prompt', ingredient: 'ai-prompt', pii_fields: ['subject'], input: { 'llm.prompt': '{{step.mail}}' } },
        // A list inside llm.data, not a batch call: no tag path crosses it.
        { id: 'nested', ingredient: 'ai-classify', pii_fields: ['subject'], input: { 'llm.data': { mails: '{{step.mails}}' } } },
      ]);
      expect(issues.map((i) => i.step_id)).toEqual(['prompt', 'nested']);
      for (const issue of issues) {
        expect(issue.message).toContain('give the text a `content` tag in a pii-protect / pii-restore bracket upstream');
      }
    });

    it('says nothing when no source calls the field free text', () => {
      expect(namesContent([
        { id: 'mail', ingredient: 'mail-source' },
        { id: 'ai', ingredient: 'ai-classify', pii_fields: ['from', 'snippet'], input: { 'llm.data': '{{step.mail}}' } },
      ])).toEqual([]);
    });
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
