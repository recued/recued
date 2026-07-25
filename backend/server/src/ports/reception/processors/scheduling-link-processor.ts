/** D-149 P5 / D-173 P4 § D7 — scheduling_link booking drain (the booking
 *  front-door's review-then-approve dispatch step).
 *
 *  Turns a persisted reservation row into a HELD review-then-approve operation:
 *
 *  ⚠ **D-210 A.8 slice 4b-ii — that row is a `reception_form_submission` with a
 *  slot**, not `reception_booking_request`. The visitor's five fields are ONE
 *  sealed blob under the FORM key (`booking-blob.ts`), the pending page is
 *  `listPendingBookingsForEndpoint`, and the two frozen `resolved_*` columns are
 *  the generic pair. Flow, guards and outcomes are otherwise unchanged.
 * a visitor picks a slot, the substrate
 *  writes the pending booking synchronously (D-149 § Must Hold I-12), and
 *  this processor hands the pending booking's projection-shaped payload to
 *  the `fireReceptionWorkflow` seam → the compiled `review-then-approve`
 *  recipe fires, its `approval_required` materialize op is HELD at the D-157
 *  gate, and the Reception Inbox surfaces it for approve (editing the slot /
 *  details first) or reject.
 *
 *  **Scheduling never auto-books** (D-173 I-7). It never had an auto-accept
 *  branch; D-210 Phase C retired the one intake_form / approval_link /
 *  drop_link had, so every reception kind now matches this posture. Every
 *  booking routes through
 *  review-by-default; the local materialize runs only on the user's explicit
 *  approve, through the shared `runReceptionProjection`'s `booking` branch +
 *  the scheduling booking seam.
 *
 *  ⚠ **That materialize is a `data_booking` row and NOTHING ELSE** since D-210
 *  A.2 (slice 3b): booking ⟂ calendar — a booking is a BUSINESS record, the
 *  calendar is PERSONAL, and a reservation is never in it. Through 3a this
 *  drain projected `calendar.event` and a booking was minted beside the event;
 *  the event is gone and the booking, which owns `slot_start_at` /
 *  `slot_end_at`, is the whole record. No redundant commitment is written
 *  either (A.5) — the "what's on my plate" fusion is a READ-layer concern
 *  (internal design notes).
 *
 *  ## D-210 R-2 — TWO paths, and the pack's is the DEFAULT
 *
 *  Until R-2 there was one dispatch: the pack's compiled recipe, fired `{reactive, system}`
 *  with NO `contract_id`. So the booking flow ran with no door, no grants and no dish —
 *  everything D-207/D-209 built, structurally excluded (D-210 §3). Now the drain asks whose
 *  recipe owns the endpoint BEFORE it reaches for the pack:
 *
 *    unpaired  →  the pack's compiled `review-then-approve` recipe, exactly as before.
 *    paired    →  the OWNER's recipe, under the door's contract, receiving the booking
 *                 RECORD (`booking-record.ts`) rather than the booking projection — where
 *                 it goes next is the recipe's decision.
 *    otherwise →  HOLD. A paired endpoint we cannot run leaves its bookings pending; it
 *                 must never fall back to the pack's recipe, which would materialize a
 *                 booking through a path the owner did not choose.
 *
 *  Flow per pending booking row:
 *    1. **Past-slot guard (I-7).** A booking whose slot start is already in the
 *       past at drain time is flipped to `rejected` and
 *       NEVER dispatched (a past slot is never materialized). The materialize
 *       op re-checks at approve time too (the slot can pass while the booking
 *       sits in the inbox — `reject_if_slot_past` on the projection input),
 *       so I-7 holds across both the drain path and the approve-resume path.
 *       Unconditional on pairing — a dead slot is nobody's to materialize.
 *    2. **The endpoint's plan** (above). A `hold` leaves the row pending.
 *    3. PAIRED — open the DECLARED visitor fields, build the record, run the owner's recipe
 *       through the door. An unreadable declared field REFUSES (never run on fields you
 *       could not recover); a `failed` / `no_door` run leaves the row pending rather than
 *       `rejected`, which would free the slot the visitor believes they hold.
 *    4. DEFAULT — open the blob and read `topic` + `name` (the booking's
 *       free-text reason + who is booking) → the inbox review title.
 *       ⚠ Since 4b-ii the email is IN that plaintext (one blob, not five
 *       ciphertexts), so "never decrypted" is no longer what keeps it out of the
 *       queryable record. What keeps it out is that only two fields are READ and
 *       the payload names its fields one at a time — never a spread. Build the projection-shaped BOOKING payload (slot →
 *       `start_at`, `duration_minutes`, `timezone` for the review card;
 *       `id` + `booking_request_id` as the I-4 anchor;
 *       `reject_if_slot_past`) and dispatch the compiled recipe via
 *       `fireReceptionWorkflow`. When the seam is absent (boot phase / no
 *       reception core-pack) OR no compiled recipe is wired yet, the row stays
 *       `pending` to dispatch once the pack installs — it MUST NOT materialize
 *       as a fallback (that would auto-book, violating I-7 / I-1).
 *    5. Flip the booking to `processed` (handed off to the held op + inbox).
 *
 *  A row whose visitor PII won't decrypt is flipped to `rejected` (the
 *  encrypted row is retained for review — never silently dropped) so a poison
 *  row can't wedge the batch or retry forever. A locked vault (key getter
 *  throws) aborts the tick leaving rows `pending` to retry after unlock —
 *  identical to the intake_form / approval_link drains so a boot-time
 *  fire-immediate sweep before unlock can't lose valid bookings.
 *
 *  Spec: D-173 § D7 / N.3 / I-1 / I-6 / I-7; D-149
 *  § A.5.2 + § Must Hold I-12. */

