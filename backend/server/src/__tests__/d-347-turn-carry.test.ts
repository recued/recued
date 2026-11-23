/** D-347 (2026-11-07) — a turn's results ride raw to the next turns until the context nears its limit.
 *  The owner: "closing brief only trigger at context window tail say such as 80%", then "Carry raw until
 *  80%". The closing brief ran after every turn that did tool work, and the next message waited for it.
 *
 *  The rules (`chat-turn-carry.ts`), the store (`chat-store.ts`, encrypted and bound to its session as
 *  the brief is), and turns through the REAL orchestrator and chat store with the model a stub, a brief
 *  call told apart by its packet (`tool_results_since`), as `chat-answer-before-brief.test.ts` does. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveSubDEK } from '@recued/crypto';
import type { ChatPriorToolCall, InternalToolRegistry, ToolEntry } from '@recued/contracts';

import { createChatOrchestrator, HELD_RESULT_TURN_NOTE } from '../chat-orchestrator.js';
import { __clearSessionBriefs, __clearUnfoldedUserMessages, briefAfterWait, UNFOLDED_MESSAGE_LIMIT } from '../chat-rolling-brief.js';
import {
  UNLEARNED_BUDGET_TOKENS, carriedResults, carryIsAllowed, carryRefusal, closingFoldDue, closingFoldLimit, parseStoredCarry,
} from '../chat-turn-carry.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const call = (tool_name: string, result: unknown, extra: Partial<ChatPriorToolCall> = {}): ChatPriorToolCall => ({
  tool_name, tier: 1, args: {}, status: 'ok', result, started_at: 1, completed_at: 2, ...extra });
const noAlias = () => false;

describe('D-347 — what may ride raw, and when the closing brief is due', () => {
  it('the next packet against 80% of the input budget, or of a stand-in window when none was learned', () => {
    const base = { catalogTokens: 40_000, overheadTokens: 2_000, tailTokens: 500, briefTokens: 400 };
    const small = [call('fixture.lookup', { text: 'x'.repeat(1_000) })];
    expect(closingFoldDue({ ...base, budgetTokens: 64_000, carried: small })).toBe(false);
    const large = [call('fixture.lookup', { text: 'x'.repeat(20_000) })];
    expect(closingFoldDue({ ...base, budgetTokens: 64_000, carried: large })).toBe(true);
    // With no window learned, what a learned 64,000 folds rides on (slice C: three page reads folded
    // under the first cut's cap on the carry alone) ...
    expect(closingFoldDue({ ...base, budgetTokens: undefined, carried: large })).toBe(false);
    // ... until the whole next packet reaches 80% of the stand-in.
    expect(closingFoldLimit(undefined)).toBe(0.8 * UNLEARNED_BUDGET_TOKENS);
    const rest = 42_900; // the base's four parts
    const past = [call('fixture.lookup', { text: 'x'.repeat(2 * (closingFoldLimit(undefined) - rest) + 100) })];
    expect(closingFoldDue({ ...base, budgetTokens: undefined, carried: past })).toBe(true);
  });

  it('ordinary results ride; a recall\'s, a write, a source read, a call still to come or an alias does not', () => {
    expect(carryIsAllowed([call('fixture.lookup', { value: 942.6 })], noAlias)).toBe(true);
    expect(carryRefusal([call('fixture.lookup', { value: 942.6 })], noAlias)).toBeNull();
    expect(carryRefusal([call('memory.search', { rows: [] })], noAlias)).toBe('recall');
    expect(carryRefusal([call('fixture.create_record', { saved: true })], noAlias, (n) => n === 'fixture.create_record')).toBe('write');
    expect(carryRefusal([call('work.read', { value: 1 })], noAlias)).toBe('source_read');
    expect(carryRefusal([call('mail.send', undefined, { status: 'error', reason: 'awaiting_approval' })], noAlias)).toBe('pending');
    expect(carryRefusal([call('fixture.lookup', { status: 'awaiting_approval', awaiting_approval: true })], noAlias)).toBe('pending');
    expect(carryRefusal([call('fixture.lookup', { who: 'pii.Person1' })], (text) => text.includes('pii.Person'))).toBe('alias');
    expect(carryIsAllowed([call('fixture.lookup', { who: 'pii.Person1' })], (text) => text.includes('pii.Person'))).toBe(false);
    // The host's own note is no result: left out, it neither rides nor stops the rest.
    const withNote = [call('context.brief', { intent: 'x' }), call('fixture.lookup', { value: 1 })];
    expect(carryIsAllowed(withNote, noAlias)).toBe(true);
    expect(carriedResults(withNote).map((c) => c.tool_name)).toEqual(['fixture.lookup']);
  });

  it('a stored carry reads back as its calls, and as none when it is not one', () => {
    const calls = [call('fixture.lookup', { value: 942.6 })];
    expect(parseStoredCarry(JSON.parse(JSON.stringify(calls)))).toEqual(calls);
    expect(parseStoredCarry({ not: 'a carry' })).toEqual([]);
    expect(parseStoredCarry([{ tool_name: 'fixture.lookup' }])).toEqual([]);
    expect(parseStoredCarry([call('context.brief', {})])).toEqual([]);
  });
});

const chatKey = (n: number): Uint8Array => deriveSubDEK(Buffer.alloc(32, n), 'chat');

describe('D-347 — the carry beside the brief, in the chat store', () => {
  const CARRY = JSON.stringify([call('fixture.lookup', { note: 'Bonded-warehouse levy is 318 units.' })]);

  it('round-trips encrypted, and survives a new store over the same database', async () => {
    const db = new Database(':memory:'); ensureChatSchema(db);
    const store = createChatStore(db, () => chatKey(1), () => undefined);
    store.createSession({ id: 's1', now: 1000 });
    await store.writeSessionCarry!('s1', CARRY);
    const row = db.prepare('SELECT carry_encrypted FROM chat_session_carry WHERE session_id = ?').get('s1') as { carry_encrypted: string };
    // A phrase no base64 ciphertext holds by chance ("318" alone did, about 1 run in 500: 2026-11-15).
    expect(row.carry_encrypted).not.toContain('Bonded-warehouse');
    expect(await createChatStore(db, () => chatKey(1), () => undefined).readSessionCarry!('s1')).toBe(CARRY);
  });

  // D-347 follow-up 3 — the mark a restarted server rebuilds the waiting statements from.
  it('marks a fold at the newest saved user message, not when it ran; deleting the session takes the mark', async () => {
    const db = new Database(':memory:'); ensureChatSchema(db);
    const store = createChatStore(db, () => chatKey(1), () => undefined);
    store.createSession({ id: 's1', now: 1000 });
    const say = (id: string, content: string, ts: number) => store.appendMessage({ id, session_id: 's1', role: 'user', content,
      target_server: 'self', picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: '1', instance_id: 't' } },
      model_used: { provider: 'local', model_id: 'test' }, ts });
    store.markStatementsFolded!('s1');
    // No message of the owner's yet: nothing was taken, nothing is marked.
    expect(store.readStatementsFoldedAt!('s1')).toBeNull();
    await say('u1', 'The levy is 318 units.', 1100);
    store.markStatementsFolded!('s1');
    // The message's own time: one sent while this fold ran is saved when its turn runs, sent after 1100.
    expect(store.readStatementsFoldedAt!('s1')).toBe(1100);
    await say('u2', 'And the retainer is 274.', 1150);
    expect(store.readStatementsFoldedAt!('s1')).toBe(1100);
    store.deleteSession('s1');
    expect(store.readStatementsFoldedAt!('s1')).toBeNull();
  });

  it('a blob moved to another session reads as absent; deleting the session takes its carry', async () => {
    const db = new Database(':memory:'); ensureChatSchema(db);
    const store = createChatStore(db, () => chatKey(1), () => undefined);
    store.createSession({ id: 's1', now: 1000 });
    store.createSession({ id: 's2', now: 1000 });
    await store.writeSessionCarry!('s1', CARRY);
    const row = db.prepare('SELECT carry_encrypted FROM chat_session_carry WHERE session_id = ?').get('s1') as { carry_encrypted: string };
    db.prepare('INSERT OR REPLACE INTO chat_session_carry (session_id, carry_encrypted, updated_at) VALUES (?,?,?)').run('s2', row.carry_encrypted, 1);
    expect(await store.readSessionCarry!('s2')).toBeNull();
    store.deleteSession('s1');
    expect(await store.readSessionCarry!('s1')).toBeNull();
  });
});

const FACT = 'The retainer is 274 units.';
const tool = (name: string, classification: ToolEntry['classification'] = 'read'): ToolEntry => ({ name, tier: 1,
  description: `${name} for the test.`, arg_schema: { type: 'object', properties: {}, additionalProperties: false },
  topic_tags: ['fixture'], concurrency_safe: classification === 'read', classification });

/** A conversation of the owner's own, a plan per turn: in turn N the model calls `turns[N].tool` once,
 *  unless its packet already holds that tool's result, then answers. Brief calls answer a valid brief. */
