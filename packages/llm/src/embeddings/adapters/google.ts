import { callProvider } from '../../adapters/anthropic.js';
import type { TokenUsage } from '../../types.js';
import { LLMError } from '../../types.js';
import type { EmbeddingsAdapter } from '../types.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

/** D-131 Phase 2 — Google Gemini embeddings adapter.
 *
 *  Gemini's embeddings API (`text-embedding-004`, dimensions 768) lives
 *  at a different endpoint shape than chat:
 *
 *    POST /v1beta/models/<model>:embedContent
 *    { "content": { "parts": [{ "text": "<input>" }] } }
 *
 *  Response shape:
 *    { "embedding": { "values": [0.0123, ...] } }
 *
 *  Notes:
 *    - **No usage block.** The Gemini embeddings API does not return
 *      token counts — usage is estimated client-side via the standard
 *      `chars / 4` heuristic. Sufficient for daily-cap accounting since
 *      Gemini's free tier is rate-limit-bound, not token-bound.
 *    - **Dimensions hint ignored.** `text-embedding-004` outputs 768
 *      dimensions; Gemini doesn't expose Matryoshka truncation today.
 *      The adapter accepts `options.dimensions` for API symmetry but
 *      doesn't forward it.
 *    - **Authentication via `x-goog-api-key`.** Same header convention
 *      as the chat adapter — keys interchangeably serve both surfaces.
 *
 *  Errors classify identically to chat via `callProvider`. */
export const createGoogleEmbeddingsAdapter = (): EmbeddingsAdapter => ({
  provider: 'google',
  async embed(slot, request, options) {
    const baseUrl = (slot.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/${API_VERSION}/models/${encodeURIComponent(options.model)}:embedContent`;

    const body = {
      content: { parts: [{ text: request.input }] },
    };

    const response = await callProvider(
      url,
      {
        'x-goog-api-key': slot.api_key,
        'content-type': 'application/json',
      },
      body,
      options.timeout_ms,
    );

    return parseGoogleEmbeddingsResponse(response, request.input, options.model);
  },
});

/** Parse a Gemini embedContent response into the canonical
 *  `EmbeddingsResult` shape. Token usage is estimated since Gemini
 *  doesn't return it. */
const parseGoogleEmbeddingsResponse = (
  response: unknown,
  input: string,
  requestedModel: string,
): { vector: number[]; dimensions: number; model: string; usage: TokenUsage } => {
  const obj = response as {
    embedding?: { values?: number[] | null };
  };
  const vector = obj.embedding?.values;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new LLMError(
      'AI_RESPONSE_PARSE_FAILED',
      'Google embeddings response missing embedding.values',
      { sample: JSON.stringify(response).slice(0, 200) },
    );
  }
  for (const n of vector) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new LLMError(
        'AI_RESPONSE_PARSE_FAILED',
        'Google embeddings response contains a non-finite number in embedding.values',
        { sample: JSON.stringify(response).slice(0, 200) },
      );
    }
  }
  const estimatedTokens = Math.ceil(input.length / 4);
  return {
    vector,
    dimensions: vector.length,
    model: requestedModel,
    usage: {
      input_tokens: estimatedTokens,
      output_tokens: 0,
      total_tokens: estimatedTokens,
    },
  };
};
