/** D-210 step 2a — the reception RECORD, as its owner reads it.
 *
 * ## Why this exists
 *
 * Until now a reception row was invisible for its entire life. Every reader of
 * `reception_booking_request` / `reception_form_submission` was the public visitor handler,
 * the drain, the projection, or the promotion — **zero rpcs**, and neither table is a `data.*`
 * collection, so the `#data` explorer cannot reach them by construction (D-210 Appendix A).
 * A booking was visible as a held op in the inbox and then as a calendar event; the row
 * itself, never. So a booking the drain HOLDS — a stale pair, an unconfirmed door, a failed
 * paired run — has nowhere to appear at all, because a held row has no held op.
 *
 * This is the read surface D-210 §2.2 ("the inbox holds the record") needs to exist first.
 *
 * ## ⛔ Redacted by construction
 *
 * No sealed visitor PII, and no ciphertext either. D-149 § N.6 seals the visitor's fields;
 * D-173 I-3 keeps them sealed until the owner opens an item. This projection is the LIST, so
 * it carries neither the plaintext nor the ciphertext to decrypt it from — a reader that
 * wants the visitor's values must go through a gated per-record read, which does not exist
 * yet and is deliberately not invented here.
 *
 * ## The two kinds are ONE TABLE and still TWO ARMS
 *
 * ⚠ This section used to say the two kinds stay SIBLINGS, on an owner ruling that
 * `reception_booking_request` must not collapse into `reception_form_submission`. **D-210 A.3
 * reversed that on a CHANGED PREMISE** — the ruling's stated reason was triple entries
 * (submission → request → calendar), and A.2 removed the calendar from the booking path, so the
 * chain is submission → destination and the third entry does not exist. A.8 slice 4b-ii carried
 * out the merge. ⛔ If A.2 is ever walked back, this reverts with it.
 *
 * 🔑 **What did NOT reverse is the vocabulary reasoning.** The two `processing_outcome`
 * vocabularies overlap on `pending` + `processed` and then diverge completely
 * (`auto_confirmed` / `requires_review` / `rejected` vs `failed` / `duplicate` / `spam` /
 * `rejected_domain`), and the argument against a union — *it would let a reader ask a booking
 * whether it was `spam`* — outlives the sibling tables it was written about. So the merged
 * COLUMN admits the union because one column physically must, while each ROW admits only its
 * own kind's list (`outcomesForRecordKind`), and THIS type keeps its two narrow arms. The
 * enforcement moved; the rule did not.
 *
 * What genuinely IS shared is the arc — submitted → held → resolved — and that is exactly
 * what the base carries.
 */

import type { IntakeFormSubmissionProcessingOutcome } from './intake-form-config.js';
import type { SchedulingLinkBookingProcessingOutcome } from './scheduling-link-config.js';

/** What a record became.
 *
 * ⚠ An ARRAY for a reason that has since expired, and it is kept deliberately. It was an array
 * because a booking had TWO frozen destination columns (`resolved_calendar_event_id` +
 * `resolved_booking_id`) and normally carried both — one approve minting a calendar event AND
 * a booking beside it. **A.2 ended that** (a reservation materializes no calendar event, so the
 * event column went permanently null) and **A.8 slice 4b-ii deleted both columns**, collapsing
 * them into the generic `resolved_target_kind` / `resolved_target_id` pair the submission
 * always had. So today this holds one entry or zero.
 *
 * 🔑 It stays an ARRAY because an empty one is load-bearing: a HELD row resolves to nothing,
 * and "nothing yet" is precisely what the owner needs to see. A nullable single would say the
 * same thing less clearly, and a future destination that fans out would need the array back.
 *
 * ⛔ The earlier note here — *"the booking columns are load-bearing;
 * `resolved_calendar_event_id` is the I-4 idempotency anchor"* — was already refuted by slice
 * 3b, which made the BOOKING ROW the anchor. It is gone with the columns. */
export interface ReceptionRecordResolution {
  /** `'calendar.event'` / `'booking'` for a booking (derived from WHICH column is set);
   *  the submission's own `resolved_target_kind` verbatim for an intake. */
  readonly kind: string;
  readonly id: string;
}

