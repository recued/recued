/** D-335 slice AK — the pages a request names, read before its first round. browser-use opens the
 *  address in its task before its first model call; Recued's first round saw only the request and
 *  spent itself asking for a read. Through the REAL orchestrator and chat store: which pages are
 *  read, that the first packet holds them as calls already made, and that the turn records them. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, RecuedServerSignature, ToolEntry } from '@recued/contracts';

import { NAMED_PAGES_MAX, NAMED_PAGES_NOTE, namedPageAddresses, readableNamedPages } from '../chat-named-pages.js';
import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const PY = 'https://en.wikipedia.org/wiki/Python_(programming_language)';
const RUST = 'https://en.wikipedia.org/wiki/Rust_(programming_language)';
const GO = 'https://en.wikipedia.org/wiki/Go_(programming_language)';
const MAIN = 'https://en.wikipedia.org/wiki/Main_Page';
const HN = 'https://news.ycombinator.com/';

describe('D-335 slice AK — the addresses a request names', () => {
  it('takes each address as written, without the sentence\'s punctuation or a bracket it does not open', () => {
    // E's task A, as the drive asks it.
    expect(namedPageAddresses(`Using these three Wikipedia articles in my browser: ${PY}, ${RUST} and ${GO}, tell me who designed each.`))
      .toEqual([PY, RUST, GO]);
    expect(namedPageAddresses(`On Wikipedia (${MAIN}) in my browser, search for Ada Lovelace.`)).toEqual([MAIN]);
    expect(namedPageAddresses(`What is the top story on Hacker News (${HN}) right now?`)).toEqual([HN]);
    expect(namedPageAddresses(`Read ${MAIN}. Then [${HN}]!`)).toEqual([MAIN, HN]);
  });

  it('names a page once, reads at most three, and nothing that is not an http or https address', () => {
    expect(namedPageAddresses(`${MAIN} and again ${MAIN}#Featured and https://www.en.wikipedia.org/wiki/Main_Page/`)).toEqual([MAIN]);
    expect(namedPageAddresses(`${PY} ${RUST} ${GO} ${MAIN}`)).toHaveLength(NAMED_PAGES_MAX);
    expect(namedPageAddresses('mail me at mailto:ada@example.com, or ftp://files.example.com/notes, or www.example.com')).toEqual([]);
  });

  it('reads every page while the conversation\'s switch is on, else only those a tab shows', async () => {
    const listTabs = vi.fn(async () => [{ url: 'https://www.en.wikipedia.org/wiki/Main_Page/' }, { url: 'https://example.com/' }]);
    expect(await readableNamedPages([MAIN, HN], { requestPassLive: () => true, listTabs })).toEqual([MAIN, HN]);
    expect(listTabs).not.toHaveBeenCalled();
    expect(await readableNamedPages([MAIN, HN], { requestPassLive: () => false, listTabs })).toEqual([MAIN]);
    // A Bridge that cannot list them: no page is known open, so none is read.
    expect(await readableNamedPages([MAIN], { requestPassLive: () => false, listTabs: async () => undefined })).toEqual([]);
    expect(await readableNamedPages([MAIN], { requestPassLive: () => false, listTabs: async () => { throw new Error('gone'); } })).toEqual([]);
  });
  it('leaves browser choice to the owner even when a request pass is live', async () => {
    const listTabs = vi.fn(async () => [{ url: MAIN }]);
    expect(await readableNamedPages([MAIN], { connectedBridges: () => 2, requestPassLive: () => true, listTabs })).toEqual([]);
    expect(listTabs).not.toHaveBeenCalled();
  });
});

const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const signature: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'test' };
const entry = (name: string, tier: 1 | 2): ToolEntry => ({
  name, tier, description: `${name} does its work`, arg_schema: { type: 'object', properties: { page: { type: 'string' } } },
  topic_tags: [], classification: 'read', risk_tier: 'read', concurrency_safe: true,
});
const INSPECT = entry('kitchen/inspect-web-page', 2);
const outlineOf = (page: string) => ({ recipe_id: 'inspect-web-page', success: true,
  output: { render: [{ type: 'json', data: { page: `7:${page.length}`, url: page, title: 'A page', outline: `# A page\nThe top of ${page}` } }] } });

type Packet = { prior_tool_calls?: Array<{ tool_name: string; args: unknown; status: string; result?: unknown }>;
  in_flight_context?: string; browser_task_context?: { assessment: string } };

/** One turn of `message`, with the toolkit installed (`installed`) and a Bridge connected
 *  (`connected`); `readable` answers which addresses read without asking. */
