import type {
  LLMAdapter,
  LLMCompletionOptions,
  LLMFinishReason,
  LLMMessage,
  LLMSlot,
} from '../types.js';
import { LLMError } from '../types.js';
import {
  LLMProviderResponseTooLargeError,
  readBoundedProviderJson,
  readBoundedProviderText,
} from '../provider-http.js';
import {
  hasCacheBreakpoint,
  hasNonTextPart,
  joinTextParts,
  toAnthropicContent,
} from './content-parts.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Anthropic Messages API adapter. Uses /v1/messages.
 *  Handles system-message promotion (Anthropic takes system separately). */
export const createAnthropicAdapter = (): LLMAdapter => ({
  provider: 'anthropic',
  async complete(slot, messages, options) {
    const baseUrl = (slot.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;

    const { system, chat } = splitSystem(messages);
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.max_tokens,
      // When `content_parts` is present it is the source of truth (never fall
      // back to `m.content` — an additive D-172 parts list ≠ `content`):
      //   • multimodal OR a cache breakpoint to place → Anthropic block array
      //     (D-172 image/document; D-164 `cache_control` on the prefix block);
      //   • all-text, no breakpoint → the joined text (string);
      //   • no parts → the plain `content` string (unchanged).
      messages: chat.map((m) => ({
        role: m.role,
        content: renderAnthropicMessageContent(m),
      })),
    };
    if (system) body.system = system;
    if (options.thinking) {
      // Anthropic extended reasoning — budget is half of max_tokens as a reasonable default
      body.thinking = { type: 'enabled', budget_tokens: Math.floor(options.max_tokens / 2) };
    }

    const response = await callProvider(
      url,
      {
        'x-api-key': slot.api_key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body,
      options.timeout_ms,
    );

    const finishReason = extractAnthropicFinishReason(response);
    return {
      // Anthropic may return stop_reason=refusal without a text block. Keep
      // that typed stop intact for the executor instead of raising a parse
      // failure while trying to extract content that is intentionally absent.
      text: finishReason === 'content_filter' ? '' : extractAnthropicText(response),
      usage: extractUsage(response, options.model),
      ...(finishReason !== undefined
        ? { finish_reason: finishReason }
        : {}),
    };
  },
});

/** Render one message's `content` for the Anthropic Messages API. When
 *  `content_parts` is present it is authoritative (never `m.content`): a
 *  multimodal turn OR a cache-breakpoint turn renders the block array (so
 *  `cache_control` lands on the marked block); an all-text turn without a
 *  breakpoint renders the joined text; absent parts use the plain string. */
const renderAnthropicMessageContent = (m: LLMMessage): string | unknown[] => {
  const parts = m.content_parts;
  if (!parts || parts.length === 0) return m.content;
  if (hasNonTextPart(parts) || hasCacheBreakpoint(parts)) return toAnthropicContent(parts);
  return joinTextParts(parts);
};

const extractAnthropicFinishReason = (
  response: unknown,
): LLMFinishReason | undefined => {
  const reason = (response as { stop_reason?: unknown }).stop_reason;
  if (reason === 'max_tokens') return 'length';
  if (reason === 'refusal') return 'content_filter';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  return undefined;
};

/** Anthropic expects a `system` field separate from the messages array. */
const splitSystem = (messages: LLMMessage[]): { system: string; chat: LLMMessage[] } => {
  const systemParts: string[] = [];
  const chat: LLMMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') systemParts.push(msg.content);
    else chat.push(msg);
  }
  return { system: systemParts.join('\n\n'), chat };
};

/** Extract the assistant's text from an Anthropic response.
 *  Response shape: { content: [{ type: "text", text: "..." }, ...] } */
const extractAnthropicText = (response: unknown): string => {
  const obj = response as { content?: Array<{ type: string; text?: string }> };
  if (!obj.content || !Array.isArray(obj.content)) {
    throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'Anthropic response missing content array');
  }
  const text = obj.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (!text) {
    throw new LLMError('AI_RESPONSE_PARSE_FAILED', 'Anthropic response had no text blocks');
  }
  return text;
};

/** Extract usage from Anthropic response.
 *
 *  Anthropic `/v1/messages` returns:
 *    `usage.input_tokens` — non-cached input tokens (Anthropic
 *      breaks cache out as separate top-level fields, unlike OpenAI
 *      / Gemini which fold the cache subset into the input total)
 *    `usage.output_tokens` — assistant + thinking tokens combined
 *    `usage.cache_read_input_tokens?` — cached input tokens
 *    `usage.cache_creation_input_tokens?` — input spent CREATING cache
 *
 *  Anthropic does NOT separate thinking output from regular output —
 *  thinking blocks roll up into `output_tokens`, and there's no
 *  `reasoning_tokens` field. Trio #E leaves the field undefined on
 *  Anthropic responses; consumers that want the breakdown for
 *  Anthropic must compute it some other way (out of scope here).
 *
 *  Codex Trio #E P2 fold #2 — `TokenUsageReport`'s contract is
 *  `cache_*` ⊂ `input_tokens` and `total_tokens = input + output`.
 *  Anthropic's raw API echoes `input_tokens` as the *non-cached*
 *  portion only, so we normalise by summing cache reads + writes
 *  into `input_tokens` before computing `total_tokens`. Without this
 *  normalisation, cached Anthropic calls would publish an
 *  inconsistent report (input < total - output) and undercount the
 *  prompt-side for per-provider rollups. OpenAI / Gemini already
 *  fold cache into their input totals, so the cache fields stay a
 *  pure subset there. */
