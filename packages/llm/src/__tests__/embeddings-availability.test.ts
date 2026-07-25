import { describe, it, expect, vi } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import {
  buildEmbeddingsAvailability,
  executeEmbedding,
} from '../embeddings/index.js';
import type {
  EmbeddingsAdapter,
  EmbeddingsAdapterRegistry,
} from '../embeddings/index.js';
import type { LLMConfig, LLMSlot, TokenUsage } from '../types.js';
import { createQuotaTracker } from '../quota.js';

/** D-174 R28 Slice C — the dedicated embeddings slot. Its `model` field IS
 *  the embeddings model string. */
const embeddingsSlot = (over: Partial<LLMSlot> = {}): LLMSlot => ({
  provider: 'openai',
  model: 'text-embedding-3-small',
  api_key: 'sk-test',
  ...over,
});

const embedManifest: IngredientManifest = {
  slug: 'ai-embed',
  name: 'Embed',
  description: 'Embed',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: { vector: 'vector', dimensions: 'dimensions', model: 'model' },
};

const fakeAdapter = (
  vector: number[] = [0.1, 0.2, 0.3],
  usage: TokenUsage = { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
): EmbeddingsAdapter => ({
  provider: 'openai',
  embed: vi.fn(async (_slot, _request, options) => ({
    vector,
    dimensions: vector.length,
    model: options.model,
    usage,
  })),
});

const registryFor = (adapter: EmbeddingsAdapter): EmbeddingsAdapterRegistry =>
  () => adapter;

// ────────────────────────────────────────────────────────────────
// buildEmbeddingsAvailability — the single dedicated embeddings slot
// ────────────────────────────────────────────────────────────────

describe('buildEmbeddingsAvailability', () => {
  it('no_key when no embeddings slot is configured', () => {
    const snap = buildEmbeddingsAvailability({
      config: {},
      quota: createQuotaTracker(),
    });
    expect(snap.embeddings_slot).toEqual({ available: false, reason: 'no_key' });
  });

  it('no_key when the embeddings slot is missing its api_key', () => {
    const snap = buildEmbeddingsAvailability({
      config: { embeddings_slot: { ...embeddingsSlot(), api_key: '' } },
      quota: createQuotaTracker(),
    });
    expect(snap.embeddings_slot).toEqual({ available: false, reason: 'no_key' });
  });

  it('no_embeddings_model when the slot has a key but no model', () => {
    const snap = buildEmbeddingsAvailability({
      config: { embeddings_slot: { ...embeddingsSlot(), model: '' } },
      quota: createQuotaTracker(),
    });
    expect(snap.embeddings_slot).toEqual({ available: false, reason: 'no_embeddings_model' });
  });

  it('available when key + model are both set', () => {
    const snap = buildEmbeddingsAvailability({
      config: { embeddings_slot: embeddingsSlot() },
      quota: createQuotaTracker(),
    });
    expect(snap.embeddings_slot).toEqual({ available: true });
  });

  it('quota_exhausted when the embeddings slot is in cooldown', () => {
    const quota = createQuotaTracker();
    quota.markRateLimited('embeddings_slot', 60_000);
    const snap = buildEmbeddingsAvailability({
      config: { embeddings_slot: embeddingsSlot() },
      quota,
    });
    expect(snap.embeddings_slot).toEqual({ available: false, reason: 'quota_exhausted' });
  });

  it('ignores chat slot_1 / slot_2 / free_pool — only the embeddings slot counts', () => {
    // A fully-configured chat fleet does NOT make embeddings available.
    const snap = buildEmbeddingsAvailability({
      config: {
        slot_1: embeddingsSlot(),
        slot_2: embeddingsSlot({ api_key: 'sk-2' }),
        free_pool: [{
          id: 'p', type: 'api', provider: 'openai', model: 'm', api_key: 'k',
          speed: 'fast', supports_json: true, enabled: true,
        }],
      },
      quota: createQuotaTracker(),
    });
    expect(snap.embeddings_slot).toEqual({ available: false, reason: 'no_key' });
  });

  it('a cooldown on a chat slot key does NOT affect the embeddings slot', () => {
    // The embeddings slot keys cooldown under EMBEDDINGS_SLOT_KEY, not slot_1.
    const quota = createQuotaTracker();
    quota.markRateLimited('slot_1', 60_000);
    const snap = buildEmbeddingsAvailability({
      config: { embeddings_slot: embeddingsSlot() },
      quota,
    });
    expect(snap.embeddings_slot).toEqual({ available: true });
  });
});

// ────────────────────────────────────────────────────────────────
// executeEmbedding — preBuiltAvailability reuse
// ────────────────────────────────────────────────────────────────

describe('executeEmbedding — preBuiltAvailability', () => {
  it('reuses an injected snapshot instead of recomputing each call', async () => {
    const adapter = fakeAdapter([0.1]);
    const config: LLMConfig = { embeddings_slot: embeddingsSlot() };
    const quota = createQuotaTracker();
    const snapshot = buildEmbeddingsAvailability({ config, quota });
    const result = await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi' },
      { config, adapters: registryFor(adapter), quota, preBuiltAvailability: snapshot },
    );
    expect(result.vector).toEqual([0.1]);
  });

  it('does not dispatch when the prebuilt snapshot marks the slot unavailable', async () => {
    const adapter = fakeAdapter([0.1]);
    // Snapshot built from an empty config → slot unavailable; even though the
    // call passes a configured slot, the prebuilt snapshot governs.
    const snapshot = buildEmbeddingsAvailability({ config: {}, quota: createQuotaTracker() });
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        {
          config: { embeddings_slot: embeddingsSlot() },
          adapters: registryFor(adapter),
          quota: createQuotaTracker(),
          preBuiltAvailability: snapshot,
        },
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
    expect(adapter.embed).not.toHaveBeenCalled();
  });
});
