/** D-210 Appendix B — the held-reschedule runner for the `/reception/manage` door.
 *
 *  The on-the-go equivalent of the R-4 at-desk reschedule, but run through the
 *  D-207 anonymous door instead of an owner session — because a public
 *  possession-based link is NOT owner identity (there is no `user_self` without
 *  a paired client token). So the move runs as `actor: 'anonymous'`, which the
 *  D-209 ceiling pins to `read`, and the `core.data.calendar.update` write
 *  therefore SURFACES: it holds at the D-157 gate and lands in the Reception
 *  Inbox for the owner to approve (approach A). That is the honest provenance —
 *  origin `anonymous` (the link), owner-approved — and it lands in the SAME
 *  inbox as bookings; conflating this with a `system`/`user_self` run would make
 *  the audit lie about who moved the booking.
 *
 *  ## The target comes from the CREDENTIAL, the new time from the FORM
 *
 *  `calendar_slug` + `event_source_id` are resolved SERVER-SIDE from the manage
 *  credential (owner-minted, scoped to one record); only `new_start_at` /
 *  `new_end_at` come from the visitor's slot pick. So a link holder can only
 *  move the ONE booking the credential names — never retarget another. And it
 *  holds for the owner's approval regardless.
 *
 *  ## Why the recipe is `reschedule-calendar-event-managed` (no output)
 *
 *  `bindReceptionDoor` refuses a door whose recipe renders `output.render` AND
 *  writes: an anonymous write holds and returns no output, so the visitor would
 *  get a bare page. This runner's handler owns the response (the held page), so
 *  the recipe renders nothing — the `-managed` variant exists for exactly this.
 *
 *  Modelled on `reception-recipe-runner.ts`; the difference is per-REQUEST
 *  config (a specific booking, not a dish overlay) and a fixed reception id.
 *
 *  Spec: D-210 Appendix B. */

