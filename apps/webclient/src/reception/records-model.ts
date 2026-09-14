/** D-210 §4c — the reception RECORDS view model.
 *
 *  Step 2a shipped `reception.record.list` server-side and nothing read it: `grep
 *  'reception.record' apps/webclient/src` answered ZERO. This module is the read half of
 *  closing that — the pure state → rows mapping, so the panel owns DOM and this owns meaning.
 *
 *  ## What this surface is FOR, and what it is not
 *
 *  ⛔ It is NOT a data browser. `#data` owns browsing, on the DESTINATION — a resolved booking
 *  is already fully served there (record → `resolved` → the calendar event / work entity, with
 *  CRUD). What `#data` structurally cannot show is a record that resolved to NOTHING, because
 *  there is no destination row to browse. That is this surface's entire job.
 *
 *  🔑 And per D-210 §4 (owner-ruled 2026-07-17) the record is **write-once** — *"the
 *  schedule_link & intake.form is untouch … when owner approved with edited, it move to the
 *  designated destination, which is mutated"*. So this is READ-ONLY by construction, not by
 *  omission. There is no edit rpc to call and building one would contradict the ruling.
 *
 *  ## The `waiting` lens is the point
 *
 *  A record whose `outcome` is `pending` is one the drain did not hand off — a stale pair, an
 *  unconfirmed door, a failed paired run (`scheduling-link-processor.ts`: *"Leave PENDING to
 *  retry — never materialize as a fallback"*). It has no held op, so the INBOX cannot show it
 *  however good its join is, and it has no destination, so `#data` cannot either. Before this
 *  surface such a row was invisible for its entire life.
 *
 *  ⚠ `pending` is NOT the same as "stuck" and the copy must not say it is — a row that arrived
 *  three seconds ago is `pending` too, and will drain on the next tick. "Waiting" is the honest
 *  word: true of both, alarming about neither.
 *
 *  ⚠ A `processed` record with an EMPTY `resolved` is a different and NORMAL state: the drain
 *  handed it to review-then-approve and the inbox owns it now (`resolved_*` stay null until the
 *  owner approves — I-4). Do not fold the two together; one wants the owner's attention here,
 *  the other wants it in the Inbox.
 *
 *  Spec: D-210 §2.2 + Appendix A; contract: `packages/contracts/src/reception-record.ts`. */

import type {
  IntakeFormSubmissionProcessingOutcome,
  ReceptionRecordKind,
  ReceptionRecordListInput,
  ReceptionRecordSummary,
  SchedulingLinkBookingProcessingOutcome,
} from '@recued/contracts';

// Reused rather than reimplemented so both reception surfaces age a timestamp identically —
// two formatters would drift into disagreeing about what "2 hours ago" means.
import { computeReceptionInboxWhenLabel } from './inbox-model.js';

// ════════════════════════════════════════════════════════════════
// Filters
// ════════════════════════════════════════════════════════════════

export type ReceptionRecordsKindFilter = 'all' | ReceptionRecordKind;

/** ⛔ Deliberately TWO values, not the outcome union. The two kinds' vocabularies overlap on
 *  `pending` + `processed` and then diverge completely, and the handler validates `outcome`
 *  against the SELECTED kind's own list — so a per-outcome picker would have to either bind
 *  itself to a chosen kind or offer members that make one arm answer `reception_record_invalid`.
 *  `waiting` maps to `pending`, which is the one member BOTH vocabularies carry, so it is safe
 *  to send with no kind selected. Widening this is a real design step, not a config tweak. */
export type ReceptionRecordsOutcomeFilter = 'all' | 'waiting';

/** The outcome a `waiting` filter sends on the wire. Named so the mapping is stated once. */
export const RECEPTION_RECORDS_WAITING_OUTCOME = 'pending';

// ════════════════════════════════════════════════════════════════
// Labels
// ════════════════════════════════════════════════════════════════

const KIND_LABELS: Readonly<Record<ReceptionRecordKind, string>> = {
  scheduling_link: 'Booking',
  intake_form: 'Intake form',
};

