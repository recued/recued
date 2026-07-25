/** D-173 INT-3 — Reception Inbox boot-wiring composer.
 *
 *  Converges the two D-173 Round-2 lanes into a working end-to-end
 *  review-then-approve inbox by composing `ReceptionInboxDeps` from the
 *  per-pair stores + the notification block + the installed catalog:
 *
 *    - The SHARED SEAM (N.6) `resolveArgEditSchema` (Lane P) bound over a
 *      `createOperationCatalogLookup` whose two readers resolve the held
 *      op's `editable_args` (the INT-1 lowering) + `request_schema` off the
 *      LIVE local-manifest catalog by fully-qualified `operation_id`. This
 *      is what makes `InboxItem.arg_schema` non-empty for an installed
 *      reception core-pack op — the keystone of the convergence.
 *    - `submitAnswer` over the notification block's `submitAnswer` (the
 *      EXISTING preflight resume path — the same funnel `history-handler`
 *      wraps). approve → `'approve'` → the engine resumes from the consumed
 *      checkpoint, merging the inbox `arg_overrides` over the gated step.
 *    - `resolveSource` = the lane's PII-redacted default join (I-3) — the
 *      card shows only a generic redacted preview; sealed visitor PII never
 *      leaves the reception row through the inbox list. (A richer
 *      reveal-on-open per-kind source join is a P4 follow-on.)
 *    - a concrete SQLite `ReceptionInboxSubviewStore` (D10) + a no-op
 *      `freeSlotHold` (the scheduling slot store lands with P4).
 *    - `broadcast` over the `EventBus` — the `reception_inbox` kind is
 *      folded into the global `ServerEvent` union (INT-2), so the lane-local
 *      no-cursor event is exactly the bus's `ServerEventInput`.
 *
 *  The PROJECTION-OP EFFECT seam. The reception core-pack's
 *  `intake.materialize` / `approval.materialize` are `approval_required`
 *  catalog operations that ride the normal Gateway path (D-173 I-2): the
 *  inbox only RELEASES them, the engine re-dispatches them on resume. Their
 *  effect is `runReceptionProjection` (writing entity targets through their
 *  destination Source, or verifying the canonical `form_response` terminal).
 *  Wiring that effect at the
 *  connection-adapter dispatch (so the catalog op routes to the projection
 *  module instead of its placeholder `rest` binding) is a connection-adapter
 *  / engine seam OUTSIDE this round's fence (`packages/engine` +
 *  `packages/ingredients` are read-only here; it lands with P3 "retire
 *  drains" — the explicit Round-3 item). This composer therefore exposes the
 *  projection effect as an injectable seam (`projectReception`) backed by
 *  `runReceptionProjection` over the per-pair destination stores, so the
 *  reviewed completion chain is wired +
 *  exercisable now, and the P3 dispatch-routing has a single ready seam to
 *  bind.
 *
 *  Returns `undefined` when its gate handles are absent (no `auditLog` /
 *  `checkpointStore`) — the integration step then drops the slice, matching
 *  the reception / history slice posture (the rpc returns `not_configured`).
 *
 *  Spec: D-173 § N.1 / N.2 / N.5 / N.6 / D5 / D10 / I-2 / I-3. */