import {
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';

import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import {
  buildReceptionContractSnapshot,
  grantedOperationsFor,
} from './reception-contract-snapshot.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

/** The pseudo reception-id the manage door dispatches under — a dedicated path,
 *  NOT one of the six endpoint kinds (mirrors `__seller_claim__`). The door
 *  contract is bound to this id at boot. */
export const RECEPTION_MANAGE_RECEPTION_ID = '__manage__' as const;

/** The recipe the manage door runs — the no-`output.render` reschedule variant.
 *  ⚠ Renamed from `reschedule-calendar-event-managed` in D-210 A.2 (slice 3b):
 *  it moves the BOOKING now, not a calendar event. */
export const RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID = 'reschedule-booking-managed' as const;

export interface ReceptionManageRescheduleInput {
  /** Resolved SERVER-SIDE from the credential — never from the form. */
  readonly calendar_slug: string;
  /** The `data.booking` row to move. ⚠ Was `event_source_id` until D-210 A.2 —
   *  a reservation has no calendar event. */
  readonly booking_id: string;
  /** The visitor's chosen new time (unix ms); `new_end_at` = start + the
   *  booking's current duration, computed by the handler. */
  readonly new_start_at: number;
  readonly new_end_at: number;
  /** Idempotency anchor — a re-drive of the same credential collapses onto one
   *  run rather than re-firing. */
  readonly credential_id: string;
}

export type ReceptionManageRunOutcome =
  /** Durably PAUSED — at the D-157 gate (`awaiting_approval`, the owner approves in
   *  the Inbox) or on a peer's answer (`awaiting_peer`, D-234 § 234.4, which no
   *  owner affordance resolves). Queued, not failed either way: this is the honest
   *  success the manage page reports, because what it claims — "your change is
   *  recorded and will be applied" — is true of both. */
  | { readonly kind: 'held' }
  /** Ran to completion without a hold — rare (only if the owner has a policy
   *  that admits an anonymous write, which the D-209 ceiling normally forbids). */
  | { readonly kind: 'completed' }
  /** The run failed — the reschedule did not hold and did not complete. */
  | { readonly kind: 'failed'; readonly errors: unknown[] }
  /** The manage door contract is not seeded (boot not complete / recipe not
   *  installed). Without it every op hard-denies (`PUBLIC_CONTRACT_ID` floor),
   *  so detect it up front rather than manufacture a failed run. */
  | { readonly kind: 'no_door' };

export interface ReceptionManageRunnerDeps {
  readonly executeDeps: ExecuteHandlerDeps;
  readonly definitionStore: ContractDefinitionStore;
  /** Resolve the manage door's minted contract id — `resolveReceptionDoorContractId(RECEPTION_MANAGE_RECEPTION_ID)`.
   *  `null` ⇒ no door yet ⇒ the run must not proceed. */
  readonly resolveContractId: () => string | null;
  readonly now: () => number;
}

export type ReceptionManageRescheduleRunner = {
  run(input: ReceptionManageRescheduleInput): Promise<ReceptionManageRunOutcome>;
};

/** Derive the door's tool allowlist from its own stored scope — the SAME
 *  derivation the mint wrote its grant rows from, so ACCESS and TOOL axes can
 *  never disagree. */
const allowedToolsFor = (
  definitionStore: ContractDefinitionStore,
): ((contractId: string) => readonly string[]) => (contractId) =>
  definitionStore.get(contractId)?.scope?.ingredient_ids ?? [];

export const createReceptionManageRescheduleRunner = (
  deps: ReceptionManageRunnerDeps,
): ReceptionManageRescheduleRunner => ({
  async run(input: ReceptionManageRescheduleInput): Promise<ReceptionManageRunOutcome> {
    const contract_id = deps.resolveContractId();
    if (contract_id === null) return { kind: 'no_door' };

    // Identity stays `anonymous` — the truth about a possession-based link. The
    // contract_id carries the authority (what ops the door may reach); identity
    // carries WHO (a link holder, not the owner). Keeping them distinct is what
    // makes the warehouse honest about who moved the event.
    const execution_source: ExecutionSource = {
      channel: 'reception',
      actor: 'anonymous',
      reception_id: RECEPTION_MANAGE_RECEPTION_ID,
      contract_id,
    };

    // NOT optional: a contract-bearing source with no snapshot THROWS at
    // `evaluatePreflightAdmission`. A revoked door yields an EMPTY allowlist,
    // denying every dispatch — a live kill-switch over the already-public link.
    const contract_snapshot: ContractSnapshot = buildReceptionContractSnapshot(
      execution_source,
      {
        definitionStore: deps.definitionStore,
        allowedTools: allowedToolsFor(deps.definitionStore),
        grantedOperations: grantedOperationsFor(deps.definitionStore),
        now: deps.now,
      },
    );

    // Config is passed EXPLICITLY — `handleExecute` only merges a dish overlay
    // for a run with no run_id, and we pass one (idempotency). The TARGET is the
    // credential's; only the new time is the visitor's.
    //
    // ⛔ EVERY KEY HERE MUST BE DECLARED BY THE RECIPE (D-222 Slice A). `config`
    // is now declaration-bounded at the execute boundary, so a key absent from
    // `reschedule-booking-managed`'s `variables` refuses the whole run as
    // `undeclared_config_argument` (400) — for a VISITOR, on the one flow this
    // runner exists to serve. `calendar_slug` used to be passed here and was
    // never declared or read: the recipe addresses the booking by
    // `{{config.booking_id}}` alone.
    //
    // ⚠ `calendar_slug` is now VESTIGIAL on the whole seam — it stays on
    // `ReceptionManageRescheduleInput` and on `ReceptionManageRescheduleRun` only
    // because those shapes and `d-210-reception-manage-handler` still name it. It
    // has no consumer. Do NOT re-add it here to "use" it;
    // `d-222-reception-manage-config-declared` fails if you do. Retiring the
    // field through the handler seam + its `calendarSlug` dep is a separate
    // cleanup.
    const result = await handleExecute(
      deps.executeDeps,
      {
        recipe_id: RECEPTION_MANAGE_RESCHEDULE_RECIPE_ID,
        config: {
          booking_id: input.booking_id,
          new_start_at: input.new_start_at,
          new_end_at: input.new_end_at,
        },
        trigger_source: 'reception',
        execution_source,
        contract_snapshot,
      },
      { run_id: `reception:manage:${input.credential_id}` },
    );

    if (!result.success) {
      // D-234 § 234.4 — both holds, for the reason spelled out in
      // `reception-recipe-runner.ts`: this site decides what the VISITOR is told, and a peer
      // hold is exactly as durable as an approval one. The two runners are the same rule
      // block, so they move together — a fix to one and not the other would leave the manage
      // door reporting a live run as failed.
      if (result.awaiting_approval === true || result.awaiting_peer === true) {
        return { kind: 'held' };
      }
      return { kind: 'failed', errors: result.errors };
    }
    return { kind: 'completed' };
  },
});
