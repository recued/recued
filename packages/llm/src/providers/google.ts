/** Google provider entry — chat via Gemini generateContent + embeddings
 *  via embedContent (text-embedding-004).
 *
 *  Both adapter factories are parameter-free; the slot supplies the
 *  api_key (Generative Language API key, not GCP service-account
 *  cred). Vertex AI's separate code path lives behind the same
 *  `'google'` provider key — the adapter reads the slot's `base_url`
 *  to flip routing if set. */

import { createGoogleAdapter } from '../adapters/google.js';
import { createGoogleEmbeddingsAdapter } from '../embeddings/adapters/google.js';
import type { LlmProviderEntry } from './registry.js';

export const googleProviderEntry: LlmProviderEntry = {
  provider: 'google',
  buildChatAdapter: () => createGoogleAdapter(),
  buildEmbeddingsAdapter: () => createGoogleEmbeddingsAdapter(),
};
