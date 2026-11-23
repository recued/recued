import { savedWorkAddress, savedWorkLinks, savedWorkLinkMatches, type CalendarEventSnapshot, type LinkedCalendarEvent, type SavedWorkAddress } from '@recued/contracts';
import { taskNoteSource, type TaskNoteSource } from './task-note-source.js';

/** Only explicit links in this exact client can enter its return navigation.
 * Provider text is escaped by the reader, never interpreted as HTML. */
export const calendarEmailLinks = (snapshot: CalendarEventSnapshot, href: string): TaskNoteSource[] => {
  const links = snapshot.mail_links ?? (snapshot.event.description_truncated ? [] : savedWorkLinks(snapshot.event.description).map(link => link.href));
  const result = new Map<string, TaskNoteSource>();
  for (const link of links) {
    const source = taskNoteSource(link, href);
    if (source?.tab === 'mail') result.set(source.hash, source);
  }
  return [...result.values()];
};

export const verifyLinkedCalendarEvent = (row: LinkedCalendarEvent, target: SavedWorkAddress, snapshot: CalendarEventSnapshot, href: string): void => {
  if (snapshot.event.record_id !== row.record_id || snapshot.record.record_id !== row.record_id
    || snapshot.event.source_id !== row.source_id || snapshot.record.source_id !== row.source_id
    || snapshot.record.received_at !== row.received_at || snapshot.incarnation !== row.incarnation
    || snapshot.event.calendar_id !== row.calendar_id) throw new Error('This event or calendar changed. Refresh Linked from.');
  if (snapshot.refresh_error) throw new Error('The calendar could not verify this event. Refresh it and try again.');
  if (!calendarEmailLinks(snapshot, href).some(link => {
    const address = savedWorkAddress(link.hash);
    return address && savedWorkLinkMatches(address, target);
  })) throw new Error('This event no longer links to this email. Refresh Linked from.');
};
