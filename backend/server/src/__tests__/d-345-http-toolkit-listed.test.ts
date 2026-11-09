/** D-345 slice D — a request that names a web address lists the HTTP Toolkit in full, Bridge or not:
 *  the server reads a public address faster than a tab, and finding the recipes by `tools.search`
 *  would cost a round. Through the REAL orchestrator and chat store, as the browsing-catalog test runs
 *  a turn. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, RecuedServerSignature, ToolEntry } from '@recued/contracts';

import { createChatOrchestrator, HTTP_TOOLKIT_LISTED_NOTE, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { wrapRegistryWithToolsSearch } from '../chat-tools-search.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const MAIL_SEARCH: ToolEntry = { name: 'mail.search', tier: 1, description: 'Search the owner\'s mail mirror.',
  arg_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  topic_tags: ['mail'], classification: 'read', concurrency_safe: true };
const recipe = (slug: string): ToolEntry => ({ name: `recued-core/${slug}`, tier: 2, description: `Use “${slug}” in Recued.`,
  arg_schema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] }, topic_tags: [],
  classification: 'read', risk_tier: 'read', concurrency_safe: true });
const HTTP = ['read-web-address', 'get-web-address', 'download-web-file'].map(recipe);
const OTHER = recipe('summarize-pdf-pdftotext');

const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const signature: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'test' };
type Packet = { available_tools: Array<{ recipe_slug: string; args_schema?: unknown }>; in_flight_context?: string };

/** The first packet of one turn of `message`, with no Browser Bridge connected. */
const firstPacket = async (message: string): Promise<Packet> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 's1', now: NOW - 10_000 });
    const packets: Packet[] = [];
    const reply: AIOutput = { response: 'Done.', events: [], tool_calls: [] };
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
      packets.push(JSON.parse(aiInput['llm.prompt'] as string) as Packet);
      return { body: reply };
    });
    const all = [MAIL_SEARCH, ...HTTP, OTHER];
    const inner: InternalToolRegistry = {
      list: () => all, listByTier: (tier) => all.filter((e) => e.tier === tier),
      getByName: (name) => all.find((e) => e.name === name) ?? null,
      dispatch: vi.fn(), subscribeRefresh: () => () => undefined,
    };
    const orchestrator = createChatOrchestrator({ chatStore: store, registry: wrapRegistryWithToolsSearch(inner, { enabled: true }),
      selfSignature: signature, executeAiCall, now: () => NOW, catalogProjection: { mode: 'lean-core' },
      browserBridgeConnected: () => false } as never);
    await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' }, message } as never);
    return packets[0]!;
  } finally {
    db.close();
  }
};
const listed = (packet: Packet, name: string) => packet.available_tools.find((tool) => tool.recipe_slug === name);

describe('D-345 slice D — the HTTP Toolkit on a turn that names a web address', () => {
  it('lists its three recipes with their arguments, and says what they are for, with no Bridge connected', async () => {
    const packet = await firstPacket('What does https://example.com/plans say about the Pro plan?');
    for (const tool of HTTP) expect(listed(packet, tool.name), tool.name).toHaveProperty('args_schema', tool.arg_schema);
    expect(listed(packet, OTHER.name)).toBeUndefined();
    expect(packet.in_flight_context).toContain(HTTP_TOOLKIT_LISTED_NOTE);
  });

  it('lists none of them for a request that names no address', async () => {
    const packet = await firstPacket('What is the Pro plan?');
    for (const tool of HTTP) expect(listed(packet, tool.name), tool.name).toBeUndefined();
    expect(packet.in_flight_context ?? '').not.toContain(HTTP_TOOLKIT_LISTED_NOTE);
  });
});
