/** D-210 Phase C §4b — stamp the materialized destination back onto the
 *  intake submission row.
 *
 *  ⛔ THIS CLOSES A LIVE BUG, not just a Phase C prerequisite.
 *
 *  `reception_form_submission` carries `resolved_target_kind` /
 *  `resolved_target_id`, and `reception.record.list` reads them to compute a
 *  record's `resolved` pointer — the middle link of D-210 step 2's display
 *  chain: record → resolved pointer → destination → `data.timeline(id)`.
 *
 *  Only the AUTO-ACCEPT branch ever wrote them. The review path deliberately
 *  leaves them null ("nothing is materialized until the user approves") and
 *  nothing wrote them back when the approval actually materialized the
 *  destination — so every reviewed intake read as UNRESOLVED forever, with
 *  its task / note / calendar event sitting right there. Retiring
 *  `auto_accept` removes the last writer, which would make the column
 *  permanently dead.
 *
 *  Lives in its own module so the composer and its tests share ONE
 *  implementation: a mirrored copy in the test would drift from the wired
 *  one and quietly stop testing it. */

import type { FormSubmissionStore } from '../../../storage/reception-form-store.js';
import type { ReceptionProjectionResult } from './reception-projection.js';

/** The intake submission this materialize belongs to, or `undefined` when it
 *  is not an intake.
 *
 *  ⛔ Keys on `reception_form_submission_id` ONLY — the intake-specific,
 *  substrate-owned marker (the same one `form-response-promotion.ts` keys its
 *  intake detection on). A generic `form_definition_id` may legitimately
 *  appear in an unrelated workflow, and claiming a submission id that is not
 *  ours would stamp a resolved pointer onto a row this materialize never
 *  materialized. */
export const readIntakeSubmissionId = (input: unknown): string | undefined => {
  const metadata = (input as { metadata?: unknown } | null)?.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const raw = (metadata as Record<string, unknown>).reception_form_submission_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
};

/** Write the resolved destination back, when this materialize was an intake's.
 *
 *  Called on the approve-resume leg, right after the projection commits. This
 *  is the ONLY moment the pointer can be known for a reviewed intake: at
 *  dispatch there is deliberately no destination yet.
 *
 *  BEST-EFFORT BY CONSTRUCTION — never throws. The entity is already
 *  committed by the time this runs, so a failed pointer write must not make a
 *  successful approve report as failed. It degrades to exactly the old
 *  behaviour (a row that reads unresolved), never to a lost materialization.
 *
 *  Idempotent: `markProcessed` is an unconditional UPDATE keyed on
 *  `submission_id`, so a boot-sweep retry of the same approve rewrites the
 *  same values.
 *
 *  ⚠ D-210 A.8 slice 4b changed the hazard this used to carry. `markProcessed`
 *  was a FULL SET, so any later call passing only an outcome nulled the pointer
 *  this module had just written — nothing enforced that this ran last. It is
 *  PARTIAL now: omitting `resolved` leaves the columns alone. This module still
 *  passes it, because it is the one caller that genuinely knows the value.
 *
 *  Returns the id it stamped, or `undefined` when it claimed nothing — the
 *  caller needs no branch, but tests can assert on it. */
export const writeResolvedPointerBack = (
  store: Pick<FormSubmissionStore, 'markProcessed'> | undefined,
  input: unknown,
  projected: ReceptionProjectionResult,
): string | undefined => {
  const submissionId = readIntakeSubmissionId(input);
  if (submissionId === undefined || store === undefined) return undefined;
  try {
    store.markProcessed({
      submission_id: submissionId,
      outcome: 'processed',
      resolved: { kind: projected.top_tier_kind, id: projected.target_id },
    });
    return submissionId;
  } catch (e) {
    console.warn(
      `[d-210] resolved-pointer write-back failed for submission '${submissionId}' `
        + '(the destination exists; the row will read unresolved): '
        + (e instanceof Error ? e.message : String(e)),
    );
    return undefined;
  }
};