let conversations = 0;
const conversation = (turns: ReadonlyArray<{ tool: string; result: unknown; write?: true }>,
  options: { carry?: boolean; statements?: boolean;
    /** D-337 §7.10 — the calls a turn carries on the owner's own message, by turn. */
    untold?: Readonly<Record<number, readonly ChatPriorToolCall[]>> } = {}) => {
  // A session of its own: the user's statements wait in module state keyed by session, and one waiting a
  // third turn forces a fold, so a session shared across tests would fold on another test's statements.
  const sid = `s-${String(++conversations)}`;
  const db = new Database(':memory:'); ensureChatSchema(db);
  const full = createChatStore(db);
  const { readSessionCarry: _read, writeSessionCarry: _write, deleteSessionCarry: _delete, ...withoutCarry } = full;
  const { readStatementsFoldedAt: _readFolded, markStatementsFolded: _markFolded, ...withoutStatements } = full;
  const store: ChatStore = options.carry === false ? withoutCarry : options.statements === false ? withoutStatements : full;
  store.createSession({ id: sid });
  // This fixture supplies Standard writer responses for its carry lifecycle.
  store.setRollingBriefEnabled(true);
  const catalog = [...new Set(turns.map((t) => t.tool))].map((name) => tool(name, turns.find((t) => t.tool === name)!.write ? 'write' : 'read'));
  let turn = -1;
  const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog,
    getByName: (name) => catalog.find((t) => t.name === name) ?? null, subscribeRefresh: () => () => {},
    dispatch: async (name) => ({ ok: true, result: turns.find((t) => t.tool === name)!.result }) };
  /** Each turn's main packets, in order. */
  const packets: Array<Array<Record<string, unknown>>> = turns.map(() => []);
  /** Each turn's rolling-brief decisions, as the bench hears them (`recued.rolling_brief.trail`). */
  const trails: string[][] = turns.map(() => []);
  const hear = (event: unknown) => {
    const heard = event as { kind?: string; event?: { kind?: string; decisions?: string[] } };
    if (heard.kind === 'chat.transparency' && heard.event?.kind === 'recued.rolling_brief.trail') {
      trails[turn]!.push(...(heard.event.decisions ?? []));
    }
  };
  let briefCalls = 0;
  let id = 0;
  // A clock that always moves on, as a real one does between two turns: a fold marks the newest saved
  // message's time, and a rebuild keeps what came after it, so two messages in one millisecond lost
  // the second (the restart test failed 2 of 15 runs).
  let last = 0;
  const now = () => (last = Math.max(Date.now(), last + 1));
  const orchestratorOf = () => createChatOrchestrator({ chatStore: store, registry, mintId: () => `id-${String(++id)}`, now,
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'local' }, broadcast: { emit: hear },
    executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      if ('tool_results_since' in packet) {
        briefCalls += 1;
        return { body: { intent: 'Look up the retainer', constraints: [], pending: [], findings: [FACT], completed: [] } };
      }
      packets[turn]!.push(packet);
      const wanted = turns[turn]!.tool;
      const has = ((packet.prior_tool_calls ?? []) as Array<{ tool_name: string }>).some((c) => c.tool_name === wanted);
      return { body: { response: has ? 'Done.' : '', events: [], tool_calls: has ? [] : [{ tool: wanted, args: {} }] } };
    },
    carriedHeldResults: async () => {
      const calls = options.untold?.[turn];
      return calls === undefined ? undefined : { calls, run_ids: new Set<string>(), told: () => undefined };
    } });
  let orchestrator = orchestratorOf();
  /** A server restart: the process's memory gone, a new orchestrator over the same store. */
  const restart = () => { __clearUnfoldedUserMessages(); __clearSessionBriefs(); orchestrator = orchestratorOf(); };
  /** `extra`: what a host adds to a turn, as the calls a continuation opens with. */
  const send = async (message: string, extra: Record<string, unknown> = {}) => {
    turn += 1;
    await orchestrator.runTurn({ session_id: sid, message, picker_state: { current: 'self' }, ...extra } as never);
  };
  /** Turn `n`'s decisions about its carry: `carried_raw`, `carry_due` or `carry_refused:<reason>`. */
  const carryTrail = (n: number) => trails[n]!.filter((d) => /^carr(ied_raw|y_due|y_refused)/.test(d))
    .map((d) => /^[a-z_]+(?::[a-z_]+)?/.exec(d)![0]);
  return { db, store: full, sid, send, packets, briefs: () => briefCalls, carryTrail, restart };
};

