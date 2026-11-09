/** D-340 slice 4 — the AI suggestions inside the stream (§3.2, §3.3, ruling 9). Their run starts ten
 *  minutes ahead of the stream, which carries them when they finished: under what holds today, ending
 *  with "Talk it over", their conversation. Carried, they never go again on their own. A run still
 *  going when the stream goes follows on its own as before, and one that ran out of its lookups says
 *  nothing. Today shows the day's.
 *
 *  Through the real scheduler, its gated read, the Yours service, the scheduled-prompt service, its
 *  turn queue and the done notices. Only the sources and the send are stand-ins, and a turn writes
 *  its answer: no model runs. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSource, InternalToolRegistry, SituationFact, YoursCommandResult } from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';
import type { WsClient } from '../ws-server.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { createYoursService } from '../situations/yours-service.js';
import { makeYoursHandlers } from '../situations/yours-handler.js';
import { agendaSuggestionsCron, SUGGESTIONS_TOOL_ROUNDS } from '../situations/agenda-suggestions.js';
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
import { createPromptScheduleDoneRuntime, DONE_TEXT_MAX_CHARS } from '../prompt-schedule-done.js';
import { TOOL_BUDGET_EXHAUSTED_MESSAGE } from '../chat-turn-budget.js';
import type { NotificationSendArgs } from '../notification-handler.js';

// Monday 19 October 2026, 06:00 UTC (the server's zone is UTC).
const MORNING = Date.parse('2026-10-19T06:00:00Z');
const at = (time: string, day = '2026-10-19') => Date.parse(`${day}T${time}:00Z`);
const fact = (collection: string, id: string, title: string, kind: string, from: number, to: number): SituationFact => ({
  ref: { collection, id }, title, kind, basis: 'declared', when: { from, to }, act_by: from, valid_until: to, people: [], subjects: [], related: [],
  evidence: [{ collection, id }], updated_at: MORNING - 86_400_000, consequence: 'routine' });
// Monday's run and lunch, Tuesday's dentist, nothing on Wednesday, Thursday's flight.
const EVENTS = [
  fact('calendar', 'work:run', 'Run 5 km', 'calendar', at('07:00'), at('07:45')),
  fact('calendar', 'work:lunch', 'Lunch with Sam', 'calendar', at('13:00'), at('14:00')),
  fact('calendar', 'work:dentist', 'Dentist', 'calendar', at('09:00', '2026-10-20'), at('10:00', '2026-10-20')),
  fact('calendar', 'work:flight', 'Flight EI 158', 'calendar', at('15:00', '2026-10-22'), at('17:30', '2026-10-22')),
];
const STATE = { ...fact('asset', 'ring', 'Short night · Oura ring', 'asset_state', at('05:00'), at('22:00')), ref: { collection: 'asset', id: 'ring', field: 'rules.sleep' } };
const ANSWER = 'Leave at 06:40 for the run: the park gates open at 06:45.\nBring the gym bag to lunch.';
const BASE = 'https://owner.example.test/';
const signature = { server_kind: 'recued' as const, version: 'fixture', instance_id: 'd340-s4' };
const paired = { instance_id: 'wc_1', client_kind: 'webclient', user_id: 'owner', client_token_id: 'paired' } as unknown as WsClient;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

/** `base`: the server's public address, or null for none. `quietEnd`: quiet hours, as the stream reads them. */
const fixture = (options: { base?: string | null; quietEnd?: (minute: number) => number | null } = {}) => {
  let clock = MORNING;
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const query = createSituationQuery({ now: () => clock, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }),
    sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => EVENTS) },
      { id: 'asset', collection: 'asset', verb_op: 'core.work-entity.read', read: vi.fn(() => [STATE]) }] });
  const sent: NotificationSendArgs[] = [];
  const send = vi.fn(async (message: NotificationSendArgs) => { sent.push(message); return { delivered_to: ['telegram'] }; });
  const store = createSituationStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => clock });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => clock });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: store, now: () => clock, timeZone: () => 'UTC', isVaultUnlocked: () => true });
  // The chat's scheduled prompts, where a stream's AI suggestions are asked for. A turn writes its
  // conversation's answer, after `holding` lets it go.
  const chat = createChatStore(db); const plans = createSqliteChatPlanStore(db);
  const answers = new Map<string, string>(); const failing = new Set<string>(); let holding: Promise<void> | undefined;
  const runTurn = async (input: { queue_turn_id?: string; session_id: string }): Promise<{ turn_id: string }> => {
    if (holding) await holding;
    await chat.appendMessage({ id: `answer:${input.queue_turn_id}`, session_id: input.session_id, role: 'assistant',
      content: answers.get(input.session_id) ?? ANSWER, turn_id: input.queue_turn_id!, target_server: 'self', ts: clock,
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
    // A run that wrote its answer and then failed.
    if (failing.has(input.session_id)) throw new Error('provider failure');
    return { turn_id: input.queue_turn_id! };
  };
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const base = createChatOrchestrator({ chatStore: chat, registry, selfSignature: signature });
  const queue = withQueuedChatTurns({ ...base, runTurn }, { db, store: chat, pollMs: 10 }).turnQueue!;
  const schedules = createPromptSchedules({ db, store: chat, instanceId: 'd340-s4', now: () => clock, runTurn, queue,
    readPlans: (session, turn) => plans.listForTurn(session, turn) });
  // As `compose-collection-context.ts` and `compose-listeners.ts` compose them.
  const scheduled = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true,
    isQuiet: () => false, now: () => clock, send, overview: () => yours.overview(), promptSchedules: () => schedules,
    ...(options.quietEnd ? { quietEnd: options.quietEnd } : {}) });
  scheduled.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => clock, isVaultUnlocked: () => true }));
  schedules.setRunGate('agenda', (schedule, due_at) => scheduled.agendaRunGate(schedule, due_at));
  yours.bindScheduled(scheduled);
  const readAnswer = async (session_id: string, message_id: string) => (await chat.listMessagePage(session_id, 1, undefined, { around_message_id: message_id }))
    .messages.find(message => message.id === message_id);
  scheduled.bindSuggestionAnswers({ readAnswer, publicBaseUrl: () => (options.base === undefined ? BASE : options.base) });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const notify = vi.fn<NotificationBlock['notify']>(async () => {});
  const done = createPromptScheduleDoneRuntime({ db, schedules, auditLog: { logActivity: vi.fn(async () => {}) }, notifier: { notify },
    readAnswer, now: () => clock, canRun: () => true, getPublicBaseUrl: () => BASE, isQuiet: () => false, gate: scheduled.agendaDoneGate });
  cleanups.push(async () => { done.stop(); await yours.stop(); await scheduled.stop(); queue.close(); db.close(); });
  const handlers = makeYoursHandlers(yours)!.handlers;
  const change = (input: unknown) => handlers['yours.change']!(input as never, paired) as Promise<YoursCommandResult>;
  /** A stream's suggestions' schedule. */
  const suggestions = async (kind: 'daily' | 'weekly' = 'daily') => {
    const id = store.readSetting<{ schedule_id?: string }>(kind === 'daily' ? 'situations.agenda_suggestions' : 'situations.weekly_suggestions', {}).schedule_id;
    return await schedules.get(id!);
  };
  const settled = (session: string) => vi.waitFor(async () => {
    const rows = (await queue.snapshot(session)).turns;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(row => ['queued', 'running', 'cancelling'].includes(row.status))).toBe(false);
  });
  /** The suggestions' clock admits what is due at `time`, and the queue finishes it. */
  const clockRun = async (time: number, kind: 'daily' | 'weekly' = 'daily') => { clock = time; await schedules.tick(); await settled((await suggestions(kind)).session_id); };
  /** The daily stream, with its Agenda and AI suggestions, at `time`. */
  const stream = async (time: string, kind: 'daily' | 'weekly' = 'daily', day: 'today' | 'tomorrow' = 'today') => {
    await change({ action: 'stream.update', stream: kind, settings: { enabled: true, time, day, weekday: 1, agenda: true, suggestions: true } });
  };
  scheduled.takeOverStreams();
  return { db, scheduled, yours, schedules, change, sent, notify, done, suggestions, settled, clockRun, stream, answers, failing,
    setClock: (value: number) => { clock = value; },
    hold: () => { let release = () => {}; holding = new Promise<void>(resolve => { release = resolve; }); return () => { holding = undefined; release(); }; },
    claim: (schedule_id: string) => (db.prepare('SELECT outcome FROM chat_prompt_done_notices WHERE schedule_id=?').all(schedule_id) as Array<{ outcome: string }>)
      .map(row => row.outcome) };
};

