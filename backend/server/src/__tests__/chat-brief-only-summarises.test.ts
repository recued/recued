/** The owner, 2026-11-18: "the brief is an independent session running on its own without owner's
 *  interaction, and it should only produce a summary without making any tool calls, and it should start
 *  at context bloated or almost, I think we set to 80%, so that extra wait time only happens at that
 *  stage". The Consolidated running note (retired 2026-11-19) used to read each owner request with model
 *  calls before every turn (answered in chat, or work to do). A request read as answered in chat made the whole turn
 *  read-only, and every recipe counts as a possible write there, so "how did Anna sleep?" could run no
 *  recipe at all, under any switch. Nothing reads a request before a turn now: the turn runs as any
 *  other, and the approval gate decides. A turn its caller made read-only (a diagnosis, mail work)
 *  still runs reads alone. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatOrchestrator, type ChatBroadcastEmitter } from '../chat-orchestrator.js';
import { __clearSessionBriefs, __clearUnfoldedUserMessages, BRIEF_INSTRUCTION } from '../chat-rolling-brief.js';

const databases: Database.Database[] = [];
beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });
afterEach(() => { for (const db of databases.splice(0)) db.close(); __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

const READ = 'calendar.get', RECIPE = 'recipe.run', WRITE = 'calendar.update';
const tools: ToolEntry[] = [
  { name: READ, tier: 1, classification: 'read', description: 'Read the event', arg_schema: { type: 'object' }, topic_tags: [], concurrency_safe: false },
  // A recipe is `unknown` to chat: it may read or write, and its own gate decides when it runs.
  { name: RECIPE, tier: 1, classification: 'unknown', description: 'Run a recipe', arg_schema: { type: 'object' }, topic_tags: [], concurrency_safe: false },
  { name: WRITE, tier: 1, classification: 'write', description: 'Change the event', arg_schema: { type: 'object' }, topic_tags: [], concurrency_safe: false },
];
const QUESTION = 'How many minutes did Anna sleep on each of the last 3 nights?';

/** One owner turn asking a question, with the running note on. The model reads, runs a recipe and
 *  changes an event; every model call is kept by what it was for. */
const turn = async (opts: { read_only?: true } = {}) => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  const key = new Uint8Array(32).fill(8);
  const chat = createChatStore(db, () => key); chat.createSession({ id: 's', now: 1 }); chat.setRollingBriefEnabled(true);
  const plans = createSqliteChatPlanStore(db, () => key);
  const dispatched: string[] = [], listed: string[][] = [], assignments: unknown[] = [];
  const events: Parameters<ChatBroadcastEmitter['emit']>[0][] = [];
  let readings = 0, ids = 0, time = 100, first = true;
  const registry: InternalToolRegistry = { list: () => tools, listByTier: () => tools,
    getByName: name => tools.find(t => t.name === name) ?? null, subscribeRefresh: () => () => {},
    dispatch: async name => { dispatched.push(name); return { ok: true, result: { minutes: [418, 419, 420] } }; } };
  await createChatOrchestrator({ chatStore: chat, registry, planApprovalStore: plans,
    readPendingApprovalRows: sid => plans.readPendingEvidenceRows(sid),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'brief-only-summarises' },
    broadcast: { emit: event => { events.push(event); } }, mintId: () => 'brief-' + (++ids), now: () => ++time,
    executeAiCall: async (_manifest, input) => {
      const p = JSON.parse(String(input['llm.prompt']));
      const system = String(input['llm.system_prompt']);
      // Any call that is neither the chat's own (it carries the owner's message) nor the brief's reads the request.
      if (!('user_message' in p) && !system.startsWith(BRIEF_INSTRUCTION)) {
        readings++;
        throw new Error('Nothing reads the owner request before a turn');
      }
      if (system.startsWith(BRIEF_INSTRUCTION)) {
        return { body: { intent: QUESTION, constraints: [], pending: [], findings: ['Anna slept 418, 419 and 420 minutes.'] } };
      }
      listed.push(p.available_tools.map((t: { recipe_slug: string }) => t.recipe_slug));
      assignments.push(p.request_execution_context?.current_assignment);
      if (first) {
        first = false;
        return { body: { response: '', events: [], tool_calls: [
          { tool: READ, args: { query: 'sleep' } },
          { tool: RECIPE, args: { recipe_id: 'read-body-signals' } },
          { tool: WRITE, args: { title: 'Sleep check', minutes: 20 } },
        ] } };
      }
      return { body: { response: 'Anna slept 418, 419 and 420 minutes.', events: [], tool_calls: [] } };
    },
  }).runTurn({ session_id: 's', message: QUESTION, picker_state: { current: 'self' }, ...(opts.read_only ? { read_only: true } : {}) });
  const refused = events.filter(e => e.kind === 'chat.tool_call_completed' && e.status === 'error'
    && (e as { reason?: string }).reason === 'classification_blocked').map(e => (e as { tool_name: string }).tool_name);
  const readingEvents = events.filter(e => e.kind === 'chat.transparency'
    && String((e as { event?: { kind?: string } }).event?.kind ?? '').startsWith('recued.assignment_scope'));
  return { readings, readingEvents, dispatched, listed, assignments, refused, pending: await plans.listPending('s') };
};

it('nothing reads the question before the turn; every tool is listed, the read and the recipe run, and the write waits for the owner', async () => {
  const t = await turn();
  expect(t.readings).toBe(0); expect(t.readingEvents).toEqual([]);
  expect(t.assignments.every(a => a === undefined)).toBe(true);
  expect(t.listed[0]).toEqual(expect.arrayContaining([READ, RECIPE, WRITE]));
  expect(t.refused).toEqual([]);
  // The recipe reaches its own gate (here, the registry): before the ruling, "This turn can only read".
  expect(t.dispatched).toEqual(expect.arrayContaining([READ, RECIPE]));
  expect(t.dispatched).not.toContain(WRITE);
  expect(t.pending.map(plan => plan.tool)).toEqual([WRITE]);
});

it('a turn its caller made read-only still runs reads alone', async () => {
  const t = await turn({ read_only: true });
  expect(t.readings).toBe(0);
  expect(t.listed[0]).toContain(READ);
  expect(t.listed[0]).not.toContain(RECIPE); expect(t.listed[0]).not.toContain(WRITE);
  expect(t.dispatched).toEqual([READ]);
  expect([...t.refused].sort()).toEqual([RECIPE, WRITE].sort());
  expect(t.pending).toEqual([]);
});
