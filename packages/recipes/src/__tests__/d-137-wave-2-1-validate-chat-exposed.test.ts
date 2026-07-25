/** D-137 Wave 2.1 — `chat_exposed` validator acceptance.
 *
 *  The structural validator enforces boolean shape on the new top-
 *  level `chat_exposed` field. Mirrors the pattern established by
 *  `validateProvenance` — absence = default (true), boolean = accept,
 *  anything else = `chat_exposed_shape` error.
 *
 *  Codifying the shape at parse time keeps the projection helper in
 *  `chat-catalog.ts` simple: it only branches on explicit `false`,
 *  trusting that any other value either never reached the registry
 *  (validator rejected) or is `true`. */

import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import type { RecipeDefinition } from '@recued/contracts';

const base: RecipeDefinition = {
  recipe_id: 'd-137-wave-2-1-chat-exposed',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Chat exposed test recipe',
    description: 'Recipe under test for the D-137 Wave 2.1 chat_exposed validator.',
    author: 'recued',
    supported_platforms: ['gmail'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
  output: { sidebar: [{ type: 'summary', source: 'step.noop' }] },
};

describe('D-137 Wave 2.1 — chat_exposed validator', () => {
  it('absent chat_exposed passes (default-true)', () => {
    const result = validateRecipe(base);
    expect(result.valid).toBe(true);
    expect(
      result.issues.find((i) => i.code === 'chat_exposed_shape'),
    ).toBeUndefined();
  });

  it('chat_exposed: true is accepted', () => {
    const result = validateRecipe({ ...base, chat_exposed: true });
    expect(result.valid).toBe(true);
    expect(
      result.issues.find((i) => i.code === 'chat_exposed_shape'),
    ).toBeUndefined();
  });

  it('chat_exposed: false is accepted (opt-out)', () => {
    const result = validateRecipe({ ...base, chat_exposed: false });
    expect(result.valid).toBe(true);
    expect(
      result.issues.find((i) => i.code === 'chat_exposed_shape'),
    ).toBeUndefined();
  });

  it('chat_exposed: "yes" (string) raises chat_exposed_shape', () => {
    const result = validateRecipe({
      ...base,
      chat_exposed: 'yes',
    } as unknown as RecipeDefinition);
    const issue = result.issues.find((i) => i.code === 'chat_exposed_shape');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.path).toBe('chat_exposed');
  });

  it('chat_exposed: null raises chat_exposed_shape (avoid silent-default footgun)', () => {
    const result = validateRecipe({
      ...base,
      chat_exposed: null,
    } as unknown as RecipeDefinition);
    const issue = result.issues.find((i) => i.code === 'chat_exposed_shape');
    expect(issue).toBeDefined();
  });

  it('chat_exposed: 1 raises chat_exposed_shape', () => {
    const result = validateRecipe({
      ...base,
      chat_exposed: 1,
    } as unknown as RecipeDefinition);
    const issue = result.issues.find((i) => i.code === 'chat_exposed_shape');
    expect(issue).toBeDefined();
  });
});
