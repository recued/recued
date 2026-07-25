/** D-116 Phase 8 — AI-prompt hardening surface. */

import { describe, it, expect } from 'vitest';
import {
  buildUncontractedPrompt,
  __D116_DELIMITER_SENTINEL,
} from '../prompts.js';
import { LLMError } from '../types.js';
import { ENGINE_LOCKED_INPUT_KEYS } from '@recued/contracts';

describe('buildUncontractedPrompt — new instruction_block / data_block shape', () => {
  it('concatenates system + delimiter + user with the engine sentinel', () => {
    const messages = buildUncontractedPrompt({
      'llm.instruction_block': 'You are a classifier.',
      'llm.data_block': { deal: { stage: 'closed-won' } },
    });
    expect(messages).toHaveLength(2);
    const system = messages[0].content;
    expect(messages[0].role).toBe('system');
    expect(system).toContain('You are a classifier.');
    expect(system).toContain(__D116_DELIMITER_SENTINEL);

    const user = messages[1].content;
    expect(messages[1].role).toBe('user');
    expect(user).toContain(__D116_DELIMITER_SENTINEL);
    expect(user).toContain('closed-won');
  });

  it('serialises non-string data_block via JSON', () => {
    const messages = buildUncontractedPrompt({
      'llm.instruction_block': 'Extract',
      'llm.data_block': [1, 2, 3],
    });
    expect(messages[1].content).toContain('[\n  1,\n  2,\n  3\n]');
  });

  it('errors when only one of instruction_block / data_block is set', () => {
    expect(() => buildUncontractedPrompt({
      'llm.instruction_block': 'hi',
    })).toThrow(LLMError);
    expect(() => buildUncontractedPrompt({
      'llm.data_block': 'hi',
    })).toThrow(LLMError);
  });

  it('sentinel is long + high-entropy (recipes cannot trivially recreate it)', () => {
    expect(__D116_DELIMITER_SENTINEL.length).toBeGreaterThan(40);
    expect(__D116_DELIMITER_SENTINEL).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe('buildUncontractedPrompt — legacy fallback', () => {
  it('uses system_prompt + prompt verbatim when new fields are absent', () => {
    const messages = buildUncontractedPrompt({
      'llm.system_prompt': 'You are a helper.',
      'llm.prompt': 'Say hi.',
    });
    expect(messages).toEqual([
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Say hi.' },
    ]);
    // Legacy path never inserts the D-116 delimiter.
    expect(messages[0].content).not.toContain(__D116_DELIMITER_SENTINEL);
    expect(messages[1].content).not.toContain(__D116_DELIMITER_SENTINEL);
  });

  it('still errors when legacy `llm.prompt` is absent entirely', () => {
    expect(() => buildUncontractedPrompt({})).toThrow(LLMError);
  });
});

describe('ENGINE_LOCKED_INPUT_KEYS — llm.delimiter', () => {
  it('includes llm.delimiter so recipes cannot hijack the sentinel', () => {
    expect(ENGINE_LOCKED_INPUT_KEYS).toContain('llm.delimiter');
  });
});
