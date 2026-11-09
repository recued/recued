/** D-344 — a server configured by its environment sets each slot's thinking too: an environment slot
 *  wins over a stored one, so without this a thinking setting could not reach it. */
import { describe, expect, it } from 'vitest';

import { resolveLLMConfigFromEnv } from '../llm-env.js';

const base = { RECUED_LLM_PROVIDER: 'openai-compatible', RECUED_LLM_MODEL: 'm', RECUED_LLM_API_KEY: 'k',
  RECUED_LLM_SLOT2_PROVIDER: 'openai-compatible', RECUED_LLM_SLOT2_MODEL: 'm2', RECUED_LLM_SLOT2_API_KEY: 'k2' };

describe('D-344 — RECUED_LLM_THINKING and RECUED_LLM_SLOT2_THINKING', () => {
  it('set each slot\'s thinking, on or off', () => {
    const config = resolveLLMConfigFromEnv({ ...base, RECUED_LLM_THINKING: 'off', RECUED_LLM_SLOT2_THINKING: 'on' });
    expect(config?.slot_1?.thinking).toBe('off');
    expect(config?.slot_2?.thinking).toBe('on');
  });

  it('leave the provider\'s default when unset, and take nothing else for a setting', () => {
    expect(resolveLLMConfigFromEnv(base)?.slot_1).not.toHaveProperty('thinking');
    expect(resolveLLMConfigFromEnv({ ...base, RECUED_LLM_THINKING: 'false' })?.slot_1).not.toHaveProperty('thinking');
  });
});
