/** D-343 slice 3 (§3.3, rulings 5, 6 and 12) — the closing instructions ride the turn that replies
 *  to the owner's Agenda, or their evening notice, quoting it: record what they report in one
 *  `episode.record` call for the day the notice is about, tick off what has its own done, ask about
 *  what they left out, and say what was recorded. The host reads the day off the notice's title on
 *  the turn's clock. A turn that quotes nothing of the kind carries nothing.
 *
 *  ⛔ The packet is read off the AI call, through the real chat store, messenger bridge, notices,
 *  turn queue and orchestrator, as `d-338-notices.test.ts` reads it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import type { AIOutput, ChatMessage, SituationFact } from '@recued/contracts';
import type { NotificationMessage } from '@recued/notification';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend } from '../chat-handler.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { conversationHoldsNotices, createChatNotices, createNoticeConversationOpener } from '../chat-notices.js';
import { createEmailCloseDay } from '../email-close-day.js';
import { CLOSING_ITEMS_MAX, closingDayLine, closingDayNote, closingFollowUpNote, createOpenClosings, quotedClosingDay } from '../chat-closing-day.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const quoting = (text: string, role = 'notice', after = ''): string =>
  `${JSON.stringify({ reply_to: { message_id: 'notice:1', role, text }, message: 'Did the run, skipped Spanish.' })}${after}`;

describe('D-343 (the owner, 2026-11-14) — ask about what was left out first, then one record', () => {
  const items = [{ title: 'Spanish lesson', ref: { collection: 'task', id: 't1' } }, { title: 'Learn guitar', ref: { collection: 'asset', id: 'a1' } }];
  const itemsOf = async () => items;
  const evening = quoting('Close the day · Sat 7 Nov\nDue · Spanish lesson\n\nPursuit: Learn guitar\n\nReply to this with what you did.');
  it('asks first and changes nothing, then the plain answer carries the day and its items again', async () => {
    let at = 0; const open = createOpenClosings(() => at);
    const first = await open.begin('s1', evening, '2026-11-07', itemsOf);
    expect(first.line).toContain('first ask about each one they left out');
    expect(first.line).toContain('That call also ticks off each task recorded as done: do not call work.update for it.');
    open.end('s1', first.closing, []);
    // Their answer quotes nothing: it gets the notice and its refs again.
    at = 60_000; const answer = await open.begin('s1', 'Leave the guitar out.', '2026-11-07', itemsOf);
    expect(answer.line).toBe(closingFollowUpNote(first.closing!.quote, items));
    expect(answer.line).toContain('- Learn guitar {"collection":"asset","id":"a1"}');
    // The record proposed: the closing is over, and the next message carries nothing.
    open.end('s1', answer.closing, ['episode.record']);
    expect((await open.begin('s1', 'Thanks!', '2026-11-07', itemsOf)).line).toBe('');
  });
  it('while its record waits, a change carries the items and replaces it; once settled, nothing', async () => {
    let waits = true; const open = createOpenClosings(() => 0, async () => waits);
    const first = await open.begin('s1', evening, '2026-11-07', itemsOf);
    open.end('s1', first.closing, ['episode.record']);
    const change = await open.begin('s1', 'Oh, and I went for a walk too.', '2026-11-07', itemsOf);
    expect(change.line).toContain('waits for their approval. If this changes what to record, propose the whole day again');
    expect(change.line).toContain('it replaces the one waiting');
    expect(change.line).toContain('- Learn guitar {"collection":"asset","id":"a1"}');
    open.end('s1', change.closing, ['episode.record']);
    // Approved (or refused): nothing waits, so a thank-you carries nothing.
    waits = false;
    expect((await open.begin('s1', 'Thanks!', '2026-11-07', itemsOf)).line).toBe('');
  });
  it('takes a reply to today\'s morning notice as a plan, not a close, until a record is proposed', async () => {
    // D-343 (the owner's app day, 2026-11-15) — moving the plumber call from the morning's "Your day"
    // left the chat asking at 9:00 whether the plumber call had happened.
    const morning = quoting('Your day · Sat 7 Nov\nAgenda\nDue · Call the plumber\nDue · Spanish lesson');
    const open = createOpenClosings(() => 0, async () => true);
    const plan = await open.begin('s', morning, '2026-11-07', itemsOf);
    expect(plan.line).toContain('If the message tells you how that day went, close it');
    open.end('s', plan.closing, ['work.update']);
    expect((await open.begin('s', 'What do I still have left today?', '2026-11-07', itemsOf)).line).toBe('');
    // Its day reported from it, a record proposed: it is a close, carried on as one.
    const report = await open.begin('s', morning, '2026-11-07', itemsOf);
    open.end('s', report.closing, ['episode.record']);
    expect((await open.begin('s', 'Oh, and a walk too.', '2026-11-07', itemsOf)).line).not.toBe('');
    // A morning notice about a day already past is a late close, as before.
    const late = createOpenClosings(() => 0);
    const past = await late.begin('s', morning, '2026-11-09', itemsOf);
    late.end('s', past.closing, []);
    expect((await late.begin('s', 'Leave the guitar out.', '2026-11-09', itemsOf)).line).not.toBe('');
  });
  it('ends on a reply that quotes something else, after two answers, or after a day', async () => {
    let at = 0; const open = createOpenClosings(() => at);
    const asked = async () => { const first = await open.begin('s', evening, '2026-11-07', itemsOf); open.end('s', first.closing, []); };
    await asked();
    expect((await open.begin('s', quoting('Due today\nRenew passport'), '2026-11-07', itemsOf)).line).toBe('');
    expect((await open.begin('s', 'Leave it out.', '2026-11-07', itemsOf)).line).toBe('');
    await asked();
    for (const n of [1, 2]) {
      const turn = await open.begin('s', `Answer ${String(n)}`, '2026-11-07', itemsOf);
      expect(turn.line).not.toBe(''); open.end('s', turn.closing, []);
    }
    expect((await open.begin('s', 'Answer 3', '2026-11-07', itemsOf)).line).toBe('');
    await asked(); at += 24 * 3_600_000 + 1;
    expect((await open.begin('s', 'Much later', '2026-11-07', itemsOf)).line).toBe('');
    // Another conversation never sees it.
    at = 0; await asked();
    expect((await open.begin('other', 'Leave it out.', '2026-11-07', itemsOf)).line).toBe('');
  });
});

describe('D-343 slice 3 — the day a quoted notice closes', () => {
  it('reads the Agenda’s or the evening notice’s day on the turn’s clock', () => {
    expect(quotedClosingDay(quoting('Agenda · Sat 7 Nov\n09:00 Run 5 km'), '2026-11-07'))
      .toEqual({ title: 'Agenda · Sat 7 Nov', from: '2026-11-07', to: '2026-11-07' });
    expect(quotedClosingDay(quoting('Close the day · Fri 6 Nov\n09:00 Run 5 km'), '2026-11-09'))
      .toEqual({ title: 'Close the day · Fri 6 Nov', from: '2026-11-06', to: '2026-11-06' });
    // An Agenda over several days.
    expect(quotedClosingDay(quoting('Agenda · Fri 6 Nov to Sun 8 Nov\nFri 6 Nov\n09:00 Run'), '2026-11-08'))
      .toEqual({ title: 'Agenda · Fri 6 Nov to Sun 8 Nov', from: '2026-11-06', to: '2026-11-08' });
    // The year that puts the day nearest today, on its weekday: New Year's Eve, closed after it.
    expect(quotedClosingDay(quoting('Agenda · Thu 31 Dec\nAll day · Party'), '2027-01-02')).toMatchObject({ from: '2026-12-31' });
    // Newer ICU writes September "Sept".
    expect(quotedClosingDay(quoting('Agenda · Tue 1 Sept\n09:00 Dentist'), '2026-09-02')).toMatchObject({ from: '2026-09-01' });
    // A file's marker after the quote.
    expect(quotedClosingDay(quoting('Agenda · Sat 7 Nov\n09:00 Run', 'notice', '\n[attached: receipt.pdf]'), '2026-11-07'))
      .toMatchObject({ from: '2026-11-07' });
  });
  it('reads nothing from any other quote or message', () => {
    for (const message of [
      quoting('Due today\nRenew passport'),
      quoting('Agenda · Mon 7 Nov\n09:00 Run'), // no Monday 7 November near 2026
      quoting('Agenda · Sun 8 Nov to Fri 6 Nov\n09:00 Run'), // ends before it starts
      quoting('Agenda · Sat 7 Nov\n09:00 Run', 'assistant'),
      quoting('Agenda · Sat 7 Nov\n09:00 Run', 'user'),
      'Agenda · Sat 7 Nov: did the run',
      '{"reply_to": "broken',
    ]) expect(quotedClosingDay(message, '2026-11-07'), message).toBeUndefined();
  });
  it('tells the model how to close the day, or each of several', () => {
    expect(closingDayNote({ title: 'Agenda · Sat 7 Nov', from: '2026-11-07', to: '2026-11-07' })).toBe(
      '\n[This replies to their notice “Agenda · Sat 7 Nov”, about 2026-11-07. If the message tells you how that day went, close it:\n'
      + '1. Read the day with situation.query (time 2026-11-07) for each item\'s ref.\n'
      + '2. If they did not mention every item on the notice, first ask about each one they left out (did they do it, skip it, or should it be left out?) '
      + 'and change nothing until they answer.\n'
      + '3. Then record the day in one episode.record call with day 2026-11-07: each item done or skipped, in their words without "did" or "didn\'t" (the outcome says it), with its ref; '
      + 'anything else they did, with no item; nothing for an item they said to leave out.\n'
      + '4. That call also ticks off each task recorded as done: do not call work.update for it.\n'
      + '5. Say what you recorded.]');
    const several = closingDayNote({ title: 'Agenda · Fri 6 Nov to Sun 8 Nov', from: '2026-11-06', to: '2026-11-08' });
    expect(several).toContain('about 2026-11-06 to 2026-11-08. If the message tells you how those days went, close each:');
    expect(several).toContain('3. Then record each day in one episode.record call per day (ask which day if they do not say)');
  });
  it('lists the day’s items with their refs when the host can read them, and the model reads none itself', async () => {
    const quote = { title: 'Agenda · Sat 7 Nov', from: '2026-11-07', to: '2026-11-07' };
    const items = [{ title: 'Run 5 km', ref: { collection: 'task', id: 't1' } },
      { title: 'Reminder in Yours', ref: { collection: 'asset', id: 'a1', field: 'rules.renew' } }];
    expect(closingDayNote(quote, items)).toBe(
      '\n[This replies to their notice “Agenda · Sat 7 Nov”, about 2026-11-07. Its items, each with its ref:\n'
      + '- Run 5 km {"collection":"task","id":"t1"}\n- Reminder in Yours {"collection":"asset","id":"a1","field":"rules.renew"}\n'
      + 'If the message tells you how that day went, close it:\n'
      + '1. If they did not mention every item above, first ask about each one they left out (did they do it, skip it, or should it be left out?) '
      + 'and change nothing until they answer.\n'
      + '2. Then record the day in one episode.record call with day 2026-11-07: each item done or skipped, in their words without "did" or "didn\'t" (the outcome says it), with its ref above; '
      + 'anything else they did, with no item; nothing for an item they said to leave out.\n'
      + '3. That call also ticks off each task recorded as done: do not call work.update for it.\n'
      + '4. Say what you recorded.]');
    const message = quoting('Agenda · Sat 7 Nov\n07:00 Run 5 km');
    expect(await closingDayLine(message, '2026-11-07', async () => items)).toBe(closingDayNote(quote, items));
    // A day with more than a note lists, a read that fails, or none: the model reads the day itself.
    const many = Array.from({ length: 30 }, (_, n) => ({ title: `Item ${n}`, ref: { collection: 'task', id: `t${n}` } }));
    expect(await closingDayLine(message, '2026-11-07', async () => many)).toBe(closingDayNote(quote, many.slice(0, CLOSING_ITEMS_MAX)));
    expect(await closingDayLine(message, '2026-11-07', async () => { throw new Error('locked'); })).toBe(closingDayNote(quote));
    expect(await closingDayLine(message, '2026-11-07')).toBe(closingDayNote(quote));
    expect(await closingDayLine('Did the run.', '2026-11-07', async () => items)).toBe('');
  });
});

describe('D-343 slice 3 — the titles the Agenda goes out with are the ones closing reads', () => {
  it('reads the day of a daily Agenda and the days of a weekly one, as they are sent', async () => {
    // Monday 19 October 2026, the way d-325-agenda-rpc.test.ts sends it: the real scheduler and its
    // gated read, so a change to the Agenda's title cannot leave closing reading none.
    const at = Date.parse('2026-10-19T05:00:00Z');
    const briefing: SituationFact = { ref: { collection: 'calendar', id: 'work:briefing' }, title: 'Morning briefing', kind: 'calendar',
      basis: 'declared', when: { from: Date.parse('2026-10-19T09:00:00Z'), to: Date.parse('2026-10-19T09:30:00Z') },
      act_by: Date.parse('2026-10-19T09:00:00Z'), valid_until: Date.parse('2026-10-19T09:30:00Z'), people: [], subjects: [], related: [],
      evidence: [{ collection: 'calendar', id: 'work:briefing' }], updated_at: at, consequence: 'routine' };
    const db = new Database(':memory:'); ensureWorkEntitySchema(db);
    const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    const query = createSituationQuery({ now: () => at, sourceForCollection: (collection) => ({ verb_op: 'core.work-entity.read', collection }),
      sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => [briefing]) }] });
    const sent: Array<{ title?: string; text: string }> = [];
    const scheduled = createScheduledSituations({ db, work, store: createSituationStore(db), query, timeZone: () => 'UTC',
      isVaultUnlocked: () => true, isQuiet: () => false, now: () => at,
      overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }),
      send: async (message) => { sent.push(message); return { delivered_to: ['telegram'] }; } });
    scheduled.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => at, isVaultUnlocked: () => true }));
    cleanups.push(async () => { await scheduled.stop(); db.close(); });

    scheduled.setAgenda({ enabled: true });
    await scheduled.sendAgendaNow();
    scheduled.setAgenda({ frequency: 'weekly', weekday: 1, day: 'today' });
    await scheduled.sendAgendaNow();

    // What a reply quoting each carries (`noticeQuoteText`: the title, then the text).
    const days = sent.map((message) => quotedClosingDay(quoting(`${message.title}\n${message.text}`), '2026-10-21'));
    expect(days).toEqual([{ title: 'Agenda · Mon 19 Oct', from: '2026-10-19', to: '2026-10-19' },
      { title: 'Agenda · Mon 19 Oct to Sun 25 Oct', from: '2026-10-19', to: '2026-10-25' }]);
  });
});

const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'd-343' };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** The owner's Telegram chat with Recued, its notices and its turns, on a Saturday evening in Dublin. */
const fixture = (situation?: { read: (raw: unknown, source: unknown) => Promise<unknown>; isPrivate: (item: { ref: { id: string } }) => boolean;
  eveningPursuits?: (source: unknown) => Array<{ title: string; ref: { collection: string; id: string }; private: boolean }>;
  namesPrivateIn?: (title: string) => boolean }) => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const key: Uint8Array = new Uint8Array(32).fill(53); const getKey = () => key;
  const store = createChatStore(db, getKey);
  store.createSession({ id: 's' });
  const calls: string[] = [];
  const middlewareRegistry = createMiddlewareRegistry(); registerFirstPartyMiddlewares(middlewareRegistry);
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature, middlewareRegistry,
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} },
    executeAiCall: async (_tool, args) => {
      calls.push(String(args['llm.prompt']));
      return { body: { response: `answer ${calls.length}`, events: [], tool_calls: [] } satisfies AIOutput };
    },
    noticesHere: (sid) => conversationHoldsNotices(db, sid),
    now: () => Date.parse('2026-11-07T20:00:00Z'),
    serverTimeZone: () => 'Europe/Dublin',
    resolveFileNames: (ids) => new Map(ids.map((id) => [id, 'route.png'])),
    // As the real access answers on a server whose streams name no private items (D-340 slice 5), and
    // for a turn that is no suggestions' own run (D-340 slice 4).
    ...(situation ? { getSituationAccess: () => ({ namesPrivateIn: () => false, toolRoundCap: () => undefined, ...situation }) as never } : {}),
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey, pollMs: 5 });
  cleanups.push(() => { orchestrator.turnQueue!.close(); db.close(); });
  const bridge = createChatMessengerBridge({ db, store, getKey, pollMs: 5, minSendIntervalMs: 0 });
  cleanups.push(() => bridge.close());
  bridge.bind('telegram', 'chat-1', 'telegram:42', 's');
  bridge.register('telegram', { resolve: async () => ({ token: 'bot', recipient: 'chat-1', account: 'telegram:42' }),
    send: async () => ({ ok: true, vendor_message_id: 'posted' }) });
  const notices = createChatNotices({ db, chatStore: store, accountFor: async (vendor) => `${vendor}:42`, keyReady: () => true, signature });
  let posted = 800;
  /** The notice this call wrote, found by its id: two written in one millisecond sort by their random
   *  ids, so the last one listed can be the other. */
  const notify = async (message: NotificationMessage): Promise<ChatMessage> => {
    const before = new Set((await store.listMessages('s')).map((m) => m.id));
    const decoration = await notices.prepare({ vendor: 'telegram', recipient: 'chat-1', token: 'bot', message });
    await decoration!.sent(String((posted += 1)));
    const written = (await store.listMessages('s')).filter((m) => m.role === 'notice' && !before.has(m.id));
    expect(written).toHaveLength(1);
    return written[0]!;
  };
  const send = (message: string, submission_id: string, reply_to_message_id?: string, attachments?: Array<{ file_id: string; media_class: string }>,
    session_id = 's') => handleSend(
    { store, orchestrator, selfSignature: signature }, { session_id, message, submission_id, picker_state: { current: 'self' },
      ...(reply_to_message_id ? { reply_to_message_id } : {}), ...(attachments ? { attachments } : {}) });
  const settled = (count: number, session_id = 's') => vi.waitFor(async () => expect(
    (await orchestrator.turnQueue!.snapshot(session_id)).turns.map((turn) => turn.status)).toEqual(Array.from({ length: count }, () => 'completed')));
  /** The model's copy of the message, as round `n`'s packet carries it. */
  const notes = (n: number): string => (JSON.parse(calls[n]!) as { user_message: string }).user_message;
  /** D-343 slice 4 — Today's "Close the day": a conversation in the app holding the evening notice. */
  const openClosing = createNoticeConversationOpener({ chatStore: store, signature });
  return { db, store, orchestrator, raw, bridge, notify, send, settled, notes, openClosing, callCount: () => calls.length };
};

