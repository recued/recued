import { describe, expect, it } from 'vitest';
import type { CalendarEventDetails } from '@recued/contracts';
import { calendarMeetingHref, calendarEventCopyText } from '../calendar-event-actions.js';

const event: CalendarEventDetails = {
  record_id: 'cal:work:meeting', source_id: 'meeting', calendar_id: 'work', summary: 'Launch planning',
  description: 'Private notes are not part of Copy event details.', location: 'Room 2', updated_at: 1,
  start_at: Date.parse('2026-11-01T08:30:00Z'), end_at: Date.parse('2026-11-01T09:30:00Z'),
  timezone: 'America/Los_Angeles', is_all_day: false, is_recurring: false, status: 'confirmed',
  conference_url: 'https://meet.example.test/planning?code=a&guest=b',
};

describe('Calendar event quick actions', () => {
  it('opens saved absolute web links and rejects executable, relative, credential and control-character URLs', () => {
    expect(calendarMeetingHref(event.conference_url)).toBe(event.conference_url);
    expect(calendarMeetingHref('http://meet.example.test/room')).toBe('http://meet.example.test/room');
    for (const value of [undefined, '', '/room', '//meet.example.test/room', 'javascript:alert(1)', 'data:text/html,meeting',
      'file:///room', 'https://owner:secret@meet.example.test/room', 'https://meet.example.test/\nroom']) {
      expect(calendarMeetingHref(value)).toBeNull();
    }
  });

  it('copies the event zone and both readings of a repeated hour with the location and saved link', () => {
    const text = calendarEventCopyText(event);
    expect(text).toContain('Launch planning\nStart: Sunday, November 1, 2026 at 1:30:00 AM PDT');
    expect(text).toContain('End: Sunday, November 1, 2026 at 1:30:00 AM PST');
    expect(text).toContain('Time zone: America/Los_Angeles\nLocation: Room 2\nMeeting link: ' + event.conference_url);
    expect(text).not.toContain(event.description);
    const unknown = calendarEventCopyText({ ...event, timezone: 'Unavailable/Zone', conference_url: 'javascript:alert(1)', status: 'cancelled' });
    expect(unknown).toContain('Status: Cancelled\nStart: 2026-11-01T08:30:00.000Z (event time zone unavailable)');
    expect(unknown).not.toContain('Meeting link:');
  });

  it('copies inclusive all-day dates without shifting them into the browser or event zone', () => {
    const text = calendarEventCopyText({ ...event, is_all_day: true, timezone: 'Asia/Tokyo',
      start_at: Date.parse('2026-10-31T00:00:00Z'), end_at: Date.parse('2026-11-03T00:00:00Z') });
    expect(text).toContain('All day: Saturday, October 31, 2026 – Monday, November 2, 2026');
    expect(text).not.toContain('November 3');
    expect(text).not.toContain('Time zone:');
  });
});
