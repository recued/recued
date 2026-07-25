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
  const run = async (config: LLMConfig, fetchJson: unknown) => {
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    return transcribe(
      { audio, mime_type: 'audio/wav', filename: 'v.wav' },
      {
        config,
        adapters: createDefaultTranscriptionRegistry({ fetchImpl: okFetch(fetchJson) as unknown as typeof fetch }),
        quota: createQuotaTracker(),
        tabProbe: noTabs,
        preBuiltAvailability: availability,
      },
    );
  };

  it('routes to an audio-capable slot and returns the transcript', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { audio: true }, transcription_model: 'whisper-1' },
    };
    const result = await run(config, { text: 'voice note text' });
    expect(result.text).toBe('voice note text');
  });

  it('uses the chat model for a Gemini audio source with no transcription_model', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'google', model: 'gemini-2.5-flash', api_key: 'k', speed: 'fast', supports_json: true, modalities: { audio: true } },
    };
    const result = await run(config, { candidates: [{ content: { parts: [{ text: 'gemini transcript' }] } }] });
    expect(result.text).toBe('gemini transcript');
  });

  it('warns (AI_MODALITY_UNSUPPORTED) when no audio-capable source is configured', async () => {
    const config: LLMConfig = {
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true }, // no audio
    };
    await expect(run(config, { text: 'x' })).rejects.toMatchObject({ code: 'AI_MODALITY_UNSUPPORTED' });
  });

  it('prefers a free audio-capable pool entry over a BYOK audio slot', async () => {
    const config: LLMConfig = {
      free_pool: [{ id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'gsk', speed: 'fast', supports_json: true, enabled: true, modalities: { audio: true }, transcription_model: 'whisper-large-v3' }],
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { audio: true }, transcription_model: 'whisper-1' },
    };
    const result = await run(config, { text: 'from free pool' });
    expect(result.text).toBe('from free pool');
  });

  it('cascades to a second audio source on a retryable failure', async () => {
    // Free pool (openai-compatible) is tried first and 429s; the cascade
    // rejects it and falls back to the BYOK openai slot, which succeeds.
    const config: LLMConfig = {
      free_pool: [{ id: 'groq', type: 'api', provider: 'openai-compatible', model: 'x', api_key: 'gsk', speed: 'fast', supports_json: true, enabled: true, modalities: { audio: true }, transcription_model: 'whisper-large-v3' }],
      slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { audio: true }, transcription_model: 'whisper-1' },
    };
    const availability = await buildAvailability({ config, quota: createQuotaTracker(), tabProbe: noTabs });
    const adapters: TranscriptionAdapterRegistry = (key) => {
      if (key === 'openai-compatible') {
        return { provider: key, transcribe: async () => { throw new LLMError('AI_LLM_UNAVAILABLE', 'rate limited', { status: 429 }, true); } };
      }
      if (key === 'openai') {
        return { provider: key, transcribe: async () => ({ text: 'served by fallback', model_id: 'whisper-1' }) };
      }
      throw new LLMError('AI_LLM_UNAVAILABLE', `no adapter for ${key}`);
    };
    const result = await transcribe(
      { audio, mime_type: 'audio/wav' },
      { config, adapters, quota: createQuotaTracker(), tabProbe: noTabs, preBuiltAvailability: availability },
    );
    expect(result.text).toBe('served by fallback');
  });
});
