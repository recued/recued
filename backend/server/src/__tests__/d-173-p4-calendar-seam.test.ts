/** D-173 P4.3 / D-210 A.2 — the reception calendar-event create seam.
 *
 *  `createReceptionCalendarEventSeam` is the `calendar.event` projection
 *  branch's write path: it builds a `CreateEventInput` for the default LOCAL
 *  calendar, calls the calendar-create dispatcher, and returns the assigned
 *  `source_id`.
 *
 *  ## 🔴 What this file STOPPED testing in slice 3b, and where it went
 *
 *  It used to be a booking test. The seam owned the I-4 idempotency anchor
 *  (`resolved_calendar_event_id` pre-check / populate), the `scheduled-from`
 *  provenance edge and the booking mint — nine cases across two describes.
 *  D-210 A.2 ruled booking ⟂ calendar, so a reservation projects as `booking`
 *  and never reaches this seam; the remaining caller is an INTAKE naming a
 *  calendar as its destination (WS3).
 *
 *  ⚠ That coverage was MOVED, not dropped, and the move is the thing to check
 *  if this file ever looks thin:
 *    - I-4 idempotency + the no-second-write property → `d-210-booking-mint`,
 *      where the anchor now lives (the booking row itself).
 *    - the `scheduled-from` edge → deleted with its writer; the booking's own
 *      `reception_record_id` column replaced it.
 *
 *  What remains is what the seam actually still does: the payload → event field
 *  mapping and the local destination. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_CALENDAR_ID,
  DEFAULT_LOCAL_CALENDAR_SLUG,
} from '../collections/calendar/local-provider.js';
import { createReceptionCalendarEventSeam } from '../ports/reception/projection/reception-calendar-event.js';
import type { CreateEventInput } from '../collections/calendar/provider.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface CalendarCreateCall {
  slug: string;
  calendar_id: string;
  event: CreateEventInput;
}

interface Env {
  calls: CalendarCreateCall[];
  seam: ReturnType<typeof createReceptionCalendarEventSeam>;
}

let nextId = 0;

const buildEnv = (): Env => {
  const calls: CalendarCreateCall[] = [];
  const seam = createReceptionCalendarEventSeam({
    calendarCreate: async (input) => {
      calls.push(input);
      nextId += 1;
      return { source_id: `evt-${nextId}`, ical_uid: `evt-${nextId}@local.recued` };
    },
  });
  return { calls, seam };
};

let env: Env;
beforeEach(() => {
  nextId = 0;
  env = buildEnv();
});

describe('D-173 P4.3 — calendar-event seam', () => {
  it('creates ONE event on the local calendar with the canonical fields', async () => {
    const start = NOW + DAY;
    const res = await env.seam({
      summary: 'Site visit',
      description: 'Bring the deck',
      start_at: start,
      end_at: start + 45 * 60_000,
      timezone: 'America/New_York',
    });

    expect(res).toEqual({ source_id: 'evt-1' });
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]!.slug).toBe(DEFAULT_LOCAL_CALENDAR_SLUG);
    expect(env.calls[0]!.calendar_id).toBe(DEFAULT_LOCAL_CALENDAR_ID);
    expect(env.calls[0]!.event).toEqual({
      calendar_id: DEFAULT_LOCAL_CALENDAR_ID,
      summary: 'Site visit',
      description: 'Bring the deck',
      start_at: start,
      end_at: start + 45 * 60_000,
      timezone: 'America/New_York',
      is_all_day: false,
      status: 'confirmed',
    });
  });

  it('omits the description when none is supplied', async () => {
    const start = NOW + DAY;
    await env.seam({
      summary: 'No-description event',
      start_at: start,
      end_at: start + 30 * 60_000,
      timezone: 'UTC',
    });
    expect(env.calls[0]!.event).not.toHaveProperty('description');
  });

  it('carries a DAY-SCOPED intake through as all-day (WS3)', async () => {
    const start = NOW + DAY;
    await env.seam({
      summary: 'Leave day',
      start_at: start,
      end_at: start + DAY,
      timezone: 'UTC',
      is_all_day: true,
    });
    expect(env.calls[0]!.event.is_all_day).toBe(true);
  });

  it('defaults to a TIMED event when the intake names no start-field type', async () => {
    const start = NOW + DAY;
    await env.seam({
      summary: 'Timed by default',
      start_at: start,
      end_at: start + 30 * 60_000,
      timezone: 'UTC',
    });
    expect(env.calls[0]!.event.is_all_day).toBe(false);
  });
});
