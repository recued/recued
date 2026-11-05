/** D-338 slice 3 — the Agenda's AI suggestions.
 *
 *  The owner: "Scheduled prompts is the way to go, append suggestions", with the schedule hidden
 *  "from the schedule prompt UI because it duplicated the agenda card", and private reminders kept
 *  by "soft request": the request asks, and the items a model reads say which are private. So
 *  "Add AI suggestions" on the Agenda card makes one scheduled prompt that the card owns
 *  (`managed_by: 'agenda'`):
 *
 *  - It runs at the Agenda's time, daily or on its weekday, in the server's zone, and notifies when
 *    it is done (slice 2). Its answer is suggestions only: the plain Agenda has already gone, so
 *    nothing it lists is retyped, and a failed run loses only the suggestions.
 *  - It is kept in step with the card: a save changes its timing and words, turning suggestions
 *    (or the Agenda) off pauses it, and turning them on again resumes the same one, so it stays one
 *    conversation. If the owner deleted that conversation, the next save starts a new one.
 *  - Its notice says nothing on a day the Agenda sent nothing (`doneGate`), as the Agenda itself
 *    does, and waits while that day's Agenda is still to go.
 *
 *  Spec: D-338 § 5. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PromptSchedule, SituationAgendaSettings } from '@recued/contracts';
import type { PromptSchedules } from '../prompt-schedules.js';
import type { PromptScheduleDoneGate } from '../prompt-schedule-done.js';

export const AGENDA_SUGGESTIONS_TITLE = 'Agenda suggestions';

type Agenda = Required<SituationAgendaSettings>;

/** The days the suggestions look at, in the words of the instruction. */
const spanWords = (agenda: Agenda): string => agenda.frequency === 'weekly'
  ? `the seven days starting ${agenda.day === 'tomorrow' ? 'tomorrow' : 'today'}`
  : agenda.day === 'tomorrow' ? 'tomorrow' : 'today';

/** The scheduled prompt's request. ⚠ Model-facing — see `chat-prompt-optimization-log.md`.
 *
 *  ⛔ Measured live (2026-11-04, D-338 §7): asked to build the day in epoch ms, the model asked
 *  `situation.query` for the wrong day in 4 of 6 runs, so the request names the day as a date.
 *  Asked to call "a private reminder" only that, with nothing marking which item it was, it named
 *  the owner's private occasion in 7 of 7 runs that had it; the item now says `private: true`. The
 *  label is "a reminder in Yours", the words the Agenda and the digest use (the owner's choice).
 *  It is left out unless a suggestion involves it: a line that only said "A reminder in Yours (all
 *  day)." repeated what the plain Agenda already lists (D-338 §12).
 *  And "with its time" put a time on an all-day one, so a time is given only if it has one. */
export const agendaSuggestionsPrompt = (agenda: Agenda): string => {
  const span = spanWords(agenda);
  return `My agenda for ${span} goes to me at this time. Read ${span} with situation.query, which lists `
    + `the same items my agenda does: give it ${span} as ${agenda.frequency === 'weekly' ? 'dates' : 'a date'}. `
    + 'Look up any detail you need. Then suggest what would help: clashes, travel time between places, what '
    + 'to prepare or bring, and anything that has to happen before an item. Reply with the suggestions only, as '
    + 'a short list: I already have the agenda, so do not repeat it. This reply goes to my notifications, which '
    + 'others may see. Leave out an item marked private unless a suggestion involves it, such as a clash; then '
    + 'write it only as "a reminder in Yours", with its time if it has one, and never its title, who it is for, or '
    + 'anything to do for it. If nothing is worth suggesting, say so in one line.';
};

/** The Agenda's time as a cron line: every day, or on its weekday (cron counts Sunday as 0). */
export const agendaSuggestionsCron = (agenda: Agenda): string => {
  const [hour, minute] = agenda.time.split(':').map(Number) as [number, number];
  return `${minute} ${hour} * * ${agenda.frequency === 'weekly' ? agenda.weekday % 7 : '*'}`;
};

interface Record {
  readonly schedule_id?: string;
}

