/** Promote an owner-approved intake submission into canonical `form_response`
 * (the ONLY place that row is written), and verify the held provenance of
 * every submission that reaches approval.
 *
 * ⚠ THE WRITE IS HERE, AT APPROVAL, FOR EVERY INTAKE. D-210 WS2 had moved it
 * for ordinary intakes to SUBMIT (the visitor POST, `handlers/intake-form.ts`),
 * and this header said so until 2026-09-27. Audit finding 3a moved it back
 * (`2ec931cc7`, 2026-07-21): a row written at submit existed, readable by the
 * owner's AI, before the owner had seen the submission — see the note above
 * `isFormResponseDestination` below. An unpaired submission is written only
 * when its destination is a form response; one routed to a task, contact,
 * calendar event or note has its provenance verified (a mismatch must not
 * resume the materialize op) and writes no row.
 *
 * A D-200 direct-checkout pair is written whatever its destination. Its
 * `form_response` is the paid deliverable, so it must not exist
 * before payment is provider-verified — the exact immutable v4 row/pair must
 * still be verified paid, and the durable approval answer cannot predate that
 * verification. The check runs both before PII access and after its async
 * decrypt, immediately before canonical insertion. Each row is therefore
 * written exactly once, in exactly one place; there is no dual-write to
 * reconcile.
 *
 * The promotion runs immediately before the held preflight operation resumes.
 * That is the one approval funnel shared by Reception Inbox, the global
 * approvals surface, batch approval, and answered-ask boot recovery. The
 * canonical response therefore lands before any optional downstream workflow
 * effect, and its idempotent submission id makes retrying the resume safe.
 *
 * The held projection payload is used only to recover substrate-owned
 * provenance. Visitor values and email are always decrypted from the original
 * `reception_form_submission` row; the reduced/editable projection is not a
 * substitute for the submitted form. */

import type { Checkpoint, FormResponse } from '@recued/contracts';
import type { PreflightAskContext } from '@recued/gateway';
import type { AuditLogStore } from '@recued/storage';

import type { FormResponseStore } from '../../storage/form-response-store.js';
import type {
  FormSubmissionStore,
  FormSubmissionSummary,
} from '../../storage/reception-form-store.js';
import type { AdmitPaidDocumentDirectCheckoutReview } from '../../paid-document-direct-checkout-review-admission.js';
import { openFormSubmissionField } from './form-pii.js';
import {
  FormResponseWorkingContentValidationError,
  validateFormResponseWorkingContent,
} from '../../form-response-working-content.js';

/** ⛔ THE TRIGGER'S EVENT KIND IS NOT A FLOW IDENTITY — do not reintroduce it
 *  as the discriminator here (D-210 A.8, 2026-07-19).
 *
 *  This used to key on `source.event_kind === 'composition.reception_form_
 *  submission'`, and that worked only by accident: the decomposer mints
 *  `composition.<entity>` from the compiled recipe's trigger entity, and each
 *  reception flow happened to own its own table, so the TABLE NAME doubled as
 *  a flow discriminator. `event_kind` was carrying two jobs — which trigger
 *  fired (routing) and which flow this approval belongs to (identity).
 *
 *  A.8 slice 4 merges `reception_booking_request` into
 *  `reception_form_submission`, which destroys the coincidence: a SCHEDULING
 *  approval would then satisfy every conjunct below, reach the intake path
 *  with no substrate provenance, and throw. This hook decorates the SHARED
 *  preflight resumer, so that would have broken inbox approve, the generic
 *  ask queue, batch approve and boot recovery together — and it fails OPEN
 *  (the dispatcher's scope regex `/^composition\.reception_/` admits both
 *  names), so nothing would have caught it on the way in.
 *
 *  The discriminator is now the flow's OWN data — see `carriesIntakeProvenance`
 *  below. ⇒ [[feedback_one_word_two_substrates]]
 *
 *  What survives is the SCOPE half: the fire must still come from a compiled
 *  reception-workflow trigger, which is a fact about the ORIGIN and stays true
 *  across the merge. Dropping that too would admit any server-internal
 *  reactive fire (a `mail.created` watcher, say) that happened to carry intake
 *  provenance — a real fail-closed posture, and one of this module's tests
 *  pins exactly that case. Identity moved; authority did not weaken. */
