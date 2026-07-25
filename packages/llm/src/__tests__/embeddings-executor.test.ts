import { describe, it, expect, vi } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import { executeEmbedding, isEmbeddingsManifest } from '../embeddings/index.js';
import type {
  EmbeddingsAdapter,
  EmbeddingsAdapterRegistry,
} from '../embeddings/index.js';
import type { LLMConfig, LLMSlot, TokenUsage } from '../types.js';
import { LLMError } from '../types.js';
import { createQuotaTracker } from '../quota.js';

/** Minimal ai-embed manifest. The discriminator is `kind:'ai'` plus a
 *  declared `output.vector` field — see `isEmbeddingsManifest`. */
const embedManifest: IngredientManifest = {
  slug: 'ai-embed',
  name: 'Embed',
  description: 'Compute an embedding vector for input text',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: {
    vector: 'vector',
    dimensions: 'dimensions',
    model: 'model',
  },
};

/** A non-embeddings ai manifest — kind:'ai' but no output.vector. */
const classifyManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'Classify',
  description: 'Classify',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: { result: 'result' },
};

const fakeEmbeddingsAdapter = (
  vector: number[] = [0.1, 0.2, 0.3],
  modelEcho?: string,
  usage: TokenUsage = { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
): EmbeddingsAdapter => ({
  provider: 'openai',
  embed: vi.fn(async (_slot, _request, options) => ({
    vector,
    dimensions: vector.length,
    model: modelEcho ?? options.model,
    usage,
  })),
});

const registryFor = (adapter: EmbeddingsAdapter): EmbeddingsAdapterRegistry =>
  () => adapter;

/** D-174 R28 Slice C — the dedicated embeddings slot. Its `model` field IS
 *  the embeddings model string (a full LLMSlot shape, but embeddings has no
 *  speed/json tier so those are omitted). */
const embeddingsSlot = (over: Partial<LLMSlot> = {}): LLMSlot => ({
  provider: 'openai',
  model: 'text-embedding-3-small',
  api_key: 'sk-test',
  ...over,
});

/** A chat slot — proves embeddings does NOT fall back to chat slots. */
const chatSlot = (over: Partial<LLMSlot> = {}): LLMSlot => ({
  provider: 'openai',
  model: 'gpt-4.1-mini',
  api_key: 'sk-chat',
  speed: 'fast',
  supports_json: true,
  ...over,
});

// ────────────────────────────────────────────────────────────────
// isEmbeddingsManifest discriminator
// ────────────────────────────────────────────────────────────────

describe('isEmbeddingsManifest', () => {
  it('flags kind:ai with output.vector as embeddings', () => {
    expect(isEmbeddingsManifest(embedManifest)).toBe(true);
  });

  it('rejects kind:ai without output.vector', () => {
    expect(isEmbeddingsManifest(classifyManifest)).toBe(false);
  });

  it('rejects non-ai kind even with output.vector', () => {
    expect(isEmbeddingsManifest({
      kind: 'http',
      output: { vector: 'data.vector' },
    } as Pick<IngredientManifest, 'kind' | 'output'>)).toBe(false);
  });

  it('rejects empty string output.vector', () => {
    expect(isEmbeddingsManifest({
      kind: 'ai',
      output: { vector: '' },
    } as Pick<IngredientManifest, 'kind' | 'output'>)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// executeEmbedding — happy path (single dedicated slot)
// ────────────────────────────────────────────────────────────────

describe('executeEmbedding — happy path', () => {
  it('returns vector + dimensions + model from the embeddings slot', async () => {
    const adapter = fakeEmbeddingsAdapter([0.5, 0.6, 0.7, 0.8]);
    const config: LLMConfig = { embeddings_slot: embeddingsSlot() };
    const result = await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hello world' },
      { config, adapters: registryFor(adapter), quota: createQuotaTracker() },
    );
    expect(result).toEqual({
      vector: [0.5, 0.6, 0.7, 0.8],
      dimensions: 4,
      model: 'text-embedding-3-small',
    });
    expect(adapter.embed).toHaveBeenCalledTimes(1);
    const callArgs = (adapter.embed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].api_key).toBe('sk-test');
    expect(callArgs[1]).toEqual({ input: 'hello world' });
    // The slot's own `model` field is the embeddings model.
    expect(callArgs[2].model).toBe('text-embedding-3-small');
    expect(callArgs[2].timeout_ms).toBeNull();
  });

  it('passes llm.dimensions hint through to the adapter when positive', async () => {
    const adapter = fakeEmbeddingsAdapter([1, 2, 3]);
    const config: LLMConfig = { embeddings_slot: embeddingsSlot() };
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi', 'llm.dimensions': 512 },
      { config, adapters: registryFor(adapter), quota: createQuotaTracker() },
    );
    const opts = (adapter.embed as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.dimensions).toBe(512);
  });

  it('drops non-positive llm.dimensions hints', async () => {
    const adapter = fakeEmbeddingsAdapter([1, 2, 3]);
    const config: LLMConfig = { embeddings_slot: embeddingsSlot() };
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi', 'llm.dimensions': -5 },
      { config, adapters: registryFor(adapter), quota: createQuotaTracker() },
    );
    const opts = (adapter.embed as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.dimensions).toBeUndefined();
  });

  it('forwards raw TokenUsage via onTokenUsage (no per-source attribution) and records embeddings spend', async () => {
    const adapter = fakeEmbeddingsAdapter([1], undefined, {
      input_tokens: 12,
      output_tokens: 0,
      total_tokens: 12,
    });
    const quota = createQuotaTracker();
    const usageEvents: TokenUsage[] = [];
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi' },
      {
        config: { embeddings_slot: embeddingsSlot() },
        adapters: registryFor(adapter),
        quota,
        onTokenUsage: (u) => usageEvents.push(u),
      },
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].total_tokens).toBe(12);
    // Slice C drops per-source attribution for the single embeddings slot —
    // it never rides the chat slot/pool TokenUsageAttribution union.
    expect(usageEvents[0].attribution).toBeUndefined();
    expect(usageEvents[0].slot_key).toBeUndefined();
    // Spend is recorded against the fixed embeddings-slot key.
    expect(quota.embeddingsTokensToday('embeddings_slot')).toBe(12);
    expect(quota.snapshot().tokens_today['embeddings_slot']).toBe(12);
  });
});