const turn = async (message: string, options: { connected?: boolean; installed?: boolean; readable?: (addresses: readonly string[]) => readonly string[];
  continuation?: boolean } = {}) => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 's1', now: NOW - 10_000 });
    const packets: Packet[] = [];
    const order: string[] = [];
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
      order.push('model');
      packets.push(JSON.parse(aiInput['llm.prompt'] as string) as Packet);
      const calls = packets.at(-1)!.prior_tool_calls ?? [];
      const browser_task_progress = calls.length ? [{ requirement: message.slice(0, 240), status: 'confirmed',
        evidence: [{ call: 0, quote: `The top of ${(calls[0]!.args as { page: string }).page}` }] }] : undefined;
      return { body: { response: 'The top story is there.', events: [], tool_calls: [],
        ...(browser_task_progress ? { browser_task_progress } : {}) } satisfies AIOutput };
    });
    const all = [entry('mail.search', 1), ...(options.installed === false ? [] : [INSPECT])];
    const dispatch = vi.fn<InternalToolRegistry['dispatch']>(async (name, args) => {
      order.push(`${name} ${String((args as { page?: string }).page)}`);
      return { ok: true, result: outlineOf((args as { page: string }).page) } as never;
    });
    const registry: InternalToolRegistry = {
      list: () => all, listByTier: (tier) => all.filter((e) => e.tier === tier),
      getByName: (name) => all.find((e) => e.name === name) ?? null,
      dispatch, subscribeRefresh: () => () => undefined,
    };
    const asked = vi.fn(async (_session: string, addresses: readonly string[]) => (options.readable ?? ((a) => a))(addresses));
    const orchestrator = createChatOrchestrator({ chatStore: store, registry, selfSignature: signature, executeAiCall,
      now: () => NOW, catalogProjection: { mode: 'lean-core' }, browserBridgeConnected: () => options.connected ?? true,
      namedPagesReadable: asked } as never);
    await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' }, message,
      ...(options.continuation ? { continuation_of_turn_id: 't0' } : {}) } as never);
    const stored = (await store.listMessagePage('s1', 20)).messages;
    return { packet: packets[0]!, order, asked, stored };
  } finally {
    db.close();
  }
};

describe('D-335 slice AK — a request\'s pages, read before its first round', () => {
  it('reads the page the request names, so the first round holds it as a call already made, and is told so', async () => {
    const { packet, order, stored } = await turn(`What is the top story on Hacker News (${HN}) right now?`);
    // The read, then the first round; the turn's closing brief may call the model after its answer.
    expect(order.slice(0, 2)).toEqual([`kitchen/inspect-web-page ${HN}`, 'model']);
    expect(packet.prior_tool_calls).toEqual([expect.objectContaining({ tool_name: 'kitchen/inspect-web-page', args: { page: HN },
      status: 'ok' })]);
    expect(JSON.stringify(packet.prior_tool_calls![0]!.result)).toContain(`The top of ${HN}`);
    expect(packet.in_flight_context).toContain(NAMED_PAGES_NOTE);
    expect(packet.browser_task_context).toBeUndefined();
    expect(order.filter(item => item === 'model')).toHaveLength(1);
    // The turn's own call, stored with its answer as a model's call is.
    const answer = stored.find((m) => m.role === 'assistant');
    expect(answer?.tool_calls?.map((call) => call.tool_name)).toEqual(['kitchen/inspect-web-page']);
  });

  it('only adds the experimental completion contract when the owner explicitly enables it', async () => {
    vi.stubEnv('RECUED_BROWSER_TASK_COMPLETION', '1');
    try {
      const { packet, order } = await turn(`Read ${HN}`);
      expect(packet.browser_task_context?.assessment).toBe('model_selected_source_linked');
      expect(order.filter(item => item === 'model')).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reads three pages side by side, and no fourth', async () => {
    const { packet, order } = await turn(`Compare ${PY}, ${RUST}, ${GO} and ${MAIN}.`);
    expect(order.slice(0, 3).sort()).toEqual([`kitchen/inspect-web-page ${GO}`, `kitchen/inspect-web-page ${PY}`,
      `kitchen/inspect-web-page ${RUST}`]);
    expect(order[3]).toBe('model');
    expect(packet.prior_tool_calls!.map((call) => (call.args as { page: string }).page)).toEqual([PY, RUST, GO]);
  });

  it('reads only the pages that ask the owner nothing, and says nothing when none does', async () => {
    const some = await turn(`Compare ${PY} and ${RUST}.`, { readable: (addresses) => addresses.filter((a) => a === RUST) });
    expect(some.packet.prior_tool_calls!.map((call) => (call.args as { page: string }).page)).toEqual([RUST]);
    const none = await turn(`Compare ${PY} and ${RUST}.`, { readable: () => [] });
    expect(none.order).toEqual(['model']);
    expect(none.packet.prior_tool_calls ?? []).toEqual([]);
    expect(none.packet.in_flight_context ?? '').not.toContain(NAMED_PAGES_NOTE);
  });

  it('reads nothing with no Bridge connected, the toolkit not installed, no address, or on a continuation', async () => {
    for (const [message, options] of [
      [`Read ${HN}`, { connected: false }],
      [`Read ${HN}`, { installed: false }],
      ['What is on my Hacker News tab?', {}],
      [`Read ${HN}`, { continuation: true }],
    ] as const) {
      const { order, asked, packet } = await turn(message, options);
      expect(order, message).toEqual(['model']);
      expect(asked, message).not.toHaveBeenCalled();
      expect(packet.in_flight_context ?? '', message).not.toContain(NAMED_PAGES_NOTE);
    }
  });
});
