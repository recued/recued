/** D-210 §7 — notify a booking's visitor server-side.
 *
 *  The close half of the reschedule surface: the audit trail proves the owner
 *  moved the booking; it does not prove the VISITOR was told, which §7 names as
 *  the actual dispute. This seam is what tells them.
 *
 *  ## Why the recipient is resolved here, not authored by the recipe
 *
 *  A booking visitor's email is SEALED (`visitor_email_encrypted`, AEAD-
 *  bound to the row, opened only by the reception sub-DEK). The whole point
 *  of D-210's model is that the recipe acting on a booking is governed by a
 *  door contract — and a recipe (possibly with a tainted AI step) must never
 *  hold the visitor's PII. So the recipe names the BOOKING (an id it already
 *  has) + the owner's own sender + the message; this
 *  dispatcher walks the booking chain, opens ONLY the address, sends, and
 *  returns `{ notified }` — the email is NEVER an input and NEVER a return
 *  value (owner ruling 2026-07-17: resolved server-side at send-time).
 *
 *  ## The chain (all built by D-210 step 3 + earlier)
 *
 *    calendar:<source_id>
 *      ──(inbound `scheduled-from` link, target-queryable via `link_to_idx`)──►
 *    reception_form_submission:<booking_id>
 *      ──(`findById`)──► the sealed row
 *      ──(`openFormSubmissionField('visitor_email')`)──► the address
 *      ──(`mailSend`)──► the visitor
 *
 *  ## Outcomes vs errors — kept distinct on purpose
 *
 *  A `{ notified: false, reason }` return is a BUSINESS outcome: there is
 *  legitimately no-one to notify (the event did not come from a booking, the
 *  row is gone, or the visitor gave no email). A SEND failure is a different
 *  category — there IS a recipient and the delivery did not confirm — so it
 *  PROPAGATES (preserving the error CODE so a mid-send crash still records
 *  `in_doubt` rather than inviting a blind double-send). ⛔ But the reused
 *  mail-send path embeds the recipient in some error messages/details (the
 *  self-loop guard; provider bounces), and the recipient here is the SEALED
 *  visitor address — so the error is re-thrown with the address SCRUBBED
 *  (`scrubSendError`): the code survives, the message/details never carry the
 *  email. A locked FileVault likewise throws (the key derivation refuses).
 *  Callers dedup on the notified:true return, so a thrown send retries next
 *  tick without double-delivering.
 *
 *  ⚠ Model-facing surface: the `notify-booking-visitor` manifest description
 *  is logged in `docs/chat-prompt-optimization-log.md` (2026-07-17). This
 *  module is the server-side dispatcher behind it.
 *
 *  Spec: docs/d-210-spec.md §7. */

import { IngredientError } from '@recued/ingredients';

import { openFormSubmissionField } from './form-pii.js';
import type { FormSubmissionSummary } from '../../storage/reception-form-store.js';
import type { WorkEntityStore } from '../../storage/work-entity-store.js';

/** The dispatcher input, mirrored from the kernel `notify-booking-visitor`
 *  slot (`KernelDispatchers['notifyBookingVisitor']`). No recipient field —
 *  by construction. */
export interface NotifyBookingVisitorInput {
  /** The `data.booking` row to notify about. ⚠ Was `event_source_id` (a
   *  calendar event id) until D-210 A.2 — a reservation has no calendar event
   *  to name any more. */
  readonly booking_id: string;
  /** A registered send-capable `data.mail.<name>` account — the owner's own
   *  sender, not PII. */
  readonly sender_mail_instance: string;
  readonly subject: string;
  readonly body: string;
  readonly body_format?: 'text' | 'html';
  readonly recipe_id?: string;
  readonly step_id?: string;
}

/** Coarse business outcomes — never the address.
 *
 *  `not_a_reception_booking` when the booking did not come from a visitor
 *  request at all (the owner entered it by hand, or an intake wrote it), so
 *  there is no sealed visitor to reach; `booking_not_found` when the booking or
 *  its reservation row is gone; `no_visitor_email` when the visitor
 *  legitimately gave none.
 *
 *  ⚠ `not_a_reception_booking` REPLACED `no_booking_link` in slice 3b. The old
 *  name described the mechanism (an absent `scheduled-from` edge) rather than
 *  the fact, and that mechanism no longer exists — keeping it would have left a
 *  model-facing string naming a link nothing writes. */
export type NotifyBookingVisitorReason =
  | 'not_a_reception_booking'
  | 'booking_not_found'
  | 'no_visitor_email';

export type NotifyBookingVisitorResult =
  | { readonly notified: true }
  | { readonly notified: false; readonly reason: NotifyBookingVisitorReason };

/** The narrow send shape this seam needs from the mail-send dispatcher — a
 *  subset of `KernelDispatchers['mailSend']`'s input. Injected so the whole
 *  send path (capability check, sender ≠ recipient guard, `mail_send` audit)
 *  is reused rather than re-implemented, and so the module is testable with a
 *  spy. The rich return is deliberately `unknown` — this seam reports only
 *  `notified`. */
