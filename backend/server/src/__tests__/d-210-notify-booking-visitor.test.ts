/** D-210 §7 — the `notify-booking-visitor` server-side dispatcher.
 *
 *  Drives the REAL chain the op composes, with the REAL visitor-PII crypto
 *  (`sealFormSubmissionField` → `openFormSubmissionField` — the FORM key since
 *  D-210 A.8 slice 4b-ii, because the reservation IS a `reception_form_submission`
 *  row) so the decrypt round-trips for real. Only `mailSend` is a spy (we assert
 *  delivery, we do not send).
 *
 *  ⚠ The chain was RE-ANCHORED in D-210 A.2 (slice 3b): it started at a
 *  `calendar:<source_id>` and walked an inbound `scheduled-from` edge to reach
 *  the reservation. A booking is never in the calendar now, so it starts at the
 *  booking and follows its own `reception_record_id`. The two cases that pinned
 *  the walk's role + from-collection FILTERS went with the walk — they guarded a
 *  dead-lane hazard that a column read cannot have. What they were really
 *  protecting is kept below as `not_a_reception_booking`: only a booking that
 *  came from a visitor request notifies anyone.
 *
 *  What each test PROVES (assert the OUTCOME, never a hollow seam):
 *   - the resolved visitor address reaches `mailSend.to`, and NEVER the result;
 *   - business no-ops (not-a-reception-booking / no row / no email) return a
 *     coarse reason and do NOT send; a tampered/rotated ciphertext PROPAGATES
 *     (never a silent send-nowhere);
 *   - the op joins OUTBOUND_SEND_INGREDIENT_SLUGS so it lifts to the D-157 gate. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { isOutboundSendSlug } from '@recued/contracts';

import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import {
  handleNotifyBookingVisitor,
  type NotifyBookingVisitorDeps,
  type NotifyBookingVisitorMailSend,
} from '../ports/reception/notify-booking-visitor.js';
import type { FormSubmissionSummary } from '../storage/reception-form-store.js';
import type { Booking } from '@recued/contracts';

const ENDPOINT_ID = 'ep-1';
const VISITOR_EMAIL = 'visitor@example.com';
const SENDER = 'owner@own.example';

const subDekA = new Uint8Array(32).fill(9);
const subDekB = new Uint8Array(32).fill(4); // a DIFFERENT reception sub-DEK
const keyA = deriveFormSubmissionPiiKeyFromSubDek(subDekA);
const keyB = deriveFormSubmissionPiiKeyFromSubDek(subDekB);

let mailSend: Mock<NotifyBookingVisitorMailSend>;
const bookings = new Map<string, FormSubmissionSummary>();
/** The `data_booking` rows the dispatcher reads — keyed on booking id. */
const entities = new Map<string, Booking>();

/** A booking row carrying (or deliberately NOT carrying) the provenance
 *  pointer. `reception_record_id` absent = a booking the owner entered by hand:
 *  no sealed visitor behind it, so nobody to notify. */
const seedEntity = (booking_id: string, reception_record_id?: string): void => {
  entities.set(booking_id, {
    id: booking_id,
    title: 'Booking',
    lifecycle_state: 'confirmed',
    source_id: 'recued.booking',
    ...(reception_record_id !== undefined ? { reception_record_id } : {}),
  } as Booking);
};

/** A booking row carrying a REAL sealed email (or a null address when
 *  `plaintext` is null), keyed under `request_id`. */
const seedBooking = async (
  request_id: string,
  plaintext: string | null,
): Promise<void> => {
  const ciphertext = await sealFormSubmissionField({
    key: keyA,
    endpoint_id: ENDPOINT_ID,
    submission_id: request_id,
    field: 'visitor_email',
    plaintext,
  });
  bookings.set(request_id, {
    submission_id: request_id,
    endpoint_id: ENDPOINT_ID,
    // D-210 A.8 slice 4b-ii — a booking has no form definition, and its `slot`
    // is what makes it a booking rather than an intake.
    form_definition_id: null,
    submitted_at: 1,
    source_ip_hash: null,
    visitor_email_encrypted: ciphertext,
    // ⚠ A PLACEHOLDER, deliberately unopenable. The address lives in the blob
    // too, but this dispatcher must read it from the dedicated column — that is
    // what keeps a send from unsealing the visitor's whole submission (§ A.5.3).
    // A path that reached for the blob would throw here rather than pass.
    submission_blob_encrypted: 'AQID',
    schema_version: 1,
    record_kind: 'booking',
    slot: { start_at: 0, end_at: 0, duration_minutes: 30 },
    processing_outcome: 'pending',
    resolved_target_kind: null,
    resolved_target_id: null,
    pair_binding: null,
    metadata: {},
  });
};

