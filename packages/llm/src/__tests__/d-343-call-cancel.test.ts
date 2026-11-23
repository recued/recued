/** D-343 (the owner, 2026-11-14: "stop the quick follow-ups from waiting") — a model call its caller
 *  cancels ends at once: the provider request is aborted and reads "LLM call was cancelled" (not a
 *  timeout, even with a timer set), and the executor tries no other provider for it and marks no
 *  source as limited. A newer chat turn cancels the closing brief it takes over this way. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import { callProvider } from '../adapters/anthropic.js';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import { LLMError, type LLMAdapter, type LLMConfig } from '../types.js';

afterEach(() => { vi.unstubAllGlobals(); });

const manifest: IngredientManifest = { slug: 'ai-classify', name: 'Classify', description: 'Classifier', author: 'recued', kind: 'ai',
  category: 'ai', risk_tier: 'read', input: {}, output: {} };
const config: LLMConfig = { slot_1: { provider: 'openai', model: 'a', api_key: 'k' }, slot_2: { provider: 'openai', model: 'b', api_key: 'k' } };

describe('D-343 — a model call its caller cancels', () => {
  it('ends the provider request at once, as cancelled rather than timed out', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })));
    const cancel = new AbortController();
    const pending = callProvider('https://provider.test/v1/chat', {}, {}, 60_000, cancel.signal);
    cancel.abort();
    await expect(pending).rejects.toMatchObject({ code: 'AI_TIMEOUT', message: 'LLM call was cancelled' });
  });

  it('tries no other provider and marks no source limited', async () => {
    const cancel = new AbortController();
    const adapter: LLMAdapter = { provider: 'openai', complete: vi.fn(async () => {
      cancel.abort();
      throw new LLMError('AI_TIMEOUT', 'LLM call was cancelled', undefined, true);
    }) };
    const quota = createQuotaTracker();
    await expect(executeLLM(manifest, { 'llm.data': 'hi', 'llm.categories': ['a'] },
      { config, adapters: () => adapter, quota, tabProbe: async () => new Set<WebChatTab>(), signal: cancel.signal }))
      .rejects.toMatchObject({ message: 'LLM call was cancelled' });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(quota.isInCooldown('slot_1')).toBe(false);
    // Cancelled before it starts: no request at all.
    const before = { provider: 'openai', complete: vi.fn() } as unknown as LLMAdapter;
    await expect(executeLLM(manifest, { 'llm.data': 'hi', 'llm.categories': ['a'] },
      { config, adapters: () => before, quota, tabProbe: async () => new Set<WebChatTab>(), signal: cancel.signal }))
      .rejects.toMatchObject({ message: 'LLM call was cancelled' });
    expect(before.complete).not.toHaveBeenCalled();
  });
});
