/** D-262 § B1/B4/B6 — transcription reads ONE dedicated source.
 *
 *  ⛔ THE LOAD-BEARING TEST IS THE SECOND ONE. Before this slice, transcription
 *  resolved an audio-capable model through `matchLLM` over slot_1 / slot_2 /
 *  free_pool — so a voice turn could be served by a different model than the
 *  one the owner pinned for chat. Falling back on the HEARING is fine; falling
 *  back on the ANSWERING is a silent substitution. A config whose chat sources
 *  are audio-capable and whose transcription slot is absent must therefore
 *  FAIL, not quietly succeed through the pool.
 */

import { describe, expect, it, vi } from 'vitest';

import { transcribe } from '../transcribe.js';
import { createQuotaTracker } from '../quota.js';
import { LLMError, type LLMConfig } from '../types.js';
import type {
  TranscriptionAdapterRegistry,
  TranscriptionRequest,
} from '../adapters/transcription.js';

const capture = () => {
  const calls: Array<{ slot: unknown; request: TranscriptionRequest; model: string }> = [];
  const adapters: TranscriptionAdapterRegistry = (key) => ({
    provider: key,
    async transcribe(slot, request, options) {
      calls.push({ slot, request, model: options.model });
      return { text: 'heard it' };
    },
  });
  return { adapters, calls };
};

const run = async (config: LLMConfig, request?: Partial<TranscriptionRequest>) => {
  const { adapters, calls } = capture();
  const result = await transcribe(
    { audio: new Uint8Array([1, 2, 3]), mime_type: 'audio/ogg', ...request },
    { config, adapters, quota: createQuotaTracker() },
  );
  return { result, calls };
};

const slot = { provider: 'openai' as const, model: 'whisper-1', api_key: 'sk-t' };

describe('D-262 — the dedicated transcription slot', () => {
  it('transcribes through the slot, using the SLOT MODEL verbatim', async () => {
    const { result, calls } = await run({ transcription_slot: slot });
    expect(result.text).toBe('heard it');
    // The slot's own `model` IS the transcription model — no provider default
    // is consulted, so an owner who typed `whisper-1` gets `whisper-1`.
    expect(calls[0]?.model).toBe('whisper-1');
  });

  it('⛔ REFUSES when no slot is set, even with audio-capable CHAT sources', async () => {
    const config: LLMConfig = {
      slot_1: {
        provider: 'openai', model: 'gpt-4o-audio-preview', api_key: 'sk-chat',
        speed: 'fast', supports_json: true, modalities: { audio: true },
      },
      free_pool: [{
        id: 'p1', type: 'api', provider: 'openai-compatible', model: 'llama',
        api_key: 'gsk', speed: 'fast', supports_json: true, enabled: true,
        modalities: { audio: true },
      }],
    };
    const { adapters, calls } = capture();
    await expect(transcribe(
      { audio: new Uint8Array([1]), mime_type: 'audio/ogg' },
      { config, adapters, quota: createQuotaTracker() },
    )).rejects.toMatchObject({ code: 'AI_NO_TRANSCRIPTION_SOURCE' });
    // ⛔ Not one call. Both of those sources declare audio and both carry a
    // transcription model; reaching either would be the silent substitution
    // this slot exists to make impossible.
    expect(calls).toHaveLength(0);
  });

  it('distinguishes "nothing configured" from "cannot hear"', async () => {
    // Two different sentences for two different fixes: one sends the owner to
    // Settings, the other tells them their provider has no audio endpoint.
    const { adapters } = capture();
    const e = await transcribe(
      { audio: new Uint8Array([1]), mime_type: 'audio/ogg' },
      { config: {}, adapters, quota: createQuotaTracker() },
    ).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(LLMError);
    expect((e as LLMError).code).toBe('AI_NO_TRANSCRIPTION_SOURCE');
    expect((e as LLMError).code).not.toBe('AI_MODALITY_UNSUPPORTED');
  });

  it('books the request against the quota tracker', async () => {
    const { adapters } = capture();
    const quota = createQuotaTracker();
    const spy = vi.spyOn(quota, 'registerRequest');
    await transcribe(
      { audio: new Uint8Array([1]), mime_type: 'audio/ogg' },
      { config: { transcription_slot: slot }, adapters, quota },
    );
    // One source has nothing to cascade to, but rpm bookkeeping still means
    // something for it.
    expect(spy).toHaveBeenCalledWith('transcription_slot');
  });
});

describe('D-262 § B6 — the language pin', () => {
  it('passes the owner-configured language through', async () => {
    const { calls } = await run({ transcription_slot: slot, transcription_language: 'de' });
    expect(calls[0]?.request.language).toBe('de');
  });

  it('⛔ omits it entirely when unset — absent is auto-detect, and is the default', async () => {
    const { calls } = await run({ transcription_slot: slot });
    // ⚠ Not an empty string: the provider reads '' as a VALUE and would try to
    // honour it. Absence is the only honest way to ask for auto-detect.
    expect(calls[0]?.request).not.toHaveProperty('language');
  });

  it('⛔ treats an empty configured language as unset, not as a pin', async () => {
    const { calls } = await run({ transcription_slot: slot, transcription_language: '' });
    expect(calls[0]?.request).not.toHaveProperty('language');
  });

  it('lets an explicit request language win, so the Settings probe can drive one', async () => {
    const { calls } = await run(
      { transcription_slot: slot, transcription_language: 'de' },
      { language: 'fr' },
    );
    expect(calls[0]?.request.language).toBe('fr');
  });
});
