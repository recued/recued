/** D-406 slice 2 — the emails among the records the owner added to a chat message ride `chat.send` as `mail_refs`:
 *  the server reads the first 3 before the turn's first round. The owner's ruling: reuse "Add records", no second
 *  picker. */
import { describe, expect, it } from 'vitest';
import { CHAT_CALENDAR_REFS_MAX, CHAT_MAIL_REFS_MAX } from '@recued/contracts';

import { pickedMailRefsOf } from '../selected-records.js';
import { pickedCalendarRefsOf, type ChatRecordContext } from '../record-context.js';
import type { PreparedRecordLink } from '../../data/record-link-insert.js';

const mail = (slug: string, recordId: string): PreparedRecordLink => ({ reference: {
  target: { tab: 'mail', collectionSlug: slug, recordId, hash: `#data/mail/${slug}/${encodeURIComponent(recordId)}` } } } as unknown as PreparedRecordLink);
const other = (tab: 'contact' | 'task' | 'note', id: string): PreparedRecordLink => ({ reference: {
  target: { tab, id, hash: `#data/${tab}/${id}` } } } as unknown as PreparedRecordLink);
const event = (slug: string, recordId: string): PreparedRecordLink => ({ reference: {
  target: { tab: 'calendar', collectionSlug: slug, recordId, hash: `#data/calendar/${slug}/${recordId}` } } } as unknown as PreparedRecordLink);

describe('the emails among the records added to a message', () => {
  it('each email\'s mailbox and record, in the order added; other records are not emails', () => {
    expect(pickedMailRefsOf([other('note', 'n1'), mail('work', 'm/1'), event('work', 'e1'), mail('home', 'm/1'), other('contact', 'c1')]))
      .toEqual([{ slug: 'work', record_id: 'm/1' }, { slug: 'home', record_id: 'm/1' }]);
    expect(pickedMailRefsOf([other('task', 't1')])).toEqual([]);
    expect(pickedMailRefsOf([])).toEqual([]);
  });

  it('each once, and at most as many as the server reads first; the rest stay references', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => mail('work', id));
    expect(pickedMailRefsOf([mail('work', 'a'), ...many])).toEqual(['a', 'b', 'c'].map((id) => ({ slug: 'work', record_id: id })));
    expect(pickedMailRefsOf(many)).toHaveLength(CHAT_MAIL_REFS_MAX);
  });
});

describe('D-406 (Q4) — the calendar events a message names', () => {
  const asked = { kind: 'calendar_event' as const, slug: 'work', sourceId: 'src-1', recordId: 'cal:work:1', name: 'Planning', calendarName: 'Work' };
  /** The context a composer holds: records added in "Add records", over the one a chat opened with. */
  const withSelectedRecords = (base: typeof asked | null, records: PreparedRecordLink[]): ChatRecordContext =>
    ({ kind: 'records', records, ...(base !== null ? { base } : {}) });
  it('the event "Ask about this event" opened with, then those added in "Add records"; never an email', () => {
    expect(pickedCalendarRefsOf(asked)).toEqual([{ slug: 'work', record_id: 'cal:work:1' }]);
    expect(pickedCalendarRefsOf(withSelectedRecords(asked, [mail('work', 'm1'), event('home', 'cal:home:2'), other('note', 'n1')])))
      .toEqual([{ slug: 'work', record_id: 'cal:work:1' }, { slug: 'home', record_id: 'cal:home:2' }]);
    expect(pickedCalendarRefsOf(withSelectedRecords(null, [mail('work', 'm1')]))).toEqual([]);
    expect(pickedCalendarRefsOf(null)).toEqual([]);
  });

  it('each calendar and record once, each calendar apart, and at most as many as the server reads first', () => {
    const many = ['a', 'b', 'c', 'd'].map((id) => event('work', id));
    expect(pickedCalendarRefsOf(withSelectedRecords(asked, [event('work', 'cal:work:1'), event('home', 'cal:work:1'), ...many])))
      .toEqual([{ slug: 'work', record_id: 'cal:work:1' }, { slug: 'home', record_id: 'cal:work:1' }, { slug: 'work', record_id: 'a' }]);
    expect(pickedCalendarRefsOf(withSelectedRecords(null, many))).toHaveLength(CHAT_CALENDAR_REFS_MAX);
  });
});
