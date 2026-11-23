import { describe, expect, it } from 'vitest';
import { TASK_TITLE_MAX, type CalendarEventSnapshot } from '@recued/contracts';
import { calendarTaskValues } from '../calendar-task.js';
import { parseShellRoute, parseSourceRecordAddress } from '../../shell/route.js';

const snapshot: CalendarEventSnapshot = { event: { record_id: 'cal:work:event?二', source_id: 'provider-uid', calendar_id: 'work', calendar_name: 'Planning',
  summary: '  Launch planning  ', description: '\n Bring the proposal.\nKeep the revised scope. ', location: 'Room 2', updated_at: 1,
  start_at: Date.parse('2026-11-01T08:30:00Z'), end_at: Date.parse('2026-11-01T09:30:00Z'), timezone: 'America/Los_Angeles', is_all_day: false, is_recurring: true, status: 'confirmed' },
  record: { record_id: 'cal:work:event?二', source_id: 'provider-uid', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
  resource_version: 'v1', incarnation: 'work-1', editable: false };

describe('calendar follow-up task draft', () => {
  it('quotes the event zone and repeated-hour readings with an exact calendar-qualified link and no inferred task relationships', () => {
    const values = calendarTaskValues({ slug: 'work/one', source_id: snapshot.event.source_id }, snapshot, 'https://owner:secret@recued.example/client/?token=private#data/calendar');
    expect(values).toMatchObject({ title: 'Launch planning', done: false, due_at: null });
    const body = String(values.body);
    expect(body).toContain('Calendar: Planning\nEvent: https://recued.example/client/#data/calendar/record/work%2Fone/cal%3Awork%3Aevent%3F%E4%BA%8C');
    expect(body).toContain('1:30:00 AM PDT'); expect(body).toContain('1:30:00 AM PST'); expect(body).toContain('Time zone: America/Los_Angeles');
    expect(body).toContain('Event notes:\nBring the proposal.\nKeep the revised scope.');
    expect(body).not.toContain('secret'); expect(body).not.toContain('token=');
    const url = new URL(body.split('\n')[1]!.slice('Event: '.length));
    expect(parseSourceRecordAddress(parseShellRoute(url.hash))).toEqual({ tab: 'calendar', collectionSlug: 'work/one', recordId: snapshot.event.record_id });
    expect(values).not.toHaveProperty('parent_calendar_event'); expect(values).not.toHaveProperty('assigned_contact');
    expect(snapshot.event.summary).toBe('  Launch planning  ');
  });

  it('keeps inclusive all-day dates and cancelled context without assigning a task deadline', () => {
    const values = calendarTaskValues({ slug: 'work', source_id: snapshot.event.source_id }, { ...snapshot, event: { ...snapshot.event,
      is_all_day: true, timezone: 'Asia/Tokyo', status: 'cancelled', start_at: Date.parse('2026-10-31T00:00:00Z'), end_at: Date.parse('2026-11-03T00:00:00Z') } }, 'https://recued.example/');
    expect(values.due_at).toBeNull(); expect(values.body).toContain('Status: Cancelled');
    expect(values.body).toContain('October 31, 2026'); expect(values.body).toContain('November 2, 2026'); expect(values.body).not.toContain('November 3');
  });

  it('bounds imported titles and notes without splitting Unicode and marks truncated or stale previews', () => {
    const values = calendarTaskValues({ slug: 'work', source_id: snapshot.event.source_id }, { ...snapshot, refresh_error: 'offline', event: { ...snapshot.event,
      summary: 'x'.repeat(TASK_TITLE_MAX - 1) + '🧾end', description: 'y'.repeat(599) + '🧾end', description_truncated: true } }, 'https://recued.example/');
    expect(values.title).toBe('x'.repeat(TASK_TITLE_MAX - 1)); expect(values.body).toContain('Event notes (partial):\n' + 'y'.repeat(599));
    expect(values.body).toContain('last saved event details'); expect(values.body).not.toContain('🧾');
    expect(calendarTaskValues({ slug: 'work', source_id: snapshot.event.source_id }, { ...snapshot, event: { ...snapshot.event, summary: ' ', description: '' } }, 'https://recued.example/').title).toBe('Follow up on calendar event');
  });

  it('rejects mismatched saved record or provider identity before handing off a task', () => {
    expect(() => calendarTaskValues({ slug: 'work', source_id: 'other' }, snapshot, 'https://recued.example/')).toThrow('could not be confirmed');
    expect(() => calendarTaskValues({ slug: 'work', source_id: snapshot.event.source_id }, { ...snapshot, record: { ...snapshot.record, record_id: 'other' } }, 'https://recued.example/')).toThrow('could not be confirmed');
  });
});
