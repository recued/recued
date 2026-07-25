import { callProvider } from '../../adapters/anthropic.js';
import type { LLMProvider, TokenUsage } from '../../types.js';
import { LLMError } from '../../types.js';
import type { EmbeddingsAdapter } from '../types.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

/** D-131 Phase 2 — OpenAI embeddings adapter. Also serves
 *  `openai-compatible` providers (Mistral free, OpenRouter free, any
 *  endpoint that mirrors `/v1/embeddings` semantics) — same code path,
 *  base URL is overridden via `slot.base_url`.
 *
 *  OpenAI's Matryoshka models (`text-embedding-3-small` / `-3-large`)
 *  honor an optional `dimensions` request parameter to truncate the
 *  output vector. `text-embedding-ada-002` (legacy) ignores it. The
 *  adapter forwards `options.dimensions` when set; the provider takes
 *  care of validation.
 *
 *  Wire shape — request:
 *    POST /v1/embeddings
 *    { "model": "text-embedding-3-small",
 *      "input": "<single string>",
 *      "dimensions": 512,             // optional
 *      "encoding_format": "float" }
 *
 *  Wire shape — response (success):
 *    { "data": [{ "embedding": [0.0123, ...], "index": 0 }],
 *      "model": "text-embedding-3-small",
 *      "usage": { "prompt_tokens": 7, "total_tokens": 7 } }
 *
 *  Errors classify identically to chat (see `classifyProviderError`):
 *  401/403 retryable (auth — cascade re-match), 429 retryable (with
 *  Retry-After honored), 5xx retryable, 413 / "context too long" not
 *  retryable. The shared `callProvider` does the heavy lifting; this
 *  adapter only adds embeddings-specific request shaping + response
 *  parsing. */
export const createOpenAIEmbeddingsAdapter = (
  provider: LLMProvider = 'openai',
): EmbeddingsAdapter => ({
  provider,
  async embed(slot, request, options) {
    const baseUrl = (slot.base_url ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/embeddings`;

    const body: Record<string, unknown> = {
      model: options.model,
      input: request.input,
      encoding_format: 'float',
    };
    if (options.dimensions !== undefined) {
      body.dimensions = options.dimensions;
    }

    const response = await callProvider(
      url,
      {
        authorization: `Bearer ${slot.api_key}`,
        'content-type': 'application/json',
      },
      body,
      options.timeout_ms,
    );

    return parseOpenAIEmbeddingsResponse(response, options.model);
  },
});

/** Parse an OpenAI-shape embeddings response into the canonical
 *  `EmbeddingsResult` shape. Throws AI_RESPONSE_PARSE_FAILED on any
 *  shape divergence — defensive because openai-compatible providers
 *  occasionally emit subtly different envelopes. */
const parseOpenAIEmbeddingsResponse = (
  response: unknown,
  requestedModel: string,
): { vector: number[]; dimensions: number; model: string; usage: TokenUsage } => {
  const obj = response as {
    data?: Array<{ embedding?: number[] | null }>;
    model?: string;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const first = obj.data?.[0];
  const vector = first?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new LLMError(
      'AI_RESPONSE_PARSE_FAILED',
      'OpenAI embeddings response missing data[0].embedding',
      { sample: JSON.stringify(response).slice(0, 200) },
    );
  }
  // Defensive: every element must be a finite number. Some openai-
  // compatible servers emit string-encoded floats under bizarre
  // configurations; surface this clearly rather than letting the
  // downstream storage choke on NaN.
  for (const n of vector) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new LLMError(
        'AI_RESPONSE_PARSE_FAILED',
        'OpenAI embeddings response contains a non-finite number in data[0].embedding',
        { sample: JSON.stringify(response).slice(0, 200) },
      );
    }
  }
  const inputTokens = obj.usage?.prompt_tokens ?? 0;
  const totalTokens = obj.usage?.total_tokens ?? inputTokens;
  return {
    vector,
    dimensions: vector.length,
    model: obj.model ?? requestedModel,
    usage: {
      input_tokens: inputTokens,
      output_tokens: 0,
      total_tokens: totalTokens,
    },
  };
};