const extractUsage = (
  response: unknown,
  modelId: string,
): import('../types.js').TokenUsage => {
  const obj = response as {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const rawInput = obj.usage?.input_tokens ?? 0;
  const output = obj.usage?.output_tokens ?? 0;
  const cacheRead = obj.usage?.cache_read_input_tokens;
  const cacheWrite = obj.usage?.cache_creation_input_tokens;
  const input = rawInput + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_write_input_tokens: cacheWrite } : {}),
    model_id: modelId,
  };
};

/** Shared provider call with optional timeout + error classification.
 *  When `timeoutMs` is null, no setTimeout is installed — the AbortController
 *  still exists (so the user/engine can cancel explicitly), but there is no
 *  automatic abort. See ./timeout.ts for the LLM timeout policy rationale.
 *  Exported so openai/google adapters reuse it. */
export const callProvider = async (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number | null,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = timeoutMs !== null
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      // Provider URLs are fully authored by the selected slot. Refuse rather
      // than replay BYOK credentials or prompt content to a redirect target.
      redirect: 'error',
    });

    if (!response.ok) {
      const errorText = await safeReadText(response);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw classifyProviderError(response.status, errorText, retryAfterMs);
    }

    try {
      return await readBoundedProviderJson(response);
    } catch (e) {
      // AbortError during body read must propagate so the outer handler
      // can surface it as AI_TIMEOUT — do NOT rewrite it as a parse error
      // (the actual cause is a dropped connection, not malformed JSON).
      if ((e as Error).name === 'AbortError') throw e;
      throw new LLMError(
        'AI_RESPONSE_PARSE_FAILED',
        e instanceof LLMProviderResponseTooLargeError
          ? e.message
          : 'Provider returned malformed JSON',
      );
    }
  } catch (e) {
    if (e instanceof LLMError) throw e;
    if ((e as Error).name === 'AbortError') {
      // Could be timer-triggered OR user/engine-triggered (explicit cancel).
      // Report the timer case distinctly; otherwise surface as cancellation.
      if (timeoutMs !== null) {
        throw new LLMError('AI_TIMEOUT', `LLM call timed out after ${timeoutMs}ms`);
      }
      throw new LLMError('AI_TIMEOUT', 'LLM call was cancelled');
    }
    throw new LLMError('AI_LLM_UNAVAILABLE', `LLM call failed: ${(e as Error).message}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

const safeReadText = async (response: Response): Promise<string> => {
  try {
    return await readBoundedProviderText(response);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return '';
  }
};

/** Classify a non-2xx provider response.
 *
 *  Status → retryable mapping (drives the executor's cascade re-match):
 *    401/403 — auth failure. Retryable: the slot's key is bad; the
 *              cascade should advance to another source rather than
 *              halt the recipe.
 *    429     — rate limited. Retryable: another pool entry or slot may
 *              have capacity. Retry-After (seconds or HTTP-date) is
 *              parsed into `retry_after_ms` so the cooldown tracker
 *              can skip this source until the provider says it's ok.
 *    5xx     — transient server error. Retryable.
 *    413 / "context too long" — AI_TOKEN_BUDGET_EXCEEDED; NOT retryable
 *              (re-matching to another model won't fix an oversized prompt).
 *    everything else — AI_LLM_UNAVAILABLE; not retryable. */
const PROVIDER_CONTEXT_OVERFLOW_RE =
  /context[_ -]?length[_ -]?exceeded|maximum context (?:length|window)|context (?:length|window).*(?:exceed|too (?:long|large))|prompt (?:is )?too long|input token count.*exceeds|too many input tokens/i;

export const classifyProviderError = (
  status: number,
  body: string,
  retryAfterMs: number | null,
): LLMError => {
  if (status === 401 || status === 403) {
    return new LLMError(
      'AI_LLM_UNAVAILABLE',
      `LLM auth failed (${status}): ${truncate(body)}`,
      { status },
      true,
    );
  }
  if (status === 429) {
    return new LLMError(
      'AI_LLM_UNAVAILABLE',
      `LLM rate limited (429): ${truncate(body)}`,
      retryAfterMs != null ? { status, retry_after_ms: retryAfterMs } : { status },
      true,
    );
  }
  if (status === 413 || PROVIDER_CONTEXT_OVERFLOW_RE.test(body)) {
    return new LLMError('AI_TOKEN_BUDGET_EXCEEDED', `LLM input too large (${status}): ${truncate(body)}`);
  }
  if (status >= 500) {
    return new LLMError(
      'AI_LLM_UNAVAILABLE',
      `LLM server error (${status}): ${truncate(body)}`,
      { status },
      true,
    );
  }
  return new LLMError('AI_LLM_UNAVAILABLE', `LLM error (${status}): ${truncate(body)}`);
};

/** Parse an HTTP `Retry-After` header into milliseconds.
 *
 *  Accepts either delta-seconds (RFC 7231 §7.1.3 form 1) or an
 *  HTTP-date (form 2). Returns null for missing / malformed / past
 *  dates so the caller can fall back to its default cooldown. */
export const parseRetryAfter = (header: string | null): number | null => {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  // delta-seconds — pure integer
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return seconds > 0 ? seconds * 1000 : null;
  }
  // HTTP-date
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  return delta > 0 ? delta : null;
};

const truncate = (s: string): string => (s.length > 200 ? s.slice(0, 200) + '…' : s);
