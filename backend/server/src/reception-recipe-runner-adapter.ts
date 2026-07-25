/** D-207 slice 1c — the production adapter that HANGS the gated reception runner on the
 *  visitor's submit path.
 *
 *  `createReceptionRecipeRunner` is the door; this is the hinge. Without it the runner is a
 *  tested module nothing calls, and a public form still runs exactly what D-200 shipped.
 *
 *  ## Why the handler hands over almost nothing
 *
 *  The submit seam (`CoordinateIntakeFormPairedRun`) carries only a `submission_id`
 *  and the endpoint's own `form_config` — no recipe, no fields, no endpoint id. That
 *  narrowness is deliberate and it is a SECURITY property, not an ergonomic one: the
 *  handler is the surface an anonymous stranger just POSTed to, so nothing it holds in
 *  memory may become an input to the run. Everything the recipe sees is SOURCE-DERIVED
 *  here, from the durable row that was already written and sealed:
 *
 *    submission_id → the persisted row → its `endpoint_id` (never the request's)
 *                                      → its AEAD-sealed blob → the visitor's fields
 *
 *  So a crafted POST cannot point the run at a different endpoint's door, and cannot
 *  substitute fields for the ones that were persisted and audited.
 *
 *  ## The runner OWNS a pair with a door; otherwise it stands aside
 *
 *  `no_door` is not an error — it is "this pair has no minted door contract", which today
 *  means one of two things, both of which belong to someone else:
 *
 *    - D-200's legacy direct-checkout pair (no door is minted for that profile until
 *      Slice 3 retires it), which still has its own coordinator; or
 *    - a pair whose owner has not yet CONFIRMED the capability, so the door is shut.
 *
 *  Either way the caller falls through. It must never be read as success.
 *
 *  Spec: `docs/d-207-spec.md` §5.3. */

import type { IntakeFormConfig } from '@recued/contracts';

import { openFormSubmissionField } from './ports/reception/form-pii.js';
import type { ReceptionOutputBlock } from './ports/reception/handlers/reception-page-render.js';
import type { ReceptionRecipeRunner } from './reception-recipe-runner.js';
import type { FormSubmissionStore } from './storage/reception-form-store.js';

export interface ReceptionRecipeRunnerAdapterDeps {
  readonly runner: ReceptionRecipeRunner;
  readonly submissionStore: Pick<FormSubmissionStore, 'findById'>;
  readonly getFormSubmissionPiiKey: () => Uint8Array;
}

/** What the visitor actually typed, recovered from the sealed blob.
 *
 *  ⚠ Every value is TAINTED (`origin_actor: 'anonymous'`, D-177 N.11). Taint propagates
 *  through every step kind including AI, so a write whose authority-bearing args derive
 *  from these can never ride a standing grant — it holds for the owner. That is what
 *  closes prompt-injection by construction, and it is enforced at the Gateway, not here. */
const openSubmissionFields = async (
  input: { readonly endpoint_id: string; readonly submission_id: string },
  key: Uint8Array,
  ciphertext: string,
): Promise<Record<string, unknown> | null> => {
  try {
    // THROWS, it does not merely return null: a ciphertext that is not even well-formed
    // base64 raises before any decrypt is attempted. Every unreadable-blob path has to land
    // on the same `null` — an uncaught throw here escapes into the visitor's request.
    const plaintext = await openFormSubmissionField({
      key,
      endpoint_id: input.endpoint_id,
      submission_id: input.submission_id,
      field: 'submission_blob',
      ciphertext,
    });
    if (plaintext === null) return null;
    const parsed = JSON.parse(plaintext) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fields = (parsed as { fields?: unknown }).fields;
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null;
    return fields as Record<string, unknown>;
  } catch {
    return null;
  }
};

export type ReceptionRecipeRunnerAdapterOutcome =
  /** D-207 slice 2 — the run's resolved `output.render` blocks travel with the outcome.
   *
   *  ⚠ These blocks are what the VISITOR will be shown. They are PII-RESTORED: the engine's
   *  `resolveOutputRender` runs `piiLedgerStore.restoreAll` over every block, so the output
   *  is alias-free by construction (`packages/engine/src/execute.ts`). For the ordinary case
   *  that is exactly right — the de-aliased values are the visitor's OWN submission coming
   *  back to them, which is what the D-149 visitor receipt already echoes. It is worth
   *  knowing, though, that a recipe which aliases THIRD-PARTY data and then renders a step
   *  that quotes it back (an AI summary repeating an alias it was given) would restore that
   *  to a real address here. That is an authoring hazard, not a substrate hole: no filter
   *  the substrate could apply would tell the two apart, and one that pretended to would be
   *  worse than none. */
  | { readonly kind: 'completed'; readonly render: ReadonlyArray<ReceptionOutputBlock> }
  | { readonly kind: 'held' }
  | { readonly kind: 'refused' }
  /** No pair, or a pair with no minted door. The CALLER must fall through — this is not a
   *  success and must never be rendered as one. */
  | { readonly kind: 'no_door' };

export const composeReceptionRecipeRunnerAdapter = (
  deps: ReceptionRecipeRunnerAdapterDeps,
): ((input: {
  readonly submission_id: string;
  readonly form_config: IntakeFormConfig;
}) => Promise<ReceptionRecipeRunnerAdapterOutcome>) => async ({ submission_id }) => {
  const row = deps.submissionStore.findById(submission_id);
  // The row is written and committed before the seam is entered, so its absence is not a
  // race — it is a submission id that does not exist. Nothing to run, nothing to claim.
  if (row === null) return { kind: 'no_door' };

  const submission = await openSubmissionFields(
    { endpoint_id: row.endpoint_id, submission_id },
    deps.getFormSubmissionPiiKey(),
    row.submission_blob_encrypted,
  );
  // The blob is sealed AAD-bound to `(endpoint, submission, field)`. A failure to open it
  // means the row is unreadable — a locked vault, a rotated key, a tampered ciphertext. We
  // cannot run the recipe on fields we could not recover, and we must NOT run it on an
  // empty set (a recipe reading `{{context.reception_submission.email}}` would quietly see
  // nothing and write a blank record). REFUSE: the visitor is told, the row stays durable.
  if (submission === null) return { kind: 'refused' };

  const outcome = await deps.runner.run({
    // The row's endpoint — never the request's. This is the whole point of source-deriving.
    endpoint_id: row.endpoint_id,
    submission_id,
    submission,
  });

  switch (outcome.kind) {
    case 'completed':
      // D-207 slice 2 — the `render` response mode. The runner has always returned the run's
      // output verbatim (it was built for exactly this); this hop used to throw it away.
      // `output.render` is already RESOLVED — the engine turned each authored
      // `OutputSection.source` ref into `data` — so it needs no further interpretation here,
      // only rendering, which happens at the one visitor-facing boundary
      // (`renderReceptionOutputBlocks`) rather than in this adapter.
      return { kind: 'completed', render: outcome.output.render ?? [] };
    case 'held':
      return { kind: 'held' };
    case 'failed':
      // The visitor was promised something and is not getting it. The handler tells them.
      return { kind: 'refused' };
    case 'no_door':
      return { kind: 'no_door' };
  }
};