export interface AgendaSuggestions {
  /** After a save: bring the managed schedule in line with the Agenda's settings, making it if the
   *  suggestions are on and it is missing. */
  sync(agenda: Agenda): Promise<void>;
  /** From the Agenda's tick: the same, when what the schedule should be has changed since this
   *  process last brought it in line (a Recued update reworded the request, the server's zone
   *  moved), and never making one. ⛔ A conversation the owner deleted comes back at their next
   *  save only, as before: a restart must not bring back what they removed. */
  refresh(agenda: Agenda): Promise<void>;
  /** The conversation the suggestions run in, while their schedule exists. */
  conversation(): string | undefined;
  /** For the done notices: the Agenda's own run decides whether its suggestions are sent. */
  doneGate: PromptScheduleDoneGate;
}

export const createAgendaSuggestions = (deps: {
  db: Database.Database;
  /** Late: the chat is composed before the Agenda, and a server without it has no schedules. */
  schedules: () => PromptSchedules | undefined;
  readSetting: <T>(key: string, fallback: T) => T;
  writeSetting: (key: string, value: unknown) => void;
  timeZone: () => string;
  /** The state of the Agenda's own run that went (or was skipped) at or after an instant, if any. */
  agendaRunSince: (at: number) => 'sent' | 'skipped' | 'pending' | undefined;
}): AgendaSuggestions => {
  const KEY = 'situations.agenda_suggestions';
  const scheduleOf = (): { schedule_id: string; session_id: string } | undefined => {
    const id = deps.readSetting<Record>(KEY, {}).schedule_id;
    if (typeof id !== 'string') return undefined;
    return deps.db.prepare('SELECT schedule_id, session_id FROM chat_prompt_schedules WHERE schedule_id = ?').get(id) as
      { schedule_id: string; session_id: string } | undefined;
  };
  /** What the schedule should be now: what a save would write. A save marks it, so its tick
   *  writes nothing more. */
  const wanted = (agenda: Agenda): string => JSON.stringify([agenda.enabled && agenda.suggestions,
    agendaSuggestionsPrompt(agenda), agendaSuggestionsCron(agenda), deps.timeZone()]);
  let applied: string | undefined;
  // One at a time: a save and a tick that both update the schedule would race its revision.
  let queue: Promise<void> = Promise.resolve();
  const serially = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work, work); queue = next.catch(() => {}); return next;
  };
  const apply = async (agenda: Agenda, make: boolean): Promise<void> => {
    const schedules = deps.schedules();
    if (!schedules) return;
    const saved = scheduleOf();
    let current: PromptSchedule | undefined = saved ? await schedules.get(saved.schedule_id) : undefined;
    if (!(agenda.enabled && agenda.suggestions)) {
      if (current?.enabled) await schedules.control('pause', { schedule_id: current.schedule_id, expected_revision: current.revision }, false, { managed: true });
      return;
    }
    const definition = { title: AGENDA_SUGGESTIONS_TITLE, prompt: agendaSuggestionsPrompt(agenda),
      time_zone: deps.timeZone(), cron_expression: agendaSuggestionsCron(agenda) };
    if (!current) {
      if (!make) return;
      const made = await schedules.create({ ...definition, mode: 'recurring', notify_on_done: true },
        `agenda-suggestions:${randomUUID()}`, false, { managed_by: 'agenda' });
      if (made) deps.writeSetting(KEY, { schedule_id: made.schedule_id });
      return;
    }
    if (current.title !== definition.title || current.prompt !== definition.prompt || current.time_zone !== definition.time_zone
      || current.cron_expression !== definition.cron_expression || current.notify_on_done !== true) {
      current = await schedules.update({ schedule_id: current.schedule_id, expected_revision: current.revision,
        ...definition, notify_on_done: true }, false, { managed: true }) ?? current;
    }
    if (!current.enabled) await schedules.control('resume', { schedule_id: current.schedule_id, expected_revision: current.revision }, false, { managed: true });
  };
  return {
    sync: agenda => serially(async () => { await apply(agenda, true); applied = wanted(agenda); }),
    refresh: agenda => serially(async () => {
      const now = wanted(agenda);
      if (now === applied) return;
      await apply(agenda, false); applied = now;
    }),
    conversation: () => scheduleOf()?.session_id,
    doneGate(schedule, run) {
      if (schedule.managed_by !== 'agenda') return 'notify';
      // The Agenda goes at the same minute; quiet hours can carry it later. A day it sent nothing
      // gets no suggestions either.
      const state = deps.agendaRunSince(run.due_at - 5 * 60_000);
      return state === 'sent' ? 'notify' : state === 'skipped' ? 'skip' : 'wait';
    },
  };
};
