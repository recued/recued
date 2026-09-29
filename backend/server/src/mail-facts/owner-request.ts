/**
 * D-315 slice 2 — requests the owner sends to their own server (§7.4, ruling 38).
 *
 * The owner emails `me+remind@…`, or CCs that address on a thread. Recognizing
 * it needs no template and no AI; a trigger routes it by its tag. The entrance
 * is two things together:
 *
 *   - **the provider's own record that this account sent it** — Gmail's SENT
 *     label, IMAP's Sent folder, Graph's sentitems. Never From, which anyone can
 *     write, and never the stored direction, which trusts a From equal to the
 *     account. Only someone holding the account can add to what it sent;
 *   - **a recipient that is the account's own address with a `+tag`.** A
 *     mailbox without plus addressing cannot carry a tag, so it sends none.
 *
 * The identity is the RFC message id: a message sent to oneself can be stored
 * twice, the Sent copy and the delivered one, and it is one request. Mail
 * Recued sends itself never reaches here (the ingest skips it by its
 * reconciliation id), so a reply in the thread cannot become a request.
 */

import type { MailFactBuiltinTypeId } from '@recued/contracts';

import type { MailFactSourceEmail } from './rules-pass.js';

/** What the ingest knows about an email beyond its content. */
export interface MailFactEnvelope {
  readonly slug: string;
  /** The account's own address; `''` when the mailbox does not know it. */
  readonly account_email: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** The provider's own record that this account sent the message. */
  readonly sent_by_account: boolean;
  /** A stored copy the mailbox keeps as sent — its direction as stored, which
   *  a From equal to the account also sets: enough to leave it out as sent
   *  mail is left out, never to take it for a request (§7.4). */
  readonly stored_as_sent?: boolean;
  /** The RFC 5322 Message-ID without angle brackets; `null` when absent. */
  readonly rfc_message_id: string | null;
  readonly thread_id: string;
}

/** Mail the account sent, as far as leaving it out goes: the provider's own
 *  record, or a stored copy kept as sent. Only the first makes a request. */
export const readAsSent = (envelope: MailFactEnvelope): boolean =>
  envelope.sent_by_account || envelope.stored_as_sent === true;

/** A standards reading: the owner-request fact before its kind checks. */
export interface OwnerRequestRead {
  readonly type: Extract<MailFactBuiltinTypeId, 'owner_request'>;
  readonly values: { readonly tag: string; readonly message_id: string };
  readonly data: Readonly<Record<string, unknown>>;
}

const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The request text kept on the fact; longer text is cut, and says so, so the
 *  fact's data never goes over its cap and is dropped whole. */
export const OWNER_REQUEST_TEXT_MAX = 16_000;

/** `M.e+Remind@GoogleMail.com` → `{ local: 'me', tag: 'remind', domain: 'gmail.com' }`.
 *  Gmail ignores dots in the local part and treats googlemail.com as gmail.com. */
const splitAddress = (address: string): { local: string; tag: string | null; domain: string } | null => {
  const angled = /<([^<>]+)>/.exec(address);
  const bare = (angled?.[1] ?? address).trim().toLowerCase();
  const at = bare.lastIndexOf('@');
  if (at <= 0 || at === bare.length - 1) return null;
  let local = bare.slice(0, at);
  let domain = bare.slice(at + 1);
  const plus = local.indexOf('+');
  const tag = plus >= 0 ? local.slice(plus + 1) : null;
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return { local, tag, domain };
};

export const recognizeOwnerRequest = (
  email: MailFactSourceEmail,
  envelope: MailFactEnvelope,
): OwnerRequestRead | null => {
  if (!envelope.sent_by_account || envelope.rfc_message_id === null) return null;
  const account = splitAddress(envelope.account_email);
  if (account === null || account.tag !== null) return null;
  const taggedIn = (addresses: readonly string[]): string | undefined => {
    for (const address of addresses) {
      const parts = splitAddress(address);
      if (parts === null || parts.tag === null) continue;
      if (parts.local !== account.local || parts.domain !== account.domain) continue;
      if (TAG_RE.test(parts.tag)) return parts.tag;
    }
    return undefined;
  };
  const toTag = taggedIn(envelope.to);
  const tag = toTag ?? taggedIn(envelope.cc);
  if (tag === undefined) return null;
  const text = email.body_text.trim();
  return {
    type: 'owner_request',
    values: { tag, message_id: envelope.rfc_message_id },
    data: {
      subject: email.subject,
      request: text.length > OWNER_REQUEST_TEXT_MAX ? text.slice(0, OWNER_REQUEST_TEXT_MAX) : text,
      ...(text.length > OWNER_REQUEST_TEXT_MAX ? { request_truncated: true } : {}),
      // CC'd onto a thread: the thread is where the request is about. A pointer,
      // not a copy — a recipe reads it with the thread reader when it needs it.
      ...(toTag === undefined ? { thread: { slug: envelope.slug, thread_id: envelope.thread_id } } : {}),
    },
  };
};
