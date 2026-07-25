/** D-172 P5 — config trust boundary preserves modality + transcription
 *  declarations (without this, a configured model is read as text-only and
 *  every media turn fails AI_MODALITY_UNSUPPORTED). */
import { describe, it, expect } from 'vitest';
import { parseLLMConfig, LLMConfigValidationError } from '../validate-config.js';

describe('parseLLMConfig — modalities + transcription_model (P5)', () => {
  it('preserves modalities + transcription_model on a slot', () => {
    const out = parseLLMConfig({
      slot_1: {
        provider: 'openai', model: 'gpt-4o', api_key: 'sk',
        modalities: { image: true, audio: true }, transcription_model: 'whisper-1',
      },
    });
    expect(out.slot_1?.modalities).toEqual({ image: true, audio: true });
    expect(out.slot_1?.transcription_model).toBe('whisper-1');
  });

  it('preserves modalities + transcription_model on a free-pool api entry', () => {
    const out = parseLLMConfig({
      free_pool: [{
        id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'gsk',
        speed: 'fast', supports_json: true, enabled: true,
        modalities: { audio: true }, transcription_model: 'whisper-large-v3',
      }],
    });
    const entry = out.free_pool?.[0];
    expect(entry && 'modalities' in entry && entry.modalities).toEqual({ audio: true });
    expect(entry && 'transcription_model' in entry && entry.transcription_model).toBe('whisper-large-v3');
  });

  it('omits modalities when absent (text-only slot round-trips unchanged)', () => {
    const out = parseLLMConfig({ slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk' } });
    expect(out.slot_1?.modalities).toBeUndefined();
    expect(out.slot_1?.transcription_model).toBeUndefined();
  });

  it('rejects a non-boolean modality flag with a field path', () => {
    expect(() =>
      parseLLMConfig({ slot_1: { provider: 'openai', model: 'm', api_key: 'k', modalities: { image: 'yes' } } }),
    ).toThrow(LLMConfigValidationError);
  });

  it('rejects a non-string transcription_model', () => {
    expect(() =>
      parseLLMConfig({ slot_1: { provider: 'openai', model: 'm', api_key: 'k', transcription_model: 5 } }),
    ).toThrow(LLMConfigValidationError);
  });
});
