/** D-145 PA7 — compose-state → `collection.mail.send` payload.
 *
 *  Pure conversion from compose dialog values into the `collection.mail.send`
 *  rpc input shape. Encapsulates:
 *
 *    1. Recipient ref → email-address resolution via a host-supplied
 *       `resolveContactEmail` hook (lets the substrate stay free of
 *       contact-graph IO; the host wires the resolver against
 *       `data.contact.<email>`).
 *    2. Substrate-level validators (`to` non-empty, subject non-empty,
 *       body non-empty, sender_source non-empty + send_capable, no
 *       sender ≠ self-send-loop on `to`).
 *    3. Sender-source send-capability gate via a host-supplied
 *       `findSenderSource` lookup (returns the matching
 *       `MailSenderSourceOption` so the gate runs against fresh state
 *       not the snapshot the dialog opened from).
 *
 *  Returns either `{ ok: true; payload }` (caller dispatches) or
 *  `{ ok: false; errors }` (caller paints inline errors). The structured
 *  errors map matches the field names on `MailComposeValues` so the
 *  PA5 form-renderer's inline-error rendering picks them up directly.
 *
 *  Spec: docs/d-145-spec.md § A.5.3 (Send dispatch). */

import { MAIL_MESSAGE_SUBJECT_MAX } from '../mail.js';
import type { MailComposeValues, MailSenderSourceOption } from './types.js';

/** Output of `composeStateToSendPayload`. The success branch carries
 *  the rpc's input verbatim; the failure branch carries an
 *  errors-by-field map the dialog renders inline. */
export type ComposeDispatchResult =
  | { ok: true; payload: ComposeMailSendPayload }
  | { ok: false; errors: Readonly<Record<string, string>> };

/** Mirrors the `collection.mail.send` rpc input from D-127 — the dispatch
 *  helper produces this shape so the host can hand it off to the rpc
 *  unchanged. Body is sent as `body_text`; PA7 doesn't ship rich-text
 *  composition (substrate stays text-only at this phase). */
export interface ComposeMailSendPayload {
  /** `data.mail.<slug>` instance the rpc dispatches against — sourced
   *  from `MailSenderSourceOption.mail_instance_slug`, NOT derived
   *  from the Source id. */
  instance: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string;
  references?: string[];
  /** D-172 P2 — `data.file` record-id refs to attach. The rpc resolves
   *  each through the Gateway-gated `file.read` into bytes before the
   *  provider send. Omitted when the user selected no files. */
  attachments?: string[];
}

/** Hooks the dispatch helper needs from the host. */
export interface ComposeDispatchHooks {
  /** Resolve a recipient ref (contact id, contact email, raw email) to
   *  an email address suitable for the SMTP `To:` / `Cc:` / `Bcc:`
   *  headers. Returns `null` when the ref doesn't resolve — the
   *  dispatch helper surfaces an error keyed on the field name (`to`
   *  / `cc` / `bcc`). */
  resolveContactEmail: (ref: string) => string | null;
  /** Look up the `MailSenderSourceOption` keyed on the value's
   *  `sender_source` id. Returns `null` when the Source is gone (race
   *  with disconnect / uninstall) — the dispatch helper surfaces a
   *  `sender_source` error. */
  findSenderSource: (id: string) => MailSenderSourceOption | null;
}

/** Normalize an email address for the self-loop guard — trim outer
 *  whitespace + lowercase. RFC 5321 leaves the local-part case-
 *  significant, but virtually every mail provider normalizes; the
 *  guard is a UX gate (don't bother sending mail to yourself), not a
 *  cryptographic identity check, so the case-insensitive comparison
 *  catches the realistic edge cases. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Pure (modulo the supplied resolver): values + hooks → dispatch result. */