describe('D-340 slice 4 — the AI suggestions start ahead of the stream (§3.3, ruling 9)', () => {
  it('start ten minutes before it, know their lookups are few, and keep the Agenda\'s own time', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    expect(schedule.cron_expression).toBe('20 7 * * *');
    expect(schedule.prompt).toContain('My agenda for today goes to me in a few minutes.');
    // The read holds the pursuits and their recorded days, and the lookups are a ceiling in no order:
    // told there was "room for 2 lookups after reading today", 7 of 15 live runs spent a second round
    // looking for what the owner had done on a pursuit.
    expect(schedule.prompt).toContain('That read has what most suggestions need, my pursuits and the days I recorded each too: look '
      + `something else up only if a suggestion cannot do without it, at most ${String(SUGGESTIONS_TOOL_ROUNDS - 1)} lookups besides the read.`);
    expect(schedule.prompt).not.toContain('after reading');
    // At its day's first minutes, the evening before: the day before's weekday for a weekly one.
    const agenda = { enabled: true, time: '00:05', day: 'today' as const, frequency: 'daily' as const, weekday: 1, suggestions: true };
    expect(agendaSuggestionsCron({ ...agenda, head_start: true })).toBe('55 23 * * *');
    expect(agendaSuggestionsCron({ ...agenda, frequency: 'weekly', head_start: true })).toBe('55 23 * * 0');
    expect(agendaSuggestionsCron({ ...agenda, frequency: 'weekly', weekday: 7, head_start: true })).toBe('55 23 * * 6');
    expect(agendaSuggestionsCron({ ...agenda, time: '00:10', frequency: 'weekly', weekday: 7, head_start: true })).toBe('0 0 * * 0');
    // The Agenda's own, before the streams, run at its time.
    expect(agendaSuggestionsCron(agenda)).toBe('5 0 * * *');
  });

  it('take the stream\'s own rounds, and no other run does', async () => {
    const f = fixture();
    await f.stream('07:30'); await f.stream('07:30', 'weekly');
    const run = (schedule_id: string) => ({ channel: 'schedule', actor: 'system', schedule_id,
      prompt_schedule: { schedule_id, occurrence_id: 'occurrence-1', revision: 1, due_at: at('07:20'), cron: '20 7 * * *' } }) as ExecutionSource;
    expect(f.scheduled.suggestionsToolRounds(run((await f.suggestions()).schedule_id))).toBe(SUGGESTIONS_TOOL_ROUNDS);
    expect(f.scheduled.suggestionsToolRounds(run((await f.suggestions('weekly')).schedule_id))).toBe(SUGGESTIONS_TOOL_ROUNDS);
    expect(f.scheduled.suggestionsToolRounds(run('someone-elses'))).toBeUndefined();
    expect(f.scheduled.suggestionsToolRounds({ channel: 'chat', actor: 'user_self' } as ExecutionSource)).toBeUndefined();
  });

  it('run for the day the stream goes: one at 00:05 reads the next day the evening before, and goes inside it', async () => {
    const f = fixture();
    await f.stream('00:05');
    const schedule = await f.suggestions();
    expect(schedule.cron_expression).toBe('55 23 * * *');
    // Tuesday has the dentist and Wednesday nothing: Tuesday evening's run would read Wednesday's.
    expect(await f.scheduled.agendaRunGate(schedule, at('23:55', '2026-10-20'))).toBe('skip');
    expect(await f.scheduled.agendaRunGate(schedule, at('23:55', '2026-10-21'))).toBe('run');
    // Monday evening's run is Tuesday's, and Tuesday's stream carries it.
    await f.clockRun(at('23:55'));
    f.setClock(at('00:05', '2026-10-20')); await f.scheduled.tick();
    expect(f.sent.map(message => message.title)).toEqual(['Your day · Tue 20 Oct']);
    expect(f.sent[0]!.text).toContain(`Suggestions\n${ANSWER}\n`);
    expect((await f.yours.overview()).suggestions).toEqual({ text: ANSWER, session_id: schedule.session_id, day: '2026-10-20' });
  });
});