describe('D-347 — turns through the real orchestrator and chat store', () => {
  beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

  it('a turn\'s result rides to the next turn, and no closing brief runs after it', async () => {
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }, { tool: 'fixture.lookup', result: { note: FACT } }]);
    await c.send('Look up the retainer.');
    expect(c.briefs()).toBe(0);
    expect(c.carryTrail(0)).toEqual(['carried_raw']);
    expect(await c.store.readSessionCarry!(c.sid)).toContain('274 units');
    await c.send('And what was the retainer again?');
    // The second turn opens holding the first turn's result: no new lookup is needed.
    expect(c.packets[1]).toHaveLength(1);
    expect(JSON.stringify(c.packets[1]![0]!.prior_tool_calls)).toContain('274 units');
    expect(c.briefs()).toBe(0);
    // A turn with no tool work of its own runs no closing block: the carry it opened with stays as it was.
    expect(c.carryTrail(1)).toEqual([]);
    expect(await c.store.readSessionCarry!(c.sid)).toContain('274 units');
    c.db.close();
  });

  it('a later turn\'s own tool work keeps the earlier results riding, in its rounds and after it', async () => {
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }, { tool: 'fixture.other', result: { note: 'The levy is 318 units.' } }]);
    await c.send('Look up the retainer.');
    await c.send('Now look up the levy.');
    // Its second round reads both: the first turn's result did not fall away when this turn's work began.
    expect(c.packets[1]).toHaveLength(2);
    expect(JSON.stringify(c.packets[1]![1]!.prior_tool_calls)).toContain('274 units');
    const carried = await c.store.readSessionCarry!(c.sid);
    expect(carried).toContain('274 units');
    expect(carried).toContain('318 units');
    expect(c.briefs()).toBe(0);
    c.db.close();
  });

  it('past the threshold the closing brief runs, as before, and folds what rode in with it', async () => {
    // No window is learned here, so the threshold is 80% of the stand-in's: this alone passes it.
    const large = { note: 'A long report.', text: 'x'.repeat(2 * UNLEARNED_BUDGET_TOKENS) };
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }, { tool: 'fixture.report', result: large }]);
    await c.send('Look up the retainer.');
    expect(await c.store.readSessionCarry!(c.sid)).toContain('274 units');
    await c.send('Now read the long report.');
    expect(c.briefs()).toBe(1);
    expect(c.carryTrail(1)).toEqual(['carry_due']);
    // Folded, the first turn's result is in the brief now, and nothing rides twice.
    expect(await c.store.readSessionCarry!(c.sid)).toBeNull();
    c.db.close();
  });

  // D-347 follow-up 3 (the owner, 2026-11-08: "Rebuild, fold when full") — a statement waiting a third turn no
  // longer forces the closing brief, as it did on every fourth turn that used tools; a full list of them does.
  it('eleven tool turns run no closing brief; the turn that fills the waiting list does', async () => {
    const turns = Array.from({ length: UNFOLDED_MESSAGE_LIMIT }, (_, i) => ({ tool: `fixture.step${String(i)}`, result: { note: `Step ${String(i)} done.` } }));
    const c = conversation(turns);
    for (let i = 0; i < UNFOLDED_MESSAGE_LIMIT - 1; i += 1) await c.send(`Do step ${String(i)}.`);
    expect(c.briefs()).toBe(0);
    await c.send(`Do step ${String(UNFOLDED_MESSAGE_LIMIT - 1)}.`);
    expect(c.briefs()).toBe(1);
    expect(c.carryTrail(UNFOLDED_MESSAGE_LIMIT - 1)).toEqual(['carry_refused:statements_full']);
    expect(await c.store.readSessionCarry!(c.sid)).toBeNull();
    c.db.close();
  });

  it('a restart rebuilds the waiting statements from the saved conversation, without what a fold took', async () => {
    const c = conversation([
      { tool: 'fixture.create_record', result: { record_id: 'note-1', saved: true }, write: true },
      { tool: 'fixture.lookup', result: { note: FACT } },
      { tool: 'fixture.other', result: { note: 'The levy is 318 units.' } },
    ]);
    await c.send('Save the Vale note.');
    // The write folded: what was said before it is in the brief now.
    expect(c.briefs()).toBe(1);
    await c.send('Look up the retainer.');
    c.restart();
    await c.send('Now look up the levy.');
    expect(c.packets[2]![0]!.pending_user_statements).toEqual(['Look up the retainer.']);
    c.db.close();
  });

  it('a store that records no fold loses them in a restart, as before', async () => {
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }, { tool: 'fixture.other', result: { note: 'x' } }],
      { statements: false });
    await c.send('Look up the retainer.');
    c.restart();
    await c.send('Now look up the levy.');
    expect(c.packets[1]![0]!.pending_user_statements).toBeUndefined();
    c.db.close();
  });

  it('a turn that wrote something still closes with a fold: its completed act is recorded at once', async () => {
    const c = conversation([{ tool: 'fixture.create_record', result: { record_id: 'note-1', saved: true }, write: true }]);
    await c.send('Save the Vale note.');
    expect(c.briefs()).toBe(1);
    expect(c.carryTrail(0)).toEqual(['carry_refused:write']);
    expect(await c.store.readSessionCarry!(c.sid)).toBeNull();
    c.db.close();
  });

  it('a source read still closes with a fold: its next read is re-validated through the brief', async () => {
    const c = conversation([{ tool: 'situation.query', result: { clusters: [] } }]);
    await c.send('What is on today?');
    expect(c.briefs()).toBe(1);
    expect(c.carryTrail(0)).toEqual(['carry_refused:source_read']);
    expect(await c.store.readSessionCarry!(c.sid)).toBeNull();
    c.db.close();
  });

  it('a store without the carry closes every turn with a fold, as before D-347', async () => {
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }], { carry: false });
    await c.send('Look up the retainer.');
    expect(c.briefs()).toBe(1);
    expect(c.carryTrail(0)).toEqual([]);
    c.db.close();
  });
});

