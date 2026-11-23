import { zonedWallClockToEpochMs } from '@recued/contracts';
/** How the chat writes a clock for the model, shared by the turn's
 *  `current_date` and the tools that render an instant (`calendar.search`'s
 *  `when`, a booking's `slot_when`), so the two cannot write one offset two
 *  ways. A leaf among the server's modules: the turn executor and the tool
 *  handlers both import it, and neither imports the other. */

import { eventWhen } from '@recued/transforms';

/** The UTC offset `zone` keeps at `epochMs`, as `UTC-07:00` (`UTC+00:00` for
 *  UTC, `UTC+05:30` for a half-hour zone); `''` when the platform cannot say.
 *  Read from the zone's rules AT that instant, so a December event seen in
 *  October carries December's offset. `zone` must already be valid. */
export const utcOffsetLabel = (epochMs: number, zone: string): string => {
  // longOffset always renders padded "GMT±HH:MM" (incl. "GMT+00:00" for
  // UTC); rebrand to the unambiguous "UTC±HH:MM".
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(epochMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  return offsetPart ? offsetPart.replace(/^GMT/, 'UTC') : '';
};

/** When an event happens on the turn's clock, written beside the epoch-ms
 *  `start_at` / `end_at` it is read from: `2026-08-27 06:40–07:40 (UTC-07:00)`,
 *  or `2026-12-24, all day` (an all-day event is stored as the UTC midnight of
 *  its day, which converted by hand west of UTC reads as the day before).
 *
 *  ⛔ Left to convert epoch ms itself, the model named the wrong day: bench 175
 *  (2026-10-24) said "Aug 26" for a meeting at 13:40 UTC on Aug 27 in 8 of its
 *  60 conversations. The zone is the one the turn's `current_date` is stamped in; absent
 *  when the dispatch carries none (an MCP caller keeps its own clock). */
export const eventWhenOnTurnClock = (hot: unknown, zone: string | undefined): string | undefined => {
  if (zone === undefined || hot === null || typeof hot !== 'object') return undefined;
  const when = eventWhen({ event: hot, time_zone: zone });
  if (when === null) return undefined;
  if (when.time === 'All day') return when.text;
  const offset = utcOffsetLabel(when.start, zone);
  return offset ? `${when.text} (${offset})` : when.text;
};

/** D-338 — the turn's clock zone in the stream's per-turn state, seeded by the
 *  orchestrator before the turn's hooks run (`buildTurnDriver`), from the inputs
 *  `runChatTurn` resolves its own `turnTimeZone` from. A before-turn hook that writes
 *  an instant (the situation lookup) is then on the clock `current_date` is stamped in. */
export const CHAT_TURN_TIME_ZONE_STATE_KEY = 'chat.turn_time_zone';

/** The zone seeded under `CHAT_TURN_TIME_ZONE_STATE_KEY`; none when nothing seeded one.
 *  ⛔ Never throws, whatever it is handed: the lookup reads it inside the block whose
 *  catch withholds the whole lookup, so a throw here would cost the model every row
 *  (a hand-built turn's `state: {}` did, in `d-325-asset-search-terms`). */
export const chatTurnTimeZoneOf = (state: unknown): string | undefined => {
  const zone = state instanceof Map ? state.get(CHAT_TURN_TIME_ZONE_STATE_KEY) : undefined;
  return typeof zone === 'string' ? zone : undefined;
};

/** D-338 §13 — the tool argument the turn's own zone fills when the model leaves it out. */
const TURN_ZONE_ARGS: Readonly<Record<string, string>> = {
  'schedule.run_prompt': 'time_zone',
  // D-343 slice 2 — the day a record is for is read on the turn's clock, which the approved run keeps.
  'episode.record': 'time_zone',
};

/** D-343 (the owner's day, 2026-11-14) — the tools whose `due_at` the model may write as the day
 *  and time it means, on the user's clock, rather than as Unix ms: asked to move a call "to 5 pm
 *  today", a model wrote the ms for 5 pm the NEXT day, and the chat then said "today". */
const WALL_CLOCK_DUE_TOOLS: ReadonlySet<string> = new Set(['work.create', 'work.update']);
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** A call's `due_at` as Unix ms where the model wrote a day ("2026-11-15", that day, as a date-only
 *  due is kept: its UTC midnight) or a day and time on the turn's clock ("2026-11-15T17:00"). Done
 *  where the dispatch begins, as `withTurnZone` is, so the held call, the owner's approval and the
 *  approved run carry the one instant. Anything else is left for the tool to refuse. */
