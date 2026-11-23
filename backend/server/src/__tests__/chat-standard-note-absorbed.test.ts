/** The running note is Standard, with what measured well in the retired Consolidated style (2026-11-19). The owner:
 *  "switch back to old but look for improvements to absorb from new, maybe a few extra guards are still useful &
 *  harmless in the instructions", then retired Consolidated ("1, then 2"). Past the 80% fold Consolidated's note kept
 *  every file it cited whole (0/2 against Standard's 2/2); its approval wins came from the records each turn gets of
 *  pending, approved, cancelled and completed actions, its guards on claims and unknown outcomes, and the host's
 *  notice for an unconfirmed action. */
import Database from 'better-sqlite3';
import { beforeEach, expect, it } from 'vitest';
import type { ChatDispatchResult, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages, clearPendingAfterWait,
  parseStoredBrief } from '../chat-rolling-brief.js';
import { STANDARD_BRIEF_ACTION_GUIDANCE, runChatTurn } from '../chat-turn-executor.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';

beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

// ⚠ With arguments: a call with none is stored without its "(…)" and gets no receipt in the records.
const lookup: ToolEntry = { name: 'fixture.lookup', tier: 1, description: 'Look a value up.', classification: 'read',
  arg_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  topic_tags: ['fixture'], concurrency_safe: true };

/** One owner turn with the note on or off: the model looks the value up once, then answers. */
const turn = async (noteOn: boolean) => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const key = new Uint8Array(32).fill(5);
  const store = createChatStore(db, () => key);
  store.createSession({ id: 's' });
  store.setRollingBriefEnabled(noteOn);
  // The approval readers production wires (`wire-chat-orchestrator.ts`), over the real plan store.
  const plans = createSqliteChatPlanStore(db, () => key, () => Date.now());
  const registry: InternalToolRegistry = { list: () => [lookup], listByTier: () => [lookup], getByName: (n) => (n === lookup.name ? lookup : null),
    subscribeRefresh: () => () => {}, dispatch: async () => ({ ok: true, result: { note: 'The retainer is 274 units.' } }) };
  const main: Array<{ system: string; packet: Record<string, any> }> = [];
  let id = 0, last = 0;
  await createChatOrchestrator({ chatStore: store, registry, mintId: () => `id-${String(++id)}`, now: () => (last = Math.max(Date.now(), last + 1)),
    planApprovalStore: plans, readPendingApprovalRows: (sid: string) => plans.readPendingEvidenceRows(sid),
    readCancelledApprovalRows: (sid: string) => plans.readCancelledEvidenceRows(sid),
    readCompletedHeldActionRows: (sid: string) => plans.readCompletedHeldEvidenceRows!(sid),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'standard-note' }, broadcast: { emit: () => {} },
    executeAiCall: async (_manifest, input) => {
      const system = String(input['llm.system_prompt']), packet = JSON.parse(String(input['llm.prompt'])) as Record<string, any>;
      if (system.startsWith(BRIEF_INSTRUCTION)) throw new Error('This turn carries its result raw: no brief runs');
      main.push({ system, packet });
      const has = Array.isArray(packet.prior_tool_calls) && packet.prior_tool_calls.some((c: { tool_name: string }) => c.tool_name === lookup.name);
      return { body: { response: has ? 'The retainer is 274 units.' : '', events: [], tool_calls: has ? [] : [{ tool: lookup.name, args: { key: 'retainer' } }] } };
    },
  }).runTurn({ session_id: 's', message: 'Look up the retainer.', picker_state: { current: 'self' } } as never);
  db.close();
  return main;
};

it('gives a turn its records and their guidance while the note is on, leaving out the empty and the repeated', async () => {
  const on = await turn(true);
  expect(on.length).toBe(2);
  for (const call of on) expect(call.system).toContain(STANDARD_BRIEF_ACTION_GUIDANCE);
  // Before the read nothing is held, done or refused: no records at all (an empty state is left out).
  expect(on[0]!.packet).not.toHaveProperty('request_execution_context');
  // After it, the read's receipt and the request it is for, and no empty list or approval state.
  expect(on[1]!.packet.request_execution_context).toEqual({
    current_request: expect.objectContaining({ text: 'Look up the retainer.' }),
    successful_calls_for_current_request: [expect.objectContaining({ tool_name: lookup.name, args: { key: 'retainer' } })] });
});

it('leaves a turn with the note off as it was: no records, no added guidance', async () => {
  const off = await turn(false);
  expect(off.length).toBeGreaterThan(0);
  for (const call of off) {
    expect(call.system).not.toContain(STANDARD_BRIEF_ACTION_GUIDANCE);
    expect(call.packet).not.toHaveProperty('request_execution_context');
  }
});

const rename: ToolEntry = { name: 'calendar.rename', tier: 1, classification: 'write', description: 'Change the event title.',
  arg_schema: { type: 'object', properties: { event_id: { type: 'string' }, title: { type: 'string' } },
    required: ['event_id', 'title'], additionalProperties: false }, topic_tags: [], concurrency_safe: false };