// D-337 slice Z (2026-11-09) — a scheduled prompt's second run, the first without asking, answered "has
// been added" and added nothing. The run before had folded its brief while its write waited ("do not call
// work.create again", "… is awaiting owner approval"), and the continuation that carried the approval on
// answered without calling a tool, so it wrote no brief; its own note rode into the next run as the
// owner's statement. Each, alone, made the next run take its request for the one approved.
describe('D-337 slice Z — a turn carrying the conversation on from an approval clears what was written around the wait', () => {
  beforeEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

  /** A brief written while a held write waited, as the turn that made the call folds it. */
  const WAITING = { intent: 'Add a task titled "Water the plants"', constraints: [], completed: [],
    findings: ['Task creation for "Water the plants" is awaiting owner approval.', FACT],
    pending: ['Wait for approval of work.create (plan_id=p-1) - do not call work.create again'] };
  type Brief = { pending: string[]; findings: string[] };
  const briefIn = (packet: Record<string, unknown>) => (packet.prior_tool_calls as Array<{ tool_name: string; result: Brief }>)
    .find((entry) => entry.tool_name === 'context.brief')!.result;

  it('the wordings the folds wrote for a wait go; a finding about anything else stays', () => {
    const waits = ['Task creation for \'Water the plants\' is awaiting owner approval', 'Task creation is awaiting approval',
      'Task creation for "Water the plants" is awaiting_approval.', 'Status: awaiting_approval',
      'Plan ID c9efc4f8 is awaiting approval', 'Approval required for work.create task "Water the plants" (plan_id=f4b0)',
      'work.create for task \'Water the plants\' is awaiting approval with plan_id=e1c9'];
    const facts = [FACT, 'Task "Water the plants" created', 'Status: created', 'The invoice needs finance approval before it is paid'];
    const brief = { intent: 'x', constraints: [], completed: [], pending: ['Wait for approval'], findings: [...waits, ...facts] };
    expect(briefAfterWait(brief)).toEqual({ ...brief, pending: [], findings: facts });
    // Nothing to drop: the same brief, so nothing is saved.
    const settled = { ...brief, pending: [], findings: facts };
    expect(briefAfterWait(settled)).toBe(settled);
  });

  it('a turn that opens holding the calls its conversation waited on clears them, for later turns too', async () => {
    const made = call('fixture.create_record', { record_id: 'task-1', created: true });
    const c = conversation([{ tool: 'fixture.create_record', result: {}, write: true }, { tool: 'fixture.lookup', result: { note: FACT } }]);
    await c.store.writeSessionBrief(c.sid, JSON.stringify(WAITING));
    // The continuation answers from the call it holds, so it writes no brief of its own.
    await c.send('Approved: Add a task.', { held_results: [made] });
    expect(c.briefs()).toBe(0);
    expect(briefIn(c.packets[0]![0]!)).toMatchObject({ pending: [], findings: [FACT] });
    await c.send('Look up the retainer.');
    expect(briefIn(c.packets[1]![0]!)).toMatchObject({ pending: [], findings: [FACT] });
    expect(JSON.parse((await c.store.readSessionBrief(c.sid))!)).toMatchObject({ pending: [], findings: [FACT] });
    c.db.close();
  });

  it('a turn that opens with no waited calls keeps the brief as it was', async () => {
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }]);
    await c.store.writeSessionBrief(c.sid, JSON.stringify(WAITING));
    await c.send('Look up the retainer.');
    expect(briefIn(c.packets[0]![0]!)).toMatchObject({ pending: WAITING.pending, findings: WAITING.findings });
    c.db.close();
  });

  it('a continuation\'s note is Recued\'s: the next turn\'s waiting statements are the owner\'s own words', async () => {
    const booked = call('fixture.booking', { booked: true, room: 'Vale' });
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }, { tool: 'fixture.booking', result: {} },
      { tool: 'fixture.other', result: { note: 'The levy is 318 units.' } }]);
    await c.send('Look up the retainer.');
    await c.send('Approved: Book the room.', { held_results: [booked] });
    expect(c.packets[1]![0]!.user_message).toBe(`${HELD_RESULT_TURN_NOTE}\nApproved: Book the room.`);
    await c.send('Now look up the levy.');
    expect(c.briefs()).toBe(0);
    expect(c.packets[2]![0]!.pending_user_statements).toEqual(['Look up the retainer.']);
    c.db.close();
  });

  it('an owner\'s message that carries calls no model was told of is still theirs', async () => {
    const booked = call('fixture.booking', { booked: true, room: 'Vale' });
    const c = conversation([{ tool: 'fixture.lookup', result: { note: FACT } }, { tool: 'fixture.booking', result: {} },
      { tool: 'fixture.other', result: { note: 'The levy is 318 units.' } }], { untold: { 1: [booked] } });
    await c.send('Look up the retainer.');
    await c.send('And book the room for Friday.');
    // It opened holding the untold call, on the owner's own message.
    expect(JSON.stringify(c.packets[1]![0]!.prior_tool_calls)).toContain('"room":"Vale"');
    await c.send('Now look up the levy.');
    expect(c.packets[2]![0]!.pending_user_statements).toEqual(['Look up the retainer.', 'And book the room for Friday.']);
    c.db.close();
  });
});