export const withTurnDates = (tool: string, args: unknown, zone: string | undefined): unknown => {
  if (!WALL_CLOCK_DUE_TOOLS.has(tool) || args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const due = (args as Record<string, unknown>).due_at;
  if (typeof due !== 'string') return args;
  const text = due.trim();
  const ms = DAY_ONLY.test(text) ? Date.parse(`${text}T00:00:00Z`)
    : WALL_CLOCK.test(text) ? zonedWallClockToEpochMs(text, zone ?? 'UTC') : null;
  return ms !== null && Number.isFinite(ms) ? { ...(args as Record<string, unknown>), due_at: ms } : args;
};

/** D-343 — how the owner reads a work tool's `due_at` on its approval: the day and time on the
 *  turn's clock ("Sun 15 Nov, 17:00"), or the day alone for a date-only due (its UTC midnight).
 *  The approval showed "due_at: 16 Nov 2026, 17:00 UTC", and a wrong day went by unread. */
/** A due date as the owner reads it: the day ("Sun 15 Nov") for a date-only due, else the day and
 *  time on their clock ("Sun 15 Nov, 17:00"). */
const dueParts = (due: number, zone: string | undefined): { day: string; time?: string } => {
  const dayOnly = due % 86_400_000 === 0;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: dayOnly ? 'UTC' : zone ?? 'UTC', weekday: 'short', day: 'numeric',
    month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(due).map((p) => [p.type, p.value]));
  const day = `${String(parts.weekday)} ${String(parts.day)} ${String(parts.month)}`;
  return dayOnly ? { day } : { day, time: `${String(parts.hour)}:${String(parts.minute)}` };
};
const dueWords = (due: number, zone: string | undefined): string => {
  const { day, time } = dueParts(due, zone);
  return time === undefined ? day : `${day}, ${time}`;
};
/** `before` — D-343 (the owner's day audit, 2026-11-15: a change showed only its new value): the
 *  row's due date before the change, `null` for none. Given, a changed due reads "before → after". */
export const dueValueLabels = (tool: string, args: unknown, zone: string | undefined,
  before?: number | null): Record<string, Record<string, string>> | undefined => {
  if (!WALL_CLOCK_DUE_TOOLS.has(tool) || args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const due = (args as Record<string, unknown>).due_at;
  if (typeof due !== 'number' || !Number.isFinite(due)) return undefined;
  const after = dueWords(due, zone);
  if (before === undefined || before === due) return { due_at: { [String(due)]: after } };
  if (before === null || !Number.isFinite(before)) return { due_at: { [String(due)]: `no due date → ${after}` } };
  // The same day, a new time: the day once ("Sun 15 Nov → 17:00 that day", "Sun 15 Nov, 09:00 → 17:00").
  const from = dueParts(before, zone); const to = dueParts(due, zone);
  if (from.day === to.day && to.time !== undefined) {
    return { due_at: { [String(due)]: from.time === undefined ? `${from.day} → ${to.time} that day` : `${from.day}, ${from.time} → ${to.time}` } };
  }
  return { due_at: { [String(due)]: `${dueWords(before, zone)} → ${after}` } };
};

/** A call's arguments with the turn's zone where the model gave none (absent, null or blank).
 *  The model sees only the zone's offset, never its name (2026-06-09: an IANA id carries a
 *  city the model repeats), so a required zone made it ask the owner (5 of 6 runs) or write
 *  `UTC` off `UTC+00:00` for a Dublin owner, an hour out once summer time starts.
 *
 *  ⛔ Filled where the dispatch begins, never in the tool: a held call is checked, shown,
 *  hashed and kept with these arguments, and the approved run (`dispatchResumedTier1Call`)
 *  is given no zone, so the owner approves the zone it runs in and the run still has it.
 *  No zone (an MCP caller keeps its own clock) leaves the call as it came. */
export const withTurnZone = (tool: string, args: unknown, zone: string | undefined): unknown => {
  const field = Object.hasOwn(TURN_ZONE_ARGS, tool) ? TURN_ZONE_ARGS[tool] : undefined;
  if (field === undefined || zone === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const given = (args as Record<string, unknown>)[field];
  const left = given === undefined || given === null || (typeof given === 'string' && given.trim() === '');
  return left ? { ...(args as Record<string, unknown>), [field]: zone } : args;
};
