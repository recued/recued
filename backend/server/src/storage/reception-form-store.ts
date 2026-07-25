/** D-149 P6 § A.5.3 — `reception_form_definition` + `reception_form_submission`
 *  store. Mirrors the P5 scheduling-booking pattern: the substrate
 *  visitor-thread persists pre-encrypted ciphertext blobs (built by
 *  the handler via `form-pii.ts`); engine-side reactive triggers (D-115
 *  substrate) consume pending rows asynchronously per Must Hold I-12.
 *
 *  Two stores live in this module so callers don't need to wire two
 *  separate factory imports for the same table family:
 *
 *    - `ReceptionFormDefinitionStore` — admin-side (Settings → Server →
 *      Reception → Intake forms). Read by the visitor GET handler to
 *      load the schema; written by the rpc layer at endpoint-create
 *      (one row per `intake_form` endpoint).
 *
 *    - `ReceptionFormSubmissionStore` — visitor-side. The POST handler
 *      writes a pending row per submission; the engine reactive path
 *      flips to a terminal state once it materialises the target entity.
 *
 *  Encryption discipline:
 *
 *    - `visitor_email_encrypted` — sealed under the form-PII AEAD key
 *      via `form-pii.ts` with AAD `(endpoint_id, submission_id, 'visitor_email')`.
 *    - `submission_blob_encrypted` — sealed under the same AEAD key
 *      with AAD `(endpoint_id, submission_id, 'submission_blob')`.
 *
 *  The store interface accepts pre-encrypted base64 strings; this module
 *  stays crypto-free + parallel to the registry-store's pattern.
 *
 *  Spec: `docs/d-149-spec.md` § A.5.3 + § N.6 (visitor-PII retention). */

import type Database from 'better-sqlite3';
import {
  isReceptionFormPairBinding,
  outcomesForRecordKind,
  type ReceptionFormPairBinding,
  type ReceptionSubmissionRecordKind,
} from '@recued/contracts';

/** ⛔ FROZEN STORAGE FORMAT — the literal keeps its D-200 spelling on purpose
 * (D-207 3d·6d split). It keys the pair-binding stamp inside every persisted
 * submission row's `metadata_blob`; renaming the VALUE would read historical
 * paired rows as UN-stamped, dropping them into the generic review funnel
 * without the paid admission the 3d·6 eviction deliberately preserved. */
const PAIR_BINDING_METADATA_KEY = 'paid_document_direct_checkout_pair';

// ────────────────────────────────────────────────────────────────
// Row shapes (mirror reception-store CREATE TABLE)
// ────────────────────────────────────────────────────────────────

interface FormDefinitionRow {
  form_definition_id: string;
  template_ref: string | null;
  schema_blob: string;
  created_at: number;
  updated_at: number;
  per_field_visibility: string | null;
  metadata_blob: string | null;
}

interface FormSubmissionRow {
  submission_id: string;
  endpoint_id: string;
  /** D-210 A.8 slice 4b — NULL on a booking, which has no form definition. */
  form_definition_id: string | null;
  submitted_at: number;
  source_ip_hash: string | null;
  visitor_email_encrypted: Buffer | null;
  submission_blob_encrypted: Buffer;
  schema_version: number;
  resolved_target_kind: string | null;
  resolved_target_id: string | null;
  processing_outcome: string;
  metadata_blob: string | null;
  /** D-210 A.8 slice 4b — the CLEAR slot. Set on every booking, NULL on every
   *  intake. Together with `form_definition_id` this is the row's kind. */
  slot_start_at: number | null;
  slot_end_at: number | null;
  duration_minutes: number | null;
}

/** D-210 A.8 slice 4b — which flow wrote the row, DERIVED rather than stored.
 *
 *  ⛔ The slot is the discriminator, not `form_definition_id`: an intake row's
 *  definition id is nullable in the schema too (a submission whose endpoint
 *  config carried no definition), so its absence does not imply a booking. A
 *  slot is written by exactly one path and never by the other. */
const recordKindOf = (row: FormSubmissionRow): ReceptionSubmissionRecordKind =>
  row.slot_start_at !== null ? 'booking' : 'intake';

// ────────────────────────────────────────────────────────────────
// Public projections
// ────────────────────────────────────────────────────────────────

