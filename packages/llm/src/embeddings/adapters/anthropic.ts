import type { AdapterKey } from '../../types.js';
import { LLMError } from '../../types.js';
import type { EmbeddingsAdapter } from '../types.js';

/** D-131 Phase 2 — Anthropic embeddings stub.
 *
 *  Anthropic does not publish an embeddings model today (only chat). The
 *  stub exists so the registry can return *something* for the `'anthropic'`
 *  key — a missing-key registry lookup would surface as an opaque "no
 *  adapter registered" error that wouldn't help the user. The stub instead
 *  throws a clearly-worded LLMError pointing at the actual remediation:
 *  add an OpenAI / Google / Mistral key alongside Anthropic.
 *
 *  This is also the safety net for misconfiguration — a user who sets an
 *  Anthropic provider + model on the embeddings slot will see this message
 *  rather than a 404 from Anthropic's chat endpoint that they'd have to
 *  debug.
 *
 *  Future: if Anthropic ships an embeddings endpoint, this stub becomes
 *  a real adapter. The interface stays unchanged. */
export const createAnthropicEmbeddingsAdapter = (): EmbeddingsAdapter => ({
  provider: 'anthropic' as AdapterKey,
  async embed() {
    throw new LLMError(
      'AI_LLM_UNAVAILABLE',
      'Anthropic does not publish a public embeddings model. Configure an OpenAI, Google, or Mistral key alongside your Anthropic slot to enable embeddings — chat continues to use Anthropic.',
      { provider: 'anthropic' },
    );
  },
});
