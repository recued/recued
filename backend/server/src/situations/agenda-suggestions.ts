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
import type { ExecutionSource, PromptSchedule, SituationAgendaSettings } from '@recued/contracts';
import type { PromptSchedules } from '../prompt-schedules.js';
import type { PromptScheduleDoneGate } from '../prompt-schedule-done.js';

export const AGENDA_SUGGESTIONS_TITLE = 'Agenda suggestions';
/** The setting that keeps the Agenda's suggestions' schedule id; the daily stream's once the streams
 *  take over (D-340 slice 2), and the weekly stream keeps its own (`WEEKLY_SUGGESTIONS_KEY`). */
export const AGENDA_SUGGESTIONS_KEY = 'situations.agenda_suggestions';
export const WEEKLY_SUGGESTIONS_KEY = 'situations.weekly_suggestions';

/** D-340 slice 5 — `names_private`: the stream they follow includes private items (§3.4). D-340 slice
 *  4 — `head_start`: a stream's, which start ahead of it (§3.3). */
type Agenda = Required<SituationAgendaSettings> & { names_private?: boolean; head_start?: boolean };

/** D-340 slice 4 (§3.3, ruling 9) started a stream's suggestions 10 minutes before it, and sent them
 *  on their own when they missed it. ⛔ The owner, 2026-11-15 (D-340 ruling 13): a second message that
 *  changes a list already planned around is a second decision point. The stream's time is now when
 *  Recued starts preparing the day: its suggestions start then, and the message waits for them and goes
 *  once (`SUGGESTIONS_STALL_MS`, `SUGGESTIONS_BACKSTOP_MS`). No head start. */
export const SUGGESTIONS_HEAD_START_MS = 0;
/** D-340 ruling 13 — a suggestions run with no new step (a lookup started or ended, an answer) for this
 *  long is taken as stuck, and the message goes without it, saying so. About three of the slowest model
 *  replies measured (≈60 s), so a slow run that is working is not cut off. */
export const SUGGESTIONS_STALL_MS = 3 * 60_000;
/** D-340 ruling 13 — the longest the message waits for a run still making progress. ⚠ Out of reach while
 *  the run has `SUGGESTIONS_TOOL_ROUNDS` rounds; raising them is the owner's cue to revisit this (a test
 *  pins the pair, the owner 2026-11-15: "this 20min may need to go with it if that limit is increased"). */
export const SUGGESTIONS_BACKSTOP_MS = 20 * 60_000;
/** D-340 slice 4 (§3.3, ruling 9: "the model never checks item by item") — the suggestions' own run
 *  reads the day once and looks up a detail or two: its tool rounds, below the chat's own cap. On the
 *  last one it is told to answer with what it has. */
export const SUGGESTIONS_TOOL_ROUNDS = 3;

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
 *  And "with its time" put a time on an all-day one, so a time is given only if it has one.
 *  D-342 §5 — the run's read also lists the owner's active pursuits (`pursuit` items), and the request
 *  asks for a step on one where the day has room. A pursuit is private by default, and any step on
 *  one is something to do for it, so a private pursuit is left out outright.
 *  D-343 slice 5 (§5) — each pursuit carries the days this week the owner recorded doing or skipping
 *  it (`recorded`). The request says a day it does not list is unknown, not missed: an unclosed day
 *  is never "didn't happen" (D-343 §3.5).
 *  D-340 slice 4, tuned (2026-11-07) — told there was "room for 2 lookups after reading" the day, the
 *  model looked for what the owner had done on a pursuit, which the read carries, in 9 of 15 runs (a
 *  second round in 7), and searched work in all 15; told the read has it, every run took one round.
 *  A line that only said "A reminder in Yours (all day)." was back in 4 of 15, and bold, which a
 *  messenger shows as asterisks, in 4 of 18 one evening: the request names both. */