describe('D-343 slice 3 — a reply to the Agenda carries how to close its day', () => {
  it('an admitted email runs as an ordinary owner chat turn with the quoted day\'s closing instructions, once', async () => {
    const f = fixture();
    const emails = createEmailCloseDay({ db: f.db, getKey: () => new Uint8Array(32).fill(53),
      openNoticeConversation: () => f.openClosing, queue: () => f.orchestrator.turnQueue, readReply: async () => null });
    cleanups.push(() => emails.stop());
    const reply = { title: 'Agenda · Fri 6 Nov', quoted: 'Agenda · Fri 6 Nov\n07:00 Run 5 km', text: 'Did the run.',
      rfc_message_id: '<closing@example.test>', source: { slug: 'alerts', record_id: 'alerts:1' } };
    expect(await emails(reply)).toBe('opened');
    const receipt = f.db.prepare('SELECT session_id FROM email_close_day_replies').get() as { session_id: string };
    await f.settled(1, receipt.session_id);
    expect(f.notes(0)).toContain(closingDayNote({ title: 'Agenda · Fri 6 Nov', from: '2026-11-06', to: '2026-11-06' }));
    await emails.recover(true);
    expect(await emails(reply)).toBe('seen');
    expect(f.callCount()).toBe(1);
    expect((await f.store.listMessages(receipt.session_id)).filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('adds the closing instructions to the turn that quotes it, and to no other', async () => {
    const f = fixture();
    const agenda = await f.notify({ title: 'Agenda · Fri 6 Nov', text: '07:00 Run 5 km\nAll day · Spanish lesson' });
    const reminder = await f.notify({ title: 'Due today', text: 'Renew passport' });
    await f.send('Ran it, skipped Spanish.', 'closing', agenda.id);
    await f.settled(1);
    expect(f.notes(0)).toContain(closingDayNote({ title: 'Agenda · Fri 6 Nov', from: '2026-11-06', to: '2026-11-06' }));
    // Quoting something else, or nothing, carries none.
    await f.send('Thanks, I will.', 'reminder', reminder.id);
    await f.send('What is on tomorrow?', 'plain');
    await f.settled(3);
    for (const n of [1, 2]) expect(f.notes(n)).not.toContain('episode.record');
  });
  it('adds them after the files a reply carries', async () => {
    const f = fixture();
    const agenda = await f.notify({ title: 'Agenda · Fri 6 Nov', text: '07:00 Run 5 km' });
    await f.send('Ran it, here is the route.', 'closing', agenda.id, [{ file_id: 'file:0123456789abcdef0123456789abcdef', media_class: 'image' }]);
    await f.settled(1);
    expect(f.notes(0)).toContain('[files attached to this message: route.png (file:0123456789abcdef0123456789abcdef)]');
    expect(f.notes(0).endsWith(closingDayNote({ title: 'Agenda · Fri 6 Nov', from: '2026-11-06', to: '2026-11-06' }))).toBe(true);
  });
  it('lists the day’s items the turn may read, a private one named as the Agenda names it', async () => {
    const reads: Array<{ raw: unknown; source: unknown }> = [];
    const item = (collection: string, id: string, title: string, kind = 'task') => ({ ref: { collection, id }, kind, what: { value: title } });
    const f = fixture({
      read: async (raw, source) => {
        reads.push({ raw, source });
        return { clusters: [{ items: [item('task', 't1', 'Run 5 km'), item('asset', 'a1', 'Renew passport · Passport', 'asset_rule'),
          item('asset', 's1', 'Battery low · Hall alarm', 'asset_state')] }, { items: [item('task', 't1', 'Run 5 km')] }], omitted: 0, ambiguous: [] };
      },
      isPrivate: (value) => value.ref.id === 'a1',
    });
    const agenda = await f.notify({ title: 'Agenda · Fri 6 Nov', text: '07:00 Run 5 km\nAll day · Reminder in Yours' });
    await f.send('Ran it.', 'closing', agenda.id);
    await f.settled(1);
    // Read on the turn's own authority, for the quoted day.
    expect(reads).toEqual([{ raw: { time: '2026-11-06' }, source: expect.objectContaining({ actor: 'user_self' }) }]);
    expect(f.notes(0)).toContain('Its items, each with its ref:\n- Run 5 km {"collection":"task","id":"t1"}\n'
      + '- Reminder in Yours {"collection":"asset","id":"a1"}\nIf the message tells you how that day went');
    expect(f.notes(0)).not.toContain('Battery low');
  });
  it('reads every day of a weekly Agenda, and leaves a week it finds empty to the model', async () => {
    const reads: unknown[] = [];
    const f = fixture({ read: async (raw) => { reads.push(raw); return { clusters: [], omitted: 0, ambiguous: [] }; }, isPrivate: () => false });
    const agenda = await f.notify({ title: 'Agenda · Mon 2 Nov to Sun 8 Nov', text: 'Mon 2 Nov\n07:00 Run 5 km' });
    await f.send('Ran every day.', 'closing', agenda.id);
    await f.settled(1);
    expect(reads).toEqual([{ time: { first_day: '2026-11-02', last_day: '2026-11-08' } }]);
    expect(f.notes(0)).toContain(closingDayNote({ title: 'Agenda · Mon 2 Nov to Sun 8 Nov', from: '2026-11-02', to: '2026-11-08' }));
  });
  it('in the conversation Today opens, the reply to the evening notice lists the pursuits it asked about', async () => {
    const asked: unknown[] = [];
    const f = fixture({
      read: async () => ({ clusters: [{ items: [{ ref: { collection: 'calendar', id: 'work:run' }, kind: 'calendar', what: { value: 'Run 5 km' } }] }],
        omitted: 0, ambiguous: [] }),
      isPrivate: () => false,
      eveningPursuits: (source) => {
        asked.push(source);
        return [{ title: 'Learn Spanish', ref: { collection: 'asset', id: 'p1' }, private: false },
          { title: 'Run a marathon', ref: { collection: 'asset', id: 'p2' }, private: true }];
      },
    });
    const opened = await f.openClosing({ title: 'Close the day · Fri 6 Nov',
      text: '07:00 Run 5 km\n\nPursuits: Learn Spanish and a pursuit in Yours\n\nReply to this with what you did.' });
    await f.send('Ran it, and did 20 minutes of Spanish.', 'closing', opened.message_id, undefined, opened.session_id);
    await f.settled(1, opened.session_id);
    // The quote is the notice the app showed, read in its own conversation; the private pursuit is
    // listed as the evening notice names it.
    expect(JSON.parse(f.notes(0).split('\n', 1)[0]!)).toMatchObject({ reply_to: { message_id: opened.message_id, role: 'notice',
      text: 'Close the day · Fri 6 Nov\n07:00 Run 5 km\n\nPursuits: Learn Spanish and a pursuit in Yours\n\nReply to this with what you did.' } });
    expect(f.notes(0)).toContain('Its items, each with its ref:\n- Run 5 km {"collection":"calendar","id":"work:run"}\n'
      + '- Learn Spanish {"collection":"asset","id":"p1"}\n- Pursuit in Yours {"collection":"asset","id":"p2"}\nIf the message tells you how that day went');
    expect(asked).toEqual([expect.objectContaining({ actor: 'user_self' })]);
  });
  // D-340 slice 5 — a stream that includes private items named them, and the note follows it.
  it('names a private item and a private pursuit in the note when the quoted notice named them', async () => {
    const titles: string[] = [];
    const f = fixture({
      read: async () => ({ clusters: [{ items: [{ ref: { collection: 'asset', id: 'a1' }, kind: 'asset_rule', what: { value: 'Renew passport · Passport' } }] }],
        omitted: 0, ambiguous: [] }),
      isPrivate: () => true,
      eveningPursuits: () => [{ title: 'Run a marathon', ref: { collection: 'asset', id: 'p2' }, private: true }],
      namesPrivateIn: (title) => { titles.push(title); return true; },
    });
    const opened = await f.openClosing({ title: 'Close the day · Fri 6 Nov',
      text: 'All day · Renew passport · Passport\n\nPursuit: Run a marathon\n\nReply to this with what you did.' });
    await f.send('Renewed it.', 'closing', opened.message_id, undefined, opened.session_id);
    await f.settled(1, opened.session_id);
    expect(f.notes(0)).toContain('Its items, each with its ref:\n- Renew passport · Passport {"collection":"asset","id":"a1"}\n'
      + '- Run a marathon {"collection":"asset","id":"p2"}\nIf the message tells you how that day went');
    expect(titles).toEqual(['Close the day · Fri 6 Nov']);
  });
  it('lists no pursuits for a reply to the Agenda, which does not ask about them', async () => {
    const eveningPursuits = vi.fn(() => [{ title: 'Learn Spanish', ref: { collection: 'asset', id: 'p1' }, private: false }]);
    const f = fixture({ read: async () => ({ clusters: [], omitted: 0, ambiguous: [] }), isPrivate: () => false, eveningPursuits });
    const agenda = await f.notify({ title: 'Agenda · Fri 6 Nov', text: '07:00 Run 5 km' });
    await f.send('Ran it.', 'closing', agenda.id);
    await f.settled(1);
    expect(f.notes(0)).not.toContain('Learn Spanish');
    expect(eveningPursuits).not.toHaveBeenCalled();
  });
  it('adds them to a reply on the messenger too, which quotes the Agenda by its message there', async () => {
    const f = fixture();
    await f.notify({ title: 'Agenda · Sat 7 Nov', text: '07:00 Run 5 km' });
    const source = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as const;
    await f.raw.runMessengerTurn({
      channel: { surface: 'messenger-telegram', onInbound: () => undefined, deliver: async () => undefined },
      sessionStore: f.raw.sessionStore,
      inbound: { session_id: 's', surface: 'messenger-telegram', text: 'Ran it.', from: '42', source, dispatch_depth: 0, ts: Date.now() },
      native_reply_to: '801', native_reply_context: await f.bridge.nativeReply('s', 'telegram', '801'),
    });
    expect(f.notes(0)).toContain(closingDayNote({ title: 'Agenda · Sat 7 Nov', from: '2026-11-07', to: '2026-11-07' }));
  });
});