export type NotifyBookingVisitorMailSend = (input: {
  instance: string;
  to: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  recipe_id?: string;
  step_id?: string;
}) => Promise<unknown>;

export interface NotifyBookingVisitorDeps {
  /** Read the `data_booking` row — for its `reception_record_id`, the pointer
   *  back to the sealed reservation. Replaces the `scheduled-from` link walk
   *  (see the chain in the header). */
  readonly readBooking: WorkEntityStore['readBooking'];
  /** Load the full reservation row (carrying the sealed ciphertext) by
   *  `request_id`. Server-side store only — never an rpc/MCP surface. */
  readonly findBooking: (request_id: string) => FormSubmissionSummary | null;
  /** Derive the booking-PII AEAD key from the reception sub-DEK. THROWS
   *  (FileVault locked / KeyManager uninitialised) rather than returning a
   *  usable key — a locked vault must fail the send, not silently no-op. */
  readonly getFormSubmissionPiiKey: () => Uint8Array;
  /** The shared mail-send path. Errors PROPAGATE (see the file header). */
  readonly mailSend: NotifyBookingVisitorMailSend;
}

/** Re-throw a send failure with the sealed recipient SCRUBBED. The reused
 *  mail-send path embeds the visitor address in some errors (the self-loop
 *  guard `MAIL_SEND_SELF_LOOP_TO`; provider bounce messages carrying the
 *  address) — and a thrown step error flows into recipe step-state, which the
 *  sealed visitor address must NEVER reach. The error CODE is preserved (so
 *  downstream in-doubt / classification keying survives) with a fixed message
 *  and minimal, recipient-free details. */
const scrubSendError = (err: unknown): IngredientError => {
  const code =
    err instanceof IngredientError
      ? err.code
      : err !== null
          && typeof err === 'object'
          && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'NOTIFY_BOOKING_VISITOR_SEND_FAILED';
  return new IngredientError(
    code,
    `notify-booking-visitor: send to the booking visitor failed (${code})`,
    { slug: 'notify-booking-visitor' },
  );
};

export const handleNotifyBookingVisitor = async (
  deps: NotifyBookingVisitorDeps,
  input: NotifyBookingVisitorInput,
): Promise<NotifyBookingVisitorResult> => {
  // 1. Read the booking and follow its own provenance column back to the
  //    reservation. A booking with no `reception_record_id` is a legitimate
  //    record that simply did not come from a visitor — there is nobody sealed
  //    behind it to notify, which is an OUTCOME, not an error.
  const booking = deps.readBooking(input.booking_id);
  if (!booking) {
    return { notified: false, reason: 'booking_not_found' };
  }
  const request_id = booking.reception_record_id;
  if (typeof request_id !== 'string' || request_id.length === 0) {
    return { notified: false, reason: 'not_a_reception_booking' };
  }

  // 2. Load the sealed reservation row (server-side; carries the ciphertext).
  const row = deps.findBooking(request_id);
  if (!row) {
    return { notified: false, reason: 'booking_not_found' };
  }

  // 3. Open ONLY the visitor's email, at send-time, inside the substrate. A
  //    null ciphertext = an optional field the visitor left blank ⇒ no address,
  //    no send (not an error). It THROWS on an unopenable ciphertext (rotated
  //    key / tampered row); that propagates — a provenance tamper must surface,
  //    never quietly send nowhere.
  //
  //    ⚠ D-210 A.8 slice 4b-ii — the FORM key, and still its OWN column. The
  //    address is also inside `submission_blob_encrypted`, but reading it from
  //    the dedicated column is what keeps this path from unsealing the
  //    visitor's whole submission to send one email (§ A.5.3).
  const email = await openFormSubmissionField({
    key: deps.getFormSubmissionPiiKey(),
    endpoint_id: row.endpoint_id,
    submission_id: row.submission_id,
    field: 'visitor_email',
    ciphertext: row.visitor_email_encrypted,
  });
  if (email === null || email.length === 0) {
    return { notified: false, reason: 'no_visitor_email' };
  }

  // 4. Delegate to the shared send path. The resolved address is the `to`;
  //    it never returns to the caller (the seam reports only `notified`).
  const sendInput: Parameters<NotifyBookingVisitorMailSend>[0] = {
    instance: input.sender_mail_instance,
    to: [email],
    subject: input.subject,
    body_text: input.body_format === 'html' ? '' : input.body,
  };
  if (input.body_format === 'html') sendInput.body_html = input.body;
  if (input.recipe_id !== undefined) sendInput.recipe_id = input.recipe_id;
  if (input.step_id !== undefined) sendInput.step_id = input.step_id;
  try {
    await deps.mailSend(sendInput);
  } catch (err) {
    // The sealed visitor address must not leak into recipe step-state via a
    // send error's message/details — re-throw with it scrubbed (code kept).
    throw scrubSendError(err);
  }

  return { notified: true };
};
