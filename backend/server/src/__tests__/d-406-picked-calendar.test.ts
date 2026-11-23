/** D-406 (Q4) — a calendar event the owner picked for a chat message, as D-406 picks an email: the message names it
 *  by its calendar and record id (P2), and the turn reads that one event (`calendar.search` with `slug` and
 *  `record_id`) before its first round, as a call of its own (P3). Through the real `calendar.search` handler on a
 *  real calendar table, and through `chat.send`, the real orchestrator, its executor and the real chat store with a
 *  scripted model. */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AIOutput,
  ChatCalendarRef,
  ChatCalendarRefInput,
  ChatDispatchResult,
  ChatMailRef,
  ChatMailRefInput,
  InternalToolRegistry,
  RecuedServerSignature,
  ToolEntry,
} from '@recued/contracts';

import { handleSend } from '../chat-handler.js';
import { createChatOrchestrator, type ChatTurnInput } from '../chat-orchestrator.js';
import { pickedCalendarNote, pickedCalendarReads, pickedMailNote } from '../chat-picked-mail.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { CALENDAR_BODY_MAX_CHARS, createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' };
const DAY = Date.UTC(2026, 10, 24, 9);
const ownerCtx = { execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' }, session_id: 's',
  time_zone: 'UTC' } as never;

/** Two calendars, and two events named alike on one of them: a title search could take either. */
const calendars = () => {
  const db = new Database(':memory:');
  const outlook = createCalendarTable({ db, slug: 'outlook' });
  const home = createCalendarTable({ db, slug: 'home' });
  // The description rides as the row's body, as a sync writes it.
  const event = (source_id: string, start_at: number, description: string) => ({ size_bytes: description.length, body_inline: description, event: {
    source_id, ical_uid: `uid-${source_id}`, calendar_id: 'cal-main', summary: 'Lease review', description, start_at, end_at: start_at + 3_600_000,
    timezone: 'UTC', is_all_day: false, status: 'confirmed', created_at: DAY, updated_at: DAY } } as never);
  outlook.upsert(event('ev-1', DAY, 'Bring the signed lease.'));
  outlook.upsert(event('ev-2', DAY + 7 * 86_400_000, 'x'.repeat(CALENDAR_BODY_MAX_CHARS + 50)));
  home.upsert(event('ev-3', DAY, 'At home.'));
  const collections = [{ platform: 'calendar', slug: 'outlook', table: outlook, provider: { kind: 'graph' } },
    { platform: 'calendar', slug: 'home', table: home, provider: { kind: 'local' } }];
  const handlers = buildChatTier1Handlers({ getCollectionRegistry: () => ({ list: () => collections }), now: () => DAY } as never);
  const idOf = (table: typeof outlook, source_id: string) => table.get(source_id)!.record_id;
  return { db, handlers, ids: { first: idOf(outlook, 'ev-1'), later: idOf(outlook, 'ev-2'), home: idOf(home, 'ev-3') } };
};

type Matches = { result: { matches: Array<Record<string, unknown>>; note?: string; record_not_found?: string; record_ambiguous?: string } };

describe('calendar.search by record_id: one event exactly', () => {
  it('the event the id names, not its namesake, with its calendar, ids, time and description', async () => {
    const { db, handlers, ids } = calendars();
    try {
      const got = await handlers['calendar.search']!({ slug: 'outlook', record_id: ids.first }, ownerCtx) as Matches;
      expect(got.result.matches).toHaveLength(1);
      expect(got.result.matches[0]).toMatchObject({ collection_slug: 'outlook', record_id: ids.first, source_id: 'ev-1',
        hot_fields: { summary: 'Lease review', start_at: DAY }, body: 'Bring the signed lease.' });
      expect(got.result.matches[0]).toHaveProperty('when');
      // The other filters are ignored: the id decides.
      const despite = await handlers['calendar.search']!({ slug: 'outlook', record_id: ids.first, query: 'nothing like it', start_since: DAY * 2 }, ownerCtx) as Matches;
      expect(despite.result.matches.map((m) => m.record_id)).toEqual([ids.first]);
      // A long description is cut where a search cuts it, and says so.
      const long = await handlers['calendar.search']!({ slug: 'outlook', record_id: ids.later }, ownerCtx) as Matches;
      expect(String(long.result.matches[0]!.body)).toHaveLength(CALENDAR_BODY_MAX_CHARS);
      expect(long.result.matches[0]!.body_truncated).toBe(true);
    } finally { db.close(); }
  });

  it('without a slug, the one calendar that holds it; an id none holds is said so, never a failure', async () => {
    const { db, handlers, ids } = calendars();
    try {
      const bare = await handlers['calendar.search']!({ record_id: ids.home }, ownerCtx) as Matches;
      expect(bare.result.matches.map((m) => [m.collection_slug, m.record_id])).toEqual([['home', ids.home]]);
      const missing = await handlers['calendar.search']!({ slug: 'outlook', record_id: 'cal:none' }, ownerCtx);
      expect(missing).toMatchObject({ ok: true, result: { matches: [], record_not_found: 'cal:none' } });
      expect((missing as Matches).result.note).toContain('ids cannot be guessed');
      // On another calendar than the one named: not there.
      const elsewhere = await handlers['calendar.search']!({ slug: 'home', record_id: ids.first }, ownerCtx) as Matches;
      expect(elsewhere.result).toMatchObject({ matches: [], record_not_found: ids.first });
    } finally { db.close(); }
  });
});

