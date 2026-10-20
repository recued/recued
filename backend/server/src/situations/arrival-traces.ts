import { calendarDayMs, type CollectionRecord } from '@recued/contracts';
import { traceId, type ProactiveTrace } from '../storage/proactive-trace-store.js';

/** A completed-action sentence with an explicit real date is evidence of a
 * reported check-in/arrival. Booking confirmations and invitations cannot
 * pass this parser. Its output remains an inferred trace, never attendance. */
export const arrivalTrace = (mailbox: string, row: CollectionRecord, now: number): ProactiveTrace | null => {
  if (!row.body_inline || row.body_inline.length > 65536 || row.hot_fields.direction === 'outbound') return null;
  const body = row.body_inline.replaceAll('\r\n', '\n');
  if (/forwarded message|\bwrote:|\bexample\b|\b(?:cancelled|canceled|not checked in)\b/iu.test(body)) return null;
  const match = /(?:^|\n)You (?:have )?(checked in (?:at|to)|arrived at) ([^\n]{1,200}?) on (\d{4}-\d{2}-\d{2})[.!]?(?:\n|$)/u.exec(body);
  if (!match) return null;
  const day = calendarDayMs(match[3]!); if (day === null || day + 86400000 > now) return null;
  const place = match[2]!.trim(); if (!place || /[<>]/u.test(place)) return null;
  const ref = { collection: 'mail', id: `${mailbox}:${row.record_id}` };
  return { id: traceId(ref, 'reported-arrival'), title: `${match[1]!.startsWith('checked') ? 'Check-in confirmation' : 'Arrival confirmation'} · ${place}`,
    when: { from: day, to: day + 86400000 - 1 }, people: [], subjects: [], sources: [ref], class_id: 'checkin',
    where: { key: `arrival:${place.toLowerCase()}`, name: place }, observed_at: row.received_at, source_mailbox: mailbox };
};