describe('D-340 slice 4 — the stream carries them (§3.2, §3.3)', () => {
  it('in a stream that lists tomorrow: the ones that ran ahead of it today', async () => {
    const f = fixture();
    await f.stream('07:30', 'daily', 'tomorrow');
    await f.clockRun(at('07:20'));
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent.map(message => message.title)).toEqual(['Your day · Tue 20 Oct']);
    expect(f.sent[0]!.text).toContain(`Suggestions\n${ANSWER}\n`);
  });

  it('when quiet hours carry its time past midnight: the evening\'s, in the morning\'s stream', async () => {
    // A stream at 23:30, in quiet hours from 23:00 to 07:00: it goes at 07:00 the morning after.
    const f = fixture({ quietEnd: minute => minute >= 23 * 60 ? 7 * 60 : null });
    await f.stream('23:30');
    expect((await f.suggestions()).cron_expression).toBe('20 23 * * *');
    // Monday evening's run is for Tuesday morning's stream, which lists Tuesday's dentist.
    await f.clockRun(at('23:20'));
    f.setClock(at('07:00', '2026-10-20')); await f.scheduled.tick();
    expect(f.sent.map(message => message.title)).toEqual(['Your day · Tue 20 Oct']);
    expect(f.sent[0]!.text).toContain(`Suggestions\n${ANSWER}\n`);
  });

  it('in a Send now before the stream\'s time, which then goes without them', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    await f.clockRun(at('07:20'));
    f.setClock(at('07:25')); await f.change({ action: 'stream.send_now', stream: 'daily' });
    expect(f.sent[0]!.text).toContain(`Suggestions\n${ANSWER}\n`);
    expect(f.claim(schedule.schedule_id)).toEqual(['included']);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.text).not.toContain('Suggestions');
  });

  it('under what holds today, ending with "Talk it over", and they do not go again on their own', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    await f.clockRun(at('07:20'));
    // Finished, they wait for the stream, and its preview counts them.
    await f.done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    const { preview } = await f.change({ action: 'stream.preview', stream: 'daily' });
    expect(preview!.counts.suggestions).toBe(1);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent.map(message => message.text)).toEqual([['Short night · Oura ring · until 22:00', '',
      'Suggestions', ...ANSWER.split('\n'), `Talk it over: https://owner.example.test/#chat/session/${encodeURIComponent(schedule.session_id)}`, '',
      'Agenda', '07:00 Run 5 km', '13:00 Lunch with Sam'].join('\n')]);
    expect(f.claim(schedule.schedule_id)).toEqual(['included']);
    await f.done.tick(); await f.done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    // A Send now later that day does not carry them again; Today still shows them.
    await f.change({ action: 'stream.send_now', stream: 'daily' });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.text).not.toContain('Suggestions');
    expect((await f.yours.overview()).suggestions).toEqual({ text: ANSWER, session_id: schedule.session_id, day: '2026-10-19' });
    // The next day's Today does not show them.
    f.setClock(at('06:00', '2026-10-20'));
    expect((await f.yours.overview()).suggestions).toBeUndefined();
  });

  it('cuts a long answer as a notice does, and says where to reply without a public address', async () => {
    const f = fixture({ base: null });
    await f.stream('07:30');
    const schedule = await f.suggestions();
    f.answers.set(schedule.session_id, `${'x'.repeat(DONE_TEXT_MAX_CHARS)}END`);
    await f.clockRun(at('07:20'));
    f.setClock(at('07:30')); await f.scheduled.tick();
    const lines = f.sent[0]!.text.split('\n');
    expect(lines.slice(2, 5)).toEqual(['Suggestions', `${'x'.repeat(DONE_TEXT_MAX_CHARS)}…`, 'Talk it over: reply to this message, or open Today in Recued.']);
    expect((await f.yours.overview()).suggestions!.text).toBe(`${'x'.repeat(DONE_TEXT_MAX_CHARS)}…`);
  });

  it('a weekly stream carries its own, and the daily one its own', async () => {
    const f = fixture();
    await f.stream('07:30'); await f.stream('07:30', 'weekly');
    const daily = await f.suggestions(); const weekly = await f.suggestions('weekly');
    expect(weekly.cron_expression).toBe('20 7 * * 1');
    f.answers.set(daily.session_id, 'Daily: leave at 06:40.'); f.answers.set(weekly.session_id, 'Weekly: book the dentist taxi.');
    f.setClock(at('07:20')); await f.schedules.tick(); await f.settled(daily.session_id); await f.settled(weekly.session_id);
    f.setClock(at('07:30')); await f.scheduled.tick();
    const byTitle = Object.fromEntries(f.sent.map(message => [message.title?.split(' · ')[0], message.text]));
    expect(byTitle['Your day']).toContain('Suggestions\nDaily: leave at 06:40.\n');
    expect(byTitle['Your day']).not.toContain('Weekly:');
    expect(byTitle['Your week']).toContain('Suggestions\nWeekly: book the dentist taxi.\n');
    expect(byTitle['Your week']).not.toContain('Daily:');
    expect([...f.claim(daily.schedule_id), ...f.claim(weekly.schedule_id)]).toEqual(['included', 'included']);
  });
});

