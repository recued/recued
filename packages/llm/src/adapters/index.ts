import type { AdapterKey, AdapterRegistry, LLMAdapter } from '../types.js';
import { LLMError } from '../types.js';
import { LLM_PROVIDER_REGISTRY } from '../providers/registry.js';

export { createAnthropicAdapter } from './anthropic.js';
export { createOpenAIAdapter } from './openai.js';
export { createGoogleAdapter } from './google.js';
export { toAnthropicContent, toGoogleParts, toOpenAIContent } from './content-parts.js';
export {
  createDefaultTranscriptionRegistry,
  createOpenAITranscriptionAdapter,
  createGoogleTranscriptionAdapter,
  createAnthropicTranscriptionAdapter,
  defaultTranscriptionModel,
} from './transcription.js';
export type {
  TranscriptionAdapter,
  TranscriptionAdapterRegistry,
  TranscriptionRequest,
  TranscriptionOptions,
  TranscriptionResult,
} from './transcription.js';
/** Build the default adapter registry covering all supported providers.
 *  Apps can wrap or replace this to inject mocks or add providers.
 *
 *  Iterates `LLM_PROVIDER_REGISTRY` — adding a provider is one entry
 *  append, no edit here. */
export const createDefaultRegistry = (
  opts: { webChatBridge?: unknown } = {},
): AdapterRegistry => {
  const map: Partial<Record<AdapterKey, LLMAdapter>> = {};
  for (const entry of LLM_PROVIDER_REGISTRY) {
    if (!entry.buildChatAdapter) continue;
    const adapter = entry.buildChatAdapter({ webChatBridge: opts.webChatBridge });
    if (adapter) {
      map[entry.provider] = adapter;
    }
  }

  return (key) => {
    const adapter = map[key];
    if (!adapter) {
      throw new LLMError('AI_LLM_UNAVAILABLE', `No adapter registered for: ${key}`);
    }
    return adapter;
  };
};
