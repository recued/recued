import type { LLMAdapter, LLMFinishReason, LLMMessage, LLMProvider } from '../types.js';
import { LLMError } from '../types.js';
import { callProvider } from './anthropic.js';
import { hasNonTextPart, joinTextParts, toOpenAIContent } from './content-parts.js';
import { joinApiBase } from '../base-url.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

/** Render one message's `content` for the OpenAI chat-completions API. When
 *  `content_parts` is present it is authoritative (never `m.content`): a
 *  multimodal turn renders the content-part array; an all-text turn renders the
 *  joined text string (the D-164 cache split is all-text → byte-identical
 *  string). Absent parts use the plain `content`. */
const renderOpenAIMessageContent = (m: LLMMessage): string | unknown[] => {
  const parts = m.content_parts;
  if (!parts || parts.length === 0) return m.content;
  return hasNonTextPart(parts) ? toOpenAIContent(parts) : joinTextParts(parts);
};

/** OpenAI Chat Completions adapter. The same adapter handles `openai-compatible`
 *  providers (Together, Groq, Ollama, vLLM, etc.) — the slot's base_url overrides
 *  the default endpoint. */
export const createOpenAIAdapter = (provider: LLMProvider = 'openai'): LLMAdapter => ({
  provider,
  async complete(slot, messages, options) {
    const baseUrl = joinApiBase(slot.base_url ?? DEFAULT_OPENAI_BASE_URL, 'v1');
    const url = `${baseUrl}/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.max_tokens,
      // Native JSON-object mode — the system prompt already instructs JSON, which
      // openai-compatible endpoints require alongside this flag. The executor only
      // sets `options.json` for `supports_json` slots and degrades gracefully if a
      // misconfigured endpoint rejects the param (completeWithJsonFallback).
      // ⛔ Never for an ARRAY reply: `json_object` can only return an object, so a
      // batch answered one record and dropped the rest (see `json_shape`).
      ...(options.json && options.json_shape !== 'array'
        ? { response_format: { type: 'json_object' } }
        : {}),
      // `content_parts`, when present, is the source of truth (never `m.content`
      // — a D-172 additive parts list ≠ content): a multimodal turn renders the
      // OpenAI content-part array (image_url / input_audio / file); an all-text
      // turn renders the JOINED text as a plain string. D-164 — the cache-split
      // turn is all-text (the cache_breakpoint marker is Anthropic-only), so it
      // joins to the byte-identical string here; OpenAI's automatic prefix
      // caching keys on the token prefix regardless, preserving the exact today
      // wire — zero compat risk for openai-compatible free-pool / local.
      messages: messages.map((m) => ({
        role: m.role,
        content: renderOpenAIMessageContent(m),
      })),
    };

    const response = await callProvider(
      url,
      {
        authorization: `Bearer ${slot.api_key}`,
        'content-type': 'application/json',
      },
      body,
      options.timeout_ms,
    );

    const finishReason = extractOpenAIFinishReason(response);
    return {
      // A content-filtered response commonly omits message.content entirely.
      // Preserve the provider-normalized stop for the executor to classify;
      // never rewrite an explicit refusal as AI_RESPONSE_PARSE_FAILED.
      text: finishReason === 'content_filter' ? '' : extractOpenAIText(response),
      usage: extractUsage(response, options.model),
      ...(finishReason !== undefined
        ? { finish_reason: finishReason }
        : {}),
    };
  },
});

/** Extract the assistant reply from an OpenAI-compatible chat completion.
 *  Response shape: { choices: [{ message: { content: "..." } }] } */
const extractOpenAIText = (response: unknown): string => {
  const obj = response as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = obj.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) {
    throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'OpenAI response missing choices[0].message.content');
  }
  return content;
};

const extractOpenAIFinishReason = (
  response: unknown,
): LLMFinishReason | undefined => {
  const choice = (response as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: { refusal?: unknown };
    }>;
  }).choices?.[0];
  // Structured-output refusals are carried separately from message.content and
  // may still report a normal `stop`. Treat the typed refusal field as the
  // stronger signal and discard its prose at this boundary.
  const refusal = choice?.message?.refusal;
  if (typeof refusal === 'string' && refusal.trim().length > 0) {
    return 'content_filter';
  }
  const reason = choice?.finish_reason;
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  if (reason === 'stop') return 'stop';
  return undefined;
};

/** Extract usage from OpenAI / openai-compatible response.
 *
 *  Base shape: `usage: { prompt_tokens, completion_tokens, total_tokens }`.
 *  GPT-4o-cache and o1 expose finer slots:
 *    `usage.prompt_tokens_details.cached_tokens` — cached input (subset)
 *    `usage.completion_tokens_details.reasoning_tokens` — o1 reasoning (subset)
 *
 *  OpenAI-compatible providers (Groq, OpenRouter, Together, Ollama,
 *  vLLM, …) typically don't echo `*_tokens_details` — those fields
 *  stay undefined. The base prompt/completion counts are always
 *  populated. `total_tokens` mirrors the provider's own sum when
 *  echoed, else `input + output`. */
const extractUsage = (
  response: unknown,
  modelId: string,
): import('../types.js').TokenUsage => {
  const obj = response as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const input = obj.usage?.prompt_tokens ?? 0;
  const output = obj.usage?.completion_tokens ?? 0;
  const cacheRead = obj.usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = obj.usage?.completion_tokens_details?.reasoning_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: obj.usage?.total_tokens ?? (input + output),
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
    model_id: modelId,
  };
};
