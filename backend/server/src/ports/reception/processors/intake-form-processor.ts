/** D-149 P6 / D-173 P3 § A.7 / D-210 Phase C — intake_form submission
 *  processor (the SINGLE review-then-approve dispatch step).
 *
 *  Turns a persisted `reception_form_submission` row into a HELD
 *  review-then-approve operation. The drain is not an *auto-materializer* — it
 *  is the *intake → workflow dispatch* step, and it writes no warehouse entity
 *  itself (I-1).
 *
 *  ⛔ D-210 Phase C — `auto_accept` RETIRED (owner ruling, 2026-07-18). There
 *  used to be a second branch: an explicit per-endpoint pre-grant that
 *  materialized straight through and never parked at the gate. It is gone, on
 *  all three reception kinds at once (`drop_link.on_upload`,
 *  `approval_link.on_action`), so inbox model "B" — nothing a visitor submits
 *  reaches the owner's world without approval — holds without an asterisk. The
 *  config validator now REFUSES the key rather than ignoring a stale one.
 *
 *  Flow per pending row:
 *    1. Decrypt `submission_blob` with the form-PII key → `{ visitor_email?,
 *       fields }`.
 *    2. Build the review projection: configured fields shape the proposed
 *       entity for entity targets, or only its review summary for a LOG-ONLY
 *       submission (absent `target_kind` — D-210 WS2). Immutable provenance
 *       always rides.
 *    3. If the durable row carries a D-200 direct-checkout pair, exact-read
 *       its immutable workflow row and leave it pending unless provider truth
 *       is v4/paid. Recheck after the decrypt yield before Inbox dispatch.
 *       Generic D-149 submissions skip this gate.
 *    4. Hand the projection-shaped payload to the `fireReceptionWorkflow` seam
 *       → the compiled `review-then-approve` recipe fires, its
 *       `approval_required` materialize op is HELD at the D-157 gate, and the
 *       Reception Inbox surfaces it. When the seam is unwired (no compiled
 *       recipe for the kind) the row stays `pending` to dispatch once it
 *       installs — it MUST NOT fall back to materialize.
 *    5. Flip the submission to `processed` (the workflow was dispatched) so
 *       the drain never re-processes it. `resolved_target_*` stay null until
 *       the approval actually materializes the destination, which writes them
 *       back (D-210 Phase C §4b, `reception-resolved-pointer.ts`).
 *
 *  A row whose config is corrupt or whose blob won't decrypt is flipped to
 *  `failed` (the encrypted row is retained for later review/reprocessing —
 *  never silently dropped) so a poison row can't wedge the batch or retry
 *  forever. A row whose dispatch seam is simply absent (no recipe wired) is
 *  left `pending` (not `failed`) — it is valid, undispatched work, not a
 *  poison row.
 *
 *  Spec: D-149 § A.5.3 + § Must Hold I-12; D-173
 *  § A.7 / D3 / I-1; D-210 Phase C. */

import {
  COMMITMENT_STATEMENT_MAX,
  NOTE_TITLE_MAX,
  RECUED_BUILTIN_SOURCE_ID,
  TASK_TITLE_MAX,
  type IntakeFormConfig,
  type SourceTopTierKind,
} from '@recued/contracts';
import type {
  FireReceptionWorkflow,
  ReceptionDrainResult,
  ReceptionDrainTickInput,
  ReceptionSubmissionProcessor,
} from '../reception-drain.js';
import { openFormSubmissionField } from '../form-pii.js';
import { parseIntakeFormConfig } from '../transformations/intake-form.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type { FormSubmissionStore } from '../../../storage/reception-form-store.js';
import type { WorkEntityStore } from '../../../storage/work-entity-store.js';
import type { AdmitPaidDocumentDirectCheckoutReview } from '../../../paid-document-direct-checkout-review-admission.js';
import { rowOwesDefaultDispatch } from '../paired-row-default-dispatch.js';
import {
  resolveIntakeCalendarSlots,
  resolveIntakeContactName,
  visibleFieldTypeMap,
} from './intake-destination-mapping.js';

/** Narrow store slices — keeps the processor decoupled + unit-fakeable. */
export type ReceptionDrainRegistry = Pick<PublicEndpointRegistryStore, 'list'>;
export type ReceptionFormDrainStore = Pick<
  FormSubmissionStore,
  'listPendingForEndpoint' | 'markProcessed'
