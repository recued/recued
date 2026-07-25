/** D-210 A.8 slice 4b — `reception_form_submission` absorbs the booking shape.
 *
 *  Slice 4a made the merged table CARRY a slot. This is the store learning that
 *  a row with one is a BOOKING: a different flow, a different outcome
 *  vocabulary, no form definition, and its own pending page.
 *
 *  ## The vocabulary is why these tests exist
 *
 *  The two flows' `processing_outcome` closed lists overlap on `pending` +
 *  `processed` and diverge completely after that (`rejected` vs `failed` /
 *  `spam` / `rejected_domain` / `duplicate`). One physical column now holds
 *  both, so the column admits the union — and the ROW admits only its own kind's
 *  list. `reception-record.ts` rejected a union once, on the reasoning that it
 *  *"would let a reader ask a booking whether it was `spam`"*; A.3 changed the
 *  premise but not that reasoning, so the hazard is closed HERE instead of by
 *  the two tables having been separate.
 *
 *  🔴 The read path throws on an outcome outside the row kind's list, and both
 *  list methods `.map()` over rows — so a wrongly-written row does not corrupt
 *  one record, it takes down the whole page the owner is reading. That is why
 *  the refusal is also at the WRITE. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';

const NOW = 1_700_000_000_000;
const SLOT = { start_at: NOW + 86_400_000, end_at: NOW + 88_200_000, duration_minutes: 30 };

const buildDb = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return db;
};

const bookingInput = (over: Record<string, unknown> = {}) => ({
  submission_id: 'bk-1',
  endpoint_id: 'ep-sched',
  form_definition_id: null,
  submitted_at: NOW,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  submission_blob_encrypted: 'AQID',
  schema_version: 1,
  processing_outcome: 'pending',
  slot: SLOT,
  ...over,
});

const intakeInput = (over: Record<string, unknown> = {}) => ({
  submission_id: 'sub-1',
  endpoint_id: 'ep-intake',
  form_definition_id: 'fd_test',
  submitted_at: NOW,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  submission_blob_encrypted: 'AQID',
  schema_version: 1,
  processing_outcome: 'pending',
  ...over,
});

describe('D-210 A.8 slice 4b — the merged table holds both flows', () => {
  it('a slot makes the row a booking; its absence makes it an intake', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);

    const booking = store.insert(bookingInput());
    expect(booking.record_kind).toBe('booking');
    expect(booking.slot).toEqual(SLOT);
    expect(booking.form_definition_id).toBeNull();

    const intake = store.insert(intakeInput());
    expect(intake.record_kind).toBe('intake');
    expect(intake.slot).toBeNull();
  });

  it('a booking has NO form definition — the key is PRESENT and null, never a sentinel', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(bookingInput());
    const row = store.findById('bk-1')!;
    // ⛔ `Object.hasOwn`, because `toBeNull` alone cannot tell "present and null"
    // from "absent" — and the two mean different things to a consumer spreading
    // this row. The value must be null rather than `''` / `'0'`, either of which
    // is a sentinel two live equality checks can collide on (4a's schema note).
    expect(Object.hasOwn(row, 'form_definition_id')).toBe(true);
    expect(row.form_definition_id).toBeNull();
  });
});

describe('D-210 A.8 slice 4b — the outcome vocabulary is scoped to the row kind', () => {
  it('refuses an INTAKE outcome on a booking, at the write', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    // The exact hazard the union re-created: `spam` is a real outcome — just
    // never a booking's.
    expect(() => store.insert(bookingInput({ processing_outcome: 'spam' })))
      .toThrow(/not a booking outcome/);
    expect(() => store.insert(bookingInput({ processing_outcome: 'rejected_domain' })))
      .toThrow(/not a booking outcome/);
  });

  it('refuses a BOOKING outcome on an intake, at the write', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    expect(() => store.insert(intakeInput({ processing_outcome: 'rejected' })))
      .toThrow(/not a intake outcome/);
  });

  it('admits each flow its OWN terminal states', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);

    store.insert(bookingInput());
    store.markProcessed({ submission_id: 'bk-1', outcome: 'rejected' });
    expect(store.findById('bk-1')!.processing_outcome).toBe('rejected');

    store.insert(intakeInput());
    store.markProcessed({ submission_id: 'sub-1', outcome: 'spam' });
    expect(store.findById('sub-1')!.processing_outcome).toBe('spam');
  });

  // 🔴 `markProcessed` used to be typed `Exclude<IntakeFormSubmissionProcessingOutcome,
  // 'pending'>`. The merged column holds both vocabularies, so that type could
  // not survive the merge — and dropping it silently would have handed the
  // WRITE path the two holes the type was closing.
  it('markProcessed refuses an outcome belonging to the OTHER flow', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(intakeInput());
    // Without this guard the row writes fine and then throws on EVERY read —
    // and both list methods `.map()`, so the owner's whole page dies with it.
    expect(() => store.markProcessed({ submission_id: 'sub-1', outcome: 'rejected' }))
      .toThrow(/not a intake outcome/);
    expect(store.findById('sub-1')!.processing_outcome).toBe('pending');

    store.insert(bookingInput());
    expect(() => store.markProcessed({ submission_id: 'bk-1', outcome: 'spam' }))
      .toThrow(/not a booking outcome/);
  });

  it('markProcessed refuses a flip back to `pending` — that would re-dispatch the row', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(intakeInput());
    store.markProcessed({ submission_id: 'sub-1', outcome: 'processed' });
    expect(() => store.markProcessed({ submission_id: 'sub-1', outcome: 'pending' }))
      .toThrow(/cannot be flipped back to pending/);
    // The drain must not see it again.
    expect(store.listPendingForEndpoint('ep-intake')).toHaveLength(0);
  });

  it('markProcessed treats `resolved: undefined` as OMITTED, not as a clear', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(intakeInput());
    store.markProcessed({
      submission_id: 'sub-1',
      outcome: 'processed',
      resolved: { kind: 'task', id: 'task-1' },
    });

    // ⛔ The third case. This repo does not set `exactOptionalPropertyTypes`, so
    // forwarding a `| undefined` typechecks against `resolved?: … | null` — and
    // the conditional-spread idiom makes that the natural mistake. `hasOwn`
    // alone would read it as an explicit CLEAR and wipe the pointer, which is
    // the exact silent failure the partial write exists to close.
    const maybeResolved: { kind: string; id: string } | undefined = undefined;
    store.markProcessed({ submission_id: 'sub-1', outcome: 'failed', resolved: maybeResolved });

    const after = store.findById('sub-1')!;
    expect(after.resolved_target_kind).toBe('task');
    expect(after.resolved_target_id).toBe('task-1');
  });

  it('🔴 a wrongly-written row is refused on READ too — and would take the page with it', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(bookingInput());
    // Bypass the store to simulate a hand-edited / future-version row. The read
    // path must not reinterpret it (D-200 6g.12) and must not silently pass it.
    db.prepare(
      `UPDATE reception_form_submission SET processing_outcome = 'spam' WHERE submission_id = 'bk-1'`,
    ).run();

    expect(() => store.findById('bk-1')).toThrow(/invalid processing outcome 'spam' for a booking row/);
    // The blast radius, stated: one bad row, and the whole owner list is gone.
    expect(() => store.listForOwner({ record_kind: 'booking', limit: 10 })).toThrow();
  });
});

describe('D-210 A.8 slice 4b — the kind filter replaces what the table used to do', () => {
  it('an owner list scoped to one kind excludes the other', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(bookingInput());
    store.insert(intakeInput());

    const bookings = store.listForOwner({ record_kind: 'booking', limit: 10 });
    expect(bookings.map((r) => r.submission_id)).toEqual(['bk-1']);

    const intakes = store.listForOwner({ record_kind: 'intake', limit: 10 });
    expect(intakes.map((r) => r.submission_id)).toEqual(['sub-1']);
  });

  it('an UNSCOPED owner list spans both — which is why callers must scope', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    store.insert(bookingInput());
    store.insert(intakeInput());
    // Before the merge this was impossible: you picked a table. The record
    // handler now passes `record_kind` for exactly this reason.
    expect(store.listForOwner({ limit: 10 })).toHaveLength(2);
  });

  it('each drain sees only its own flow', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    // Same endpoint id on purpose — belt-and-braces. A registry endpoint is
    // single-kind, so this cannot happen in production; the predicate must not
    // be relying on that.
    store.insert(bookingInput({ endpoint_id: 'ep-shared' }));
    store.insert(intakeInput({ endpoint_id: 'ep-shared' }));

    expect(store.listPendingBookingsForEndpoint('ep-shared').map((r) => r.submission_id))
      .toEqual(['bk-1']);
    expect(store.listPendingForEndpoint('ep-shared').map((r) => r.submission_id))
      .toEqual(['sub-1']);
  });
});

describe('D-210 A.8 slice 4b — the atomic per-day cap moves with the insert', () => {
  it('refuses past the cap, and returns the row under it', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    const args = { max_bookings_per_day: 2, day_window_start_at: NOW - 86_400_000, now: NOW };

    expect(store.insertIfAvailable({ ...bookingInput({ submission_id: 'bk-1' }), ...args }))
      .toHaveProperty('row');
    expect(store.insertIfAvailable({ ...bookingInput({ submission_id: 'bk-2' }), ...args }))
      .toHaveProperty('row');
    expect(store.insertIfAvailable({ ...bookingInput({ submission_id: 'bk-3' }), ...args }))
      .toEqual({ conflict: 'day_cap' });
  });

  it('`max_bookings_per_day: 0` is uncapped', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    const args = { max_bookings_per_day: 0, day_window_start_at: NOW - 86_400_000, now: NOW };
    for (const id of ['bk-1', 'bk-2', 'bk-3']) {
      expect(store.insertIfAvailable({ ...bookingInput({ submission_id: id }), ...args }))
        .toHaveProperty('row');
    }
  });

  it('🔴 counts a row stamped AFTER the captured `now` — the bound that was removed', () => {
    const db = buildDb();
    const store = createReceptionFormSubmissionStore(db);
    // The booking store dropped its `received_at <= now` bound because inside
    // the atomic re-check it excluded a concurrently-committed row whose stamp
    // is later than THIS request's captured `now`, letting the cap be exceeded.
    // Re-adding it to the merged statement would restore that bug.
    store.insert(bookingInput({ submission_id: 'bk-earlier', submitted_at: NOW + 5_000 }));

    expect(store.countWithinWindow({
      endpoint_id: 'ep-sched',
      window_start_at: NOW - 86_400_000,
      now: NOW,
    })).toBe(1);

    expect(store.insertIfAvailable({
      ...bookingInput({ submission_id: 'bk-2' }),
      max_bookings_per_day: 1,
      day_window_start_at: NOW - 86_400_000,
      now: NOW,
    })).toEqual({ conflict: 'day_cap' });
  });
});
