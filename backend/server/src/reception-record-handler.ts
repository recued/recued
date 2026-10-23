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
 *  The gated per-record reveal is a DIFFERENT surface — `reception.record.open`, below — and
 *  the list never borrows from it.
 *
 *  ⚠ The redaction is defended by `toBookingSummary` / `toSubmissionSummary` naming every
 *  field they emit — never a spread of the store row. A spread would carry
 *  `visitor_email_encrypted` the day someone adds a column, and the test that checks for it
 *  would still pass because it checks the fields it knows about.
 *
 *  Spec: D-210 §2.2 + Appendix A. */

import {
  RpcError,
  intakeFormChoiceText,
  INTAKE_FORM_SUBMISSION_PROCESSING_OUTCOMES,
  RECEPTION_RECORD_ID_MAX,
  RECEPTION_RECORD_LIST_LIMIT_DEFAULT,
  RECEPTION_RECORD_LIST_LIMIT_MAX,
  SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES,
  isReceptionRecordKind,
  type IntakeFormSubmissionProcessingOutcome,
  type ReceptionBookingRecordSummary,
  type ReceptionRecordAnswer,
  type ReceptionRecordKind,
  type ReceptionRecordListInput,
  type ReceptionRecordListResult,
  type ReceptionRecordOpenInput,
  type ReceptionRecordOpenResult,
  type ReceptionRecordResolution,
  type ReceptionRecordSummary,
  type ReceptionSubmissionRecordSummary,
  type SchedulingLinkBookingProcessingOutcome,
} from '@recued/contracts';

import type { FormSubmissionStore, FormSubmissionSummary } from './storage/reception-form-store.js';

/** ⛔ AN `RpcError`, OR ITS CODE NEVER REACHES THE CLIENT. The dispatcher round-trips
 *  the code and status of an `RpcError` only and sends anything else as `500 internal`.
 *  This class extended plain `Error`, which no live server ever showed, because
 *  `server.ts` dropped this slice's deps until 2026-10-21 (`archive-rpc-wiring.test.ts`). */
export class ReceptionRecordRpcError extends RpcError {
  declare readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
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
  /** `reception.record.open`. All three or none: absent ⇒ the method is not registered, the
   *  same posture as the list — a reveal wired without its key would answer with nothing, and
   *  "this visitor told you nothing" is a claim, not an empty state. */
  readonly openRecord?: ReceptionRecordOpenDeps;
  /** Names each listed record's form, so the owner can match a record to the notice that named
   *  it. Absent or throwing ⇒ the record carries no `form_name`, never a guessed one. */
  readonly formName?: (endpoint_id: string) => string | null;
}

/** A record's sealed blob, opened. Both halves exactly as the visitor's submission wrote them. */
export interface ReceptionSealedRecord {
  /** The separately sealed address on an intake; `fields.email` on a booking. */
  readonly visitor_email: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ReceptionRecordOpenDeps {
  readonly find: (record_id: string) => FormSubmissionSummary | null;
  /** ⚠ THROWS on a row it cannot open (a rotated key, a tampered row). The handler answers that
   *  as "could not be opened", never as a record with no answers. */
  readonly open: (row: FormSubmissionSummary) => Promise<ReceptionSealedRecord>;
  /** The endpoint's name as the owner set it, or null when the endpoint is gone. */
  readonly formName: (endpoint_id: string) => string | null;
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

  return { records: withFormNames(records, deps.formName), truncated };
};

/** One lookup per endpoint, not per record: a busy form lists many records. */
const withFormNames = (
  records: ReceptionRecordSummary[],
  formName: ((endpoint_id: string) => string | null) | undefined,
): ReceptionRecordSummary[] => {
  if (formName === undefined) return records;
  const names = new Map<string, string | null>();
  const nameOf = (endpoint_id: string): string | null => {
    if (!names.has(endpoint_id)) {
      let name: string | null = null;
      try {
        const raw = formName(endpoint_id);
        name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
      } catch {
        name = null;
      }
      names.set(endpoint_id, name);
    }
    return names.get(endpoint_id) ?? null;
  };
  return records.map((record) => {
    const form_name = nameOf(record.endpoint_id);
    return form_name === null ? record : { ...record, form_name };
  });
};

/** A booking's visitor fields — the closed vocabulary, in the order the booking page asks for
 *  them, under the labels the visitor's own receipt uses (`scheduling-link-book.ts`). */
const BOOKING_FIELD_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['topic', 'Topic'],
  ['phone', 'Phone'],
  ['notes', 'Notes'],
];

/** An answer written out the way the visitor's receipt writes it: a list as "a, b", a tick box
 *  as Yes / No, a choice as the form showed it ("Under 10k", its label in the frozen form). A
 *  form stores a tick box as `true`/`false`; an older row may hold the string. */
const answerText = (value: unknown, type: unknown, choices?: { value_labels?: unknown }): string => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => answerText(entry, undefined)).filter((v) => v !== '').join(', ');
  if (type === 'boolean' || typeof value === 'boolean') {
    if (value === true || value === 'true') return 'Yes';
    if (value === false || value === 'false') return 'No';
  }
  if (typeof value === 'string') {
    return (type === 'enum' && choices !== undefined ? intakeFormChoiceText(choices, value) : value).trim();
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
};

/** The form's questions as the visitor saw them: the definition FROZEN onto the record when it
 *  was sent. ⛔ Never the endpoint's current form — a label edited since would relabel the
 *  visitor's old answers, the reinterpretation the snapshot exists to prevent. */