>;
export type ReceptionMaterializeStore = Pick<
  WorkEntityStore,
  'writeTask' | 'writeNote' | 'writeCommitment'
>;

export interface IntakeFormProcessorDeps {
  readonly registryStore: ReceptionDrainRegistry;
  readonly submissionStore: ReceptionFormDrainStore;
  readonly workEntityStore: ReceptionMaterializeStore;
  readonly getFormSubmissionPiiKey: () => Uint8Array;
  readonly now: () => number;
  // D-210 Phase C — the `notify` / `runRecipe` effect seams are GONE. They
  // were only ever called from the auto-accept branch, and they were never
  // bound in production either (`wire-reception-substrate.ts`: "the notify +
  // triggered_recipe / applyEffect seams are intentionally left unwired here
  // … a later effects pass supplies them" — that pass never landed). With the
  // branch retired they had zero call sites, so keeping the parameters would
  // advertise a hook nothing can reach.
  //
  // ⚠ Their CONFIG fields outlive them: `submission_processing_rule`'s
  // `triggered_recipe_id` and `notification_target` now have no reader at all.
  // Retiring those is an authoring-surface change and its own decision — see
  // the handover. Building the deferred effects pass would give them a real
  // home on the approve leg.
  /** D-173 P3 § A.7 — the review-then-approve dispatch seam (the SINGLE
   *  path for REVIEW-mode endpoints, the default). Fires the kind's compiled
   *  `review-then-approve` recipe so its `approval_required` op holds at the
   *  D-157 gate → inbox. Absent (boot phase before the engine composes, or no
   *  reception core-pack installed) ⇒ a review-mode row is left `pending` to
   *  dispatch once the recipe lands (NEVER auto-materialized as a fallback —
   *  that would bypass review, violating I-1). D-210 Phase C: this is now the
   *  ONLY path — there is no pre-grant that skips it. */
  readonly fireReceptionWorkflow?: FireReceptionWorkflow;
  /** D-200 Slice 6g.16 — paired form_response submissions remain pending
   * until their immutable v4 row proves exact provider-verified payment.
   * Missing composition is fail-closed for paired rows and has no effect on
   * generic D-149 intake. */
  readonly admitPaidDirectCheckoutReview?: AdmitPaidDocumentDirectCheckoutReview;
}

const clamp = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
};

