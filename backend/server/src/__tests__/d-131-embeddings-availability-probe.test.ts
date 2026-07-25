/** D-131 Phase 3 / D-174 R28 Slice C — embeddings-side path availability
 *  probe tests.
 *
 *  Drives `probeEmbeddingsPathAvailability` directly. The Run-Now dialog
 *  calls this for any producer whose output schema contains a vector.
 *
 *  Slice C made embeddings a dedicated slot (`config.embeddings_slot`), so
 *  the probe maps that ONE slot's status → the three reasons:
 *    - `no_byok_no_freepool` — no embeddings slot configured at all
 *      (incl. the pure-Anthropic case: chat works, embeddings unset).
 *    - `no_embeddings_model` — a slot exists (with a key) but its model
 *      is unset (a half-configured slot).
 *    - `quota_exhausted` — the slot is configured but in cooldown. */

import { describe, expect, it } from 'vitest';

import { probeEmbeddingsPathAvailability } from '../housekeeping/ai-availability.js';
import { createQuotaTracker, type LLMConfig, type LLMSlot } from '@recued/llm';

/** A dedicated embeddings slot — its `model` field IS the embeddings model. */
const embeddingsSlot = (overrides: Partial<LLMSlot> = {}): LLMSlot => ({
  provider: 'openai',
  model: 'text-embedding-3-small',
  api_key: 'sk-test',
  ...overrides,
});

const anthropicChatSlot: LLMSlot = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  api_key: 'sk-ant',
  speed: 'quality',
};

describe('probeEmbeddingsPathAvailability', () => {
  it('returns no_byok_no_freepool when LLMConfig is undefined', () => {
    const result = probeEmbeddingsPathAvailability(undefined, createQuotaTracker());
    expect(result).toEqual({ available: false, reason: 'no_byok_no_freepool' });
  });

  it('returns available=true when the embeddings slot has both key + model', () => {
    const result = probeEmbeddingsPathAvailability(
      { embeddings_slot: embeddingsSlot() },
      createQuotaTracker(),
    );
    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns no_byok_no_freepool for the pure-Anthropic case (chat key, no embeddings slot)', () => {
    // Anthropic chat works fine; the user simply hasn't set up an embeddings
    // slot. Distinct from `no_embeddings_model` (a half-configured slot).
    const config: LLMConfig = { slot_1: anthropicChatSlot };
    const result = probeEmbeddingsPathAvailability(config, createQuotaTracker());
    expect(result).toEqual({ available: false, reason: 'no_byok_no_freepool' });
  });

  it('returns no_byok_no_freepool when literally nothing is configured', () => {
    const result = probeEmbeddingsPathAvailability({}, createQuotaTracker());
    expect(result).toEqual({ available: false, reason: 'no_byok_no_freepool' });
  });

  it('returns no_embeddings_model when an embeddings slot exists (with a key) but its model is unset', () => {
    const config: LLMConfig = { embeddings_slot: { ...embeddingsSlot(), model: '' } };
    const result = probeEmbeddingsPathAvailability(config, createQuotaTracker());
    expect(result).toEqual({ available: false, reason: 'no_embeddings_model' });
  });

  it('returns quota_exhausted when the embeddings slot is in cooldown', () => {
    const quota = createQuotaTracker();
    quota.markRateLimited('embeddings_slot');
    const result = probeEmbeddingsPathAvailability(
      { embeddings_slot: embeddingsSlot() },
      quota,
    );
    expect(result).toEqual({ available: false, reason: 'quota_exhausted' });
  });

  it('ignores chat slots — a configured chat slot_1 does NOT make embeddings available', () => {
    // Embeddings reads ONLY config.embeddings_slot; a chat fleet is irrelevant.
    const config: LLMConfig = { slot_1: embeddingsSlot() };
    const result = probeEmbeddingsPathAvailability(config, createQuotaTracker());
    expect(result).toEqual({ available: false, reason: 'no_byok_no_freepool' });
  });
});