describe('picked events on the stored message', () => {
  it('kept with the message, encrypted as its text is, and read back', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 's', now: 1_000 });
    const refs: ChatCalendarRef[] = [{ slug: 'outlook', record_id: 'cal:1', title: 'Lease review', start_at: DAY }];
    await store.appendMessage({ id: 'u1', session_id: 's', role: 'user', content: 'Prepare me', ts: 1_001, target_server: 'self',
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'test', model_id: 'test' }, calendar_refs: refs });
    expect((await store.listMessages('s'))[0]?.calendar_refs).toEqual(refs);
    const raw = db.prepare('SELECT metadata_blob FROM chat_messages WHERE message_id = ?').get('u1') as { metadata_blob: string };
    expect(raw.metadata_blob).toContain('calendar_refs_encrypted');
    expect(raw.metadata_blob).not.toContain('Lease review');
  });
});

const TOOLS: ToolEntry[] = ['mail.read', 'calendar.search'].map((name) => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: ['read'], classification: 'read', concurrency_safe: true,
}) as ToolEntry);
const EVENT_READ: ChatDispatchResult = { ok: true, result: { matches: [{ collection_slug: 'outlook', record_id: 'cal:1', body: 'Bring the signed lease.' }] } };
const MAIL_READ: ChatDispatchResult = { ok: true, result: { status: 'read', slug: 'gmail', record_id: 'm1', body: 'The lease ends in January.' } };
const PICK: ChatCalendarRefInput = { slug: 'outlook', record_id: 'cal:1' };
const FOUND: ChatCalendarRef = { ...PICK, title: 'Lease review', start_at: DAY };
const MAIL_PICK: ChatMailRefInput = { slug: 'gmail', record_id: 'm1' };

let store: ChatStore;
beforeEach(() => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  store.createSession({ id: 's', now: 1_000 });
});

/** `chat.send` over the real orchestrator, as slice 1's test drives it. `pickedCalendar`: the server's check of each
 *  picked event (by default, each pick as stored); null: a server without one. */
const chat = (pickedCalendar: ((ref: ChatCalendarRefInput) => ChatCalendarRef | null) | null = (ref) => ({ ...FOUND, ...ref })) => {
  const inputs: string[] = [];
  const dispatched: Array<{ name: string; args: unknown }> = [];
  const registry: InternalToolRegistry = {
    list: () => TOOLS,
    listByTier: (tier) => (tier === 1 ? TOOLS : []),
    getByName: (name) => TOOLS.find((tool) => tool.name === name) ?? null,
    dispatch: async (name, args) => { dispatched.push({ name, args }); return name === 'mail.read' ? MAIL_READ : EVENT_READ; },
    subscribeRefresh: () => () => undefined,
  };
  let n = 0;
  const real = createChatOrchestrator({
    chatStore: store, registry, broadcast: { emit: () => undefined }, selfSignature: signature, mintId: () => `id-${String(++n)}`,
    executeAiCall: async (_manifest, input) => {
      inputs.push(JSON.stringify(input));
      const body: AIOutput = { response: 'Bring the signed lease to the review.', events: [], tool_calls: [] };
      return { body };
    },
  });
  const turns: Array<Promise<unknown>> = [];
  const orchestrator = { ...real, runTurn: (input: ChatTurnInput) => { const turn = real.runTurn(input); turns.push(turn); return turn; } };
  const pickedMail = (ref: ChatMailRefInput): ChatMailRef => ({ ...ref, subject: 'Lease' });
  const send = async (args: { message: string; calendar_refs?: unknown; mail_refs?: unknown }) => {
    await handleSend({ store, orchestrator, selfSignature: signature, pickedMail, ...(pickedCalendar !== null ? { pickedCalendar } : {}) } as never,
      { session_id: 's', picker_state: { current: 'self' }, ...args });
    await Promise.all(turns);
    const messages = await store.listMessages('s');
    return { user: messages.find((m) => m.role === 'user'), answer: messages.filter((m) => m.role === 'assistant').at(-1) };
  };
  return { send, inputs, dispatched };
};