import {
  COMMITMENT_STATEMENT_MAX,
  type SchedulingLinkConfig,
  type SchedulingLinkVisitorFieldRequirements,
} from '@recued/contracts';
import type {
  FireReceptionWorkflow,
  ReceptionDrainResult,
  ReceptionDrainTickInput,
  ReceptionSubmissionProcessor,
} from '../reception-drain.js';
import { openBookingSubmissionBlob } from '../booking-blob.js';
import { buildPairedBookingRecord } from '../booking-record.js';
import type { ReceptionSchedulingRecipePairResolution } from '../scheduling-recipe-pair.js';
import { parseSchedulingLinkConfig } from '../transformations/scheduling-link.js';
import type { ReceptionProjectionInput } from '../projection/reception-projection.js';
import { mintReceptionBookingBinding } from '../projection/reception-booking-binding.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type {
  FormSubmissionStore,
  FormSubmissionSummary,
} from '../../../storage/reception-form-store.js';

/** Narrow store slices — keeps the processor decoupled + unit-fakeable. */
export type ReceptionDrainRegistry = Pick<PublicEndpointRegistryStore, 'list'>;
/** D-210 A.8 slice 4b-ii — the MERGED store, scoped to its booking page.
 *  ⛔ `listPendingBookingsForEndpoint`, NOT `listPendingForEndpoint`: that one is
 *  INTAKE's page now (it excludes rows with a slot) and its cursor contract is
 *  the intake drain's. Handed this drain, it would return nothing, forever. */
export type ReceptionSchedulingDrainStore = Pick<
  FormSubmissionStore,
  'listPendingBookingsForEndpoint' | 'markProcessed'
>;

/** Notify seam payload — fired after a booking is dispatched to review.
 *  Unwired this phase (mirrors the intake_form / approval_link posture —
 *  NotificationBlock is engine-internal). Never throws into the drain. */
export interface ReceptionSchedulingNotice {
  readonly endpoint_id: string;
  readonly request_id: string;
  readonly kind: 'scheduling_link';
  /** The booked slot start (epoch ms) — for the booking-received alert. */
  readonly slot_start_at: number;
}

