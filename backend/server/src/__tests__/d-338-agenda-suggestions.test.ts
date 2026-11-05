/** D-338 slice 3 — the Agenda's AI suggestions: one scheduled prompt the Agenda card owns, kept in
 *  step with its settings, and silent on a day the Agenda sent nothing. Through the real Agenda
 *  scheduler and the real scheduled-prompt service; no model runs. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalToolRegistry, SituationAgendaSettings, SituationFact } from '@recued/contracts';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { agendaSuggestionsCron, agendaSuggestionsPrompt } from '../situations/agenda-suggestions.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';

// Monday 19 October 2026 is day 0, in UTC.
const on = (day: number, hhmm: string) => Date.parse(`2026-10-${19 + day}T${hhmm}:00Z`);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const event = (id: string, title: string, day: number, from: string, to: string): SituationFact => ({
  ref: { collection: 'calendar', id: `work:${id}` }, title, kind: 'calendar', basis: 'declared',
  when: { from: on(day, from), to: on(day, to) }, act_by: on(day, from), valid_until: on(day, to),
  people: [], subjects: [], related: [], evidence: [{ collection: 'calendar', id: `work:${id}` }], updated_at: on(0, '00:00'), consequence: 'routine' });

const fixture = () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const store = createSituationStore(db); const contracts = createContractStore(db);
  let at = on(0, '06:00'); let facts: SituationFact[] = [];
  const sources = ['calendar', 'task'].map(collection => ({ id: collection, collection, verb_op: 'core.work-entity.read',
    read: vi.fn(() => facts.filter(row => row.ref.collection === collection)) }));
  const query = createSituationQuery({ now: () => at, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  // The chat's scheduled prompts, with a turn that writes nothing: these tests read schedules.
  const chat = createChatStore(db), plans = createSqliteChatPlanStore(db);
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const turns: string[] = [];
  const runTurn = async (input: { queue_turn_id?: string }) => { turns.push(input.queue_turn_id!); return { turn_id: input.queue_turn_id! }; };
  const base = createChatOrchestrator({ chatStore: chat, registry, selfSignature: { server_kind: 'recued', version: '1', instance_id: 'agenda-suggestions' } });
  const queue = withQueuedChatTurns({ ...base, runTurn }, { db, store: chat, pollMs: 10 }).turnQueue!;
  const schedules = createPromptSchedules({ db, store: chat, instanceId: 'agenda-suggestions', now: () => at, runTurn, queue,
    readPlans: (session, turn) => plans.listForTurn(session, turn) });
  const send = vi.fn(async () => ({ delivered_to: ['in_app', 'telegram'] }));
  let zone = 'UTC'; let unlocked = true;
  // As the composition root wires it, and again after a restart (a Recued update is a new process).
  const boot = () => {
    const made = createScheduledSituations({ db, work, store, query, timeZone: () => zone, isVaultUnlocked: () => unlocked, now: () => at,
      isQuiet: () => false, overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), send,
      promptSchedules: () => schedules });
    made.bindAccess(createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => unlocked }));
    schedules.setRunGate('agenda', (schedule, due_at) => made.agendaRunGate(schedule, due_at));
    return made;
  };
  const service = boot();
  const restarted: Array<ReturnType<typeof createScheduledSituations>> = [];
  cleanups.push(async () => { for (const again of restarted) await again.stop(); await service.stop(); queue.close(); db.close(); });
  const save = async (patch: Partial<SituationAgendaSettings>) => { service.setAgenda(patch); await service.syncAgendaSuggestions(); };
  const owned = async () => (await schedules.list(undefined, { managed: true })).filter(s => s.managed_by === 'agenda');
  const occurrences = () => (db.prepare('SELECT COUNT(*) AS n FROM chat_prompt_occurrences').get() as { n: number }).n;
  return { db, chat, schedules, service, send, save, owned, turns, occurrences, queue,
    time: (value: number) => { at = value; }, facts: (value: SituationFact[]) => { facts = value; },
    zone: (value: string) => { zone = value; }, seal: (value: boolean) => { unlocked = !value; },
    restart: () => { const again = boot(); restarted.push(again); return again; } };
};

describe('D-338 the Agenda\'s AI suggestions', () => {
  it('reads as off until the owner turns them on, and refuses anything but true or false', () => {
    const f = fixture();
    expect(f.service.agendaSettings().suggestions).toBe(false);
    expect(() => f.service.setAgenda({ suggestions: 'yes' as never })).toThrow('Choose a valid agenda schedule');
  });

  it('makes one schedule the Agenda owns, at its time and in its words, kept off the schedule screens', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [schedule, ...more] = await f.owned();
    expect(more).toEqual([]);
    expect(schedule).toMatchObject({ title: 'Agenda suggestions', mode: 'recurring', cron_expression: '0 7 * * *', time_zone: 'UTC',
      notify_on_done: true, managed_by: 'agenda', enabled: true, prompt: agendaSuggestionsPrompt(f.service.agendaSettings() as never) });
    expect(schedule!.prompt).toContain('My agenda for today goes to me at this time.');
    // The day as a date, which the model reads on the owner's clock, and the marker the soft
    // request names (D-338 §7: epoch ms put the wrong day in 4 of 6 live runs; with no marker the
    // private occasion was named 7 times in 7).
    expect(schedule!.prompt).toContain('give it today as a date.');
    expect(schedule!.prompt).toContain('Leave out an item marked private unless a suggestion involves it, such as a clash; then '
      + 'write it only as "a reminder in Yours", with its time if it has one, and never its title, who it is for, or anything to do for it.');
    expect(await f.schedules.list()).toEqual([]);
    expect(f.service.agendaStatus().suggestions_session_id).toBe(schedule!.session_id);
    // The conversation is in the chat list, under the schedule's title.
    expect(f.chat.getSession(schedule!.session_id)?.title).toBe('Agenda suggestions');
  });

  it('follows the Agenda\'s time, frequency and days, and stays one conversation', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [first] = await f.owned();
    await f.save({ time: '06:30', frequency: 'weekly', weekday: 5, day: 'tomorrow' });
    const [moved] = await f.owned();
    expect(moved).toMatchObject({ schedule_id: first!.schedule_id, session_id: first!.session_id, cron_expression: '30 6 * * 5' });
    expect(moved!.prompt).toContain('My agenda for the seven days starting tomorrow');
    expect(moved!.prompt).toContain('give it the seven days starting tomorrow as dates.');
    expect(agendaSuggestionsCron({ ...f.service.agendaSettings(), weekday: 7 } as never)).toBe('30 6 * * 0');
  });

  it('pauses when the suggestions or the Agenda go off, and resumes the same schedule', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', suggestions: true });
    const [first] = await f.owned();
    await f.save({ suggestions: false });
    expect((await f.owned())[0]).toMatchObject({ schedule_id: first!.schedule_id, enabled: false });
    await f.save({ suggestions: true });
    expect((await f.owned())[0]).toMatchObject({ schedule_id: first!.schedule_id, enabled: true });
    await f.save({ enabled: false });
    expect((await f.owned())[0]).toMatchObject({ schedule_id: first!.schedule_id, enabled: false });
    expect(await f.owned()).toHaveLength(1);
  });

  it('starts a new conversation when the owner deleted the old one', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', suggestions: true });
    const [first] = await f.owned();
    await f.schedules.beforeDeleteSession(first!.session_id); f.chat.deleteSession(first!.session_id);
    expect(f.service.agendaStatus().suggestions_session_id).toBeUndefined();
    await f.save({ time: '07:05' });
    const [second] = await f.owned();
    expect(second!.schedule_id).not.toBe(first!.schedule_id);
    expect(f.service.agendaStatus().suggestions_session_id).toBe(second!.session_id);
  });

  it('holds its done notice until the day\'s Agenda goes, and drops it on a day the Agenda sent nothing', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [schedule] = await f.owned();
    f.service.setSettings({ frequency: 'off', day_of: false });
    expect(f.service.agendaDoneGate(schedule!, { due_at: on(1, '07:00') })).toBe('wait');
    // Tuesday has a meeting: the Agenda goes, and so may its suggestions.
    f.facts([event('dentist', 'Dentist', 1, '09:00', '10:00')]); f.time(on(1, '07:00')); await f.service.tick();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.service.agendaDoneGate(schedule!, { due_at: on(1, '07:00') })).toBe('notify');
    // Wednesday has nothing on: no Agenda, and no suggestions.
    f.facts([]); f.time(on(2, '07:00')); await f.service.tick();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.service.agendaDoneGate(schedule!, { due_at: on(2, '07:00') })).toBe('skip');
    // A schedule the Agenda does not own is not its to hold.
    expect(f.service.agendaDoneGate({ ...schedule!, managed_by: undefined }, { due_at: on(2, '07:00') })).toBe('notify');
  });

  it('does not run at all on a day with nothing on, and runs on a day with something on', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [schedule] = await f.owned();
    expect(schedule!.next_run_at).toBe(on(0, '07:00'));
    // Monday: nothing on. No model call, nothing queued or written, and the clock moves to Tuesday.
    f.time(on(0, '07:00')); await f.schedules.tick();
    expect(f.occurrences()).toBe(0); expect(f.turns).toEqual([]);
    expect(await f.chat.listMessages(schedule!.session_id)).toEqual([]);
    expect((await f.owned())[0]!.next_run_at).toBe(on(1, '07:00'));
    // Tuesday: a meeting. It runs.
    f.facts([event('dentist', 'Dentist', 1, '09:00', '10:00')]);
    f.time(on(1, '07:00')); await f.schedules.tick();
    expect(f.occurrences()).toBe(1);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    expect((await f.owned())[0]!.next_run_at).toBe(on(2, '07:00'));
  });

  // The owner asked whether the request needs a save to be reworded: the card's unsaved-change
  // guard covers their own edits, and a reword or a moved zone arrives with no edit at all.
  it('follows a moved server zone at its next tick, with no save, and writes nothing while nothing changes', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [first] = await f.owned();
    await f.service.tick(); await f.service.tick();
    expect((await f.owned())[0]!.revision).toBe(first!.revision);
    // Settings → Server moves the server to Dublin. The Agenda reads its zone live; its schedule follows.
    f.zone('Europe/Dublin'); await f.service.tick();
    expect((await f.owned())[0]).toMatchObject({ schedule_id: first!.schedule_id, time_zone: 'Europe/Dublin', cron_expression: '0 7 * * *' });
  });

  it('takes a reworded request at the first tick after a restart, with no save', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [first] = await f.owned();
    // The words an earlier build saved.
    await f.schedules.update({ schedule_id: first!.schedule_id, expected_revision: first!.revision, prompt: 'Old words.' }, false, { managed: true });
    const again = f.restart(); await again.tick();
    expect((await f.owned())[0]).toMatchObject({ schedule_id: first!.schedule_id, session_id: first!.session_id,
      prompt: agendaSuggestionsPrompt(again.agendaSettings() as never) });
  });

  it('never brings back a conversation the owner deleted: that waits for their next save', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', suggestions: true });
    const [first] = await f.owned();
    await f.schedules.beforeDeleteSession(first!.session_id); f.chat.deleteSession(first!.session_id);
    await f.service.tick(); f.zone('Europe/Dublin'); await f.service.tick(); await f.restart().tick();
    expect(await f.owned()).toEqual([]);
    await f.save({ time: '07:05' });
    expect(await f.owned()).toHaveLength(1);
  });

  it('leaves the schedule alone while the vault is sealed, and catches up once it opens', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', suggestions: true });
    f.seal(true); f.zone('Europe/Dublin'); await f.service.tick();
    expect((await f.owned())[0]!.time_zone).toBe('UTC');
    f.seal(false); await f.service.tick();
    expect((await f.owned())[0]!.time_zone).toBe('Europe/Dublin');
  });

  it('skips a day the Agenda has already settled as empty, and leaves alone a schedule it does not own', async () => {
    const f = fixture();
    await f.save({ enabled: true, time: '07:00', day: 'today', suggestions: true });
    const [schedule] = await f.owned();
    f.service.setSettings({ frequency: 'off', day_of: false });
    f.time(on(0, '07:00')); await f.service.tick();
    expect(await f.service.agendaRunGate(schedule!, on(0, '07:00'))).toBe('skip');
    // Even if something is added after the Agenda went out empty, that day's run stays skipped,
    // as the Agenda did.
    f.facts([event('late', 'Late call', 0, '18:00', '19:00')]);
    expect(await f.service.agendaRunGate(schedule!, on(0, '07:00'))).toBe('skip');
    expect(await f.service.agendaRunGate({ ...schedule!, managed_by: undefined }, on(0, '07:00'))).toBe('run');
  });
});