describe('D-406 (Q4) — a picked event, read before the turn\'s first round', () => {
  it('the message keeps it; calendar.search by its record id runs first, as a call of the turn, and the model is told', async () => {
    const { send, inputs, dispatched } = chat();
    const { user, answer } = await send({ message: 'Help me prepare for this meeting.', calendar_refs: [PICK] });
    expect(user?.calendar_refs).toEqual([FOUND]);
    expect(dispatched).toEqual([{ name: 'calendar.search', args: { slug: 'outlook', record_id: 'cal:1' } }]);
    expect(inputs[0]).toContain('Bring the signed lease.');
    expect(inputs[0]).toContain(pickedCalendarNote(1).slice(0, 60));
    expect(answer?.tool_calls?.map((call) => call.tool_name)).toContain('calendar.search');
  });

  it('beside a picked email: the email first, then the event, each told; picks and no words are a turn', async () => {
    const { send, inputs, dispatched } = chat();
    await send({ message: '', mail_refs: [MAIL_PICK], calendar_refs: [PICK, { slug: 'outlook', record_id: 'cal:2' }] });
    expect(dispatched.map((call) => call.name)).toEqual(['mail.read', 'calendar.search', 'calendar.search']);
    expect(inputs[0]).toContain(pickedMailNote(1).slice(0, 50));
    expect(inputs[0]).toContain(pickedCalendarNote(2).slice(0, 50));
  });

  it('⛔ refused in words, never dropped: an event no longer there, too many, a malformed one, a server that cannot read one', async () => {
    await expect(chat(() => null).send({ message: 'x', calendar_refs: [PICK] })).rejects.toThrow('no longer in its calendar');
    const four = ['a', 'b', 'c', 'd'].map((record_id) => ({ slug: 'outlook', record_id }));
    await expect(chat().send({ message: 'x', calendar_refs: four })).rejects.toThrow('at most 3');
    await expect(chat().send({ message: 'x', calendar_refs: [{ record_id: 'cal:1' }] })).rejects.toThrow('not one');
    await expect(chat(null).send({ message: 'x', calendar_refs: [PICK] })).rejects.toThrow('cannot read a picked calendar event');
    expect(await store.listMessages('s')).toEqual([]);
  });

  it('a message with no pick reads nothing first, and tells the model nothing', async () => {
    const { send, dispatched, inputs } = chat();
    const { user } = await send({ message: 'Hello' });
    expect(dispatched).toEqual([]);
    expect(user).not.toHaveProperty('calendar_refs');
    expect(inputs[0]).not.toContain('picked the calendar event');
  });
});

describe('which turns read picked events first', () => {
  const OWNER_TURN = { picker_target: 'self', execution_source: { channel: 'chat', actor: 'user_self' }, calendar_refs: [FOUND] };
  it('the owner\'s own chat turn that opened with them, answered by their own model', () => {
    expect(pickedCalendarReads(OWNER_TURN)).toEqual([{ slug: 'outlook', record_id: 'cal:1' }]);
  });

  it('⛔ none for another picker\'s model, another channel or actor, mail work, a retry, a continuation, held results', () => {
    for (const turn of [
      { ...OWNER_TURN, picker_target: 'connection.mcp.peer' },
      { ...OWNER_TURN, execution_source: { channel: 'messenger', actor: 'user_self' } },
      { ...OWNER_TURN, execution_source: { channel: 'chat', actor: 'ai_agent' } },
      { ...OWNER_TURN, mail_work: { seeds: [] } },
      { ...OWNER_TURN, retry_of_plan_id: 'plan-1' },
      { ...OWNER_TURN, continuation_of_turn_id: 'turn-1' },
      { ...OWNER_TURN, held_results: [] },
    ]) expect(pickedCalendarReads(turn)).toEqual([]);
  });
});
