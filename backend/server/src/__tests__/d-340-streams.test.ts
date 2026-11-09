/** D-340 slice 2, with slice 6 (rulings 11 and 12) — the daily and weekly streams: one message at its
 *  time holding the parts the owner checks, to the channels they pick. They take over from the
 *  Agenda and Coming up once, carrying over what the owner had (§3.6). Daily and weekly are tabs on
 *  Today, each its own schedule; the messages are "Your day" and "Your week".
 *
 *  Through the real scheduler, its gated read, the Yours service and its rpc handlers. Only the
 *  sources (a few events and one state) and the send are stand-ins. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PURSUIT_CLASS_ID, type ExecutionSource, type InternalToolRegistry, type SituationAgendaStatus, type SituationFact,
  type YoursCommandResult } from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
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
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { agendaSuggestionsCron, agendaSuggestionsPrompt } from '../situations/agenda-suggestions.js';
import { quotedClosingDay } from '../chat-closing-day.js';
import type { NotificationSendArgs } from '../notification-handler.js';

// Monday 19 October 2026, 06:00 UTC (the server's zone is UTC).
const MORNING = Date.parse('2026-10-19T06:00:00Z');
const at = (time: string, day = '2026-10-19') => Date.parse(`${day}T${time}:00Z`);
const fact = (collection: string, id: string, title: string, kind: string, from: number, to: number): SituationFact => ({
  ref: { collection, id }, title, kind, basis: 'declared', when: { from, to }, act_by: from, valid_until: to, people: [], subjects: [], related: [],
  evidence: [{ collection, id }], updated_at: MORNING - 86_400_000, consequence: 'routine' });
const EVENTS = [
  fact('calendar', 'work:run', 'Run 5 km', 'calendar', at('07:00'), at('07:45')),
  fact('calendar', 'work:lunch', 'Lunch with Sam', 'calendar', at('13:00'), at('14:00')),
  fact('calendar', 'work:dentist', 'Dentist', 'calendar', at('09:00', '2026-10-20'), at('10:00', '2026-10-20')),
  fact('calendar', 'work:flight', 'Flight EI 158', 'calendar', at('15:00', '2026-10-22'), at('17:30', '2026-10-22')),
];
// D-340 §4 — a state that holds for its day, as a ring's short night does.
const STATE = { ...fact('asset', 'ring', 'Short night · Oura ring', 'asset_state', at('05:00'), at('22:00')), ref: { collection: 'asset', id: 'ring', field: 'rules.sleep' } };
const paired = { instance_id: 'wc_1', client_kind: 'webclient', user_id: 'owner', client_token_id: 'paired' } as unknown as WsClient;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const fixture = (options: { delivered?: () => string[]; schedules?: true; summarize?: () => Promise<string | undefined>;
  calendar?: SituationFact[]; assets?: SituationFact[] } = {}) => {
  let clock = MORNING; let zone = 'UTC';
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const query = createSituationQuery({ now: () => clock, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }),
    sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => [...EVENTS, ...options.calendar ?? []]) },
      { id: 'asset', collection: 'asset', verb_op: 'core.work-entity.read', read: vi.fn(() => [STATE, ...options.assets ?? []]) }] });
  const sent: NotificationSendArgs[] = [];
  const send = vi.fn(async (message: NotificationSendArgs) => { sent.push(message); return { delivered_to: options.delivered?.() ?? ['telegram'] }; });
  const store = createSituationStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => clock });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => zone, now: () => clock });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: store, now: () => clock, timeZone: () => zone, isVaultUnlocked: () => true });
  // The chat's scheduled prompts, as D-338's test builds them, where a stream's AI suggestions are
  // asked for: their managed schedules are real.
  let schedules: ReturnType<typeof createPromptSchedules> | undefined; let closeQueue = () => {};
  if (options.schedules) {
    const chat = createChatStore(db); const plans = createSqliteChatPlanStore(db);
    const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
    const runTurn = async (input: { queue_turn_id?: string }) => ({ turn_id: input.queue_turn_id! });
    const base = createChatOrchestrator({ chatStore: chat, registry, selfSignature: { server_kind: 'recued', version: '1', instance_id: 'd340' } });
    const queue = withQueuedChatTurns({ ...base, runTurn }, { db, store: chat, pollMs: 10 }).turnQueue!;
    schedules = createPromptSchedules({ db, store: chat, instanceId: 'd340', now: () => clock, runTurn, queue,
      readPlans: (session, turn) => plans.listForTurn(session, turn) });
    closeQueue = () => { queue.close(); };
  }
  // As `compose-collection-context.ts` composes them: Today's overview is the Yours service's.
  const scheduled = createScheduledSituations({ db, work, store, query, timeZone: () => zone, isVaultUnlocked: () => true,
    isQuiet: () => false, now: () => clock, send, overview: () => yours.overview(), promptSchedules: () => schedules,
    ...(options.summarize ? { summarize: options.summarize } : {}) });
  scheduled.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => clock, isVaultUnlocked: () => true }));
  yours.bindScheduled(scheduled);
  cleanups.push(async () => { await yours.stop(); await scheduled.stop(); closeQueue(); db.close(); });
  const handlers = makeYoursHandlers(yours)!.handlers;
  const change = (input: unknown) => handlers['yours.change']!(input as never, paired) as Promise<YoursCommandResult>;
  const agenda = async () => await handlers['yours.agenda']!(undefined, paired) as SituationAgendaStatus;
  return { db, work, store, yours, scheduled, schedules, change, agenda, sent,
    setClock: (value: number) => { clock = value; }, setZone: (value: string) => { zone = value; } };
};

describe('D-340 §3.6 — the streams take over from the Agenda and Coming up, once', () => {
  it('carries a daily Agenda and a daily Coming up into the daily stream, says once that Coming up moved, and sends nothing late', async () => {
    const f = fixture();
    f.scheduled.setAgenda({ enabled: true, time: '07:00', day: 'today', frequency: 'daily', weekday: 1, suggestions: true });
    f.scheduled.setSettings({ frequency: 'daily', time: '08:00', weekday: 1, day_of: true, look_ahead_days: 3 });
    f.setClock(at('09:00'));
    f.scheduled.takeOverStreams();
    const { streams } = await f.agenda();
    expect(streams!.daily.settings).toEqual({ enabled: true, time: '07:00', day: 'today', weekday: 1, agenda: true, coming_up: true,
      look_ahead_days: 3, suggestions: true, due_today: true, include_private: false, reminders: false, channels: null });
    expect(streams!.weekly.settings).toMatchObject({ enabled: false, agenda: false, coming_up: false });
    // Its 07:00 came before it took over: today's does not go late, and tomorrow's goes at 07:00.
    expect(streams!.daily.next_at).toBe(at('07:00', '2026-10-20'));
    await f.scheduled.tick();
    expect(f.sent).toEqual([]);
    f.setClock(at('07:00', '2026-10-20')); await f.scheduled.tick();
    expect(f.sent.map(message => message.title)).toEqual(['Your day · Tue 20 Oct']);
    expect(f.sent[0]!.text.split('\n').slice(0, 2)).toEqual(['Coming up now arrives with your Agenda at 07:00.', '']);
    // Said once.
    expect(f.store.readSetting('situations.stream_fold_note.daily', 'unsaid')).toBe('');
  });

  it('makes a weekly Agenda the weekly stream, its suggestions with it, and a fresh server\'s defaults a daily Due today and a weekly Coming up', async () => {
    const f = fixture();
    f.scheduled.setAgenda({ enabled: true, time: '08:30', day: 'tomorrow', frequency: 'weekly', weekday: 7, suggestions: true });
    f.store.writeSetting('situations.agenda_suggestions', { schedule_id: 'the-agendas' });
    // Where a schedule's conversation is looked up (the chat's scheduled prompts keep the table).
    f.db.exec('CREATE TABLE chat_prompt_schedules (schedule_id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
    f.scheduled.takeOverStreams();
    let { streams } = await f.agenda();
    expect(streams!.weekly.settings).toEqual({ enabled: true, time: '08:30', day: 'tomorrow', weekday: 7, agenda: true, coming_up: true,
      look_ahead_days: 7, suggestions: true, due_today: false, include_private: false, reminders: false, channels: null });
    // The fresh server's weekly Coming up (Monday 08:00) went with its Agenda: it says so.
    expect(f.store.readSetting('situations.stream_fold_note.weekly', '')).toBe('Coming up now arrives with your weekly Agenda, on Sunday at 08:30.');
    // Its suggestions' conversation is the weekly stream's now.
    expect(f.store.readSetting('situations.weekly_suggestions', {})).toEqual({ schedule_id: 'the-agendas' });
    expect(f.store.readSetting('situations.agenda_suggestions', null)).toEqual({});
    expect(streams!.daily.settings).toEqual({ enabled: true, time: '08:00', day: 'today', weekday: 1, agenda: false, coming_up: false,
      look_ahead_days: 7, suggestions: false, due_today: true, include_private: false, reminders: false, channels: null });
    // A server never set up: Due today each day, and Coming up on Mondays, both at 08:00, as before.
    const fresh = fixture(); fresh.scheduled.takeOverStreams();
    ({ streams } = await fresh.agenda());
    expect(streams!.daily.settings).toMatchObject({ enabled: true, time: '08:00', agenda: false, coming_up: false, due_today: true });
    expect(streams!.weekly.settings).toMatchObject({ enabled: true, time: '08:00', weekday: 1, agenda: false, coming_up: true, look_ahead_days: 7 });
  });

  it('takes over once, offers Today its button, and refuses the old settings with where they went', async () => {
    const f = fixture();
    expect(await f.yours.overview()).not.toHaveProperty('stream');
    await expect(f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: true } })).rejects.toThrow('This server has no streams yet');
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { time: '06:45' } });
    f.scheduled.takeOverStreams();
    expect((await f.agenda()).streams!.daily.settings.time).toBe('06:45');
    expect(await f.yours.overview()).toMatchObject({ stream: true });
    const moved = 'Your Agenda and Coming up are part of your daily and weekly streams now. Set them on Today: open Daily stream.';
    for (const input of [{ action: 'agenda.update', settings: { enabled: true } }, { action: 'agenda.send_now' },
      { action: 'delivery.update', settings: { frequency: 'daily' } }, { action: 'delivery.send_now' }, { action: 'settings.update', digest: 'off' }]) {
      await expect(f.change(input)).rejects.toThrow(moved);
    }
    // Coming up's own status says so, and its card leaves.
    expect(f.scheduled.status()).toMatchObject({ streams: true });
  });

  it('reads a stream setting it did not write itself as one it accepts', async () => {
    const f = fixture(); f.scheduled.takeOverStreams();
    // A setting from a later Recued, or edited by hand: each field it does not accept reads as its default.
    f.store.writeSetting('situations.streams', { daily: { time: '7:5', channels: ['fax'], look_ahead_days: 5 },
      weekly: { enabled: true, look_ahead_days: 3, due_today: true } });
    const { streams } = await f.agenda();
    expect(streams!.daily.settings).toMatchObject({ time: '07:30', channels: null, look_ahead_days: 7 });
    expect(streams!.weekly.settings).toMatchObject({ enabled: true, look_ahead_days: 7, due_today: false });
  });

  it('does not send late a run the owner\'s change left in the past: moved at 09:00 to 08:00, it waits for tomorrow', async () => {
    const f = fixture(); f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: true, time: '07:30', agenda: true } });
    await f.change({ action: 'stream.update', stream: 'weekly', settings: { enabled: false } });
    f.setClock(at('09:00'));
    await f.change({ action: 'stream.update', stream: 'daily', settings: { time: '08:00' } });
    await f.scheduled.tick();
    expect(f.sent).toEqual([]);
    expect((await f.agenda()).streams!.daily.next_at).toBe(at('08:00', '2026-10-20'));
  });
});

describe('D-340 §3.2 — one message at its time', () => {
  const daily = async (f: ReturnType<typeof fixture>, settings: Record<string, unknown>) => {
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: true, time: '07:30', day: 'today', ...settings } });
    await f.change({ action: 'stream.update', stream: 'weekly', settings: { enabled: false } });
  };

  it('sends "Your day": what holds today, the Agenda, and Coming up after it, each part but the first under its heading', async () => {
    const f = fixture();
    await daily(f, { agenda: true, coming_up: true, look_ahead_days: 3, due_today: false });
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent).toEqual([{ title: 'Your day · Mon 19 Oct', ui_link_url: '#today', text: [
      'Short night · Oura ring · until 22:00', '',
      'Agenda', '07:00 Run 5 km', '13:00 Lunch with Sam', '',
      'Coming up', 'Dentist · 2026-10-20', 'Flight EI 158 · 2026-10-22'].join('\n') }]);
    expect((await f.agenda()).streams!.daily).toMatchObject({ last_run: { mode: 'stream', state: 'sent' }, next_at: at('07:30', '2026-10-20') });
  });

  it('leaves out a part with nothing in it, shows Due today on a day with no Agenda, and sends nothing when every part is empty', async () => {
    const f = fixture();
    await daily(f, { agenda: false, coming_up: false, due_today: false });
    f.setClock(at('07:30')); await f.scheduled.tick();
    // What holds today alone is still something to say.
    expect(f.sent.map(message => message.text)).toEqual(['Short night · Oura ring · until 22:00']);
    await f.change({ action: 'stream.update', stream: 'daily', settings: { due_today: true } });
    f.setClock(at('07:30', '2026-10-20')); await f.scheduled.tick();
    expect(f.sent.at(-1)!.text).toBe('Due today\nDentist · 2026-10-20');
    // Nothing on, nothing holding, nothing changed: the run is skipped and nothing goes.
    f.setClock(at('07:30', '2026-10-21')); await f.scheduled.tick();
    expect(f.sent).toHaveLength(2);
    expect((await f.agenda()).streams!.daily.last_run).toMatchObject({ state: 'skipped' });
  });

  it('leaves out a state the owner set aside, and a private one until Include private items (slice 5)', async () => {
    const agendaOnly = 'Agenda\n07:00 Run 5 km\n13:00 Lunch with Sam';
    // The ring's readings are private by its own setting (D-338).
    const f = fixture();
    await daily(f, { agenda: true, coming_up: false, due_today: false });
    f.work.writeAsset({ id: 'ring', source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Oura ring',
      settings: { sensitive: true } } as never, MORNING - 86_400_000);
    await f.change({ action: 'stream.send_now', stream: 'daily' });
    expect(f.sent.map(message => message.text)).toEqual([agendaOnly]);
    // "Not now" on Today: a state shared with no one stays out too.
    const g = fixture();
    await daily(g, { agenda: true, coming_up: false, due_today: false });
    await g.change({ action: 'situation.dismiss', ref: STATE.ref, kind: 'asset_state', code: 'not_now', label: 'Short night' });
    await g.change({ action: 'stream.send_now', stream: 'daily' });
    expect(g.sent.map(message => message.text)).toEqual([agendaOnly]);
  });

  it('leaves out Due today beside the Agenda, which lists what is due that day', async () => {
    const f = fixture();
    // As a takeover carries a daily Coming up's Due today into a stream that holds the Agenda.
    await daily(f, { agenda: true, coming_up: false, due_today: true });
    f.setClock(at('07:30', '2026-10-20')); await f.scheduled.tick();
    expect(f.sent.map(message => message.text)).toEqual(['Agenda\n09:00 Dentist']);
  });

  it('counts Coming up as sent only once the stream went, so the next day repeats nothing unchanged', async () => {
    let reached = ['telegram']; const f = fixture({ delivered: () => reached });
    await daily(f, { agenda: true, coming_up: true, look_ahead_days: 7, due_today: false });
    reached = [];
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent[0]!.text).toContain('Coming up\nDentist · 2026-10-20');
    // Not delivered: it waits to retry, and Coming up is still news.
    expect((await f.agenda()).streams!.daily.last_run).toMatchObject({ state: 'pending' });
    reached = ['telegram'];
    f.setClock(at('07:35')); await f.scheduled.tick();
    expect(f.sent[1]!.text).toContain('Coming up\nDentist · 2026-10-20');
    f.setClock(at('07:30', '2026-10-20')); await f.scheduled.tick();
    expect(f.sent[2]!.title).toBe('Your day · Tue 20 Oct');
    // The Dentist is on the Agenda now, and the flight has not changed. Yesterday's run is resolved,
    // which Coming up has always said once.
    expect(f.sent[2]!.text).not.toMatch(/Dentist · |Flight EI 158/u);
  });

  it('sends "Your week" for its seven days, a day at a time, with no states and no Due today', async () => {
    const f = fixture();
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: false } });
    await f.change({ action: 'stream.update', stream: 'weekly', settings: { enabled: true, time: '07:30', weekday: 1, day: 'today',
      agenda: true, coming_up: false } });
    await expect(f.change({ action: 'stream.update', stream: 'weekly', settings: { due_today: true } })).rejects.toThrow('Due today goes with the daily stream');
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent).toEqual([{ title: 'Your week · Mon 19 Oct to Sun 25 Oct', ui_link_url: '#today', text: [
      'Agenda', 'Mon 19 Oct', '07:00 Run 5 km', '13:00 Lunch with Sam', '', 'Tue 20 Oct', '09:00 Dentist', '', 'Thu 22 Oct', '15:00 Flight EI 158'].join('\n') }]);
    expect((await f.agenda()).streams!.weekly.last_run).toMatchObject({ mode: 'stream_week', state: 'sent' });
  });

  it('goes to the channels the owner picked, Close the day with it, and to every channel set up when none is picked', async () => {
    const f = fixture();
    await daily(f, { agenda: true, coming_up: false, channels: ['telegram', 'in_app'] });
    await f.change({ action: 'close_day.update', settings: { enabled: true } });
    await f.change({ action: 'stream.send_now', stream: 'daily' });
    await f.change({ action: 'close_day.send_now' });
    expect(f.sent.map(message => [message.title, message.channels])).toEqual([
      ['Your day · Mon 19 Oct', ['telegram', 'in_app']], ['Close the day · Mon 19 Oct', ['telegram', 'in_app']]]);
    await f.change({ action: 'stream.update', stream: 'daily', settings: { channels: null } });
    await f.change({ action: 'stream.send_now', stream: 'daily' });
    expect(f.sent.at(-1)).not.toHaveProperty('channels');
    for (const channels of [[], ['fax'], ['telegram', 'telegram']]) {
      await expect(f.change({ action: 'stream.update', stream: 'daily', settings: { channels } })).rejects.toThrow('Choose a valid stream schedule');
    }
    await expect(f.change({ action: 'stream.update', stream: 'weekly', settings: { look_ahead_days: 3 } })).rejects.toThrow('A weekly stream looks at least 7 days ahead');
  });
});

describe('D-340 slice 2 — each stream\'s AI suggestions are its own (§3.3, ruling 11)', () => {
  it('get a schedule of their own, run and notify on their own stream\'s run, read the pursuits, and follow its zone', async () => {
    const f = fixture({ schedules: true });
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: false } });
    const settings = { enabled: true, time: '07:30', weekday: 1, day: 'today' as const, agenda: true, suggestions: true };
    await f.change({ action: 'stream.update', stream: 'weekly', settings });
    // The weekly stream's save made its schedule: the weekly Agenda's request, at its time.
    const managed = (await f.schedules!.list(undefined, { managed: true })).filter(row => row.managed_by === 'agenda');
    expect(managed).toHaveLength(1);
    // D-340 slice 4 — a stream's start ten minutes ahead of it (§3.3), so it can carry them.
    const weekly = managed[0]!; const asAgenda = { ...settings, frequency: 'weekly' as const, head_start: true };
    expect(f.store.readSetting('situations.weekly_suggestions', {})).toEqual({ schedule_id: weekly.schedule_id });
    expect(weekly).toMatchObject({ prompt: agendaSuggestionsPrompt(asAgenda), cron_expression: '20 7 * * 1', time_zone: 'UTC' });
    expect(agendaSuggestionsCron(asAgenda)).toBe('20 7 * * 1');
    // They run on the weekly stream's run, which lists the week; the daily stream's (off) run none.
    const due = at('07:30');
    expect(await f.scheduled.agendaRunGate(weekly, due)).toBe('run');
    expect(await f.scheduled.agendaRunGate({ ...weekly, schedule_id: 'the-daily-streams' }, due)).toBe('skip');
    // Their answer waits for the week's message, then goes.
    expect(f.scheduled.agendaDoneGate(weekly, { due_at: due })).toBe('wait');
    f.setClock(due); await f.scheduled.tick();
    expect(f.sent.map(message => message.title)).toEqual(['Your week · Mon 19 Oct to Sun 25 Oct']);
    expect(f.scheduled.agendaDoneGate(weekly, { due_at: due })).toBe('notify');
    // D-342 §5: their run reads the owner's pursuits, and no other run does.
    const run = (schedule_id: string) => ({ channel: 'schedule', actor: 'system', schedule_id,
      prompt_schedule: { schedule_id, occurrence_id: 'occurrence-1', revision: 1, due_at: due, cron: weekly.cron_expression } }) as ExecutionSource;
    expect(f.scheduled.readsPursuits(run(weekly.schedule_id))).toBe(true);
    expect(f.scheduled.readsPursuits(run('the-daily-streams'))).toBe(false);
    // A server zone that moved: the next tick brings the schedule in line, with no save.
    f.setZone('Europe/Dublin'); await f.scheduled.tick();
    expect((await f.schedules!.get(weekly.schedule_id)).time_zone).toBe('Europe/Dublin');
  });
});

describe('D-340 slice 5 — Include private items (§3.4)', () => {
  // A visa appointment today that cites the passport, and the passport's expiry in two days: both
  // private once the passport is, as the ring's short night is once the ring is.
  const VISA = { ...fact('calendar', 'work:visa', 'Visa appointment', 'calendar', at('11:00'), at('11:30')),
    evidence: [{ collection: 'calendar', id: 'work:visa' }, { collection: 'asset', id: 'passport' }] };
  const EXPIRY = fact('asset', 'passport', 'Passport expires', 'expiry', at('09:00', '2026-10-21'), at('09:00', '2026-10-21'));
  const world = async (include_private: boolean) => {
    const f = fixture({ calendar: [VISA], assets: [EXPIRY] });
    for (const [id, name] of [['ring', 'Oura ring'], ['passport', 'Passport']] as const) {
      f.work.writeAsset({ id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name, settings: { sensitive: true } } as never, MORNING - 86_400_000);
    }
    f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Learn Spanish', class_id: PURSUIT_CLASS_ID,
      settings: { sensitive: true, evening: true } } as never, MORNING - 86_400_000);
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: true, time: '07:30', day: 'today', agenda: true, coming_up: true,
      look_ahead_days: 3, due_today: false, include_private } });
    await f.change({ action: 'stream.update', stream: 'weekly', settings: { enabled: false } });
    return f;
  };

  it('names private items in every part of a stream that includes them, Close the day too, and in none of one that does not', async () => {
    const off = await world(false);
    await expect(off.change({ action: 'stream.update', stream: 'daily', settings: { include_private: 'yes' } })).rejects.toThrow('Choose a valid stream schedule');
    off.setClock(at('07:30')); await off.scheduled.tick(); await off.change({ action: 'close_day.send_now' });
    const [morning, evening] = off.sent.map(message => message.text);
    expect(morning).not.toMatch(/Short night|Visa|Passport/u);
    expect(morning).toContain('11:00 Reminder in Yours');
    expect(evening).not.toMatch(/Visa|Spanish/u);
    expect(evening).toContain('Pursuit: a pursuit in Yours');
    const on = await world(true);
    on.setClock(at('07:30')); await on.scheduled.tick(); await on.change({ action: 'close_day.send_now' });
    const [named, closing] = on.sent.map(message => message.text);
    // What holds today, the Agenda, Coming up.
    expect(named!.split('\n')[0]).toBe('Short night · Oura ring · until 22:00');
    expect(named).toContain('11:00 Visa appointment');
    expect(named).toMatch(/^Passport expires · 2026-10-21$/mu);
    expect(named).not.toContain('Reminder in Yours');
    expect(closing).toContain('Visa appointment');
    expect(closing).toContain('Pursuit: Learn Spanish');
  });

  it('lets a reply\'s closing note name what the quoted stream named, by its title', async () => {
    const f = await world(true);
    expect(f.scheduled.namesPrivateIn('Your day · Mon 19 Oct')).toBe(true);
    expect(f.scheduled.namesPrivateIn('Close the day · Mon 19 Oct')).toBe(true);
    expect(f.scheduled.namesPrivateIn('Your week · Mon 19 Oct to Sun 25 Oct')).toBe(false);
    expect(f.scheduled.namesPrivateIn('Agenda · Mon 19 Oct')).toBe(false);
    expect((await world(false)).scheduled.namesPrivateIn('Your day · Mon 19 Oct')).toBe(false);
  });

  it('lets the stream\'s AI suggestions name a private item or pursuit, rewriting their schedule\'s request on a save', async () => {
    const f = fixture({ schedules: true });
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: true, time: '07:30', agenda: true, suggestions: true } });
    const [schedule] = (await f.schedules!.list(undefined, { managed: true })).filter(row => row.managed_by === 'agenda');
    expect(schedule!.prompt).toContain('Leave out a pursuit marked private.');
    await f.change({ action: 'stream.update', stream: 'daily', settings: { include_private: true } });
    const named = await f.schedules!.get(schedule!.schedule_id);
    expect(named.prompt).toContain('This reply goes to my notifications, where I chose to have my private items named: you may name an item or '
      + 'pursuit marked private and suggest about it like any other.');
    expect(named.prompt).not.toMatch(/Leave out|a reminder in Yours/u);
    expect(named.prompt).toContain('as a short list of plain lines, without bold (my notifications show it as asterisks)');
    // The same conversation, its words rewritten.
    expect(named.session_id).toBe(schedule!.session_id);
  });
});

describe('D-340 §3.7 — the preview of the next message', () => {
  it('gives its time, how many lines each part holds and its text, and marks nothing', async () => {
    const summarize = vi.fn(async (): Promise<string | undefined> => undefined);
    const f = fixture({ summarize });
    f.scheduled.takeOverStreams();
    await f.change({ action: 'stream.update', stream: 'daily', settings: { enabled: true, time: '07:30', day: 'today', agenda: true, coming_up: true,
      look_ahead_days: 3, due_today: false } });
    const { preview } = await f.change({ action: 'stream.preview', stream: 'daily' });
    expect(preview).toEqual({ title: 'Your day · Mon 19 Oct', counts: { states: 1, agenda: 2, due_today: 0, coming_up: 2, reminders: 0, suggestions: 0 }, next_at: at('07:30'), time_zone: 'UTC',
      text: 'Short night · Oura ring · until 22:00\n\nAgenda\n07:00 Run 5 km\n13:00 Lunch with Sam\n\nComing up\nDentist · 2026-10-20\nFlight EI 158 · 2026-10-22' });
    // Nothing was marked sent: the stream itself still carries Coming up. And no group was kept, nor a
    // model asked for its summary, which the stream itself does, as Coming up always has.
    expect(summarize).not.toHaveBeenCalled(); expect(f.store.walk('situation-', 10)).toEqual([]);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent[0]!.text).toContain('Coming up\nDentist · 2026-10-20');
    expect(summarize).toHaveBeenCalled(); expect(f.store.walk('situation-', 10)).not.toEqual([]);
  });
});

describe('D-340 ruling 12 — a reply to the stream closes its day or its week (D-343 slice 3)', () => {
  const quoting = (text: string) => JSON.stringify({ reply_to: { message_id: 'notice:1', role: 'notice', text }, message: 'Ran it.' });
  it('reads the day or the days from its title', () => {
    expect(quotedClosingDay(quoting('Your day · Mon 19 Oct\n07:00 Run 5 km'), '2026-10-19')).toEqual({ title: 'Your day · Mon 19 Oct', from: '2026-10-19', to: '2026-10-19' });
    expect(quotedClosingDay(quoting('Your week · Mon 19 Oct to Sun 25 Oct\nAgenda'), '2026-10-21'))
      .toEqual({ title: 'Your week · Mon 19 Oct to Sun 25 Oct', from: '2026-10-19', to: '2026-10-25' });
  });
});
