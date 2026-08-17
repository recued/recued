/** D-210 Appendix B — `reception.manage.mint`: the owner mints an on-the-go
 *  reschedule link for one booking.
 *
 *  Reserved admin-only rpc, like every other `reception.*` method (the whole
 *  prefix is in `MCP_RESERVED_RPC_PREFIXES`, so this surface is paired-client-
 *  only by construction and implies no grant work).
 *
 *  ## What it does
 *
 *  ⚠ D-210 audit finding 17 — THIS HEADER DESCRIBES THE PRE-A.2 DESIGN AND IS
 *  WRONG. The implementation below takes a `booking_id` and reads the booking's
 *  own `reception_record_id`; the `scheduled-from` link was DELETED in A.2 and
 *  `booking.resolved_calendar_event_id` no longer exists. Kept visible rather
 *  than quietly rewritten because this is exactly the kind of site that would
 *  talk a future change into re-wiring reception to a calendar.
 *
 *  ~~Given a local calendar event id, it walks the `scheduled-from` link back to
 *  the booking that produced the event, then issues a single-use, short-TTL
 *  manage credential scoped to that booking. The result is the RELATIVE link
 *  path (`/reception/manage/<secret>`); the webclient prepends its own origin,
 *  because a WS rpc has no request Host and `getShareBaseUrl` throws on a LAN
 *  host (the owner's "no host constraint — LAN benefits" ruling).
 *
 *  ## Only a BOOKING event can be minted
 *
 *  The credential is scoped to a booking record — the manage handler resolves
 *  the reschedule target from `booking.resolved_calendar_event_id`, so the whole
 *  surface exists to move a booking's event (and notify the visitor on the close
 *  half). A manual calendar event has no booking behind it: the walk finds no
 *  `scheduled-from` link and the mint refuses. Manual events reschedule at-desk
 *  via R-4.
 *
 *  Modelled on `reception-record-handler.ts`. Spec: D-210 Appendix B. */

import type {
  ReceptionManageMintInput,
  ReceptionManageMintResult,
} from '@recued/contracts';

import type { ReceptionManageCredentialStore } from './storage/reception-manage-credential-store.js';
import type { FormSubmissionStore, FormSubmissionSummary } from './storage/reception-form-store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import { RECEPTION_MANAGE_PATH } from './ports/reception/handlers/manage.js';

export class ReceptionManageMintRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ReceptionManageMintRpcError';
  }
}

export interface ReceptionManageMintDeps {
  readonly getCredentialStore: () => ReceptionManageCredentialStore;
  /** Read the `data_booking` row — for its `reception_record_id`, the pointer
   *  back to the reservation. The SAME hop the notify-booking-visitor
   *  dispatcher makes. */
  readonly readBooking: WorkEntityStore['readBooking'];
  readonly getBookingStore: () => Pick<FormSubmissionStore, 'findById'>;
  readonly now: () => number;
}

/** ⛔ The same gate every other `reception.*` method applies. The reserved prefix
 *  keeps this off MCP, but that is a CHANNEL fence, not an actor one — an
 *  unregistered connection on the paired transport is still a caller. Minting a
 *  reschedule link is an owner action; it answers to a paired admin or to nobody. */
const requireAdmin = (
  caller: { instance_id?: string | null | undefined } | undefined,
  method: string,
): void => {
  if (!caller?.instance_id) {
    throw new ReceptionManageMintRpcError(
      'permission_denied',
      `${method}: requires a paired admin client (D-121); dispatched from an unregistered connection`,
      403,
    );
  }
};

export const handleReceptionManageMint = async (
  deps: ReceptionManageMintDeps,
  args: ReceptionManageMintInput | undefined,
  caller: { instance_id?: string | null | undefined } | undefined,
): Promise<ReceptionManageMintResult> => {
  const method = 'reception.manage.mint';
  requireAdmin(caller, method);

  const booking_id = args?.booking_id;
  if (typeof booking_id !== 'string' || booking_id.length === 0) {
    throw new ReceptionManageMintRpcError(
      'reception_manage_invalid',
      `${method}: booking_id must be a non-empty string`,
      400,
    );
  }

  // 1. Read the booking and follow its own provenance column to the
  //    reservation. No `reception_record_id` ⇒ the owner (or an intake) created
  //    this booking, so there is no visitor to hand a manage link to.
  const entity = deps.readBooking(booking_id);
  if (!entity) {
    throw new ReceptionManageMintRpcError(
      'booking_not_found',
      `${method}: booking '${booking_id}' does not exist`,
      404,
    );
  }
  const request_id = entity.reception_record_id;
  if (typeof request_id !== 'string' || request_id.length === 0) {
    throw new ReceptionManageMintRpcError(
      'no_booking',
      `${method}: booking '${booking_id}' did not come from a visitor request — only reception bookings can be rescheduled on the go`,
      404,
    );
  }

  const booking: FormSubmissionSummary | null = deps.getBookingStore().findById(request_id);
  if (!booking) {
    throw new ReceptionManageMintRpcError(
      'booking_not_found',
      `${method}: the reservation behind '${booking_id}' no longer exists`,
      404,
    );
  }

  const issued = deps.getCredentialStore().issue({
    kind: 'scheduling_link',
    endpoint_id: booking.endpoint_id,
    record_id: booking.submission_id,
    // D-240 — the OWNER capability. This rpc is `requireAdmin`-gated and the
    // link it returns authorizes a reschedule, so it must never be mintable as
    // the visitor-facing `lookup` purpose the submit path issues.
    purpose: 'manage',
    now: deps.now(),
  });

  return {
    manage_path: `${RECEPTION_MANAGE_PATH}/${issued.secret}`,
    expires_at: issued.expires_at,
  };
};

/** The rpc slice. ⛔ Returns `undefined` when the deps are absent so the method is
 *  simply not registered on a db-less / manage-disabled boot — the same posture as
 *  the record + inbox slices. */
export const makeReceptionManageMintHandlers = <C extends { instance_id?: string | null }>(
  deps: ReceptionManageMintDeps | undefined,
):
  | {
      methods: ReadonlyArray<'reception.manage.mint'>;
      handlers: {
        'reception.manage.mint': (
          args: ReceptionManageMintInput,
          client: C | undefined,
        ) => Promise<ReceptionManageMintResult>;
      };
    }
  | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['reception.manage.mint'],
    handlers: {
      'reception.manage.mint': async (args, client) =>
        handleReceptionManageMint(
          deps,
          args,
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