const deps = (over: Partial<NotifyBookingVisitorDeps> = {}): NotifyBookingVisitorDeps => ({
  readBooking: (id) => entities.get(id) ?? null,
  findBooking: (id) => bookings.get(id) ?? null,
  getFormSubmissionPiiKey: () => keyA,
  mailSend,
  ...over,
});

beforeEach(() => {
  mailSend = vi.fn<NotifyBookingVisitorMailSend>()
    .mockResolvedValue({ source_id: 's', message_id: 'm', sent_at: 1 });
  bookings.clear();
  entities.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D-210 §7 — notify-booking-visitor dispatcher', () => {
  it('walks the scheduled-from link, opens the sealed email, and sends to it', async () => {
    await seedBooking('req-1', VISITOR_EMAIL);
    seedEntity('bk-1', 'req-1');

    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-1',
      sender_mail_instance: SENDER,
      subject: 'Your appointment moved',
      body: 'It is now 4pm.',
    });

    expect(result).toEqual({ notified: true });
    expect(mailSend).toHaveBeenCalledTimes(1);
    const sent = mailSend.mock.calls[0][0];
    // The OUTCOME: the resolved visitor address is the recipient.
    expect(sent.to).toEqual([VISITOR_EMAIL]);
    expect(sent.instance).toBe(SENDER);
    expect(sent.subject).toBe('Your appointment moved');
    expect(sent.body_text).toBe('It is now 4pm.');
  });

  it('NEVER returns the visitor address to the caller', async () => {
    await seedBooking('req-1', VISITOR_EMAIL);
    seedEntity('bk-1', 'req-1');

    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-1',
      sender_mail_instance: SENDER,
      subject: 's',
      body: 'b',
    });

    // The seal must never leak through the result — the whole point of
    // server-side resolution. `notified` + nothing else.
    expect(JSON.stringify(result)).not.toContain(VISITOR_EMAIL);
    expect(result).toEqual({ notified: true });
  });

  it('html body_format routes to body_html with an empty body_text', async () => {
    await seedBooking('req-1', VISITOR_EMAIL);
    seedEntity('bk-1', 'req-1');

    await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-1',
      sender_mail_instance: SENDER,
      subject: 's',
      body: '<p>moved</p>',
      body_format: 'html',
    });

    const sent = mailSend.mock.calls[0][0];
    expect(sent.body_html).toBe('<p>moved</p>');
    expect(sent.body_text).toBe('');
  });

  it('booking_not_found — no such booking row → no send', async () => {
    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-lonely',
      sender_mail_instance: SENDER,
      subject: 's',
      body: 'b',
    });
    expect(result).toEqual({ notified: false, reason: 'booking_not_found' });
    expect(mailSend).not.toHaveBeenCalled();
  });

  it('⛔ PROVENANCE is load-bearing — a booking the owner entered by hand does not notify', async () => {
    // The guarantee the two retired link-FILTER cases were really protecting:
    // only a booking that came from a visitor request has anyone sealed behind
    // it. A hand-entered booking (or one an intake wrote) carries no
    // `reception_record_id`, and mailing whoever the reservation table happens
    // to hold under that id would be a send to the wrong person.
    seedEntity('bk-manual'); // NO reception_record_id
    await seedBooking('req-1', VISITOR_EMAIL); // a reservation exists, unrelated

    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-manual',
      sender_mail_instance: SENDER,
      subject: 's',
      body: 'b',
    });
    expect(result).toEqual({ notified: false, reason: 'not_a_reception_booking' });
    expect(mailSend).not.toHaveBeenCalled();
  });

  it('booking_not_found — the linked booking row is gone → no send', async () => {
    seedEntity('bk-1', 'req-missing');
    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-1',
      sender_mail_instance: SENDER,
      subject: 's',
      body: 'b',
    });
    expect(result).toEqual({ notified: false, reason: 'booking_not_found' });
    expect(mailSend).not.toHaveBeenCalled();
  });

  it('no_visitor_email — the visitor gave no address → no send', async () => {
    await seedBooking('req-1', null); // sealed email is null
    seedEntity('bk-1', 'req-1');
    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-1',
      sender_mail_instance: SENDER,
      subject: 's',
      body: 'b',
    });
    expect(result).toEqual({ notified: false, reason: 'no_visitor_email' });
    expect(mailSend).not.toHaveBeenCalled();
  });

  it('a tampered / rotated ciphertext PROPAGATES rather than sending nowhere', async () => {
    await seedBooking('req-1', VISITOR_EMAIL); // sealed under keyA
    seedEntity('bk-1', 'req-1');
    // never swallow into `no_visitor_email` (a business outcome) and never send.
    await expect(
      handleNotifyBookingVisitor(deps({ getFormSubmissionPiiKey: () => keyB }), {
        booking_id: 'bk-1',
        sender_mail_instance: SENDER,
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow();
    expect(mailSend).not.toHaveBeenCalled();
  });

  it('a send failure PROPAGATES but SCRUBS the sealed address, keeping the code', async () => {
    await seedBooking('req-1', VISITOR_EMAIL);
    seedEntity('bk-1', 'req-1');
    // guard, provider bounce). The sealed visitor address must NEVER reach the
    // caller — but the CODE must survive for in-doubt / classification keying.
    const leaky = new Error(
      `This recipe is configured to send mail to itself (${VISITOR_EMAIL})`,
    ) as Error & { code?: string; details?: unknown };
    leaky.code = 'MAIL_SEND_SELF_LOOP_TO';
    leaky.details = { offending: VISITOR_EMAIL };
    mailSend.mockRejectedValueOnce(leaky);

    let thrown: unknown;
    try {
      await handleNotifyBookingVisitor(deps(), {
        booking_id: 'bk-1',
        sender_mail_instance: SENDER,
        subject: 's',
        body: 'b',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The address appears NOWHERE — not in the message, not in any detail.
    const serialized =
      `${(thrown as Error).message} ${JSON.stringify((thrown as { details?: unknown }).details ?? {})}`;
    expect(serialized).not.toContain(VISITOR_EMAIL);
    // …but the original code is preserved.
    expect((thrown as { code?: string }).code).toBe('MAIL_SEND_SELF_LOOP_TO');
  });
});

describe('D-210 §7 — notify-booking-visitor is an outbound send', () => {
  it('joins OUTBOUND_SEND_INGREDIENT_SLUGS so it lifts to the D-157 gate', () => {
    // Governance: the recipient is sealed, but delivery is still an
    // irreversible external send. It must lift exactly like mail-send.
    expect(isOutboundSendSlug('notify-booking-visitor')).toBe(true);
    // The core alias must lift identically (no bypass via the prefix).
    expect(isOutboundSendSlug('core-notify-booking-visitor')).toBe(true);
  });
});

/** D-210 code audit, finding 3b. */
describe('D-210 finding 3b — the sealed recipient is kept out of the audit row', () => {
  it('declares `redact_audit_recipients` on every send it makes', async () => {
    // This seam already scrubs the address from step state, from the output, and
    // from send errors. The `mail_send` audit row was the one remaining escape:
    // a booking notice has exactly ONE recipient, so it always fell under the
    // noise-redaction threshold and the address was attached in plaintext.
    //
    // Asserting the REQUEST, not a downstream effect — the flag is what this seam
    // is responsible for; that the flag actually suppresses the row is pinned
    // against the real collection + audit store in the D-127 audit suite.
    // ⇒ [[a_defaulted_field_is_not_evidence]]
    await seedBooking('req-1', VISITOR_EMAIL);
    seedEntity('bk-1', 'req-1');

    const result = await handleNotifyBookingVisitor(deps(), {
      booking_id: 'bk-1',
      sender_mail_instance: SENDER,
      subject: 'Your appointment moved',
      body: 'It is now 4pm.',
    });

    expect(result).toEqual({ notified: true });
    const sent = mailSend.mock.calls[0][0];
    expect(sent.redact_audit_recipients).toBe(true);
  });
});