export interface SchedulingLinkProcessorDeps {
  readonly registryStore: ReceptionDrainRegistry;
  readonly bookingStore: ReceptionSchedulingDrainStore;
  /** D-210 A.8 slice 4b-ii — the FORM-submission PII key. A booking's blob is
   *  sealed with it, because a booking row IS a `reception_form_submission` row
   *  and every reader of that table opens with the form key (`booking-blob.ts`). */
  readonly getFormSubmissionPiiKey: () => Uint8Array;
  readonly now: () => number;
  /** Optional — fired after each dispatched booking. Unwired this phase. */
  readonly notify?: (notice: ReceptionSchedulingNotice) => void | Promise<void>;
  /** D-173 P4 § D7 — the review-then-approve dispatch seam. Fires the kind's compiled
   *  `review-then-approve` recipe so its `approval_required` materialize op holds at the
   *  D-157 gate → inbox.
   *
   *  ⚠ Since D-210 R-2 this is the DEFAULT path, not "the scheduling path" — what a booking
   *  becomes when the owner paired nothing. Absent (boot phase before the engine composes,
   *  or no reception core-pack installed) ⇒ a booking is left `pending` to dispatch once the
   *  recipe lands (NEVER auto-materialized as a fallback — that would auto-book, violating
   *  I-7 / I-1). */
  readonly fireReceptionWorkflow?: FireReceptionWorkflow;
  /** D-210 R-2 — resolve the endpoint's paired recipe, re-derived against the CURRENT
   *  visitor-field map + recipe. Absent ⇒ every endpoint reads unpaired ⇒ byte-identical
   *  pre-D-210 behaviour. */
  readonly resolveSchedulingRecipePair?: (input: {
    readonly endpoint_id: string;
    readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements | null;
  }) => ReceptionSchedulingRecipePairResolution;
  /** D-210 R-2 — the paired run. See `RunPairedBooking`. */
  readonly runPairedBooking?: RunPairedBooking;
}

/** D-210 R-2 — the outcome of running the OWNER's paired recipe for one booking.
 *
 *  Mirrors `ReceptionRunOutcome` without importing it: this port stays free of
 *  engine/recipes imports under Must Hold I-12, so the seam is typed here and the server
 *  boundary satisfies it. */
export type PairedBookingRunOutcome =
  | { readonly kind: 'completed' }
  /** Durably PAUSED at the D-157 gate → the Reception Inbox. Queued, not failed — the same
   *  place the pack's default lands its `approval_required` materialize. */
  | { readonly kind: 'held' }
  | { readonly kind: 'failed'; readonly errors: readonly unknown[] }
  /** The pair has no minted door contract, so nothing may run under it. */
  | { readonly kind: 'no_door' };

/** D-210 R-2 — run one booking through the endpoint's OWN paired recipe, under the door's
 *  contract (`{ channel: 'reception', actor: 'anonymous', reception_id, contract_id }`).
 *  Absent ⇒ no paired path is wired, and a paired endpoint's bookings HOLD rather than
 *  falling to the pack's default. */
export type RunPairedBooking = (input: {
  readonly endpoint_id: string;
  readonly request_id: string;
  /** The booking record, `context.reception_submission`-shaped (see `booking-record.ts`). */
  readonly record: Record<string, unknown>;
}) => Promise<PairedBookingRunOutcome>;

const clamp = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** Deterministic projection id for a booking — and since D-210 A.2 (slice 3b)
 *  the I-4 IDEMPOTENCY ANCHOR itself, not merely an audit convenience.
 *
 *  ⚠ It used to be neither: the calendar branch keyed idempotency on the
 *  reception row's `resolved_calendar_event_id` and ignored this id entirely.
 *  With the event gone, the booking row IS the anchor and this is its primary
 *  key — the seam pre-reads exactly this id to decide whether an approve has
 *  already materialized. Changing the derivation would make a re-approve mint a
 *  SECOND booking for one slot. */
const receptionIdForBooking = (request_id: string): string => `reception_${request_id}`;

