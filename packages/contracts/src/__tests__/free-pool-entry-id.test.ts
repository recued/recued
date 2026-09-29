import { describe, expect, it } from 'vitest';
import { suggestFreePoolEntryId } from '../free-pool-entry-id.js';

const none: ReadonlySet<string> = new Set();

describe('suggestFreePoolEntryId', () => {
  it('names an entry after the service its address reaches', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['https://api.groq.com/openai/v1', 'groq'],
      ['https://openrouter.ai/api/v1', 'openrouter'],
      ['https://api.mistral.ai/v1', 'mistral'],
      ['https://api.cerebras.ai/v1', 'cerebras'],
      ['https://integrate.api.nvidia.com/v1', 'nvidia'],
      ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini'],
    ];
    for (const [base_url, name] of cases) {
      expect(suggestFreePoolEntryId({ provider: 'openai-compatible', base_url }, none))
        .toBe(name);
    }
  });

  it('names anything on the owner’s own network local', () => {
    for (const base_url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://192.168.1.20:8000/v1',
      'http://ollama:11434/v1',
      'http://gpu-box.local:8000/v1',
    ]) {
      expect(suggestFreePoolEntryId({ provider: 'openai-compatible', base_url }, none))
        .toBe('local');
    }
  });

  it('falls back to the protocol without a usable address', () => {
    expect(suggestFreePoolEntryId({ provider: 'anthropic' }, none)).toBe('anthropic');
    expect(suggestFreePoolEntryId({ provider: 'google' }, none)).toBe('gemini');
    expect(suggestFreePoolEntryId({ provider: 'openai', base_url: 'not a url' }, none))
      .toBe('openai');
    // A public IP address is not a name.
    expect(suggestFreePoolEntryId({ provider: 'openai', base_url: 'https://203.0.113.9/v1' }, none))
      .toBe('openai');
  });

  /** ⛔ A plain object keyed by the provider would find `constructor` on its
   *  prototype and return a function for a name. */
  it('answers an unknown protocol with a plain name, not a prototype member', () => {
    expect(suggestFreePoolEntryId({ provider: 'constructor' }, none)).toBe('entry');
    expect(suggestFreePoolEntryId({}, none)).toBe('entry');
  });

  it('keeps clear of names already taken', () => {
    const taken = new Set(['groq', 'groq-2']);
    expect(suggestFreePoolEntryId(
      { provider: 'openai-compatible', base_url: 'https://api.groq.com/openai/v1' },
      taken,
    )).toBe('groq-3');
  });
});