/** Admin-side read of a form definition. The schema_blob is the
 *  JSON-serialized `IntakeFormConfig.form_definition` (admin-only
 *  contents — the visitor-facing payload is rebuilt at packet build
 *  time so user-only metadata never crosses the boundary). */
export interface FormDefinitionSummary {
  readonly form_definition_id: string;
  readonly template_ref: string | null;
  /** Closed-shape `IntakeFormConfig.form_definition` payload as
   *  persisted (already JSON-decoded). */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly created_at: number;
  readonly updated_at: number;
  /** `per_field_visibility` map: `Record<fieldName, 'visitor' | 'user_only'>`. */
  readonly per_field_visibility: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface FormDefinitionUpsertInput {
  readonly form_definition_id: string;
  readonly template_ref?: string | null;
  /** JSON-encodable schema payload (closed shape per
   *  `IntakeFormConfig.form_definition`). */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly now: number;
  readonly per_field_visibility?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FormDefinitionStore {
  upsert(input: FormDefinitionUpsertInput): FormDefinitionSummary;
  findById(form_definition_id: string): FormDefinitionSummary | null;
  delete(form_definition_id: string): 'deleted' | 'not_found';
}

/** Public summary projection — read-side. Encrypted columns surface
 *  as base64 strings so callers (e.g., the engine reactive handler)
 *  can decrypt via `openFormSubmissionField`. */
export interface FormSubmissionSummary {
  readonly submission_id: string;
  readonly endpoint_id: string;
  /** D-210 A.8 slice 4b — NULL on a booking. */
  readonly form_definition_id: string | null;
  readonly submitted_at: number;
  readonly source_ip_hash: string | null;
  readonly visitor_email_encrypted: string | null;
  readonly submission_blob_encrypted: string;
  readonly schema_version: number;
  readonly resolved_target_kind: string | null;
  readonly resolved_target_id: string | null;
  /** D-210 A.8 slice 4b — which flow wrote this row. Derived from the slot.
   *
   *  ⚠ Read this BEFORE reading `processing_outcome` as a narrow type: the
   *  column holds the union of both vocabularies and only this says which one
   *  applies. */
  readonly record_kind: ReceptionSubmissionRecordKind;
  /** D-210 A.8 slice 4b — the slot the visitor ASKED for, on a booking; `null`
   *  on an intake.
   *
   *  ⚠ A REQUEST, not a hold. Reservation happens at APPROVAL — the
   *  authoritative agreed slot lives on `data_booking` (D-210 A.2). Never read
   *  this as a confirmed appointment. */
  readonly slot: {
    readonly start_at: number;
    readonly end_at: number;
    readonly duration_minutes: number;
  } | null;
  /** ⚠ The COLUMN's union. Narrow it with `record_kind` — a booking's terminal
   *  states are `processed` / `rejected`, an intake's are `processed` /
   *  `failed` / `spam` / `rejected_domain`. */
  readonly processing_outcome: string;
  /** Exact pair stamped by the consumed render nonce. `null` preserves the
   * generic D-149 intake path. Pair-specific field mappings and visitor email
   * remain outside this server-owned locator. */
  readonly pair_binding: ReceptionFormPairBinding | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface FormSubmissionInsertInput {
  readonly submission_id: string;
  readonly endpoint_id: string;
  /** D-210 A.8 slice 4b — `null` for a booking, which has no form definition.
   *  ⛔ Not a sentinel: `''` / `'0'` are VALUES two live equality checks
   *  (`definitionSnapshotFor`, the promotion re-check) can collide on. */
  readonly form_definition_id: string | null;
  readonly submitted_at: number;
  readonly source_ip_hash: string | null;
  /** Base64 ciphertext built via `sealFormSubmissionField`. Nullable
   *  when the visitor omitted the email (per spec § N.6 column is
   *  nullable). */
  readonly visitor_email_encrypted: string | null;
  /** Base64 ciphertext for the JSON-serialized submission_blob. */
  readonly submission_blob_encrypted: string;
  readonly schema_version: number;
  /** Initial processing outcome — `'pending'` for a clean submission,
   *  `'spam'` when honeypot tripped, `'rejected_domain'` when the
   *  email's domain failed the allowlist.
   *
   *  ⛔ Validated against the ROW's kind, not the union: a booking may not be
   *  inserted `spam`, an intake may not be inserted `rejected`. */
  readonly processing_outcome: string;
  /** D-210 A.8 slice 4b — the booking's CLEAR slot. Present ⇒ the row is a
   *  booking; absent ⇒ an intake. */
  readonly slot?: {
    readonly start_at: number;
    readonly end_at: number;
    readonly duration_minutes: number;
  };
  /** Server-owned binding copied from the consumed render nonce. Callers may
   * not inject the reserved metadata key directly. */
  readonly pair_binding?: ReceptionFormPairBinding | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** D-210 A.8 slice 4b — result of the atomic per-day-cap guard. */
export type FormSubmissionInsertResult =
  | { readonly row: FormSubmissionSummary }
  | { readonly conflict: 'day_cap' };

export interface FormSubmissionStore {
  insert(input: FormSubmissionInsertInput): FormSubmissionSummary;

  /** D-210 A.8 slice 4b — atomically re-check the per-day cap and insert, in ONE
   *  synchronous transaction. Moved here from the booking store that slice 4c
   *  deleted.
   *
   *  The handler's `countWithinWindow` pre-check runs BEFORE the async PII seal,
   *  so two concurrent visitors can both pass it and then both insert (the
   *  `await` yields the event loop). Re-checking inside the insert transaction
   *  closes that TOCTOU: better-sqlite3 is synchronous, so check+insert cannot
   *  interleave. `max_bookings_per_day === 0` ⇒ uncapped.
   *
   *  ⚠ Guards VOLUME, not capacity — it does NOT refuse a booking overlapping an
   *  existing one. Concurrent bookings at one time are legitimate (a 100-table
   *  restaurant holds 100), and how many is a judgment only the owner can make,
   *  at the D-157 gate.
   *
   *  🔑 That refusal DID exist once, as the booking store's `hasOverlappingBooking`,
   *  and it read the row as a live slot HOLD. It hard-coded capacity to 1 per
   *  endpoint (a 100-table restaurant would have needed 100 public URLs) and
   *  produced two live defects — a rejected booking burned its slot forever, a
   *  moved booking freed nothing and claimed nothing (both halves of D-173 I-5).
   *  Recorded here because slice 4c deleted the header that used to carry it: an
   *  overlap guard is the obvious thing to re-add, and this is why not. */
  insertIfAvailable(input: FormSubmissionInsertInput & {
    readonly max_bookings_per_day: number;
    readonly day_window_start_at: number;
    readonly now: number;
  }): FormSubmissionInsertResult;

  findById(submission_id: string): FormSubmissionSummary | null;
  /** Stable pending page. `after` is an exclusive `(submitted_at,
   * submission_id)` cursor so a deferred oldest row cannot monopolize every
   * bounded drain tick. Omitting it preserves the public oldest-first list. */
  listPendingForEndpoint(
    endpoint_id: string,
    limit?: number,
    after?: { readonly submitted_at: number; readonly submission_id: string } | null,
  ): ReadonlyArray<FormSubmissionSummary>;
  /** D-210 A.8 slice 4b — the scheduling drain's pending page.
   *
   *  ⚠ Deliberately a SEPARATE method rather than a `record_kind` parameter on
   *  the one above. The two drains want different orders: intake pages by a
   *  `(submitted_at, submission_id)` cursor so a deferred row cannot monopolize
   *  a bounded tick; scheduling takes a flat oldest-first page so a backlog
   *  drains in arrival order. Merging them behind a flag would give one drain
   *  the other's contract. */
  listPendingBookingsForEndpoint(
    endpoint_id: string,
    limit?: number,
  ): ReadonlyArray<FormSubmissionSummary>;
  /** D-210 step 2a — the OWNER's read: every outcome, newest first.
   *
   *  ⚠ Deliberately NOT `listPendingForEndpoint` widened. That one is the drain's: `pending`
   *  only, oldest-first, with a `(submitted_at, submission_id)` cursor so a deferred row
   *  cannot monopolize a bounded tick. This answers a different question — "what has this
   *  endpoint received?" — newest-first, which is the only order a review surface can use. */
  listForOwner(input: {
    readonly endpoint_id?: string | undefined;
    readonly outcome?: string | undefined;
    /** D-210 A.8 slice 4b — REQUIRED discipline in practice, though optional in
     *  the type for the "everything this endpoint received" read.
     *
     *  🔴 Before the merge, the table you chose WAS the kind filter. An owner
     *  list with no `endpoint_id` now spans both flows, so a caller that wants
     *  one kind must say so — otherwise an intake list projects booking rows
     *  through the intake summary and produces garbage. */
    readonly record_kind?: ReceptionSubmissionRecordKind | undefined;
    readonly limit: number;
  }): ReadonlyArray<FormSubmissionSummary>;
  /** Per-endpoint rolling window count for the per-day cap.
   *
   *  ⚠ Endpoint-scoped, NOT kind-scoped — a registry endpoint has exactly one
   *  kind, so its rows are all one flow and a kind predicate would be dead
   *  weight. */
  countWithinWindow(input: {
    endpoint_id: string;
    window_start_at: number;
    now: number;
  }): number;
  /** D-210 A.8 slice 4b — PARTIAL, and that is a fix, not a refinement.
   *
   *  🔴 This used to be a FULL SET: every caller passing only `outcome` nulled
   *  BOTH resolved columns. The booking mint's write-back happened to run last,
   *  so nothing broke — but nothing ENFORCED that ordering either, and a second
   *  `markProcessed` after the mint silently wiped the resolved pointer, after
   *  which the manage page refused the reschedule with no error anywhere.
   *
   *  Now: omit `resolved` to leave the columns untouched; pass `null` to clear
   *  them explicitly. The two are different intentions and no longer spell the
   *  same. */
  markProcessed(input: {
    submission_id: string;
    /** ⛔ A TERMINAL state of THIS ROW'S kind, checked at runtime.
     *
     *  This was `Exclude<IntakeFormSubmissionProcessingOutcome, 'pending'>` — a
     *  type that carried two guarantees the merged column cannot express, since
     *  it now holds both flows' vocabularies. Both are re-asserted at runtime
     *  instead of quietly lost:
     *
     *    - the outcome belongs to the row's OWN kind (flipping an intake to
     *      `rejected` writes a row that then throws on every read — and both
     *      list methods `.map()`, so one such row takes down the owner's whole
     *      page);
     *    - it is not `pending` (that would put an already-processed row back on
     *      the drain, re-dispatching it). */
    outcome: string;
    resolved?: { readonly kind: string; readonly id: string } | null;
  }): 'updated' | 'not_found';
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseJsonObject = (raw: string | null): Readonly<Record<string, unknown>> => {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Submission metadata carries the server-owned direct-checkout pair stamp.
 * Unlike legacy definition metadata, corrupt bytes cannot safely downgrade to
 * an empty object because that would reinterpret a paired submission as a
 * generic one. */
const parseSubmissionMetadata = (
  raw: string | null,
  submissionId: string,
): Readonly<Record<string, unknown>> => {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `ReceptionFormSubmissionStore: submission '${submissionId}' has invalid metadata`,
    );
  }
};

const parseStringMap = (raw: string | null): Readonly<Record<string, string>> => {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

const blobToBase64 = (raw: Buffer | null): string | null => {
  if (raw === null) return null;
  return raw.toString('base64');
};

const base64ToBlob = (raw: string | null): Buffer | null => {
  if (raw === null) return null;
  return Buffer.from(raw, 'base64');
};

const definitionRowToSummary = (row: FormDefinitionRow): FormDefinitionSummary => ({
  form_definition_id: row.form_definition_id,
  template_ref: row.template_ref,
  schema: parseJsonObject(row.schema_blob),
  created_at: row.created_at,
  updated_at: row.updated_at,
  per_field_visibility: parseStringMap(row.per_field_visibility),
  metadata: parseJsonObject(row.metadata_blob),
});

const submissionRowToSummary = (row: FormSubmissionRow): FormSubmissionSummary => {
  const outcomeRaw = row.processing_outcome;
  const record_kind = recordKindOf(row);
  // D-200 Slice 6g.12 audit fold — unknown durable outcomes must not be
  // reinterpreted as `pending`. A hand-edited/future value is not eligibility
  // evidence for a paid claim (and is not safe generic-drain input either).
  //
  // D-210 A.8 slice 4b — validated against THIS ROW'S kind, not the column's
  // union. The merged column admits both vocabularies because it physically
  // must; a booking carrying `spam` is still a corrupt row and says so here.
  // That is strictly stronger than the sibling tables, where the separation
  // was structural luck rather than a rule anything checked.
  if (!outcomesForRecordKind(record_kind).includes(outcomeRaw)) {
    throw new Error(
      `ReceptionFormSubmissionStore: submission '${row.submission_id}' has invalid processing outcome `
        + `'${outcomeRaw}' for a ${record_kind} row`,
    );
  }
  const outcome = outcomeRaw;
  const storedMetadata = parseSubmissionMetadata(row.metadata_blob, row.submission_id);
  const pairValue = storedMetadata[PAIR_BINDING_METADATA_KEY];
  if (pairValue !== undefined
    && (!isReceptionFormPairBinding(pairValue)
      || pairValue.form_definition_id !== row.form_definition_id)) {
    throw new Error(
      `ReceptionFormSubmissionStore: submission '${row.submission_id}' has an invalid or mismatched direct-checkout pair binding`,
    );
  }
  const metadata = { ...storedMetadata };
  delete metadata[PAIR_BINDING_METADATA_KEY];
  return {
    submission_id: row.submission_id,
    endpoint_id: row.endpoint_id,
    form_definition_id: row.form_definition_id,
    submitted_at: row.submitted_at,
    source_ip_hash: row.source_ip_hash,
    visitor_email_encrypted: blobToBase64(row.visitor_email_encrypted),
    submission_blob_encrypted: row.submission_blob_encrypted.toString('base64'),
    schema_version: row.schema_version,
    resolved_target_kind: row.resolved_target_kind,
    resolved_target_id: row.resolved_target_id,
    record_kind,
    // Every slot column or none — `recordKindOf` keys on `slot_start_at`, so a
    // row with a start and no end is a half-written booking, not an intake.
    // Refuse it rather than hand back a slot with holes in it.
    slot: record_kind === 'booking'
      ? (() => {
          if (row.slot_end_at === null || row.duration_minutes === null) {
            throw new Error(
              `ReceptionFormSubmissionStore: submission '${row.submission_id}' has a partial slot`,
            );
          }
          return {
            start_at: row.slot_start_at as number,
            end_at: row.slot_end_at,
            duration_minutes: row.duration_minutes,
          };
        })()
      : null,
    processing_outcome: outcome,
    pair_binding: pairValue === undefined ? null : { ...pairValue },
    metadata,
  };
};

// ────────────────────────────────────────────────────────────────
// FormDefinitionStore impl
// ────────────────────────────────────────────────────────────────

export const createReceptionFormDefinitionStore = (
  db: Database.Database,
): FormDefinitionStore => {
  const upsertStmt = db.prepare(`
    INSERT INTO reception_form_definition (
      form_definition_id, template_ref, schema_blob,
      created_at, updated_at, per_field_visibility, metadata_blob
    ) VALUES (
      @form_definition_id, @template_ref, @schema_blob,
      @created_at, @updated_at, @per_field_visibility, @metadata_blob
    )
    ON CONFLICT(form_definition_id) DO UPDATE SET
      template_ref = excluded.template_ref,
      schema_blob = excluded.schema_blob,
      updated_at = excluded.updated_at,
      per_field_visibility = excluded.per_field_visibility,
      metadata_blob = excluded.metadata_blob
  `);

  const findByIdStmt = db.prepare(
    `SELECT * FROM reception_form_definition WHERE form_definition_id = @form_definition_id`,
  );

  const deleteStmt = db.prepare(
    `DELETE FROM reception_form_definition WHERE form_definition_id = @form_definition_id`,
  );

  return {
    upsert(input) {
      // Preserve the original created_at on update by reading the
      // existing row first; ON CONFLICT only updates the named columns
      // so created_at stays intact.
      const existing = findByIdStmt.get({ form_definition_id: input.form_definition_id }) as
        | FormDefinitionRow
        | undefined;
      upsertStmt.run({
        form_definition_id: input.form_definition_id,
        template_ref: input.template_ref ?? null,
        schema_blob: JSON.stringify(input.schema),
        created_at: existing ? existing.created_at : input.now,
        updated_at: input.now,
        per_field_visibility: input.per_field_visibility
          ? JSON.stringify(input.per_field_visibility)
          : null,
        metadata_blob: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      const row = findByIdStmt.get({ form_definition_id: input.form_definition_id }) as
        | FormDefinitionRow
        | undefined;
      if (!row) {
        throw new Error(
          'ReceptionFormDefinitionStore.upsert: row missing after insert',
        );
      }
      return definitionRowToSummary(row);
    },

    findById(form_definition_id) {
      const row = findByIdStmt.get({ form_definition_id }) as FormDefinitionRow | undefined;
      return row ? definitionRowToSummary(row) : null;
    },

    delete(form_definition_id) {
      const result = deleteStmt.run({ form_definition_id });
      return result.changes > 0 ? 'deleted' : 'not_found';
    },
  };
};

// ────────────────────────────────────────────────────────────────
// FormSubmissionStore impl
// ────────────────────────────────────────────────────────────────

export const createReceptionFormSubmissionStore = (
  db: Database.Database,
): FormSubmissionStore => {
  const insertStmt = db.prepare(`
    INSERT INTO reception_form_submission (
      submission_id, endpoint_id, form_definition_id, submitted_at,
      source_ip_hash, visitor_email_encrypted, submission_blob_encrypted,
      schema_version, resolved_target_kind, resolved_target_id,
      processing_outcome, metadata_blob,
      slot_start_at, slot_end_at, duration_minutes
    ) VALUES (
      @submission_id, @endpoint_id, @form_definition_id, @submitted_at,
      @source_ip_hash, @visitor_email_encrypted, @submission_blob_encrypted,
      @schema_version, NULL, NULL,
      @processing_outcome, @metadata_blob,
      @slot_start_at, @slot_end_at, @duration_minutes
    )
  `);

  const findByIdStmt = db.prepare(
    `SELECT * FROM reception_form_submission WHERE submission_id = @submission_id`,
  );

  // D-210 step 2a — the owner's read. Newest first; both filters optional. Total order
  // (`submitted_at DESC, submission_id DESC`) so the page boundary is deterministic when two
  // submissions share a millisecond.
  //
  // D-210 A.8 slice 4b — the kind predicate. Bound as a nullable flag rather
  // than concatenated, keeping one prepared shape across all filter
  // combinations: 1 = bookings only, 0 = intakes only, NULL = both.
  const listForOwnerStmt = db.prepare(`
    SELECT * FROM reception_form_submission
     WHERE (@endpoint_id IS NULL OR endpoint_id = @endpoint_id)
       AND (@outcome IS NULL OR processing_outcome = @outcome)
       AND (
         @want_booking IS NULL
         OR (@want_booking = 1 AND slot_start_at IS NOT NULL)
         OR (@want_booking = 0 AND slot_start_at IS NULL)
       )
     ORDER BY submitted_at DESC, submission_id DESC
     LIMIT @limit
  `);

  // Intake's pending page. `slot_start_at IS NULL` keeps bookings out: before
  // the merge the table did that, and an endpoint is single-kind so this is
  // belt-and-braces — but a drain silently handed the other flow's rows is not
  // a failure worth leaving to registry hygiene.
  const listPendingStmt = db.prepare(`
    SELECT * FROM reception_form_submission
     WHERE endpoint_id = @endpoint_id
       AND processing_outcome = 'pending'
       AND slot_start_at IS NULL
       AND (
         @after_submitted_at IS NULL
         OR submitted_at > @after_submitted_at
         OR (
           submitted_at = @after_submitted_at
           AND submission_id > @after_submission_id
         )
       )
     ORDER BY submitted_at ASC, submission_id ASC
     LIMIT @limit
  `);

  // D-210 A.8 slice 4b — the scheduling drain's pending page. Flat oldest-first
  // (a backlog drains in arrival order); the total order on submission_id keeps
  // the page boundary deterministic when two bookings share a millisecond.
  const listPendingBookingsStmt = db.prepare(`
    SELECT * FROM reception_form_submission
     WHERE endpoint_id = @endpoint_id
       AND processing_outcome = 'pending'
       AND slot_start_at IS NOT NULL
     ORDER BY submitted_at ASC, submission_id ASC
     LIMIT @limit
  `);

  // 🔴 NO upper bound, and that is deliberate — do NOT re-add one.
  //
  // The booking store dropped its own upper bound because inside the atomic
  // insertIfAvailable re-check it WRONGLY excluded a concurrently-committed row
  // whose stamp is later than this request's captured now, letting the per-day
  // cap be exceeded. submitted_at is the insert time and never future, so the
  // bound was redundant on the read path and harmful on the write path.
  // Reintroducing it here would restore a fixed bug.
  const countWindowStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM reception_form_submission
     WHERE endpoint_id = @endpoint_id
       AND submitted_at >= @window_start_at
  `);

  // D-210 A.8 slice 4b — PARTIAL. @set_resolved = 0 leaves both columns as they
  // are; = 1 writes them (to values, or to NULL for an explicit clear). See the
  // interface note: the full-set version silently wiped the booking mint's
  // write-back whenever a second markProcessed followed it.
  const markProcessedStmt = db.prepare(`
    UPDATE reception_form_submission
       SET processing_outcome = @outcome,
           resolved_target_kind =
             CASE WHEN @set_resolved = 1 THEN @resolved_target_kind
                  ELSE resolved_target_kind END,
           resolved_target_id =
             CASE WHEN @set_resolved = 1 THEN @resolved_target_id
                  ELSE resolved_target_id END
     WHERE submission_id = @submission_id
  `);

  const runInsert = (input: FormSubmissionInsertInput): FormSubmissionSummary => {
      const blob = base64ToBlob(input.submission_blob_encrypted);
      if (blob === null) {
        throw new Error(
          'ReceptionFormSubmissionStore.insert: submission_blob_encrypted is required',
        );
      }
      // D-210 A.8 slice 4b — refuse the outcome the OTHER flow owns, at the
      // write. Catching it on read only would mean a row that inserts fine and
      // then throws every time anything lists it.
      const insertKind: ReceptionSubmissionRecordKind =
        input.slot !== undefined ? 'booking' : 'intake';
      if (!outcomesForRecordKind(insertKind).includes(input.processing_outcome)) {
        throw new Error(
          `ReceptionFormSubmissionStore.insert: '${input.processing_outcome}' is not a `
            + `${insertKind} outcome`,
        );
      }
      if (input.metadata !== undefined
        && Object.prototype.hasOwnProperty.call(
          input.metadata,
          PAIR_BINDING_METADATA_KEY,
        )) {
        throw new Error(
          `ReceptionFormSubmissionStore.insert: '${PAIR_BINDING_METADATA_KEY}' is server-owned`,
        );
      }
      const pairBinding = input.pair_binding ?? null;
      if (pairBinding !== null
        && !isReceptionFormPairBinding(pairBinding)) {
        throw new Error(
          'ReceptionFormSubmissionStore.insert: pair_binding is invalid',
        );
      }
      if (pairBinding !== null
        && pairBinding.form_definition_id !== input.form_definition_id) {
        throw new Error(
          'ReceptionFormSubmissionStore.insert: pair_binding does not match form_definition_id',
        );
      }
      const metadata = {
        ...(input.metadata ?? {}),
        ...(pairBinding === null
          ? {}
          : { [PAIR_BINDING_METADATA_KEY]: pairBinding }),
      };
      insertStmt.run({
        submission_id: input.submission_id,
        endpoint_id: input.endpoint_id,
        form_definition_id: input.form_definition_id,
        submitted_at: input.submitted_at,
        source_ip_hash: input.source_ip_hash,
        visitor_email_encrypted: base64ToBlob(input.visitor_email_encrypted),
        submission_blob_encrypted: blob,
        schema_version: input.schema_version,
        processing_outcome: input.processing_outcome,
        metadata_blob: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        slot_start_at: input.slot?.start_at ?? null,
        slot_end_at: input.slot?.end_at ?? null,
        duration_minutes: input.slot?.duration_minutes ?? null,
      });
      const row = findByIdStmt.get({ submission_id: input.submission_id }) as
        | FormSubmissionRow
        | undefined;
      if (!row) {
        throw new Error(
          'ReceptionFormSubmissionStore.insert: row missing after insert',
        );
      }
      return submissionRowToSummary(row);
  };

  // db.transaction wraps the body in BEGIN/COMMIT and runs it synchronously —
  // no event-loop yield, so a concurrent request cannot interleave between the
  // re-check and the insert.
  const insertIfAvailableTxn = db.transaction(
    (
      input: FormSubmissionInsertInput & {
        max_bookings_per_day: number;
        day_window_start_at: number;
        now: number;
      },
    ): FormSubmissionInsertResult => {
      if (input.max_bookings_per_day > 0) {
        const { n } = countWindowStmt.get({
          endpoint_id: input.endpoint_id,
          window_start_at: input.day_window_start_at,
        }) as { n: number };
        if (n >= input.max_bookings_per_day) return { conflict: 'day_cap' };
      }
      return { row: runInsert(input) };
    },
  );

  return {
    insert(input) {
      return runInsert(input);
    },

    insertIfAvailable(input) {
      return insertIfAvailableTxn(input);
    },

    findById(submission_id) {
      const row = findByIdStmt.get({ submission_id }) as FormSubmissionRow | undefined;
      return row ? submissionRowToSummary(row) : null;
    },

    listPendingForEndpoint(endpoint_id, limit = 100, after = null) {
      const rows = listPendingStmt.all({
        endpoint_id,
        limit,
        after_submitted_at: after?.submitted_at ?? null,
        after_submission_id: after?.submission_id ?? null,
      }) as FormSubmissionRow[];
      return rows.map(submissionRowToSummary);
    },

    listPendingBookingsForEndpoint(endpoint_id, limit = 100) {
      const rows = listPendingBookingsStmt.all({ endpoint_id, limit }) as FormSubmissionRow[];
      return rows.map(submissionRowToSummary);
    },

    listForOwner(input) {
      // Every filter bound, never interpolated — the outcome reaches here off the wire.
      const rows = listForOwnerStmt.all({
        endpoint_id: input.endpoint_id ?? null,
        outcome: input.outcome ?? null,
        want_booking: input.record_kind === undefined
          ? null
          : input.record_kind === 'booking' ? 1 : 0,
        limit: input.limit,
      }) as FormSubmissionRow[];
      return rows.map(submissionRowToSummary);
    },

    countWithinWindow(input) {
      // `now` stays in the signature (callers derive `window_start_at` from it)
      // but the query no longer reads it — see countWindowStmt.
      const row = countWindowStmt.get({
        endpoint_id: input.endpoint_id,
        window_start_at: input.window_start_at,
      }) as { n: number };
      return row.n;
    },

    markProcessed(input) {
      // Re-assert what the old `Exclude<…, 'pending'>` type used to guarantee.
      // The row must exist and its kind decides the vocabulary, so this reads
      // before it writes.
      const existing = findByIdStmt.get({ submission_id: input.submission_id }) as
        | FormSubmissionRow
        | undefined;
      if (!existing) return 'not_found';
      const kind = recordKindOf(existing);
      if (input.outcome === 'pending') {
        throw new Error(
          `ReceptionFormSubmissionStore.markProcessed: '${input.submission_id}' cannot be flipped `
            + 'back to pending — that would re-dispatch an already-processed row',
        );
      }
      if (!outcomesForRecordKind(kind).includes(input.outcome)) {
        throw new Error(
          `ReceptionFormSubmissionStore.markProcessed: '${input.outcome}' is not a ${kind} outcome`,
        );
      }
      // ⛔ THREE cases, not two. `Object.hasOwn` alone separates omitted from
      // explicit-null — but this repo does not set `exactOptionalPropertyTypes`,
      // so `resolved: someOptional` where the value is `undefined` typechecks
      // against `resolved?: … | null`, and `hasOwn` would call it a CLEAR.
      // Forwarding a `| undefined` is the natural mistake in a codebase whose
      // idiom for optionals is the conditional spread, and the wipe it produces
      // is exactly the silent failure this partial write exists to close.
      const setResolved = Object.hasOwn(input, 'resolved') && input.resolved !== undefined;
      const result = markProcessedStmt.run({
        submission_id: input.submission_id,
        outcome: input.outcome,
        set_resolved: setResolved ? 1 : 0,
        resolved_target_kind: input.resolved?.kind ?? null,
        resolved_target_id: input.resolved?.id ?? null,
      });
      return result.changes > 0 ? 'updated' : 'not_found';
    },
  };
};
