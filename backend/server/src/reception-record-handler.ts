/** D-210 step 2a — `reception.record.list`: the reception record, as its owner reads it.
 *
 *  Reserved admin-only rpc, like every other `reception.*` method. The whole prefix is in
 *  `MCP_RESERVED_RPC_PREFIXES`, so this surface is paired-client-only by construction and
 *  implies no grant work.
 *
 *  ## What this closes
 *
 *  A reception row was invisible for its entire life (D-210 Appendix A). That is tolerable
 *  while every row moves — it becomes a held op, then an artifact. It stops being tolerable
 *  the moment a row can be HELD: since D-210 R-2 the scheduling drain deliberately leaves a
 *  booking `pending` when the owner's paired recipe is stale, the door unconfirmed, or the
 *  run failed — and a held row has no held op, so the inbox cannot show it however good its
 *  join is. Without this rpc the owner has a booking that waits forever and nowhere to see it.
 *
 *  ## ⛔ The redaction is the point
 *
 *  This projection carries neither the visitor's values NOR the ciphertext to recover them.
 *  Both are structural, and the second matters as much as the first: handing back ciphertext
 *  would move the decrypt decision to the caller, and D-149 § N.6 / D-173 I-3 put it here.
 *  A gated per-record reveal is a DIFFERENT surface and is deliberately not invented here.
 *
 *  ⚠ The redaction is defended by `toBookingSummary` / `toSubmissionSummary` naming every
 *  field they emit — never a spread of the store row. A spread would carry
 *  `visitor_email_encrypted` the day someone adds a column, and the test that checks for it
 *  would still pass because it checks the fields it knows about.
 *
 *  Spec: `docs/d-210-spec.md` §2.2 + Appendix A. */

import {
  INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES,
  RECEPTION_RECORD_LIST_LIMIT_DEFAULT,
  RECEPTION_RECORD_LIST_LIMIT_MAX,
  SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES,
  isReceptionRecordKind,
  type IntakeFormSubmissionProcessingOutcome,
  type ReceptionBookingRecordSummary,
  type ReceptionRecordKind,
  type ReceptionRecordListInput,
  type ReceptionRecordListResult,
  type ReceptionRecordResolution,
  type ReceptionRecordSummary,
  type ReceptionSubmissionRecordSummary,
  type SchedulingLinkBookingProcessingOutcome,
} from '@recued/contracts';

import type { FormSubmissionStore, FormSubmissionSummary } from './storage/reception-form-store.js';

export class ReceptionRecordRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ReceptionRecordRpcError';
  }
}

export interface ReceptionRecordDeps {
  /** Absent ⇒ that kind contributes nothing. A partial boot answers with what it has rather
   *  than 503-ing the whole list: a missing booking store must not hide the submissions. */
  /** D-210 A.8 slice 4b-ii — BOTH arms read the same merged store now, and are
   *  told apart by `record_kind`. Kept as two deps because a partial boot may
   *  wire one and not the other, and a missing booking store must not hide the
   *  submissions. */
  readonly getBookingStore?: () => Pick<FormSubmissionStore, 'listForOwner'> | undefined;
  readonly getSubmissionStore?: () => Pick<FormSubmissionStore, 'listForOwner'> | undefined;
}

const badRequest = (method: string, code: string, message: string): ReceptionRecordRpcError =>
  new ReceptionRecordRpcError(code, `${method}: ${message}`, 400);

/** ⛔ The same gate every other `reception.*` method applies. The reserved prefix keeps this
 *  off MCP, but that is a CHANNEL fence, not an actor one — an unregistered connection on the
 *  paired transport is still a caller. A record list is the visitor's data; it answers to a
 *  paired admin or to nobody. */
const requireAdmin = (
  caller: { instance_id?: string | null | undefined } | undefined,
  method: string,
): void => {
  if (!caller?.instance_id) {
    throw new ReceptionRecordRpcError(
      'permission_denied',
      `${method}: requires a paired admin client (D-121); dispatched from an unregistered connection`,
      403,
    );
  }
};

/** ⛔ Every field NAMED, never a spread of the row. The row carries
 *  `visitor_email_encrypted` + `submission_blob_encrypted` — the latter being the visitor's
 *  ENTIRE submission since D-210 A.8 slice 4b-ii, which makes the rule stricter, not looser:
 *  one spread would now leak every field the visitor typed, not just the next column added. */
