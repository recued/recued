/** D-210 R-2 — the booking RECORD, as a paired recipe receives it.
 *
 *  ## The shape, and why it is the form's shape
 *
 *  A paired intake recipe receives the visitor's fields as a FLAT MAP and nothing else —
 *  `reception-recipe-runner-adapter.ts` opens the sealed blob, takes `.fields`, and hands
 *  that straight to the runner as `context.reception_submission`. No envelope, no ids, no
 *  projection. A booking reaches its recipe the same way (owner-ruled 2026-07-17: *"the
 *  system record to form table regardless, but the recipe can decide where to go next
 *  freely"*), because a booking IS a form submission in every respect that matters to a
 *  recipe: a set of fields the visitor filled in, plus the slot they picked.
 *
 *  ⛔ What is deliberately NOT here is the calendar. The drain's OTHER payload — the one the
 *  pack's compiled default consumes — is a `ReceptionProjectionInput`: `top_tier_kind:
 *  'calendar.event'`, a `title` with the name and topic mashed into a sentence,
 *  `booking_request_id`, `reject_if_slot_past`. Those are one materialize op's ARGS, not the
 *  record, and they answer "where does this go" — which is the paired recipe's decision to
 *  make, not ours to have made for it.
 *
 *  ## The key set IS the digest subject
 *
 *  The v3 pair digests `{ required_visitor_fields, recipe }`, on the owner's ruling that the
 *  visitor-field map is *"exactly what determines what the paired recipe RECEIVES"*. This
 *  module is where that stops being an assertion: a field the config marks `omit` is ABSENT
 *  from the record, and a declared field the visitor left blank is PRESENT and null. So the
 *  record's key set is literally the config's declared set — flip `phone` to `omit` and the
 *  payload and the pair revision change together, which is the property that makes the
 *  digest guard anything at all.
 *
 *  Field names are the CONFIG's vocabulary (`name` / `email` / `phone` / `topic` / `notes`),
 *  derived from `SCHEDULING_LINK_VISITOR_FIELD_NAMES` rather than re-listed, so the payload
 *  and the digest subject cannot come to disagree about which fields exist. The `visitor_*`
 *  spelling is the storage/AAD binding and stays behind this boundary — a recipe reads
 *  `{{context.reception_submission.phone}}`, the same word the owner sets to `omit`.
 *
 *  Spec: `docs/d-210-spec.md` §3 / §2.6; `docs/d-149-spec.md` § A.5.2 + § N.6. */

import {
  SCHEDULING_LINK_VISITOR_FIELD_NAMES,
  type SchedulingLinkVisitorFieldRequirements,
} from '@recued/contracts';

import { openBookingSubmissionBlob } from './booking-blob.js';
import type { FormSubmissionSummary } from '../../storage/reception-form-store.js';

export type PairedBookingRecordResult =
  | { readonly kind: 'ready'; readonly record: Record<string, unknown> }
  /** A declared field's ciphertext would not open — a rotated key, a tampered row. The
   *  caller MUST refuse rather than run: a recipe reading
   *  `{{context.reception_submission.email}}` would quietly see nothing and write a blank
   *  record. Never confused with a `null` ciphertext, which is an optional field the
   *  visitor legitimately left blank. */
  | { readonly kind: 'unreadable' };

/** Open the booking's declared visitor fields and assemble the record the paired recipe
 *  reads as `context.reception_submission`.
 *
 *  ⚠ Every value here is TAINTED (`origin_actor: 'anonymous'`, D-177 N.11). Taint propagates
 *  through every step kind including AI, so a write whose authority-bearing args derive from
 *  these can never ride a standing grant — it holds for the owner. That is what closes
 *  prompt-injection by construction, and it is enforced at the Gateway, not here. */
export const buildPairedBookingRecord = async (input: {
  readonly key: Uint8Array;
  readonly endpoint_id: string;
  readonly row: FormSubmissionSummary;
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  /** The endpoint's availability-window tz — the frame the slot's epoch stamps mean
   *  anything in. */
  readonly timezone: string;
}): Promise<PairedBookingRecordResult> => {
  // D-210 A.8 slice 4b-ii — ONE open, not five. The five ciphertexts became one
  // `submission_blob_encrypted` with the table merge, so the per-field ciphertext map this
  // module used to carry is gone: there is nothing left to route, only a blob to open and a
  // config to filter it by.
  //
  // ⚠ The FILTERING is what still matters, and it did not move. A field the config marks
  // `omit` is ABSENT from the record; a declared field the visitor left blank is PRESENT and
  // null. That distinction is the whole reason the v3 pair digest can guard anything (see the
  // header), and the blob deliberately does NOT encode it — the blob carries all five,
  // present-or-null, and the CURRENT config decides which are real.
  if (input.row.slot === null) {
    // Not a booking row. Unreachable through the drain, which reads a booking-scoped page —
    // but building a "booking record" from an intake row would silently produce a record with
    // no slot, and a recipe would write it.
    return { kind: 'unreadable' };
  }
  let fields;
  try {
    fields = await openBookingSubmissionBlob({
      key: input.key,
      endpoint_id: input.endpoint_id,
      submission_id: input.row.submission_id,
      ciphertext: input.row.submission_blob_encrypted,
    });
  } catch {
    // THROWS rather than returning nulls on a malformed or unopenable blob. Every unreadable
    // path lands here, on one outcome the caller must refuse.
    //
    // ⚠ The blast radius GREW with the merge: one bad blob now costs all five fields, where a
    // bad column cost one. That makes refusing more important, not less — a partial record is
    // exactly what a recipe would read and write as fact.
    return { kind: 'unreadable' };
  }

  const record: Record<string, unknown> = {};
  for (const field of SCHEDULING_LINK_VISITOR_FIELD_NAMES) {
    // `omit` ⇒ the key is ABSENT, not null. The config says this endpoint never collects
    // the field, so the record must not claim it exists and happens to be empty.
    if (input.required_visitor_fields[field] === 'omit') continue;
    record[field] = fields[field];
  }

  // The slot the visitor picked. Safe to sit flat beside the visitor fields ONLY because
  // that field set is closed (`SCHEDULING_LINK_VISITOR_FIELD_NAMES`) and contains none of
  // these names — a booking page has no authored schema, so a visitor can never introduce
  // a field that shadows one.
  record.slot_start_at = input.row.slot.start_at;
  record.slot_end_at = input.row.slot.end_at;
  record.duration_minutes = input.row.slot.duration_minutes;
  record.timezone = input.timezone;

  return { kind: 'ready', record };
};
