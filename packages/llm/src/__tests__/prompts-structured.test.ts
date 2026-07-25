import { describe, it, expect } from 'vitest';
import { buildUncontractedPrompt } from '../prompts.js';
import { LLMError } from '../types.js';

describe('buildUncontractedPrompt structured legacy prompt values', () => {
  it('renders object llm.prompt as pretty JSON', () => {
    const prompt = { deal: { stage: 'won' }, amount: 12 };
    const content = JSON.stringify(prompt, null, 2);
    const messages = buildUncontractedPrompt({ 'llm.prompt': prompt });

    expect(messages).toEqual([{ role: 'user', content }]);
    expect(messages[0].content).not.toContain('[object Object]');
  });

  it('renders array llm.prompt as pretty JSON', () => {
    const prompt = [{ id: 'a' }, { id: 'b' }];

    expect(buildUncontractedPrompt({ 'llm.prompt': prompt })).toEqual([
      { role: 'user', content: JSON.stringify(prompt, null, 2) },
    ]);
  });

  it('passes string llm.prompt through byte-identically', () => {
    const prompt = 'Line 1\n{"already":"formatted"}';

    expect(buildUncontractedPrompt({ 'llm.prompt': prompt })).toEqual([
      { role: 'user', content: prompt },
    ]);
  });

  it('renders object llm.system_prompt as pretty JSON', () => {
    const system = { mode: 'audit', rules: ['concise'] };
    const messages = buildUncontractedPrompt({
      'llm.system_prompt': system,
      'llm.prompt': 'Summarize',
    });

    expect(messages).toEqual([
      { role: 'system', content: JSON.stringify(system, null, 2) },
      { role: 'user', content: 'Summarize' },
    ]);
  });

  it('throws AI_OUTPUT_INVALID when llm.prompt is missing', () => {
    try {
      buildUncontractedPrompt({});
      throw new Error('expected buildUncontractedPrompt to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).code).toBe('AI_OUTPUT_INVALID');
    }
  });

  it('fails open to a plain string turn when cache_prefix misses a pretty JSON prompt', () => {
    const prompt = { text: 'body' };
    const content = JSON.stringify(prompt, null, 2);
    const messages = buildUncontractedPrompt({
      'llm.prompt': prompt,
      'llm.cache_prefix': 'text',
    });

    expect(messages).toEqual([{ role: 'user', content }]);
    expect(messages[0].content_parts).toBeUndefined();
  });

  it('keeps string-prompt cache prefix splitting unchanged', () => {
    const prefix = '{"available_tools":[]}';
    const prompt = `${prefix}\nquestion`;
    const messages = buildUncontractedPrompt({
      'llm.prompt': prompt,
      'llm.cache_prefix': prefix,
    });

    expect(messages).toEqual([
      {
        role: 'user',
        content: prompt,
        content_parts: [
          { type: 'text', text: prefix, cache_breakpoint: true },
          { type: 'text', text: '\nquestion' },
        ],
      },
    ]);
  });
});
