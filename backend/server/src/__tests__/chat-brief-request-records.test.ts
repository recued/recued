/** The request records (`request_execution_context`) ride in every reader packet while the running note is on. The owner, 2026-11-18, "go ahead" on the audit's trims: they are re-read every round
 *  with a fresh `observed_at`, so they come after the retained history, where they do not invalidate the provider's
 *  reusable prefix; and the folds count them, since D-347's 80% is of the whole next packet. Each count is measured as
 *  a turn with the records against the same turn without them, so the system prompt is the same and the
 *  difference is the records alone. Turns through the real orchestrator and chat store, the model a stub, as
 *  d-347-turn-carry.test.ts runs them. */
import Database from 'better-sqlite3';
import { beforeEach, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

const NOTE = 'The retainer is 274 units. ' + 'Filler line of the account file. '.repeat(600);
const keyed: ToolEntry = { name: 'fixture.lookup', tier: 1, description: 'Look a value up by key.', classification: 'read',
  arg_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  topic_tags: ['fixture'], concurrency_safe: true };
const occurrences = (text: string, part: string): number => text.split(part).length - 1;

/** One owner turn: the model looks up `keys` one per round, each returning `result`, then answers. Without
 *  `records`, the store offers no records reader, so the turn carries none. */
const reads = async (keys: readonly string[], opts: { records?: boolean; budget?: number; result?: string } = {}) => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 's' });
  store.setRollingBriefEnabled(true);
  const chatStore = opts.records === false ? { ...store, readRequestEvidenceWindow: undefined } : store;
  const registry: InternalToolRegistry = { list: () => [keyed], listByTier: () => [keyed], getByName: (n) => (n === keyed.name ? keyed : null),
    subscribeRefresh: () => () => {}, dispatch: async () => ({ ok: true, result: { note: opts.result ?? NOTE } }) };
  const packets: Array<{ text: string; packet: Record<string, any> }> = [];
  const trail: string[] = [];
  let system = '', id = 0, last = 0;
  await createChatOrchestrator({ chatStore, registry, mintId: () => `id-${String(++id)}`, now: () => (last = Math.max(Date.now(), last + 1)),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'records' },
    ...(opts.budget !== undefined ? { resolveInputTokenBudget: () => opts.budget } : {}),
    broadcast: { emit: (event: any) => { if (event.kind === 'chat.transparency' && event.event?.kind === 'recued.rolling_brief.trail') trail.push(...(event.event.decisions ?? [])); } },
    executeAiCall: async (_manifest, input) => {
      const text = String(input['llm.prompt']); const packet = JSON.parse(text) as Record<string, any>;
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION) || 'tool_results_since' in packet) {
        throw new Error('These results ride raw: no brief runs');
      }
      packets.push({ text, packet }); system = String(input['llm.system_prompt']);
      const done = (packet.prior_tool_calls ?? []).filter((c: { tool_name: string }) => c.tool_name === keyed.name).length;
      return { body: done < keys.length ? { response: '', events: [], tool_calls: [{ tool: keyed.name, args: { key: keys[done] } }] }
        : { response: 'The retainer is 274 units.', events: [], tool_calls: [] } };
    },
  }).runTurn({ session_id: 's', message: 'Look the retainer up.', picker_state: { current: 'self' } } as never);
  db.close();
  const carried = trail.find((d) => d.startsWith('carried_raw:'));
  return { packets, system, trail, estimate: carried === undefined ? undefined : Number(/\((\d+) estimated tokens next/.exec(carried)?.[1]) };
};
const recordTokensOf = (packet: Record<string, any>): number => Math.floor(JSON.stringify(packet.request_execution_context).length / 2);

it('the request records ride after the retained history, as the browser context does', async () => {
  const t = await reads(['retainer'], { result: 'The retainer is 274 units.' });
  const withHistory = t.packets.find((p) => Array.isArray(p.packet.prior_tool_calls) && p.packet.request_execution_context !== undefined)!.packet;
  expect(withHistory).toBeDefined();
  const keys = Object.keys(withHistory);
  expect(keys.indexOf('prior_tool_calls')).toBeGreaterThan(-1);
  expect(keys.indexOf('request_execution_context')).toBeGreaterThan(keys.indexOf('prior_tool_calls'));
  expect(keys.indexOf('request_execution_context')).toBeGreaterThan(keys.indexOf('user_message'));
});

it('the closing estimate counts the request records with the rest of the next packet', async () => {
  const withRecords = await reads(['retainer'], { result: 'The retainer is 274 units.' });
  const without = await reads(['retainer'], { result: 'The retainer is 274 units.', records: false });
  expect(without.packets.at(-1)!.packet.request_execution_context).toBeUndefined();
  expect(withRecords.system).toBe(without.system);
  const recordTokens = recordTokensOf(withRecords.packets.at(-1)!.packet);
  expect(recordTokens).toBeGreaterThan(100);
  // Without the records counted the difference would be zero.
  expect(Math.abs(withRecords.estimate! - without.estimate! - recordTokens)).toBeLessThanOrEqual(20);
});

// ── A read's result rides once (2026-11-18, the owner's "do the remaining open items"). Measuring a long conversation
//    found the current request's read receipts carrying each result a second time: 35,336 characters against
//    17,516 on the same round, the closing fold counting the copy as next-turn content (it folded one file early),
//    and the copy coming first within the records' byte limit, ahead of the approval states.

