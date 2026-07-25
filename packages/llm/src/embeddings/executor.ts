import type { IngredientManifest } from '@recued/contracts';
import type {
  LLMConfig,
  LLMSlot,
  TokenUsage,
} from '../types.js';
import { LLMError } from '../types.js';
import { resolveLLMTimeoutMs } from '../timeout.js';
import type { QuotaTracker } from '../quota.js';
import type {
  EmbeddingsAdapterRegistry,
  EmbeddingsOutput,
} from './types.js';
import { isEmbeddingsManifest } from './types.js';
import {
  buildEmbeddingsAvailability,
  EMBEDDINGS_SLOT_KEY,
  type EmbeddingsAvailabilitySnapshot,
} from './availability.js';

/** D-131 Phase 1 (interface) + D-174 R28 Slice C (dedicated slot) —
 *  `executeEmbedding` entry point.
 *
 *  Embeddings resolves to ONE dedicated source — `config.embeddings_slot`
 *  (a full `LLMSlot` whose `model` field is the embeddings model). It
 *  shares the chat `LLMConfig` container, the shared `QuotaTracker` (so a
 *  429 cooldown on the same key carries across surfaces), and the
 *  `TokenUsage` reporting surface — but the adapter call shape, per-call
 *  options, and source pick are embeddings-specific.
 *
 *  Slice C collapsed the former slot_1 → slot_2 → free-pool cascade to this
 *  single read: embeddings is a recipe/housekeeping capability, never a
 *  chat model-select option, so it gets its own slot rather than riding the
 *  chat slots' (now-removed) per-slot `embeddings_model` field. With one
 *  source there's no tier ladder and no cascade — a retryable provider
 *  error records a cooldown (for the next call) and surfaces, since there
 *  is nowhere to fall through to. */

/** The resolved embeddings source, with everything needed to dispatch. */
interface EmbeddingsSource {
  /** Stable id for cooldown / request accounting — always the fixed
   *  `EMBEDDINGS_SLOT_KEY`. */
  id: string;
  slot: LLMSlot;
  /** The embeddings model string — the slot's own `model` field. */
  embeddings_model: string;
}

export interface EmbeddingsExecutorDeps {
  /** Shares the chat `LLMConfig`; this resolver reads only its
   *  `embeddings_slot`. */
  config: LLMConfig;
  /** Embeddings adapter registry. Apps wire vendor implementations
   *  via `createDefaultEmbeddingsRegistry()`. */
  adapters: EmbeddingsAdapterRegistry;
  /** Shared QuotaTracker — same instance the chat path uses. A 429
   *  cooldown set elsewhere on the embeddings key applies here too. */
  quota: QuotaTracker;
  /** Pre-built availability snapshot. When set, the executor skips
   *  `buildEmbeddingsAvailability` and reuses this snapshot. Useful
   *  when a recipe runs multiple embeddings calls and wants every call
   *  to see the same source state. */
  preBuiltAvailability?: EmbeddingsAvailabilitySnapshot;
  /** Per-call timeout in milliseconds. Same default policy as chat
   *  (`null` → no auto-abort). */
  timeout_ms?: number;
  /** Callback to report token usage after each successful embeddings call. */
  onTokenUsage?: (usage: TokenUsage) => void;
}

/** Execute a single embeddings ingredient call.
 *
 *  Flow:
 *    1. Validate manifest is an embeddings ingredient (kind:'ai' + output.vector).
 *    2. Validate input — `llm.data` is a non-empty string.
 *    3. Build availability snapshot (or use `preBuiltAvailability`).
 *    4. Resolve the embeddings slot; dispatch once.
 *    5. On success: report TokenUsage, record embeddings spend, return
 *       `{ vector, dimensions, model }`.
 *
 *  Errors:
 *    - `AI_OUTPUT_INVALID` — manifest mis-shaped or input missing.
 *    - `AI_LLM_UNAVAILABLE` — no embeddings slot configured.
 *    - Any other LLMError the adapter throws is propagated unchanged; a
 *      retryable one records a cooldown on the way out. */
