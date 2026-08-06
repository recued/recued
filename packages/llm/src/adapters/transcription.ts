/** D-172 P5 / A.9 — voice→text transcription adapters.
 *
 *  Transcription is a DISTINCT capability from multimodal chat (N.8): it
 *  routes to an audio-capable source and returns plain text, not a chat
 *  turn. Each provider exposes it differently:
 *    - OpenAI (and openai-compatible, e.g. Groq): `POST /v1/audio/transcriptions`
 *      multipart form (`file` + `model`) → `{ text }`.
 *    - Google (Gemini): no dedicated endpoint — `generateContent` with the
 *      audio as an `inlineData` part + a "transcribe verbatim" instruction.
 *    - Anthropic: no audio input at all → throws `AI_MODALITY_UNSUPPORTED`.
 *
 *  `fetch` is injectable (default `globalThis.fetch`) so tests can drive the
 *  multipart / JSON request shape without a network. */

import type { AdapterKey, LLMProvider, LLMSlot } from '../types.js';
import { LLMError } from '../types.js';
import { joinApiBase } from '../base-url.js';
import {
  LLMProviderResponseTooLargeError,
  readBoundedProviderJson,
  readBoundedProviderText,
} from '../provider-http.js';

export interface TranscriptionRequest {
  /** Raw audio bytes. */
  audio: Uint8Array;
  /** Detected MIME (`audio/wav`, `audio/ogg`, `audio/mpeg`, …). */
  mime_type: string;
  /** Display filename for the multipart upload (OpenAI). */
  filename?: string;
}

export interface TranscriptionOptions {
  /** Resolved transcription model (provider default when the slot omits one). */
  model: string;
  /** Per-call timeout in ms, or null to skip the timer. */
  timeout_ms: number | null;
}

export interface TranscriptionResult {
  text: string;
  /** Detected source language when the provider reports it. */
  language?: string;
  model_id?: string;
}

export interface TranscriptionAdapter {
  readonly provider: AdapterKey;
  transcribe(
    slot: LLMSlot,
    request: TranscriptionRequest,
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult>;
}

export type TranscriptionAdapterRegistry = (key: AdapterKey) => TranscriptionAdapter;

type FetchImpl = typeof fetch;

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';
const GOOGLE_API_VERSION = 'v1beta';

/** Provider-default transcription model when the slot/entry omits one. */
export const defaultTranscriptionModel = (provider: AdapterKey): string | null => {
  switch (provider) {
    case 'openai':
      return 'whisper-1';
    case 'openai-compatible':
      return 'whisper-large-v3'; // Groq's whisper; override via transcription_model
    case 'google':
      return null; // Gemini uses the chat `model` for generateContent
    default:
      return null;
  }
};

/** Base64-encode bytes in both Node (Buffer) and browser (btoa) runtimes. */
const toBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // eslint-disable-next-line no-undef
  return btoa(binary);
};

/** Shared timeout + error classification around a transcription fetch.
 *  Mirrors the chat `callProvider` policy (null timeout → unbounded), but
 *  takes a pre-built `RequestInit` so multipart (FormData) + JSON bodies
 *  both flow through one error path. */
