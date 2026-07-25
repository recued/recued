/** D-149 P5 § A.5.2 — the booking flow's store contract.
 *
 *  Round-trip insert / find / list-pending / countWithinWindow / markProcessed,
 *  for a BOOKING row.
 *
 *  ## Why this file outlived the store it was written for
 *
 *  D-210 A.8 slice 4c deleted `SchedulingBookingStore` and its
 *  `reception_booking_request` table; a booking is now a
 *  `reception_form_submission` row (slice 4b-ii moved every writer and reader).
 *  The STORE went — the CONTRACT did not, so these tests were re-pointed at
 *  `ReceptionFormSubmissionStore` rather than deleted with the module.
 *
 *  🔑 Four of the six claims below have no equivalent in
 *  `d-210-a8-slice4b-merged-submission-store.test.ts`, which covers the merge
 *  itself (kind discrimination, per-kind vocabulary, the atomic day cap):
 *  `findById` miss ⇒ null, `markProcessed` miss ⇒ `not_found`, the booking
 *  page's oldest-first order, and `countWithinWindow`'s endpoint + window
 *  bounds. Deleting this file to "clean up after the drop" would have taken
 *  those with it, silently.
 *  ⇒ [[feedback_a_reduction_is_faked_by_doing_less]]
 *
 *  The AAD binding is exercised separately in the merged flow's PII suite
 *  (`d-149-phase-6-intake-form-pii.test.ts` — 4c retired the booking key
 *  stream, so a booking's fields seal under the FORM key). */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';

const setup = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return createReceptionFormSubmissionStore(db);
};

/** A booking: a row WITH a slot and WITHOUT a form definition. Both halves
 *  matter — the slot is what makes `recordKindOf` call it a booking. */
const booking = (over: Record<string, unknown> = {}) => ({
  submission_id: 'req-1',
  endpoint_id: 'ep-1',
  form_definition_id: null,
  submitted_at: 1_700_000_000_000,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  submission_blob_encrypted: 'AQID',
  schema_version: 1,
  processing_outcome: 'pending',
  slot: {
    start_at: 1_700_000_100_000,
    end_at: 1_700_000_101_800,
    duration_minutes: 30,
  },
  ...over,
});

describe('D-149 P5 § A.5.2 — the booking store contract, on the merged table', () => {
  it('inserts a pending row + retrieves it by id', () => {
    const store = setup();
    const row = store.insert(booking({
      source_ip_hash: 'hashA',
      visitor_email_encrypted: Buffer.from('ct-email', 'utf8').toString('base64'),
      submission_blob_encrypted: Buffer.from('ct-blob', 'utf8').toString('base64'),
    }));
    expect(row.submission_id).toBe('req-1');
    expect(row.processing_outcome).toBe('pending');
    expect(row.record_kind).toBe('booking');
    expect(row.visitor_email_encrypted).toBe(Buffer.from('ct-email', 'utf8').toString('base64'));
    expect(row.submission_blob_encrypted)
      .toBe(Buffer.from('ct-blob', 'utf8').toString('base64'));

    const fetched = store.findById('req-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.endpoint_id).toBe('ep-1');
    expect(fetched?.slot?.duration_minutes).toBe(30);
  });

  it('returns null on findById miss', () => {
    const store = setup();
    expect(store.findById('nope')).toBeNull();
  });

  it('listPendingBookingsForEndpoint returns pending rows in submitted_at ASC order', () => {
    const store = setup();
    store.insert(booking({ submission_id: 'req-1', submitted_at: 1_700_000_002_000 }));
    store.insert(booking({ submission_id: 'req-2', submitted_at: 1_700_000_001_000 }));
    const pending = store.listPendingBookingsForEndpoint('ep-1');
    expect(pending.map((r) => r.submission_id)).toEqual(['req-2', 'req-1']);
  });

  it('countWithinWindow respects endpoint + window bounds', () => {
    const store = setup();
    store.insert(booking({ submission_id: 'req-1', endpoint_id: 'ep-1', submitted_at: 1_000 }));
    store.insert(booking({ submission_id: 'req-2', endpoint_id: 'ep-1', submitted_at: 5_000 }));
    store.insert(booking({ submission_id: 'req-3', endpoint_id: 'ep-2', submitted_at: 5_000 }));
    expect(
      store.countWithinWindow({ endpoint_id: 'ep-1', window_start_at: 0, now: 10_000 }),
    ).toBe(2);
    expect(
      store.countWithinWindow({ endpoint_id: 'ep-1', window_start_at: 2_000, now: 10_000 }),
    ).toBe(1);
    expect(
      store.countWithinWindow({ endpoint_id: 'ep-2', window_start_at: 0, now: 10_000 }),
    ).toBe(1);
    // `now` no longer caps the count (race-batch Codex fold): a booking whose
    // submitted_at lands after this request's captured `now` (a concurrent
    // insert) must still count toward the per-day cap. Only `window_start_at`
    // filters; both ep-1 rows count despite submitted_at (1000/5000) > now (999).
    expect(
      store.countWithinWindow({ endpoint_id: 'ep-1', window_start_at: 0, now: 999 }),
    ).toBe(2);
  });

  it('markProcessed updates outcome + the resolved pointer', () => {
    const store = setup();
    store.insert(booking({ submission_id: 'req-1', submitted_at: 1 }));
    const r = store.markProcessed({
      submission_id: 'req-1',
      outcome: 'auto_confirmed',
      resolved: { kind: 'booking', id: 'bkg-1' },
    });
    expect(r).toBe('updated');
    const after = store.findById('req-1');
    expect(after?.processing_outcome).toBe('auto_confirmed');
    // ⚠ ONE resolved pointer, not two. The booking store carried
    // `resolved_calendar_event_id` beside `resolved_booking_id`; D-210 A.2 made
    // booking and calendar disjoint, so the calendar column had no writer left
    // and 4c dropped it with the table. Asserting the pointer names a BOOKING
    // is the surviving form of the claim — a null-check on the id alone would
    // pass whichever kind got written.
    expect(after?.resolved_target_kind).toBe('booking');
    expect(after?.resolved_target_id).toBe('bkg-1');
  });

  it('markProcessed returns not_found when submission_id is missing', () => {
    const store = setup();
    expect(
      store.markProcessed({
        submission_id: 'nope',
        outcome: 'rejected',
      }),
    ).toBe('not_found');
  });
});
