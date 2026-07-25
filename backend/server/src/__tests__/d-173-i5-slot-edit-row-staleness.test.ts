/** D-173 / D-210 A.2 — the reservation row is a REQUEST; the BOOKING is the AGREEMENT.
 *
 *  ## What this file pinned, and what it pins now
 *
 *  It was written (2026-07-16) to PROVE two live defects, and it did — 5/5 green
 *  against the then-current code:
 *
 *    BUG-1 — rejecting a booking in the Inbox never freed its slot. The row was
 *            already `'processed'` (set at dispatch), the overlap query treated
 *            every non-`'rejected'` outcome as a hold, and the inbox reject path
 *            never touched the row ⇒ the slot was burned forever, silently.
 *    BUG-2 — editing the slot at approval double-booked. The edited `start_at`
 *            landed on the EVENT correctly, but `selected_slot_*` is write-once
 *            ⇒ the old slot stayed blocked (lost bookings) and the new slot
 *            stayed free (a second visitor could take it).
 *
 *  Both were symptoms of one root cause: **the booking row had been conscripted
 *  into being a slot hold** by its only consumer, `hasOverlappingBooking`. That
 *  consumer is deleted (2026-07-16) — it hard-coded capacity to 1 per endpoint,
 *  which only fits a one-table restaurant. With it gone, both defects are gone,
 *  and no write-back was needed to kill them.
 *
 *  ## The invariant that survives — and why it is load-bearing
 *
 *  The row records what the VISITOR ASKED FOR. The AGREEMENT records what was
 *  agreed. Two different facts, both true, neither stale. What looked like the
 *  row going stale was provenance being misread as live state.
 *
 *  ⚠ **Only the agreement's HOME moved** (D-210 A.2, slice 3b): it was a calendar
 *  event, it is now the `data_booking` row's `slot_start_at` / `slot_end_at`. The
 *  invariant is untouched, and so is the reason it is load-bearing — but the axis
 *  a capacity count must read is now the BOOKING, not the calendar. This file is
 *  what caught the 3b regression where the mint read `selected_slot_*` off the
 *  sealed row and silently confirmed the visitor\'s ORIGINAL time, discarding the
 *  owner\'s edit at `success: true`.
 *
 *  This matters beyond tidiness: capacity is now the owner's judgment, made at
 *  the D-157 gate against an overlap COUNT. **That count is the only safety
 *  mechanism left**, so it must be computed from the accurate axis. These tests
 *  pin which axis that is: the BOOKING carries the agreed time; the reservation
 *  ROW does not, and must not be counted. A count built on the row would
 *  under-report by exactly one per edited booking — silently, on the surface
 *  where the owner exercises judgment.
 *
 *  Real store + real projection + real mint seam. Nothing is faked — since A.2
 *  the path no longer crosses the calendar provider at all.
 *
 *  Spec: `docs/d-173-spec.md` D7 ("confirmed at approval");
 *  `handovers/calendar-reservation-landing-zone-audit.md` §§ 9-10. */

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { ensureReceptionSchema } from '../storage/reception-store.js';
// D-210 A.8 slice 4b-ii — the reservation is a `reception_form_submission` row
// with a slot; `reception_booking_request` has no writer any more.
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
} from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { runReceptionProjection } from '../ports/reception/projection/reception-projection.js';
import { createReceptionCalendarEventSeam } from '../ports/reception/projection/reception-calendar-event.js';
import { createReceptionBookingMintSeam } from '../ports/reception/projection/reception-booking-mint.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ENDPOINT_ID = 'ep-provenance-1';
const REQUEST_ID = 'req-provenance-1';
const DURATION_MINUTES = 30;
const DURATION_MS = DURATION_MINUTES * 60_000;

/** The slot the visitor picked and the door accepted. */
const BOOKED_AT = NOW + DAY;
/** Where the OWNER moved it at approval — the D4 "Slot start" edit. */
const MOVED_TO = BOOKED_AT + 4 * HOUR;

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  ensureWorkEntitySchema(db);

  const booking = createReceptionFormSubmissionStore(db);
  const workEntityStore = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(workEntityStore, NOW);

  const calendarCreates: Array<{ start_at: number; end_at: number }> = [];

  // The REAL calendar seam, wired ONLY so the "no event is created" assertion
  // has something that would have recorded one. A reservation never reaches it
  // since A.2; if it ever does again, `calendarCreates` grows and the test says so.
  const createCalendarEvent = createReceptionCalendarEventSeam({
    calendarCreate: async (input) => {
      calendarCreates.push({
        start_at: input.event.start_at,
        end_at: input.event.end_at,
      });
      return { source_id: 'evt-provenance-1', ical_uid: 'uid-provenance-1' };
    },
  });

  // The REAL mint — it owns the I-4 anchor pre-check + the back-pointer write.
  const createBooking = createReceptionBookingMintSeam({
    writeBooking: (input, now) => workEntityStore.writeBooking(input, now),
    readBooking: (id) => workEntityStore.readBooking(id),
    findBooking: (request_id) => booking.findById(request_id),
    markProcessed: (input) => booking.markProcessed(input),
    now: () => NOW,
  });

  return { db, booking, workEntityStore, createCalendarEvent, createBooking, calendarCreates };
};

