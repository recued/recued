/** Anthropic provider entry — chat via Messages API + embeddings stub.
 *
 *  Chat: `createAnthropicAdapter()` wraps the Anthropic Messages API
 *  (`POST /v1/messages` with `x-api-key`). Supports extended reasoning
 *  + web-search tool calls when the slot's capability tier asks.
 *
 *  Embeddings: stub adapter that throws `AI_LLM_UNAVAILABLE` at call
 *  time. Anthropic has no public embeddings model today; the entry
 *  still registers so the provider-availability probe can surface a
 *  precise "anthropic embeddings unavailable" diagnostic rather than
 *  collapsing to a generic "no adapter for anthropic" lookup miss.
 *  Pure-Anthropic users leave their slot's `embeddings_model` empty
 *  and the resolver routes embeddings through whichever other slot /
 *  pool entry the user has wired. */

import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createAnthropicEmbeddingsAdapter } from '../embeddings/adapters/anthropic.js';
import type { LlmProviderEntry } from './registry.js';

export const anthropicProviderEntry: LlmProviderEntry = {
  provider: 'anthropic',
  buildChatAdapter: () => createAnthropicAdapter(),
  buildEmbeddingsAdapter: () => createAnthropicEmbeddingsAdapter(),
};
