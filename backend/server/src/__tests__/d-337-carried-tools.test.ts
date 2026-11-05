/** D-337 slice W — a conversation carrying on after an approval starts with the recipe tools its
 *  request was using. Lean-core lists no recipe, and a model may call only one a search of its own
 *  request returned, so each continuation searched for the Browser Toolkit again (2 or 3
 *  `tools.search` rounds in every measured search run). Through the REAL orchestrator and chat
 *  store: the rows the request left, and the packet its continuation's model reads. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, InternalToolRegistry, RecuedServerSignature, ToolEntry } from '@recued/contracts';
import {
  CARRIED_TOOLS_LIMIT,
  CARRIED_TOOLS_NOTE,
  carryRecipeTools,
  createChatOrchestrator,
  renderToolRow,
  toolsOfTurn,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { heldResultCall } from '../chat-held-results.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const signature: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'test' };

const entry = (name: string, tier: 1 | 2, classification: 'read' | 'write' = 'read'): ToolEntry => ({
  name, tier, description: `${name} does its work`, arg_schema: { type: 'object', properties: { page: { type: 'string' } } },
  topic_tags: [], classification, risk_tier: classification, concurrency_safe: classification === 'read',
});
const CORE = entry('mail.search', 1);
const TABS = entry('kitchen/list-browser-tabs', 2);
const INSPECT = entry('kitchen/inspect-web-page', 2);
const TYPE = entry('kitchen/type-into-web-page', 2, 'write');
const CLICK = entry('kitchen/click-web-element', 2, 'write');
const OTHER = entry('kitchen/summarize-pdf', 2);

const searchRow = (slugs: readonly string[]) => renderToolRow('tools.search', { query: 'browser tabs' }, {
  ok: true, result: { query: 'browser tabs', match_count: slugs.length,
    matches: slugs.map((recipe_slug) => ({ recipe_slug, description: 'x', args_schema: {} })) },
});

const withStore = async <T>(run: (store: ReturnType<typeof createChatStore>) => Promise<T>): Promise<T> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 's1', now: NOW - 10_000 });
    return await run(store);
  } finally {
    db.close();
  }
};
const base = { session_id: 's1', target_server: 'self' as const, picker_at_send: { display_name: 'Self', signature },
  model_used: { provider: 'fixture', model_id: 'fixture' } };
/** The rows a request leaves: its answer naming its calls, and a row per call's result. */
const leaveRequest = async (store: ReturnType<typeof createChatStore>, turn_id: string, ts: number,
  calls: readonly string[], rows: readonly string[]) => {
  await store.appendMessage({ ...base, id: `${turn_id}:a`, role: 'assistant', content: 'Working on it.', turn_id, ts,
    tool_calls: calls.map((tool_name) => ({ tool_name, tier: 2 as const, args: {}, status: 'ok' as const, started_at: ts,
      completed_at: ts })) });
  for (const [index, content] of rows.entries()) {
    await store.appendMessage({ ...base, id: `${turn_id}:t${index}`, role: 'tool', content, turn_id, ts: ts + index + 1 });
  }
};

describe('D-337 slice W — the tools a request used, read from its rows', () => {
  it('the calls it made and the recipes its searches returned, in the order it met them; then the others, newest first', async () => {
    await withStore(async (store) => {
      await leaveRequest(store, 't0', NOW - 9_000, [OTHER.name], [renderToolRow(OTHER.name, {}, { ok: true })]);
      await leaveRequest(store, 't1', NOW - 5_000, ['tools.search', TABS.name, TYPE.name], [
        searchRow([TABS.name, INSPECT.name, TYPE.name, CLICK.name]),
        renderToolRow(TABS.name, {}, { ok: true, result: { tabs: [] } }),
        renderToolRow(TYPE.name, { page: '1:A', ref: 'e4' }, undefined),
      ]);
      expect(await toolsOfTurn(store, 's1', 't1')).toEqual([TABS.name, TYPE.name, INSPECT.name, CLICK.name, OTHER.name]);
      // A continuation of a continuation: the work its first request searched for comes after its own.
      await leaveRequest(store, 't2', NOW - 2_000, [CLICK.name], [renderToolRow(CLICK.name, { ref: 'e5' }, undefined)]);
      expect(await toolsOfTurn(store, 's1', 't2')).toEqual([CLICK.name, TABS.name, TYPE.name, INSPECT.name, OTHER.name]);
      expect(await toolsOfTurn(store, 's1', 't0')).toEqual([OTHER.name, CLICK.name, TABS.name, TYPE.name, INSPECT.name]);
    });
  });
});

