import type { LLMAdapter, LLMFinishReason, LLMMessage } from '../types.js';
import { LLMError } from '../types.js';
import { callProvider } from './anthropic.js';
import { hasNonTextPart, joinTextParts, toGoogleParts } from './content-parts.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

/** Google Gemini adapter. Uses the generateContent endpoint.
 *  Gemini expects contents shaped as `[{ role, parts: [{ text }] }]` with role values
 *  of "user" or "model" (system is a separate `system_instruction` field). */
export const createGoogleAdapter = (): LLMAdapter => ({
  provider: 'google',
  async complete(slot, messages, options) {
    const baseUrl = (slot.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/${API_VERSION}/models/${encodeURIComponent(options.model)}:generateContent`;

    const { system_instruction, contents } = splitGoogleMessages(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options.max_tokens,
        // Gemini's native JSON mode — equivalent to OpenAI's response_format.
        ...(options.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system_instruction) {
      body.system_instruction = { parts: [{ text: system_instruction }] };
    }

    const response = await callProvider(
      url,
      {
        'x-goog-api-key': slot.api_key,
        'content-type': 'application/json',
      },
      body,
      options.timeout_ms,
    );

    const finishReason = extractGoogleFinishReason(response);
    return {
      // Gemini safety/recitation/blocklist stops may contain no answer parts.
      // The normalized finish reason is the evidence; defer its typed
      // classification to the executor rather than reporting a parse failure.
      text: finishReason === 'content_filter' ? '' : extractGoogleText(response),
      usage: extractUsage(response, options.model),
      ...(finishReason !== undefined
        ? { finish_reason: finishReason }
        : {}),
    };
  },
});

/** Promote system messages to system_instruction; map assistant→model. */
const splitGoogleMessages = (
  messages: LLMMessage[],
): {
  system_instruction: string;
  contents: Array<{ role: 'user' | 'model'; parts: unknown[] }>;
} => {
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      // `content_parts`, when present, is the source of truth (never `m.content`
      // — a D-172 additive parts list ≠ content): a multimodal turn renders
      // inlineData/fileData parts; an all-text turn renders ONE `{ text }` part
      // holding the JOINED text. D-164 — the cache-split turn is all-text (the
      // cache_breakpoint marker is Anthropic-only), so it joins to the
      // byte-identical string; Gemini's implicit caching keys on the prefix
      // regardless, preserving the exact today wire. Absent parts → `m.content`.
      parts: renderGoogleParts(msg),
    });
  }

  return { system_instruction: systemParts.join('\n\n'), contents };
};

const extractGoogleFinishReason = (
  response: unknown,
): LLMFinishReason | undefined => {
  const obj = response as {
    promptFeedback?: { blockReason?: unknown };
    candidates?: Array<{ finishReason?: unknown }>;
  };
  // Prompt-level blocks return promptFeedback and no candidates. Any concrete
  // block reason is a provider refusal; the unspecified enum value is not.
  const promptBlockReason = obj.promptFeedback?.blockReason;
  if (
    typeof promptBlockReason === 'string'
    && promptBlockReason.length > 0
    && promptBlockReason !== 'BLOCK_REASON_UNSPECIFIED'
    && promptBlockReason !== 'BLOCKED_REASON_UNSPECIFIED'
  ) {
    return 'content_filter';
  }

  const reason = obj.candidates?.[0]?.finishReason;
  if (reason === 'MAX_TOKENS') return 'length';
  if (
    reason === 'SAFETY'
    || reason === 'RECITATION'
    || reason === 'BLOCKLIST'
    || reason === 'PROHIBITED_CONTENT'
    || reason === 'SPII'
    || reason === 'IMAGE_SAFETY'
    || reason === 'IMAGE_PROHIBITED_CONTENT'
    || reason === 'IMAGE_RECITATION'
  ) {
    return 'content_filter';
  }
  if (reason === 'STOP') return 'stop';
  return undefined;
};

/** Render one non-system message's Gemini `parts`. `content_parts`, when
 *  present, is authoritative (never `m.content`): multimodal → inlineData/
 *  fileData parts; all-text → one `{ text }` part holding the joined text (the
 *  D-164 cache split is all-text → byte-identical string). Absent → `m.content`. */
const renderGoogleParts = (msg: LLMMessage): unknown[] => {
  const parts = msg.content_parts;
  if (!parts || parts.length === 0) return [{ text: msg.content }];
  return hasNonTextPart(parts) ? toGoogleParts(parts) : [{ text: joinTextParts(parts) }];
};

/** Extract text from Gemini response.
 *  Response shape: { candidates: [{ content: { parts: [{ text: "...", thought? }] } }] }
 *
 *  Gemini 2.5+ and Gemma-4 "thinking" models return their private reasoning as
 *  parts flagged `thought: true` ALONGSIDE the answer parts. Those are NOT the
 *  response — concatenating them prepends reasoning prose (which routinely
 *  contains its own JSON-looking fragments the model is weighing) to the answer,
 *  which breaks every downstream JSON / tool-call parser (`parse.ts` would scan
 *  a `{` out of the reasoning, and the chat main-turn parser expects the whole
 *  text to be the AIOutput). So drop thought parts; the answer is the
 *  non-thought text. The reasoning is still ACCOUNTED for via
 *  `usageMetadata.thoughtsTokenCount` in extractUsage. */
const extractGoogleText = (response: unknown): string => {
  const obj = response as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  };
  const parts = obj.candidates?.[0]?.content?.parts;
  if (!parts || !Array.isArray(parts)) {
    throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'Google response missing candidates[0].content.parts');
  }
  const text = parts
    .filter((p) => p.thought !== true)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('');
  if (!text) {
    // Distinguish "the model spent its whole token budget thinking and never
    // reached an answer" from a genuinely empty response — the former is fixed
    // by a larger max_output_tokens, so name it.
    const hadThoughts = parts.some((p) => p.thought === true);
    throw new LLMError(
      'AI_RESPONSE_PARSE_FAILED',
      hadThoughts
        ? 'Google response had only thinking parts, no answer (raise max_output_tokens)'
        : 'Google response had no text parts',
    );
  }
  return text;
};

/** Extract usage from Gemini response.
 *
 *  Base shape: `usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount}`.
 *  Gemini extensions:
 *    `usageMetadata.cachedContentTokenCount?` — cached input (subset)
 *    `usageMetadata.thoughtsTokenCount?` — thinking output tokens (subset, 2.5+ thinking models)
 *
 *  Gemini doesn't surface a cache_creation field — the cache lives
 *  in a separate cached-content resource the caller created
 *  out-of-band, so the per-call response only echoes the read.
 *  Cache_write stays undefined for Gemini. */
const extractUsage = (
  response: unknown,
  modelId: string,
): import('../types.js').TokenUsage => {
  const obj = response as {
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const input = obj.usageMetadata?.promptTokenCount ?? 0;
  const output = obj.usageMetadata?.candidatesTokenCount ?? 0;
  const cacheRead = obj.usageMetadata?.cachedContentTokenCount;
  const reasoning = obj.usageMetadata?.thoughtsTokenCount;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: obj.usageMetadata?.totalTokenCount ?? (input + output),
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
    model_id: modelId,
  };
};