interface DecodedSubmission {
  readonly visitor_email?: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Project the submission into the held-operation shape. Entity targets obey
 * the configured body/metadata mappings. A LOG-ONLY submission (no `target_kind`
 * — D-210 WS2) has no entity mapping, so its review body automatically includes
 * every visible, non-honeypot field; otherwise the owner would have nothing to
 * inspect before accepting it. Visitor email remains separately sealed. */
const buildEntityShape = (
  config: IntakeFormConfig,
  decoded: DecodedSubmission,
  provenance: { submission_id: string; endpoint_id: string },
): { title: string; body: string; metadata: Record<string, unknown> } => {
  const rule = config.submission_processing_rule;
  const labelByName = new Map(
    config.form_definition.fields.map((f) => [f.name, f.label] as const),
  );
  const valueOf = (name: string): string => asText(decoded.fields[name]);
  // D-210 A.8 slice 2b step 3 — this was `rule.target_kind === undefined`
  // ("log-only"). Absent is no longer a value, but the BEHAVIOUR it selected is
  // not dead: it was always "this intake's answers ARE the record, so review the
  // whole submission rather than a configured projection of it". That is
  // precisely what `'form_response'` means, and the contract already says so —
  // "its held review summary includes every visible non-honeypot field".
  //
  // ⛔ Deleting this branch instead of re-pointing it would silently empty the
  // review payload: a `form_response` intake has no reason to populate
  // `fields_to_include_in_target` (coverage is not required for it), so the
  // body would fall back to an empty list and the owner would review a blank.
  const answersAreTheRecord = rule.target_kind === 'form_response';
  const honeypotFields = new Set(config.anti_spam.honeypot_fields);
  const bodyFieldNames = answersAreTheRecord
    ? config.form_definition.fields
        .map((field) => field.name)
        .filter((name) => !honeypotFields.has(name))
    : rule.fields_to_include_in_target;

  const firstNonEmpty = bodyFieldNames
    .map(valueOf)
    .find((s) => s.trim().length > 0);
  const titleSource = answersAreTheRecord
    ? `${config.display_name} form submission`
    : firstNonEmpty ?? `${config.display_name} form submission`;
  const title = titleSource.trim() || 'Form submission';

  const body = bodyFieldNames
    .map((name) => `${labelByName.get(name) ?? name}: ${valueOf(name)}`)
    .join('\n');

  // Visitor metadata fields FIRST, then provenance ids LAST so a config
  // whose field is named `reception_*` / `form_definition_id` can never
  // clobber or spoof the provenance — those ids are the entity's only
  // reverse link back to the sealed submission row.
  //
  // The visitor email is deliberately NOT copied here: `visitor_email` is a
  // substrate-injected PII field sealed separately in the reception row
  // (visitor_email_encrypted, contact-resolution-gated per D-138); copying
  // it plaintext into the entity's `source_extension_blob` (a normal
  // queryable field returned by every task/note/commitment read) would
  // bypass that gate. The provenance id lets a future gated detail path
  // decrypt the email on demand instead.
  const metadata: Record<string, unknown> = {};
  const metadataFieldNames = answersAreTheRecord ? [] : rule.fields_to_attach_as_metadata;
  for (const name of metadataFieldNames) {
    metadata[name] = decoded.fields[name] ?? null;
  }
  metadata.reception_form_submission_id = provenance.submission_id;
  metadata.reception_endpoint_id = provenance.endpoint_id;
  metadata.form_definition_id = config.form_definition.form_definition_id;
  return { title, body, metadata };
};

/** Deterministic work-entity id for a submission. The work-entity writes
 *  upsert on `ON CONFLICT(id)`, so deriving the id from the submission_id
 *  makes materialization idempotent: if the process crashes after the
 *  entity write but before `markProcessed`, the restart catch-up drain
 *  re-materializes onto the SAME id (overwrite) instead of creating a
 *  duplicate entity with a fresh random id. */
const entityIdForSubmission = (submission_id: string): string => `reception_${submission_id}`;

/** Map a submission `target_kind` to the projection `top_tier_kind` the
 *  review-then-approve workflow forwards (D5). `inbox_item` has no distinct
 *  `top_tier_kind`; the review payload routes it as a `task` — the
 *  materialize-through-Source resolves to the builtin task Source. */
type IntakeReviewProjectionKind = SourceTopTierKind | 'form_response';

const topTierKindForTarget = (
  target_kind: IntakeFormConfig['submission_processing_rule']['target_kind'],
): IntakeReviewProjectionKind => {
  switch (target_kind) {
    case 'note':
      return 'note';
    // D-210 A.7 — `booking` is the primary destination; its projection arm
    // lands in `reception-projection.ts`. ⚠ `commitment` and `inbox_item` LEFT
    // this switch with the intake vocabulary: nothing in reception mints a
    // commitment (A.5), and `inbox_item` was always an alias for `task`.
    // ⛔ The `commitment` PROJECTION arm stays — `approval_link` still reaches
    // it, and an approval is a verdict on a record that already exists, which
    // is a different picture from a submission naming a destination.
    case 'booking':
      return 'booking';
    // D-210 WS3 — the two destinations whose projection arms are NOT
    // Source-routed work entities. `calendar` materializes through the local
    // calendar create seam, `contact` through the `contact.upsert` path.
    case 'calendar':
      return 'calendar.event';
    case 'contact':
      return 'contact';
    // D-210 A.8 slice 2 — the generic destination: the answers ARE the record.
    // ⚠ This arm ABSORBED `case undefined` in step 3. Absent used to be a
    // second spelling of exactly this, and the two are now one.
    case 'form_response':
      return 'form_response';
    case 'task':
      return 'task';
    default: {
      // ⚠ `task` USED to carry `default:` with it. That made this the same
      // silent-laundering shape the projection had: any target_kind without an
      // arm — including a value RETIRED from `INTAKE_FORM_TARGET_KINDS` but
      // still sitting in a stored config — quietly became a Task, and the owner
      // got a destination they never chose. `validateIntakeFormConfig` rejects
      // unknown kinds, but only at the rpc boundary; the drain does not
      // revalidate, so this is the last place a stale value can be caught.
      // Exhaustive now: the `never` binding makes the next vocabulary change a
      // compile error here, and the throw fails closed at the point of use.
      const unhandled: never = target_kind;
      throw new Error(
        `intake_form: no top_tier_kind mapping for target_kind '${String(unhandled)}' — `
          + 'add one rather than letting it fall through to a task',
      );
    }
  }
};

/** D-210 WS3 — destinations that are NOT deterministic-`reception_<id>` work
 *  entities. A calendar event's identity is minted by the create seam; a
 *  contact's is its canonical email. Both are idempotent on their own key, so
 *  neither needs (nor can use) the legacy id. */
/** D-210 WS3 — the destination-specific slots a review payload carries beyond
 *  the generic title/body/metadata.
 *
 *  Returns `{}` for every destination that needs none (the work entities and
 *  log-only), and `null` when a calendar mapping could not be resolved — the
 *  caller must then leave the row PENDING rather than dispatch a hold whose
 *  start does not exist. `null` is deliberately distinct from `{}`: "nothing to
 *  add" and "this cannot be built" are different answers and only one of them
 *  is safe to proceed on. */
const resolveDestinationSlots = (
  config: IntakeFormConfig,
  fields: Record<string, unknown>,
): Record<string, unknown> | null => {
  const rule = config.submission_processing_rule;
  if (rule.target_kind === 'calendar') {
    if (rule.calendar_mapping === undefined) return null;
    const resolved = resolveIntakeCalendarSlots({
      mapping: rule.calendar_mapping,
      fields,
      fieldTypes: visibleFieldTypeMap(config),
    });
    if (!resolved.ok) return null;
    return {
      start_at: resolved.slots.start_at,
      duration_minutes: resolved.slots.duration_minutes,
      timezone: resolved.slots.timezone,
      ...(resolved.slots.is_all_day ? { is_all_day: true } : {}),
      // I-7's past-slot guard is scheduling's, not intake's: a visitor may
      // legitimately record a date that has already passed (a leave day being
      // logged after the fact). Deliberately NOT set.
    };
  }
  if (rule.target_kind === 'contact') {
    const name = resolveIntakeContactName({
      mapping: rule.contact_mapping,
      fields,
    });
    // The EMAIL is absent by construction — the projection resolves it from
    // the sealed submission at materialize time.
    return name !== undefined ? { contact_name: name } : {};
  }
  return {};
};

/** Entity targets use the legacy deterministic `reception_` id. A LOG-ONLY
 * submission (absent target_kind — D-210 WS2) addresses the canonical
 * form_response by its actual submission id, which the projection's non-writing
 * terminal verifies against immutable provenance. */
const projectionIdForSubmission = (
  target_kind: IntakeFormConfig['submission_processing_rule']['target_kind'],
  submission_id: string,
// ⚠ D-210 A.8 slice 2b step 3 — was `target_kind === undefined`. THIRD branch
// in this file keyed on the retired absent value, and the most dangerous: the
// `form_response` terminal looks the row up by its ACTUAL submission id, so
// letting it fall through to `reception_<id>` would make every lookup miss.
// Re-pointed, not deleted — same fix as `answersAreTheRecord` above.
): string => target_kind === 'form_response'
  ? submission_id
  : entityIdForSubmission(submission_id);

export const createIntakeFormSubmissionProcessor = (
  deps: IntakeFormProcessorDeps,
): ReceptionSubmissionProcessor => {
  // Deferred direct-checkout rows deliberately remain `pending`. Advance a
  // stable per-endpoint scan cursor across ticks so an unpaid oldest prefix
  // cannot starve a later paid row forever. When the cursor reaches the end,
  // the same tick wraps to the oldest still-pending row.
  const pendingCursorByEndpoint = new Map<
    string,
    { readonly submitted_at: number; readonly submission_id: string }
  >();

  const drainOnce = async (
    { now, limit }: ReceptionDrainTickInput,
  ): Promise<ReceptionDrainResult> => {
    let processed = 0;
    let failed = 0;
    let budget = limit;

    // Resolve the form-PII key lazily + once per tick. A locked /
    // uninitialised FileVault makes the getter throw `not_configured` (503)
    // — the SAME transient error the visitor handlers surface. That MUST
    // NOT be treated as row corruption: marking pending rows `failed` here
    // would lose valid submissions on the fire-immediate boot drain (vault
    // not yet unlocked). On key-unavailable the whole tick aborts, leaving
    // rows `pending` to retry after unlock. Per-row decrypt failures below
    // (valid key, tampered ciphertext) are the only permanent `failed` path.
    let keyResolved = false;
    let piiKey: Uint8Array | null = null;
    const resolveKey = (): Uint8Array | null => {
      if (!keyResolved) {
        keyResolved = true;
        try {
          piiKey = deps.getFormSubmissionPiiKey();
        } catch (e) {
          console.warn(
            '[d-149] intake_form drain: form-PII key unavailable (vault locked?) — leaving submissions pending',
            e,
          );
          piiKey = null;
        }
      }
      return piiKey;
    };

    // ALL intake_form endpoints — including disabled AND revoked. A
    // submission accepted while the endpoint was live is valid received
    // data and must still materialize even if the user later disabled or
    // revoked the endpoint: revocation stops FUTURE visitor access, it does
    // not retroactively discard already-accepted rows (which would strand
    // them as `pending` forever). The config blob is preserved on
    // disabled/revoked rows so materialization still resolves.
    const endpoints = deps.registryStore.list({ kind: 'intake_form', include_revoked: true });

    for (const endpoint of endpoints) {
      if (budget <= 0) break;
      const cursor = pendingCursorByEndpoint.get(endpoint.endpoint_id) ?? null;
      let pending = deps.submissionStore.listPendingForEndpoint(
        endpoint.endpoint_id,
        budget,
        cursor,
      );
      if (pending.length === 0 && cursor !== null) {
        pendingCursorByEndpoint.delete(endpoint.endpoint_id);
        pending = deps.submissionStore.listPendingForEndpoint(
          endpoint.endpoint_id,
          budget,
          null,
        );
      }
      if (pending.length === 0) continue;
      const lastPending = pending[pending.length - 1]!;
      pendingCursorByEndpoint.set(endpoint.endpoint_id, {
        submitted_at: lastPending.submitted_at,
        submission_id: lastPending.submission_id,
      });
      budget -= pending.length;

      const config = parseIntakeFormConfig(endpoint.metadata);

      for (const row of pending) {
        // A corrupt/unparseable config can never materialize — fail the
        // row (retained for review) rather than retry forever.
        if (!config) {
          deps.submissionStore.markProcessed({ submission_id: row.submission_id, outcome: 'failed' });
          failed += 1;
          continue;
        }
        // D-210 §3 — a paired row may not fall through to the DEFAULT review funnel: the
        // submit path already ran the owner's recipe through the gated runner. The one
        // exception is D-200's dying paid deferral. The rule (and why the payment admitter
        // is the exception, not the decision) lives in `rowOwesDefaultDispatch`.
        //
        // Checked before PII access, then once more immediately before dispatch after the
        // decrypt yield.
        const owesDefaultDispatch = (): Promise<boolean> =>
          rowOwesDefaultDispatch({
            pair_binding: row.pair_binding,
            row_id: row.submission_id,
            ...(deps.admitPaidDirectCheckoutReview
              ? { admitPaidDirectCheckoutReview: deps.admitPaidDirectCheckoutReview }
              : {}),
          });
        if (!(await owesDefaultDispatch())) continue;
        const key = resolveKey();
        if (!key) {
          // Vault locked / key unavailable — abort the tick. Remaining
          // rows stay `pending` for the next cycle after unlock.
          return { processed, failed };
        }
        try {
          const blobJson = await openFormSubmissionField({
            key,
            endpoint_id: endpoint.endpoint_id,
            submission_id: row.submission_id,
            field: 'submission_blob',
            ciphertext: row.submission_blob_encrypted,
          });
          if (!blobJson) throw new Error('submission_blob decrypt returned null');
          const parsed = JSON.parse(blobJson) as {
            visitor_email?: unknown;
            fields?: unknown;
          };
          const decoded: DecodedSubmission = {
            ...(typeof parsed.visitor_email === 'string'
              ? { visitor_email: parsed.visitor_email }
              : {}),
            fields:
              parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
                ? (parsed.fields as Record<string, unknown>)
                : {},
          };

          const shape = buildEntityShape(config, decoded, {
            submission_id: row.submission_id,
            endpoint_id: endpoint.endpoint_id,
          });
          const rule = config.submission_processing_rule;

          // D-210 Phase C — REVIEW IS THE ONLY PATH. The per-endpoint
          // `auto_accept` pre-grant was retired (owner ruling, 2026-07-18) on
          // all three reception kinds at once, so inbox model "B" — nothing a
          // visitor submits reaches the owner's world without approval — holds
          // without an asterisk. The materialize op is `approval_required`, so
          // the D-157 gate holds it and the inbox owns the decision.
            // REVIEW (the default) — dispatch the compiled
            // `review-then-approve` workflow so the materialize op is HELD at
            // the D-157 gate → inbox. The processor does NOT materialize here
            // (no ambient warehouse write — I-1); the materialize runs only on
            // the user's explicit approve, through the same projection.
            if (!deps.fireReceptionWorkflow) {
              // No dispatch seam wired (boot phase / no reception core-pack).
              // Leave the row PENDING — it is valid, undispatched review work,
              // not a poison row; it dispatches once the recipe installs. It
              // MUST NOT fall back to materialize (that would bypass review).
              continue;
            }
            if (!(await owesDefaultDispatch())) continue;

            // D-210 WS3 — a `calendar` / `contact` destination needs slots the
            // form's role-agnostic fields don't name on their own. Resolve them
            // from the config's mapping BEFORE dispatching: an unreadable start
            // must leave the row pending (retryable, visible as "did not
            // materialize"), never dispatch a calendar hold whose start the
            // approve would have to invent.
            const destinationSlots = resolveDestinationSlots(config, decoded.fields);
            if (destinationSlots === null) {
              console.warn(
                `[d-210] intake_form: submission '${row.submission_id}' targets `
                  + `'${String(rule.target_kind)}' but its field mapping did not resolve — `
                  + 'leaving PENDING (the config or the submitted values need a look)',
              );
              continue;
            }

            const fired = await deps.fireReceptionWorkflow({
              kind: 'intake_form',
              // The projection-shaped trigger payload (deterministic id,
              // top_tier_kind, title/body, provenance metadata). The compiled
              // recipe forwards
              // it verbatim as `context.event.payload` → the materialize op's
              // `args`. The visitor email is deliberately absent (sealed in the
              // reception row, D-138-gated — never in the queryable payload).
              //
              // D-210 WS3 — `destinationSlots` adds the calendar start /
              // duration / timezone or the contact NAME. Never the contact
              // EMAIL: that stays sealed and is resolved server-side at
              // materialize, so it never enters step state a recipe can read.
              payload: {
                top_tier_kind: topTierKindForTarget(rule.target_kind),
                id: projectionIdForSubmission(rule.target_kind, row.submission_id),
                title: shape.title,
                ...(shape.body.length > 0 ? { body: shape.body } : {}),
                metadata: shape.metadata,
                ...destinationSlots,
              },
              source_ref: row.submission_id,
              endpoint_id: endpoint.endpoint_id,
            });
            if (!fired.dispatched) {
              // The seam couldn't fire (no compiled recipe for the kind). Leave
              // PENDING to retry — never materialize as a fallback (I-1).
              continue;
            }
            // Handed off to the review-then-approve workflow — mark processed
            // so the drain never re-dispatches it (the held op + the inbox now
            // own the lifecycle). `resolved_target_*` stay null: nothing is
            // materialized until the user approves.
            deps.submissionStore.markProcessed({
              submission_id: row.submission_id,
              outcome: 'processed',
            });
            processed += 1;
        } catch (e) {
          console.warn(
            `[d-149] intake_form submission ${row.submission_id} processing failed`,
            e,
          );
          deps.submissionStore.markProcessed({ submission_id: row.submission_id, outcome: 'failed' });
          failed += 1;
        }
      }
    }

    return { processed, failed };
  };

  return { label: 'intake_form', drainOnce };
};
