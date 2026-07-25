/** D-173 P4.3 — the reception calendar-event create seam.
 *
 *  The `calendar.event` projection branch's write path, injected into
 *  `runReceptionProjection` as `deps.createCalendarEvent` so the projection
 *  stays agnostic of the calendar stack (it owns only the I-7 past-slot guard
 *  + the visitor-payload → event mapping).
 *
 *  ## 🔴 Who reaches this seam changed in D-210 A.2 (slice 3b)
 *
 *  It used to serve TWO callers: a scheduling reservation and an intake
 *  targeting a calendar. A.2 ruled booking ⟂ calendar — **if it is a booking it
 *  does not go in the calendar** — so a reservation now projects as `booking`
 *  and never arrives here.
 *
 *  ⇒ The remaining caller is an INTAKE naming a calendar as its destination
 *  (WS3): a personal calendar event, which A.7.1 keeps as a legitimate tier-2
 *  destination. The seam was NOT deleted with the booking path for exactly that
 *  reason.
 *
 *  ⇒ Everything reservation-shaped left with it: the `booking_request_id`
 *  idempotency pre-check, the `resolved_calendar_event_id` anchor writes, the
 *  `scheduled-from` provenance edge and the booking mint. They did not move
 *  here from somewhere — they moved OUT, to `reception-booking-mint.ts`, which
 *  is now the reservation's whole write path and holds its own anchor.
 *
 *  ⚠ There is consequently NO idempotency pre-check left in this seam, and that
 *  is a real (accepted) difference, not an oversight. `createEvent` is
 *  non-idempotent — it mints a fresh UUID per call, matching every external
 *  provider's contract — and the intake path has no equivalent of the
 *  reservation row to anchor on. What protects it instead is the same thing
 *  that made the old pre-check sufficient rather than a CAS: an intake's
 *  materialize op is admitted ONCE at the D-157 gate, the engine is
 *  single-threaded over synchronous SQLite, and D-153 mandates no auto-resume
 *  on crash (a crash mid-create surfaces as `in_doubt`, never a silent retry).
 *  A deterministic-id storage upsert is the hardening IF the recovery model
 *  ever gains auto-retry.
 *
 *  DESTINATION: cold-start (no external calendar) writes to the default LOCAL
 *  calendar (`'local'` instance, `'local'` calendar_id) — a credential-free
 *  preset. Choosing a non-local destination is a follow-on.
 *
 *  Spec: D-210 § A.2 + D-173 § D7. */

import type { CreateEventInput } from '../../../collections/calendar/provider.js';
import {
  DEFAULT_LOCAL_CALENDAR_ID,
  DEFAULT_LOCAL_CALENDAR_SLUG,
} from '../../../collections/calendar/local-provider.js';
import type {
  ReceptionCalendarEventEffect,
} from './reception-projection.js';

export interface ReceptionCalendarEventSeamDeps {
  /** The calendar stack's create dispatcher
   *  (`calendarStack.kernelDispatchers.calendarCreate`). Verified-then-
   *  reflected: it calls the provider's `createEvent` (the local provider
   *  mints the identity) then mirrors the canonical event into the warehouse.
   *  Returns the assigned `source_id` (+ `ical_uid`). */
  readonly calendarCreate: (input: {
    slug: string;
    calendar_id: string;
    event: CreateEventInput;
  }) => Promise<{ source_id: string; ical_uid: string }>;
}

/** Build the `createCalendarEvent` effect bound to the local calendar. */
export const createReceptionCalendarEventSeam = (
  deps: ReceptionCalendarEventSeamDeps,
): ReceptionCalendarEventEffect => async (input) => {
  const event: CreateEventInput = {
    calendar_id: DEFAULT_LOCAL_CALENDAR_ID,
    summary: input.summary,
    ...(input.description !== undefined ? { description: input.description } : {}),
    start_at: input.start_at,
    end_at: input.end_at,
    timezone: input.timezone,
    // D-210 WS3 — the visitor's own field type decides: a `date` field means a
    // day-scoped request (a hotel stay, a leave day), a `datetime` field a
    // timed one. The `false` default is the timed reading, which is what an
    // intake that names no start-field type should get.
    is_all_day: input.is_all_day ?? false,
    status: 'confirmed',
  };

  const { source_id } = await deps.calendarCreate({
    slug: DEFAULT_LOCAL_CALENDAR_SLUG,
    calendar_id: DEFAULT_LOCAL_CALENDAR_ID,
    event,
  });

  return { source_id };
};