it.each([true, false])('tells the owner an action attempt did not confirm completion (write failed: %s)', async (failure) => {
  const read: ToolEntry = { ...rename, name: 'calendar.get', classification: 'read', concurrency_safe: true };
  const registry: InternalToolRegistry = { list: () => [rename, read], listByTier: () => [rename, read],
    getByName: name => [rename, read].find(tool => tool.name === name) ?? null,
    dispatch: async () => { throw Error('Use the native dispatch seam'); }, subscribeRefresh: () => () => {} };
  let calls = 0;
  const result = await runChatTurn({ session_id: 'receipt', turn_id: 'owner', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [rename, read].map(tool => ({ recipe_slug: tool.name, args_schema: tool.arg_schema })),
    content: { chat_tail: [], user_message: 'Set calendar event EVENT-7 title to Review.' }, correction_context: [], model_layer: 'byok' }, {
    registry, rollingBriefEnabled: () => true, now: () => 1000, emit() {},
    dispatchTool: async ({ tool_name }): Promise<ChatDispatchResult> => tool_name === rename.name && failure
      ? { ok: false, reason: 'execution_error', detail: 'Transport failed after dispatch; outcome unknown.' }
      : { ok: true, result: tool_name === rename.name ? { updated: true } : { title: 'Review' } },
    executeAiCall: async (_manifest, input) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        return { body: { intent: 'Rename EVENT-7.', constraints: [], pending: [], findings: ['EVENT-7 reads Review.'] } };
      }
      const body = { response: calls < 2 ? '' : 'The current title is Review.', events: [], tool_calls: calls++ < 2
        ? [{ tool: calls === 1 ? rename.name : read.name, args: { event_id: 'EVENT-7', title: 'Review' } }] : [] };
      return { body };
    },
  });
  expect(result.assistant_content).toContain('The current title is Review.');
  expect(result.assistant_content.includes('did not confirm completion')).toBe(failure);
});

it('discloses a failed held action in a one-shot continuation without dispatching it again', async () => {
  const held = { tool_name: rename.name, tier: 1 as const, args: { event_id: 'EVENT-7', title: 'Review' },
    status: 'error' as const, reason: 'execution_error' as const, detail: 'Outcome unknown.', started_at: 1, completed_at: 2 };
  const registry: InternalToolRegistry = { list: () => [rename], listByTier: () => [rename], getByName: () => rename,
    dispatch: async () => { throw Error('No repeat dispatch'); }, subscribeRefresh: () => () => {} };
  let calls = 0;
  const result = await runChatTurn({ session_id: 'held-receipt', turn_id: 'continuation', picker_target: 'self', dispatch_peer_name: null,
    held_results: [held], available_tools: [], content: { chat_tail: [], user_message: 'The held action settled.' },
    correction_context: [], model_layer: 'byok' }, {
    registry, rollingBriefEnabled: () => true, now: () => 1000, emit() {},
    dispatchTool: async () => { throw Error('No repeat dispatch'); },
    executeAiCall: async (_manifest, input) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        return { body: { intent: 'Rename EVENT-7.', constraints: [], pending: [], findings: [] } };
      }
      calls++; return { body: { response: 'The current state needs checking.', events: [], tool_calls: [] } };
    },
  });
  expect(calls).toBe(1); expect(result.assistant_content).toContain('did not confirm completion');
  expect(result.assistant_content).toContain('The current state needs checking.');
});

it('retains a successful write after a failed first fold and a store reload', async () => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db); store.createSession({ id: 's' }); store.setRollingBriefEnabled(true);
  const tool: ToolEntry = { name: 'fixture.create_record', tier: 1, description: 'Save a local note.',
    arg_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    topic_tags: ['fixture'], concurrency_safe: false, classification: 'write' };
  let writes = 0, id = 0;
  const registry: InternalToolRegistry = { list: () => [tool], listByTier: () => [tool], getByName: name => name === tool.name ? tool : null,
    subscribeRefresh: () => () => {}, dispatch: async () => { writes++; return { ok: true, result: { record_id: 'note-1', saved: true } }; } };
  await createChatOrchestrator({ chatStore: store, registry,
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' }, mintId: () => `write-${++id}`,
    broadcast: { emit: () => {} }, executeAiCall: async (_manifest, input) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) return { body: { invalid: true } };
      const packet = JSON.parse(String(input['llm.prompt']));
      const saved = (packet.prior_tool_calls ?? []).some((call: { tool_name: string }) => call.tool_name === tool.name);
      return { body: { response: saved ? 'Saved the Vale note.' : '', events: [],
        tool_calls: saved ? [] : [{ tool: tool.name, args: { summary: 'Vale note' } }] } };
    } }).runTurn({ session_id: 's', message: 'Save the Vale note.', picker_state: { current: 'self' } });
  expect(writes).toBe(1);
  const stored = parseStoredBrief(JSON.parse((await createChatStore(db).readSessionBrief('s'))!))!;
  expect(stored.completed).toEqual(['fixture.create_record — completed: Vale note']);
  expect(stored.pending.join(' ')).toContain('Unfolded');
  expect(stored.findings).toEqual([]);
  db.close();
});

it('reads a note the retired Consolidated style saved as a Standard note, and does not write its fields back', () => {
  const saved = { intent: 'Price the Vale job', constraints: ['Do not send mail.'], pending: ['Check the quote.'],
    findings: ['The estimate was 689 units.'], completed: [],
    active_context: { version: 1, sources: [{ id: 's-0123456789abcdef01234567', role: 'user', content: 'Price the Vale job' }],
      citations: { intent: ['s-0123456789abcdef01234567'], constraints: [[]], pending: [[]], findings: [[]] } },
    legacy_standard_note: { version: 1, intent: 'Old', constraints: [], pending: [], findings: [] } };
  const read = parseStoredBrief(saved)!;
  expect(read).toEqual({ intent: 'Price the Vale job', constraints: ['Do not send mail.'], pending: ['Check the quote.'],
    findings: ['The estimate was 689 units.'], completed: [] });
  const rewritten = JSON.parse(clearPendingAfterWait(JSON.stringify(saved))!);
  expect(rewritten).not.toHaveProperty('active_context');
  expect(rewritten).not.toHaveProperty('legacy_standard_note');
  expect(rewritten.pending).toEqual([]);
  expect(rewritten.findings).toEqual(['The estimate was 689 units.']);
});
