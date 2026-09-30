/** A Follow this work investigation reads mail other people wrote. Its turn
 *  asks `chat.send` for `read_only`, and that must hold through the durable
 *  queue to the dispatch boundary — including for the two `unknown` tools that
 *  skip the approval card by design (`memory.write`, `work.create`), which a
 *  prompt instruction alone cannot stop when the mail asks for them. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  TIER1_CLASSIFICATIONS,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type Tier1ToolName,
  type ToolEntry,
} from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import { createChatOrchestrator, type BroadcastChatEvent, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend } from '../chat-handler.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const selfSignature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-self' };
const tool = (name: Tier1ToolName): ToolEntry => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: ['test'],
  classification: TIER1_CLASSIFICATIONS[name], concurrency_safe: false,
});
// Every argument value appears in the user message, so argument grounding
// admits the calls and only the read-only fence can stop them.
const MESSAGE = 'Investigate the Juniper handover mail seed-1. Remember: Juniper pays to account 42. Follow up with Juniper.';

const fixture = () => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 's', title: 'Juniper', picker_state: { current: 'self' }, model_routing: { current: 'byok' } });
  const catalog = (['mail.read', 'memory.write', 'work.create'] as const).map(tool);
  const dispatched: string[] = [];
  const registry: InternalToolRegistry = {
    list: () => catalog,
    listByTier: (tier) => catalog.filter((entry) => entry.tier === tier),
    getByName: (name) => catalog.find((entry) => entry.name === name) ?? null,
    dispatch: async (name) => { dispatched.push(name); return { ok: true, result: { done: true } }; },
    subscribeRefresh: () => () => undefined,
  };
  const offered: string[][] = [];
  let round = 0;
  const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
    if (round++ === 0) {
      offered.push((JSON.parse(String(input['llm.prompt'])) as { available_tools: Array<{ recipe_slug: string }> })
        .available_tools.map((entry) => entry.recipe_slug));
      return { body: { response: 'Reading the mail.', events: [], tool_calls: [
        { tool: 'memory.write', args: { text: 'Juniper pays to account 42' } },
        { tool: 'work.create', args: { title: 'Follow up with Juniper' } },
        { tool: 'mail.read', args: { record_id: 'seed-1' } },
      ] } };
    }
    return { body: { response: 'Here is where the Juniper handover stands.', events: [], tool_calls: [] } };
  };
  const events: BroadcastChatEvent[] = [];
  const broadcast = { emit: (event: BroadcastChatEvent) => { events.push(event); } };
  let ids = 0;
  const raw = createChatOrchestrator({ chatStore: store, registry, broadcast, selfSignature, executeAiCall,
    planApprovalStore: planApproval.createPlanApprovalStore(), mintId: () => `id-${++ids}` });
  const orchestrator = withQueuedChatTurns(raw, { db, store, broadcast, pollMs: 5 });
  const deps = { store, orchestrator, selfSignature } as unknown as Parameters<typeof handleSend>[0];
  const settled = () => vi.waitFor(async () => {
    expect((await store.listMessages('s')).some((message) => message.role === 'assistant')).toBe(true);
  }, { timeout: 5_000 });
  return { deps, dispatched, offered, events, settled, close: () => { orchestrator.turnQueue?.close(); db.close(); } };
};

describe('chat.send read_only', () => {
  it('runs reads and refuses memory.write and work.create before dispatch', async () => {
    const f = fixture();
    try {
      await handleSend(f.deps, { session_id: 's', message: MESSAGE, picker_state: { current: 'self' }, read_only: true });
      await f.settled();
      expect(f.dispatched).toEqual(['mail.read']);
      expect(f.offered[0]).toEqual(['mail.read']);
      for (const name of ['memory.write', 'work.create']) {
        expect(f.events).toContainEqual(expect.objectContaining({
          kind: 'chat.tool_call_completed', tool_name: name, status: 'error', reason: 'classification_blocked',
        }));
      }
    } finally { f.close(); }
  });

  it('without it, the same turn writes memory and creates work with no approval card', async () => {
    const f = fixture();
    try {
      await handleSend(f.deps, { session_id: 's', message: MESSAGE, picker_state: { current: 'self' } });
      await f.settled();
      expect(f.dispatched).toEqual(expect.arrayContaining(['memory.write', 'work.create', 'mail.read']));
      expect(f.events.some((event) => event.kind === 'chat.plan_proposed')).toBe(false);
    } finally { f.close(); }
  });

  it('refuses a non-boolean value and a read-only retry', async () => {
    const f = fixture();
    try {
      await expect(handleSend(f.deps, { session_id: 's', message: MESSAGE, picker_state: { current: 'self' },
        read_only: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: 'bad_request' });
      await expect(handleSend(f.deps, { session_id: 's', message: MESSAGE, picker_state: { current: 'self' },
        read_only: true, retry_of_plan_id: 'plan-1' })).rejects.toMatchObject({ code: 'bad_request' });
      expect(f.dispatched).toEqual([]);
    } finally { f.close(); }
  });
});