// ────────────────────────────────────────────────────────────────
// executeEmbedding — source resolution (only the dedicated slot)
// ────────────────────────────────────────────────────────────────

describe('executeEmbedding — source resolution', () => {
  it('reads ONLY embeddings_slot — never falls back to chat slot_1/slot_2 or the free pool', async () => {
    // A fully-configured chat slot_1 + free pool, but NO embeddings_slot →
    // embeddings is unavailable (the cascade was removed in Slice C).
    const adapter = fakeEmbeddingsAdapter([0.1]);
    const config: LLMConfig = {
      slot_1: chatSlot(),
      slot_2: chatSlot({ provider: 'google', model: 'gemini-2.5-pro', api_key: 'sk-g' }),
      free_pool: [{
        id: 'p1', type: 'api', provider: 'openai-compatible', model: 'm',
        api_key: 'sk-pool', base_url: 'https://x/v1', speed: 'fast',
        supports_json: true, enabled: true,
      }],
    };
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        { config, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it('uses the embeddings slot even when chat slots are also configured', async () => {
    const adapter = fakeEmbeddingsAdapter([0.1]);
    const config: LLMConfig = {
      slot_1: chatSlot(),
      embeddings_slot: embeddingsSlot({ provider: 'google', model: 'text-embedding-004', api_key: 'sk-g' }),
    };
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi' },
      { config, adapters: registryFor(adapter), quota: createQuotaTracker() },
    );
    const callArgs = (adapter.embed as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].api_key).toBe('sk-g');
    expect(callArgs[2].model).toBe('text-embedding-004');
  });

  it('throws AI_LLM_UNAVAILABLE (no dispatch) when the embeddings slot is in cooldown', async () => {
    const quota = createQuotaTracker();
    quota.markRateLimited('embeddings_slot', 60_000);
    const adapter = fakeEmbeddingsAdapter([0.9]);
    const config: LLMConfig = { embeddings_slot: embeddingsSlot() };
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        { config, adapters: registryFor(adapter), quota },
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
    expect(adapter.embed).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// executeEmbedding — failure paths
// ────────────────────────────────────────────────────────────────

describe('executeEmbedding — failure paths', () => {
  it('throws AI_OUTPUT_INVALID when manifest is not an embeddings ingredient', async () => {
    const adapter = fakeEmbeddingsAdapter();
    await expect(
      executeEmbedding(
        classifyManifest,
        { 'llm.data': 'hi' },
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it('throws AI_OUTPUT_INVALID when llm.data is missing', async () => {
    const adapter = fakeEmbeddingsAdapter();
    await expect(
      executeEmbedding(
        embedManifest,
        {},
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });

  it('throws AI_OUTPUT_INVALID when llm.data is empty string', async () => {
    const adapter = fakeEmbeddingsAdapter();
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': '' },
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });

  it('fails CLOSED (AI_OUTPUT_INVALID) when llm.pii_fields is declared — embeddings does not alias', async () => {
    // D-167 P6 / D-174 R28 — embeddings sends llm.data raw; a pii_fields
    // declaration implies protection that is never applied, so it must fail
    // closed rather than silently ship raw PII. No dispatch.
    const adapter = fakeEmbeddingsAdapter();
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'Jane Doe jane@acme.com', 'llm.pii_fields': { name: ['contact'] } },
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it('throws AI_LLM_UNAVAILABLE when no embeddings slot is configured', async () => {
    const adapter = fakeEmbeddingsAdapter();
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        { config: {}, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
    expect(adapter.embed).not.toHaveBeenCalled();
  });

  it('marks a cooldown on the embeddings slot for a retryable error, then throws (no cascade)', async () => {
    const adapter: EmbeddingsAdapter = {
      provider: 'openai',
      embed: vi.fn(async () => {
        throw new LLMError('AI_LLM_UNAVAILABLE', 'rate limited (429)', { status: 429, retry_after_ms: 90_000 }, true);
      }),
    };
    const quota = createQuotaTracker();
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota },
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE', retryable: true });
    // Single source — exactly one dispatch, no cascade.
    expect(adapter.embed).toHaveBeenCalledTimes(1);
    // The retryable error stamped a cooldown for the next call.
    expect(quota.isInCooldown('embeddings_slot')).toBe(true);
  });

  it('does NOT mark a cooldown for a non-retryable error, and propagates it', async () => {
    const adapter: EmbeddingsAdapter = {
      provider: 'openai',
      embed: vi.fn(async () => {
        throw new LLMError('AI_TOKEN_BUDGET_EXCEEDED', 'input too long', { status: 413 }, false);
      }),
    };
    const quota = createQuotaTracker();
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota },
      ),
    ).rejects.toMatchObject({ code: 'AI_TOKEN_BUDGET_EXCEEDED' });
    expect(adapter.embed).toHaveBeenCalledTimes(1);
    expect(quota.isInCooldown('embeddings_slot')).toBe(false);
  });

  it('propagates non-LLMError adapter throws unchanged', async () => {
    const adapter: EmbeddingsAdapter = {
      provider: 'openai',
      embed: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    await expect(
      executeEmbedding(
        embedManifest,
        { 'llm.data': 'hi' },
        { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota: createQuotaTracker() },
      ),
    ).rejects.toThrow('connection refused');
  });
});

// ────────────────────────────────────────────────────────────────
// executeEmbedding — timeout policy
// ────────────────────────────────────────────────────────────────

describe('executeEmbedding — timeout policy', () => {
  it('passes null timeout when deps.timeout_ms is undefined (matches chat default)', async () => {
    const adapter = fakeEmbeddingsAdapter();
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi' },
      { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota: createQuotaTracker() },
    );
    const opts = (adapter.embed as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.timeout_ms).toBeNull();
  });

  it('respects explicit deps.timeout_ms override when caller opts in', async () => {
    const adapter = fakeEmbeddingsAdapter();
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi' },
      {
        config: { embeddings_slot: embeddingsSlot() },
        adapters: registryFor(adapter),
        quota: createQuotaTracker(),
        timeout_ms: 30_000,
      },
    );
    const opts = (adapter.embed as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.timeout_ms).toBe(30_000);
  });
});

// ────────────────────────────────────────────────────────────────
// executeEmbedding — request registration
// ────────────────────────────────────────────────────────────────

describe('executeEmbedding — request registration', () => {
  it('registers a request with the QuotaTracker before dispatching', async () => {
    const adapter = fakeEmbeddingsAdapter();
    const quota = createQuotaTracker();
    const spy = vi.spyOn(quota, 'registerRequest');
    await executeEmbedding(
      embedManifest,
      { 'llm.data': 'hi' },
      { config: { embeddings_slot: embeddingsSlot() }, adapters: registryFor(adapter), quota },
    );
    expect(spy).toHaveBeenCalledWith('embeddings_slot');
  });
});