/** Build the calendar event's summary from the visitor's free-text. The
 *  TOPIC (the booking reason) is what the user wants to read — exactly as
 *  intake_form / approval_link project visitor free-text into the entity.
 *  The slot time is NOT inlined here — it rides `start_at` / `end_at` (the
 *  event's time frame). The visitor EMAIL is deliberately absent. */
const buildBookingStatement = (visitorName: string, topic: string): string => {
  const name = visitorName.trim();
  const reason = topic.trim();
  if (name.length > 0) {
    return reason.length > 0 ? `Booking with ${name} — ${reason}` : `Booking with ${name}`;
  }
  return reason.length > 0 ? `Booking — ${reason}` : 'Booking request';
};

/** The optional booking-received alert. Shared by the default and paired paths: both have
 *  handed the booking off at this point, and the visitor is owed the same notice either way.
 *  A seam failure must never undo the already-committed dispatch. */
const fireNotify = async (
  deps: SchedulingLinkProcessorDeps,
  endpoint_id: string,
  row: Pick<FormSubmissionSummary, 'submission_id'>,
  /** ⛔ Passed EXPLICITLY rather than re-read off the row. The loop already
   *  refused a slot-less row, but that narrowing does not survive into this
   *  function — and the alternative spelling (`row.slot?.start_at ?? 0`) would
   *  fabricate a 1970 timestamp for a visitor-facing notice on a path the type
   *  system thinks is reachable. Take the value the caller has already proven. */
  slot_start_at: number,
): Promise<void> => {
  if (!deps.notify) return;
  try {
    await deps.notify({
      endpoint_id,
      request_id: row.submission_id,
      kind: 'scheduling_link',
      slot_start_at,
    });
  } catch (e) {
    console.warn('[d-149] scheduling_link notify seam failed', e);
  }
};

/** D-210 R-2 — what this endpoint's pending bookings are about to become.
 *
 *  Three outcomes, and the third is why this is a closed union rather than a boolean: a
 *  paired endpoint we cannot run has to HOLD, and a hold must never be reachable by falling
 *  through a `!paired` test. Every uncertain path names itself. */
type EndpointDispatchPlan =
  /** No pair — the pack's compiled `review-then-approve` recipe, exactly as before D-210. */
  | { readonly kind: 'default' }
  /** The owner's recipe, under the door's contract. Both the visitor-field map the record is
   *  built from and the run seam are CAPTURED here, so the row loop cannot re-resolve them
   *  into a different answer than the one this plan was decided on. */
  | {
      readonly kind: 'paired';
      readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
      readonly run: RunPairedBooking;
    }
  /** Paired, but not runnable. Leave the bookings pending; `reason` says why. */
  | { readonly kind: 'hold'; readonly reason: string };

const resolveEndpointDispatchPlan = (
  deps: SchedulingLinkProcessorDeps,
  endpoint_id: string,
  config: SchedulingLinkConfig | null,
): EndpointDispatchPlan => {
  // Unwired (boot phase / a deployment with no pair substrate) ⇒ every endpoint reads
  // unpaired ⇒ byte-identical pre-D-210 behaviour.
  if (deps.resolveSchedulingRecipePair === undefined) return { kind: 'default' };
  const resolution = deps.resolveSchedulingRecipePair({
    endpoint_id,
    required_visitor_fields: config?.required_visitor_fields ?? null,
  });
  if (resolution.kind === 'unpaired') return { kind: 'default' };
  if (resolution.kind === 'stale') {
    // The stored binding no longer matches its sources: an edited recipe, an edited
    // visitor-field map, an unparseable config, a corrupt row, or a FORM pair sitting on a
    // scheduling endpoint. All one state — re-bind and it dispatches.
    return { kind: 'hold', reason: 'the paired recipe is stale (re-bind it)' };
  }
  if (config === null) {
    // Unreachable via the resolver, which answers `stale` for a null config on a paired
    // endpoint. Kept as a hold rather than an assertion because if the two ever disagreed,
    // the alternative is the pack's default running on an endpoint the owner paired.
    return { kind: 'hold', reason: 'paired, but its config does not parse' };
  }
  if (deps.runPairedBooking === undefined) {
    return { kind: 'hold', reason: 'paired, but no paired-run seam is wired yet' };
  }
  return {
    kind: 'paired',
    required_visitor_fields: config.required_visitor_fields,
    run: deps.runPairedBooking,
  };
};