it('a read\'s result rides once: in prior_tool_calls, and its receipt keeps the call alone', async () => {
  const t = await reads(['retainer']);
  const after = t.packets.at(-1)!;
  expect(after.packet.prior_tool_calls.some((c: { tool_name: string }) => c.tool_name === keyed.name)).toBe(true);
  expect(occurrences(after.text, NOTE)).toBe(1);
  const receipts = after.packet.request_execution_context.successful_calls_for_current_request;
  expect(receipts).toEqual([expect.objectContaining({ tool_name: keyed.name, args: { key: 'retainer' } })]);
  expect(receipts[0]).not.toHaveProperty('result');
});

it('the closing estimate counts a large read once', async () => {
  const withRecords = await reads(['retainer']), without = await reads(['retainer'], { records: false });
  expect(without.estimate!).toBeGreaterThan(NOTE.length / 2);
  const recordTokens = recordTokensOf(withRecords.packets.at(-1)!.packet);
  // The records are the request and its call, never the result again (which alone is ~10,000 estimated tokens).
  expect(recordTokens).toBeLessThan(1000);
  expect(Math.abs(withRecords.estimate! - without.estimate! - recordTokens)).toBeLessThanOrEqual(20);
});

it('the mid-turn check counts the request records with the system prompt', async () => {
  // Three reads in one turn reach the check's minimum; the budget is learned so its trigger is a number.
  const withRecords = await reads(['a', 'b', 'c'], { budget: 1_000_000 });
  const without = await reads(['a', 'b', 'c'], { budget: 1_000_000, records: false });
  const trigger = (trail: readonly string[]) => Number(/trigger (\d+)/.exec(trail.find((d) => d.startsWith('not_triggered:'))!)?.[1]);
  const wt = trigger(withRecords.trail), nt = trigger(without.trail);
  expect(Number.isFinite(wt) && Number.isFinite(nt)).toBe(true);
  // Checked after the third read, against the records the third round's packet carried.
  const recordTokens = recordTokensOf(withRecords.packets[2]!.packet);
  expect(recordTokens).toBeGreaterThan(100);
  expect(Math.abs(nt - wt - recordTokens)).toBeLessThanOrEqual(20);
});

// 2026-11-20 (the owner: "go ahead, take slice 4 too, but ... a correct solution that happens to be lower"): a browser
// call's receipt keeps what ran and how it ended, and not the pages it read. After a fold, those pages were where the
// model found an earlier page's ref to click (recued-bridge-vs-browser-use/results/analysis/2026-11-20-P-four-way-handoff-386igzlf).
it('a browser act\'s receipt keeps what ran and how it ended, and its pages ride only in the turn\'s history', async () => {
  const act: ToolEntry = { name: 'recued-core/act-on-web-page', tier: 1, description: 'Act on web pages.', classification: 'write',
    arg_schema: { type: 'object', properties: { page: { type: 'string' } }, additionalProperties: true }, topic_tags: ['browser'],
    concurrency_safe: false };
  const PAGE = '[button: Edit](e43) Bench stock review ' + 'A line of the notes page. '.repeat(200);
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db); store.createSession({ id: 'b' }); store.setRollingBriefEnabled(true);
  const registry: InternalToolRegistry = { list: () => [act], listByTier: () => [act], getByName: (n) => (n === act.name ? act : null),
    subscribeRefresh: () => () => {}, dispatch: async () => ({ ok: true, result: { success: true, recipe_id: 'act-on-web-page',
      browser_state: { action_status: 'acknowledged', check_status: 'passed', view: { page: 'p-1', outline: PAGE } },
      output: { render: [{ type: 'json', data: { page: 'p-1', steps: ['1. clicked e5'], tabs: [{ page: 'p-1', reads: [{ step: 2, outline: PAGE }] }] } }],
        sidebar: [{ type: 'json', data: { tabs: [{ page: 'p-1', reads: [{ step: 2, outline: PAGE }] }] } }] } } }) };
  const packets: Array<{ text: string; packet: Record<string, any> }> = [];
  let id = 0, last = 0, calls = 0;
  await createChatOrchestrator({ chatStore: store, registry, mintId: () => `id-${String(++id)}`, now: () => (last = Math.max(Date.now(), last + 1)),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'browser-records' }, broadcast: { emit: () => {} },
    executeAiCall: async (_manifest, input) => {
      const text = String(input['llm.prompt']); const packet = JSON.parse(text) as Record<string, any>;
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION) || 'tool_results_since' in packet) {
        return { body: { intent: 'Edit the note', constraints: [], pending: [], findings: [] } };
      }
      packets.push({ text, packet });
      return { body: calls++ === 0 ? { response: '', events: [], tool_calls: [{ tool: act.name, args: { page: 'p-1' } }] }
        : { response: 'Saved.', events: [], tool_calls: [] } };
    },
  }).runTurn({ session_id: 'b', message: 'Edit the note.', picker_state: { current: 'self' } } as never);
  db.close();
  const after = packets.at(-1)!;
  const receipts = after.packet.request_execution_context?.successful_calls_for_current_request ?? [];
  expect(receipts).toEqual([expect.objectContaining({ tool_name: act.name })]);
  expect(receipts[0].result).toMatchObject({ success: true, browser_state: { action_status: 'acknowledged', check_status: 'passed' },
    output: { render: [{ data: { steps: ['1. clicked e5'], tabs: [{ page: 'p-1' }] } }] } });
  expect(JSON.stringify(after.packet.request_execution_context)).not.toContain('e43');
  expect(JSON.stringify(after.packet.prior_tool_calls)).toContain('(e43)');
});
