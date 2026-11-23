import { CALENDAR_EVENT_EDIT_LIMITS, type MailMessageSnapshot } from '@recued/contracts';
import { draftOriginHash, mailDraftOrigin, readDraftOrigin, type DraftOrigin } from './draft-origin.js';

export type CalendarMailOrigin = Extract<DraftOrigin, { kind: 'mail' }>;
export interface CalendarMailSeed {
  origin: CalendarMailOrigin;
  summary: string;
  description: string;
  location: string;
}
/** Only source navigation accompanies recovery. Never infer guests or dates
 * from email text or copy mail sending authority into calendar requests. */
export const readCalendarMailOrigin = (value: unknown): CalendarMailOrigin | null => {
  const origin = readDraftOrigin(value);
  return origin?.kind === 'mail' && Object.keys(value as object).every(key =>
    ['kind', 'slug', 'recordId', 'receivedAt', 'identity', 'label', 'conversation'].includes(key)) ? origin : null;
};
export const calendarMailSeed = (message: MailMessageSnapshot, clientUrl: string): CalendarMailSeed => {
  const origin = readCalendarMailOrigin(mailDraftOrigin(message));
  if (!origin) throw new Error('This email could not be confirmed. Reopen it from Mail.');
  const url = new URL(clientUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The original email link is unavailable.');
  url.username = ''; url.password = ''; url.search = ''; url.hash = draftOriginHash(origin);
  const fields = { summary: message.subject.replace(/[\r\n]+/g, ' ').trim() || 'Event from email',
    description: `Original email: ${url.href}`, location: '' };
  for (const key of ['summary', 'description', 'location'] as const)
    if (new TextEncoder().encode(fields[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key])
      throw new Error('The email subject or link exceeds this form’s limits. Start a new event and copy the details you need.');
  return { origin, ...fields };
};