const toBookingSummary = (row: FormSubmissionSummary): ReceptionBookingRecordSummary => ({
  kind: 'scheduling_link',
  record_id: row.submission_id,
  endpoint_id: row.endpoint_id,
  received_at: row.submitted_at,
  // D-210 A.8 slice 4b-ii — the merged column carries both flows' vocabularies;
  // this arm re-narrows to the booking's. SAFE because the store refuses to
  // write or read back an outcome that is not this row kind's, and the query
  // below asks for `record_kind: 'booking'`.
  outcome: row.processing_outcome as SchedulingLinkBookingProcessingOutcome,
  // ⚠ Non-null on a booking by construction — the store DERIVES the kind from
  // the slot. Zeroes rather than a throw if it ever were: this is a list the
  // owner is reading, and one odd row must not take the page down.
  slot: {
    start_at: row.slot?.start_at ?? 0,
    end_at: row.slot?.end_at ?? 0,
    duration_minutes: row.slot?.duration_minutes ?? 0,
  },
  // The generic pair. ⚠ Through 4b-i this was an ARRAY because a booking had TWO
  // frozen columns and "normally carried both" — one approve minting a calendar
  // event AND a booking. A.2 ended that (a reservation materializes no calendar
  // event) and 4b-ii deleted the second column, so the array now holds one entry
  // or none. `kind` without `id` is a half-written resolution, not a resolution.
  resolved: row.resolved_target_kind !== null && row.resolved_target_id !== null
    ? [{ kind: row.resolved_target_kind, id: row.resolved_target_id }]
    : [],
});

/** ⛔ Every field NAMED — see `toBookingSummary`. `submission_blob_encrypted` is the whole
 *  visitor payload and `pair_binding` is server-owned locator state; neither belongs on a
 *  list an owner reads. */
const toSubmissionSummary = (row: FormSubmissionSummary): ReceptionSubmissionRecordSummary => ({
  kind: 'intake_form',
  record_id: row.submission_id,
  endpoint_id: row.endpoint_id,
  received_at: row.submitted_at,
  // D-210 A.8 slice 4b — the merged column holds the union of both flows'
  // vocabularies; this arm re-narrows to intake's. The cast is SAFE because the
  // store refuses to write (and refuses to read back) an outcome that is not
  // this row kind's, and this projection only ever sees `record_kind: 'intake'`
  // rows — the caller passes the kind filter to the query.
  outcome: row.processing_outcome as IntakeFormSubmissionProcessingOutcome,
  // Verbatim. An intake reaching here always HAS one — the column is nullable
  // only because a booking has none — but a fabricated `''` would be a sentinel
  // asserting a definition that does not exist. Carry what the row carries.
  form_definition_id: row.form_definition_id,
  // The generic pair, verbatim. `kind` without `id` (or vice versa) is a half-written
  // resolution, not a resolution — emit nothing rather than a pointer to nowhere.
  resolved: row.resolved_target_kind !== null && row.resolved_target_id !== null
    ? [{ kind: row.resolved_target_kind, id: row.resolved_target_id }]
    : [],
});

const requireLimit = (value: unknown, method: string): number => {
  if (value === undefined) return RECEPTION_RECORD_LIST_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw badRequest(method, 'reception_record_invalid', 'limit must be a positive integer');
  }
  return Math.min(value as number, RECEPTION_RECORD_LIST_LIMIT_MAX);
};

/** ⛔ Validated against the SELECTED kind's OWN vocabulary, and this is why `outcome` is a
 *  free string on the wire: the two vocabularies overlap only on `pending` + `processed`
 *  (`auto_confirmed` / `requires_review` / `rejected` vs `failed` / `duplicate` / `spam` /
 *  `rejected_domain`). Their union as a wire type would let a caller ask a booking for
 *  `spam` and get a silently empty list — an answer that reads as "none" rather than "wrong
 *  question". Refuse instead. */
const outcomeFor = <T extends string>(
  outcome: string | undefined,
  allowed: ReadonlyArray<T>,
  kind: ReceptionRecordKind,
  method: string,
): T | undefined => {
  if (outcome === undefined) return undefined;
  if (!(allowed as ReadonlyArray<string>).includes(outcome)) {
    throw badRequest(
      method,
      'reception_record_invalid',
      `outcome '${outcome}' is not one of ${kind}'s outcomes (${allowed.join(', ')})`,
    );
  }
  return outcome as T;
};

