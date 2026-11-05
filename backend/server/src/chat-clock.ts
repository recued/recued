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
const TURN_ZONE_ARGS: Readonly<Record<string, string>> = { 'schedule.run_prompt': 'time_zone' };

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
