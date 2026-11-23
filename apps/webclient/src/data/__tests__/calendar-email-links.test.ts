import { expect, it } from 'vitest';
import { savedWorkAddress, type CalendarEventSnapshot, type LinkedCalendarEvent } from '@recued/contracts';
import { calendarEmailLinks, verifyLinkedCalendarEvent } from '../calendar-email-links.js';

const client = 'https://app.test/client/';
const url = client + '#data/mail/record/work/message%2F%E4%BA%8C%3F';
const snapshot = (description = url): CalendarEventSnapshot => ({
  event: { record_id: 'cal:one', source_id: 'provider-one', calendar_id: 'primary', summary: 'Planning', description, location: '',
    start_at: 100, end_at: 200, updated_at: 100, timezone: 'UTC', is_all_day: false, status: 'confirmed', is_recurring: false },
  record: { record_id: 'cal:one', source_id: 'provider-one', received_at: 90, modified_at: 100, size_bytes: 10, hot_fields: {} },
  incarnation: 'planning-1', resource_version: 'v1', editable: false,
});
const row: LinkedCalendarEvent = { slug: 'planning', record_id: 'cal:one', source_id: 'provider-one', received_at: 90, incarnation: 'planning-1',
  calendar_id: 'primary', calendar_name: 'Planning', title: 'Planning', start_at: 100, end_at: 200, updated_at: 100,
  timezone: 'UTC', is_all_day: false, status: 'confirmed', stale: false };

it('accepts only explicit exact-client email links and preserves opaque ids and distinct mailboxes', () => {
  const value = snapshot([url, url, url.replace('/work/', '/home/'), url.replace('app.test', 'elsewhere.test'),
    url.replace('/client/', '/other/'), 'https://app.test/client/?edit=1#data/mail/record/work/id',
    'javascript:alert(1)', '<img src=x>'].join('\n'));
  expect(calendarEmailLinks(value, client).map(link => [link.collectionSlug, link.recordId])).toEqual([['work', 'message/二?'], ['home', 'message/二?']]);
  expect(calendarEmailLinks(snapshot('#data/mail/record/work/message%2F%E4%BA%8C%3F'), client)).toHaveLength(1);
});

it('uses full-description link metadata, and never guesses beyond a truncated preview on an older server', () => {
  const value = snapshot('Description preview'); value.event.description_truncated = true;
  expect(calendarEmailLinks(value, client)).toEqual([]);
  value.mail_links = [url]; expect(calendarEmailLinks(value, client)).toHaveLength(1);
});

it('rechecks event birth, account, link and provider-read outcome before opening incoming results', () => {
  const target = savedWorkAddress(url)!;
  expect(() => verifyLinkedCalendarEvent(row, target, snapshot(), client)).not.toThrow();
  for (const changed of [{ ...snapshot(), incarnation: 'planning-2' }, { ...snapshot(), record: { ...snapshot().record, received_at: 91 } },
    snapshot(url.replace('/work/', '/home/')), { ...snapshot(), refresh_error: 'Offline' }]) {
    expect(() => verifyLinkedCalendarEvent(row, target, changed, client)).toThrow();
  }
});
