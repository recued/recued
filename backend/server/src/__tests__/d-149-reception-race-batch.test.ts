/** D-149 reception race-batch (Codex pass-2 TOCTOU findings).
 *
 *  #1 — per-day-cap TOCTOU. The handler's cap pre-check runs before the async
 *  PII-seal, so two concurrent visitors can both pass then both insert.
 *  `insertIfAvailable` re-checks INSIDE a synchronous transaction (no
 *  event-loop yield), so the check+insert can't interleave. (The #4
 *  nonce-before-blob guard is covered by the drop-link handler suite.)
 *
 *  ⚠ The SLOT half of #1 is retired (2026-07-16). `insertIfAvailable` no longer
 *  refuses an overlapping booking: that refusal hard-coded capacity to 1 per
 *  endpoint, which only fits a one-table restaurant. Concurrent bookings are
 *  legitimate; how many is too many is the owner's judgment at the D-157 gate.
 *  Only the VOLUME cap (`max_bookings_per_day`, owner-set) is still atomic here
 *  — and it is still a genuine TOCTOU, hence this file.
 *
 *  ⚠ D-210 A.8 slice 4c re-pointed these at `ReceptionFormSubmissionStore`: the
 *  booking store this was written against is deleted and a booking is now a
 *  `reception_form_submission` row. The guard moved WITH the insert, so the
 *  finding it closes is unchanged and all three claims survive verbatim. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';

const mkStore = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return createReceptionFormSubmissionStore(db);
};

const base = (over: Record<string, unknown>) => ({
  submission_id: 'r1',
  endpoint_id: 'ep',
  form_definition_id: null,
  submitted_at: 1000,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  submission_blob_encrypted: 'AQID',
  schema_version: 1,
  processing_outcome: 'pending',
  slot: { start_at: 5000, end_at: 5900, duration_minutes: 15 },
  max_bookings_per_day: 0,
  day_window_start_at: 0,
  now: 1000,
  ...over,
});

describe('#1 booking insertIfAvailable — atomic per-day-cap guard', () => {
  it('admits concurrent bookings at the SAME slot (capacity is the owner’s call, not the store’s)', () => {
    // The retired overlap guard refused this, hard-coding capacity to 1. Ten
    // bookings at one time is a yoga class, not a bug — the owner judges at
    // the gate. This asserts the DELETION holds: re-adding the refusal fails
    // here, which is the point.
    const store = mkStore();
    expect('row' in store.insertIfAvailable(base({ submission_id: 'r1' }))).toBe(true);
    expect('row' in store.insertIfAvailable(base({ submission_id: 'r2' }))).toBe(true);
    expect('row' in store.insertIfAvailable(base({ submission_id: 'r3' }))).toBe(true);
  });

  it('rejects past the per-day cap (conflict=day_cap), 0 = uncapped', () => {
    const store = mkStore();
    store.insertIfAvailable(base({ submission_id: 'r1', max_bookings_per_day: 1 }));
    const capped = store.insertIfAvailable(
      base({
        submission_id: 'r2',
        slot: { start_at: 9000, end_at: 9900, duration_minutes: 15 },
        max_bookings_per_day: 1,
      }),
    );
    expect(capped).toEqual({ conflict: 'day_cap' });
  });

  it('day-cap counts a row whose submitted_at is later than the counting now (Codex fold — no upper bound)', () => {
    // The old `submitted_at <= now` bound dropped a concurrently-committed
    // booking whose stamp landed after THIS request's captured `now`,
    // letting the cap be exceeded. r1 commits with submitted_at=5000; r2 counts
    // with now=3000 and must still see r1.
    const store = mkStore();
    store.insertIfAvailable(base({ submission_id: 'r1', submitted_at: 5000 }));
    const r2 = store.insertIfAvailable(
      base({
        submission_id: 'r2',
        slot: { start_at: 9000, end_at: 9900, duration_minutes: 15 },
        submitted_at: 3000,
        now: 3000,
        day_window_start_at: 0,
        max_bookings_per_day: 1,
      }),
    );
    expect(r2).toEqual({ conflict: 'day_cap' });
  });
});