const frozenQuestions = (
  metadata: Readonly<Record<string, unknown>>,
): ReadonlyArray<{ name: string; label: string; type: unknown; value_labels: unknown }> => {
  const snapshot = metadata.definition_snapshot;
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const fields = (snapshot as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  const out: Array<{ name: string; label: string; type: unknown; value_labels: unknown }> = [];
  for (const field of fields) {
    if (field === null || typeof field !== 'object') continue;
    const { name, label, type, value_labels } = field as {
      name?: unknown; label?: unknown; type?: unknown; value_labels?: unknown;
    };
    if (typeof name !== 'string' || name === '') continue;
    out.push({
      name,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : name,
      type,
      value_labels,
    });
  }
  return out;
};

const intakeAnswers = (
  row: FormSubmissionSummary,
  sealed: ReceptionSealedRecord,
): ReceptionRecordAnswer[] => {
  const answers: ReceptionRecordAnswer[] = [];
  if (sealed.visitor_email !== null && sealed.visitor_email.trim() !== '') {
    answers.push({ label: 'Email', value: sealed.visitor_email.trim() });
  }
  const seen = new Set<string>();
  for (const question of frozenQuestions(row.metadata)) {
    seen.add(question.name);
    const value = answerText(sealed.fields[question.name], question.type, question);
    if (value !== '') answers.push({ label: question.label, value });
  }
  // A field the frozen form does not name (a row from before the snapshot) is still the
  // visitor's answer. Shown under its field name rather than hidden.
  for (const [name, raw] of Object.entries(sealed.fields)) {
    if (seen.has(name)) continue;
    const value = answerText(raw, undefined);
    if (value !== '') answers.push({ label: name, value });
  }
  return answers;
};

const bookingAnswers = (sealed: ReceptionSealedRecord): ReceptionRecordAnswer[] => {
  const answers: ReceptionRecordAnswer[] = [];
  for (const [name, label] of BOOKING_FIELD_LABELS) {
    const value = answerText(sealed.fields[name], undefined);
    if (value !== '') answers.push({ label, value });
  }
  return answers;
};

/** D-149 § N.6 "Open submission detail" — `reception.record.open`.
 *
 *  🔑 The gated per-record read. Gated by WHO (a paired admin; the `reception.` prefix keeps it
 *  off MCP, so the owner's AI cannot read a visitor's answers here) and by SHAPE (one record,
 *  opened server-side; the caller never holds a ciphertext or a key). It writes nothing: the
 *  record is write-once evidence (D-210 §4), and reading it changes no outcome. */
export const handleReceptionRecordOpen = async (
  deps: ReceptionRecordOpenDeps,
  args: ReceptionRecordOpenInput | undefined,
  caller: { instance_id?: string | null | undefined } | undefined,
): Promise<ReceptionRecordOpenResult> => {
  const method = 'reception.record.open';
  requireAdmin(caller, method);
  const record_id = (args as { record_id?: unknown } | undefined)?.record_id;
  if (typeof record_id !== 'string' || record_id.length === 0 || record_id.length > RECEPTION_RECORD_ID_MAX) {
    throw badRequest(method, 'reception_record_invalid', `record_id must be a string of 1 to ${RECEPTION_RECORD_ID_MAX} characters`);
  }
  const row = deps.find(record_id);
  if (row === null) {
    throw new ReceptionRecordRpcError('reception_record_not_found', `${method}: no record '${record_id}'`, 404);
  }
  let sealed: ReceptionSealedRecord;
  try {
    sealed = await deps.open(row);
  } catch {
    // ⛔ Never a record with no answers: "they told you nothing" is a claim the owner acts on.
    throw new ReceptionRecordRpcError('reception_record_unreadable', `${method}: record '${record_id}' could not be opened`, 500);
  }
  const booking = row.record_kind === 'booking';
  const answers = booking ? bookingAnswers(sealed) : intakeAnswers(row, sealed);
  const emailField = booking ? answerText(sealed.fields.email, undefined) : (sealed.visitor_email ?? '').trim();
  let form_name: string | null = null;
  try {
    const name = deps.formName(row.endpoint_id);
    form_name = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
  } catch {
    form_name = null;
  }
  const summary: ReceptionRecordSummary = booking ? toBookingSummary(row) : toSubmissionSummary(row);
  return {
    record: form_name === null ? summary : { ...summary, form_name },
    form_name,
    visitor_email: emailField === '' ? null : emailField,
    answers,
  };
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

/** The `reception.record.open` slice — its own, because its deps are its own. ⛔ `undefined`
 *  unless `openRecord` is wired: a reveal registered without its key would have to answer
 *  every record as unreadable, where an unregistered method answers `not_configured`. */
export const makeReceptionRecordOpenHandlers = <C extends { instance_id?: string | null }>(
  deps: ReceptionRecordDeps | undefined,
):
  | {
      methods: ReadonlyArray<'reception.record.open'>;
      handlers: {
        'reception.record.open': (
          args: ReceptionRecordOpenInput,
          client: C | undefined,
        ) => Promise<ReceptionRecordOpenResult>;
      };
    }
  | undefined => {
  const openRecord = deps?.openRecord;
  if (openRecord === undefined) return undefined;
  return {
    methods: ['reception.record.open'],
    handlers: {
      'reception.record.open': async (args, client) =>
        handleReceptionRecordOpen(
          openRecord,
          args,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