const RECEPTION_TRIGGER_EVENT_PREFIX = 'composition.reception_';

/** ⚠ Sibling copy: `wire-reception-workflow-dispatch.ts` scopes recipe
 *  RESOLUTION with the same prefix (`RECEPTION_TRIGGER_EVENT_RE`). Two
 *  independent scope filters over one naming rule — if the decomposer's
 *  prefix ever changes, BOTH stop matching and both fail closed (a missed
 *  classification throws here via the tripwire below), so drift is loud
 *  rather than silent. Kept local rather than shared because the direction
 *  `ports/ → composition/` is the wrong way round. */
const COMPILED_INTAKE_RECIPE_ID =
  /^(?:recued-core\/)?reception-intake-review-then-approve-/;

export type FormResponsePromotionErrorCode =
  | 'not_configured'
  | 'source_missing'
  | 'source_invalid';

export class FormResponsePromotionError extends Error {
  readonly code: FormResponsePromotionErrorCode;

  constructor(code: FormResponsePromotionErrorCode, message: string) {
    super(message);
    this.name = 'FormResponsePromotionError';
    this.code = code;
  }
}

export interface FormResponsePromotionDeps {
  /** The paused-run anchor is the authority that this is the compiled intake
   * workflow, rather than an arbitrary recipe carrying look-alike metadata. */
  readonly auditLog: Pick<AuditLogStore, 'get'>;
  readonly submissionStore?: Pick<FormSubmissionStore, 'findById'>;
  readonly formResponseStore?: Pick<
    FormResponseStore,
    'accept' | 'acceptWithWorkingContent'
  >;
  /** Best-effort first-create event fan-out. It runs immediately after the
   * canonical insert, before optional downstream resume; idempotent retries
   * never call it again. Callers may invalidate owner Data surfaces and signal
   * the warehouse trigger bus, whose delivery contract is at-most-once. */
  readonly onCreated?: (response: FormResponse) => void;
  /** Live key getter. A locked vault throws and leaves the checkpoint for the
   * answered-ask recovery sweep; no downstream operation resumes. */
  readonly getFormSubmissionPiiKey?: () => Uint8Array;
  /** D-200 direct-checkout pairs may promote only while their exact immutable
   * v4 transaction is still provider-verified paid, and only when the durable
   * approval answer was recorded at or after that verification. Generic D-199
   * submissions do not use this seam. */
  readonly admitPaidDirectCheckoutReview?: AdmitPaidDocumentDirectCheckoutReview;
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const invalid = (message: string): FormResponsePromotionError =>
  new FormResponsePromotionError('source_invalid', message);

const hasOwn = (object: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** Read the original materialize args. `arg_overrides` are deliberately not
 * consulted: provenance is substrate-authored at dispatch and cannot be
 * replaced by an approval edit. */
const readProjectionArgs = (checkpoint: Checkpoint): JsonObject | null => {
  const gatedStepId = checkpoint.gated_step_id;
  if (typeof gatedStepId !== 'string' || gatedStepId.length === 0) return null;
  const state = asObject(checkpoint.step_state?.[gatedStepId]);
  if (state === null) return null;
  return asObject(state.input) ?? asObject(state.args) ?? state;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`form response promotion: ${label} is missing`);
  }
  return value;
};

const readSubmissionPayload = (raw: string): {
  fields: JsonObject;
  visitor_email?: string;
} => {
  let parsed: JsonObject;
  try {
    const candidate = asObject(JSON.parse(raw) as unknown);
    if (candidate === null) throw new Error('payload is not an object');
    parsed = candidate;
  } catch {
    throw invalid('form response promotion: submission payload is not valid JSON object data');
  }
  const fields = asObject(parsed.fields);
  if (fields === null) {
    throw invalid('form response promotion: submission payload fields are missing or invalid');
  }
  if (
    parsed.visitor_email !== undefined
    && (typeof parsed.visitor_email !== 'string' || parsed.visitor_email.length === 0)
  ) {
    throw invalid('form response promotion: visitor_email is invalid');
  }
  return {
    fields,
    ...(typeof parsed.visitor_email === 'string'
      ? { visitor_email: parsed.visitor_email }
      : {}),
  };
};

