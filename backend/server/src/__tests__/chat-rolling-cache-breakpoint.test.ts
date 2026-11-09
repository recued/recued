/** D-347 slice C follow-up (2026-11-08) — a second Anthropic cache breakpoint after the last of a turn's
 *  calls, so a turn's next round reads them from the cache. Each round rebuilds one user message, and
 *  Anthropic finds a cached prefix only at a block boundary: the round after must hold a boundary where
 *  this round's breakpoint was. Through the REAL orchestrator and chat store with the model a stub, each
 *  round's input put through the LLM layer's own `buildUncontractedPrompt`. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { buildUncontractedPrompt } from '@recued/llm';

import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const tool = (name: string): ToolEntry => ({ name, tier: 1, description: `${name} for the test.`,
  arg_schema: { type: 'object', properties: {}, additionalProperties: false }, topic_tags: ['fixture'],
  concurrency_safe: true, classification: 'read' });

describe('a turn\'s rounds and the cache', () => {
  it('each round after the first marks a breakpoint after its last call, where the next round has a boundary', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const store = createChatStore(db);
      store.createSession({ id: 's1' });
      const catalog = [tool('fixture.first'), tool('fixture.second')];
      const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog,
        getByName: (name) => catalog.find((t) => t.name === name) ?? null, subscribeRefresh: () => () => {},
        dispatch: async (name) => ({ ok: true, result: { from: name, note: 'a ] } " [ { inside a value' } }) };
      const inputs: Array<Record<string, unknown>> = [];
      const plan = ['fixture.first', 'fixture.second'];
      const orchestrator = createChatOrchestrator({ chatStore: store, registry,
        selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' }, broadcast: { emit: () => {} },
        executeAiCall: async (_manifest, input) => {
          inputs.push(input as Record<string, unknown>);
          const next = plan[inputs.length - 1];
          return { body: { response: next === undefined ? 'Done.' : '', events: [],
            tool_calls: next === undefined ? [] : [{ tool: next, args: {} }] } };
        } });
      await orchestrator.runTurn({ session_id: 's1', message: 'Look both up.', picker_state: { current: 'self' } } as never);
      expect(inputs).toHaveLength(3);
      for (const input of inputs) expect(input['llm.cache_rolling_field']).toBe('prior_tool_calls');
      const blocks = inputs.map((input) => {
        const user = buildUncontractedPrompt(input).find((m) => m.role === 'user')!;
        return (user.content_parts ?? []).map((p) => ({ text: p.type === 'text' ? p.text : '', marked: p.type === 'text' && p.cache_breakpoint === true }));
      });
      // Round 1 holds no call yet: the catalog alone is marked.
      expect(blocks[0]!.filter((b) => b.marked)).toHaveLength(1);
      for (const round of [1, 2]) {
        const mine = blocks[round]!;
        expect(mine.filter((b) => b.marked)).toHaveLength(2);
        expect(mine.map((b) => b.text).join('')).toBe(String(inputs[round]!['llm.prompt']));
      }
      // Round 3 has a block boundary exactly where round 2 wrote its cache.
      const written = blocks[1]!.slice(0, blocks[1]!.map((b) => b.marked).lastIndexOf(true) + 1).map((b) => b.text).join('');
      const boundaries = blocks[2]!.map((_, i, all) => all.slice(0, i + 1).map((b) => b.text).join(''));
      expect(boundaries).toContain(written);
    } finally {
      db.close();
    }
  });
});
