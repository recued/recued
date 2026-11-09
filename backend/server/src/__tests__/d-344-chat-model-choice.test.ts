/** D-344 slice C — the model the owner's chat runs on reaches the model calls of the recipes its turn
 *  runs, as a preference (`PreferredSource`, `@recued/llm`): the server executor's model calls made
 *  inside a turn's choice carry it, and none outside one. The owner: "user can always choose which
 *  model (the selected chat model) to perform such search". */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IngredientManifest } from '@recued/contracts';
import type { LLMConfig, QuotaTracker } from '@recued/llm';

import { chatModelChoiceOf, currentChatModelChoice, withChatModelChoice } from '../chat-model-choice.js';
import type { ManifestRegistry } from '../manifest-loader.js';
import { createServerExecutor } from '../server-executor.js';

const llm = vi.hoisted(() => ({ executeLLM: vi.fn(async () => ({ result: 'ok' })) }));
vi.mock('@recued/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/llm')>();
  return { ...actual, executeLLM: llm.executeLLM };
});

const summarize: IngredientManifest = { slug: 'core-ai-summarize', name: 'AI summarize', description: '', author: 'recued-core',
  kind: 'ai', category: 'ai', risk_tier: 'read', input: {}, output: { result: 'summary' } };
const executor = () => createServerExecutor({
  manifests: { get: vi.fn((slug: string) => (slug === summarize.slug ? summarize : undefined)) } as unknown as ManifestRegistry,
  llmConfig: { slot_1: { provider: 'openai', model: 'm', api_key: 'k' } } as unknown as LLMConfig,
  llmQuota: { tag: 'q' } as unknown as QuotaTracker,
});
/** What the last model call's match context said. */
const lastContext = () => {
  const deps = (llm.executeLLM.mock.calls.at(-1) as unknown[])[2] as { matchContext?: () => unknown };
  return deps.matchContext?.();
};

beforeEach(() => vi.clearAllMocks());

describe('D-344 slice C — a chat turn\'s model, preferred by its recipes\' model calls', () => {
  it('a turn on a slot, on the free pool, or on its own keys', () => {
    expect(chatModelChoiceOf('byok', 'slot_2')).toEqual({ pinSlot: 'slot_2' });
    expect(chatModelChoiceOf('free_pool', undefined)).toEqual({ layer: 'free' });
    // A free-pool turn drops a slot its session carries, as the chat's own call does.
    expect(chatModelChoiceOf('free_pool', 'slot_1')).toEqual({ layer: 'free' });
    expect(chatModelChoiceOf('byok', undefined)).toEqual({ layer: 'byok' });
    expect(chatModelChoiceOf(undefined, undefined)).toBeUndefined();
  });

  it('a model call inside the turn prefers the chat\'s model, through every wait', async () => {
    const run = executor();
    await withChatModelChoice({ pinSlot: 'slot_2' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentChatModelChoice()).toEqual({ pinSlot: 'slot_2' });
      await run('core-ai-summarize', { 'llm.data': 'text' });
    });
    expect(lastContext()).toEqual({ prefer: { pinSlot: 'slot_2' } });
  });

  it('one outside any turn prefers nothing', async () => {
    await executor()('core-ai-summarize', { 'llm.data': 'text' });
    expect(lastContext()).toBeUndefined();
    expect(currentChatModelChoice()).toBeUndefined();
  });
});

describe('D-344 slice C — through a real turn', () => {
  it('a tool the turn runs sees the turn\'s model, and nothing does once the turn is over', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { createChatOrchestrator } = await import('../chat-orchestrator.js');
    const { createChatStore, ensureChatSchema } = await import('../storage/chat-store.js');
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const store = createChatStore(db);
      store.createSession({ id: 's1', now: 1_000 });
      const seen: unknown[] = [];
      const entry = { name: 'kitchen/inspect-web-page', tier: 2 as const, description: 'reads a page',
        arg_schema: { type: 'object', properties: { page: { type: 'string' } } }, topic_tags: [], classification: 'read' as const,
        risk_tier: 'read' as const, concurrency_safe: true };
      const registry = {
        list: () => [entry], listByTier: (tier: number) => (tier === 2 ? [entry] : []),
        getByName: (name: string) => (name === entry.name ? entry : null),
        dispatch: vi.fn(async () => { seen.push(currentChatModelChoice()); return { ok: true, result: { outline: '# A page' } }; }),
        subscribeRefresh: () => () => undefined,
      };
      let calls = 0;
      const executeAiCall = vi.fn(async () => {
        calls += 1;
        return { body: calls === 1
          ? { response: '', events: [], tool_calls: [{ tool: entry.name, args: { page: '7:A' } }] }
          : { response: 'Read it.', events: [], tool_calls: [] } };
      });
      const orchestrator = createChatOrchestrator({ chatStore: store, registry,
        selfSignature: { server_kind: 'recued', version: '1', instance_id: 'test' }, executeAiCall, now: () => 2_000,
        catalogProjection: { mode: 'full' } } as never);
      await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' }, message: 'Read the page.',
        model_pref: { current: 'byok', source_id: 'slot_2' } } as never);
      expect(registry.dispatch).toHaveBeenCalled();
      expect(seen).toEqual([{ pinSlot: 'slot_2' }]);
      expect(currentChatModelChoice()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