import {
  isCommitmentProposalSlug,
  type ArgEditField,
  type IngredientManifest,
  type ReceptionInboxScanStatus,
  type InboxItem,
} from '@recued/contracts';
import {
  COMMITMENT_EVIDENCE_EDITABLE_ARGS,
  COMMITMENT_EVIDENCE_PROPOSAL_SYNTHETIC_OP_ID,
  COMMITMENT_PROPOSE_OPERATION_ID,
} from '../../commitment-evidence-capture.js';
import type { AuditLogStore, CheckpointStore } from '@recued/storage';
import type { PreflightResumer } from '@recued/gateway';
import { createNoAskRelease } from '../../reception-inbox-no-ask-release.js';
import type { EventBus } from '../../events/bus.js';
import type { ContactRpcDeps } from '../../contact-handler.js';
import type { LocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import type { FormResponseStore } from '../../storage/form-response-store.js';
import {
  defaultIsReceptionOriginAnchor,
  defaultResolveInboxSource,
  withLiveAttachmentScanStatus,
  type CountCalendarOverlap,
  type ReceptionInboxBroadcastEvent,
  type ReceptionInboxDeps,
  type ReceptionInboxSubviewStore,
  type ResolveInboxSource,
} from '../../reception-inbox-handler.js';
import {
  createOperationCatalogLookup,
  resolveArgEditSchema,
  type ArgEditSchemaResolverDeps,
} from '../../preflight-arg-schema-resolver.js';
import {
  runReceptionProjection,
  type ReceptionAttachFileEffect,
  type ReceptionCalendarEventEffect,
  type ReceptionProjectionInput,
  type ReceptionProjectionResult,
  type ReceptionProjectionWorkEntityStore,
} from '../../ports/reception/projection/reception-projection.js';
import type { ReceptionBookingMintEffect } from '../../ports/reception/projection/reception-booking-mint.js';

/** The injectable projection-op effect (the D-173 I-2 materialize). Backed
 *  by `runReceptionProjection`; the P3 dispatch-routing slice binds it as
 *  the catalog op's connection-adapter effect. */
export type ReceptionProjectionEffect = (
  input: ReceptionProjectionInput,
) => Promise<ReceptionProjectionResult>;

export interface ComposeReceptionInboxDepsInput {
  /** Gate handle — the D-120 audit log (held-run anchors + audit rows). */
  readonly auditLog: AuditLogStore | undefined;
  /** Gate handle — the checkpoint store (held state + the N.5 narrow
   *  `setArgOverrides` writer). */
  readonly checkpointStore: CheckpointStore | undefined;
  /** The installed local-manifest catalog store — the source the operation
   *  catalog lookup reads `editable_args` + `request_schema` off of (by
   *  fully-qualified `operation_id`). Always present at the wire site
   *  (per-pair db). */
  readonly localManifestStore: LocalManifestStore | undefined;
  /** The D-121 broadcast bus. The inbox emits the `reception_inbox` kind
   *  (INT-2 fold) on approve / reject. */
  readonly eventBus: EventBus;
  /** The subview store (D10) — the concrete SQLite-backed impl. */
  readonly subviewStore: ReceptionInboxSubviewStore | undefined;
  /** Release a held op through the EXISTING preflight resume path — the
   *  notification block's `submitAnswer`, pre-bound by the caller to the
   *  `'ui'` channel (the same funnel `history-handler` wraps). Absent (no
   *  notification block) → approve fails closed with `not_configured`
   *  instead of reporting a no-op release. */
  readonly submitAnswer?: (ask_id: string, option_id: string) => Promise<void>;
  /** D-210 Phase C — the DECORATED preflight resumer. Present ⇒ the inbox
   *  can release a hold that carries NO durable ask by driving
   *  `resumeRun` / `denyRun` directly. Required for `inbox_fanout_mode:
   *  'notify'`, where no ask is ever raised; in `'approval'` it only
   *  covers the raise-failed accident. Absent ⇒ an ask-less hold keeps
   *  the `not_configured` refusal (fail closed — never report a release
   *  that did not happen). */
  readonly preflightResumer?: PreflightResumer;
  /** D-177 N.14 — read the hold's ask and return its allow-for-this-form
   *  offer bounds iff the OPEN ask actually carries the `allow_session`
   *  option (bound by the caller over `NotificationBlock.getAsk`). Feeds
   *  the `InboxItem.allow_offer` hint + the approve path's act-site
   *  re-verify. */
  readonly readAskAllowOffer?: (
    ask_id: string,
  ) => Promise<{ ttl_ms: number; max_uses: number } | undefined>;
  /** D-173 D7 — the owner-facing calendar overlap count for a held booking
   *  (`countCalendarOverlap` over the calendar stack). Absent ⇒ no count is
   *  surfaced on the inbox item. Owner-facing ONLY — never the visitor path. */
  readonly countCalendarOverlap?: CountCalendarOverlap;
  readonly lookupBookingHistory?: (
    source: InboxItem['source'],
    args: Readonly<Record<string, unknown>>,
  ) => Promise<InboxItem['booking_history']>;
  readonly resolveFormResponseEdit?: ReceptionInboxDeps['resolveFormResponseEdit'];
  /** Per-pair work-entity store — the destination the projection effect
   *  writes task / note / commitment / project through (D5). */
  readonly workEntityStore?: ReceptionProjectionWorkEntityStore;
  /** Canonical accepted-response store used to verify a store-only intake
   *  promotion before its held operation can complete. */
  readonly formResponseStore?: Pick<FormResponseStore, 'findById'>;
  /** The `contact.upsert` path — the D5 contact branch's write path (NOT a
   *  Source). Present only when a `contact`-kind projection can run. */
  readonly contactDeps?: ContactRpcDeps;
  /** D-173 P4.3 — the local-calendar create seam (the `calendar.event`
   *  intake branch's write path). Built by the caller over the calendar stack;
   *  present only when a calendar can be written. Absent → an intake-calendar
   *  projection fail-closes. */
  readonly createCalendarEvent?: ReceptionCalendarEventEffect;
  /** Scheduling reservation materialization. Kept explicit so a conditional
   *  spread at the boot caller cannot silently drop the live booking seam. */
  readonly createBooking?: ReceptionBookingMintEffect;
  /** D-173 P5 — the file-attach seam (a drop's `data.link role:'attachment'`
   *  write path). Built by the caller over the annotation store + collection
   *  registry; present only when the attach substrate is up. Absent → a
   *  work-entity projection carrying a `file_id` fail-closes. */
  readonly attachFile?: ReceptionAttachFileEffect;
  /** D-173 P5 (scan-gate part B) — read a `data.file.received` record's LIVE
   *  `scan_status` so a drop attachment in the inbox shows the scanner verdict
   *  (`clean` / `flagged`) the ClamAV pack wrote, instead of the static
   *  `unscanned` the source resolver stamps. Built by the caller over the
   *  collection registry; absent (or a vanished record) → the attachment keeps
   *  `unscanned` and the advisory gate still warns — a missing scanner never
   *  blocks review. */
  readonly readFileScanStatus?: (file_id: string) => ReceptionInboxScanStatus | undefined;
  /** Deterministic clock seam. Production passes `Date.now`. */
  readonly now?: () => number;
}

/** The bundle the composer returns — `ReceptionInboxDeps` (for
 *  `makeReceptionInboxRpcHandlers`) + the injectable projection effect (for
 *  the P3 dispatch-routing seam + the INT-4 e2e). */
export interface ReceptionInboxDepsBundle {
  readonly receptionInboxDeps: ReceptionInboxDeps;
  /** The projection-op effect (`runReceptionProjection`-backed). The catalog
   *  op's connection-adapter effect binds to this in P3; the e2e exercises
   *  it directly to prove the materialize-through-Source-with-edited-args
   *  chain. */
  readonly projectReception: ReceptionProjectionEffect;
}

/** Build the operation-catalog `lookupOperation` over the installed
 *  local-manifest catalog. Scans the current catalog manifests for the
 *  `OperationSpec` whose `operation_id` matches (the held checkpoint's
 *  `approved_target.operation_id` is the fully-qualified id the catalog
 *  gate resolved). Both `editable_args` (the INT-1 lowering) and
 *  `request_schema` come off that one spec.
 *
 *  Pure of side effects beyond the injected `listManifests()` read; rebuilds
 *  the index per call so a freshly-installed pack's ops resolve without a
 *  restart (the inbox is low-frequency — a held-op approve is a human
 *  action, not a hot path). */
const buildResolverDeps = (
  localManifestStore: LocalManifestStore,
): ArgEditSchemaResolverDeps => {
  /** Find the installed `OperationSpec` (by fully-qualified id) across every
   *  current catalog manifest's `operations` map. */
  const findOperation = (
    operationId: string,
  ): { editable_args?: readonly ArgEditField[]; request_schema?: unknown } | undefined => {
    const manifests: IngredientManifest[] = localManifestStore.listManifests();
    for (const manifest of manifests) {
      const ops = manifest.operations;
      if (ops === undefined) continue;
      for (const spec of Object.values(ops)) {
        if (spec.operation_id === operationId) {
          return {
            ...(spec.editable_args !== undefined ? { editable_args: spec.editable_args } : {}),
            ...(spec.request_schema !== undefined ? { request_schema: spec.request_schema } : {}),
          };
        }
      }
    }
    return undefined;
  };

  // D-192 F1 — the commitment-evidence proposal holds on the KERNEL
  // `commitment-propose` op, whose manifest is runtime-bundled (never in
  // the local-manifest catalog this lookup scans). Serve its
  // approve-with-editable-args allowlist for EVERY identity the inbox may
  // key on (`heldOperationId`, reception-inbox-handler.ts):
  //   1. the resolved catalog `operation_id` — for a hypothetical surface
  //      dispatch of the op;
  //   2. the BACKING SLUG `commitment-propose` — the ACTUAL identity a
  //      simple-form kernel op-step resolves to: the gate records
  //      `approved_target = { ingredient_slug: 'commitment-propose' }` with
  //      NO `operation_id` (only catalog surface dispatches carry a
  //      `surface_operation_key`), so `heldOperationId` returns the slug.
  //      Without this the owner could NOT edit statement/deadline/direction/
  //      counterparty on a captured proposal (every edit rejected as
  //      `edit_not_allowed`) — the whole point of the review surface;
  //   3. the synthetic `<recipe>.<gated_step>` fallback — the last resort
  //      when neither `operation_id` nor `ingredient_slug` is set.
  // The allowlist declares types in full, so no request_schema fallback is needed.
  const kernelEditableArgs = (operationId: string): readonly ArgEditField[] | undefined =>
    operationId === COMMITMENT_PROPOSE_OPERATION_ID
    || isCommitmentProposalSlug(operationId)
    || operationId === COMMITMENT_EVIDENCE_PROPOSAL_SYNTHETIC_OP_ID
      ? COMMITMENT_EVIDENCE_EDITABLE_ARGS
      : undefined;

  return {
    lookupOperation: createOperationCatalogLookup({
      // INT-1 — `editable_args` is now LOWERED onto the installed
      // `OperationSpec`, so the runtime reads the allowlist straight off the
      // live catalog (was: dropped at decompose → resolver always empty).
      getEditableArgs: (operationId) =>
        kernelEditableArgs(operationId) ?? findOperation(operationId)?.editable_args,
      getRequestSchema: (operationId) => findOperation(operationId)?.request_schema,
    }),
    // lookupTargetField is a P4 enrichment (entity-field type/privacy on the
    // materialize target) — the field falls back to its `editable_args`
    // declaration + the request schema, which the core packs declare in full.
  };
};

/** Compose `ReceptionInboxDeps` + the projection effect for server boot. */
export const composeReceptionInboxDeps = (
  input: ComposeReceptionInboxDepsInput,
): ReceptionInboxDepsBundle | undefined => {
  // Gate — the held-op view + the N.5 boundary writer are both load-bearing;
  // without either the inbox cannot function (drop the slice → not_configured).
  if (
    input.auditLog === undefined
    || input.checkpointStore === undefined
    || input.localManifestStore === undefined
    || input.subviewStore === undefined
  ) {
    return undefined;
  }

  const now = input.now ?? (() => Date.now());
  const localManifestStore = input.localManifestStore;
  const resolverDeps = buildResolverDeps(localManifestStore);

  const broadcast = (event: ReceptionInboxBroadcastEvent): void => {
    // The lane-local no-cursor event IS the bus's `ServerEventInput` for the
    // `reception_inbox` kind (INT-2 fold); the bus stamps the cursor. Emit is
    // best-effort — a bus failure never aborts the approve/reject (the
    // high-assurance audit row + the arg_overrides write land BEFORE this).
    try {
      input.eventBus.emit(event);
    } catch {
      /* non-fatal — broadcast is fire-and-forget (D-158 I-2 / TR-10 posture). */
    }
  };

  // D-173 P5 (scan-gate part B) — wrap the PII-redacted default join so a drop
  // attachment's `scan_status` reflects the LIVE data.file.received verdict (the
  // ClamAV pack writes it via core.storage.file.set-scan-status) rather than the
  // static `unscanned` the source resolver stamps. The default join stays pure
  // (its `unscanned` is the dbless/test floor); production enriches when the
  // file-collection reader is wired. A missing reader or a vanished record leaves
  // `unscanned` — the advisory gate still warns, so a down scanner never blocks
  // review. (The wrapper is a pure helper on the handler so it is unit-tested.)
  const resolveSource: ResolveInboxSource = withLiveAttachmentScanStatus(
    defaultResolveInboxSource,
    input.readFileScanStatus,
  );

  const receptionInboxDeps: ReceptionInboxDeps = {
    auditLog: input.auditLog,
    checkpointStore: input.checkpointStore,
    // SHARED SEAM (N.6) — bind Lane P's resolver over the live-catalog
    // operation lookup. Production CAPTURES the real `ArgEditSchemaResolverDeps`
    // in this closure (so the lookup is always the live catalog) and ignores
    // the handler's threaded opaque `resolverDeps` bag — which is an
    // open `Record<string, unknown>` for unit-test stubs, and deliberately
    // left at its `{}` default here (the closure is the production binding).
    resolveArgEditSchema: (operationId, prefilledArgs) =>
      resolveArgEditSchema(operationId, prefilledArgs, resolverDeps),
    // PII-redacted default join (I-3) — generic preview, no sealed visitor
    // PII through the list. A richer reveal-on-open per-kind join is P4.
    // D-173 P5 — wrapped to enrich a drop attachment's live scan_status.
    resolveSource,
    isReceptionOrigin: defaultIsReceptionOriginAnchor,
    // EXISTING resume path — answer the held op's `gateway.preflight` ask.
    // Unwired notification blocks now fail closed with `not_configured`.
    submitAnswer: input.submitAnswer,
    // D-210 Phase C — the no-ask release leg. Bound only when BOTH the
    // decorated resumer and the checkpoint store are present: the release
    // must resume AND consume the checkpoint, and a half-wired seam that
    // resumed without consuming would let a boot sweep re-raise an already
    // released hold.
    ...(input.preflightResumer !== undefined && input.checkpointStore !== undefined
      ? {
          releaseWithoutAsk: createNoAskRelease({
            resumer: input.preflightResumer,
            checkpointStore: input.checkpointStore,
          }),
        }
      : {}),
    // D-177 N.14 — the allow-for-this-form offer read (absent ⇒ no
    // affordance + `allow: true` refuses, fail closed).
    ...(input.readAskAllowOffer !== undefined
      ? { readAskAllowOffer: input.readAskAllowOffer }
      : {}),
    subviewStore: input.subviewStore,
    // D-173 D7 — "confirmed at approval". The OWNER-facing overlap count over
    // every calendar they have, so they can judge whether another booking at
    // this time is fine. Absent ⇒ the item carries no count and the surface
    // renders nothing.
    //
    // ⛔ This is NOT the visitor path. The slot picker keeps
    // `NULL_SCHEDULING_CALENDAR_EVENTS_READER` (`wire-reception-substrate.ts`):
    // free/busy-vs-your-calendar stays out of scope for the visitor per D7, and
    // event intervals are a free/busy disclosure. Same data, opposite audience —
    // do not cross-wire these two.
    ...(input.countCalendarOverlap !== undefined
      ? { countCalendarOverlap: input.countCalendarOverlap }
      : {}),
    ...(input.lookupBookingHistory !== undefined
      ? { lookupBookingHistory: input.lookupBookingHistory }
      : {}),
    ...(input.resolveFormResponseEdit !== undefined
      ? { resolveFormResponseEdit: input.resolveFormResponseEdit }
      : {}),
    broadcast,
    now,
  };

  // The projection-op effect — `runReceptionProjection` over the per-pair
  // destination stores. The P3 dispatch-routing
  // slice binds this as the catalog op's connection-adapter effect; until
  // then it is the ready seam the e2e exercises to prove the
  // materialize-through-Source chain.
  const projectReception: ReceptionProjectionEffect = (projInput) =>
    runReceptionProjection(
      {
        workEntityStore: input.workEntityStore ?? {},
        ...(input.formResponseStore !== undefined
          ? { formResponseStore: input.formResponseStore }
          : {}),
        ...(input.contactDeps !== undefined ? { contactDeps: input.contactDeps } : {}),
        ...(input.createCalendarEvent !== undefined
          ? { createCalendarEvent: input.createCalendarEvent }
          : {}),
        ...(input.createBooking !== undefined
          ? { createBooking: input.createBooking }
          : {}),
        ...(input.attachFile !== undefined ? { attachFile: input.attachFile } : {}),
        now,
      },
      projInput,
    );

  return { receptionInboxDeps, projectReception };
};
