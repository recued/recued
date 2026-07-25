import type { AdapterKey } from '../../types.js';
import { LLMError } from '../../types.js';
import type { EmbeddingsAdapter, EmbeddingsAdapterRegistry } from '../types.js';
import { LLM_PROVIDER_REGISTRY } from '../../providers/registry.js';

export { createOpenAIEmbeddingsAdapter } from './openai.js';
export { createGoogleEmbeddingsAdapter } from './google.js';
export { createAnthropicEmbeddingsAdapter } from './anthropic.js';

/** D-131 Phase 2 — default embeddings adapter registry.
 *
 *  Mirrors `createDefaultRegistry` in `../adapters/index.ts` but for the
 *  embeddings surface. Iterates `LLM_PROVIDER_REGISTRY` and includes
 *  every entry whose `buildEmbeddingsAdapter` is defined:
 *
 *    - `openai`            — POST /v1/embeddings (text-embedding-3-*)
 *    - `openai-compatible` — same code path, slot.base_url override
 *    - `google`            — Gemini embedContent (text-embedding-004)
 *    - `anthropic`         — stub that throws (no public model today)
 *
 *  `web_chat` is intentionally absent — its provider entry omits
 *  `buildEmbeddingsAdapter` so the iteration skips it. A registry
 *  lookup for `'web_chat'` falls through to the default error branch
 *  and surfaces AI_LLM_UNAVAILABLE, which is the correct outcome for
 *  the source-pick resolver. */
export const createDefaultEmbeddingsRegistry = (): EmbeddingsAdapterRegistry => {
  const map: Partial<Record<AdapterKey, EmbeddingsAdapter>> = {};
  for (const entry of LLM_PROVIDER_REGISTRY) {
    if (!entry.buildEmbeddingsAdapter) continue;
    map[entry.provider] = entry.buildEmbeddingsAdapter();
  }

  return (key) => {
    const adapter = map[key];
    if (!adapter) {
      throw new LLMError(
        'AI_LLM_UNAVAILABLE',
        `No embeddings adapter registered for: ${key}`,
        { provider: key },
      );
    }
    return adapter;
  };
};
