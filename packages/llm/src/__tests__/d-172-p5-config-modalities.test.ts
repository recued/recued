/** D-172 P5 — config trust boundary preserves modality + transcription
 *  declarations (without this, a configured model is read as text-only and
 *  every media turn fails AI_MODALITY_UNSUPPORTED). */
import { describe, it, expect } from 'vitest';
import { parseLLMConfig, LLMConfigValidationError } from '../validate-config.js';

describe('parseLLMConfig — modalities (P5), and transcription_model retired (D-262)', () => {
  it('preserves modalities on a slot', () => {
    const out = parseLLMConfig({
      slot_1: {
        provider: 'openai', model: 'gpt-4o', api_key: 'sk',
        modalities: { image: true, audio: true },
      },
    });
    expect(out.slot_1?.modalities).toEqual({ image: true, audio: true });
  });

  it('preserves modalities on a free-pool api entry', () => {
    const out = parseLLMConfig({
      free_pool: [{
        id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'gsk',
        speed: 'fast', supports_json: true, enabled: true,
        modalities: { audio: true },
      }],
    });
    const entry = out.free_pool?.[0];
    expect(entry && 'modalities' in entry && entry.modalities).toEqual({ audio: true });
  });

  it('⛔ RETIRED — DROPS a slot\'s transcription_model instead of preserving it', () => {
    // D-262 § B4. It named a second model for `transcribe` to use, which only
    // made sense while transcription routed through the chat pool. It reads the
    // dedicated `transcription_slot` now, whose own `model` IS the
    // transcription model — so a second field could only ever disagree with the
    // thing in use.
    const out = parseLLMConfig({
      slot_1: {
        provider: 'openai', model: 'gpt-4o', api_key: 'sk',
        transcription_model: 'whisper-1',
      },
    });
    expect(out.slot_1).toBeDefined();
    expect('transcription_model' in (out.slot_1 as object)).toBe(false);
  });

  it('⛔ RETIRED — drops it on a pool entry too, without refusing the import', () => {
    // ⚠ DROPPED, NOT REJECTED, and deliberately: an owner importing a config
    // exported before the retirement should get a working config minus a dead
    // field, not a failed import. A retired field stops taking effect; it does
    // not start breaking things.
    const out = parseLLMConfig({
      free_pool: [{
        id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'gsk',
        speed: 'fast', supports_json: true, enabled: true,
        transcription_model: 'whisper-large-v3',
      }],
    });
    const entry = out.free_pool?.[0];
    expect(entry).toBeDefined();
    expect('transcription_model' in (entry as object)).toBe(false);
  });

  it('omits modalities when absent (text-only slot round-trips unchanged)', () => {
    const out = parseLLMConfig({ slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk' } });
    expect(out.slot_1?.modalities).toBeUndefined();
  });

  it('rejects a non-boolean modality flag with a field path', () => {
    expect(() =>
      parseLLMConfig({ slot_1: { provider: 'openai', model: 'm', api_key: 'k', modalities: { image: 'yes' } } }),
    ).toThrow(LLMConfigValidationError);
  });

  it('⛔ RETIRED — a MALFORMED transcription_model no longer throws either', () => {
    // The validation went with the field. A stored blob carrying `5` there is
    // now simply ignored, which is the right behaviour for a value nothing
    // reads: refusing to parse a config over a dead field would strand an
    // owner on an import they cannot fix.
    expect(() =>
      parseLLMConfig({ slot_1: { provider: 'openai', model: 'm', api_key: 'k', transcription_model: 5 } }),
    ).not.toThrow();
  });
});