/** ⛔ Keyed on the UNION of both closed vocabularies, so adding an outcome to either const in
 *  contracts is a TYPE ERROR here rather than a row that renders a raw enum at the owner.
 *  [[a_subset_typechecks_so_derive_the_closed_list]] — a copied list would typecheck as a
 *  subset and rot in silence. */
const OUTCOME_LABELS: Readonly<
  Record<SchedulingLinkBookingProcessingOutcome | IntakeFormSubmissionProcessingOutcome, string>
> = {
  pending: 'Waiting',
  processed: 'Processed',
  auto_confirmed: 'Auto-confirmed',
  requires_review: 'Needs a look',
  rejected: 'Rejected',
  failed: 'Failed',
  duplicate: 'Duplicate',
  spam: 'Spam',
  rejected_domain: 'That email address is blocked',
};

/** ⚠ `outcome` is typed per-arm on the contract but arrives over the wire, so an unknown value
 *  is possible from a newer server. Fall back to the raw string rather than dropping the row —
 *  on THIS surface an omitted record reads as "you received nothing", which is the one thing a
 *  reception list must never imply. */
const outcomeLabel = (outcome: string): string =>
  (OUTCOME_LABELS as Readonly<Record<string, string>>)[outcome] ?? outcome;

/** Does this outcome mean the record will NEVER materialize anything?
 *
 *  🔑 The difference is a claim, not a nicety. An unresolved row reads "Nothing materialized
 *  YET" — true of a booking the drain is still holding, and a LIE about a `spam` submission,
 *  which told the owner to keep waiting for something that is never coming.
 *  [[a_rendering_is_a_claim_about_what_it_shows]]
 *
 *  ⚠ `failed` is deliberately NOT terminal: the drain's posture is to leave work retryable
 *  rather than materialize a fallback, so "yet" is the honest word there.
 *
 *  ⛔ Exhaustive over both vocabularies, so a new outcome is a TYPE ERROR that forces this
 *  call rather than silently defaulting to the friendlier (and possibly false) copy. */
const OUTCOME_TERMINAL: Readonly<
  Record<SchedulingLinkBookingProcessingOutcome | IntakeFormSubmissionProcessingOutcome, boolean>
> = {
  pending: false,
  processed: false,
  auto_confirmed: false,
  requires_review: false,
  failed: false,
  rejected: true,
  duplicate: true,
  spam: true,
  rejected_domain: true,
};

/** Unknown outcome ⇒ NOT terminal. The weaker claim: "yet" merely says we do not know it is
 *  over, where the terminal copy asserts that it is. */
const isTerminalOutcome = (outcome: string): boolean =>
  (OUTCOME_TERMINAL as Readonly<Record<string, boolean>>)[outcome] ?? false;

/** The `resolved` pointer's kind, as a human phrase. Open vocabulary by
 *  contract, so this maps what we know and passes through the rest. */
const RESOLUTION_KIND_LABELS: Readonly<Record<string, string>> = {
  'calendar.event': 'Calendar event',
  // An approved reservation resolves to its canonical booking.
  booking: 'Booking',
  // Still reachable: an INTAKE's generic `resolved_target_kind` may name a
  // commitment. Only SCHEDULING stopped resolving to one.
  commitment: 'Commitment',
  form_response: 'Form response',
  contact: 'Contact',
  task: 'Task',
  note: 'Note',
  project: 'Project',
};

const resolutionKindLabel = (kind: string): string =>
  RESOLUTION_KIND_LABELS[kind] ?? kind;

// ════════════════════════════════════════════════════════════════
// Row + model shapes
// ════════════════════════════════════════════════════════════════

export interface ReceptionRecordResolutionModel {
  readonly kind: string;
  readonly kind_label: string;
  readonly id: string;
}

