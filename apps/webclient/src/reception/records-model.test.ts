/** D-210 §4c — reception records view-model tests.
 *
 *  The two things worth pinning here are the ones a rendering test cannot see:
 *
 *    1. **`receptionRecordsListInput` sends the filter to the SERVER.** Filtering client-side
 *       would apply the limit before the filter, so `truncated` would describe a page the owner
 *       never sees. The args are the seam; assert them, not the rows they happen to produce.
 *    2. **`has_resolved: false` survives.** A record that materialized nothing is the entire
 *       reason this surface exists — if that collapses to a falsy check somewhere, the surface
 *       silently stops answering its one question.
 */

import { describe, expect, it } from 'vitest';
import type {
  ReceptionBookingRecordSummary,
  ReceptionSubmissionRecordSummary,
} from '@recued/contracts';

import {
  RECEPTION_RECORDS_WAITING_OUTCOME,
  buildReceptionRecordsModel,
  receptionRecordsListInput,
} from './records-model.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const booking = (
  over: Partial<ReceptionBookingRecordSummary> = {},
): ReceptionBookingRecordSummary => ({
  kind: 'scheduling_link',
  record_id: 'bk_1',
  endpoint_id: 'ep_sched',
  received_at: NOW - 2 * HOUR,
  outcome: 'pending',
  slot: {
    start_at: NOW + 24 * HOUR,
    end_at: NOW + 25 * HOUR,
    duration_minutes: 60,
  },
  resolved: [],
  ...over,
});

const submission = (
  over: Partial<ReceptionSubmissionRecordSummary> = {},
): ReceptionSubmissionRecordSummary => ({
  kind: 'intake_form',
  record_id: 'sb_1',
  endpoint_id: 'ep_intake',
  received_at: NOW - 3 * HOUR,
  outcome: 'processed',
  form_definition_id: 'form_a',
  resolved: [{ kind: 'form_response', id: 'fr_1' }],
  ...over,
});

const build = (
  records: ReadonlyArray<ReceptionBookingRecordSummary | ReceptionSubmissionRecordSummary>,
  over: Partial<Parameters<typeof buildReceptionRecordsModel>[0]> = {},
) =>
  buildReceptionRecordsModel({
    records,
    truncated: false,
    kind: 'all',
    outcome: 'all',
    now: NOW,
    ...over,
  });

describe('receptionRecordsListInput — the server-side filter seam', () => {
  it('sends nothing when unfiltered', () => {
    expect(receptionRecordsListInput({ kind: 'all', outcome: 'all' })).toEqual({});
  });

  it('maps the waiting lens to the one outcome BOTH vocabularies carry', () => {
    // ⛔ If this ever stops being `pending`, a no-kind waiting query starts failing one arm with
    // `reception_record_invalid` — the handler validates against the SELECTED kind's own list.
    expect(RECEPTION_RECORDS_WAITING_OUTCOME).toBe('pending');
    expect(receptionRecordsListInput({ kind: 'all', outcome: 'waiting' })).toEqual({
      outcome: 'pending',
    });
  });

  it('sends the kind when one is picked, and both together', () => {
    expect(receptionRecordsListInput({ kind: 'scheduling_link', outcome: 'all' })).toEqual({
      kind: 'scheduling_link',
    });
    expect(
      receptionRecordsListInput({ kind: 'intake_form', outcome: 'waiting' }),
    ).toEqual({ kind: 'intake_form', outcome: 'pending' });
  });

  it('OMITS the keys rather than sending undefined', () => {
    // `toEqual` treats `{ kind: undefined }` as `{}`, so it cannot catch an explicit undefined
    // reaching the wire. [[an_absent_key_needs_object_hasown]]
    const args = receptionRecordsListInput({ kind: 'all', outcome: 'all' });
    expect(Object.hasOwn(args, 'kind')).toBe(false);
    expect(Object.hasOwn(args, 'outcome')).toBe(false);
  });
});

