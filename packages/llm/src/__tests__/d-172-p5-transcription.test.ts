/** D-172 P5 / A.9 — transcription adapters + the transcribe() orchestrator. */
import { describe, it, expect, vi } from 'vitest';
import {
  createOpenAITranscriptionAdapter,
  createGoogleTranscriptionAdapter,
  createAnthropicTranscriptionAdapter,
  createDefaultTranscriptionRegistry,
  type TranscriptionAdapterRegistry,
} from '../adapters/transcription.js';
import { transcribe } from '../transcribe.js';
import { buildAvailability } from '../availability.js';
import { createQuotaTracker } from '../quota.js';
import { LLMError } from '../types.js';
import type { LLMConfig, LLMSlot, WebChatTab } from '../types.js';

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
const audio = new Uint8Array([1, 2, 3, 4]);
const okFetch = (json: unknown) =>
  vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }));

describe('OpenAI transcription adapter', () => {
  it('POSTs multipart to /v1/audio/transcriptions with bearer auth and returns text', async () => {
    const fetchMock = okFetch({ text: 'hello world', language: 'en' });
    const adapter = createOpenAITranscriptionAdapter('openai', fetchMock as unknown as typeof fetch);
    const slot: LLMSlot = { provider: 'openai', model: 'gpt', api_key: 'sk', modalities: { audio: true } };
    const result = await adapter.transcribe(slot, { audio, mime_type: 'audio/wav', filename: 'note.wav' }, { model: 'whisper-1', timeout_ms: 5000 });
    expect(result.text).toBe('hello world');
    expect(result.language).toBe('en');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk' });
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    // The runtime sets the multipart content-type from the FormData boundary —
    // we must NOT set it manually.
    expect((init as RequestInit).headers).not.toHaveProperty('content-type');
  });

  it('honours base_url for openai-compatible (Groq) endpoints', async () => {
    const fetchMock = okFetch({ text: 'groq result' });
    const adapter = createOpenAITranscriptionAdapter('openai-compatible', fetchMock as unknown as typeof fetch);
    const slot: LLMSlot = { provider: 'openai-compatible', model: 'x', api_key: 'gsk', base_url: 'https://api.groq.com/openai' };
    const result = await adapter.transcribe(slot, { audio, mime_type: 'audio/ogg' }, { model: 'whisper-large-v3', timeout_ms: null });
    expect(result.text).toBe('groq result');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('throws AI_RESPONSE_PARSE_FAILED when the response lacks text', async () => {
    const adapter = createOpenAITranscriptionAdapter('openai', okFetch({ nope: true }) as unknown as typeof fetch);
    const slot: LLMSlot = { provider: 'openai', model: 'gpt', api_key: 'sk' };
    await expect(
      adapter.transcribe(slot, { audio, mime_type: 'audio/wav' }, { model: 'whisper-1', timeout_ms: null }),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_PARSE_FAILED' });
  });
});

describe('Google transcription adapter', () => {
  it('POSTs generateContent with inline audio and extracts the transcript', async () => {
    const fetchMock = okFetch({ candidates: [{ content: { parts: [{ text: 'transcribed ' }, { text: 'gemini' }] } }] });
    const adapter = createGoogleTranscriptionAdapter(fetchMock as unknown as typeof fetch);
    const slot: LLMSlot = { provider: 'google', model: 'gemini-2.5-flash', api_key: 'k', modalities: { audio: true } };
    const result = await adapter.transcribe(slot, { audio, mime_type: 'audio/ogg' }, { model: 'gemini-2.5-flash', timeout_ms: null });
    expect(result.text).toBe('transcribed gemini');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'k' });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe('audio/ogg');
    expect(body.contents[0].parts[1].inlineData.data).toBe(Buffer.from(audio).toString('base64'));
  });
});

describe('Anthropic transcription adapter', () => {
  it('throws AI_MODALITY_UNSUPPORTED (no audio input)', async () => {
    const adapter = createAnthropicTranscriptionAdapter();
    const slot: LLMSlot = { provider: 'anthropic', model: 'claude', api_key: 'sk' };
    await expect(
      adapter.transcribe(slot, { audio, mime_type: 'audio/wav' }, { model: 'x', timeout_ms: null }),
    ).rejects.toMatchObject({ code: 'AI_MODALITY_UNSUPPORTED' });
  });
});

describe('transcribe() orchestrator', () => {
  // ⚠ D-262 § B1 — REWRITTEN. This block used to pin the `matchLLM` routing:
  // free-before-BYOK preference for transcription, and a cascade across audio
  // sources. Both retired with the dedicated slot, and the two cases at the end
  // now assert their ABSENCE — a retired behaviour that is merely deleted from
  // a suite comes back the next time someone "restores" the old shape.
  const run = async (config: LLMConfig, fetchJson: unknown) =>
    transcribe(
      { audio, mime_type: 'audio/wav', filename: 'v.wav' },
      {
        config,
        adapters: createDefaultTranscriptionRegistry({ fetchImpl: okFetch(fetchJson) as unknown as typeof fetch }),
        quota: createQuotaTracker(),
      },
    );

  it('transcribes through the dedicated slot', async () => {
    const config: LLMConfig = {
      transcription_slot: { provider: 'openai', model: 'whisper-1', api_key: 'sk' },
    };
    const result = await run(config, { text: 'voice note text' });
    expect(result.text).toBe('voice note text');
  });

  it('uses a Gemini slot\'s own model, which transcribes itself via generateContent', async () => {
    const config: LLMConfig = {
      transcription_slot: { provider: 'google', model: 'gemini-2.5-flash', api_key: 'k' },
    };
    const result = await run(config, { candidates: [{ content: { parts: [{ text: 'gemini transcript' }] } }] });
    expect(result.text).toBe('gemini transcript');
  });

  it('⛔ REFUSES with AI_NO_TRANSCRIPTION_SOURCE when no slot is set', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
    };
    // ⚠ Was `AI_MODALITY_UNSUPPORTED` ("no audio-capable source"). The two are
    // now different questions: nothing configured sends the owner to Settings;
    // a configured provider that cannot hear is the adapter's own refusal.
    await expect(run(config, { text: 'x' })).rejects.toMatchObject({
      code: 'AI_NO_TRANSCRIPTION_SOURCE',
    });
  });

  it('⛔ RETIRED — does NOT prefer a free pool entry, or consult the pool at all', async () => {
    const config: LLMConfig = {
      free_pool: [{ id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'gsk', speed: 'fast', supports_json: true, enabled: true, modalities: { audio: true } }],
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { audio: true } },
    };
    // Both of these once served transcription, and the free one won. Now
    // neither is reachable: routing a voice turn through the chat pool is what
    // let a voice note be served by a model the owner did not pin.
    await expect(run(config, { text: 'from free pool' })).rejects.toMatchObject({
      code: 'AI_NO_TRANSCRIPTION_SOURCE',
    });
  });

  it('⛔ RETIRED — a retryable failure SURFACES; there is nothing to cascade to', async () => {
    const config: LLMConfig = {
      transcription_slot: { provider: 'openai-compatible', model: 'whisper-large-v3', api_key: 'gsk' },
      // Present, audio-capable, and deliberately unreachable: the cascade that
      // would once have walked here is gone with the pool.
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { audio: true } },
    };
    const adapters: TranscriptionAdapterRegistry = (key) => {
      if (key === 'openai-compatible') {
        return { provider: key, transcribe: async () => { throw new LLMError('AI_LLM_UNAVAILABLE', 'rate limited', { status: 429 }, true); } };
      }
      return { provider: key, transcribe: async () => ({ text: 'served by fallback', model_id: 'whisper-1' }) };
    };
    await expect(transcribe(
      { audio, mime_type: 'audio/wav' },
      { config, adapters, quota: createQuotaTracker() },
    )).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
  });
});