const definitionSnapshotFor = (row: FormSubmissionSummary): JsonObject => {
  const snapshot = asObject(row.metadata.definition_snapshot);
  if (snapshot === null) {
    throw invalid(
      `form response promotion: submission '${row.submission_id}' has no frozen definition snapshot`,
    );
  }
  if (snapshot.form_definition_id !== row.form_definition_id) {
    throw invalid(
      `form response promotion: submission '${row.submission_id}' definition snapshot does not match its form_definition_id`,
    );
  }
  return snapshot;
};

const responseMetadataFor = (row: FormSubmissionSummary): JsonObject => {
  const metadata: JsonObject = {};
  for (const [key, value] of Object.entries(row.metadata)) {
    if (key !== 'definition_snapshot') metadata[key] = value;
  }
  // Server-owned schema provenance wins over any legacy metadata key.
  metadata.schema_version = row.schema_version;
  return metadata;
};

/** Build the pre-resume hook. Non-intake approvals are a strict no-op. An
 * intake approval fails closed when its source, key, or canonical store is
 * unavailable; the notification answer remains durable and boot recovery
 * retries this hook before attempting the downstream resume again. */
export const createFormResponsePromotion = (
  deps: FormResponsePromotionDeps,
): ((checkpoint: Checkpoint, context: PreflightAskContext) => Promise<void>) => {
  return async (checkpoint, context): Promise<void> => {
    const args = readProjectionArgs(checkpoint);
    const provenance = asObject(args?.metadata);
    // `reception_form_submission_id` is the intake-specific, substrate-owned
    // marker. A generic `form_definition_id` may legitimately appear in an
    // unrelated workflow and must not make its approval fail.
    const carriesIntakeProvenance =
      provenance?.reception_form_submission_id !== undefined;
    const looksLikeCompiledIntake =
      typeof checkpoint.recipe_id === 'string'
      && COMPILED_INTAKE_RECIPE_ID.test(checkpoint.recipe_id);
    const anchor = await deps.auditLog.get(checkpoint.run_id);
    const source = anchor?.execution_source;
    // The ORIGIN conjuncts are unchanged and still do the authorization work:
    // a server-internal reactive fire whose anchor, checkpoint and
    // `source_recipe` all name the same recipe. What changed is the last one —
    // the flow is identified by the flow's OWN substrate-owned data instead of
    // by the trigger's table name (see the note on COMPILED_INTAKE_RECIPE_ID).
    //
    // 🔑 Classification and requirement are now the SAME fact: this is an
    // intake approval BECAUSE it carries intake provenance. A booking approval
    // builds no `metadata` at all, so it is simply not one and returns
    // cleanly — no table name anywhere in the decision, which is what lets
    // slice 4 rename freely.
    //
    // ⛔ Safe as a discriminator only because it decides WHETHER to run, never
    // WHAT to act on: everything below is re-derived from the stored row and
    // re-checked against it (`findById`, then endpoint + form_definition +
    // outcome). A provenance naming someone else's submission throws rather
    // than promoting it. ⇒ [[feedback_close_toctou_by_rederiving_at_act_site]]
    const isIntakeApproval =
      anchor !== null
      && anchor !== undefined
      && anchor.recipe_id === checkpoint.recipe_id
      && source?.channel === 'reactive'
      && source.actor === 'system'
      && source.source_recipe === anchor.recipe_id
      && source.event_kind.startsWith(RECEPTION_TRIGGER_EVENT_PREFIX)
      && carriesIntakeProvenance;
    if (!isIntakeApproval) {
      if (carriesIntakeProvenance || looksLikeCompiledIntake) {
        throw invalid(
          'form response promotion: intake-shaped checkpoint has no authoritative intake approval origin',
        );
      }
      return;
    }

    if (
      deps.submissionStore === undefined
      || deps.formResponseStore === undefined
      || deps.getFormSubmissionPiiKey === undefined
    ) {
      throw new FormResponsePromotionError(
        'not_configured',
        'form response promotion: intake approval substrate is not configured',
      );
    }

    // Unreachable since the discriminator became `carriesIntakeProvenance`
    // (which is false for a null provenance) — KEPT deliberately: it is also
    // the narrowing guard TypeScript needs to read `provenance` below, and a
    // fail-closed assertion on this path is worth more than the line it costs.
    if (provenance === null) {
      throw invalid('form response promotion: held intake has no substrate provenance');
    }
    const submissionId = requireString(
      provenance.reception_form_submission_id,
      'reception_form_submission_id',
    );
    const endpointId = requireString(
      provenance.reception_endpoint_id,
      'reception_endpoint_id',
    );
    const formDefinitionId = requireString(
      provenance.form_definition_id,
      'form_definition_id',
    );

    const row = deps.submissionStore.findById(submissionId);
    if (row === null) {
      throw new FormResponsePromotionError(
        'source_missing',
        `form response promotion: submission '${submissionId}' was not found`,
      );
    }
    if (row.endpoint_id !== endpointId || row.form_definition_id !== formDefinitionId) {
      throw invalid(
        `form response promotion: held provenance does not match submission '${submissionId}'`,
      );
    }
    if (row.processing_outcome !== 'pending' && row.processing_outcome !== 'processed') {
      throw invalid(
        `form response promotion: submission '${submissionId}' is '${row.processing_outcome}', not acceptable`,
      );
    }

    const approvedAt = context.approved_at;
    if (
      typeof approvedAt !== 'number'
      || !Number.isSafeInteger(approvedAt)
      || approvedAt < 0
    ) {
      throw invalid(
        `form response promotion: submission '${submissionId}' has no valid durable approval timestamp`,
      );
    }

    const requireDirectCheckoutAdmission = async (): Promise<void> => {
      if (row.pair_binding === null) return;
      if (deps.admitPaidDirectCheckoutReview === undefined) {
        throw new FormResponsePromotionError(
          'not_configured',
          'form response promotion: direct-checkout payment admission is not configured',
        );
      }
      const admission = await deps.admitPaidDirectCheckoutReview({
        submission_id: row.submission_id,
        pair_binding: row.pair_binding,
        approved_at: approvedAt,
      }).catch(() => null);
      if (admission === null || admission.kind !== 'admitted') {
        throw invalid(
          `form response promotion: direct-checkout submission '${submissionId}' is not paid-review eligible (${admission?.reason ?? 'source_unavailable'})`,
        );
      }
    };
    // Early check prevents decrypting visitor PII for an unpaid/ineligible
    // transaction. A second check below closes the async decryption window.
    await requireDirectCheckoutAdmission();

    // D-210 audit finding 3a (2026-07-20) — THE UNPAIRED WRITE MOVED BACK HERE.
    //
    // WS2 had put it at SUBMIT, inside the public visitor POST, "where the
    // plaintext is still live and no decrypt is needed". That made approval gate
    // NOTHING about the destination row's existence: a `form_response` row —
    // a first-class `data.*` collection with owner-default grants — existed, and
    // was queryable by the owner's AI, before the owner had seen the submission.
    // A.1 is explicit that stage 2 → 3 has exactly one door: "The inbox HOLDS.
    // Approve is the only door, and it is where the record becomes real."
    //
    // Writing here costs a decrypt the submit path did not need. That is the
    // correct price: the sealed `reception_form_submission` row is stage-2
    // evidence and is never mutated, so nothing is lost by deferring — and the
    // paid-pair path below already proves the decrypt-then-write shape works at
    // approve time.
    //
    // The destination discriminator comes from the held projection payload, which
    // is substrate-authored at dispatch (`arg_overrides` are deliberately not
    // consulted — see `readProjectionArgs`). It decides only WHETHER to write; every
    // value written below is still re-derived from the stored row and re-checked
    // against it. ⇒ [[close_toctou_by_rederiving_at_act_site]]
    //
    // ⛔ An unpaired submission whose destination is `task` / `contact` / `calendar`
    // / `note` still writes NO `form_response` row — that was true at submit (the
    // handler gated on `target_kind === 'form_response'`) and must stay true here,
    // or every intake would mint a spurious row. A D-200 pair continues regardless
    // of destination: its row is the paid deliverable.
    const isFormResponseDestination = args?.top_tier_kind === 'form_response';
    if (row.pair_binding === null && !isFormResponseDestination) return;

    const key = deps.getFormSubmissionPiiKey();
    const [blobJson, separatelySealedEmail] = await Promise.all([
      openFormSubmissionField({
        key,
        endpoint_id: row.endpoint_id,
        submission_id: row.submission_id,
        field: 'submission_blob',
        ciphertext: row.submission_blob_encrypted,
      }),
      openFormSubmissionField({
        key,
        endpoint_id: row.endpoint_id,
        submission_id: row.submission_id,
        field: 'visitor_email',
        ciphertext: row.visitor_email_encrypted,
      }),
    ]);
    if (blobJson === null) {
      throw invalid(`form response promotion: submission '${submissionId}' has no payload`);
    }
    const decoded = readSubmissionPayload(blobJson);
    if ((decoded.visitor_email ?? null) !== separatelySealedEmail) {
      throw invalid(
        `form response promotion: submission '${submissionId}' visitor email fields disagree`,
      );
    }

    // Decryption yields to the event loop. Re-read the exact CAS row after
    // that yield and immediately before the synchronous canonical insert so a
    // concurrent refund/ambiguity transition cannot inherit the earlier paid
    // observation.
    await requireDirectCheckoutAdmission();

    const definitionSnapshot = definitionSnapshotFor(row);
    const acceptedAt = Math.max(approvedAt, row.submitted_at);
    const acceptance = {
      submission_id: row.submission_id,
      endpoint_id: row.endpoint_id,
      form_definition_id: row.form_definition_id,
      definition_snapshot: definitionSnapshot,
      values: decoded.fields,
      ...(decoded.visitor_email !== undefined
        ? { visitor: { email: decoded.visitor_email } }
        : {}),
      submitted_at: row.submitted_at,
      // A wall-clock correction between submit and approve must not make a
      // valid response impossible to persist; clamp only to the submission
      // floor while otherwise retaining the durable answer timestamp exactly.
      accepted_at: acceptedAt,
      metadata: responseMetadataFor(row),
    };

    // Provenance continues to come only from the substrate-authored input
    // above. The two dedicated override keys are working-copy content, and are
    // honored only for an actual form_response destination. Validate them
    // again at this act site against the frozen definition even though the
    // paired-admin inbox already enforced its key/type allowlist.
    const overrides = checkpoint.arg_overrides ?? {};
    const hasValuesEdit = isFormResponseDestination
      && hasOwn(overrides, 'form_response_values');
    const hasEmailEdit = isFormResponseDestination
      && hasOwn(overrides, 'form_response_visitor_email');
    let accepted;
    if (hasValuesEdit || hasEmailEdit) {
      const editedEmail = hasEmailEdit
        ? overrides.form_response_visitor_email
        : decoded.visitor_email;
      // ⛔ `null` IS A CLEAR, not a value. `validateEditsAgainstSchema` accepts
      // and forwards an explicit `null` as the documented way to clear a
      // non-required field, and the webclient now sends exactly that (an
      // `undefined` would be dropped by `JSON.stringify` and never arrive).
      // Testing only `''`/`undefined` here would carry `{ email: null }` into
      // `validateFormResponseWorkingContent`, which demands a non-empty string
      // and throws — turning a legitimate clear into `source_invalid` AFTER the
      // arg overrides, the audit row and `submitAnswer` are already durable.
      const visitor = editedEmail === ''
        || editedEmail === undefined
        || editedEmail === null
        ? {}
        : { email: editedEmail };
      let working;
      try {
        working = validateFormResponseWorkingContent(
          {
            form_definition_id: row.form_definition_id,
            definition_snapshot: definitionSnapshot,
          },
          {
            values: hasValuesEdit ? overrides.form_response_values : decoded.fields,
            visitor,
          },
        );
      } catch (error) {
        if (error instanceof FormResponseWorkingContentValidationError) {
          throw invalid(`form response promotion: owner edit is invalid: ${error.message}`);
        }
        throw error;
      }
      accepted = deps.formResponseStore.acceptWithWorkingContent(
        acceptance,
        working,
        acceptedAt,
      );
    } else {
      accepted = deps.formResponseStore.accept(acceptance);
    }
    if (accepted.status === 'created') {
      try {
        deps.onCreated?.(accepted.response);
      } catch {
        // Event fan-out is best-effort. The canonical insert is the authority
        // and must never be rolled back/retried because a listener or bus
        // failed after persistence.
      }
    }
  };
};