type Env = ReturnType<typeof buildEnv>;

const insertBookingAtOriginalSlot = (env: Env): void => {
  // D-210 A.8 slice 4b-ii — `slot` present is what MAKES this a booking row (the
  // store derives the kind from it, and with it the outcome vocabulary the row
  // may carry). The blob is NOT NULL and stands in for the sealed visitor fields
  // this file never reads.
  env.booking.insert({
    submission_id: REQUEST_ID,
    endpoint_id: ENDPOINT_ID,
    form_definition_id: null,
    submitted_at: NOW,
    source_ip_hash: null,
    visitor_email_encrypted: null,
    submission_blob_encrypted: 'AQID',
    schema_version: 1,
    processing_outcome: 'pending',
    slot: {
      start_at: BOOKED_AT,
      end_at: BOOKED_AT + DURATION_MS,
      duration_minutes: DURATION_MINUTES,
    },
  });
  // The drain marks the row 'processed' at DISPATCH — before the owner ever
  // sees it (`scheduling-link-processor.ts:275`).
  env.booking.markProcessed({ submission_id: REQUEST_ID, outcome: 'processed' });
};

/** Materialize the booking with the owner's EDITED slot start — exactly what
 *  `mergeArgOverrides` hands the projection after an approve-with-edit. */
const approveWithEditedSlot = async (env: Env): Promise<void> => {
  await runReceptionProjection(
    {
      workEntityStore: env.workEntityStore,
      createCalendarEvent: env.createCalendarEvent,
      createBooking: env.createBooking,
      now: () => NOW,
    },
    {
      top_tier_kind: 'booking',
      id: `reception-${REQUEST_ID}`,
      title: 'Alice — consultation',
      start_at: MOVED_TO,
      duration_minutes: DURATION_MINUTES,
      timezone: 'America/New_York',
      booking_request_id: REQUEST_ID,
      reject_if_slot_past: true,
    },
  );
};

let env: Env;
beforeEach(async () => {
  env = buildEnv();
  insertBookingAtOriginalSlot(env);
  await approveWithEditedSlot(env);
});
afterEach(() => {
  env.db.close();
});

describe('D-173 — a slot edited at approval: the event agrees, the row remembers', () => {
  it('the BOOKING carries the edited slot — the accurate axis, and the one to count', () => {
    const minted = env.workEntityStore.readBooking(`reception-${REQUEST_ID}`);
    expect(minted).not.toBeNull();
    expect(minted!.slot_start_at).toBe(MOVED_TO);
    // `slot_end_at` is recomputed from the edited start, preserving the booked
    // duration — "move it an hour later" keeps its length.
    expect(minted!.slot_end_at).toBe(MOVED_TO + DURATION_MS);
  });

  it('⛔ A.2 — no calendar event is created for a reservation at all', () => {
    expect(env.calendarCreates).toHaveLength(0);
  });

  it('the RESERVATION keeps the visitor’s original ask — provenance, deliberately not rewritten', () => {
    const row = env.booking.findById(REQUEST_ID);
    expect(row?.slot?.start_at).toBe(BOOKED_AT);
    expect(row?.slot?.end_at).toBe(BOOKED_AT + DURATION_MS);
  });

  it('the two disagree — which is WHY the overlap count must read the booking, never the row', () => {
    // The load-bearing assertion. A count sourced from the row's `slot` would
    // place this booking at BOOKED_AT — a time nobody is coming — and miss it
    // at MOVED_TO, the time they actually are. Both errors land on the
    // approval ask, where the owner is deciding.
    //
    // ⚠ It is ALSO what catches a mint that reads the sealed row for its slot:
    // that regression makes these two agree, and this assertion is the only
    // thing standing between it and a silently discarded owner edit.
    const row = env.booking.findById(REQUEST_ID);
    const minted = env.workEntityStore.readBooking(`reception-${REQUEST_ID}`);
    expect(row?.slot?.start_at).not.toBe(minted?.slot_start_at);
  });

  it('the provenance pointer joins the two facts, so neither is orphaned', () => {
    const minted = env.workEntityStore.readBooking(`reception-${REQUEST_ID}`);
    expect(minted?.reception_record_id).toBe(REQUEST_ID);
    // D-210 A.8 slice 4b-ii — the frozen `resolved_booking_id` became the
    // generic `(kind, id)` pair. BOTH halves are asserted: an id alone would
    // pass for a row resolved to some other kind entirely.
    const row = env.booking.findById(REQUEST_ID);
    expect(row?.resolved_target_kind).toBe('booking');
    expect(row?.resolved_target_id).toBe(`reception-${REQUEST_ID}`);
  });
});
