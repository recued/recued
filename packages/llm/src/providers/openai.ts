/** OpenAI provider entry — chat via /v1/chat/completions + embeddings
 *  via /v1/embeddings.
 *
 *  Both factories accept the provider key explicitly so the same code
 *  paths serve `'openai'` (api.openai.com defaults) and
 *  `'openai-compatible'` (custom `base_url` for Groq / Cerebras /
 *  Ollama / vLLM / etc.). This entry binds to the `'openai'` key
 *  specifically; the parallel `openai-compatible` entry binds to the
 *  custom-endpoint key. */

import { createOpenAIAdapter } from '../adapters/openai.js';
import { createOpenAIEmbeddingsAdapter } from '../embeddings/adapters/openai.js';
import type { LlmProviderEntry } from './registry.js';

export const openaiProviderEntry: LlmProviderEntry = {
  provider: 'openai',
  buildChatAdapter: () => createOpenAIAdapter('openai'),
  buildEmbeddingsAdapter: () => createOpenAIEmbeddingsAdapter('openai'),
};
