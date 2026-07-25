/** D-123 follow-on — pre-confirm AI-availability probe tests.
 *
 *  Drives `probeAiPathAvailability` directly with stubbed configs +
 *  quota trackers. The probe is the gate the Run-Now dialog uses to
 *  decide whether to render the warning state ("Configure AI in
 *  Settings → AI before running") instead of the standard cost
 *  preview. */

import { describe, expect, it } from 'vitest';

import { probeAiPathAvailability } from '../housekeeping/ai-availability.js';
import { createQuotaTracker, type LLMConfig } from '@recued/llm';

const slot1 = (overrides: Partial<LLMConfig['slot_1']> = {}): LLMConfig['slot_1'] => ({
  provider: 'openai',
  model: 'gpt-4.1-mini',
  api_key: 'sk-test',
  speed: 'fast',
  supports_json: true,
  ...overrides,
});

describe('probeAiPathAvailability', () => {
  it('returns no_byok_no_freepool when LLMConfig is undefined', async () => {
    const result = await probeAiPathAvailability(undefined, createQuotaTracker());
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no_byok_no_freepool');
  });

  it('returns available=true when slot_1 is configured with a key + model', async () => {
    const config: LLMConfig = { slot_1: slot1() };
    const result = await probeAiPathAvailability(config, createQuotaTracker());
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns no_byok_no_freepool when slot_1 has no api_key', async () => {
    const config: LLMConfig = {
      slot_1: slot1({ api_key: '' }),
    };
    const result = await probeAiPathAvailability(config, createQuotaTracker());
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no_byok_no_freepool');
  });

  it('returns quota_exhausted when the only configured slot is in cooldown', async () => {
    const config: LLMConfig = { slot_1: slot1() };
    const quota = createQuotaTracker();
    // 60s default cooldown is enough for the snapshot to flip slot_1
    // to `available: false, reason: 'quota_exhausted'`.
    quota.markRateLimited('slot_1');
    const result = await probeAiPathAvailability(config, quota);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('quota_exhausted');
  });
});
