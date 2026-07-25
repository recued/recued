/** D-131 — embeddings substrate.
 *
 *  Public surface for the embeddings driver. Mirrors the chat package
 *  layout (executor + types) but kept in a sub-namespace so the chat
 *  surface stays free of embeddings-specific entries.
 *
 *  Top-level `@recued/llm` re-exports the load-bearing pieces:
 *  `executeEmbedding`, `EmbeddingsAdapter`, `EmbeddingsAdapterRegistry`,
 *  `isEmbeddingsManifest`. Internal callers (adapters package, ingredient
 *  layer) import via `@recued/llm/embeddings/*` if they need the deeper
 *  surface, but in practice the top-level re-exports cover the use
 *  cases. */
export type {
  EmbeddingsRequest,
  EmbeddingsOptions,
  EmbeddingsResult,
  EmbeddingsAdapter,
  EmbeddingsAdapterRegistry,
  EmbeddingsOutput,
} from './types.js';
export { isEmbeddingsManifest } from './types.js';

export { executeEmbedding } from './executor.js';
export type { EmbeddingsExecutorDeps } from './executor.js';

export {
  createDefaultEmbeddingsRegistry,
  createOpenAIEmbeddingsAdapter,
  createGoogleEmbeddingsAdapter,
  createAnthropicEmbeddingsAdapter,
} from './adapters/index.js';

export { buildEmbeddingsAvailability } from './availability.js';
export type {
  EmbeddingsAvailabilitySnapshot,
  BuildEmbeddingsAvailabilityDeps,
} from './availability.js';
