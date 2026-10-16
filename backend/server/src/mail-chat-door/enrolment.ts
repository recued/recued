/** D-318 step 8 — proof (b): the email that enrols an address Recued does not
 *  read.
 *
 *  The owner adds the address in Settings and Recued shows a code. The owner
 *  sends an email from that address to the chat mailbox with the code in it
 *  (§4.2, P13). Only the owner sees the code, so the email shows they can send
 *  as the address. It also lands the way every later request from the address
 *  will, so the stamp on it says who checks that mail: the chat mailbox
 *  provider's authserv-id. Every later request from the address must carry a
 *  passing check from that same provider (`sent-proof.ts`). ⚠ The provider, not
 *  the host: many name each receiving host (`mx1.messagingengine.com`,
 *  `mx2.…`), so the stamp's name is compared by its organisation
 *  (`mailChatCheckerOrg`).
 *
 *  ⛔ THE CHECKER MUST BE THE CHAT MAILBOX'S PROVIDER, AND IS PINNED HERE. Only
 *  the first stamp is read, and on a server that stamps nothing the first one
 *  is whatever the sender put there. The owner's real D-318 sample carries one
 *  from the SENDER'S OWN relay: `relay.firm.example; spf=pass
 *  smtp.mailfrom=sender@firm.example`, an SPF pass for its own domain, sitting
 *  below Zoho's. So the checker must fit the chat mailbox's provider:
 *    - Gmail's stamp names itself `mx.google.com`.
 *    - Microsoft's names nobody, and a Graph mailbox's mail always carries one.
 *    - Any other provider (IMAP) names itself, never inside the sending
 *      address's own organisation: a stamp named there is the sender's own
 *      mail server's. The one exception is a chat mailbox whose address is in
 *      that organisation too, where one provider holds both.
 *  ⚠ What is left: an IMAP chat mailbox whose server stamps nothing, while the
 *  owner's own mail passes a server named outside its domain that stamps a pass
 *  for it. That stamp would be pinned, and a forger could plant it.
 *
 *  An email from a pending address that carries no code is just mail: the door
 *  reads it as any other. One with a wrong code in its subject counts toward
 *  the limit. The code is spent once its email arrives, pass or fail, so a code
 *  someone read in the chat mailbox cannot be tried again.
 *
 *  Spec: D-318 §4.2, §8 step 8. */

import {
  MAIL_CHAT_ENROL_CODE_LENGTH,
  mailChatCheckerOrg,
  type MailChatEnrolFailure,
  type MailChatEnrolledSender,
} from '@recued/contracts';

import { senderCheckFor, type SenderCheck } from '../collections/mail/authentication-results.js';
import type { MailProviderKind } from '../collections/mail/provider.js';
import type { MailChatEnrolOutcome } from '../storage/mail-chat-door-store.js';
import { mailChatHtmlToText } from './html-text.js';

/** The authserv-id Gmail's own stamp carries. */
export const GMAIL_AUTHSERV_ID = 'mx.google.com';

/** The chat mailbox, as the checker must fit it. */
export interface MailChatEnrolChat {
  /** Its provider. Unknown is read as IMAP's rules, the strictest that still
   *  lets a stamping server through. */
  readonly provider_kind: MailProviderKind | undefined;
  /** Its own address, bare. */
  readonly address: string;
}

/** The parts of the email the enrolment reads. */
export interface MailChatEnrolEmail {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html?: string;
  /** Its From, bare and lower case. */
  readonly from_address: string;
  /** The first `Authentication-Results` stamp. */
  readonly authentication_results: string | undefined;
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** A code-shaped number in a subject: what a try looks like. */
const CODE_SHAPED = new RegExp(`(?<!\\d)\\d{${MAIL_CHAT_ENROL_CODE_LENGTH}}(?!\\d)`);

/** Does the text hold the code as a whole number? */
const holds = (text: string | undefined, code: string): boolean =>
  text !== undefined && text !== '' && new RegExp(`(?<!\\d)${code}(?!\\d)`).test(text);

/** Does a stamp's writer fit the chat mailbox's provider (above)? */
export const mailChatCheckerFits = (stamped_by: string, domain: string, chat: MailChatEnrolChat): boolean => {
  if (chat.provider_kind === 'gmail') return stamped_by === GMAIL_AUTHSERV_ID;
  if (chat.provider_kind === 'graph') return stamped_by === '';
  if (stamped_by === '') return false;
  const checker = mailChatCheckerOrg(stamped_by);
  return checker !== mailChatCheckerOrg(domain) || checker === mailChatCheckerOrg(domainOf(chat.address));
};

/** Is a request's stamp by the provider the address was enrolled with? */
export const mailChatSameChecker = (stamped_by: string | null, checked_by: string | null): boolean =>
  stamped_by !== null && checked_by !== null && mailChatCheckerOrg(stamped_by) === mailChatCheckerOrg(checked_by);

/** Why a stamp cannot confirm an address, or `null` when it can. */
export const mailChatEnrolFailure = (
  check: SenderCheck,
  domain: string,
  chat: MailChatEnrolChat,
): MailChatEnrolFailure | null => {
  if (check.stamped_by === null) return 'no_check';
  if (!mailChatCheckerFits(check.stamped_by, domain, chat)) return 'foreign_check';
  if (check.result === 'fail') return 'failed_check';
  if (check.result !== 'pass') return 'no_pass';
  return null;
};

/** What one email from a PENDING address comes to, or `null` when it carries
 *  no code at all: then it is mail, and the door reads it as any other. */
export const mailChatEnrolOutcome = (
  email: MailChatEnrolEmail,
  sender: MailChatEnrolledSender,
  chat: MailChatEnrolChat,
): MailChatEnrolOutcome | null => {
  const code = sender.code;
  if (sender.state !== 'pending' || code === null) return null;
  const carries = holds(email.subject, code) || holds(email.body_text, code)
    || (email.body_html !== undefined && email.body_html !== '' && holds(mailChatHtmlToText(email.body_html), code));
  if (!carries) return CODE_SHAPED.test(email.subject) ? { kind: 'wrong_code' } : null;
  const domain = domainOf(email.from_address);
  const check = senderCheckFor(email.authentication_results, domain);
  const failure = mailChatEnrolFailure(check, domain, chat);
  return failure === null
    ? { kind: 'confirmed', checked_by: check.stamped_by! }
    : { kind: 'failed', failure };
};