describe('D-337 slice W — carried into the continuation\'s tools, from its own catalog', () => {
  const entries = [CORE, TABS, INSPECT, TYPE, CLICK, OTHER];
  const leanCore = [{ recipe_slug: CORE.name, args_schema: CORE.arg_schema }];

  it('lean-core: the recipes listed in full after the core tools, in the order the request met them', () => {
    const { tools, carried } = carryRecipeTools(leanCore, entries, [TABS.name, CLICK.name]);
    expect(carried).toBe(2);
    expect(tools).toEqual([...leanCore,
      { recipe_slug: TABS.name, args_schema: TABS.arg_schema, description: TABS.description },
      { recipe_slug: CLICK.name, args_schema: CLICK.arg_schema, description: CLICK.description }]);
  });

  it('only what the turn\'s own catalog holds: a recipe no longer granted, and a core tool, are not carried', () => {
    const granted = entries.filter((e) => e !== CLICK);
    expect(carryRecipeTools(leanCore, granted, [CLICK.name, CORE.name, 'kitchen/unknown']).carried).toBe(0);
    expect(carryRecipeTools(leanCore, granted, [CLICK.name, CORE.name, 'kitchen/unknown']).tools).toBe(leanCore);
  });

  it('index mode: a recipe listed by a line is listed in full in its place', () => {
    const index = [...leanCore, { recipe_slug: TABS.name, description: 'one line' }, { recipe_slug: OTHER.name, description: 'one line' }];
    const { tools, carried } = carryRecipeTools(index, entries, [TABS.name]);
    expect(carried).toBe(1);
    expect(tools.map((tool) => [tool.recipe_slug, tool.args_schema !== undefined])).toEqual([
      [CORE.name, true], [OTHER.name, false], [TABS.name, true]]);
  });

  it('at most the limit, and a read-only turn carries only reads', () => {
    const many = Array.from({ length: CARRIED_TOOLS_LIMIT + 5 }, (_, i) => entry(`kitchen/r${i}`, 2));
    expect(carryRecipeTools(leanCore, many, many.map((e) => e.name)).carried).toBe(CARRIED_TOOLS_LIMIT);
    expect(carryRecipeTools(leanCore, entries, [TABS.name, TYPE.name], (e) => e.classification === 'read').tools
      .map((tool) => tool.recipe_slug)).toEqual([CORE.name, TABS.name]);
  });
});

describe('D-337 slice W — the continuation\'s model reads them, and is told they are there', () => {
  const run = async (input: Record<string, unknown>, mode: 'lean-core' | 'full' = 'lean-core') => withStore(async (store) => {
    await leaveRequest(store, 't1', NOW - 5_000, ['tools.search', TABS.name, TYPE.name], [
      searchRow([TABS.name, INSPECT.name, TYPE.name, CLICK.name]),
      renderToolRow(TABS.name, {}, { ok: true, result: { tabs: [] } }),
    ]);
    const packets: Array<{ available_tools?: Array<{ recipe_slug: string; args_schema?: unknown }>; in_flight_context?: string }> = [];
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
      packets.push(JSON.parse(aiInput['llm.prompt'] as string) as (typeof packets)[number]);
      return { body: { response: 'Typed. Next I will click Search.', events: [], tool_calls: [] } satisfies AIOutput };
    });
    const all = [CORE, TABS, INSPECT, TYPE, CLICK, OTHER];
    const registry: InternalToolRegistry = {
      list: () => all, listByTier: (tier) => all.filter((e) => e.tier === tier),
      getByName: (name) => all.find((e) => e.name === name) ?? null,
      dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
      subscribeRefresh: () => () => undefined,
    };
    const orchestrator = createChatOrchestrator({ chatStore: store, registry, selfSignature: signature, executeAiCall,
      now: () => NOW, catalogProjection: { mode } } as never);
    await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' }, ...input } as never);
    return packets[0]!;
  });
  const continuing = {
    message: 'Approved: Type into a web page.',
    held_results: [heldResultCall({ session_id: 's1', turn_id: 't1', run_id: 'run-1', tool_name: TYPE.name, tier: 2,
      args: { page: '1:A', ref: 'e4' }, outcome: 'ran', result: { success: true }, called_at: NOW - 4_000, settled_at: NOW - 1_000 })],
    continuation_of_turn_id: 't1',
  };

  it('a continuation in lean-core lists the request\'s recipe tools in full, and says they are there', async () => {
    const packet = await run(continuing);
    const listed = packet.available_tools!.map((tool) => tool.recipe_slug);
    expect(listed).toEqual(expect.arrayContaining([TABS.name, TYPE.name, INSPECT.name, CLICK.name]));
    expect(listed).not.toContain(OTHER.name);
    expect(packet.available_tools!.filter((tool) => tool.recipe_slug.startsWith('kitchen/'))
      .every((tool) => tool.args_schema !== undefined)).toBe(true);
    expect(packet.in_flight_context).toContain(CARRIED_TOOLS_NOTE);
  });

  it('a message the owner sends is no continuation, and lists no recipe', async () => {
    const packet = await run({ message: 'and click Search' });
    expect(packet.available_tools!.map((tool) => tool.recipe_slug).filter((name) => name.startsWith('kitchen/'))).toEqual([]);
    expect(packet.in_flight_context ?? '').not.toContain(CARRIED_TOOLS_NOTE);
  });

  it('in full mode every recipe is listed already, and nothing is said of it', async () => {
    const packet = await run(continuing, 'full');
    expect(packet.in_flight_context ?? '').not.toContain(CARRIED_TOOLS_NOTE);
  });
});
