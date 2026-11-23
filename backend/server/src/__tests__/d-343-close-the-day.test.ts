/** D-343 slice 4 (§3.1, §3.2; rulings 3, 5, 19, 20 and 21) — Close the day: an evening message
 *  beside the Agenda that lists the whole day, the pursuits the owner asked about in the evening,
 *  and one line that asks what they did; and Today's "Close the day", a conversation holding it.
 *
 *  Through the real scheduler, its gated read, the Yours service and its rpc handlers, the asset
 *  store a pursuit lives in, and the chat store the conversation is kept in. Only the calendar
 *  (two events) and the send are stand-ins. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D165_CONTRACT_SCHEMA, PURSUIT_CLASS_ID, type Asset, type ExecutionSource, type SituationFact } from '@recued/contracts';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { situationSourceAccess } from '../situations/sources.js';
import type { WsClient } from '../ws-server.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { CLOSE_DAY_ASK, CLOSE_DAY_NOTHING_ON, createScheduledSituations } from '../situations/scheduled-situations.js';
import { createYoursService } from '../situations/yours-service.js';
import { makeYoursHandlers } from '../situations/yours-handler.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { APP_DAY_SESSION_ID, createNoticeConversationOpener } from '../chat-notices.js';
import { createEmailCloseDay } from '../email-close-day.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import type { NotificationSendArgs } from '../notification-handler.js';

// Monday 19 October 2026, 20:00 UTC (the server's zone is UTC).
const EVENING = Date.parse('2026-10-19T20:00:00Z');
const at = (time: string, day = '2026-10-19') => Date.parse(`${day}T${time}:00Z`);
const event = (id: string, title: string, from: number, to: number): SituationFact => ({ ref: { collection: 'calendar', id }, title,
  kind: 'calendar', basis: 'declared', when: { from, to }, act_by: from, valid_until: to, people: [], subjects: [], related: [],
  evidence: [{ collection: 'calendar', id }], updated_at: EVENING - 86_400_000, consequence: 'routine' });
const paired = { instance_id: 'wc_1', client_kind: 'webclient', user_id: 'owner', client_token_id: 'paired' } as unknown as WsClient;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const fixture = (options: { events?: SituationFact[]; quiet?: (at: number) => boolean; quietEnd?: (minute: number) => number | null;
  opener?: boolean; deliveredTo?: string[] } = {}) => {
  let clock = EVENING;
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  // The morning's run is over by the evening; the dinner is still to come.
  const events = options.events ?? [event('work:run', 'Run 5 km', at('07:00'), at('07:45')), event('work:dinner', 'Dinner with Sam', at('21:30'), at('23:00'))];
  const query = createSituationQuery({ now: () => clock, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }),
    sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => events) }] });
  const sent: NotificationSendArgs[] = [];
  const send = vi.fn(async (message: NotificationSendArgs) => { sent.push(message); return { delivered_to: options.deliveredTo ?? ['telegram'] }; });
  const store = createSituationStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => clock });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => clock });
  const chat = createChatStore(db);
  const opener = createNoticeConversationOpener({ chatStore: chat, signature: { server_kind: 'recued', version: '1', instance_id: 'd343' }, now: () => clock });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: store, now: () => clock, timeZone: () => 'UTC',
    isVaultUnlocked: () => true, ...(options.opener === false ? {} : { openNoticeConversation: opener }) });
  // As `compose-collection-context.ts` composes them: Today's overview is the Yours service's.
  const scheduled = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true,
    isQuiet: options.quiet ?? (() => false), ...(options.quietEnd ? { quietEnd: options.quietEnd } : {}), now: () => clock, send,
    overview: () => yours.overview(), ...(options.opener === false ? {} : { recordAppNotice: () => opener.record }) });
  scheduled.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => clock, isVaultUnlocked: () => true }));
  yours.bindScheduled(scheduled);
  cleanups.push(async () => { await yours.stop(); await scheduled.stop(); db.close(); });
  const handlers = makeYoursHandlers(yours)!.handlers;
  const change = (input: unknown) => handlers['yours.change']!(input as never, paired) as Promise<import('@recued/contracts').YoursCommandResult>;
  const status = async () => (await handlers['yours.agenda']!(undefined, paired) as import('@recued/contracts').SituationAgendaStatus).close_day!;
  const pursuit = (name: string, settings: Record<string, unknown>, patch: Partial<Asset> = {}) => work.writeAsset({ source_id: 'recued.asset',
    source: { kind: 'owner', ref: 'owner' }, name, class_id: PURSUIT_CLASS_ID, settings, ...patch } as never, EVENING - 86_400_000);
  const closing = () => sent.filter(message => message.title?.startsWith('Close the day'));
  return { db, chat, yours, scheduled, handlers, change, status, pursuit, closing, sent, setClock: (value: number) => { clock = value; } };
};

describe('D-343 slice 4 — Close the day, beside the Agenda', () => {
  it('reports unresolved email handoffs through its owner RPC and retries or marks reviewed without repeating an admitted turn', async () => {
    const f = fixture(); const journal = createChatTurnQueueStore(f.db);
    f.db.exec(`CREATE TABLE email_close_day_replies(rfc_message_id TEXT PRIMARY KEY,session_id TEXT,created_at INTEGER NOT NULL);
      INSERT INTO email_close_day_replies VALUES('earlier-reply',NULL,1);`);
    let refuse = true;
    const opener = createNoticeConversationOpener({ chatStore: f.chat, signature: { server_kind: 'recued', version: '1', instance_id: 'd343' } });
    const emails = createEmailCloseDay({ db: f.db, openNoticeConversation: () => opener, readReply: async () => null,
      queue: () => ({ routing: () => undefined, submit: async (...args) => {
        if (refuse) throw new Error('injected admission refusal'); return journal.admit(...args);
      } }) });
    cleanups.push(() => emails.stop()); f.yours.bindEmailCloseDay(emails);
    const reply = { title: 'Your day · Mon 19 Oct', text: 'Did the run.', quoted: '', rfc_message_id: 'new-reply', source: { slug: 'alerts', record_id: 'alerts:1' } };
    expect(await emails(reply)).toBe('pending');
    const pending = (await f.status()).email_replies!;
    const current = pending.find(row => row.reason === 'retry')!;
    const earlier = pending.find(row => row.reason === 'unknown')!;
    expect(current).toMatchObject({ retry_available: true, session_id: expect.any(String) });
    await expect(f.handlers['yours.change']!({ action: 'close_day.retry_reply', id: current.id }, {} as WsClient)).rejects.toThrow('paired webclient');
    expect(f.db.prepare('SELECT count(*) AS n FROM chat_turn_queue').get()).toEqual({ n: 0 });
    refuse = false;
    expect(await f.change({ action: 'close_day.retry_reply', id: current.id })).toEqual({ message: 'Your reply has been handed to Chat.' });
    await f.change({ action: 'close_day.retry_reply', id: current.id });
    await f.change({ action: 'close_day.review_reply', id: earlier.id });
    expect((await f.status()).email_replies).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS n FROM chat_turn_queue').get()).toEqual({ n: 1 });
    expect(await emails(reply)).toBe('seen');
  });

  it('is off until the owner turns it on, at 21:00, and the Agenda names it', async () => {
    const f = fixture();
    expect(await f.status()).toMatchObject({ settings: { enabled: false, time: '21:00' }, last_run: null, last_sent: null, pending: 0, uncertain: 0 });
    expect((await f.status()).next_at).toBeUndefined();
    expect(await f.change({ action: 'close_day.update', settings: { enabled: true } })).toEqual({ message: 'Close the day saved.' });
    expect(await f.status()).toMatchObject({ settings: { enabled: true, time: '21:00' }, next_at: at('21:00'), time_zone: 'UTC' });
    await expect(f.change({ action: 'close_day.update', settings: { time: '9pm' } })).rejects.toThrow('Choose a valid time to close the day');
    await f.scheduled.tick();
    expect(f.closing()).toEqual([]);
  });

  it('lists the whole day, what is over included, the pursuits asked about in the evening, and asks', async () => {
    const f = fixture();
    f.pursuit('Learn Spanish', { evening: true });
    f.pursuit('Run a marathon', { evening: true, sensitive: true });
    f.pursuit('Read more', {});
    f.pursuit('Write a novel', { evening: true }, { status: 'retired' });
    expect(await f.change({ action: 'close_day.send_now' })).toEqual({ message: 'Sent. Reply to it with what you did.' });
    expect(f.closing()).toEqual([{ title: 'Close the day · Mon 19 Oct', ui_link_url: '#today',
      text: `07:00 Run 5 km\n21:30 Dinner with Sam\n\nPursuits: Learn Spanish and a pursuit in Yours\n\n${CLOSE_DAY_ASK}`,
      // In the app the name a pursuit is listed by opens it; a private one is not named, so not linked.
      mentions: [{ text: 'Learn Spanish', ref: { collection: 'asset', id: expect.any(String) } }] }]);
    // The Agenda at this hour leaves the run out: it is over, and a forward list drops what is.
    await f.change({ action: 'agenda.send_now' });
    expect(f.sent.find(message => message.title === 'Agenda · Mon 19 Oct')?.text).toBe('21:30 Dinner with Sam');
  });

  it('still asks on a day with nothing on (ruling 21)', async () => {
    const f = fixture({ events: [] });
    await f.change({ action: 'close_day.send_now' });
    expect(f.closing()).toEqual([{ title: 'Close the day · Mon 19 Oct', text: `${CLOSE_DAY_NOTHING_ON}\n\n${CLOSE_DAY_ASK}`, ui_link_url: '#today' }]);
  });

  it('goes once at its time, keyed by the day it closes, and is not caught up when turned on late', async () => {
    const f = fixture();
    f.setClock(at('22:00'));
    await f.change({ action: 'close_day.update', settings: { enabled: true } });
    await f.scheduled.tick();
    expect(f.closing()).toEqual([]);
    expect((await f.status()).next_at).toBe(at('21:00', '2026-10-20'));
    f.setClock(at('20:59', '2026-10-20')); await f.scheduled.tick();
    expect(f.closing()).toEqual([]);
    f.setClock(at('21:00', '2026-10-20')); await f.scheduled.tick(); await f.scheduled.tick();
    expect(f.closing().map(message => message.title)).toEqual(['Close the day · Tue 20 Oct']);
    expect(f.db.prepare("SELECT id, mode, state FROM scheduled_situation_runs WHERE mode LIKE 'close_day%'").all())
      .toEqual([{ id: 'close_day:2026-10-20', mode: 'close_day', state: 'sent' }]);
    expect(await f.status()).toMatchObject({ last_sent: { mode: 'close_day', text: expect.stringContaining(CLOSE_DAY_ASK) } });
  });

  it('carried past midnight by quiet hours, goes the next morning about the day before', async () => {
    // Quiet from 20:00 to 07:00: 21:00 falls inside, so it waits for 07:00.
    const quiet = (instant: number) => { const hour = new Date(instant).getUTCHours(); return hour >= 20 || hour < 7; };
    const f = fixture({ quiet, quietEnd: minute => (minute >= 20 * 60 || minute < 7 * 60 ? 7 * 60 : null) });
    f.setClock(at('12:00'));
    await f.change({ action: 'close_day.update', settings: { enabled: true } });
    f.setClock(at('21:00')); await f.scheduled.tick();
    expect(f.closing()).toEqual([]);
    f.setClock(at('07:00', '2026-10-20')); await f.scheduled.tick();
    expect(f.closing().map(message => message.title)).toEqual(['Close the day · Mon 19 Oct']);
    expect(f.db.prepare("SELECT id FROM scheduled_situation_runs WHERE mode='close_day'").all()).toEqual([{ id: 'close_day:2026-10-19' }]);
  });

  it('keeps its own receipts: the Agenda and Coming up neither show its runs nor spend its sends', async () => {
    const f = fixture();
    await f.change({ action: 'close_day.send_now' });
    const agenda = await f.handlers['yours.agenda']!(undefined, paired) as import('@recued/contracts').SituationAgendaStatus;
    expect(agenda.last_run).toBeNull();
    expect((await f.handlers['yours.delivery']!(undefined, paired) as import('@recued/contracts').SituationDeliveryStatus).last_run).toBeNull();
    expect(agenda.close_day).toMatchObject({ last_run: { mode: 'close_day_manual', state: 'sent' } });
    // Two scheduled evening sends a day at most, counted apart from the Digest's two and the Agenda's.
    f.db.prepare(`INSERT INTO scheduled_situation_attempts(run_id,day,at,mode,outcome) VALUES('w','2026-10-19',?,'overview','delivered'),
      ('x','2026-10-19',?,'day_of','delivered'),('y','2026-10-19',?,'agenda','delivered'),('z','2026-10-19',?,'agenda','delivered')`)
      .run(EVENING, EVENING, EVENING, EVENING);
    f.setClock(at('12:00')); await f.change({ action: 'close_day.update', settings: { enabled: true } });
    f.setClock(at('21:00')); await f.scheduled.tick();
    expect(f.closing().map(message => message.title)).toEqual(['Close the day · Mon 19 Oct', 'Close the day · Mon 19 Oct']);
  });
});

describe('D-343 slice 4 — what retention keeps of it', () => {
  it('keeps its last run and its last sent one, as the Agenda\'s and the Digest\'s are kept', async () => {
    const f = fixture();
    await f.change({ action: 'close_day.send_now' });
    f.db.prepare("UPDATE scheduled_situation_runs SET at=1 WHERE mode='close_day_manual'").run();
    f.scheduled.prune(EVENING);
    expect(await f.status()).toMatchObject({ last_run: { mode: 'close_day_manual', state: 'sent' }, last_sent: { mode: 'close_day_manual' } });
    // A second, older and superseded, goes.
    f.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state) VALUES('close_day:2026-10-01','close_day','2026-10-01',0,'superseded')").run();
    f.scheduled.prune(EVENING);
    expect(f.db.prepare("SELECT id FROM scheduled_situation_runs WHERE mode LIKE 'close_day%'").all()).toEqual([{ id: expect.stringMatching(/^close_day_manual:/u) }]);
  });
});

describe('D-343 slice 4 — Today\'s "Close the day" (ruling 20)', () => {
  it('opens the app\'s "Your day" conversation at today\'s evening notice, for the app\'s reply to quote', async () => {
    const f = fixture();
    f.pursuit('Learn Spanish', { evening: true });
    const result = await f.change({ action: 'close_day.open' });
    const title = 'Close the day · Mon 19 Oct';
    const text = `07:00 Run 5 km\n21:30 Dinner with Sam\n\nPursuit: Learn Spanish\n\n${CLOSE_DAY_ASK}`;
    expect(result).toEqual({ message: 'Your day is ready to close.', conversation: { session_id: APP_DAY_SESSION_ID, message_id: expect.stringMatching(/^notice:/u), title, text } });
    const { session_id, message_id } = result.conversation!;
    expect(f.chat.getSession(session_id)).toMatchObject({ id: APP_DAY_SESSION_ID, title: 'Your day' });
    expect(await f.chat.listMessages(session_id)).toEqual([expect.objectContaining({ id: message_id, role: 'notice', content: text,
      notice: { vendor: 'app', title } })]);
    // Nothing went to a channel: the conversation is the app's own.
    expect(f.sent).toEqual([]);
    // Pressed again, it is the same notice, not a second one.
    expect((await f.change({ action: 'close_day.open' })).conversation).toMatchObject({ session_id, message_id });
    expect(await f.chat.listMessages(session_id)).toHaveLength(1);
  });

  it('keeps the evening notice that went out in "Your day", and the button opens that one', async () => {
    const f = fixture();
    await f.change({ action: 'close_day.send_now' });
    const [kept] = await f.chat.listMessages(APP_DAY_SESSION_ID);
    expect(kept).toMatchObject({ role: 'notice', notice: { vendor: 'app', title: 'Close the day · Mon 19 Oct' } });
    expect(kept!.content).toBe(f.closing()[0]!.text);
    expect((await f.change({ action: 'close_day.open' })).conversation).toMatchObject({ session_id: APP_DAY_SESSION_ID, message_id: kept!.id });
    expect(await f.chat.listMessages(APP_DAY_SESSION_ID)).toHaveLength(1);
    // The day changed since it went (the 2026-11-15 drive: a task ticked off in a close on Telegram):
    // the button still opens today's one notice, not a second with the new lines.
    f.setClock(EVENING + 60_000);
    f.pursuit('Read more books', { evening: true });
    expect((await f.change({ action: 'close_day.open' })).conversation).toMatchObject({ session_id: APP_DAY_SESSION_ID, message_id: kept!.id });
    expect(await f.chat.listMessages(APP_DAY_SESSION_ID)).toHaveLength(1);
  });

  it('keeps the Agenda that went out there too, and nothing that went nowhere', async () => {
    const f = fixture();
    await f.change({ action: 'agenda.send_now' });
    expect((await f.chat.listMessages(APP_DAY_SESSION_ID)).map(message => message.notice?.title)).toEqual(['Agenda · Mon 19 Oct']);
    const nowhere = fixture({ deliveredTo: [] });
    await nowhere.change({ action: 'close_day.send_now' }).catch(() => undefined);
    expect(nowhere.chat.getSession(APP_DAY_SESSION_ID)).toBeNull();
  });

  it('is offered by Today only where the server can open it', async () => {
    const able = fixture();
    expect(await able.handlers['yours.today']!({ now: EVENING, before: EVENING + 86_400_000 } as never, paired)).toMatchObject({ close_day: true });
    const unable = fixture({ opener: false });
    expect(await unable.handlers['yours.today']!({ now: EVENING, before: EVENING + 86_400_000 } as never, paired)).not.toHaveProperty('close_day');
    await expect(unable.change({ action: 'close_day.open' })).rejects.toThrow('Close the day is unavailable on this server');
  });
});

describe('D-343 slice 4 — the pursuits a reply to the evening notice lists', () => {
  it('are the owner\'s alone: an AI app, even one that reads assets, is given none', () => {
    const db = new Database(':memory:');
    cleanups.push(() => { db.close(); });
    const contracts = createContractStore(db, { now: () => EVENING });
    contracts.seedSchema(D165_CONTRACT_SCHEMA);
    const agreement = createContractDefinitionStore(contracts, { now: () => EVENING, newId: () => 'ct_app' })
      .mint({ minted_by: 'owner', display_name: 'An AI app', scope: {}, key_authority: 'contract' });
    const grants = createContractGrantEntryStore(contracts);
    for (const entry of ['core.situation.read', 'core.work-entity.read', 'data.asset']) grants.set(agreement.contract_id, entry, true, EVENING);
    const query = createSituationQuery({ now: () => EVENING, sources: [], sourceForCollection: situationSourceAccess });
    const access = createSituationAccess({ contracts, query, now: () => EVENING, isVaultUnlocked: () => true,
      eveningPursuits: () => [{ id: 'p1', name: 'Learn Spanish', private: false }, { id: 'p2', name: 'Run a marathon', private: true }] });
    const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'chat-1' };
    const app: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', contract_id: agreement.contract_id,
      mcp_token_id: 'key-1', agent_id: 'app', tool_call_id: 'call-1' };
    expect(access.eveningPursuits(owner)).toEqual([{ title: 'Learn Spanish', ref: { collection: 'asset', id: 'p1' }, private: false },
      { title: 'Run a marathon', ref: { collection: 'asset', id: 'p2' }, private: true }]);
    expect(access.eveningPursuits(app)).toEqual([]);
  });
});
