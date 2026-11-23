import { allDayEventDays, type CalendarEventDetails } from '@recued/contracts';

/** Open only an absolute web link saved by the calendar provider. */
export const calendarMeetingHref = (value: string | undefined): string | null => {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

export const calendarTimeLabel = (at: number, zone: string): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(at);
  } catch { return `${new Date(at).toISOString()} (event time zone unavailable)`; }
};
export const calendarDayLabel = (day: string): string =>
  new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', dateStyle: 'full' }).format(Date.parse(day + 'T00:00:00Z'));

export const calendarEventCopyText = (event: CalendarEventDetails): string => {
  const days = event.is_all_day ? allDayEventDays(event) : null;
  const meeting = calendarMeetingHref(event.conference_url);
  return [
    event.summary || 'Untitled event',
    ...(event.status === 'cancelled' ? ['Status: Cancelled'] : event.status === 'tentative' ? ['Status: Tentative'] : []),
    ...(days ? [`All day: ${calendarDayLabel(days.first)}${days.last === days.first ? '' : ` – ${calendarDayLabel(days.last)}`}`]
      : [`Start: ${calendarTimeLabel(event.start_at, event.timezone)}`, `End: ${calendarTimeLabel(event.end_at, event.timezone)}`, `Time zone: ${event.timezone}`]),
    ...(event.location ? [`Location: ${event.location}`] : []),
    ...(meeting ? [`Meeting link: ${meeting}`] : []),
  ].join('\n');
};