export const createSchedulingLinkSubmissionProcessor = (
  deps: SchedulingLinkProcessorDeps,
): ReceptionSubmissionProcessor => ({
  label: 'scheduling_link',
  drainOnce: async ({ now, limit }: ReceptionDrainTickInput): Promise<ReceptionDrainResult> => {
    let processed = 0;
    let failed = 0;
    let budget = limit;

    // Lazy + once-per-tick key resolution. A locked / uninitialised FileVault
    // makes the getter throw — that MUST NOT mark rows failed (it would lose
    // valid bookings on the boot fire-immediate sweep before unlock). On
    // key-unavailable the whole tick aborts, leaving rows pending to retry
    // after unlock. Per-row decrypt failures below (valid key, tampered
    // ciphertext) are the only permanent rejected path.
    let keyResolved = false;
    let piiKey: Uint8Array | null = null;
    const resolveKey = (): Uint8Array | null => {
      if (!keyResolved) {
        keyResolved = true;
        try {
          piiKey = deps.getFormSubmissionPiiKey();
        } catch (e) {
          console.warn(
            '[d-149] scheduling_link drain: booking-PII key unavailable (vault locked?) — leaving bookings pending',
            e,
          );
          piiKey = null;
        }
      }
      return piiKey;
    };

    // ALL scheduling_link endpoints — including disabled AND revoked. A
    // booking accepted while the endpoint was live is valid received data and
    // must still process even if the user later disabled / revoked the
    // endpoint (revocation stops FUTURE access; it doesn't retroact
    // already-accepted rows, which would strand them pending forever).
    const endpoints = deps.registryStore.list({ kind: 'scheduling_link', include_revoked: true });

    for (const endpoint of endpoints) {
      if (budget <= 0) break;
      const pending = deps.bookingStore.listPendingBookingsForEndpoint(endpoint.endpoint_id, budget);
      if (pending.length === 0) continue;

      // The config supplies the event `timezone` (availability window tz); a
      // corrupt blob does NOT fail the booking (the slot + visitor PII are on
      // the row itself, and the projection is fixed — always a calendar event).
      // A null config falls back to `'UTC'` at the payload build below.
      const config = parseSchedulingLinkConfig(endpoint.metadata);

      // ── D-210 R-2 — whose recipe owns this endpoint's bookings? ─────────────────────
      //
      // Decided ONCE per endpoint (the pair is per-endpoint; the rows below share it), as
      // one closed plan rather than a condition re-asked per row. This is where
      // `PACK_SLUG_FOR_KIND` is DEMOTED: the compiled default is what a booking becomes when
      // the owner paired NOTHING, not "the scheduling path". When the owner HAS paired a
      // recipe it runs under the door's contract — the whole of what R-2 fixes (D-210 §3:
      // the booking flow was structurally excluded from everything D-207/D-209 built).
      //
      // ⛔ NOT `rowOwesDefaultDispatch`. That helper's rule is INTAKE's — "the SUBMIT path
      // already ran the owner's recipe, so firing the default too would materialize a SECOND
      // artifact". Scheduling has no submit-time run (D-173 I-7: it never auto-books, so
      // there is nothing truthful to render inline), the drain is its only dispatch, and
      // `reception_booking_request` carries no `pair_binding` column for the helper to read.
      // Handed a booking it would answer `true` unconditionally — a constant wearing the
      // shape of a decision.
      const plan = resolveEndpointDispatchPlan(deps, endpoint.endpoint_id, config);
      if (plan.kind === 'hold') {
        // Logged ONCE per endpoint rather than per row — the cause is the endpoint's, and a
        // backlog would otherwise repeat it every tick per booking.
        console.warn(
          `[d-210] scheduling_link endpoint '${endpoint.endpoint_id}': ${plan.reason} — `
          + `${pending.length} booking(s) held pending`,
        );
      }

      for (const row of pending) {
        if (budget <= 0) break;

        // 0. D-210 A.8 slice 4b-ii — a booking row without a slot cannot exist:
        // the store DERIVES the kind from the slot and this page filters on
        // `slot_start_at IS NOT NULL`. Refused rather than asserted because the
        // alternative is dispatching a booking whose time is unknown — and left
        // PENDING rather than `rejected`, since a row this store should not have
        // produced is a substrate fault, not the visitor's.
        if (row.slot === null) {
          console.warn(
            `[d-210] scheduling_link row ${row.submission_id} has no slot on the booking page — left pending`,
          );
          continue;
        }

        // 1. Past-slot guard (I-7) — a booking whose slot is already in the
        // past is rejected, never dispatched (never auto-books a dead slot).
        // `<=` treats a slot starting exactly now as past.
        //
        // ⚠ This no longer "frees the slot" — the comment used to say so, and
        // three like it did too. `hasOverlappingBooking` was deleted with the
        // capacity-1 hardcode, so NOTHING reads this outcome mechanically any
        // more; it is a display state. Capacity is the owner's judgment at the
        // D-157 gate (D-173 D7).
        if (row.slot.start_at <= now) {
          deps.bookingStore.markProcessed({ submission_id: row.submission_id, outcome: 'rejected' });
          processed += 1;
          budget -= 1;
          continue;
        }

        // 2. D-210 R-2 — a paired endpoint we cannot run HOLDS. Leave the booking PENDING
        // (budget unspent); it dispatches once the owner re-binds / confirms the door.
        //
        // ⛔ A hold is never the default. The endpoint IS paired; running the pack's recipe
        // instead would materialize a calendar event through a path the owner did not
        // choose, and silently — the exact substitution the binding exists to prevent.
        //
        // ⚠ AFTER the past-slot guard, deliberately. I-7 is not conditional on pairing: a
        // dead slot is never materialized by anyone, and holding it instead would keep the
        // row pending forever — retrying every tick and occupying a slot (only `rejected`
        // frees one) that has already passed.
        if (plan.kind === 'hold') continue;

        const key = resolveKey();
        if (!key) {
          // Vault locked / key unavailable — abort the tick. Remaining rows
          // stay pending for the next cycle after unlock.
          return { processed, failed };
        }

        try {
          // ── D-210 R-2 — the PAIRED path: the owner's recipe, under the door ──────────
          //
          // Its own payload, and that is the point rather than an accident. The default's
          // payload below is a calendar PROJECTION — the pack materialize op's args — with
          // the visitor's email, phone and notes deliberately never decrypted. The owner
          // ruled the v3 digest subject on the reasoning that flipping `phone` to `omit`
          // means "a recipe reading it gets null"; a recipe reading `phone` off the calendar
          // payload gets null WHATEVER the config says, so on that payload the digest would
          // guard nothing. The record carries what the pair promised.
          if (plan.kind === 'paired') {
            const built = await buildPairedBookingRecord({
              key,
              endpoint_id: endpoint.endpoint_id,
              row,
              required_visitor_fields: plan.required_visitor_fields,
              timezone: config?.available_window_definition?.tz ?? 'UTC',
            });
            if (built.kind === 'unreadable') {
              // A DECLARED field's ciphertext would not open (rotated key, tampered row) —
              // distinct from the `null` ciphertext of an optional field left blank, which
              // the record carries through as `null`. Never run a recipe on fields we could
              // not recover: it would read the blank and write it.
              //
              // `rejected`, matching the tick's existing poison-row posture.
              // ⚠ This no longer FREES anything — `hasOverlappingBooking` was
              // deleted with the capacity-1 hardcode, so no query reads this
              // outcome. It is a terminal display state.
              console.warn(
                `[d-210] scheduling_link booking ${row.submission_id} has unreadable visitor fields — refusing the paired run`,
              );
              deps.bookingStore.markProcessed({ submission_id: row.submission_id, outcome: 'rejected' });
              failed += 1;
              budget -= 1;
              continue;
            }
            // ⛔ A THROW IS NOT A MODELLED OUTCOME, AND IT MUST NOT BECOME A TERMINAL ONE.
            //
            // `plan.run` reaches `handleExecute`, which THROWS rather than returning for a
            // request-shape problem — `recipe_not_found`, `assertRunTargets`, or anything the
            // engine's catch-all re-raises. Nothing between here and there converts that into
            // `{kind:'failed'}`: the `runPairedBooking` wrapper has no try/catch and the runner
            // awaits `handleExecute` bare. So a throw used to escape to the tick's outer catch,
            // which marks the row `rejected` — and `markProcessed` REFUSES `pending`, so that
            // is TERMINAL. The booking was never re-drained.
            //
            // That is the exact inverse of the branch immediately below, and of §3a.2's
            // "DRIFT ⇒ HOLD, never the default" / "⚠ Never `rejected` on those paths". The
            // DEFAULT arm already gets this right for the identical throw
            // (`wire-reception-workflow-dispatch.ts`: "a throw here is a request-shape problem
            // … Leave the row pending to retry rather than lose it"); the paired arm inverted it.
            //
            // Collapsing the throw into `failed` routes it through the SAME already-correct
            // handling — left pending, retryable once the owner fixes the recipe — rather than
            // adding a second policy that could drift from it. `unreadable` above keeps its
            // explicit `rejected`: that is a MODELLED, provably unrecoverable poison row
            // (a declared field's ciphertext will not open), not an owner-fixable bug.
            //
            // Found by the D-210 code audit 2026-07-20 (finding 2).
            let outcome: PairedBookingRunOutcome;
            try {
              outcome = await plan.run({
                endpoint_id: endpoint.endpoint_id,
                request_id: row.submission_id,
                record: built.record,
              });
            } catch (e) {
              outcome = { kind: 'failed', errors: [e] };
            }
            // `held` is the ordinary steady state, not an error: the D-209 ceiling pins an
            // anonymous reception actor to `read`, so the recipe's writes hold at the gate
            // and land in the Inbox. Both it and `completed` mean the row is HANDED OFF.
            if (outcome.kind !== 'held' && outcome.kind !== 'completed') {
              // `failed` (the recipe ran and broke) or `no_door` (the owner has not
              // confirmed the door). Leave PENDING — both are the owner's to fix, and the
              // retry succeeds once they do.
              //
              // ⛔ NOT `rejected`: a booking the OWNER's recipe failed on is not the
              // visitor's fault, and a terminal state here would end a reservation
              // the visitor believes they hold over a bug the owner can fix.
              console.warn(
                `[d-210] scheduling_link booking ${row.submission_id} paired run '${outcome.kind}' — left pending`,
                outcome.kind === 'failed' ? outcome.errors : undefined,
              );
              continue;
            }
            deps.bookingStore.markProcessed({ submission_id: row.submission_id, outcome: 'processed' });
            processed += 1;
            budget -= 1;
            await fireNotify(deps, endpoint.endpoint_id, row, row.slot.start_at);
            continue;
          }

          // Decrypt the visitor's topic + name (the booking's free-text reason
          // + who is booking) for the review title.
          //
          // ⚠ D-210 A.8 slice 4b-ii — the five ciphertexts are ONE blob now, so
          // this opens everything to read two fields. The EMAIL invariant is
          // therefore no longer enforced by NOT DECRYPTING it: the address is
          // in the plaintext here. What still holds it out of the queryable
          // record is that only `topic` + `name` are READ below — the blob
          // stays a local, and the payload names its fields one at a time.
          // ⛔ Do not "simplify" by spreading `fields` into the payload.
          const fields = await openBookingSubmissionBlob({
            key,
            endpoint_id: endpoint.endpoint_id,
            submission_id: row.submission_id,
            ciphertext: row.submission_blob_encrypted,
          });
          const topic = fields.topic ?? '';
          const visitorName = fields.name ?? '';

          const statement = clamp(buildBookingStatement(visitorName, topic), COMMITMENT_STATEMENT_MAX);

          // The projection-shaped BOOKING payload (D-210 A.2 — booking ⟂
          // calendar: a reservation materializes a `data_booking` row and NO
          // calendar event; a booking is a business record, the calendar is
          // personal). Through 3a this said `'calendar.event'` and the booking
          // was minted beside the event it created.
          //
          // ⚠ `start_at` / `duration_minutes` are both review content and the
          // agreed slot passed to the mint. They may be owner-edited at the gate;
          // the sealed reservation keeps the visitor's original ask separately.
          // `timezone` remains review-only. `reject_if_slot_past` re-guards I-7
          // at the approve-time materialize.
          //
          // `id` is the DETERMINISTIC booking id and `booking_request_id` the
          // reservation it came from — together the I-4 anchor (the seam
          // pre-reads the row it would write). The visitor email is absent
          // (sealed).
          const bookingId = receptionIdForBooking(row.submission_id);
          const bookingPayload: ReceptionProjectionInput = {
            top_tier_kind: 'booking',
            id: bookingId,
            // `title` is review copy only; the booking mint resolves the
            // owner-authored endpoint title server-side. `body` stays absent.
            title: statement,
            start_at: row.slot.start_at,
            duration_minutes: row.slot.duration_minutes,
            timezone: config?.available_window_definition?.tz ?? 'UTC',
            booking_request_id: row.submission_id,
            // The drain is the authority that derives both ids. Bind the pair
            // here so a direct/future caller of reception-materialize cannot
            // select an unrelated sealed reservation and booking id.
            booking_binding: mintReceptionBookingBinding(key, {
              booking_request_id: row.submission_id,
              booking_id: bookingId,
            }),
            reject_if_slot_past: true,
          };

          // Review-by-default — the ONLY path (scheduling never auto-books,
          // I-7). Dispatch the compiled `review-then-approve` workflow so the
          // materialize op is HELD at the D-157 gate → inbox. The processor
          // does NOT materialize here (no ambient warehouse write — I-1); the
            // booking materializes only on the user's explicit approve.
          if (!deps.fireReceptionWorkflow) {
            // No dispatch seam (boot phase / no reception core-pack). Leave
            // PENDING (budget unspent) — valid undispatched review work, not a
            // poison row; it dispatches once the recipe installs. It MUST NOT
            // materialize as a fallback (I-1 / I-7).
            continue;
          }
          const fired = await deps.fireReceptionWorkflow({
            kind: 'scheduling_link',
            // Spread to a plain record — the seam's payload is
            // `Record<string, unknown>`; the closed `ReceptionProjectionInput`
            // has no index signature.
            payload: { ...bookingPayload },
            source_ref: row.submission_id,
            endpoint_id: endpoint.endpoint_id,
          });
          if (!fired.dispatched) {
            // Seam couldn't fire (no compiled recipe). Leave PENDING to retry —
            // never materialize as a fallback (I-1 / I-7).
            continue;
          }

          // Handed off to review-then-approve — mark processed so the drain
          // never re-dispatches it (the held op + inbox own the lifecycle now).
          // `resolved_calendar_event_id` / `resolved_booking_id` stay null:
          // nothing is materialized until the user approves. On approve the
          // booking seam mints the row and fills `resolved_booking_id`;
          // `resolved_calendar_event_id` now stays null FOREVER on this path
          // (A.2 — a reservation materializes no calendar event).
          deps.bookingStore.markProcessed({ submission_id: row.submission_id, outcome: 'processed' });
          processed += 1;
          budget -= 1;

          await fireNotify(deps, endpoint.endpoint_id, row, row.slot.start_at);
        } catch (e) {
          console.warn(
            `[d-149] scheduling_link booking ${row.submission_id} processing failed`,
            e,
          );
          deps.bookingStore.markProcessed({ submission_id: row.submission_id, outcome: 'rejected' });
          failed += 1;
          budget -= 1;
        }
      }
    }

    return { processed, failed };
  },
});