const callTranscription = async (
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number | null,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = timeoutMs !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      // Multipart and JSON provider bodies carry BYOK credentials. They are
      // not safely replayable, so no redirect is an acceptable response.
      redirect: 'error',
    });
    if (!response.ok) {
      let body = '';
      try {
        body = await readBoundedProviderText(response);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
      }
      const retryable = response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403;
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        `Transcription failed (${response.status}): ${body.slice(0, 200)}`,
        { status: response.status },
        retryable,
      );
    }
    try {
      return await readBoundedProviderJson(response);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new LLMError(
        'AI_RESPONSE_PARSE_FAILED',
        e instanceof LLMProviderResponseTooLargeError
          ? e.message
          : 'Transcription returned malformed JSON',
      );
    }
  } catch (e) {
    if (e instanceof LLMError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new LLMError('AI_TIMEOUT', timeoutMs !== null ? `Transcription timed out after ${timeoutMs}ms` : 'Transcription was cancelled');
    }
    throw new LLMError('AI_LLM_UNAVAILABLE', `Transcription call failed: ${(e as Error).message}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

/** OpenAI `/v1/audio/transcriptions` (also serves openai-compatible Whisper
 *  endpoints like Groq via `base_url`). Multipart form; `content-type` is set
 *  by the runtime from the `FormData` boundary — do NOT set it manually. */
export const createOpenAITranscriptionAdapter = (
  provider: LLMProvider = 'openai',
  fetchImpl: FetchImpl = globalThis.fetch,
): TranscriptionAdapter => ({
  provider,
  async transcribe(slot, request, options) {
    const baseUrl = joinApiBase(slot.base_url ?? DEFAULT_OPENAI_BASE_URL, 'v1');
    const url = `${baseUrl}/v1/audio/transcriptions`;
    const form = new FormData();
    form.append('model', options.model);
    form.append(
      'file',
      new Blob([request.audio as BlobPart], { type: request.mime_type }),
      request.filename ?? 'audio',
    );
    const json = (await callTranscription(
      fetchImpl,
      url,
      { method: 'POST', headers: { authorization: `Bearer ${slot.api_key}` }, body: form },
      options.timeout_ms,
    )) as { text?: unknown; language?: unknown };
    if (typeof json.text !== 'string') {
      throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'OpenAI transcription response missing text');
    }
    return {
      text: json.text,
      ...(typeof json.language === 'string' ? { language: json.language } : {}),
      model_id: options.model,
    };
  },
});

/** Gemini transcription via `generateContent` (audio inlineData + a verbatim
 *  instruction). Uses the chat `model` (`options.model`). */
export const createGoogleTranscriptionAdapter = (
  fetchImpl: FetchImpl = globalThis.fetch,
): TranscriptionAdapter => ({
  provider: 'google',
  async transcribe(slot, request, options) {
    const baseUrl = joinApiBase(slot.base_url ?? DEFAULT_GOOGLE_BASE_URL, GOOGLE_API_VERSION);
    const url = `${baseUrl}/${GOOGLE_API_VERSION}/models/${encodeURIComponent(options.model)}:generateContent`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe the attached audio verbatim. Output only the transcript text, with no preamble.' },
            { inlineData: { mimeType: request.mime_type, data: toBase64(request.audio) } },
          ],
        },
      ],
    };
    const json = (await callTranscription(
      fetchImpl,
      url,
      { method: 'POST', headers: { 'x-goog-api-key': slot.api_key, 'content-type': 'application/json' }, body: JSON.stringify(body) },
      options.timeout_ms,
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
    const parts = json.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim()
      : '';
    if (!text) {
      throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'Google transcription response had no text');
    }
    return { text, model_id: options.model };
  },
});

/** Anthropic has no audio input — transcription is impossible. Throws the
 *  modality warn so the caller surfaces it (never a silent failure). */
export const createAnthropicTranscriptionAdapter = (): TranscriptionAdapter => ({
  provider: 'anthropic',
  async transcribe() {
    throw new LLMError(
      'AI_MODALITY_UNSUPPORTED',
      'Anthropic does not support audio transcription — configure an OpenAI/Groq/Gemini audio source',
      { provider: 'anthropic', modality: 'audio' },
    );
  },
});

/** Default transcription registry. openai + openai-compatible share the
 *  Whisper adapter (base_url differs); google uses generateContent; anthropic
 *  throws. `web_chat` is not a transcription transport. */
export const createDefaultTranscriptionRegistry = (
  opts: { fetchImpl?: FetchImpl } = {},
): TranscriptionAdapterRegistry => {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const openai = createOpenAITranscriptionAdapter('openai', fetchImpl);
  const openaiCompatible = createOpenAITranscriptionAdapter('openai-compatible', fetchImpl);
  const google = createGoogleTranscriptionAdapter(fetchImpl);
  const anthropic = createAnthropicTranscriptionAdapter();
  return (key) => {
    switch (key) {
      case 'openai':
        return openai;
      case 'openai-compatible':
        return openaiCompatible;
      case 'google':
        return google;
      case 'anthropic':
        return anthropic;
      default:
        throw new LLMError('AI_LLM_UNAVAILABLE', `No transcription adapter for: ${key}`);
    }
  };
};
