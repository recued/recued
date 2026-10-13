/** D-323 — through the real orchestrator: a turn whose last `tools.search`
 *  offered marketplace packs carries them on its answer, stored and broadcast;
 *  a turn whose last search offered none carries none. The model is scripted;
 *  the search result is what `tools.search` returns on a no-match. A turn whose
 *  recipe was refused for a pack not installed carries that pack, through the
 *  real chat-registry wrapper. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  InternalToolRegistry,
  RecuedServerSignature,
  ToolEntry,
} from '@recued/contracts';

import {
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { wrapRegistryWithNeededPackOffers } from '../install-offers/needed-packs.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' };
const OFFER = { kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent'] };

const searchTool: ToolEntry = {
  name: 'tools.search', tier: 1, description: 'find tools', arg_schema: { type: 'object' },
  topic_tags: ['tool'], classification: 'read', concurrency_safe: true,
};

const registry = (results: ChatDispatchResult[]): InternalToolRegistry => {
  let call = 0;
  return {
    list: () => [searchTool],
    listByTier: (tier) => (tier === 1 ? [searchTool] : []),
    getByName: (name) => (name === searchTool.name ? searchTool : null),
    dispatch: async () => results[Math.min(call++, results.length - 1)]!,
    subscribeRefresh: () => () => undefined,
  };
};

/** The model searches as many times as it is given queries, then answers. */
const model = (queries: string[]): ExecuteChatAiCall => {
  let calls = 0;
  return async () => {
    calls += 1;
    const query = queries[calls - 1];
    const body: AIOutput = query !== undefined
      ? { response: '', events: [], tool_calls: [{ tool: 'tools.search', args: { query } }] }
      : { response: 'Nothing installed collects rent. Rental Book would.', events: [], tool_calls: [] };
    return { body };
  };
};

const noMatch = (installable?: unknown[]): ChatDispatchResult => ({
  ok: true,
  result: { query: 'rent collection', match_count: 0, matches: [], ...(installable ? { installable } : {}), guidance: '…' },
});

let store: ChatStore;
let events: BroadcastChatEvent[];
beforeEach(() => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  events = [];
});

const turn = async (results: ChatDispatchResult[], queries: string[]) => {
  let n = 0;
  const orchestrator = createChatOrchestrator({
    chatStore: store,
    registry: registry(results),
    broadcast: { emit: (event) => events.push(event) },
    selfSignature: signature,
    mintId: () => `id-${String(++n)}`,
    executeAiCall: model(queries),
  });
  store.createSession({ id: 's', now: 1_000 });
  await orchestrator.runTurn({ session_id: 's', message: 'collect the rent', picker_state: { current: 'self' } });
  const messages = await store.listMessages('s');
  return messages.find((message) => message.role === 'assistant');
};

describe('the answer to a turn that searched', () => {
  it('carries the offers its search made, stored and broadcast', async () => {
    const answer = await turn([noMatch([OFFER])], ['rent collection']);
    expect(answer?.install_offers).toEqual([OFFER]);
    const complete = events.find((event) => event.kind === 'chat.message_complete');
    expect((complete as { final?: { install_offers?: unknown } } | undefined)?.final?.install_offers).toEqual([OFFER]);
  });

  it('⛔ carries none when a later search offered none', async () => {
    const answer = await turn([noMatch([OFFER]), noMatch()], ['rent collection', 'rental']);
    expect(answer).toBeDefined();
    expect(answer).not.toHaveProperty('install_offers');
  });

  it('carries none when its search offered none', async () => {
    const answer = await turn([noMatch()], ['quantum blockchain']);
    expect(answer).not.toHaveProperty('install_offers');
  });
});

const DOCLING = { kind: 'pack' as const, slug: 'docling', name: 'Docling', publisher: 'recued-core', recipes: [] };
const recipeTool: ToolEntry = {
  name: 'recued-core/parse-a-pdf', tier: 2, description: 'Parse a PDF', arg_schema: { type: 'object' },
  topic_tags: ['documents'], classification: 'read', concurrency_safe: false,
};
/** The recipe tool, refused as the chat tools now return it: the run's sentence
 *  and its packs as data. */
const refusingRegistry = (): InternalToolRegistry => ({
  list: () => [recipeTool],
  listByTier: (tier) => (tier === 2 ? [recipeTool] : []),
  getByName: (name) => (name === recipeTool.name ? recipeTool : null),
  dispatch: async () => ({
    ok: false,
    reason: 'execution_error',
    detail: "Recipe 'parse-a-pdf' needs a pack that is not installed: recued-core.docling. Install it and run again.",
    missing_packs: ['recued-core.docling'],
  }),
  subscribeRefresh: () => () => undefined,
});

describe('the answer to a turn whose recipe needed a pack not installed', () => {
  it('carries the pack, stored and broadcast, and the model read only that it is a link', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    let calls = 0;
    let n = 0;
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry: wrapRegistryWithNeededPackOffers(refusingRegistry(), { offers: async () => [DOCLING] }),
      broadcast: { emit: (event) => events.push(event) },
      selfSignature: signature,
      mintId: () => `id-${String(++n)}`,
      executeAiCall: async (_manifest, input) => {
        inputs.push(input);
        calls += 1;
        const body: AIOutput = calls === 1
          ? { response: '', events: [], tool_calls: [{ tool: recipeTool.name, args: {} }] }
          : { response: 'That recipe needs the Docling pack. Install it from the link below.', events: [], tool_calls: [] };
        return { body };
      },
    });
    store.createSession({ id: 's', now: 1_000 });
    await orchestrator.runTurn({ session_id: 's', message: 'read this pdf', picker_state: { current: 'self' } });
    const answer = (await store.listMessages('s')).find((message) => message.role === 'assistant');
    expect(answer?.install_offers).toEqual([DOCLING]);
    const complete = events.find((event) => event.kind === 'chat.message_complete');
    expect((complete as { final?: { install_offers?: unknown } } | undefined)?.final?.install_offers).toEqual([DOCLING]);
    // The model's next main-turn call, which carries the refused call back to
    // it, reads the refusal's sentence and then the link's. The calls after it
    // compress the turn's context and read the same. None of them, ever, reads
    // the host's fields beside it.
    const told = inputs.map((input) => JSON.stringify(input)).filter((input) => input.includes('recued-core.docling'));
    expect(told.length).toBeGreaterThan(0);
    expect(told[0]).toContain('not installed: recued-core.docling. Install it and run again.');
    expect(told[0]).toContain('as a link under your answer');
    for (const input of inputs.map((each) => JSON.stringify(each))) {
      expect(input).not.toContain('install_offers');
      expect(input).not.toContain('missing_packs');
    }
    // ⛔ The owner's activity row, live and stored: the call failed, in the
    // refusal's own words. The model's sentence never reaches the owner (live,
    // 2026-10-13, the first cut put it in the row).
    const refusal = "Recipe 'parse-a-pdf' needs a pack that is not installed: recued-core.docling. Install it and run again.";
    const completed = events.find((event) => event.kind === 'chat.tool_call_completed'
      && (event as { tool_name?: string }).tool_name === recipeTool.name);
    expect(completed).toMatchObject({ status: 'error', detail: refusal });
    expect(answer?.tool_calls?.find((call) => call.tool_name === recipeTool.name))
      .toMatchObject({ status: 'error', detail: refusal });
  });
});
