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