export const composeStateToSendPayload = (
  values: MailComposeValues,
  hooks: ComposeDispatchHooks,
): ComposeDispatchResult => {
  const errors: Record<string, string> = {};

  // sender_source — must resolve + must be send_capable.
  let senderOption: MailSenderSourceOption | null = null;
  if (values.sender_source.trim().length === 0) {
    errors.sender_source = 'Choose a Source to send from.';
  } else {
    senderOption = hooks.findSenderSource(values.sender_source);
    if (senderOption === null) {
      errors.sender_source =
        'Sender Source not found — pick a connected mail Source.';
    } else if (senderOption.send_capable !== true) {
      errors.sender_source =
        'Sender Source is not configured for outbound send.';
    } else if (senderOption.mail_instance_slug.trim().length === 0) {
      errors.sender_source =
        'Sender Source is missing a mail-instance slug — re-enroll the mail Source.';
    }
  }

  // Subject — required, non-empty, ≤ MAIL_MESSAGE_SUBJECT_MAX.
  const subject = values.subject.trim();
  if (subject.length === 0) {
    errors.subject = 'Subject is required.';
  } else if (subject.length > MAIL_MESSAGE_SUBJECT_MAX) {
    errors.subject = `Subject exceeds ${MAIL_MESSAGE_SUBJECT_MAX} characters.`;
  }

  // Body — required, non-empty.
  const body = values.body.trim();
  if (body.length === 0) errors.body = 'Body is required.';

  // D-172 P2 — attachments are supported. The user-selected `data.file`
  // record-id refs flow into the payload verbatim; the rpc layer
  // (`MailCollection.send`) resolves each through the Gateway-gated
  // `file.read` into bytes before the provider send, dropping + warning
  // any over-cap file (never silently — D-172 I-6). No substrate-side
  // rejection: the schema slot is now live.

  // Recipients — `to` must have ≥ 1 resolved address. Resolution
  // failures across `to` / `cc` / `bcc` are aggregated separately so the
  // user sees per-field guidance.
  const resolvedTo: string[] = [];
  for (const ref of values.to) {
    const email = hooks.resolveContactEmail(ref);
    if (email === null) {
      errors.to = `Recipient '${ref}' is not in the contact graph.`;
      break;
    }
    resolvedTo.push(email);
  }
  if (errors.to === undefined && resolvedTo.length === 0) {
    errors.to = 'At least one recipient is required.';
  }

  const resolvedCc: string[] = [];
  for (const ref of values.cc) {
    const email = hooks.resolveContactEmail(ref);
    if (email === null) {
      errors.cc = `Cc recipient '${ref}' is not in the contact graph.`;
      break;
    }
    resolvedCc.push(email);
  }

  const resolvedBcc: string[] = [];
  for (const ref of values.bcc) {
    const email = hooks.resolveContactEmail(ref);
    if (email === null) {
      errors.bcc = `Bcc recipient '${ref}' is not in the contact graph.`;
      break;
    }
    resolvedBcc.push(email);
  }

  // Self-loop guard on `to` only (cc/bcc-self allowed for archival per
  // D-127 § P1.3). Runs only when sender resolved + `to` has at least
  // one resolved entry that didn't already error. Email comparison is
  // case-insensitive + whitespace-trimmed — provider-side normalization
  // makes "Alice@Example.com" and "alice@example.com" the same address
  // for the self-loop UX gate.
  if (
    senderOption !== null &&
    senderOption.send_capable === true &&
    errors.to === undefined
  ) {
    const senderNormalized = normalizeEmail(senderOption.account_email);
    const matchesSelf = resolvedTo.some(
      (addr) => normalizeEmail(addr) === senderNormalized,
    );
    if (matchesSelf) {
      errors.to =
        'Sending to yourself on `To:` is blocked — use Bcc to archive a copy.';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  // All gates passed — emit payload.
  if (senderOption === null) {
    // Should never happen — both branches above set errors.sender_source
    // when senderOption stays null. Keeps the type narrowing happy.
    return {
      ok: false,
      errors: { sender_source: 'Sender Source could not be resolved.' },
    };
  }
  const payload: ComposeMailSendPayload = {
    instance: senderOption.mail_instance_slug,
    to: resolvedTo,
    subject,
    body_text: body,
  };
  if (resolvedCc.length > 0) payload.cc = resolvedCc;
  if (resolvedBcc.length > 0) payload.bcc = resolvedBcc;
  if (values.in_reply_to !== null) payload.in_reply_to = values.in_reply_to;
  // D-172 P2 — carry the selected attachment refs into the payload.
  if (values.attachments.length > 0) payload.attachments = [...values.attachments];
  return { ok: true, payload };
};