export const executeEmbedding = async (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
  deps: EmbeddingsExecutorDeps,
): Promise<EmbeddingsOutput> => {
  if (!isEmbeddingsManifest(manifest)) {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `executeEmbedding called with non-embeddings manifest '${manifest.slug}' — expected kind:'ai' with output.vector declared`,
      { slug: manifest.slug, kind: manifest.kind },
    );
  }
  const text = input['llm.data'];
  if (typeof text !== 'string' || text.length === 0) {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `${manifest.slug} requires non-empty string input 'llm.data'`,
      { slug: manifest.slug, missing: 'llm.data' },
    );
  }
  // D-167 P6 / D-174 R28 — embeddings does NOT implement the single-step
  // `llm.pii_fields` aliasing contract (it sends `llm.data` to the provider
  // raw, with no field aliasing). A declaration here would imply protection
  // that is never applied, so fail CLOSED — mirroring `executeLLM` — rather
  // than silently ship raw PII. Authors alias upstream with `pii-protect`.
  const piiFields = input['llm.pii_fields'];
  if (piiFields !== undefined && piiFields !== null) {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `${manifest.slug}: llm.pii_fields is not supported on embeddings — the model payload (llm.data) is sent without field aliasing; alias upstream with the pii-protect transform`,
      { slug: manifest.slug },
    );
  }
  const dimensionsHint = pickDimensionsHint(input['llm.dimensions']);

  const availability = deps.preBuiltAvailability ?? buildEmbeddingsAvailability({
    config: deps.config,
    quota: deps.quota,
  });

  const source = pickEmbeddingsSource(deps.config, availability);
  if (!source) {
    throw new LLMError(
      'AI_LLM_UNAVAILABLE',
      'No embeddings model configured. Set up an embeddings slot in Settings → AI/Models (Providers → Embeddings) — e.g. an OpenAI `text-embedding-3-small` key, or an OpenAI-compatible / Google provider. Anthropic publishes no embeddings model.',
    );
  }

  try {
    const adapter = deps.adapters(source.slot.provider);
    const options = {
      model: source.embeddings_model,
      dimensions: dimensionsHint,
      timeout_ms: resolveLLMTimeoutMs(deps.timeout_ms),
    };
    deps.quota.registerRequest(source.id);
    const result = await adapter.embed(source.slot, { input: text }, options);

    if (deps.onTokenUsage) {
      // Single dedicated source — no per-source attribution discriminator
      // (embeddings stays off the chat slot/pool TokenUsageAttribution
      // union). Forward the raw provider usage.
      deps.onTokenUsage({ ...result.usage });
    }
    // Record embeddings spend against the shared QuotaTracker so the
    // `embeddings_tokens_today` breakout + daily accounting reflect the call.
    deps.quota.recordEmbeddingsUsage(source.id, result.usage.total_tokens);

    return {
      vector: result.vector,
      dimensions: result.dimensions,
      model: result.model,
    };
  } catch (e) {
    if (e instanceof LLMError && e.retryable) {
      // Persist a cooldown so the NEXT call deranks this source until the
      // provider's Retry-After (or the default window) elapses. A single
      // embeddings source has nothing to cascade to, so we surface the
      // error rather than re-pick.
      const retryAfterMs = typeof e.details?.retry_after_ms === 'number'
        ? e.details.retry_after_ms
        : undefined;
      deps.quota.markRateLimited(source.id, retryAfterMs);
    }
    throw e;
  }
};

/** Optional dimensions hint validation. Coerces non-positive / non-finite
 *  values to undefined so the adapter doesn't see garbage. */
const pickDimensionsHint = (raw: unknown): number | undefined => {
  if (typeof raw !== 'number') return undefined;
  if (!Number.isFinite(raw)) return undefined;
  if (raw <= 0) return undefined;
  return Math.floor(raw);
};

/** Resolve the single embeddings source — `config.embeddings_slot`.
 *
 *  Returns null when no embeddings slot is configured, the slot has no
 *  model, or the availability snapshot marks it unavailable (no key /
 *  cooldown). There is deliberately no slot_1 / slot_2 / free-pool
 *  fallback: embeddings is served only by its dedicated slot. */
const pickEmbeddingsSource = (
  config: LLMConfig,
  availability: EmbeddingsAvailabilitySnapshot,
): EmbeddingsSource | null => {
  const slot = config.embeddings_slot;
  if (!slot) return null;
  if (!availability.embeddings_slot.available) return null;
  if (!slot.model) return null; // belt-and-suspenders; availability gates this too
  return { id: EMBEDDINGS_SLOT_KEY, slot, embeddings_model: slot.model };
};
