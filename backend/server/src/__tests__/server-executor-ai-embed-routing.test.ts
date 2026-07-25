import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IngredientManifest } from '@recued/contracts';
import type { LLMConfig, QuotaTracker } from '@recued/llm';
import { createServerExecutor } from '../server-executor.js';
import type { ManifestRegistry } from '../manifest-loader.js';

/** D-174 R28 — wire `ai-embed` into the recipe execution path. The
 *  recipe-executable contracted AI functions are the `core-ai-*` manifests
 *  (author `recued-core` — NON-kernel, so they route to the `'ai'` adapter =
 *  `createLLMAdapter`; the bare `ai-*` are author `recued` → the kernel
 *  adapter, which has no AI handler, same as `ai-classify`). The 'ai' adapter
 *  must route an embeddings manifest (`kind:'ai'` + `output.vector`, via the
 *  REAL `isEmbeddingsManifest`) to `executeEmbedding`, chat to `executeLLM`;
 *  read config LIVE (`resolveLlmConfig`); and always wire the adapter (no boot
 *  `slot_1` gate). `executeLLM` / `executeEmbedding` / the adapter-registry
 *  factories are mocked; `isEmbeddingsManifest` + LLMError stay REAL so the
 *  routing decision is exercised. */

const llmMocks = vi.hoisted(() => ({
  createDefaultRegistry: vi.fn(() => ({ tag: 'chat-adapters' })),
  createDefaultEmbeddingsRegistry: vi.fn(() => ({ tag: 'embeddings-adapters' })),
  createQuotaTracker: vi.fn(() => ({ tag: 'quota' })),
  executeLLM: vi.fn(async () => ({ result: 'chat-ok' })),
  executeEmbedding: vi.fn(async () => ({ vector: [0.1, 0.2], dimensions: 2, model: 'text-embedding-3-small' })),
}));

vi.mock('@recued/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/llm')>();
  return {
    ...actual, // keep the REAL isEmbeddingsManifest + LLMError
    createDefaultRegistry: llmMocks.createDefaultRegistry,
    createDefaultEmbeddingsRegistry: llmMocks.createDefaultEmbeddingsRegistry,
    createQuotaTracker: llmMocks.createQuotaTracker,
    executeLLM: llmMocks.executeLLM,
    executeEmbedding: llmMocks.executeEmbedding,
  };
});

// `recued-core` (publishable contracted form) → non-kernel → the 'ai' adapter.
const embedManifest: IngredientManifest = {
  slug: 'core-ai-embed',
  name: 'AI Embed',
  description: 'embed',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: { vector: 'vector', dimensions: 'dimensions', model: 'model' }, // discriminator
};

const chatManifest: IngredientManifest = {
  slug: 'core-ai-summarize',
  name: 'AI summarize',
  description: 'summarize',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: { result: 'summary' }, // no vector → chat
};

const registry = (): ManifestRegistry =>
  ({
    get: vi.fn((slug: string) =>
      slug === embedManifest.slug ? embedManifest : slug === chatManifest.slug ? chatManifest : undefined),
  }) as unknown as ManifestRegistry;

const embeddingsOnlyConfig = {
  embeddings_slot: { provider: 'openai', model: 'text-embedding-3-small', api_key: 'sk' },
} as unknown as LLMConfig;
const chatConfig = {
  slot_1: { provider: 'openai', model: 'gpt-4.1-mini', api_key: 'sk' },
} as unknown as LLMConfig;
const quota = { tag: 'q' } as unknown as QuotaTracker;

beforeEach(() => {
  vi.clearAllMocks(); // resets call history; keeps the vi.fn implementations
});

describe('createServerExecutor — core-ai-embed routing (D-174 R28)', () => {
  it('routes a core-ai-embed step (output.vector) to executeEmbedding, NOT executeLLM', async () => {
    const executor = createServerExecutor({
      manifests: registry(),
      llmConfig: embeddingsOnlyConfig,
      llmQuota: quota,
    });
    await executor('core-ai-embed', { 'llm.data': 'hello' });

    expect(llmMocks.executeEmbedding).toHaveBeenCalledTimes(1);
    expect(llmMocks.executeLLM).not.toHaveBeenCalled();
    const call = llmMocks.executeEmbedding.mock.calls[0] as unknown[];
    // raw input passed through (embeddings takes the text llm.data, not the
    // chat file-ref-resolved/multimodal content parts).
    expect(call[1]).toEqual({ 'llm.data': 'hello' });
    // dispatched against the embeddings adapter registry + the live config.
    const opts = call[2] as { adapters: unknown; config: unknown };
    expect(opts.adapters).toEqual({ tag: 'embeddings-adapters' });
    expect(opts.config).toBe(embeddingsOnlyConfig);
  });

  it('routes a chat core-ai-* step to executeLLM, NOT executeEmbedding', async () => {
    const executor = createServerExecutor({
      manifests: registry(),
      llmConfig: chatConfig,
      llmQuota: quota,
    });
    await executor('core-ai-summarize', { 'llm.data': 'text' });

    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
    expect(llmMocks.executeEmbedding).not.toHaveBeenCalled();
  });

  it('reads config PER-USE via resolveLlmConfig (live), not the boot llmConfig snapshot', async () => {
    // Boot llmConfig has NO embeddings slot; the live resolver supplies it —
    // proving a slot saved after boot is picked up without a restart.
    const resolveLlmConfig = vi.fn(() => embeddingsOnlyConfig);
    const executor = createServerExecutor({
      manifests: registry(),
      llmConfig: chatConfig, // boot snapshot — no embeddings_slot
      resolveLlmConfig,
      llmQuota: quota,
    });
    await executor('core-ai-embed', { 'llm.data': 'hi' });

    expect(resolveLlmConfig).toHaveBeenCalled();
    const opts = (llmMocks.executeEmbedding.mock.calls[0] as unknown[])[2] as { config: unknown };
    expect(opts.config).toBe(embeddingsOnlyConfig);
  });

  it('wires the ai adapter even with NO chat slot_1 (embeddings-only config) — boot gate dropped', async () => {
    // Pre-D-174 the `slot_1` boot gate left the adapter undefined for an
    // embeddings-only config; now core-ai-embed still executes.
    const executor = createServerExecutor({
      manifests: registry(),
      llmConfig: embeddingsOnlyConfig, // no slot_1
      llmQuota: quota,
    });
    await executor('core-ai-embed', { 'llm.data': 'hi' });
    expect(llmMocks.executeEmbedding).toHaveBeenCalledTimes(1);
  });

  it('rejects (no silent dispatch) when no LLM config resolves — adapter present, fails per-call', async () => {
    const executor = createServerExecutor({
      manifests: registry(),
      llmConfig: undefined,
      resolveLlmConfig: () => undefined,
      llmQuota: quota,
    });
    // The adapter IS wired (gate dropped); it fails per-call rather than the
    // engine reporting a missing adapter — so embeddings never dispatches.
    await expect(executor('core-ai-embed', { 'llm.data': 'hi' })).rejects.toThrow();
    expect(llmMocks.executeEmbedding).not.toHaveBeenCalled();
  });
});
