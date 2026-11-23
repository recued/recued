/** D-407 slice 4 — an event's private marking and its one alert as an owner patch carries them (`CalendarEventPatch`
 *  `marked_private`, `alert_minutes`): validated, made the provider's patch (`alert_minutes` → `reminders`; `null` →
 *  none), and on the local calendar a marking taken away or no alert left leaves no field. The providers' own writes
 *  are in their test files. */
import { describe, expect, it } from 'vitest';
import type { CalendarEventSnapshot, CanonicalEvent } from '@recued/contracts';

import { validateCalendarEventPatch } from '../local-event-handler.js';
import { createLocalCalendarProvider } from '../local-provider.js';
import { normalizeCalendarMutationPatch } from '../mutation-patch.js';

const event: CanonicalEvent = { source_id: 'local:1', ical_uid: 'one@recued', calendar_id: 'local', summary: 'Dr. Lee',
  start_at: Date.parse('2026-12-12T10:30:00Z'), end_at: Date.parse('2026-12-12T11:30:00Z'), timezone: 'UTC', is_all_day: false,
  status: 'confirmed', created_at: 1, updated_at: 1 };

describe('D-407 slice 4 — an owner patch\'s marking and alert', () => {
  it('validated: a boolean marking; whole minutes up to four weeks, or null', () => {
    const snapshot = { event } as unknown as CalendarEventSnapshot;
    expect(validateCalendarEventPatch(snapshot, { marked_private: true, alert_minutes: 120 })).toEqual({ marked_private: true, alert_minutes: 120 });
    expect(validateCalendarEventPatch(snapshot, { alert_minutes: null })).toEqual({ alert_minutes: null });
    for (const bad of [{ marked_private: 'yes' }, { alert_minutes: -1 }, { alert_minutes: 40_321 }, { alert_minutes: 2.5 }]) {
      expect(() => validateCalendarEventPatch(snapshot, bad as never), JSON.stringify(bad)).toThrow();
    }
  });

  it('made the provider\'s patch: minutes become its one reminder, null none; the marking passes as given', () => {
    expect(normalizeCalendarMutationPatch({ alert_minutes: 120, marked_private: false }, event))
      .toEqual({ reminders: [{ method: 'popup', minutes: 120 }], marked_private: false });
    expect(normalizeCalendarMutationPatch({ alert_minutes: null }, event)).toEqual({ reminders: [] });
    expect(normalizeCalendarMutationPatch({ summary: 'Dr. Lee, again' }, event)).toEqual({ summary: 'Dr. Lee, again' });
  });

  it('the local calendar keeps them, and keeps no field once taken away', async () => {
    let stored: CanonicalEvent | null = null;
    const provider = createLocalCalendarProvider({ slug: 'local', now: () => 2, readEvent: () => stored });
    stored = (await provider.createEvent('local', { calendar_id: 'local', summary: 'Dr. Lee', start_at: event.start_at, end_at: event.end_at,
      timezone: 'UTC', is_all_day: false, status: 'confirmed', marked_private: true, reminders: [{ method: 'popup', minutes: 120 }] })).event;
    expect(stored).toMatchObject({ marked_private: true, reminders: [{ method: 'popup', minutes: 120 }] });
    const updated = (await provider.updateEvent({ calendar_id: 'local', source_id: stored.source_id, patch: { marked_private: false, reminders: [] } })).event;
    expect(updated.marked_private).toBeUndefined();
    expect(updated.reminders).toBeUndefined();
    expect(updated.summary).toBe('Dr. Lee');
  });
});
