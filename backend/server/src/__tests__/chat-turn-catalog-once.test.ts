/** D-347 slice C follow-up (2026-11-08) — a turn's setup reads its catalog's entries once. It read them
 *  for the catalog and again for each toolkit it lists (and the named pages, and the budget fit), and
 *  each read listed every recipe, twice over: measured 780 entries at 0.2 to 1.1 s a listing, the largest
 *  share of a turn's work before its first model call. Through the REAL orchestrator and chat store, as
 *  `d-345-http-toolkit-listed.test.ts` runs a turn; each read is counted where it starts, at the owner's
 *  catalog (`tier2OwnerCatalog`, null here so the registry's own entries stand). */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, RecuedServerSignature, ToolEntry } from '@recued/contracts';

import { createChatOrchestrator, type ChatAiCallOptions, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { wrapRegistryWithToolsSearch } from '../chat-tools-search.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const recipe = (slug: string): ToolEntry => ({ name: `recued-core/${slug}`, tier: 2, description: `Use “${slug}” in Recued.`,
  arg_schema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] }, topic_tags: [],
  classification: 'read', risk_tier: 'read', concurrency_safe: true });
const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const signature: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'test' };
type Packet = { available_tools: Array<{ recipe_slug: string; args_schema?: unknown }> };

/** A conversation with a Browser Bridge connected: each turn of `message` gives its first packet and how
 *  many times its setup read the catalog's entries. */
const conversation = (all: ToolEntry[]) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 's1', now: NOW - 10_000 });
  const packets: Packet[] = [];
  const callOptions: Array<ChatAiCallOptions | undefined> = [];
  const reply: AIOutput = { response: 'Done.', events: [], tool_calls: [] };
  const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput, opts) => {
    packets.push(JSON.parse(aiInput['llm.prompt'] as string) as Packet);
    callOptions.push(opts);
    return { body: reply };
  });
  const inner: InternalToolRegistry = {
    list: () => all, listByTier: (tier) => all.filter((e) => e.tier === tier),
    getByName: (name) => all.find((e) => e.name === name) ?? null,
    dispatch: vi.fn(), subscribeRefresh: () => () => undefined,
  };
  let reads = 0;
  const orchestrator = createChatOrchestrator({ chatStore: store, registry: wrapRegistryWithToolsSearch(inner, { enabled: true }),
    selfSignature: signature, executeAiCall, now: () => NOW, catalogProjection: { mode: 'lean-core' },
    namedPagesReadable: async (_session: string, addresses: readonly string[]) => addresses,
    browserBridgeConnected: () => true, tier2OwnerCatalog: () => { reads += 1; return null; } } as never);
  return {
    turn: async (message: string) => {
      reads = 0;
      await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' }, message } as never);
      return { packet: packets.at(-1)!, reads, callOptions: callOptions.at(-1) };
    },
    close: () => db.close(),
  };
};
const listed = (packet: Packet, name: string) => packet.available_tools.find((tool) => tool.recipe_slug === name);

describe('a turn reads its catalog\'s entries once', () => {
  it('for the catalog and both toolkits it lists, a Bridge connected and an address named', async () => {
    const http = ['read-web-address', 'get-web-address', 'download-web-file'].map(recipe);
    const c = conversation([...http, recipe('inspect-web-page')]);
    try {
      const { packet, reads, callOptions } = await c.turn('What does https://example.com/plans say about the Pro plan?');
      // The shared entries reached every reader: the HTTP Toolkit is listed in full.
      for (const tool of http) expect(listed(packet, tool.name), tool.name).toHaveProperty('args_schema', tool.arg_schema);
      expect(reads).toBe(1);
      expect(callOptions?.browser_action_mode).toBe(true);
    } finally { c.close(); }
  });

  it('and the next turn reads them afresh: a recipe added between turns is listed', async () => {
    const all = [recipe('read-web-address'), recipe('get-web-address')];
    const c = conversation(all);
    try {
      const first = await c.turn('What does https://example.com/plans say?');
      expect(first.callOptions?.browser_action_mode).toBeUndefined();
      expect(listed(first.packet, 'recued-core/download-web-file')).toBeUndefined();
      all.push(recipe('download-web-file'));
      const second = await c.turn('And https://example.com/pricing?');
      expect(listed(second.packet, 'recued-core/download-web-file')).toHaveProperty('args_schema');
      expect(second.reads).toBe(1);
    } finally { c.close(); }
  });
});