interface ReceptionRecordBase {
  /** `request_id` on a booking, `submission_id` on a submission. */
  readonly record_id: string;
  readonly endpoint_id: string;
  /** When the visitor submitted. `received_at` on a booking, `submitted_at` on a submission —
   *  one concept, two column names. Unix ms. */
  readonly received_at: number;
  /** What the record became. Empty until something materializes — which for a HELD row is the
   *  whole point: it is how the owner sees that nothing has. */
  readonly resolved: ReadonlyArray<ReceptionRecordResolution>;
}

export interface ReceptionBookingRecordSummary extends ReceptionRecordBase {
  readonly kind: 'scheduling_link';
  readonly outcome: SchedulingLinkBookingProcessingOutcome;
  /** The slot the visitor picked. NOT visitor PII — it is the booking's substance, and the
   *  inbox card already surfaces a held booking's slot as `preview.when`. */
  readonly slot: {
    readonly start_at: number;
    readonly end_at: number;
    readonly duration_minutes: number;
  };
}

export interface ReceptionSubmissionRecordSummary extends ReceptionRecordBase {
  readonly kind: 'intake_form';
  readonly outcome: IntakeFormSubmissionProcessingOutcome;
  /** ⚠ A NAME, not a join key. `reception_form_definition` has zero writers and zero readers
   *  outside its own store file — the row this id names has never existed. It is carried
   *  because it is what the record stores and the owner's endpoint config uses the same id;
   *  do NOT add a reader that tries to resolve it.
   *
   *  D-210 A.8 slice 4b — NULLABLE. The merged table's column is nullable because a booking
   *  has no form definition, and the honest encoding of absent is absent: a `''` default here
   *  would be a sentinel, which is exactly what the 4a schema note refuses (a value rows can
   *  collide on). An intake reaching this projection always has one. */
  readonly form_definition_id: string | null;
}

/** One reception record, redacted. Discriminated on `kind` so each arm keeps its own closed
 *  outcome vocabulary. */
export type ReceptionRecordSummary =
  | ReceptionBookingRecordSummary
  | ReceptionSubmissionRecordSummary;

/** The kinds that HAVE a record table. ⛔ Not the same list as the pairable kinds
 *  (`RECEPTION_PAIR_CONSUMER`) and not the same as `ReceptionEndpointKind` — `drop_link` and
 *  `approval_link` persist through other tables, and `reception_page` / `status_link` persist
 *  nothing. Keyed here rather than derived from the endpoint union precisely because it is a
 *  different question. */
export const RECEPTION_RECORD_KINDS = ['scheduling_link', 'intake_form'] as const;
export type ReceptionRecordKind = (typeof RECEPTION_RECORD_KINDS)[number];
export const RECEPTION_RECORD_KIND_SET: ReadonlySet<ReceptionRecordKind> =
  new Set(RECEPTION_RECORD_KINDS);
export const isReceptionRecordKind = (value: unknown): value is ReceptionRecordKind =>
  typeof value === 'string' && RECEPTION_RECORD_KIND_SET.has(value as ReceptionRecordKind);

export const RECEPTION_RECORD_LIST_LIMIT_MAX = 200;
export const RECEPTION_RECORD_LIST_LIMIT_DEFAULT = 50;

export interface ReceptionRecordListInput {
  /** Absent ⇒ every record kind. */
  readonly kind?: ReceptionRecordKind;
  /** Absent ⇒ every endpoint of the selected kind(s). */
  readonly endpoint_id?: string;
  /** Absent ⇒ every outcome. ⚠ A free string, validated against the SELECTED kind's own
   *  vocabulary at the handler — the two vocabularies are different, so a closed type here
   *  would have to be their union and would let a caller ask a booking for `spam`. */
  readonly outcome?: string;
  readonly limit?: number;
}

export interface ReceptionRecordListResult {
  /** Newest first (`received_at DESC`). */
  readonly records: ReadonlyArray<ReceptionRecordSummary>;
  /** `true` when the limit truncated the answer. ⛔ Never silently truncate: a reception list
   *  is exactly the surface where "I see all of them" must be either true or visibly false. */
  readonly truncated: boolean;
}
