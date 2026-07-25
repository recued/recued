import type { IngredientManifest } from '@recued/contracts';
import type { AdapterKey, LLMSlot, TokenUsage } from '../types.js';

/** D-131 Phase 1 — embeddings adapter surface, parallel to the chat
 *  `LLMAdapter` in ../types.ts.
 *
 *  The split exists because embeddings are a different kind of provider
 *  call — single text in, single vector out, no chat-message stream, no
 *  output_format negotiation, no thinking/search modes. Sharing the chat
 *  `LLMAdapter` interface would force every method on every adapter to
 *  no-op for the wrong call shape; a separate interface keeps each
 *  surface honest.
 *
 *  What IS shared with chat:
 *    - `AdapterKey` for the registry lookup (anthropic / openai /
 *      openai-compatible / google).
 *    - `LLMSlot` for credentials + endpoint config.
 *    - `TokenUsage` for billing accounting.
 *    - Quota tracker (per-vendor cooldowns are global — a 429 on
 *      OpenAI's chat API likely means a 429 is coming on the embeddings
 *      API too, since they share rate limits).
 *
 *  What's NOT shared:
 *    - Adapter method shape (`embed` vs `complete`).
 *    - Per-call options (`EmbeddingsOptions` vs `LLMCompletionOptions`).
 *    - Model identifier — for the dedicated embeddings slot, `slot.model`
 *      IS the embeddings model string (the slot reuses the `LLMSlot` shape;
 *      D-174 R28 Slice C). A chat slot's `slot.model` is its chat model —
 *      the same key may serve both surfaces under different model strings,
 *      configured on separate slots.
 */

/** What the embeddings provider needs as input. */
export interface EmbeddingsRequest {
  /** Single text string to embed. Batch input (string[]) is deferred to a
   *  future D — most callers (per-record producers) pass one string at a
   *  time and need vector-per-record attribution; batching adds output-
   *  ordering nuance that's not load-bearing for the launch sequence. */
  input: string;
}

/** Per-call options to the embeddings adapter. */
export interface EmbeddingsOptions {
  /** Provider-specific embeddings model identifier. */
  model: string;
  /** Optional output dimensions hint. Honored by OpenAI's text-embedding-3-*
   *  family (truncates the output vector to the requested size — Matryoshka).
   *  Other providers ignore. */
  dimensions?: number;
  /** Per-call timeout in ms, or null for unbounded — same default policy as
   *  chat (see `../timeout.ts`). Embeddings calls are typically faster than
   *  chat (single forward pass, no token-by-token decode), so the default
   *  null is even safer here. */
  timeout_ms: number | null;
}

/** Adapter-level result shape — vector + provenance + token usage. */
export interface EmbeddingsResult {
  /** Float32 vector. JS-side this is `number[]` for portability — adapters
   *  unpack provider responses (OpenAI returns `number[]` directly; Gemini
   *  returns `{ values: number[] }`) into this canonical shape. */
  vector: number[];
  /** Length of the returned vector. Stored alongside the vector because
   *  different providers + different models produce different dimensions
   *  (OpenAI 1536/3072, Gemini 768, Mistral 1024). Storage layer needs
   *  this to compute similarity within same-dim cohorts. */
  dimensions: number;
  /** The model string the provider returned (echo of options.model in
   *  most cases, but providers occasionally normalize aliases). */
  model: string;
  /** Token usage for billing accounting. `output_tokens` is always 0 for
   *  embeddings (no decode); only `input_tokens` and `total_tokens` are
   *  meaningful. */
  usage: TokenUsage;
}

/** Adapter-level entry point. Each provider implements this. Implementations
 *  should throw `LLMError` with appropriate codes:
 *    AI_TIMEOUT, AI_LLM_UNAVAILABLE, AI_TOKEN_BUDGET_EXCEEDED,
 *    AI_RESPONSE_PARSE_FAILED.
 *  Set `retryable: true` on LLMError when the error is eligible for a
 *  cascade re-match (auth failure, quota exhausted). */
export interface EmbeddingsAdapter {
  readonly provider: AdapterKey;
  embed(
    slot: LLMSlot,
    request: EmbeddingsRequest,
    options: EmbeddingsOptions,
  ): Promise<EmbeddingsResult>;
}

/** Factory by adapter key. Parallel to `AdapterRegistry` on the chat side. */
export type EmbeddingsAdapterRegistry = (key: AdapterKey) => EmbeddingsAdapter;

/** Engine-level output shape returned by `executeEmbedding` — strips the
 *  adapter-internal `TokenUsage` (reported separately via `onTokenUsage`)
 *  and mirrors the contracted `output.{vector,dimensions,model}` schema
 *  the `ai-embed` ingredient declares. */
export interface EmbeddingsOutput {
  vector: number[];
  dimensions: number;
  model: string;
}

/** True iff a manifest is an embeddings ingredient.
 *
 *  Discriminator: `kind === 'ai'` AND `output.vector` is declared.
 *  Spec rule from internal design notes A.2: "Manifest
 *  validator extension — `kind: 'ai'` ingredients with `output: { vector }`
 *  field flag as embeddings (vs chat)."
 *
 *  Cleaner than slug-listing because future per-vendor kernel embeddings
 *  ingredients (`ai-embed-openai`, `ai-embed-google`) can ride this
 *  without an enum update. The `output.vector` field doubles as the
 *  ingredient's wire-shape declaration AND the engine-routing signal. */
export const isEmbeddingsManifest = (
  manifest: Pick<IngredientManifest, 'kind' | 'output'>,
): boolean =>
  manifest.kind === 'ai' &&
  typeof manifest.output?.vector === 'string' &&
  manifest.output.vector.length > 0;