export const agendaSuggestionsPrompt = (agenda: Agenda): string => {
  const span = spanWords(agenda);
  // D-340 slice 4 — a stream's run starts ahead of it, which then carries the suggestions.
  return `My agenda for ${span} goes to me ${agenda.head_start === true ? 'with your suggestions as soon as you answer' : 'at this time'}. Read ${span} with situation.query, which lists `
    + `the same items my agenda does, and beside them what I am working toward (kind pursuit): give it ${span} as `
    + `${agenda.frequency === 'weekly' ? 'dates' : 'a date'}. `
    // D-340 slice 4 — bounded: the day once, then at most a detail or two (ruling 9).
    + 'That read has what most suggestions need, my pursuits and the days I recorded each too: look something else up '
    + `only if a suggestion cannot do without it, at most ${String(SUGGESTIONS_TOOL_ROUNDS - 1)} lookups besides the read. `
    + 'Then suggest what would help: clashes, travel time between places, what '
    + 'to prepare or bring, anything that has to happen before an item, and, where the day has room, a step on one '
    + 'of my pursuits that fits it, from where I am with it and the days this week I recorded doing or skipping it '
    + '(recorded; a day it does not list is unknown, not one I missed). '
    // D-343 (the owner, 2026-11-15: "suggest an hour, more proactive"; the live run's four suggestions
    // named no time) — a time for what has none, in a stretch the day leaves free.
    + `Where an item has no time, or for a step on a pursuit, propose one: a time in a free stretch of ${span}, not `
    // D-343 (busy-day drive, 2026-11-15) — run 10 minutes ahead, "not already past" let through 16:30 in a
    // message that reached the owner at 16:31.
    + (agenda.head_start === true ? 'before this reaches me (allow 15 minutes from now) ' : 'one already past ')
    + 'and not over a timed item, and say why it fits (for example "- Spanish lesson at 12:00: you are '
    + 'free until the 17:00 call"). Give each its own time: two in one gap only if both fit in it, one after the other. '
    // D-343 (busy-day drives, 2026-11-15) — "free between the 18:30 Team review and the 20:00 Dentist" for
    // a gap that opened at 19:30, when the review ended.
    + 'Name a gap by when the item before it ends ("free from 19:30, after the team review"), not when it starts. '
    // D-343 (busy-day drive, 2026-11-15) — "it is unknown if you practiced this week" read the request's
    // own rule back to the owner.
    + 'Never tell me a day is unknown or unrecorded. Reply with the suggestions only, as a '
    + 'short list of plain lines, each starting with "- ", without bold (my notifications show it as asterisks): I '
    + 'already have the agenda, so do not repeat it. '
    + (agenda.names_private === true
      // D-340 slice 5 (§3.4) — Include private items: the owner chose to have them named in the
      // channels the stream goes to, so a private item or pursuit is suggested about like any other.
      ? 'This reply goes to my notifications, where I chose to have my private items named: you may name an item or '
        + 'pursuit marked private and suggest about it like any other. '
      : 'This reply goes to my notifications, which others may see. Leave out a pursuit marked private. Leave out any '
        + 'other item marked private unless a suggestion involves it, such as a clash; then write it only as "a reminder '
        + 'in Yours", with its time if it has one, and never its title, who it is for, or anything to do for it. '
        + 'A line that only says I have a reminder in Yours is not a suggestion. ')
    + 'If nothing is worth suggesting, say so in one line.';
};

/** The Agenda's time as a cron line: every day, or on its weekday (cron counts Sunday as 0). A stream's
 *  start `SUGGESTIONS_HEAD_START_MS` ahead (D-340 slice 4): a weekly one that goes in its day's first
 *  minutes starts the day before. */
export const agendaSuggestionsCron = (agenda: Agenda): string => {
  const [hour, minute] = agenda.time.split(':').map(Number) as [number, number];
  const start = hour * 60 + minute - (agenda.head_start === true ? SUGGESTIONS_HEAD_START_MS / 60_000 : 0);
  const at = (start + 1440) % 1440; const dayBefore = start < 0;
  return `${at % 60} ${Math.floor(at / 60)} * * ${agenda.frequency === 'weekly' ? ((agenda.weekday - (dayBefore ? 1 : 0)) % 7 + 7) % 7 : '*'}`;
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
  /** D-340 slice 4 — their schedule, while it exists: the stream reads its finished run. */
  scheduleId(): string | undefined;
  /** D-342 §5 — whether a turn is the suggestions' own run: one of the managed schedule's, by its id. */
  isOwnRun(source: ExecutionSource | undefined): boolean;
  /** D-340 slice 2 — whether a schedule is these suggestions' own: the daily stream's and the weekly
   *  stream's are both managed by the Agenda, and each gate answers for its own. */
  owns(schedule_id: string): boolean;
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
  /** D-340 ruling 13 — whether these suggestions are a stream's: they then go inside its message or, when
   *  it went without them, stay in Today and their conversation; never a notification of their own. */
  streaming?: () => boolean;
  /** D-340 slice 2 — the setting that keeps its schedule's id: the Agenda's (the daily stream's,
   *  once the streams take over) by default, and the weekly stream's for its own. */
  key?: string;
}): AgendaSuggestions => {
  const KEY = deps.key ?? AGENDA_SUGGESTIONS_KEY;
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
    scheduleId: () => scheduleOf()?.schedule_id,
    owns: schedule_id => scheduleOf()?.schedule_id === schedule_id,
    isOwnRun: source => source?.channel === 'schedule' && 'prompt_schedule' in source && source.prompt_schedule !== undefined
      && source.prompt_schedule.schedule_id === scheduleOf()?.schedule_id,
    doneGate(schedule, run) {
      if (schedule.managed_by !== 'agenda') return 'notify';
      // The Agenda goes at the same minute; quiet hours can carry it later. A day it sent nothing
      // gets no suggestions either.
      const state = deps.agendaRunSince(run.due_at - 5 * 60_000);
      // D-340 ruling 13 — a stream's: inside its message, or quiet once it went without them. ⛔ Not
      // skipped before it goes: a skip claims them, and the message would then find none to carry.
      if (deps.streaming?.() === true) return state === 'sent' || state === 'skipped' ? 'skip' : 'wait';
      return state === 'sent' ? 'notify' : state === 'skipped' ? 'skip' : 'wait';
    },
  };
};