export interface ReceptionRecordRowModel {
  readonly record_id: string;
  readonly kind: ReceptionRecordKind;
  readonly kind_label: string;
  readonly endpoint_id: string;
  readonly received_at: number;
  /** Relative ("3 hours ago"), from the inbox's own helper so both reception surfaces age a
   *  timestamp the same way. */
  readonly received_label: string;
  readonly outcome: string;
  readonly outcome_label: string;
  /** `outcome === 'pending'` — the drain has not handed this off. See the header: waiting, not
   *  necessarily stuck. */
  readonly waiting: boolean;
  /** Booking only — the slot the visitor picked. Absolute, because an appointment time means
   *  nothing relative. Null on an intake row. */
  readonly slot: {
    readonly start_at: number;
    readonly end_at: number;
    readonly duration_minutes: number;
  } | null;
  readonly resolved: ReadonlyArray<ReceptionRecordResolutionModel>;
  /** 🔑 `false` ⇒ nothing materialized. THE signal this surface exists to carry: for a held row
   *  it is how the owner sees that nothing has. */
  readonly has_resolved: boolean;
  /** The outcome is final — nothing will ever materialize. Drives whether an unresolved row
   *  says "yet". See `OUTCOME_TERMINAL`. */
  readonly terminal: boolean;
}

export interface ReceptionRecordsModel {
  readonly rows: ReadonlyArray<ReceptionRecordRowModel>;
  readonly total: number;
  /** How many of the rendered rows are waiting. ⚠ Scoped to THIS response, not to the server —
   *  under a `kind` filter or a truncated answer it is a count of what is shown, and the copy
   *  must not promise otherwise. */
  readonly waiting_count: number;
  /** ⛔ Surfaced, never swallowed. The contract is explicit: *"a reception list is exactly the
   *  surface where 'I see all of them' must be either true or visibly false."* */
  readonly truncated: boolean;
  readonly empty_reason: 'none' | 'no_records' | 'filtered_out';
}

// ════════════════════════════════════════════════════════════════
// Wire input
// ════════════════════════════════════════════════════════════════

/** Build the rpc args for the active filters.
 *
 *  🔑 Filtering is SERVER-side. Client-side filtering would apply the limit before the filter,
 *  so `truncated` would describe a page the owner never sees — "3 waiting" out of a truncated
 *  50 says nothing about how many are waiting. */
export const receptionRecordsListInput = (filters: {
  kind: ReceptionRecordsKindFilter;
  outcome: ReceptionRecordsOutcomeFilter;
}): ReceptionRecordListInput => ({
  ...(filters.kind !== 'all' ? { kind: filters.kind } : {}),
  ...(filters.outcome === 'waiting'
    ? { outcome: RECEPTION_RECORDS_WAITING_OUTCOME }
    : {}),
});

// ════════════════════════════════════════════════════════════════
// Model
// ════════════════════════════════════════════════════════════════

const toRow = (
  record: ReceptionRecordSummary,
  now: number,
): ReceptionRecordRowModel => {
  const resolved = record.resolved.map((entry) => ({
    kind: entry.kind,
    kind_label: resolutionKindLabel(entry.kind),
    id: entry.id,
  }));
  return {
    record_id: record.record_id,
    kind: record.kind,
    kind_label: KIND_LABELS[record.kind],
    endpoint_id: record.endpoint_id,
    received_at: record.received_at,
    received_label: computeReceptionInboxWhenLabel(record.received_at, now),
    outcome: record.outcome,
    outcome_label: outcomeLabel(record.outcome),
    waiting: record.outcome === RECEPTION_RECORDS_WAITING_OUTCOME,
    // ⛔ Read off the DISCRIMINANT, never a truthiness check on `slot` — an intake row has no
    // slot at all and a booking's slot is always present.
    slot: record.kind === 'scheduling_link' ? record.slot : null,
    resolved,
    has_resolved: resolved.length > 0,
    terminal: isTerminalOutcome(record.outcome),
  };
};

export const buildReceptionRecordsModel = (input: {
  records: ReadonlyArray<ReceptionRecordSummary>;
  truncated: boolean;
  /** The filters the response was fetched under — used ONLY to tell "you have no records" from
   *  "no records match this filter", which are different things to say to an owner. */
  kind: ReceptionRecordsKindFilter;
  outcome: ReceptionRecordsOutcomeFilter;
  now: number;
}): ReceptionRecordsModel => {
  const rows = input.records.map((record) => toRow(record, input.now));
  const filtered = input.kind !== 'all' || input.outcome !== 'all';
  return {
    rows,
    total: rows.length,
    waiting_count: rows.filter((row) => row.waiting).length,
    truncated: input.truncated,
    empty_reason:
      rows.length > 0 ? 'none' : filtered ? 'filtered_out' : 'no_records',
  };
};