export const handleReceptionRecordList = async (
  deps: ReceptionRecordDeps,
  args: ReceptionRecordListInput | undefined,
  caller: { instance_id?: string | null | undefined } | undefined,
): Promise<ReceptionRecordListResult> => {
  const method = 'reception.record.list';
  requireAdmin(caller, method);
  const input: ReceptionRecordListInput = args ?? {};
  if (input.kind !== undefined && !isReceptionRecordKind(input.kind)) {
    throw badRequest(method, 'reception_record_invalid', `unknown record kind '${input.kind}'`);
  }
  if (input.endpoint_id !== undefined
    && (typeof input.endpoint_id !== 'string' || input.endpoint_id.length === 0)) {
    throw badRequest(method, 'reception_record_invalid', 'endpoint_id must be a non-empty string');
  }
  const limit = requireLimit(input.limit, method);

  // Over-fetch by one PER KIND so truncation is observed rather than guessed. ⛔ A silent
  // truncation on a reception list reads as "you have received nothing else", which is the
  // one thing a review surface must never imply.
  const fetch = limit + 1;
  const records: ReceptionRecordSummary[] = [];
  let truncated = false;

  const wantBooking = input.kind === undefined || input.kind === 'scheduling_link';
  const wantSubmission = input.kind === undefined || input.kind === 'intake_form';

  if (wantBooking) {
    const store = deps.getBookingStore?.();
    if (store) {
      const outcome = outcomeFor<SchedulingLinkBookingProcessingOutcome>(
        input.outcome,
        SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES,
        'scheduling_link',
        method,
      );
      const rows = store.listForOwner({
        ...(input.endpoint_id !== undefined ? { endpoint_id: input.endpoint_id } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        // 🔴 See the intake arm — without this the two flows return each other's
        // rows, because the table no longer separates them.
        record_kind: 'booking',
        limit: fetch,
      });
      if (rows.length > limit) truncated = true;
      for (const row of rows.slice(0, limit)) records.push(toBookingSummary(row));
    }
  }

  if (wantSubmission) {
    const store = deps.getSubmissionStore?.();
    if (store) {
      const outcome = outcomeFor<IntakeFormSubmissionProcessingOutcome>(
        input.outcome,
        INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES,
        'intake_form',
        method,
      );
      const rows = store.listForOwner({
        ...(input.endpoint_id !== undefined ? { endpoint_id: input.endpoint_id } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        // 🔴 D-210 A.8 slice 4b — LOAD-BEARING, not a tidy-up. Before the merge
        // the table you read WAS the kind filter. Without this, an unfiltered
        // owner list hands booking rows to `toSubmissionSummary`, which projects
        // them as intakes with a null definition id and a booking's outcome
        // vocabulary — garbage that reads as data.
        record_kind: 'intake',
        limit: fetch,
      });
      if (rows.length > limit) truncated = true;
      for (const row of rows.slice(0, limit)) records.push(toSubmissionSummary(row));
    }
  }

  // Merge the two kinds into one newest-first feed. Each store already ordered its own rows;
  // this only interleaves them.
  //
  // ⚠ When BOTH kinds are asked for, the answer is capped at `limit` PER KIND, not `limit`
  // overall — so a caller asking for 50 may receive up to 100. Bounding the merged feed
  // instead would need a real cross-table cursor; over-answering is the honest failure here,
  // and `truncated` still tells the truth about each kind having more.
  records.sort((a, b) => b.received_at - a.received_at
    || (a.record_id < b.record_id ? 1 : a.record_id > b.record_id ? -1 : 0));

  return { records, truncated };
};

/** The rpc slice. ⛔ Returns `undefined` when the record deps are absent so the method is
 *  simply not registered on a db-less boot — the same posture as the inbox trio. A method
 *  registered against no store would answer `[]`, which on THIS surface reads as "you have
 *  received nothing" rather than "this server cannot tell you". */
export const makeReceptionRecordHandlers = <C extends { instance_id?: string | null }>(
  deps: ReceptionRecordDeps | undefined,
):
  | {
      methods: ReadonlyArray<'reception.record.list'>;
      handlers: {
        'reception.record.list': (
          args: ReceptionRecordListInput | void,
          client: C | undefined,
        ) => Promise<ReceptionRecordListResult>;
      };
    }
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['reception.record.list'],
    handlers: {
      'reception.record.list': async (args, client) =>
        handleReceptionRecordList(
          deps,
          // The registry declares `| void` (a no-arg list is the common call, as with
          // `reception.emergency_disable_all`); the handler takes `| undefined`.
          args === undefined ? undefined : args,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
