/** openai-compatible provider entry — same code paths as the OpenAI
 *  entry, bound to the `'openai-compatible'` adapter key.
 *
 *  Covers Groq / Cerebras / OpenRouter / GitHub Models / Mistral /
 *  Together / Ollama / vLLM / any other OpenAI-API-shape endpoint via
 *  the slot's `base_url`. The adapter factories take the provider key
 *  argument so error messages + telemetry attribution stay accurate
 *  (a 401 from Groq surfaces as "openai-compatible auth failed"
 *  pointing at the right slot, not a misleading "openai auth failed"). */

import { createOpenAIAdapter } from '../adapters/openai.js';
import { createOpenAIEmbeddingsAdapter } from '../embeddings/adapters/openai.js';
import type { LlmProviderEntry } from './registry.js';

export const openaiCompatibleProviderEntry: LlmProviderEntry = {
  provider: 'openai-compatible',
  buildChatAdapter: () => createOpenAIAdapter('openai-compatible'),
  buildEmbeddingsAdapter: () => createOpenAIEmbeddingsAdapter('openai-compatible'),
};