describe('D-340 slice 4 — what the stream does not carry (§3.3)', () => {
  it('lets a run still going when the stream goes follow on its own, as before', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    const release = f.hold();
    f.setClock(at('07:20')); await f.schedules.tick();
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).not.toContain('Suggestions');
    release(); await f.settled(schedule.session_id);
    await f.done.tick();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]![0]).toMatchObject({ title: 'Agenda suggestions', text: ANSWER });
    expect(f.claim(schedule.schedule_id)).toEqual(['sent']);
    // Today shows them all the same.
    expect((await f.yours.overview()).suggestions).toEqual({ text: ANSWER, session_id: schedule.session_id, day: '2026-10-19' });
  });

  it('leaves out a run that failed, whatever it wrote', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    f.failing.add(schedule.session_id);
    await f.clockRun(at('07:20'));
    expect((await f.schedules.get(schedule.schedule_id)).last_outcome).toMatchObject({ status: 'failed' });
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent[0]!.text).not.toContain('Suggestions');
    expect((await f.yours.overview()).suggestions).toBeUndefined();
  });

  it('leaves out a Run now the owner started', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    f.setClock(at('07:25'));
    await f.schedules.runNow({ schedule_id: schedule.schedule_id, expected_revision: schedule.revision, submission_id: 'by-hand' });
    await f.settled(schedule.session_id);
    expect((await f.schedules.get(schedule.schedule_id)).last_outcome?.status).toBe('finished');
    const { preview } = await f.change({ action: 'stream.preview', stream: 'daily' });
    expect(preview!.counts.suggestions).toBe(0);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent[0]!.text).not.toContain('Suggestions');
    expect((await f.yours.overview()).suggestions).toBeUndefined();
  });

  it('says nothing of a run that ran out of its lookups: not in the stream, no notice, not on Today', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    f.answers.set(schedule.session_id, `I read the day.\n\n${TOOL_BUDGET_EXHAUSTED_MESSAGE}`);
    await f.clockRun(at('07:20'));
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent[0]!.text).not.toContain('Suggestions');
    await f.done.tick(); await f.done.tick();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.claim(schedule.schedule_id)).toEqual(['skipped']);
    expect((await f.yours.overview()).suggestions).toBeUndefined();
  });

  it('carries nothing with the suggestions off, or from another day', async () => {
    const f = fixture();
    await f.stream('07:30');
    const schedule = await f.suggestions();
    await f.clockRun(at('07:20'));
    // Monday's, unsent, are not Tuesday's.
    f.setClock(at('07:30', '2026-10-20'));
    const { preview } = await f.change({ action: 'stream.preview', stream: 'daily' });
    expect(preview!.counts.suggestions).toBe(0);
    expect((await f.yours.overview()).suggestions).toBeUndefined();
    // Off: Monday's stream lists none, and Today shows none.
    f.setClock(at('07:29'));
    await f.change({ action: 'stream.update', stream: 'daily', settings: { suggestions: false } });
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.sent[0]!.text).not.toContain('Suggestions');
    expect((await f.yours.overview()).suggestions).toBeUndefined();
    expect(f.claim(schedule.schedule_id)).toEqual([]);
  });
});
