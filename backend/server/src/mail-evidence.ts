/** Readable message date and an exact, account-qualified source link. The date
 * is `received_at` as stored: providers take the sender's Date header first,
 * so it is not proof of receipt. Neither establishes chronology within a
 * message or proves a claim is supported.
 *
 * With `timeZone` (a chat turn's clock, `ChatDispatchContext.time_zone`) the
 * date is written in that zone with its offset, `2026-08-25T06:40:00-07:00`:
 * the same instant as the UTC form, with the owner's own date in front. In UTC
 * a mail that arrived late in the owner's evening read as the next day, and the
 * model reports the date it reads. Without one (MCP, a direct call), UTC. */
export const mailReceivedAtIso = (receivedAt: number | undefined, timeZone?: string): string | null => {
  if (receivedAt === undefined || !Number.isFinite(receivedAt)) return null;
  const date = new Date(receivedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return timeZone !== undefined ? isoInZone(date, timeZone) : date.toISOString();
};

/** `date` in `timeZone` as ISO 8601 with that date's offset, to the second;
 *  UTC (`…Z`) for a zone the platform does not know.
 *
 *  ⛔ Written here, not imported: the mail-work replays pin this file's bytes and
 *  boot it beside only the files they list (`scripts/replay-mail-work-*.mjs`), so
 *  a relative import of anything else fails every replay at setup. */
const isoInZone = (date: Date, timeZone: string): string => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
    }).formatToParts(date);
  } catch {
    return date.toISOString();
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  // longOffset renders "GMT-07:00", or a bare "GMT" for UTC.
  const offset = part('timeZoneName').replace(/^GMT/u, '') || 'Z';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
};

export const mailEvidenceMetadata = (
  slug: string,
  recordId: string,
  receivedAt: number | undefined,
  timeZone?: string,
) => ({
  // The webclient's exact Data record route. Encode punctuation too so the
  // address can be copied into a Markdown link without ending it early.
  source_url: '#data/mail/record/' + [slug, recordId].map(value =>
    encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()),
  ).join('/'),
  received_at_iso: mailReceivedAtIso(receivedAt, timeZone),
});