describe('buildReceptionRecordsModel', () => {
  it('keeps a booking slot and gives an intake none', () => {
    const model = build([booking(), submission()]);
    const [bk, sb] = model.rows;
    expect(bk?.slot).toEqual({
      start_at: NOW + 24 * HOUR,
      end_at: NOW + 25 * HOUR,
      duration_minutes: 60,
    });
    expect(sb?.slot).toBeNull();
  });

  it('reads the DISCRIMINANT for slot, not the shape', () => {
    // 🔑 A SHAPE IS NOT A ROLE. Without this, `'slot' in record ? record.slot : null` passes
    // every other test in this file — the fixtures make the two implementations
    // indistinguishable, so the discriminant looks load-bearing while nothing holds it there.
    // A server that ever puts a `slot` key on an intake row would then render one.
    const strayShaped = {
      ...submission(),
      slot: { start_at: NOW, end_at: NOW + HOUR, duration_minutes: 60 },
    } as unknown as ReceptionSubmissionRecordSummary;
    expect(build([strayShaped]).rows[0]?.slot).toBeNull();
  });

  it('marks a record that materialized NOTHING — the signal the surface exists for', () => {
    const model = build([booking({ resolved: [] })]);
    expect(model.rows[0]?.has_resolved).toBe(false);
    expect(model.rows[0]?.resolved).toEqual([]);
  });

  it('carries the resolved pointer through with a human kind label', () => {
    const model = build([
      booking({ resolved: [{ kind: 'calendar.event', id: 'ev_9' }] }),
    ]);
    expect(model.rows[0]?.has_resolved).toBe(true);
    expect(model.rows[0]?.resolved[0]).toEqual({
      kind: 'calendar.event',
      kind_label: 'Calendar event',
      id: 'ev_9',
    });
  });

  it('labels BOTH halves of an approved reservation — event and booking', () => {
    // D-210 slice 3 — one approve now resolves to two rows. The label map is
    // keyed by open `string` with a `?? kind` fallback, so a missing member
    // typechecks and renders the raw slug ('booking') next to a properly
    // labelled 'Calendar event'. It fails SOFT, which is why the compiler
    // cannot catch it and this test must.
    const model = build([
      booking({
        resolved: [
          { kind: 'calendar.event', id: 'ev_9' },
          { kind: 'booking', id: 'bkg_9' },
        ],
      }),
    ]);
    expect(model.rows[0]?.resolved.map((r) => r.kind_label)).toEqual([
      'Calendar event',
      'Booking',
    ]);
  });

  it('counts waiting rows and flags only pending ones', () => {
    const model = build([
      booking({ record_id: 'a', outcome: 'pending' }),
      booking({ record_id: 'b', outcome: 'processed' }),
      submission({ record_id: 'c', outcome: 'pending' }),
    ]);
    expect(model.waiting_count).toBe(2);
    expect(model.rows.map((r) => r.waiting)).toEqual([true, false, true]);
  });

  it('labels outcomes from BOTH closed vocabularies', () => {
    const model = build([
      booking({ record_id: 'a', outcome: 'requires_review' }),
      booking({ record_id: 'b', outcome: 'auto_confirmed' }),
      submission({ record_id: 'c', outcome: 'rejected_domain' }),
      submission({ record_id: 'd', outcome: 'spam' }),
    ]);
    expect(model.rows.map((r) => r.outcome_label)).toEqual([
      'Needs review',
      'Auto-confirmed',
      'Blocked domain',
      'Spam',
    ]);
  });

  it('passes an UNKNOWN outcome through rather than dropping the row', () => {
    // A newer server can send an outcome this build has never heard of. Dropping the row would
    // read as "you received nothing", which is the one thing a reception list must not imply.
    const model = build([
      booking({ outcome: 'invented_later' as ReceptionBookingRecordSummary['outcome'] }),
    ]);
    expect(model.total).toBe(1);
    expect(model.rows[0]?.outcome_label).toBe('invented_later');
    expect(model.rows[0]?.waiting).toBe(false);
  });

  it('marks terminal outcomes so an unresolved row stops saying "yet"', () => {
    // A `spam` row will never materialize anything. Rendering "Nothing materialized YET" told
    // the owner to keep waiting for something that is not coming — a false claim on a review
    // surface. Caught by looking at the browser render, not by any assertion above.
    const model = build([
      booking({ record_id: 'a', outcome: 'pending' }),
      booking({ record_id: 'b', outcome: 'rejected' }),
      submission({ record_id: 'c', outcome: 'spam', resolved: [] }),
      submission({ record_id: 'd', outcome: 'duplicate', resolved: [] }),
      submission({ record_id: 'e', outcome: 'rejected_domain', resolved: [] }),
      // ⚠ `failed` is NOT terminal — the drain leaves work retryable rather than materializing
      // a fallback, so "yet" is the honest word.
      submission({ record_id: 'f', outcome: 'failed', resolved: [] }),
    ]);
    expect(model.rows.map((r) => r.terminal)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('treats an UNKNOWN outcome as non-terminal (the weaker claim)', () => {
    const model = build([
      booking({ outcome: 'invented_later' as ReceptionBookingRecordSummary['outcome'] }),
    ]);
    expect(model.rows[0]?.terminal).toBe(false);
  });

  it('distinguishes "nothing yet" from "nothing matches"', () => {
    expect(build([]).empty_reason).toBe('no_records');
    expect(build([], { outcome: 'waiting' }).empty_reason).toBe('filtered_out');
    expect(build([], { kind: 'intake_form' }).empty_reason).toBe('filtered_out');
    expect(build([booking()]).empty_reason).toBe('none');
  });

  it('carries truncation through untouched', () => {
    expect(build([booking()], { truncated: true }).truncated).toBe(true);
    expect(build([booking()]).truncated).toBe(false);
  });

  it('ages received_at relative to now', () => {
    const model = build([booking({ received_at: NOW - 2 * HOUR })]);
    expect(model.rows[0]?.received_label).toBe('2 hours ago');
  });
});
