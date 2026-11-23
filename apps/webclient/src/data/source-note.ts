import { NOTE_TITLE_MAX, type CalendarEventRef, type CalendarEventSnapshot, type MailMessageSnapshot } from '@recued/contracts';
import { selectedCalendarEventContext } from '../calendar/event-context.js';
import { calendarDraftOrigin, draftOriginHash, mailDraftOrigin, type DraftOrigin } from './draft-origin.js';

const values = (origin: DraftOrigin | undefined, kind: 'mail' | 'calendar', clientHref: string): Record<string, unknown> => {
  if (!origin || origin.kind !== kind) throw new Error('The original record could not be confirmed. Reopen it before adding a note.');
  const url = new URL(clientHref);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The original record link is unavailable. Reopen it before adding a note.');
  url.username = ''; url.password = ''; url.search = ''; url.hash = draftOriginHash(origin);
  // Angle brackets keep opaque provider IDs intact in formatted Markdown too.
  // This is a source link, not a guessed canonical mail-thread/event relation.
  let title = 'Notes: ';
  for (const character of origin.label) {
    if (title.length + character.length > NOTE_TITLE_MAX) break;
    title += character;
  }
  return { title, body: `${kind === 'mail' ? 'Email' : 'Event'}: <${url.href}>\n\n` };
};
export const mailNoteValues = (message: MailMessageSnapshot, clientHref: string) => values(mailDraftOrigin(message), 'mail', clientHref);
export const calendarNoteValues = (ref: CalendarEventRef, snapshot: CalendarEventSnapshot, clientHref: string) => {
  if (!selectedCalendarEventContext(ref, snapshot)) throw new Error('This calendar occurrence could not be confirmed. Refresh it before adding a note.');
  return values(calendarDraftOrigin(ref, snapshot), 'calendar', clientHref);
};
