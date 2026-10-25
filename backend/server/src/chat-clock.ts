/** How the chat writes a clock for the model, shared by the turn's
 *  `current_date` and the tools that render an instant (`calendar.search`'s
 *  `when`), so the two cannot write one offset two ways. A leaf: the turn
 *  executor and the tool handlers both import it, and neither imports the other. */

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
